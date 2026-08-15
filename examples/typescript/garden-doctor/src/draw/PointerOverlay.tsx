import type { CSSProperties } from 'react';

import type { DrawPointRequest } from 'cosmo-ai';
import { pointPosition, type VideoPlacement } from 'cosmo-ai/tool/video_geometry';

type Props = {
  request: DrawPointRequest;
  /** How the frame sits inside the element underneath. Null maps straight
   *  through — see ``BoundingBoxOverlay``. */
  placement: VideoPlacement | null;
};

// A point in the cropped-away margin marks something the user cannot see, so
// it is dropped rather than pinned to an edge it does not belong on.
function positioned(
  point: DrawPointRequest['point'],
  placement: VideoPlacement | null,
): CSSProperties | null {
  if (placement === null) {
    return { left: `${point.x * 100}%`, top: `${point.y * 100}%` };
  }
  const mapped = pointPosition(point, placement);
  const { width: cw, height: ch } = placement.container;
  if (mapped.x < 0 || mapped.y < 0 || mapped.x > cw || mapped.y > ch) return null;
  return { left: `${mapped.x}px`, top: `${mapped.y}px` };
}

/** Marks a `cosmo_sdk_draw_point` request over the camera, through the same
 *  corrections as ``BoundingBoxOverlay``. */
export default function PointerOverlay({ request, placement }: Props) {
  const { point, label } = request;
  const style = positioned(point, placement);
  if (style === null) return null;
  return (
    <div className="mark-point" style={style}>
      <span className="mark-ping" />
      <span className="mark-dot" />
      {label !== undefined && label !== '' && <span className="mark-label point">{label}</span>}
    </div>
  );
}
