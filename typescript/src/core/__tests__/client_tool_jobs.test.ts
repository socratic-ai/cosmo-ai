/** Background client-tool behavior (the TS mirror of the reference SDK's
 *  ``tests/test_client_tool_jobs.py`` plus the explicit-declaration
 *  routing from the cross-SDK ``BackgroundClientTool`` contract): the
 *  deferred ack, the terminal ``tool_job_result`` publish with its size
 *  caps, idempotency, and the misuse paths. */

import { describe, expect, it, vi } from 'vitest';

import type { RpcInvocation } from '../../transport/types';
import type { ToolJobResult } from '../../wire/types.gen';
import type { BackgroundClientToolSpec } from '../agent';
import { ClientToolJobSink, TRUNCATION_SUFFIX, type ClientToolJob } from '../client_tool_jobs';
import { MAX_REPLY_BYTES, registerClientToolHandlers } from '../client_tools';
import { type Hook,
  HookEngine,
  postToolUse, type PostToolUseContext } from '../hooks';

const SESSION = 'sess-1';

function makeSink(opts: { open?: boolean } = {}) {
  const published: ToolJobResult[] = [];
  const sink = new ClientToolJobSink({
    publish: async (message) => {
      published.push(message);
    },
    isOpen: () => opts.open ?? true,
  });
  return { sink, published };
}

function makeRegistrar(opts: {
  tool: BackgroundClientToolSpec;
  hooks?: HookEngine;
  sessionId?: string | null;
  sink?: ClientToolJobSink | null;
}) {
  const methods = new Map<string, (invocation: RpcInvocation) => Promise<string>>();
  registerClientToolHandlers(
    {
      registerRpcMethod(name, handler) {
        methods.set(name, handler);
        return () => {
          methods.delete(name);
        };
      },
    },
    [opts.tool],
    {
      hooks: opts.hooks ?? null,
      sessionId: opts.sessionId === undefined ? SESSION : opts.sessionId,
      jobSink: opts.sink,
    },
  );
  return {
    invoke(payload = '{}', invokeOpts: { callerIsAgent?: boolean } = {}): Promise<string> {
      const handler = methods.get(opts.tool.name);
      if (handler === undefined) throw new Error('tool not registered');
      return handler({
        payload,
        callerIdentity: 'agent:sess-1',
        callerIsAgent: invokeOpts.callerIsAgent ?? true,
      });
    },
  };
}

function bgTool(
  handler: BackgroundClientToolSpec['handler'],
): BackgroundClientToolSpec {
  return {
    kind: 'client',
    background: true,
    name: 'export_report',
    description: 'd',
    parameters: {},
    handler,
  };
}

describe('deferred dispatch', () => {
  it('ack releases a deferred reply; complete publishes the terminal result', async () => {
    const { sink, published } = makeSink();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registrar = makeRegistrar({
      sink,
      tool: bgTool(async (_args, job) => {
        job.ack('Starting the export…');
        await gate;
        await job.complete({ result: { url: 'https://x' }, summary: 'Report ready.' });
      }),
    });

    const reply = JSON.parse(await registrar.invoke()) as Record<string, unknown>;
    expect(reply).toEqual({
      ok: true,
      result: { note: 'Starting the export…' },
      error: null,
      deferred: true,
      job_id: reply.job_id,
    });
    expect(typeof reply.job_id).toBe('string');
    expect(published).toHaveLength(0);

    release();
    await sink.drain();
    expect(published).toEqual([
      {
        type: 'tool_job_result',
        job_id: reply.job_id,
        tool_name: 'export_report',
        status: 'completed',
        result: { url: 'https://x' },
        summary: 'Report ready.',
        error: undefined,
      },
    ]);
  });

  it('an empty ack note yields an empty result object', async () => {
    const { sink } = makeSink();
    const registrar = makeRegistrar({
      sink,
      tool: bgTool(async (_args, job) => {
        job.ack();
        await job.complete({});
      }),
    });
    const reply = JSON.parse(await registrar.invoke()) as { result: unknown };
    expect(reply.result).toEqual({});
  });

  it('truncates an oversized ack note so the deferred reply fits the cap', async () => {
    const { sink } = makeSink();
    const registrar = makeRegistrar({
      sink,
      tool: bgTool(async (_args, job) => {
        job.ack('é'.repeat(16 * 1024));
        await job.complete({});
      }),
    });
    const raw = await registrar.invoke();
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    const reply = JSON.parse(raw) as {
      ok: boolean;
      deferred: boolean;
      job_id: string;
      result: { note: string };
    };
    expect(reply.ok).toBe(true);
    expect(reply.deferred).toBe(true);
    expect(typeof reply.job_id).toBe('string');
    expect(reply.result.note.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    await sink.drain();
  });

  it('a throw after ack auto-fails the job', async () => {
    const { sink, published } = makeSink();
    const registrar = makeRegistrar({
      sink,
      tool: bgTool(async (_args, job) => {
        job.ack('working');
        throw new Error('export blew up');
      }),
    });
    const reply = JSON.parse(await registrar.invoke()) as { deferred?: boolean };
    expect(reply.deferred).toBe(true);
    await sink.drain();
    expect(published).toHaveLength(1);
    expect(published[0].status).toBe('failed');
    expect(published[0].error).toBe('export blew up');
  });

  it('a throw before ack is an inline error reply, nothing published', async () => {
    const { sink, published } = makeSink();
    const registrar = makeRegistrar({
      sink,
      tool: bgTool(async () => {
        throw new Error('bad args');
      }),
    });
    const reply = JSON.parse(await registrar.invoke()) as Record<string, unknown>;
    expect(reply).toEqual({ ok: false, result: null, error: 'bad args' });
    await sink.drain();
    expect(published).toHaveLength(0);
  });

  it('finishing without acking or completing is a misuse error', async () => {
    const { sink, published } = makeSink();
    const registrar = makeRegistrar({
      sink,
      tool: bgTool(async () => {
        /* returns without job interaction */
      }),
    });
    const reply = JSON.parse(await registrar.invoke()) as { ok: boolean; error: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/without acking or completing/);
    expect(published).toHaveLength(0);
  });

  it('complete without a prior ack auto-acks so the deferred reply still lands', async () => {
    const { sink, published } = makeSink();
    const registrar = makeRegistrar({
      sink,
      tool: bgTool(async (_args, job) => {
        await job.complete({ summary: 'instant' });
      }),
    });
    const reply = JSON.parse(await registrar.invoke()) as Record<string, unknown>;
    expect(reply.deferred).toBe(true);
    expect(reply.result).toEqual({});
    await sink.drain();
    expect(published).toHaveLength(1);
    expect(published[0].status).toBe('completed');
  });

  it('the caller guard applies to background tools', async () => {
    const { sink } = makeSink();
    const handler = vi.fn();
    const registrar = makeRegistrar({ sink, tool: bgTool(handler) });
    await expect(
      registrar.invoke('{}', { callerIsAgent: false }),
    ).rejects.toThrow(/only be invoked by the session agent/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a background tool with no session job sink fails cleanly', async () => {
    const registrar = makeRegistrar({
      sink: null,
      tool: bgTool(async (_args, job) => {
        job.ack();
      }),
    });
    const reply = JSON.parse(await registrar.invoke()) as { ok: boolean; error: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/no session job sink/);
  });
});

describe('job terminal semantics', () => {
  async function runJob(
    body: (job: ClientToolJob) => Promise<void>,
    opts: { open?: boolean; hooks?: HookEngine; sessionId?: string | null } = {},
  ) {
    const { sink, published } = makeSink({ open: opts.open });
    const registrar = makeRegistrar({
      sink,
      hooks: opts.hooks,
      sessionId: opts.sessionId,
      tool: bgTool(async (_args, job) => {
        job.ack();
        await body(job);
      }),
    });
    await registrar.invoke();
    await sink.drain();
    return { published };
  }

  it('an acked job the handler abandons is settled as a failure', async () => {
    // Returning after ack without complete/fail previously published nothing,
    // leaving the server-side call waiting forever (cross-SDK fix).
    const { published } = await runJob(async () => {
      /* acked by the harness, then returns with no terminal call */
    });
    expect(published).toHaveLength(1);
    expect(published[0]?.status).toBe('failed');
    expect(published[0]?.error).toMatch(/without completing/);
  });

  it('shrinks an over-budget terminal message to fit the packet budget', async () => {
    // Per-field caps alone cannot bound the serialized message: capped text
    // made of JSON-escaping-heavy characters plus a near-cap result overflows
    // the packet budget; the final fit pass degrades result to the marker.
    const heavy = '"'.repeat(4000); // each escapes to two bytes
    const bigResult = { blob: 'x'.repeat(8100) }; // under the 8 KiB result cap
    const { published } = await runJob(async (job) => {
      await job.complete({ result: bigResult, summary: heavy });
    });
    expect(published).toHaveLength(1);
    const msg = published[0];
    expect(new TextEncoder().encode(JSON.stringify(msg)).length).toBeLessThanOrEqual(
      12_000,
    );
    expect(msg?.result).toEqual({ _truncated: true });
    expect(msg?.summary).toMatch(/\[truncated\]$/u);
  });

  it('a second terminal call is dropped', async () => {
    const { published } = await runJob(async (job) => {
      await job.complete({ summary: 'first' });
      await job.fail({ error: 'second' });
      await job.complete({ summary: 'third' });
    });
    expect(published).toHaveLength(1);
    expect(published[0].summary).toBe('first');
  });

  it('a terminal call after the session closed is dropped', async () => {
    const { published } = await runJob(
      async (job) => {
        await job.complete({ summary: 'late' });
      },
      { open: false },
    );
    expect(published).toHaveLength(0);
  });

  it('a failed publish rejects the terminal call and leaves the job retryable', async () => {
    let failNext = true;
    const published: ToolJobResult[] = [];
    const sink = new ClientToolJobSink({
      publish: async (message) => {
        if (failNext) {
          failNext = false;
          throw new Error('data channel closed');
        }
        published.push(message);
      },
      isOpen: () => true,
    });
    let firstTryError: unknown = null;
    const registrar = makeRegistrar({
      sink,
      tool: bgTool(async (_args, job) => {
        job.ack();
        try {
          await job.complete({ summary: 'first try' });
        } catch (err) {
          firstTryError = err;
        }
        await job.complete({ summary: 'second try' });
      }),
    });
    await registrar.invoke();
    await sink.drain();
    expect(firstTryError).toBeInstanceOf(Error);
    expect((firstTryError as Error).message).toBe('data channel closed');
    expect(published).toEqual([
      expect.objectContaining({ status: 'completed', summary: 'second try' }),
    ]);
  });

  it('an undeliverable auto-fail after a post-ack throw settles the tracked run', async () => {
    const sink = new ClientToolJobSink({
      publish: async () => {
        throw new Error('data channel closed');
      },
      isOpen: () => true,
    });
    const registrar = makeRegistrar({
      sink,
      tool: bgTool(async (_args, job) => {
        job.ack('working');
        throw new Error('export blew up');
      }),
    });
    const reply = JSON.parse(await registrar.invoke()) as { deferred?: boolean };
    expect(reply.deferred).toBe(true);
    // Rejecting tracked runs would make this drain throw.
    await sink.drain();
  });

  it('sink.close() drops terminal deliveries from still-running handlers', async () => {
    const { sink, published } = makeSink();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registrar = makeRegistrar({
      sink,
      tool: bgTool(async (_args, job) => {
        job.ack();
        await gate;
        await job.complete({ summary: 'after close' });
      }),
    });
    await registrar.invoke();
    sink.close();
    release();
    await sink.drain();
    expect(published).toHaveLength(0);
  });

  it('an oversized terminal result is replaced with a marker; text fields are capped', async () => {
    const { published } = await runJob(async (job) => {
      await job.complete({
        result: { blob: 'x'.repeat(9 * 1024) },
        summary: 's'.repeat(5000),
      });
    });
    expect(published).toHaveLength(1);
    const message = published[0];
    expect(message.result).toEqual({
      _truncated: true,
      _original_bytes: expect.any(Number) as unknown as number,
    });
    const summary = message.summary ?? '';
    expect(summary.length).toBeLessThan(5000);
    expect(summary.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it('PostToolUse fires at the terminal signal with the job outcome', async () => {
    const hooks: Hook[] = [];
    const post: PostToolUseContext[] = [];
    hooks.push(postToolUse((ctx) => {
      post.push(ctx);
    }));
    await runJob(
      async (job) => {
        await job.complete({ result: { url: 'https://x' } });
      },
      { hooks: new HookEngine(hooks) },
    );
    expect(post).toHaveLength(1);
    expect(post[0].outcome).toEqual({ kind: 'ok', result: { url: 'https://x' } });
    expect(post[0].toolName).toBe('export_report');
  });

  it('PostToolUse observes a failed job as an error outcome', async () => {
    const hooks: Hook[] = [];
    const post: PostToolUseContext[] = [];
    hooks.push(postToolUse((ctx) => {
      post.push(ctx);
    }));
    await runJob(
      async (job) => {
        await job.fail({ error: 'no dice' });
      },
      { hooks: new HookEngine(hooks) },
    );
    expect(post).toHaveLength(1);
    expect(post[0].outcome).toEqual({ kind: 'error', message: 'no dice' });
  });
});

describe('type routing', () => {
  it('a plain client tool with the same shape runs inline (no deferral)', async () => {
    const methods = new Map<string, (invocation: RpcInvocation) => Promise<string>>();
    registerClientToolHandlers(
      {
        registerRpcMethod(name, handler) {
          methods.set(name, handler);
          return () => {
            methods.delete(name);
          };
        },
      },
      [
        {
          kind: 'client',
          name: 'fast',
          description: 'd',
          parameters: {},
          handler: async () => ({ done: true }),
        },
      ],
      { sessionId: SESSION, jobSink: makeSink().sink },
    );
    const handler = methods.get('fast');
    if (handler === undefined) throw new Error('not registered');
    const reply = JSON.parse(
      await handler({ payload: '{}', callerIdentity: 'agent:s', callerIsAgent: true }),
    ) as Record<string, unknown>;
    expect(reply).toEqual({ ok: true, result: { done: true }, error: null });
    expect('deferred' in reply).toBe(false);
  });
});
