import { useEffect, useRef } from 'react';

/** The pan, full bleed — every other piece of the live view floats on top of
 *  it, kept clear of the middle so what you are cooking stays visible. The
 *  ring lights up only while a frame is actually being read, which is the one
 *  moment the camera is doing anything. Without a camera the stage is a warm
 *  gradient and the rest of the screen is unchanged: voice-only costs the
 *  doneness checks and nothing else. */
export function CameraStage({
  stream,
  looking,
}: {
  stream: MediaStream | null;
  looking: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null || stream === null) return;
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  const blind = stream === null;
  return (
    <div className={`stage${looking ? ' stage--looking' : ''}${blind ? ' stage--blind' : ''}`}>
      {/* The scrim exists to hold type legible over whatever the pan happens
          to look like. With no camera there is nothing to darken — the stage
          is already a background chosen to be read against. */}
      {!blind && (
        <>
          <video ref={videoRef} autoPlay muted playsInline />
          <div className="stage-scrim" />
        </>
      )}
    </div>
  );
}
