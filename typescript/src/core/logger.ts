/** The SDK's log sink, quiet by default.
 *
 * A library writing straight to `console` puts its diagnostics into the host
 * app's output whether the app wanted them or not. Everything here routes
 * through one level gate instead: `warn` and above print, `info` and `debug`
 * stay off until the app asks for them.
 *
 *     import { setLogLevel } from 'cosmo-ai';
 *     setLogLevel('debug');   // or 'silent' for nothing at all
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

let current: LogLevel = 'warn';

/** Set how much the SDK logs. Applies to every SDK logger immediately. */
export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function getLogLevel(): LogLevel {
  return current;
}

function enabled(level: Exclude<LogLevel, 'silent'>): boolean {
  return RANK[level] <= RANK[current];
}

export const log = {
  error(...args: unknown[]): void {
    if (enabled('error')) console.error(...args);
  },
  warn(...args: unknown[]): void {
    if (enabled('warn')) console.warn(...args);
  },
  info(...args: unknown[]): void {
    if (enabled('info')) console.info(...args);
  },
  debug(...args: unknown[]): void {
    if (enabled('debug')) console.debug(...args);
  },
};
