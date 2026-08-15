/** The SDK's log gate. Default is quiet for info/debug so a library import
 *  never puts diagnostics into the host app's console. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLogLevel, log, setLogLevel } from '../logger';

afterEach(() => setLogLevel('warn'));

describe('log level gate', () => {
  it("defaults to warn, so info and debug stay silent", () => {
    expect(getLogLevel()).toBe('warn');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    log.info('chatty');
    log.debug('chattier');
    log.warn('actionable');

    expect(info).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('actionable');
    info.mockRestore();
    debug.mockRestore();
    warn.mockRestore();
  });

  it('lets the app opt into everything', () => {
    setLogLevel('debug');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    log.info('now visible');
    expect(info).toHaveBeenCalledWith('now visible');
    info.mockRestore();
  });

  it('silent suppresses even errors', () => {
    setLogLevel('silent');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log.error('boom');
    log.warn('hmm');
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });
});
