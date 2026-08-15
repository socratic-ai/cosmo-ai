import type { CSSProperties } from 'react';

import type { DrawBoxRequest } from 'cosmo-ai';
import { boxRect, type VideoPlacement } from 'cosmo-ai/tool/video_geometry';

type Props = {
  request: DrawBoxRequest;
  /** How the frame sits inside the element underneath. Null maps straight
   *  through — the element is exactly the frame. */
  placement: VideoPlacement | null;
};

// The preview crops the frame, so a box on something in the cropped-away
// margin maps outside the screen. Trim it to what the user can actually see.
function positioned(
  box: DrawBoxRequest['box'],
  placement: VideoPlacement | null,
): CSSProperties | null {
  if (placement === null) {
    return {
      left: `${box.x * 100}%`,
      top: `${box.y * 100}%`,
      width: `${box.width * 100}%`,
      height: `${box.height * 100}%`,
    };
  }
  const rect = boxRect(box, placement);
  const { width: cw, height: ch } = placement.container;
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(cw, rect.x + rect.width);
  const bottom = Math.min(ch, rect.y + rect.height);
  const visible = (right - left) * (bottom - top);
  const whole = rect.width * rect.height;
  // Mostly off-screen means it points at something the user cannot see;
  // a sliver clinging to the edge reads as a rendering fault, not a mark.
  if (whole <= 0 || visible / whole < 0.35) return null;
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${right - left}px`,
    height: `${bottom - top}px`,
  };
}

/**
 * Draws a `cosmo_sdk_draw_box` request over the camera. The model's
 * coordinates are normalized to the frame it was shown, so the cropping
 * full-bleed video needs `placement` to land the box where the model pointed.
 */
export default function BoundingBoxOverlay({ request, placement }: Props) {
  const { box, label } = request;
  const style = positioned(box, placement);
  if (style === null) return null;
  return (
    <div className="mark-box" style={style}>
      {label !== undefined && label !== '' && <span className="mark-label">{label}</span>}
    </div>
  );
}
