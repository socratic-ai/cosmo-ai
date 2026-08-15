"""The screen tools the SDK ships: the capture handler behind the server's
locator, and the three renderers that act on what it finds —
``cosmo_sdk_screen_click_element``, ``cosmo_sdk_screen_highlight_element`` and
``cosmo_sdk_screen_highlight_box``.

The ``screen_locate`` opt-in declares the server-side locator
(``cosmo_screen_locate``) and answers the capture RPC it drives, which is why it
carries a ``capture`` handler where the other opt-ins are bare kinds. The server
grounds the model's description against the screenshot and the accessibility
list, then hands the model candidates carrying a ``found_element`` handle. The
model picks one and passes the handle to a renderer, where the SDK resolves it
back to the element it addresses::

    from cosmo_ai.tools import (
        ScreenCapture,
        ScreenClickTarget,
        ScreenClickOutcome,
        screen_click_element,
        screen_locate,
    )

    def grab() -> ScreenCapture:
        image, elements = snapshot_screen_and_accessibility_tree()
        return ScreenCapture(image_jpeg=image, elements=elements)

    def on_click(target: ScreenClickTarget) -> ScreenClickOutcome:
        if not can_control_the_desktop():
            return ScreenClickOutcome(clicked=False, reason="I need accessibility access")
        press(target.element.frame, target.action)
        return ScreenClickOutcome(clicked=True)

    agent = client.agent(tools=[screen_locate(grab), screen_click_element(on_click)])

:func:`screen_highlight_box` stands apart: its caller already has coordinates,
so it skips capture and grounding and draws immediately.

Platform-neutral: macOS clicks a mouse, iOS taps, a web client clicks the DOM —
only the handlers differ. Names, wording, schemas, decode and reply shapes are
cross-SDK contract, pinned by ``sdk-client-tool-vectors.json``.
"""

from __future__ import annotations

from typing import Any

from cosmo_ai._internal.protocol import ClientTool, ScreenLocateTool
from cosmo_ai.tools._sdk_tools import _SdkClientTool
from cosmo_ai.tools._screen_capture import (
    SCREEN_CLICK_TOOL_NAME,
    SCREEN_HIGHLIGHT_BOX_TOOL_NAME,
    SCREEN_HIGHLIGHT_TOOL_NAME,
    _UNRESOLVABLE_HANDLE_REASON,
    _capture_cache,
)
from cosmo_ai.tools._screen_decode import (
    _click_reply,
    _highlight_reply,
    _resolve_found_element,
    parse_screen_click_request,
    parse_screen_highlight_box_request,
    parse_screen_highlight_request,
)
from cosmo_ai.tools._screen_schemas import (
    _SCREEN_CLICK_DESCRIPTION,
    _SCREEN_CLICK_PARAMETERS,
    _SCREEN_HIGHLIGHT_BOX_DESCRIPTION,
    _SCREEN_HIGHLIGHT_BOX_PARAMETERS,
    _SCREEN_HIGHLIGHT_DESCRIPTION,
    _SCREEN_HIGHLIGHT_PARAMETERS,
)
from cosmo_ai.tools._screen_types import (
    ScreenCaptureHandler,
    ScreenClickAction,
    ScreenClickHandler,
    ScreenClickOutcome,
    ScreenClickTarget,
    ScreenHighlightBoxHandler,
    ScreenHighlightHandler,
    ScreenHighlightOutcome,
    ScreenHighlightTarget,
    _resolved,
)


# ─────────────────────────────────────────────────────────────────────────────
# Public factories
# ─────────────────────────────────────────────────────────────────────────────


def screen_locate(capture: ScreenCaptureHandler) -> ScreenLocateTool:
    """Opt in to the server-executed screen locator, ready to add to ``tools=``
    alongside the renderers that act on what it finds
    (:func:`screen_click_element`, :func:`screen_highlight_element`).

    Unlike the other tools it is never advertised: the model cannot call it,
    ``cosmo_screen_locate`` does. Declaring it is what asks for the locator, and
    the SDK owns everything wire-facing behind it — the capture cache, the
    payload encoding, the byte-stream publish, and the ack. ``capture`` owns only
    the snapshot; raise to decline one (the message reaches the model)."""
    return ScreenLocateTool(capture=capture)


def screen_click_element(on_click: ScreenClickHandler) -> ClientTool:
    """The click renderer, ready to add to ``tools=`` alongside the
    :func:`screen_locate` opt-in that feeds it. Your handler owns only the
    clicking — and the honest answer about whether it happened. Malformed
    arguments surface to the model as the call's error without reaching your
    handler, and a handle the capture cache can no longer resolve declines with a
    reason instead of clicking something else.

    Server-gated: ``cosmo_sdk_screen_click_element`` sits behind a desktop-control
    policy that defaults off, so a session that cannot run it starts without it
    and echoes the drop on :class:`~cosmo_ai.ReadyEvent`'s ``rejected_tools``.
    A dropped renderer is simply never invoked; the locator and
    :func:`screen_highlight_element` are ungated and keep working."""

    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        request = parse_screen_click_request(args)
        if request is None:
            raise ValueError(
                f"{SCREEN_CLICK_TOOL_NAME}: pass found_element exactly as "
                f"cosmo_screen_locate returned it, and button left|right"
            )
        resolved = _resolve_found_element(request.found_element, _capture_cache)
        if resolved is None:
            return _click_reply(
                ScreenClickOutcome(clicked=False, reason=_UNRESOLVABLE_HANDLE_REASON)
            )
        element, capture = resolved
        outcome = await _resolved(
            on_click(
                ScreenClickTarget(
                    element=element,
                    capture=capture,
                    action=ScreenClickAction(
                        button=request.button, double=request.double
                    ),
                )
            )
        )
        return _click_reply(outcome)

    return _SdkClientTool(
        name=SCREEN_CLICK_TOOL_NAME,
        description=_SCREEN_CLICK_DESCRIPTION,
        parameters=_SCREEN_CLICK_PARAMETERS,
        handler=handler,
    )


def screen_highlight_element(on_highlight: ScreenHighlightHandler) -> ClientTool:
    """The element highlight. Same handle contract as :func:`screen_click_element`,
    reporting through the :class:`ScreenHighlightOutcome` both highlights share —
    a grounded handle is on a real control, so ``exact=True`` is the answer here.
    Visual only — it never clicks."""

    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        request = parse_screen_highlight_request(args)
        if request is None:
            raise ValueError(
                f"{SCREEN_HIGHLIGHT_TOOL_NAME}: pass found_element exactly as "
                f"cosmo_screen_locate returned it, and a label"
            )
        resolved = _resolve_found_element(request.found_element, _capture_cache)
        if resolved is None:
            return _highlight_reply(
                ScreenHighlightOutcome(shown=False, reason=_UNRESOLVABLE_HANDLE_REASON)
            )
        element, capture = resolved
        outcome = await _resolved(
            on_highlight(
                ScreenHighlightTarget(
                    element=element,
                    capture=capture,
                    label=request.label,
                    placement=request.placement,
                    interaction=request.interaction,
                )
            )
        )
        return _highlight_reply(outcome)

    return _SdkClientTool(
        name=SCREEN_HIGHLIGHT_TOOL_NAME,
        description=_SCREEN_HIGHLIGHT_DESCRIPTION,
        parameters=_SCREEN_HIGHLIGHT_PARAMETERS,
        handler=handler,
    )


def screen_highlight_box(on_highlight: ScreenHighlightBoxHandler) -> ClientTool:
    """The box highlight: no capture, no locator, no cache — the model gives the
    box and your handler draws it. Answer ``exact=True`` only when something
    confirmed the highlight sits on a real control; ``exact=False`` is what tells
    the model to re-target through the locator."""

    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        request = parse_screen_highlight_box_request(args)
        if request is None:
            raise ValueError(
                f"{SCREEN_HIGHLIGHT_BOX_TOOL_NAME}: pass x, y, width and height as "
                f"fractions of the shared surface, plus a label"
            )
        outcome = await _resolved(on_highlight(request))
        return _highlight_reply(outcome)

    return _SdkClientTool(
        name=SCREEN_HIGHLIGHT_BOX_TOOL_NAME,
        description=_SCREEN_HIGHLIGHT_BOX_DESCRIPTION,
        parameters=_SCREEN_HIGHLIGHT_BOX_PARAMETERS,
        handler=handler,
    )
