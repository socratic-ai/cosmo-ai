/** Dispatch behavior of the client-tool runtime (the TS mirror of the
 *  reference SDK's ``tests/test_client_tools.py``): decode → run →
 *  ``{ok, result, error}`` envelope, the 15 KiB reply cap, PreToolUse /
 *  PostToolUse hooks, and the agent-only caller guard. */

import { describe, expect, it, vi } from 'vitest';

import type { RpcInvocation } from '../../transport/types';
import type { RealtimeTool } from '../agent';
import {
  MAX_REPLY_BYTES,
  TRUNCATION_MARKER_KEY,
  TRUNCATION_MARKER_NOTE,
  registerClientToolHandlers,
  shrinkStrings,
} from '../client_tools';
import { TRUNCATION_SUFFIX } from '../client_tool_jobs';
import { type Hook,
  HookEngine,
  postToolUse,
  preToolUse, type PostToolUseContext } from '../hooks';

const SESSION = 'sess-1';

function makeRegistrar() {
  const methods = new Map<string, (invocation: RpcInvocation) => Promise<string>>();
  return {
    registerRpcMethod(
      name: string,
      handler: (invocation: RpcInvocation) => Promise<string>,
    ): () => void {
      methods.set(name, handler);
      return () => {
        methods.delete(name);
      };
    },
    invoke(
      name: string,
      payload: string,
      opts: { callerIsAgent?: boolean } = {},
    ): Promise<string> {
      const handler = methods.get(name);
      if (handler === undefined) throw new Error(`no rpc method ${name}`);
      return handler({
        payload,
        callerIdentity: 'agent:sess-1',
        callerIsAgent: opts.callerIsAgent ?? true,
      });
    },
    methods,
  };
}

function registerOne(
  tool: RealtimeTool,
  opts: { hooks?: HookEngine; sessionId?: string | null } = {},
) {
  const registrar = makeRegistrar();
  registerClientToolHandlers(registrar, [tool], {
    hooks: opts.hooks ?? null,
    sessionId: opts.sessionId === undefined ? SESSION : opts.sessionId,
  });
  return registrar;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe('plain client-tool dispatch', () => {
  it('runs the handler with decoded args and returns the ok envelope', async () => {
    const seen: unknown[] = [];
    const registrar = registerOne({
      kind: 'client',
      name: 'echo',
      description: 'd',
      parameters: {},
      handler: async (args: Record<string, unknown>) => {
        seen.push(args);
        return { echoed: args.value };
      },
    });
    const reply = await registrar.invoke('echo', JSON.stringify({ value: 42 }));
    expect(seen).toEqual([{ value: 42 }]);
    expect(JSON.parse(reply)).toEqual({ ok: true, result: { echoed: 42 }, error: null });
  });

  it('decodes an empty payload to empty args', async () => {
    const seen: unknown[] = [];
    const registrar = registerOne({
      kind: 'client',
      name: 't',
      description: 'd',
      parameters: {},
      handler: async (args: Record<string, unknown>) => {
        seen.push(args);
        return null;
      },
    });
    const reply = await registrar.invoke('t', '');
    expect(seen).toEqual([{}]);
    expect(JSON.parse(reply)).toEqual({ ok: true, result: null, error: null });
  });

  it('maps a handler throw to an error envelope', async () => {
    const registrar = registerOne({
      kind: 'client',
      name: 't',
      description: 'd',
      parameters: {},
      handler: async () => {
        throw new Error('boom');
      },
    });
    const reply = await registrar.invoke('t', '{}');
    expect(JSON.parse(reply)).toEqual({ ok: false, result: null, error: 'boom' });
  });

  it.each(['not json', '"str"', '[1]', 'null'])(
    'rejects non-object args %j without calling the handler',
    async (payload) => {
      const handler = vi.fn();
      const registrar = registerOne({
        kind: 'client',
        name: 't',
        description: 'd',
        parameters: {},
        handler,
      });
      const reply = JSON.parse(await registrar.invoke('t', payload)) as {
        ok: boolean;
        error: string;
      };
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/client tool args/);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('delivers an oversized success result truncated rather than losing it', async () => {
    const blob = 'x'.repeat(MAX_REPLY_BYTES);
    const registrar = registerOne({
      kind: 'client',
      name: 't',
      description: 'd',
      parameters: {},
      handler: async () => ({ blob, unit: 'celsius' }),
    });
    const reply = await registrar.invoke('t', '{}');
    expect(byteLength(reply)).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    const parsed = JSON.parse(reply);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    // The partial answer survives, and the marker tells the model it is partial.
    const marker = parsed.result[TRUNCATION_MARKER_KEY];
    expect(marker.note).toBe(TRUNCATION_MARKER_NOTE);
    expect(marker.original_bytes).toBeGreaterThan(marker.kept_bytes);
    expect(parsed.result.unit).toBe('celsius');
    expect(parsed.result.blob.startsWith('xxx')).toBe(true);
    expect(parsed.result.blob.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    expect(parsed.result.blob.length).toBeLessThan(blob.length);
  });

  // The shape the never-grow rule exists for: short strings near the suffix's
  // own length beside one long string.
  const interiorWindowResult = (): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (let i = 0; i < 20; i += 1) result[`k${i}`] = 'a'.repeat(8);
    result.big = 'b'.repeat(32_768);
    result.pad = Array.from({ length: 4905 }, () => 0);
    return result;
  };

  it('keeps every entry when many short strings sit beside a long one', async () => {
    const result = interiorWindowResult();
    const registrar = registerOne({
      kind: 'client',
      name: 't',
      description: 'd',
      parameters: {},
      handler: async () => result,
    });
    const reply = await registrar.invoke('t', '{}');
    expect(byteLength(reply)).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    const parsed = JSON.parse(reply);
    expect(Object.keys(parsed.result).sort()).toEqual(
      [...Object.keys(result), TRUNCATION_MARKER_KEY].sort(),
    );
    // Nearly the whole budget is spent on the answer, not surrendered.
    expect(byteLength(reply)).toBeGreaterThan(MAX_REPLY_BYTES - 512);
  });

  // The property `successReply`'s binary search prunes on. Without it a smaller
  // allowance can yield a larger reply, and the search steps over the fitting
  // window and reports that nothing fits.
  it('never shrinks the reply as the allowance rises', () => {
    const result = interiorWindowResult();
    const sizes = Array.from({ length: 120 }, (_, m) =>
      byteLength(JSON.stringify({ ok: true, result: shrinkStrings(result, m), error: null })),
    );
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  // Astral scalars survive whole. `String.prototype.slice` counts UTF-16 units
  // and would strand a lone surrogate here.
  it('cuts an error message on a scalar boundary', async () => {
    const registrar = registerOne({
      kind: 'client',
      name: 't',
      description: 'd',
      parameters: {},
      handler: async () => {
        throw new Error('🙂'.repeat(20_000));
      },
    });
    const reply = await registrar.invoke('t', '{}');
    expect(byteLength(reply)).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    const message: string = JSON.parse(reply).error;
    expect(message.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    const kept = message.slice(0, -TRUNCATION_SUFFIX.length);
    expect(kept).toBe('🙂'.repeat(Array.from(kept).length));
  });

  // Ranking on the value alone drops the wrong entry, then runs out of entries
  // and returns nothing but the marker.
  it('weighs a long key with its value when dropping entries', async () => {
    const result = { ['K'.repeat(15_200)]: 0, x: Array.from({ length: 100 }, () => 0) };
    const registrar = registerOne({
      kind: 'client',
      name: 't',
      description: 'd',
      parameters: {},
      handler: async () => result,
    });
    const reply = await registrar.invoke('t', '{}');
    expect(byteLength(reply)).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    const parsed = JSON.parse(reply);
    expect(parsed.result.x).toEqual(Array.from({ length: 100 }, () => 0));
    expect(parsed.result['K'.repeat(15_200)]).toBeUndefined();
  });

  it('drops entries biggest-first when the overflow is not in the strings', async () => {
    const rows = Array.from({ length: 4000 }, (_, i) => 1_000_000 + i);
    const registrar = registerOne({
      kind: 'client',
      name: 't',
      description: 'd',
      parameters: {},
      handler: async () => ({ rows, count: rows.length }),
    });
    const reply = await registrar.invoke('t', '{}');
    expect(byteLength(reply)).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    const parsed = JSON.parse(reply);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect(parsed.result.count).toBe(4000);
    expect(parsed.result.rows).toBeUndefined();
    const marker = parsed.result[TRUNCATION_MARKER_KEY];
    expect(marker.note).toBe(TRUNCATION_MARKER_NOTE);
    // The dropped list is the whole overflow, so almost nothing survived.
    expect(marker.original_bytes).toBeGreaterThan(10 * marker.kept_bytes);
  });

  it('leaves a result that fits unchanged and unmarked', async () => {
    const registrar = registerOne({
      kind: 'client',
      name: 't',
      description: 'd',
      parameters: {},
      handler: async () => ({ tempC: 21.5 }),
    });
    expect(JSON.parse(await registrar.invoke('t', '{}'))).toEqual({
      ok: true,
      result: { tempC: 21.5 },
      error: null,
    });
  });

  it('truncates a long error message so the envelope fits the cap', async () => {
    const registrar = registerOne({
      kind: 'client',
      name: 't',
      description: 'd',
      parameters: {},
      // Multi-byte characters make the encoded size diverge from the
      // string length, exercising the shrink loop.
      handler: async () => {
        throw new Error('é'.repeat(MAX_REPLY_BYTES));
      },
    });
    const reply = await registrar.invoke('t', '{}');
    expect(byteLength(reply)).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    const parsed = JSON.parse(reply) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });
});

describe('caller guard', () => {
  it('rejects a non-agent caller before the handler runs', async () => {
    const handler = vi.fn();
    const registrar = registerOne({
      kind: 'client',
      name: 't',
      description: 'd',
      parameters: {},
      handler,
    });
    await expect(
      registrar.invoke('t', '{}', { callerIsAgent: false }),
    ).rejects.toThrow(/only be invoked by the session agent/);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('registration', () => {
  it('registers only client tools that carry a handler', () => {
    const registrar = makeRegistrar();
    registerClientToolHandlers(registrar, [
      { kind: 'client', name: 'declared_only', description: 'd', parameters: {} },
      {
        kind: 'client',
        name: 'runnable',
        description: 'd',
        parameters: {},
        handler: async () => null,
      },
      { kind: 'web_search' },
      {
        kind: 'client',
        background: true,
        name: 'bg_declared_only',
        description: 'd',
        parameters: {},
      },
    ]);
    expect([...registrar.methods.keys()]).toEqual(['runnable']);
  });

  it('the returned disposer unregisters every installed method', () => {
    const registrar = makeRegistrar();
    const unregister = registerClientToolHandlers(registrar, [
      {
        kind: 'client',
        name: 'first',
        description: 'd',
        parameters: {},
        handler: async () => null,
      },
      {
        kind: 'client',
        name: 'second',
        description: 'd',
        parameters: {},
        handler: async () => null,
      },
    ]);
    expect([...registrar.methods.keys()]).toEqual(['first', 'second']);
    unregister();
    expect(registrar.methods.size).toBe(0);
  });

  it('a registration failure mid-loop unregisters the already-installed methods', () => {
    const registrar = makeRegistrar();
    const original = registrar.registerRpcMethod.bind(registrar);
    registrar.registerRpcMethod = (name, handler) => {
      if (name === 'second') throw new Error('duplicate rpc method');
      return original(name, handler);
    };
    expect(() =>
      registerClientToolHandlers(registrar, [
        {
          kind: 'client',
          name: 'first',
          description: 'd',
          parameters: {},
          handler: async () => null,
        },
        {
          kind: 'client',
          name: 'second',
          description: 'd',
          parameters: {},
          handler: async () => null,
        },
      ]),
    ).toThrow('duplicate rpc method');
    expect(registrar.methods.size).toBe(0);
  });
});

describe('hooks integration', () => {
  it('PreToolUse deny blocks the handler and fires PostToolUse with denied', async () => {
    const hooks: Hook[] = [];
    const post: PostToolUseContext[] = [];
    hooks.push(preToolUse(() => ({ permission: 'deny', reason: 'not allowed' })));
    hooks.push(postToolUse((ctx) => {
      post.push(ctx);
    }));
    const handler = vi.fn();
    const registrar = registerOne(
      { kind: 'client', name: 't', description: 'd', parameters: {}, handler },
      { hooks: new HookEngine(hooks) },
    );
    const reply = await registrar.invoke('t', '{}');
    expect(JSON.parse(reply)).toEqual({ ok: false, result: null, error: 'not allowed' });
    expect(handler).not.toHaveBeenCalled();
    expect(post).toHaveLength(1);
    expect(post[0].outcome).toEqual({ kind: 'denied', reason: 'not allowed' });
  });

  it('PreToolUse rewrites the arguments the handler receives', async () => {
    const hooks: Hook[] = [];
    hooks.push(preToolUse(() => ({ updatedArguments: { city: 'Oslo' } })));
    const seen: unknown[] = [];
    const registrar = registerOne(
      {
        kind: 'client',
        name: 't',
        description: 'd',
        parameters: {},
        handler: async (args: Record<string, unknown>) => {
          seen.push(args);
          return null;
        },
      },
      { hooks: new HookEngine(hooks) },
    );
    await registrar.invoke('t', JSON.stringify({ city: 'Paris' }));
    expect(seen).toEqual([{ city: 'Oslo' }]);
  });

  it('PostToolUse observes the ok outcome', async () => {
    const hooks: Hook[] = [];
    const post: PostToolUseContext[] = [];
    hooks.push(postToolUse((ctx) => {
      post.push(ctx);
    }));
    const registrar = registerOne(
      {
        kind: 'client',
        name: 't',
        description: 'd',
        parameters: {},
        handler: async () => ({ done: true }),
      },
      { hooks: new HookEngine(hooks) },
    );
    await registrar.invoke('t', '{}');
    expect(post).toHaveLength(1);
    expect(post[0].outcome).toEqual({ kind: 'ok', result: { done: true } });
    expect(post[0].sessionId).toBe(SESSION);
  });

  it('PostToolUse reports a size-capped success as ok, carrying the untruncated result', async () => {
    const hooks: Hook[] = [];
    const post: PostToolUseContext[] = [];
    hooks.push(postToolUse((ctx) => {
      post.push(ctx);
    }));
    const blob = 'x'.repeat(MAX_REPLY_BYTES);
    const registrar = registerOne(
      {
        kind: 'client',
        name: 't',
        description: 'd',
        parameters: {},
        handler: async () => ({ blob }),
      },
      { hooks: new HookEngine(hooks) },
    );
    await registrar.invoke('t', '{}');
    // The cap is a transport property; a local observer sees what the handler
    // actually returned, not what fit on the wire.
    expect(post[0].outcome).toEqual({ kind: 'ok', result: { blob } });
  });

  it('hooks are skipped when the session id is unknown', async () => {
    const hooks: Hook[] = [];
    const pre = vi.fn();
    hooks.push(preToolUse(pre));
    const registrar = registerOne(
      {
        kind: 'client',
        name: 't',
        description: 'd',
        parameters: {},
        handler: async () => null,
      },
      { hooks: new HookEngine(hooks), sessionId: null },
    );
    const reply = await registrar.invoke('t', '{}');
    expect(JSON.parse(reply)).toEqual({ ok: true, result: null, error: null });
    expect(pre).not.toHaveBeenCalled();
  });
});
