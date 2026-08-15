import { useEffect, useState, type RefObject } from 'react';

import type { VideoContentMode, VideoPlacement } from 'cosmo-ai/tool/video_geometry';

/** Measure how a video element is showing its frame, for overlays that draw
 *  the model's normalized coordinates onto it.
 *
 *  Both sizes move on their own: the intrinsic size changes when the camera
 *  flips between a portrait and a landscape sensor (the element fires
 *  ``resize``), and the rendered size changes with the layout. Returns
 *  ``null`` until both are known — an overlay treats that as "the element is
 *  the frame" and maps straight through. */
export function useVideoPlacement(
  videoRef: RefObject<HTMLVideoElement | null>,
  contentMode: VideoContentMode,
  mirrored = false,
): VideoPlacement | null {
  const [placement, setPlacement] = useState<VideoPlacement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;

    const measure = () => {
      const frameSize = { width: video.videoWidth, height: video.videoHeight };
      const container = { width: video.clientWidth, height: video.clientHeight };
      const known =
        frameSize.width > 0 &&
        frameSize.height > 0 &&
        container.width > 0 &&
        container.height > 0;
      setPlacement(known ? { container, frameSize, contentMode, mirrored } : null);
    };

    measure();
    video.addEventListener('loadedmetadata', measure);
    video.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    observer.observe(video);
    return () => {
      video.removeEventListener('loadedmetadata', measure);
      video.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, [videoRef, contentMode, mirrored]);

  return placement;
}
