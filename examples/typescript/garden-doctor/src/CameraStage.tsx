import { useEffect, useRef } from 'react';

import type { DrawBoxRequest, DrawPointRequest } from 'cosmo-ai';

import { useVideoPlacement } from './camera/use_video_placement';
import BoundingBoxOverlay from './draw/BoundingBoxOverlay';
import PointerOverlay from './draw/PointerOverlay';
import type { Mark } from './draw/use_draw_marks';

type Props = {
  stream: MediaStream;
  /** Front-lens capture previews mirrored, matching a selfie view. */
  mirrored: boolean;
  boxes: Mark<DrawBoxRequest>[];
  points: Mark<DrawPointRequest>[];
};

export default function CameraStage({ stream, mirrored, boxes, points }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // The stage pins both dimensions and fills, so the frame is cropped — and a
  // front lens is mirrored in CSS while the published frame is not. Both have
  // to be undone before a normalized coordinate means anything here.
  const placement = useVideoPlacement(videoRef, 'fill', mirrored);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    // Some mobile browsers won't autostart a srcObject video from the
    // attribute alone; muted + playsInline keeps the explicit play allowed.
    void el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  }, [stream]);

  return (
    <div className="stage" aria-label="Camera view">
      <video ref={videoRef} autoPlay playsInline muted className={mirrored ? 'mirrored' : ''} />
      <div className="marks" aria-hidden>
        {boxes.map((mark) => (
          <BoundingBoxOverlay key={mark.id} request={mark.request} placement={placement} />
        ))}
        {points.map((mark) => (
          <PointerOverlay key={mark.id} request={mark.request} placement={placement} />
        ))}
      </div>
    </div>
  );
}
