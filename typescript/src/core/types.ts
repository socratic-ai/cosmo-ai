export type ErrorCode =
  | 'mic_denied'
  | 'screen_denied'
  | 'screen_start_failed'
  | 'session_start_failed'
  | 'session_rejected'
  | 'auth_error'
  | 'not_ready'
  | 'transport_connect_timeout'
  | 'transport_disconnect'
  | 'unsupported_browser'
  | 'server_error';

export type ErrorEvent = {
  code: ErrorCode;
  message: string;
};

export class NotReadyError extends Error {
  readonly code: ErrorCode = 'not_ready';

  constructor(message: string) {
    super(message);
    this.name = 'NotReadyError';
  }
}

export type ScreenShareState =
  | { kind: 'inactive' }
  | { kind: 'requesting' }
  | { kind: 'active'; startedAt: number }
  | { kind: 'error'; error: ErrorEvent };
