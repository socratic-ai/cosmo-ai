"""The seam around the screen tools the SDK ships that the shared conformance
vectors don't reach: the capture RPC's cache-and-publish handoff, handle
resolution against the module cache, the reply envelope the model receives, the
capture cache's TTL/eviction, and the session-level wiring — the locator spec
emitted mechanically (with its ``capture`` handler stripped) and the
``screen_capture`` RPC registered without being advertised.
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Any

import pytest

from cosmo_ai._internal.schema import check_schema_dialect
from cosmo_ai.tools import (
    ClientTool,
    ScreenCapture,
    ScreenCaptureRequest,
    ScreenClickOutcome,
    ScreenClickTarget,
    ScreenElement,
    ScreenHighlightBoxRequest,
    ScreenHighlightOutcome,
    ScreenHighlightTarget,
    screen_click_element,
    screen_highlight_box,
    screen_highlight_element,
    screen_locate,
)
from cosmo_ai.tools._screen_capture import (
    SCREEN_CAPTURE_RPC_METHOD,
    SCREEN_CLICK_TOOL_NAME,
    SCREEN_HIGHLIGHT_BOX_TOOL_NAME,
    SCREEN_HIGHLIGHT_TOOL_NAME,
    ScreenCaptureCache,
    _screen_capture_payload,
    screen_capture_handler,
)
from cosmo_ai.tools._screen_schemas import (
    _SCREEN_CLICK_PARAMETERS,
    _SCREEN_HIGHLIGHT_BOX_PARAMETERS,
    _SCREEN_HIGHLIGHT_PARAMETERS,
)

from .fakes import FakeRpcInvocation, run_awaitable, start_body, start_fake_session


def _capture(*, elements: tuple[ScreenElement, ...] = ()) -> ScreenCapture:
    return ScreenCapture(image_jpeg=b"\xff\xd8", elements=elements, context={"app_pid": 7})


def _two_elements() -> tuple[ScreenElement, ...]:
    return (
        ScreenElement(index=0, role="AXButton", frame=(0.0, 0.0, 20.0, 20.0), title="b0"),
        ScreenElement(index=1, role="AXButton", frame=(10.0, 0.0, 20.0, 20.0), title="b1"),
    )


async def _collect_bytes() -> tuple[list[tuple[bytes, str]], Any]:
    sent: list[tuple[bytes, str]] = []

    async def send_bytes(data: bytes, topic: str) -> None:
        sent.append((data, topic))

    return sent, send_bytes


def _locate(capture_id: str, capture: ScreenCapture) -> None:
    """Seed the module cache the way a live locator does — over the capture
    RPC — so a handle addressing ``capture_id`` resolves for the renderers."""

    async def scenario() -> None:
        _sent, send_bytes = await _collect_bytes()
        handler = screen_capture_handler(screen_locate(lambda: capture), send_bytes)
        ack = await handler({"capture_id": capture_id})
        assert ack == {"captured": True}

    asyncio.run(scenario())


def _invoke(tool: ClientTool, args: dict[str, Any]) -> Any:
    assert tool.handler is not None
    return run_awaitable(tool.handler(args))


# ── Capture RPC ─────────────────────────────────────────────────────────────


def test_capture_caches_the_snapshot_and_publishes_it_for_the_locator() -> None:
    async def scenario() -> None:
        cache = ScreenCaptureCache()
        sent, send_bytes = await _collect_bytes()
        spec = screen_locate(lambda: _capture(elements=_two_elements()))
        handler = screen_capture_handler(spec, send_bytes, cache=cache)

        ack = await handler({"capture_id": "cap1"})

        assert ack == {"captured": True}
        assert cache.get("cap1") is not None
        assert len(sent) == 1
        data, topic = sent[0]
        assert topic == "screen_capture"
        payload = json.loads(data)
        assert payload["capture_id"] == "cap1"
        assert payload["mime_type"] == "image/jpeg"
        assert base64.b64decode(payload["image_b64"]) == b"\xff\xd8"
        assert payload["ax_elements"] == [
            {"idx": 0, "role": "AXButton", "frame": [0.0, 0.0, 20.0, 20.0], "title": "b0"},
            {"idx": 1, "role": "AXButton", "frame": [10.0, 0.0, 20.0, 20.0], "title": "b1"},
        ]

    asyncio.run(scenario())


def test_descriptors_are_clamped_instead_of_shipping_a_document() -> None:
    # A focused text area holding a document used to reach the backend whole,
    # where a length cap rejected the *entire* capture.
    payload = json.loads(
        _screen_capture_payload(
            "cap1",
            _capture(
                elements=(
                    ScreenElement(
                        index=0,
                        role="AXTextArea",
                        frame=(0.0, 0.0, 20.0, 20.0),
                        value="v" * 40_000,
                    ),
                )
            ),
        )
    )

    assert payload["ax_elements"][0]["value"] == "v" * 256


def test_a_named_element_ships_no_value_the_screenshot_already_shows_it() -> None:
    payload = json.loads(
        _screen_capture_payload(
            "cap1",
            _capture(
                elements=(
                    ScreenElement(
                        index=0,
                        role="AXTextField",
                        frame=(0.0, 0.0, 20.0, 20.0),
                        title="Email",
                        value="someone@example.com",
                    ),
                )
            ),
        )
    )

    assert payload["ax_elements"][0] == {
        "idx": 0,
        "role": "AXTextField",
        "frame": [0.0, 0.0, 20.0, 20.0],
        "title": "Email",
    }


@pytest.mark.parametrize(
    ("args", "wants_elements", "element_count"),
    [
        ({"want_elements": False}, False, 0),
        ({"want_elements": True}, True, 2),
        ({}, True, 2),
    ],
)
def test_want_elements_reaches_the_handler_and_shapes_the_payload(
    args: dict[str, Any], wants_elements: bool, element_count: int
) -> None:
    async def scenario() -> None:
        sent, send_bytes = await _collect_bytes()
        asked: list[ScreenCaptureRequest] = []

        def capture(request: ScreenCaptureRequest) -> ScreenCapture:
            asked.append(request)
            return _capture(elements=_two_elements())

        handler = screen_capture_handler(
            screen_locate(capture), send_bytes, cache=ScreenCaptureCache()
        )

        await handler({"capture_id": "cap1", **args})

        assert asked == [ScreenCaptureRequest(wants_elements=wants_elements)]
        payload = json.loads(sent[0][0])
        assert len(payload["ax_elements"]) == element_count
        assert base64.b64decode(payload["image_b64"]) == b"\xff\xd8"

    asyncio.run(scenario())


def test_a_no_argument_capture_handler_still_works() -> None:
    async def scenario() -> None:
        sent, send_bytes = await _collect_bytes()
        handler = screen_capture_handler(
            screen_locate(lambda: _capture(elements=_two_elements())),
            send_bytes,
            cache=ScreenCaptureCache(),
        )

        ack = await handler({"capture_id": "cap1", "want_elements": False})

        assert ack == {"captured": True}
        assert json.loads(sent[0][0])["ax_elements"] == []

    asyncio.run(scenario())


def test_a_failed_capture_answers_no_capture_carrying_the_handlers_reason() -> None:
    async def scenario() -> None:
        cache = ScreenCaptureCache()
        sent, send_bytes = await _collect_bytes()

        def boom() -> ScreenCapture:
            raise RuntimeError("the user stopped sharing their screen")

        handler = screen_capture_handler(screen_locate(boom), send_bytes, cache=cache)

        ack = await handler({"capture_id": "cap-fails"})

        assert ack == {
            "captured": False,
            "message": "the user stopped sharing their screen",
        }
        assert sent == []
        assert cache.get("cap-fails") is None

    asyncio.run(scenario())


def test_a_call_with_no_capture_id_answers_no_capture_without_capturing() -> None:
    async def scenario() -> None:
        cache = ScreenCaptureCache()
        sent, send_bytes = await _collect_bytes()
        captured: list[bool] = []

        def capture() -> ScreenCapture:
            captured.append(True)
            return _capture()

        handler = screen_capture_handler(screen_locate(capture), send_bytes, cache=cache)

        assert await handler({}) == {"captured": False}
        assert captured == []
        assert sent == []

    asyncio.run(scenario())


def test_an_async_capture_handler_is_awaited() -> None:
    async def scenario() -> None:
        cache = ScreenCaptureCache()
        sent, send_bytes = await _collect_bytes()

        async def capture() -> ScreenCapture:
            await asyncio.sleep(0)
            return _capture(elements=_two_elements())

        handler = screen_capture_handler(screen_locate(capture), send_bytes, cache=cache)

        assert await handler({"capture_id": "cap-async"}) == {"captured": True}
        assert cache.get("cap-async") is not None

    asyncio.run(scenario())


def test_a_publish_failure_propagates_as_the_calls_error() -> None:
    async def scenario() -> None:
        cache = ScreenCaptureCache()

        async def send_boom(data: bytes, topic: str) -> None:
            raise RuntimeError("byte stream refused")

        handler = screen_capture_handler(
            screen_locate(lambda: _capture()), send_boom, cache=cache
        )

        with pytest.raises(RuntimeError, match="byte stream refused"):
            await handler({"capture_id": "cap-nostream"})

    asyncio.run(scenario())


# ── Click renderer ──────────────────────────────────────────────────────────


def test_click_hands_the_caller_the_element_the_handle_addresses() -> None:
    _locate("click-ok", _capture(elements=_two_elements()))
    seen: list[ScreenClickTarget] = []

    def on_click(target: ScreenClickTarget) -> ScreenClickOutcome:
        seen.append(target)
        return ScreenClickOutcome(clicked=True)

    result = _invoke(
        screen_click_element(on_click),
        {"found_element": "click-ok#1", "button": "right", "double": True},
    )

    assert result == {"clicked": True}
    assert seen[0].element.index == 1
    assert seen[0].element.title == "b1"
    assert seen[0].capture.context == {"app_pid": 7}
    assert seen[0].action.button == "right"
    assert seen[0].action.double is True


def test_click_defaults_to_a_single_left_click() -> None:
    _locate("click-defaults", _capture(elements=_two_elements()))
    seen: list[ScreenClickTarget] = []

    def on_click(target: ScreenClickTarget) -> ScreenClickOutcome:
        seen.append(target)
        return ScreenClickOutcome(clicked=True)

    _invoke(screen_click_element(on_click), {"found_element": "click-defaults#0"})

    assert seen[0].action.button == "left"
    assert seen[0].action.double is False


def test_click_declines_an_unresolvable_handle_instead_of_clicking_something_else() -> None:
    called: list[bool] = []

    def on_click(target: ScreenClickTarget) -> ScreenClickOutcome:
        called.append(True)
        return ScreenClickOutcome(clicked=True)

    result = _invoke(
        screen_click_element(on_click),
        {"found_element": "never-captured#0"},
    )

    assert result["clicked"] is False
    assert "cosmo_screen_locate" in result["reason"]
    assert called == []


def test_click_declines_an_index_past_the_end_of_its_capture() -> None:
    _locate("click-short", _capture(elements=_two_elements()[:1]))
    called: list[bool] = []

    def on_click(target: ScreenClickTarget) -> ScreenClickOutcome:
        called.append(True)
        return ScreenClickOutcome(clicked=True)

    result = _invoke(
        screen_click_element(on_click), {"found_element": "click-short#5"}
    )

    assert result["clicked"] is False
    assert called == []


def test_click_carries_a_refusal_reason() -> None:
    _locate("click-refused", _capture(elements=_two_elements()))

    def on_click(target: ScreenClickTarget) -> ScreenClickOutcome:
        return ScreenClickOutcome(clicked=False, reason="the window moved — locate it again")

    result = _invoke(
        screen_click_element(on_click), {"found_element": "click-refused#0"}
    )

    assert result == {"clicked": False, "reason": "the window moved — locate it again"}


def test_click_never_hands_malformed_arguments_to_the_caller() -> None:
    called: list[bool] = []

    def on_click(target: ScreenClickTarget) -> ScreenClickOutcome:
        called.append(True)
        return ScreenClickOutcome(clicked=True)

    # A structured token is not a handle: decode rejects it before the handler.
    with pytest.raises(ValueError, match=SCREEN_CLICK_TOOL_NAME):
        _invoke(
            screen_click_element(on_click),
            {"found_element": {"capture_id": "click-ok", "element_idx": 0}},
        )
    assert called == []


# ── Element highlight ───────────────────────────────────────────────────────


def test_highlight_hands_the_caller_the_element_plus_the_tooltip() -> None:
    _locate("mark-ok", _capture(elements=_two_elements()))
    seen: list[ScreenHighlightTarget] = []

    async def on_highlight(target: ScreenHighlightTarget) -> ScreenHighlightOutcome:
        seen.append(target)
        return ScreenHighlightOutcome(shown=True, exact=True)

    result = _invoke(
        screen_highlight_element(on_highlight),
        {
            "found_element": "mark-ok#0",
            "label": "Save",
            "placement": "top",
            "interaction": "press_hold",
        },
    )

    assert result == {"shown": True, "exact": True}
    assert seen[0].element.index == 0
    assert seen[0].label == "Save"
    assert seen[0].placement == "top"
    assert seen[0].interaction == "press_hold"


def test_highlight_declines_an_unresolvable_handle() -> None:
    called: list[bool] = []

    def on_highlight(target: ScreenHighlightTarget) -> ScreenHighlightOutcome:
        called.append(True)
        return ScreenHighlightOutcome(shown=True, exact=True)

    result = _invoke(
        screen_highlight_element(on_highlight),
        {"found_element": "never-captured#0", "label": "Save"},
    )

    assert result["shown"] is False
    assert "cosmo_screen_locate" in result["reason"]
    assert called == []


def test_highlight_carries_the_callers_refusal_reason() -> None:
    _locate("mark-refused", _capture(elements=_two_elements()))

    def on_highlight(target: ScreenHighlightTarget) -> ScreenHighlightOutcome:
        return ScreenHighlightOutcome(
            shown=False, reason="the user stopped sharing their screen"
        )

    result = _invoke(
        screen_highlight_element(on_highlight),
        {"found_element": "mark-refused#0", "label": "Save"},
    )

    assert result == {"shown": False, "reason": "the user stopped sharing their screen"}


# ── Box highlight ───────────────────────────────────────────────────────────


def test_box_draws_from_the_box_alone_no_capture_no_lookup() -> None:
    seen: list[ScreenHighlightBoxRequest] = []

    def on_highlight(request: ScreenHighlightBoxRequest) -> ScreenHighlightOutcome:
        seen.append(request)
        return ScreenHighlightOutcome(shown=True, exact=True)

    result = _invoke(
        screen_highlight_box(on_highlight),
        {
            "x": 0.25,
            "y": 0.5,
            "width": 0.1,
            "height": 0.0,
            "label": "Click Save",
            "element_title": "Files changed",
            "element_role": "AXButton",
        },
    )

    assert result == {"shown": True, "exact": True}
    request = seen[0]
    assert request.box.x == 0.25
    assert request.label == "Click Save"
    assert request.element_guess is not None
    assert request.element_guess.title == "Files changed"
    assert request.element_guess.role == "AXButton"
    assert request.placement == "auto"
    assert request.interaction == "click"


def test_box_reports_a_highlight_that_only_landed_on_the_estimate() -> None:
    result = _invoke(
        screen_highlight_box(
            lambda request: ScreenHighlightOutcome(shown=True, exact=False)
        ),
        {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4, "label": "Save"},
    )

    assert result == {"shown": True, "exact": False}


def test_box_carries_a_refusal_reason_instead_of_an_exactness() -> None:
    result = _invoke(
        screen_highlight_box(
            lambda request: ScreenHighlightOutcome(
                shown=False, reason="nothing is shared right now"
            )
        ),
        {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4, "label": "Save"},
    )

    assert result == {"shown": False, "reason": "nothing is shared right now"}


def test_box_never_hands_malformed_arguments_to_the_caller() -> None:
    called: list[bool] = []

    def on_highlight(request: ScreenHighlightBoxRequest) -> ScreenHighlightOutcome:
        called.append(True)
        return ScreenHighlightOutcome(shown=True, exact=True)

    with pytest.raises(ValueError, match=SCREEN_HIGHLIGHT_BOX_TOOL_NAME):
        _invoke(
            screen_highlight_box(on_highlight),
            {"x": 0.1, "y": 0.2, "width": 0.3, "label": "Save"},
        )
    assert called == []


# ── Capture cache ───────────────────────────────────────────────────────────


def test_cache_returns_a_live_capture_and_misses_on_a_wrong_id() -> None:
    cache = ScreenCaptureCache()
    capture = _capture()
    cache.put("cap-1", capture)
    assert cache.get("cap-1") is capture
    assert cache.get("cap-other") is None


def test_cache_expires_entries_past_the_ttl() -> None:
    clock = [1000.0]
    cache = ScreenCaptureCache(ttl_seconds=30.0, max_entries=4, now=lambda: clock[0])
    cache.put("cap-1", _capture())
    clock[0] += 29.0
    assert cache.get("cap-1") is not None
    clock[0] += 2.0
    assert cache.get("cap-1") is None


def test_cache_evicts_the_oldest_beyond_the_cap() -> None:
    clock = [0.0]
    cache = ScreenCaptureCache(ttl_seconds=30.0, max_entries=2, now=lambda: clock[0])
    cache.put("a", _capture())
    clock[0] += 1.0
    cache.put("b", _capture())
    clock[0] += 1.0
    cache.put("c", _capture())
    assert cache.get("a") is None
    assert cache.get("b") is not None
    assert cache.get("c") is not None


# ── Schemas stay within the restricted dialect ──────────────────────────────


@pytest.mark.parametrize(
    ("tool_name", "parameters"),
    [
        (SCREEN_CLICK_TOOL_NAME, _SCREEN_CLICK_PARAMETERS),
        (SCREEN_HIGHLIGHT_TOOL_NAME, _SCREEN_HIGHLIGHT_PARAMETERS),
        (SCREEN_HIGHLIGHT_BOX_TOOL_NAME, _SCREEN_HIGHLIGHT_BOX_PARAMETERS),
    ],
)
def test_the_renderer_schemas_stay_within_the_restricted_dialect(
    tool_name: str, parameters: dict[str, Any]
) -> None:
    check_schema_dialect(parameters, tool_name=tool_name)


# ── Session wiring ──────────────────────────────────────────────────────────


def test_the_locate_opt_in_reaches_the_wire_as_a_bare_kind() -> None:
    body = start_body(
        tools=[
            screen_locate(lambda: _capture()),
            screen_click_element(lambda target: ScreenClickOutcome(clicked=True)),
        ]
    )
    declared = {spec["kind"]: spec for spec in body["agent"]["tools"]}

    # The capture handler is local-only: the spec reaches the wire as the bare
    # kind, exactly like the other server-tool opt-ins.
    assert declared["screen_locate"] == {"kind": "screen_locate"}
    assert declared["client"]["name"] == SCREEN_CLICK_TOOL_NAME


def test_the_capture_rpc_is_registered_without_being_advertised() -> None:
    async def scenario() -> None:
        harness = await start_fake_session(tools=[screen_locate(lambda: _capture())])
        # Registered as an RPC method the locator drives, but never declared as
        # a tool the model can call.
        assert SCREEN_CAPTURE_RPC_METHOD in harness.transport.rpc_methods
        assert harness.transport.rpc_methods.get("screen_locate") is None
        assert harness.start_bodies[0]["agent"]["tools"] == [{"kind": "screen_locate"}]

    asyncio.run(scenario())


def test_no_screen_locate_registers_no_capture_rpc() -> None:
    async def scenario() -> None:
        harness = await start_fake_session(
            tools=[screen_click_element(lambda target: ScreenClickOutcome(clicked=True))]
        )
        assert SCREEN_CAPTURE_RPC_METHOD not in harness.transport.rpc_methods

    asyncio.run(scenario())


def test_the_capture_rpc_round_trips_over_the_transport() -> None:
    async def scenario() -> None:
        harness = await start_fake_session(
            tools=[screen_locate(lambda: _capture(elements=_two_elements()))]
        )
        method = harness.transport.rpc_methods[SCREEN_CAPTURE_RPC_METHOD]
        reply = await method(
            FakeRpcInvocation(
                caller_identity="agent-1", payload=json.dumps({"capture_id": "wire-cap"})
            )
        )

        assert json.loads(reply) == {
            "ok": True,
            "result": {"captured": True},
            "error": None,
        }
        assert len(harness.transport.byte_streams) == 1
        data, topic = harness.transport.byte_streams[0]
        assert topic == "screen_capture"
        assert json.loads(data)["capture_id"] == "wire-cap"

    asyncio.run(scenario())


# ── Reserved namespace ──────────────────────────────────────────────────────


def test_the_sdks_own_screen_tools_are_admitted_by_construction() -> None:
    body = start_body(
        tools=[
            screen_locate(lambda: _capture()),
            screen_click_element(lambda target: ScreenClickOutcome(clicked=True)),
            screen_highlight_element(
                lambda target: ScreenHighlightOutcome(shown=True, exact=True)
            ),
            screen_highlight_box(
                lambda request: ScreenHighlightOutcome(shown=True, exact=True)
            ),
        ]
    )
    kinds = [spec["kind"] for spec in body["agent"]["tools"]]
    assert kinds.count("screen_locate") == 1
    assert kinds.count("client") == 3


@pytest.mark.parametrize(
    "name",
    [SCREEN_CLICK_TOOL_NAME, SCREEN_HIGHLIGHT_TOOL_NAME, SCREEN_HIGHLIGHT_BOX_TOOL_NAME],
)
def test_a_hand_built_spec_cannot_claim_a_screen_tools_name(name: str) -> None:
    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        return {}

    squatter = ClientTool(
        name=name,
        description="Not the SDK's.",
        parameters={"type": "object", "properties": {}},
        handler=handler,
    )
    with pytest.raises(ValueError, match="reserved for tools the SDK ships"):
        start_body(tools=[squatter])
