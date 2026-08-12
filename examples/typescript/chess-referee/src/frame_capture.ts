/** Grabs still frames from a live camera or screen-share track by playing the
 *  stream into an off-screen <video> and drawing it to a canvas at the track's
 *  full capture resolution. */
export class FrameCapture {
  private video: HTMLVideoElement;
  private canvas = document.createElement('canvas');
  private ready: Promise<void>;

  constructor(readonly stream: MediaStream) {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = stream;
    this.ready = this.video.play().then(() => {
      if (this.video.videoWidth > 0) return;
      return new Promise<void>((resolve) => {
        this.video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      });
    });
  }

  async capture(type = 'image/jpeg', quality = 0.8): Promise<Blob> {
    await this.ready;
    const { videoWidth, videoHeight } = this.video;
    if (videoWidth === 0 || videoHeight === 0) {
      throw new Error('video track has no frames yet');
    }
    this.canvas.width = videoWidth;
    this.canvas.height = videoHeight;
    const ctx = this.canvas.getContext('2d');
    if (ctx === null) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(this.video, 0, 0, videoWidth, videoHeight);
    return new Promise<Blob>((resolve, reject) => {
      this.canvas.toBlob(
        (blob) => (blob !== null ? resolve(blob) : reject(new Error('frame encode failed'))),
        type,
        quality,
      );
    });
  }

  dispose(): void {
    this.video.srcObject = null;
    for (const track of this.stream.getTracks()) track.stop();
  }
}
