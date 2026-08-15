"""The vocabulary the screen tools are built from: the captures a host produces,
the handles and boxes the model hands back, the targets a handler acts on, and
the outcomes it reports. Every other ``_screen*`` module speaks in these types,
so they live on their own with no dependency on the schemas, decoding, capture
plumbing, or factories that consume them — the base of the dependency tree.

Names, wording, and shapes here are cross-SDK contract, pinned by
``sdk-client-tool-vectors.json``.
"""

from __future__ import annotations

import inspect
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Literal, TypeVar, Union

_T = TypeVar("_T")


async def _resolved(value: _T | Awaitable[_T]) -> _T:
    if inspect.isawaitable(value):
        return await value
    return value


SCREEN_PLACEMENTS: tuple[str, ...] = ("auto", "top", "bottom", "left", "right")
"""Which side of the target the tooltip sits on; ``auto`` picks the side with
the most room."""

ScreenPlacement = Literal["auto", "top", "bottom", "left", "right"]

SCREEN_AFFORDANCES: tuple[str, ...] = (
    "pointer",
    "click",
    "double_click",
    "left_click",
    "right_click",
    "drag_show",
    "press_hold",
    "inform",
)
"""Which glyph the highlight draws — the action being asked of the user. A
highlight never acts on the user's behalf; see :class:`ScreenClickAction`."""

ScreenAffordance = Literal[
    "pointer",
    "click",
    "double_click",
    "left_click",
    "right_click",
    "drag_show",
    "press_hold",
    "inform",
]

ScreenClickButton = Literal["left", "right"]
"""Which button/gesture to click with: ``left`` is a left click on desktop / tap
on touch; ``right`` a right click / long-press."""


# ─────────────────────────────────────────────────────────────────────────────
# Capture inputs — what the host's handler produces
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ScreenElement:
    """One interactive on-screen element the locator may pick. ``index`` is
    0-based and contiguous within one :class:`ScreenCapture`; ``frame`` is
    ``(x, y, w, h)`` in the platform's screen coordinates."""

    index: int
    role: str
    frame: tuple[float, float, float, float]
    title: str | None = None
    label: str | None = None
    value: str | None = None


@dataclass(frozen=True)
class ScreenCaptureRequest:
    """What the server wants out of this capture. The accessibility walk is the
    expensive half and only the grounding locator reads it, so a handler that
    can skip it when ``wants_elements`` is false answers materially faster.
    Ignoring it is always correct — the extra elements are dropped."""

    wants_elements: bool


@dataclass(frozen=True)
class ScreenCapture:
    """A snapshot the locator works from: the JPEG image plus the pickable
    elements. ``context`` is opaque per-capture state the handler may stash and
    read back at click time to validate freshness (e.g. the frontmost-app
    identity); the SDK never inspects it."""

    image_jpeg: bytes
    elements: Sequence[ScreenElement] = field(default_factory=tuple)
    context: object = None


# ─────────────────────────────────────────────────────────────────────────────
# Handles, boxes, and hints — what the model hands a renderer
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FoundElement:
    """The two halves of a ``found_element`` handle, split back out: the capture
    an element was found in and its index there. Internal — a renderer's handler
    receives the resolved :class:`ScreenElement`, never these parts, so nothing
    downstream can address an element the locator did not pick. The index means
    nothing beside any other capture, so the two always travel together."""

    capture_id: str
    element_idx: int


@dataclass(frozen=True)
class ScreenBox:
    """A rectangle the model located itself, as fractions of the shared surface:
    ``x``/``y`` are the top-left corner (0 = left/top), all four in ``0..1``.

    Deliberately not reusing :class:`ScreenElement.frame`, which is the same
    shape in platform screen coordinates — the two spaces are not
    interchangeable, and mixing them draws a marker in the top-left one percent
    of the screen."""

    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class ScreenElementHint:
    """What the model believes the target is *called*, alongside where it thinks
    it is. A handler with a platform accessibility tree can ask the OS for that
    control's exact frame; one without a usable tree ignores this and falls back
    to the region. ``title`` is the control's own visible text ("Files
    changed"), not the tooltip; ``role`` disambiguates a repeated title."""

    title: str
    role: str | None = None


@dataclass(frozen=True)
class ScreenClickAction:
    """How to click the located element: which button/gesture, and whether it's
    a double. Button and double are orthogonal axes rather than a flat enum."""

    button: ScreenClickButton
    double: bool


# ─────────────────────────────────────────────────────────────────────────────
# Decoded requests — the boundary check on model output
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ScreenClickRequest:
    """A decoded ``cosmo_sdk_screen_click_element`` call, before the handle is
    resolved."""

    found_element: str
    button: ScreenClickButton
    double: bool


@dataclass(frozen=True)
class ScreenHighlightRequest:
    """A decoded ``cosmo_sdk_screen_highlight_element`` call, before the handle
    is resolved."""

    found_element: str
    label: str
    placement: ScreenPlacement
    interaction: ScreenAffordance


@dataclass(frozen=True)
class ScreenHighlightBoxRequest:
    """A decoded ``cosmo_sdk_screen_highlight_box`` call. The model gave a box
    instead of a handle, so there is nothing to resolve — the handler draws it
    directly. ``element_guess`` is a bonus signal, never a requirement; most apps
    expose no usable label."""

    box: ScreenBox
    label: str
    placement: ScreenPlacement
    interaction: ScreenAffordance
    element_guess: ScreenElementHint | None = None


# ─────────────────────────────────────────────────────────────────────────────
# Targets — what a ref-taking renderer's handler is asked to act on
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ScreenClickTarget:
    """What a click handler is asked to do: the element the handle resolved to,
    the capture it was picked from, and how to click it."""

    element: ScreenElement
    capture: ScreenCapture
    action: ScreenClickAction


@dataclass(frozen=True)
class ScreenHighlightTarget:
    """What a highlight handler is asked to do, for a handle the locator minted."""

    element: ScreenElement
    capture: ScreenCapture
    label: str
    placement: ScreenPlacement
    interaction: ScreenAffordance


# ─────────────────────────────────────────────────────────────────────────────
# Outcomes — what a handler reports back to the model
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ScreenClickOutcome:
    """What a click handler reports back to the model.

    Clicking can fail for reasons the model has to hear about — the user stopped
    sharing, the window moved, accessibility access is off. Answering
    ``clicked=True`` regardless would leave it narrating something that never
    happened, so a refusal carries a ``reason`` the agent can say out loud
    ("the window moved — locate it again"), not an error code."""

    clicked: bool
    reason: str | None = None


@dataclass(frozen=True)
class ScreenHighlightOutcome:
    """What either highlight reports back to the model — the mark is showing, but
    is it *on* the thing?

    Shared by :func:`screen_highlight_element` and :func:`screen_highlight_box`
    so the model reads the same field whichever it called. A handler that
    resolved the target to a real control answers ``exact=True``; one that could
    only draw where the model estimated answers ``exact=False``, the model's cue
    to re-target through the locator. From a grounded handle the answer is always
    ``exact=True`` — the locator picked it out of a real accessibility list.

    A refusal carries the same model-facing ``reason`` contract as
    :class:`ScreenClickOutcome`: prose the agent says out loud ("the user stopped
    sharing their screen"), not an error code."""

    shown: bool
    exact: bool = False
    reason: str | None = None


# ─────────────────────────────────────────────────────────────────────────────
# Handler type aliases (the host-facing surface)
# ─────────────────────────────────────────────────────────────────────────────


ScreenCaptureHandler = Union[
    Callable[[], Union[ScreenCapture, Awaitable[ScreenCapture]]],
    Callable[[ScreenCaptureRequest], Union[ScreenCapture, Awaitable[ScreenCapture]]],
]
"""Snapshot the shared screen: ``() -> ScreenCapture`` or
``(request) -> ScreenCapture``, sync or async. Take the
:class:`ScreenCaptureRequest` to skip the accessibility walk when the caller
will not read it. Raising (or returning no elements) surfaces to the model as
an inability to see the screen — the raised message reaches the model as the
locator's reason."""

ScreenClickHandler = Callable[
    [ScreenClickTarget], Union[ScreenClickOutcome, Awaitable[ScreenClickOutcome]]
]
"""Your click renderer: ``(target) -> outcome``, sync or async."""

ScreenHighlightHandler = Callable[
    [ScreenHighlightTarget],
    Union[ScreenHighlightOutcome, Awaitable[ScreenHighlightOutcome]],
]
"""Your element-highlight renderer: ``(target) -> outcome``, sync or async.
Reports through the :class:`ScreenHighlightOutcome` both highlights share."""

ScreenHighlightBoxHandler = Callable[
    [ScreenHighlightBoxRequest],
    Union[ScreenHighlightOutcome, Awaitable[ScreenHighlightOutcome]],
]
"""Your box-highlight renderer: ``(request) -> outcome``, sync or async."""
