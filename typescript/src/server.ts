// Server-safe entry: hold an API key on a backend — mint end-user tokens,
// verify credentials — with no React in the module graph. The root entry
// exports the React bindings, which the `react-server` bundler condition
// (Next.js route handlers, server components) refuses to load.
export { RealtimeClient } from './core/realtime_client';
export type { RealtimeClientOptions } from './core/realtime_client';
export type { MintedToken, MintTokenErrorCode } from './core/auth';
export { CredentialError, MintTokenError } from './core/auth';
export { VerifyError } from './core/verify';
export type { CredentialInfo } from './core/verify';
export { setLogLevel, getLogLevel } from './core/logger';
export type { LogLevel } from './core/logger';
