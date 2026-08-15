/** Base for every error this SDK throws, so `err instanceof
 *  RealtimeError` catches the whole family. Mirrors Python's
 *  `cosmo_ai.RealtimeError`. */
export class RealtimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealtimeError';
  }
}

/** A second audio publish was requested while one was live. A session carries
 *  one voice — the microphone or a caller-owned stream, never both — so the
 *  active stream has to be removed before another is added. Mirrors Swift's
 *  `.audioPublishAlreadyActive`. */
export class AudioPublishAlreadyActiveError extends RealtimeError {
  constructor(message: string) {
    super(message);
    this.name = 'AudioPublishAlreadyActiveError';
  }
}
