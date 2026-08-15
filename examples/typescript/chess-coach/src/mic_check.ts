/**
 * Mic preflight. A realtime session fed a silent microphone does not fail —
 * it degrades into nonsense: the recognizer invents speech from the silence,
 * that phantom speech reads as a barge-in, and the agent is cut off mid-word.
 * Diagnosing that from the transcript is miserable, so the app proves the mic
 * carries signal before offering to start.
 */

export type MicLevel = {
  /** Peak amplitude over the last frame, 0..1. */
  peak: number;
  /** Label of the device actually feeding the track — not the OS default,
   *  which the browser is free to ignore. */
  deviceLabel: string;
};

export type MicMonitor = {
  stop: () => void;
};

/** Speech peaks well above this; room tone sits below it. */
export const SPEECH_PEAK_THRESHOLD = 0.02;

/** Open the default mic and report its level until stopped. The track is
 *  opened with the same processing the SDK publishes with, so the meter
 *  reflects what the agent will actually receive. */
export async function monitorMicLevel(
  onLevel: (level: MicLevel) => void,
): Promise<MicMonitor> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
  });
  const deviceLabel = stream.getAudioTracks()[0]?.label ?? 'unknown device';

  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(samples);
    let peak = 0;
    for (const sample of samples) {
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
    }
    onLevel({ peak, deviceLabel });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return {
    stop: () => {
      stopped = true;
      source.disconnect();
      void context.close();
      for (const track of stream.getTracks()) track.stop();
    },
  };
}
