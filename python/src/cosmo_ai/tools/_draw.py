"""The renderer half of the locate-then-draw pair: ``cosmo_sdk_draw_box`` and
``cosmo_sdk_draw_point``.

A server-side locator (:class:`~cosmo_ai.DetectObjectsTool` /
:class:`~cosmo_ai.PointAtObjectTool`) returns candidate boxes or points to the
model; the model picks the one matching what it is looking at and passes it to
the renderer, which draws it over the user's live camera or screen preview::

    from cosmo_ai import DetectObjectsTool
    from cosmo_ai.tools import DrawBoxRequest, DrawOutcome, draw_box

    def on_draw(request: DrawBoxRequest) -> DrawOutcome:
        if not camera.streaming:
            return DrawOutcome(
                shown=False,
                reason="the camera is off — ask the user to turn it on",
            )
        overlay.show(request.box, label=request.label)
        return DrawOutcome(shown=True)

    agent = client.agent(tools=[DetectObjectsTool(), draw_box(on_draw)])

The renderers measure nothing — they carry the model's choice to your UI. The
SDK owns the name, description, schema, decode and reply shape; you own the
drawing, and the honest answer about whether it happened.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Union

from cosmo_ai._internal.protocol import ClientTool
from cosmo_ai.tools._sdk_tools import _SdkClientTool

DRAW_BOX_TOOL_NAME = "cosmo_sdk_draw_box"
"""Wire name shipped in ``tool-invocation`` events; a rename is a wire break."""

DRAW_POINT_TOOL_NAME = "cosmo_sdk_draw_point"
"""Wire name shipped in ``tool-invocation`` events; a rename is a wire break."""

_DRAW_BOX_DESCRIPTION = (
    "Draw a box over the user's live view (their camera or screen preview) "
    "around something cosmo_detect_objects located — pass a box it returned, "
    "normalized to the frame you were shown ([0,1], top-left origin), and an "
    "optional short label. Call this after cosmo_detect_objects rather than "
    "guessing a box yourself. Visual only — it measures nothing and changes "
    "nothing."
)

_DRAW_POINT_DESCRIPTION = (
    "Mark a single spot on the user's live view (their camera or screen "
    "preview) — one leaf, one screw, one control — using a point "
    "cosmo_point_at_object returned, normalized to the frame you were shown "
    "([0,1], top-left origin), with an optional short label. Call this after "
    "cosmo_point_at_object rather than guessing a position yourself. Visual "
    "only — it measures nothing and changes nothing."
)

_DRAW_BOX_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "box": {
            "type": "object",
            "description": (
                "Where to draw, normalized to the frame you were shown: "
                "[0,1], top-left origin."
            ),
            "properties": {
                "x": {"type": "number", "minimum": 0, "maximum": 1},
                "y": {"type": "number", "minimum": 0, "maximum": 1},
                "width": {"type": "number", "minimum": 0, "maximum": 1},
                "height": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["x", "y", "width", "height"],
        },
        "label": {
            "type": "string",
            "maxLength": 40,
            "description": "Short caption shown on the box, e.g. 'blush here'.",
        },
    },
    "required": ["box"],
}

_DRAW_POINT_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "point": {
            "type": "object",
            "description": (
                "Where to point, normalized to the frame you were shown: "
                "[0,1], top-left origin."
            ),
            "properties": {
                "x": {"type": "number", "minimum": 0, "maximum": 1},
                "y": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["x", "y"],
        },
        "label": {
            "type": "string",
            "maxLength": 40,
            "description": "Short caption shown beside the marker, e.g. 'this screw'.",
        },
    },
    "required": ["point"],
}


@dataclass(frozen=True)
class NormalizedBox:
    """A rectangle in ``[0,1]``, **top-left origin** (y increases downward) —
    the convention the locators report and a preview overlay maps onto the
    screen."""

    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class NormalizedPoint:
    """A position in ``[0,1]``, on the same terms as :class:`NormalizedBox`."""

    x: float
    y: float


@dataclass(frozen=True)
class DrawBoxRequest:
    """One model request to draw a box over the user's live view: where, and
    an optional short caption."""

    box: NormalizedBox
    label: str | None = None


@dataclass(frozen=True)
class DrawPointRequest:
    """One model request to mark a spot on the user's live view: where, and an
    optional short caption."""

    point: NormalizedPoint
    label: str | None = None


@dataclass(frozen=True)
class DrawOutcome:
    """What a renderer's handler reports back to the model.

    Drawing can fail for reasons the model must hear about — the camera is
    off, the preview isn't on screen, the frame the box describes is already
    gone. Answering ``shown=True`` regardless would leave the model talking
    about something the user cannot see, so a refusal travels with a
    ``reason``: model-facing prose the agent says out loud ("the camera is off
    — ask the user to turn it on"), not an error code.
    """

    shown: bool
    reason: str | None = None


DrawBoxHandler = Callable[
    [DrawBoxRequest], Union[DrawOutcome, Awaitable[DrawOutcome]]
]
"""Your box renderer: ``(request) -> outcome``, sync or async."""

DrawPointHandler = Callable[
    [DrawPointRequest], Union[DrawOutcome, Awaitable[DrawOutcome]]
]
"""Your point renderer: ``(request) -> outcome``, sync or async."""


def _clamped(raw: object) -> float | None:
    """A JSON number clamped into ``[0,1]``, or ``None`` when the model sent
    something that isn't one. Clamping keeps a model that overshoots the frame
    edge yielding a drawable annotation."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    return min(1.0, max(0.0, float(raw)))


def _box(raw: object) -> NormalizedBox | None:
    if not isinstance(raw, dict):
        return None
    x, y = _clamped(raw.get("x")), _clamped(raw.get("y"))
    width, height = _clamped(raw.get("width")), _clamped(raw.get("height"))
    if x is None or y is None or width is None or height is None:
        return None
    return NormalizedBox(x=x, y=y, width=width, height=height)


def _point(raw: object) -> NormalizedPoint | None:
    if not isinstance(raw, dict):
        return None
    x, y = _clamped(raw.get("x")), _clamped(raw.get("y"))
    if x is None or y is None:
        return None
    return NormalizedPoint(x=x, y=y)


def _label(args: Mapping[str, Any]) -> str | None:
    label = args.get("label")
    return label if isinstance(label, str) else None


async def _tool_result(
    outcome: DrawOutcome | Awaitable[DrawOutcome],
) -> dict[str, Any]:
    resolved = outcome if isinstance(outcome, DrawOutcome) else await outcome
    result: dict[str, Any] = {"shown": resolved.shown}
    if resolved.reason is not None:
        result["reason"] = resolved.reason
    return result


def draw_box(on_draw: DrawBoxHandler) -> ClientTool:
    """The box renderer, ready to add to ``tools=`` alongside the locator that
    feeds it (:class:`~cosmo_ai.DetectObjectsTool`).

    ``on_draw`` receives a decoded, clamped :class:`DrawBoxRequest` and returns
    a :class:`DrawOutcome`; it may be sync or async. Malformed model arguments
    surface to the model as the invocation's error without reaching it.
    """

    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        box = _box(args.get("box"))
        if box is None:
            raise ValueError(
                f"{DRAW_BOX_TOOL_NAME}: pass box {{x,y,width,height}} "
                f"normalized to [0,1]"
            )
        return await _tool_result(
            on_draw(DrawBoxRequest(box=box, label=_label(args)))
        )

    return _SdkClientTool(
        name=DRAW_BOX_TOOL_NAME,
        description=_DRAW_BOX_DESCRIPTION,
        parameters=_DRAW_BOX_PARAMETERS,
        handler=handler,
    )


def draw_point(on_draw: DrawPointHandler) -> ClientTool:
    """The point renderer, pairing with
    :class:`~cosmo_ai.PointAtObjectTool`. Same contract as :func:`draw_box`,
    with a :class:`DrawPointRequest` — it exists next to the box renderer
    because the two answer different questions: a box around a leaf includes
    everything behind it, where a marked point says one thing.
    """

    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        point = _point(args.get("point"))
        if point is None:
            raise ValueError(
                f"{DRAW_POINT_TOOL_NAME}: pass point {{x,y}} normalized to [0,1]"
            )
        return await _tool_result(
            on_draw(DrawPointRequest(point=point, label=_label(args)))
        )

    return _SdkClientTool(
        name=DRAW_POINT_TOOL_NAME,
        description=_DRAW_POINT_DESCRIPTION,
        parameters=_DRAW_POINT_PARAMETERS,
        handler=handler,
    )
