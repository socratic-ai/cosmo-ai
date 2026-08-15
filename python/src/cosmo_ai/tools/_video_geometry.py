"""Turning a renderer's normalized coordinates into something you can draw.

The model reports a box or point against **the frame it was shown**, which is
rarely what a viewer sees pixel-for-pixel: the view crops the frame, letterboxes
it, or mirrors it (a selfie preview — the published frame never is). Both
corrections live here so every surface applies them identically; a hand-rolled
version is how an annotation ends up somewhere the model never pointed.

Only useful to an app that shows the frames it publishes. The SDK draws
nothing and owns no window — it hands you the arithmetic, in whatever
coordinate space your preview happens to use.

The Swift (``VideoGeometry``) and TypeScript (``tool/video_geometry``) SDKs are
the same mapping, pinned to the same vectors
(``video-geometry-vectors.json``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from cosmo_ai.tools._draw import NormalizedBox, NormalizedPoint

VideoContentMode = Literal["fit", "fill"]
"""How the frame is fitted into the view showing it: ``fit`` letterboxes the
whole frame, ``fill`` crops it to cover."""


@dataclass(frozen=True)
class Size:
    width: float
    height: float


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class Point:
    x: float
    y: float


_ZERO_RECT = Rect(0.0, 0.0, 0.0, 0.0)
_ZERO_POINT = Point(0.0, 0.0)


def _placement(
    container: Size, frame_size: Size, content_mode: VideoContentMode
) -> tuple[Size, Point] | None:
    """The drawn size and the (negative, when cropping) origin offset. ``None``
    for a degenerate frame or view, which callers surface as zero."""
    if min(frame_size.width, frame_size.height, container.width, container.height) <= 0:
        return None
    width_ratio = container.width / frame_size.width
    height_ratio = container.height / frame_size.height
    scale = (
        max(width_ratio, height_ratio)
        if content_mode == "fill"
        else min(width_ratio, height_ratio)
    )
    size = Size(frame_size.width * scale, frame_size.height * scale)
    return size, Point(
        (container.width - size.width) / 2, (container.height - size.height) / 2
    )


def box_rect(
    box: NormalizedBox,
    *,
    container: Size,
    frame_size: Size,
    content_mode: VideoContentMode = "fill",
    mirrored: bool = False,
) -> Rect:
    """Where to draw ``box`` inside a view of ``container`` showing a frame of
    ``frame_size``. Zero for a degenerate frame or view."""
    placed = _placement(container, frame_size, content_mode)
    if placed is None:
        return _ZERO_RECT
    size, offset = placed
    x = offset.x + box.x * size.width
    width = box.width * size.width
    return Rect(
        x=container.width - (x + width) if mirrored else x,
        y=offset.y + box.y * size.height,
        width=width,
        height=box.height * size.height,
    )


def point_position(
    point: NormalizedPoint,
    *,
    container: Size,
    frame_size: Size,
    content_mode: VideoContentMode = "fill",
    mirrored: bool = False,
) -> Point:
    """Where to mark ``point``, on the same terms as :func:`box_rect`."""
    placed = _placement(container, frame_size, content_mode)
    if placed is None:
        return _ZERO_POINT
    size, offset = placed
    x = offset.x + point.x * size.width
    return Point(
        x=container.width - x if mirrored else x,
        y=offset.y + point.y * size.height,
    )
