/**
 * Turning a renderer's normalized coordinates into something you can draw.
 *
 * The model reports a box or point against **the frame it was shown**, which
 * is rarely what the viewer sees pixel-for-pixel: the element crops
 * (``object-fit: cover``) or letterboxes (``contain``) the frame, and a
 * front-camera preview is mirrored while the published frame never is. Both
 * corrections live here so every surface applies them identically —
 * hand-rolled versions of this math are how a box ends up somewhere the model
 * never pointed.
 *
 * The Swift SDK's ``VideoGeometry`` is the same mapping, pinned to the same
 * vectors (``video-geometry-vectors.json``).
 */

import type { NormalizedBox, NormalizedPoint } from './draw';

/** How the frame is fitted into the element showing it — the two choices
 *  ``object-fit`` and `AVLayerVideoGravity` both offer. */
export type VideoContentMode = 'fit' | 'fill';

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

/** Where the frame sits: the element's size in CSS pixels, the frame's own
 *  size (a video element's ``videoWidth`` / ``videoHeight``), how it is
 *  fitted, and whether the preview is mirrored. */
export type VideoPlacement = {
  container: Size;
  frameSize: Size;
  /** Defaults to ``fill`` — the common preview case. */
  contentMode?: VideoContentMode;
  /** Set for a mirrored (selfie) preview: the published frame is never
   *  mirrored, so the mark has to be reflected to land where the user sees
   *  the thing it points at. */
  mirrored?: boolean;
};

const ZERO_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };
const ZERO_POINT: Point = { x: 0, y: 0 };

/** The drawn size and the (negative, when cropping) origin offset. ``null``
 *  for a degenerate frame or element, which callers surface as zero rather
 *  than `NaN`. */
function placement(
  p: VideoPlacement,
): { size: Size; offset: Point; container: Size } | null {
  const { container, frameSize } = p;
  if (
    !(frameSize.width > 0) ||
    !(frameSize.height > 0) ||
    !(container.width > 0) ||
    !(container.height > 0)
  ) {
    return null;
  }
  const widthRatio = container.width / frameSize.width;
  const heightRatio = container.height / frameSize.height;
  const scale =
    (p.contentMode ?? 'fill') === 'fill'
      ? Math.max(widthRatio, heightRatio)
      : Math.min(widthRatio, heightRatio);
  const size = {
    width: frameSize.width * scale,
    height: frameSize.height * scale,
  };
  return {
    size,
    offset: {
      x: (container.width - size.width) / 2,
      y: (container.height - size.height) / 2,
    },
    container,
  };
}

/** Where to draw a box inside the element showing the frame it was measured
 *  against. Zero for a degenerate frame or element. */
export function boxRect(box: NormalizedBox, p: VideoPlacement): Rect {
  const placed = placement(p);
  if (placed === null) return ZERO_RECT;
  const { size, offset, container } = placed;
  const rect: Rect = {
    x: offset.x + box.x * size.width,
    y: offset.y + box.y * size.height,
    width: box.width * size.width,
    height: box.height * size.height,
  };
  if (p.mirrored === true) {
    rect.x = container.width - (rect.x + rect.width);
  }
  return rect;
}

/** Where to mark a point, on the same terms as {@link boxRect}. */
export function pointPosition(point: NormalizedPoint, p: VideoPlacement): Point {
  const placed = placement(p);
  if (placed === null) return ZERO_POINT;
  const { size, offset, container } = placed;
  const mapped = {
    x: offset.x + point.x * size.width,
    y: offset.y + point.y * size.height,
  };
  return p.mirrored === true
    ? { x: container.width - mapped.x, y: mapped.y }
    : mapped;
}
