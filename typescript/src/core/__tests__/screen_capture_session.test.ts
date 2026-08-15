/** Session-level wiring of the screen locator's capture step through a live
 *  ``RealtimeClient``: connect-time registration of the one
 *  register-without-advertise RPC, the streamed capture payload + agent-only
 *  guard end-to-end, the omit→none path, the transport-capability guard, and
 *  teardown disposal. */

import { describe, expect, it, vi } from 'vitest';

import { RealtimeClient } from '../realtime_client';
import {
  type ScreenCapture,
} from '../../tool/screen';
import { makeFakeTransport, type FakeTransport } from './test_helpers';


const CAPTURE_RPC = 'screen_capture';

const capture = (): ScreenCapture => ({
  imageJpeg: new Uint8Array([0xff, 0xd8]),
  elements: [{ index: 0, role: 'button', title: 'OK', frame: [0, 0, 10, 10] }],
});

/** A client whose transport reports a minted session id on connect, so the
 *  session reaches ``connected`` and the binds run. */
function startableClient(transport: FakeTransport): RealtimeClient {
  const original = transport.connect.bind(transport);
  transport.connect = async (opts) => {
    await original(opts);
    opts.onSessionStarted?.('sess-fake');
  };
  return new RealtimeClient({ transportFactory: () => transport });
}

describe('screen-capture session wiring through RealtimeClient', () => {
  it('registers the capture RPC when the agent declares a capture handler', async () => {
    const fake = makeFakeTransport();
    const client = startableClient(fake);

    await client.agent({ tools: [{ kind: 'screen_locate', capture }] }).start();

    expect([...fake.rpcMethods.keys()]).toEqual([CAPTURE_RPC]);
  });

  it('registers nothing when no capture handler was declared', async () => {
    const fake = makeFakeTransport();
    const client = startableClient(fake);

    await client.agent({}).start();

    expect(fake.rpcMethods.size).toBe(0);
  });

  it('acks the capture, streams the payload, and unregisters on teardown', async () => {
    const fake = makeFakeTransport();
    const client = startableClient(fake);
    await client.agent({ tools: [{ kind: 'screen_locate', capture }] }).start();

    const reply = JSON.parse(await fake.invokeRpc(CAPTURE_RPC, '{"capture_id":"c"}'));
    expect(reply).toEqual({ ok: true, result: { captured: true }, error: null });

    expect(fake.sentBytes).toHaveLength(1);
    expect(fake.sentBytes[0].topic).toBe(CAPTURE_RPC);
    const payload = JSON.parse(new TextDecoder().decode(fake.sentBytes[0].data));
    expect(payload.capture_id).toBe('c');
    expect(payload.ax_elements).toHaveLength(1);

    await client.disconnect();
    expect(fake.rpcMethods.size).toBe(0);
  });

  it('rejects a non-agent caller end-to-end', async () => {
    const fake = makeFakeTransport();
    const client = startableClient(fake);
    await client.agent({ tools: [{ kind: 'screen_locate', capture }] }).start();

    await expect(
      fake.invokeRpc(CAPTURE_RPC, '{"capture_id":"c"}', { callerIsAgent: false }),
    ).rejects.toThrow(/only be invoked by the session agent/);
  });

  it('warns and skips registration when the transport cannot stream bytes', async () => {
    const fake = makeFakeTransport();
    (fake as { sendBytes?: unknown }).sendBytes = undefined;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const client = startableClient(fake);
      await client.agent({ tools: [{ kind: 'screen_locate', capture }] }).start();

      expect(fake.rpcMethods.size).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('does not support RPC registration + byte streams'),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
