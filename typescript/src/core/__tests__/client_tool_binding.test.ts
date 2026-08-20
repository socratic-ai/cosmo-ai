/** Engine-level binding: ``client.agent({tools, hooks}).start()`` wires
 *  declared client tools onto the transport's RPC bridge, routes a
 *  background job's terminal result through ``transport.send`` as a
 *  ``tool_job_result`` message, and tears the job sink down with the
 *  session. */

import { describe, expect, it } from 'vitest';

import { RealtimeClient } from '../realtime_client';
import { type Hook,
  preToolUse } from '../hooks';
import { makeFakeTransport, type FakeTransport } from './test_helpers';

function makeClient(fake: FakeTransport): RealtimeClient {
  // The engine reads the session id minted by the session-start POST;
  // surface one from the fake so hook contexts carry it.
  const originalConnect = fake.connect.bind(fake);
  fake.connect = async (opts) => {
    await originalConnect(opts);
    opts.onSessionStarted?.('sess-fake');
  };
  return new RealtimeClient({ transportFactory: () => fake });
}

describe('client-tool binding through agent.start()', () => {
  it('registers one RPC method per handler-carrying client tool', async () => {
    const fake = makeFakeTransport();
    const client = makeClient(fake);
    await client
      .agent({
        tools: [
          {
            kind: 'client',
            name: 'runnable',
            description: 'd',
            parameters: {},
            handler: async () => ({ done: true }),
          },
          { kind: 'client', name: 'declared_only', description: 'd', parameters: {} },
          { kind: 'web_search' },
        ],
      })
      .start();
    expect([...fake.rpcMethods.keys()]).toEqual(['runnable']);

    const reply = JSON.parse(await fake.invokeRpc('runnable', '{}')) as unknown;
    expect(reply).toEqual({ ok: true, result: { done: true }, error: null });
  });

  it('registers nothing when no declared tool carries a handler', async () => {
    const fake = makeFakeTransport();
    const client = makeClient(fake);
    await client
      .agent({
        tools: [{ kind: 'client', name: 'declared_only', description: 'd', parameters: {} }],
      })
      .start();
    expect(fake.rpcMethods.size).toBe(0);
  });

  it('routes a background job result through the transport as tool_job_result', async () => {
    const fake = makeFakeTransport();
    const client = makeClient(fake);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    await client
      .agent({
        tools: [
          {
            kind: 'client',
            background: true,
            name: 'export_report',
            description: 'd',
            parameters: {},
            handler: async (_args, job) => {
              job.ack('on it');
              await gate;
              await job.complete({ result: { url: 'https://x' }, summary: 'ready' });
              finished();
            },
          },
        ],
      })
      .start();

    const reply = JSON.parse(await fake.invokeRpc('export_report', '{}')) as {
      deferred?: boolean;
      job_id?: string;
    };
    expect(reply.deferred).toBe(true);
    expect(fake.sent.filter((m) => m.type === 'tool_job_result')).toHaveLength(0);

    release();
    await done;
    const jobResults = fake.sent.filter((m) => m.type === 'tool_job_result');
    expect(jobResults).toEqual([
      {
        type: 'tool_job_result',
        job_id: reply.job_id,
        tool_name: 'export_report',
        status: 'completed',
        result: { url: 'https://x' },
        summary: 'ready',
        error: undefined,
      },
    ]);
  });

  it('end closes the job sink — a late terminal result is dropped', async () => {
    const fake = makeFakeTransport();
    const client = makeClient(fake);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const session = await client
      .agent({
        tools: [
          {
            kind: 'client',
            background: true,
            name: 'export_report',
            description: 'd',
            parameters: {},
            handler: async (_args, job) => {
              job.ack();
              await gate;
              await job.complete({ summary: 'too late' });
              finished();
            },
          },
        ],
      })
      .start();

    await fake.invokeRpc('export_report', '{}');
    await session.end();
    release();
    await done;
    expect(fake.sent.filter((m) => m.type === 'tool_job_result')).toHaveLength(0);
  });

  it('end unregisters the RPC methods installed at start', async () => {
    const fake = makeFakeTransport();
    const client = makeClient(fake);
    const session = await client
      .agent({
        tools: [
          {
            kind: 'client',
            name: 'runnable',
            description: 'd',
            parameters: {},
            handler: async () => ({ done: true }),
          },
        ],
      })
      .start();
    expect([...fake.rpcMethods.keys()]).toEqual(['runnable']);
    await session.end();
    expect(fake.rpcMethods.size).toBe(0);
  });

  it('hooks fire with the minted session id; the list is snapshotted at start', async () => {
    const fake = makeFakeTransport();
    const client = makeClient(fake);
    const hooks: Hook[] = [];
    const sessionIds: string[] = [];
    hooks.push(preToolUse((ctx) => {
      sessionIds.push(ctx.sessionId);
      return { permission: 'deny', reason: 'locked down' };
    }));
    await client
      .agent({
        hooks,
        tools: [
          {
            kind: 'client',
            name: 'runnable',
            description: 'd',
            parameters: {},
            handler: async () => ({ done: true }),
          },
        ],
      })
      .start();

    const reply = JSON.parse(await fake.invokeRpc('runnable', '{}')) as unknown;
    expect(reply).toEqual({ ok: false, result: null, error: 'locked down' });
    expect(sessionIds).toEqual(['sess-fake']);
    // The engine snapshots the list at start — a late push is inert, not an
    // error (declared lists replaced the mutable registry).
    hooks.push(preToolUse(() => ({ permission: 'deny', reason: 'late hook' })));
    const replyAfter = JSON.parse(await fake.invokeRpc('runnable', '{}')) as unknown;
    expect(replyAfter).toEqual({ ok: false, result: null, error: 'locked down' });
  });

  it('handles a tool invocation arriving in the join→register window', async () => {
    const fake = makeFakeTransport();
    let windowReply: string | null = null;
    const originalConnect = fake.connect.bind(fake);
    fake.connect = async (opts) => {
      opts.onSessionStarted?.('sess-fake');
      // An invocation dispatched while the join is completing — before
      // start() has returned and any post-connect code has run.
      windowReply = await fake.invokeRpc('runnable', '{}');
      await originalConnect(opts);
    };
    const client = new RealtimeClient({ transportFactory: () => fake });
    await client
      .agent({
        tools: [
          {
            kind: 'client',
            name: 'runnable',
            description: 'd',
            parameters: {},
            handler: async () => ({ done: true }),
          },
        ],
      })
      .start();
    expect(windowReply).not.toBeNull();
    expect(JSON.parse(windowReply ?? '')).toEqual({
      ok: true,
      result: { done: true },
      error: null,
    });
  });

  it('a non-agent caller is rejected end-to-end', async () => {
    const fake = makeFakeTransport();
    const client = makeClient(fake);
    await client
      .agent({
        tools: [
          {
            kind: 'client',
            name: 'runnable',
            description: 'd',
            parameters: {},
            handler: async () => ({ done: true }),
          },
        ],
      })
      .start();
    await expect(
      fake.invokeRpc('runnable', '{}', { callerIsAgent: false }),
    ).rejects.toThrow(/only be invoked by the session agent/);
  });
});
