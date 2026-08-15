/** The ``tool()`` builder: construction-time checks, the three input
 *  forms, the normalized ``INVALID_INPUT`` error contract, lowering to the
 *  hand-written spec shape, and the dispatch-layer integration (envelope +
 *  hook-rewrite attribution). Python mirror: ``tests/test_tool_decorator.py``. */

import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import type { RpcInvocation } from '../../transport/types';
import type { RealtimeTool } from '../../core/agent';
import { registerClientToolHandlers } from '../../core/client_tools';
import { HookEngine, preToolUse } from '../../core/hooks';
import { ToolInputValidationError, ToolSchemaError, tool } from '../index';
import { zodInput } from '../zod';

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
    invoke(name: string, payload: string): Promise<string> {
      const handler = methods.get(name);
      if (handler === undefined) throw new Error(`no rpc method ${name}`);
      return handler({
        payload,
        callerIdentity: 'agent:sess-1',
        callerIsAgent: true,
      });
    },
  };
}

function registerOne(spec: RealtimeTool, opts: { hooks?: HookEngine } = {}) {
  const registrar = makeRegistrar();
  registerClientToolHandlers(registrar, [spec], {
    hooks: opts.hooks ?? null,
    sessionId: SESSION,
  });
  return registrar;
}

const weatherInput = () =>
  zodInput(
    z.object({
      city: z.string(),
      unit: z.enum(['c', 'f']).default('c'),
    }),
  );

describe('construction-time checks', () => {
  it('rejects a name outside the tool-name grammar', () => {
    expect(() =>
      tool({ name: 'Bad-Name', description: 'x', parameters: { type: 'object' } }),
    ).toThrow(/must match/);
  });

  it('requires a description', () => {
    expect(() =>
      tool({ name: 'get_weather', description: '', parameters: { type: 'object' } }),
    ).toThrow(/has no description/);
  });

  it('reports actual and max length for an overlong description', () => {
    expect(() =>
      tool({
        name: 'get_weather',
        description: 'x'.repeat(2049),
        parameters: { type: 'object' },
      }),
    ).toThrow(/2049 characters; the protocol limit is 2048/);
  });

  it('rejects a description with a control character', () => {
    expect(() =>
      tool({
        name: 'get_weather',
        description: 'badtext',
        parameters: { type: 'object' },
      }),
    ).toThrow(/control character/);
  });

  it('dialect-checks raw parameters', () => {
    expect(() =>
      tool({
        name: 'get_weather',
        description: 'Weather',
        parameters: {
          type: 'object',
          properties: { sku: { type: 'string', pattern: '^[A-Z]+$' } },
        },
      }),
    ).toThrow(ToolSchemaError);
  });

  it('dialect-checks unsafeParameters', () => {
    expect(() =>
      tool({
        name: 'get_weather',
        description: 'Weather',
        input: z.object({ city: z.string() }),
        unsafeParameters: { type: 'string' },
        handler: async () => null,
      }),
    ).toThrow(ToolSchemaError);
  });

  it('rejects a bare Standard Schema passed as input', () => {
    const opts = {
      name: 'get_weather',
      description: 'Weather',
      input: z.object({ city: z.string() }),
      handler: async () => null,
    };
    // @ts-expect-error a bare Standard Schema needs the unsafeParameters form
    expect(() => tool(opts)).toThrow(/unsafeParameters/);
  });
});

describe('lowering', () => {
  it('emits the hand-written spec shape', () => {
    const spec = tool({
      name: 'get_weather',
      description: 'Current weather for a city',
      input: weatherInput(),
      handler: async () => null,
    });
    expect(spec.kind).toBe('client');
    expect(spec.background).toBeUndefined();
    expect(spec.name).toBe('get_weather');
    expect(spec.description).toBe('Current weather for a city');
    expect(spec.parameters).toEqual({
      type: 'object',
      properties: {
        city: { type: 'string' },
        unit: { type: 'string', enum: ['c', 'f'], default: 'c' },
      },
      required: ['city'],
    });
    expect(typeof spec.handler).toBe('function');
  });

  it('background form lowers to a BackgroundClientToolSpec', () => {
    const spec = tool({
      name: 'export_report',
      description: 'Export a report',
      input: weatherInput(),
      background: true,
      handler: async (_args, job) => {
        await job.ack('started');
      },
    });
    expect(spec.kind).toBe('client');
    expect(spec.background).toBe(true);
  });

  it('raw form passes parameters through verbatim', () => {
    const parameters = {
      type: 'object',
      properties: { city: { type: 'string' } },
    };
    const spec = tool({
      name: 'get_weather',
      description: 'Weather',
      parameters,
    });
    expect(spec.parameters).toBe(parameters);
    expect(spec.handler).toBeUndefined();
  });
});

describe('typed validation', () => {
  it('passes validated, default-filled args to the handler', async () => {
    const seen: unknown[] = [];
    const spec = tool({
      name: 'get_weather',
      description: 'Weather',
      input: weatherInput(),
      handler: async (args) => {
        seen.push(args);
        return { ok: true };
      },
    });
    const result = await spec.handler?.({ city: 'Oslo' });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([{ city: 'Oslo', unit: 'c' }]);
  });

  it('the handler receives the validator output for a transforming schema', async () => {
    const input = zodInput(
      z.object({ city: z.string().transform((value) => value.length) }),
    );
    const seen: unknown[] = [];
    const spec = tool({
      name: 'get_weather',
      description: 'Weather',
      input,
      handler: async (args) => {
        seen.push(args.city);
        return null;
      },
    });
    expect(input.parameters).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    });
    await spec.handler?.({ city: 'Oslo' });
    expect(seen).toEqual([4]);
  });

  it('throws the normalized INVALID_INPUT shape without submitted values', async () => {
    const spec = tool({
      name: 'get_weather',
      description: 'Weather',
      input: weatherInput(),
      handler: async () => null,
    });
    const secret = 'hunter2-credential';
    let thrown: unknown = null;
    try {
      await spec.handler?.({ unit: secret });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToolInputValidationError);
    const error = thrown as ToolInputValidationError;
    expect(error.message).toBe(
      'INVALID_INPUT: get_weather rejected parameters:\n' +
        '- city: required\n' +
        '- unit: expected one of "c", "f"\n' +
        'Fix the input and retry.',
    );
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.issues)).not.toContain(secret);
  });

  it('caps issue lines at five and appends the hidden count', async () => {
    const input = zodInput(
      z.object({
        a: z.string(),
        b: z.string(),
        c: z.string(),
        d: z.string(),
        e: z.string(),
        f: z.string(),
        g: z.string(),
      }),
    );
    const spec = tool({
      name: 'many_fields',
      description: 'Many fields',
      input,
      handler: async () => null,
    });
    let thrown: unknown = null;
    try {
      await spec.handler?.({});
    } catch (err) {
      thrown = err;
    }
    const message = (thrown as ToolInputValidationError).message;
    expect(message.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(6);
    expect(message).toContain('- … and 2 more');
  });

  it('nested paths render dotted with array indices', async () => {
    const input = zodInput(
      z.object({
        items: z.array(z.object({ sku: z.string() })),
      }),
    );
    const spec = tool({
      name: 'submit_order',
      description: 'Submit an order',
      input,
      handler: async () => null,
    });
    let thrown: unknown = null;
    try {
      await spec.handler?.({ items: [{ sku: 'ok' }, {}] });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as ToolInputValidationError).message).toContain('- items[1].sku: required');
  });

  it('fails closed on a non-object handler return', async () => {
    const spec = tool({
      name: 'get_weather',
      description: 'Weather',
      input: weatherInput(),
      handler: async () => 'nope' as unknown as null,
    });
    await expect(spec.handler?.({ city: 'Oslo' })).rejects.toThrow(
      /result must be an object/,
    );
  });

  it('background typed handler validates before user code', async () => {
    const spec = tool({
      name: 'export_report',
      description: 'Export a report',
      input: weatherInput(),
      background: true,
      handler: async () => {
        throw new Error('user code must not run');
      },
    });
    const job = { ack: async () => undefined } as never;
    await expect(spec.handler?.({}, job)).rejects.toThrow(/INVALID_INPUT/);
  });
});

describe('unsafe Standard Schema form', () => {
  it('validates through the schema but reports paths only', async () => {
    const spec = tool({
      name: 'get_weather',
      description: 'Weather',
      input: z.object({ city: z.string() }),
      unsafeParameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
      },
      handler: async (args) => ({ length: args.city.length }),
    });
    expect(await spec.handler?.({ city: 'Oslo' })).toEqual({ length: 4 });

    let thrown: unknown = null;
    try {
      await spec.handler?.({ city: 42 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToolInputValidationError);
    expect((thrown as ToolInputValidationError).message).toBe(
      'INVALID_INPUT: get_weather rejected parameters:\n' +
        '- city: invalid\n' +
        'Fix the input and retry.',
    );
  });
});

describe('dispatch integration', () => {
  it('a malformed model call becomes the {ok: false} envelope', async () => {
    const spec = tool({
      name: 'get_weather',
      description: 'Weather',
      input: weatherInput(),
      handler: async () => ({ tempC: 7 }),
    });
    const registrar = registerOne(spec);
    const reply = JSON.parse(await registrar.invoke('get_weather', '{"unit":"x"}'));
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('INVALID_INPUT: get_weather rejected parameters:');
    expect(reply.error).not.toContain('"x"');
  });

  it('a hook rewrite that breaks validation logs the attribution event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const spec = tool({
        name: 'get_weather',
        description: 'Weather',
        input: weatherInput(),
        handler: async () => null,
      });
      const hooks = new HookEngine([
        preToolUse(() => ({ updatedArguments: { city: 42 } })),
      ]);
      const registrar = registerOne(spec, { hooks });
      const reply = JSON.parse(
        await registrar.invoke('get_weather', '{"city":"Oslo"}'),
      );
      expect(reply.ok).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        '[realtime] client tool validation failed after hook rewrite',
        { tool: 'get_weather' },
      );
    } finally {
      warn.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('an equal-but-reordered hook rewrite does not log the attribution event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const spec = tool({
        name: 'get_weather',
        description: 'Weather',
        input: weatherInput(),
        handler: async () => null,
      });
      const hooks = new HookEngine([
        preToolUse(() => ({ updatedArguments: { unit: 'x', city: 'Oslo' } })),
      ]);
      const registrar = registerOne(spec, { hooks });
      const reply = JSON.parse(
        await registrar.invoke('get_weather', '{"city":"Oslo","unit":"x"}'),
      );
      expect(reply.ok).toBe(false);
      expect(warn).not.toHaveBeenCalledWith(
        '[realtime] client tool validation failed after hook rewrite',
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('a model-caused validation failure does not log the attribution event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const spec = tool({
        name: 'get_weather',
        description: 'Weather',
        input: weatherInput(),
        handler: async () => null,
      });
      const registrar = registerOne(spec, { hooks: new HookEngine([]) });
      await registrar.invoke('get_weather', '{"unit":"x"}');
      expect(warn).not.toHaveBeenCalledWith(
        '[realtime] client tool validation failed after hook rewrite',
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
      errorLog.mockRestore();
    }
  });
});
