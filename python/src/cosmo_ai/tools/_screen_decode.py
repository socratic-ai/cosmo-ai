"""The boundary between model output and the SDK: decode each renderer's raw
arguments into a typed request (or ``None`` when the model sent something
unusable), resolve a ``found_element`` handle back to the element it addresses,
and shape a handler's outcome into the reply the model reads. Everything a
malformed or stale invocation has to survive lives here, so the public factories
stay a thin wiring layer over it.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

import structlog

from cosmo_ai._internal.logging import get_logger
from cosmo_ai.tools._screen_capture import ScreenCaptureCache, parse_found_element_handle
from cosmo_ai.tools._screen_types import (
    SCREEN_AFFORDANCES,
    SCREEN_PLACEMENTS,
    ScreenAffordance,
    ScreenBox,
    ScreenCapture,
    ScreenClickButton,
    ScreenClickOutcome,
    ScreenClickRequest,
    ScreenElement,
    ScreenElementHint,
    ScreenHighlightBoxRequest,
    ScreenHighlightOutcome,
    ScreenHighlightRequest,
    ScreenPlacement,
)

logger: structlog.stdlib.BoundLogger = get_logger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Argument decoding
# ─────────────────────────────────────────────────────────────────────────────


def _clamp01(raw: object) -> float | None:
    """A JSON number clamped into ``[0,1]``, or ``None`` when the model sent
    something that isn't a finite one. Clamping keeps a model that overshoots the
    surface edge yielding a drawable box."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    value = float(raw)
    if not math.isfinite(value):
        return None
    return min(1.0, max(0.0, value))


def _parse_found_element(raw: object) -> str | None:
    """Decode only checks a handle is present — its contents are the SDK's
    business at resolution time, so a token the model assembled itself is a miss
    against the cache rather than a decode error, and the model is told to locate
    again rather than handed a schema complaint."""
    return raw if isinstance(raw, str) and raw != "" else None


def _parse_button(raw: object) -> ScreenClickButton | None:
    """An absent button defaults to a left click; an unknown one is rejected
    rather than defaulted — guessing here opens a context menu the user never
    asked for."""
    if raw is None:
        return "left"
    if raw == "left" or raw == "right":
        return raw
    return None


def _parse_placement(raw: object) -> ScreenPlacement:
    return raw if raw in SCREEN_PLACEMENTS else "auto"  # type: ignore[return-value]


def _parse_affordance(raw: object) -> ScreenAffordance:
    """An unrecognized glyph falls back rather than rejecting: it means the
    caller is newer than this SDK, and a highlight with the wrong glyph still
    points the user at the right control, where an error points at nothing."""
    return raw if raw in SCREEN_AFFORDANCES else "click"  # type: ignore[return-value]


def _label(args: Mapping[str, Any]) -> str | None:
    label = args.get("label")
    return label if isinstance(label, str) else None


def _parse_box(args: Mapping[str, Any]) -> ScreenBox | None:
    values: list[float] = []
    for key in ("x", "y", "width", "height"):
        value = _clamp01(args.get(key))
        if value is None:
            return None
        values.append(value)
    return ScreenBox(x=values[0], y=values[1], width=values[2], height=values[3])


def _parse_element_hint(args: Mapping[str, Any]) -> ScreenElementHint | None:
    """Absent or blank means the model could not read a name off the target,
    which is normal."""
    title = args.get("element_title")
    if not isinstance(title, str) or title.strip() == "":
        return None
    role = args.get("element_role")
    return ScreenElementHint(
        title=title, role=role if isinstance(role, str) and role != "" else None
    )


def parse_screen_click_request(args: Mapping[str, Any]) -> ScreenClickRequest | None:
    """Decode a ``cosmo_sdk_screen_click_element`` invocation. ``None`` when the
    handle is absent, or the button is one this SDK does not know — a boundary
    check on model output, not an invariant."""
    found_element = _parse_found_element(args.get("found_element"))
    if found_element is None:
        return None
    button = _parse_button(args.get("button"))
    if button is None:
        return None
    return ScreenClickRequest(
        found_element=found_element, button=button, double=args.get("double") is True
    )


def parse_screen_highlight_request(
    args: Mapping[str, Any],
) -> ScreenHighlightRequest | None:
    """Decode a ``cosmo_sdk_screen_highlight_element`` invocation. ``None`` when
    the handle or the tooltip label is absent or malformed."""
    found_element = _parse_found_element(args.get("found_element"))
    label = _label(args)
    if found_element is None or label is None:
        return None
    return ScreenHighlightRequest(
        found_element=found_element,
        label=label,
        placement=_parse_placement(args.get("placement")),
        interaction=_parse_affordance(args.get("interaction")),
    )


def parse_screen_highlight_box_request(
    args: Mapping[str, Any],
) -> ScreenHighlightBoxRequest | None:
    """Decode a ``cosmo_sdk_screen_highlight_box`` invocation. ``None`` when a box
    component or the tooltip label is absent or malformed; coordinates are
    clamped, so a model that overshoots the surface edge still yields a drawable
    box."""
    box = _parse_box(args)
    label = _label(args)
    if box is None or label is None:
        return None
    return ScreenHighlightBoxRequest(
        box=box,
        label=label,
        placement=_parse_placement(args.get("placement")),
        interaction=_parse_affordance(args.get("interaction")),
        element_guess=_parse_element_hint(args),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Handle resolution + reply shaping
# ─────────────────────────────────────────────────────────────────────────────


def _resolve_found_element(
    found_element: str, cache: ScreenCaptureCache
) -> tuple[ScreenElement, ScreenCapture] | None:
    """Split a handle back into the capture it names and the element's index
    there, then look both up. A token that does not parse, names a capture the
    cache no longer holds, or overshoots its element list is one miss — the
    caller cannot tell them apart, and neither should the model.

    A token that does not parse cannot raise — a fabricated handle is model
    output, not a broken invariant — so it is logged instead: the locator only
    ever mints well-formed handles, so either this SDK's pattern has drifted from
    the backend's encoder or the model invented one."""
    parts = parse_found_element_handle(found_element)
    if parts is None:
        logger.warning("realtime.unparseable_found_element_handle", handle=found_element)
        return None
    capture = cache.get(parts.capture_id)
    if capture is None or parts.element_idx >= len(capture.elements):
        return None
    return capture.elements[parts.element_idx], capture


def _click_reply(outcome: ScreenClickOutcome) -> dict[str, Any]:
    if outcome.clicked:
        return {"clicked": True}
    reply: dict[str, Any] = {"clicked": False}
    if outcome.reason is not None:
        reply["reason"] = outcome.reason
    return reply


def _highlight_reply(outcome: ScreenHighlightOutcome) -> dict[str, Any]:
    """The reply both highlights answer in. ``exact`` rides only a highlight that
    is actually up — there is nothing to be exact about otherwise."""
    reply: dict[str, Any] = {"shown": outcome.shown}
    if outcome.shown:
        reply["exact"] = outcome.exact
    if outcome.reason is not None:
        reply["reason"] = outcome.reason
    return reply
