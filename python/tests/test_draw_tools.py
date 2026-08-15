"""The seam around the renderer tools the SDK ships — what the shared vectors
in ``test_sdk_client_tool_conformance.py`` deliberately don't reach: handler
registration over the transport, the reply envelope the model receives, and
the ``cosmo_sdk_`` reservation enforced when the tool set becomes the session
config."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Callable

import pytest

from cosmo_ai._internal.schema import check_schema_dialect
from cosmo_ai.tools import (
    DRAW_BOX_TOOL_NAME,
    DRAW_POINT_TOOL_NAME,
    BackgroundClientTool,
    ClientTool,
    ClientToolJob,
    DrawBoxRequest,
    DrawOutcome,
    DrawPointRequest,
    draw_box,
    draw_point,
)
from cosmo_ai.tools._draw import _DRAW_BOX_PARAMETERS, _DRAW_POINT_PARAMETERS

from .fakes import FakeRpcInvocation, start_body, start_fake_session

_BOX_ARGS: dict[str, Any] = {
    "box": {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4},
    "label": "the reset button",
}
_POINT_ARGS: dict[str, Any] = {"point": {"x": 0.5, "y": 0.25}}
_EMPTY_PARAMETERS: dict[str, Any] = {"type": "object", "properties": {}}


def _invoke(tool: ClientTool, args: dict[str, Any]) -> dict[str, Any]:
    """Start a fake session declaring ``tool``, invoke the RPC method it
    registered, and return the decoded reply envelope."""

    async def scenario() -> dict[str, Any]:
        harness = await start_fake_session(tools=[tool])
        method = harness.transport.rpc_methods.get(tool.name)
        assert method is not None, f"no RPC method registered for {tool.name!r}"
        reply = await method(
            FakeRpcInvocation(caller_identity="agent-1", payload=json.dumps(args))
        )
        envelope: dict[str, Any] = json.loads(reply)
        return envelope

    return asyncio.run(scenario())


def _shown(request: Any) -> DrawOutcome:
    return DrawOutcome(shown=True)


def test_drawing_reports_shown_to_the_model() -> None:
    assert _invoke(draw_box(_shown), _BOX_ARGS) == {
        "ok": True,
        "result": {"shown": True},
        "error": None,
    }


def test_refusing_to_draw_tells_the_model_why() -> None:
    reason = "the camera is off — ask the user to turn it on"

    def on_draw(request: DrawBoxRequest) -> DrawOutcome:
        return DrawOutcome(shown=False, reason=reason)

    assert _invoke(draw_box(on_draw), _BOX_ARGS) == {
        "ok": True,
        "result": {"shown": False, "reason": reason},
        "error": None,
    }


def test_malformed_arguments_reach_the_model_as_an_error_not_the_handler() -> None:
    seen: list[DrawBoxRequest] = []

    def on_draw(request: DrawBoxRequest) -> DrawOutcome:
        seen.append(request)
        return DrawOutcome(shown=True)

    reply = _invoke(draw_box(on_draw), {"box": "over there"})

    assert seen == []
    assert reply == {
        "ok": False,
        "result": None,
        "error": (
            f"{DRAW_BOX_TOOL_NAME}: pass box {{x,y,width,height}} "
            f"normalized to [0,1]"
        ),
    }


def test_the_point_renderer_registers_and_replies_the_same_way() -> None:
    def on_draw(request: DrawPointRequest) -> DrawOutcome:
        return DrawOutcome(shown=False, reason="no preview is visible")

    assert _invoke(draw_point(on_draw), _POINT_ARGS)["result"] == {
        "shown": False,
        "reason": "no preview is visible",
    }


def test_an_async_handler_is_awaited() -> None:
    async def on_draw(request: DrawBoxRequest) -> DrawOutcome:
        await asyncio.sleep(0)
        return DrawOutcome(shown=False, reason="the preview is behind another window")

    assert _invoke(draw_box(on_draw), _BOX_ARGS)["result"] == {
        "shown": False,
        "reason": "the preview is behind another window",
    }


def test_the_sdks_own_tools_reach_the_wire_declaration() -> None:
    body = start_body(tools=[draw_box(_shown), draw_point(_shown)])
    declared = {spec["name"]: spec for spec in body["agent"]["tools"]}

    assert set(declared) == {DRAW_BOX_TOOL_NAME, DRAW_POINT_TOOL_NAME}
    assert declared[DRAW_BOX_TOOL_NAME]["kind"] == "client"
    assert declared[DRAW_POINT_TOOL_NAME]["kind"] == "client"


@pytest.mark.parametrize(
    ("tool_name", "parameters"),
    [
        (DRAW_BOX_TOOL_NAME, _DRAW_BOX_PARAMETERS),
        (DRAW_POINT_TOOL_NAME, _DRAW_POINT_PARAMETERS),
    ],
)
def test_the_renderer_schemas_stay_within_the_restricted_dialect(
    tool_name: str, parameters: dict[str, Any]
) -> None:
    check_schema_dialect(parameters, tool_name=tool_name)


def _client_squatter(name: str) -> ClientTool:
    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        return {}

    return ClientTool(
        name=name,
        description="Impersonates an SDK tool.",
        parameters=_EMPTY_PARAMETERS,
        handler=handler,
    )


def _background_squatter(name: str) -> BackgroundClientTool:
    async def handler(args: dict[str, Any], job: ClientToolJob) -> None:
        await job.ack("")

    return BackgroundClientTool(
        name=name,
        description="Impersonates an SDK tool.",
        parameters=_EMPTY_PARAMETERS,
        handler=handler,
    )


# A background client tool has the same wire shape as a plain one, so the
# reservation has to reach both.
_SQUATTERS = [
    pytest.param(_client_squatter, id="client"),
    pytest.param(_background_squatter, id="background_client"),
]


@pytest.mark.parametrize("squatter", _SQUATTERS)
def test_a_callers_own_tool_cannot_claim_the_sdk_prefix(
    squatter: Callable[[str], ClientTool],
) -> None:
    with pytest.raises(ValueError, match="reserved for tools the SDK ships"):
        start_body(tools=[squatter("cosmo_sdk_draw_everything")])


# The dangerous case an allow-list of names would have let through: same name,
# someone else's schema and handler, silently replacing the SDK's.
@pytest.mark.parametrize("squatter", _SQUATTERS)
@pytest.mark.parametrize("name", [DRAW_BOX_TOOL_NAME, DRAW_POINT_TOOL_NAME])
def test_an_sdk_tools_exact_name_cannot_be_taken_by_a_hand_built_spec(
    squatter: Callable[[str], ClientTool], name: str
) -> None:
    with pytest.raises(ValueError, match="reserved for tools the SDK ships"):
        start_body(tools=[squatter(name)])


def test_a_callers_tool_outside_the_prefix_is_unaffected() -> None:
    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        return {}

    mine = ClientTool(
        name="draw_box",
        description="My own renderer, natural name still free.",
        parameters=_EMPTY_PARAMETERS,
        handler=handler,
    )
    body = start_body(tools=[mine])

    assert [spec["name"] for spec in body["agent"]["tools"]] == ["draw_box"]
