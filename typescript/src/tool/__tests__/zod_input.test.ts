/** The Zod converter: emitted dialect schemas for the common shapes, and
 *  construction-time rejection of lossy constructs. Runs against zod 4, the
 *  only supported major; CI brackets the guard at the declared peer floor. */

import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { ToolSchemaError } from '../errors';
import type { ToolInput } from '../input';
import { zodInput } from '../zod';

/** The version guard wraps the parameter in a conditional type. Written
 *  wrong, it swallows inference and every handler silently receives
 *  ``unknown`` — a `tsc`-only regression no runtime assertion would catch. */
type IsExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const inferenceProbe = zodInput(z.object({ city: z.string() }));
const inferredThroughTheGuard: IsExact<typeof inferenceProbe, ToolInput<{ city: string }>> =
  true;
void inferredThroughTheGuard;

describe('zodInput schema emission', () => {
  it('emits a dialect object schema for a nested model', () => {
    const input = zodInput(
      z.object({
        address: z.object({
          city: z.string().describe('City name'),
          zip: z.string().optional(),
        }),
        count: z.number().int().min(0).max(10).optional(),
      }),
    );
    expect(input.parameters).toEqual({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name' },
            zip: { type: 'string' },
          },
          required: ['city'],
        },
        count: { type: 'integer', minimum: 0, maximum: 10 },
      },
      required: ['address'],
    });
  });

  it('describes the accepted input for defaulted fields', () => {
    const input = zodInput(z.object({ unit: z.enum(['c', 'f']).default('c') }));
    expect(input.parameters).toEqual({
      type: 'object',
      properties: {
        unit: { type: 'string', enum: ['c', 'f'], default: 'c' },
      },
    });
  });

  it('rejects a non-object top level', () => {
    expect(() => zodInput(z.string() as never)).toThrow(ToolSchemaError);
  });

  it('rejects a strict object (additionalProperties: false)', () => {
    expect(() => zodInput(z.strictObject({ a: z.string() }))).toThrow(
      /additionalProperties/,
    );
  });

  it('rejects a record (schema-valued additionalProperties)', () => {
    expect(() =>
      zodInput(z.object({ labels: z.record(z.string(), z.string()) })),
    ).toThrow(/additionalProperties/);
  });

  it('rejects a regex pattern as a lossy construct', () => {
    let thrown: unknown = null;
    try {
      zodInput(z.object({ sku: z.string().regex(/^[A-Z]+$/) }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToolSchemaError);
    expect((thrown as ToolSchemaError).code).toBe('forbidden_key');
  });

  it('labels a dialect rejection with the name hint', () => {
    expect(() =>
      zodInput(z.object({ sku: z.string().regex(/^[A-Z]+$/) }), {
        name: 'get_weather',
      }),
    ).toThrow(/get_weather: schema key 'pattern'/);
  });

  it('rejects a string format as a lossy construct', () => {
    expect(() => zodInput(z.object({ contact: z.email() }))).toThrow(
      ToolSchemaError,
    );
  });

  it('rejects an exclusive bound as a lossy construct', () => {
    expect(() => zodInput(z.object({ n: z.number().positive() }))).toThrow(
      ToolSchemaError,
    );
  });

  it('rejects array-length bounds as lossy constructs', () => {
    let thrown: unknown = null;
    try {
      zodInput(z.object({ tags: z.array(z.string()).min(1) }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToolSchemaError);
    expect((thrown as ToolSchemaError).code).toBe('forbidden_key');
  });

  it('nullable lowers to anyOf with null', () => {
    const input = zodInput(z.object({ note: z.string().max(32).nullable() }));
    expect(input.parameters).toEqual({
      type: 'object',
      properties: {
        note: {
          anyOf: [{ type: 'string', maxLength: 32 }, { type: 'null' }],
        },
      },
      required: ['note'],
    });
  });

  it('literal lowers to a one-value enum', () => {
    const input = zodInput(z.object({ mode: z.literal('fast') }));
    expect(input.parameters).toEqual({
      type: 'object',
      properties: { mode: { type: 'string', enum: ['fast'] } },
      required: ['mode'],
    });
  });
});

describe('zodInput validation', () => {
  it('applies defaults and coercions the schema declares', async () => {
    const input = zodInput(z.object({ unit: z.enum(['c', 'f']).default('c') }));
    const result = await input.validate({});
    expect(result).toEqual({ ok: true, value: { unit: 'c' } });
  });

  it('sanitizes issues from structured fields only', async () => {
    const input = zodInput(
      z.object({
        city: z.string(),
        unit: z.enum(['c', 'f']),
        count: z.number().int().min(2).max(10),
        note: z.string().max(4),
      }),
    );
    const secret = 'super-secret-value';
    const result = await input.validate({
      unit: secret,
      count: 1,
      note: 'toolong',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const byPath = Object.fromEntries(
      result.issues.map((issue) => [issue.path.join('.'), issue.constraint]),
    );
    expect(byPath).toEqual({
      city: 'required',
      unit: 'expected one of "c", "f"',
      count: 'must be >= 2',
      note: 'must be at most 4 characters',
    });
    expect(JSON.stringify(result.issues)).not.toContain(secret);
  });
});
