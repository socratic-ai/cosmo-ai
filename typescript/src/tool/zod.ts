/**
 * ``zodInput`` — the Zod converter entry point for ``tool({ input })``.
 *
 * Statically imports the Zod v4 API (the ``zod/v4`` subpath, which must
 * resolve to zod ^4.2 — see ``ZodV4Guard``); ``zod`` is an optional peer
 * dependency resolved only by importers of ``cosmo-ai/tool/zod``. The emitted
 * JSON Schema describes the **accepted input** (``io: 'input'``); the
 * handler receives the **validator's output**, so transforms and defaults
 * behave as the Zod schema says.
 *
 * Conversion runs the strict builder pipeline at the ``zodInput()`` call:
 * ``z.toJSONSchema`` → ref inlining → normalize (safe drops silent, lossy
 * constructs throw ``ToolSchemaError``) → restricted-dialect check.
 *
 * Validation issues are sanitized from Zod's structured fields only
 * (``path`` / ``code`` / expected values) — ``issue.message`` can embed the
 * submitted value and is never used.
 */

import * as z from 'zod/v4';

import type { ToolInputIssue } from './errors';
import { mintToolInput, type ToolInput } from './input';
import { buildToolParameters } from './schema';

const TYPE_WORDS: Record<string, string> = {
  string: 'a string',
  number: 'a number',
  int: 'an integer',
  bigint: 'an integer',
  boolean: 'a boolean',
  array: 'an array',
  object: 'an object',
  null: 'null',
  undefined: 'undefined',
};

/** The structured fields this converter reads off a Zod issue. ``input`` is
 *  only ever compared against ``undefined`` (missing-key detection) — it is
 *  the submitted value and must never be echoed. */
type ZodIssueLike = {
  code?: string;
  path: PropertyKey[];
  input?: unknown;
  expected?: string;
  values?: unknown[];
  keys?: string[];
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  inclusive?: boolean;
  format?: string;
  divisor?: number;
};

function issueConstraint(issue: ZodIssueLike): string {
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.input === undefined) return 'required';
      const word = issue.expected !== undefined ? TYPE_WORDS[issue.expected] : undefined;
      return word !== undefined ? `expected ${word}` : `expected ${issue.expected}`;
    }
    case 'invalid_value':
    case 'invalid_enum_value': {
      const values = issue.values;
      if (values !== undefined && values.length > 0) {
        return `expected one of ${values.map((v) => JSON.stringify(v)).join(', ')}`;
      }
      return 'not an allowed value';
    }
    case 'too_small':
    case 'too_big': {
      const small = issue.code === 'too_small';
      const bound = small ? issue.minimum : issue.maximum;
      if (issue.origin === 'string') {
        return `must be ${small ? 'at least' : 'at most'} ${bound} characters`;
      }
      if (issue.origin === 'array') {
        return `must have ${small ? 'at least' : 'at most'} ${bound} items`;
      }
      const inclusive = issue.inclusive !== false;
      const op = small ? (inclusive ? '>=' : '>') : inclusive ? '<=' : '<';
      return `must be ${op} ${bound}`;
    }
    case 'unrecognized_keys': {
      const keys = issue.keys ?? [];
      return keys.length > 0 ? `unexpected keys: ${keys.join(', ')}` : 'unexpected keys';
    }
    case 'invalid_union':
      return 'does not match any allowed variant';
    case 'invalid_format':
      return issue.format !== undefined ? `invalid ${issue.format}` : 'invalid format';
    case 'not_multiple_of':
      return issue.divisor !== undefined
        ? `must be a multiple of ${issue.divisor}`
        : 'must be a multiple';
    default:
      return `invalid (${issue.code ?? 'unknown'})`;
  }
}

function sanitizeIssues(issues: readonly ZodIssueLike[]): ToolInputIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map((segment) =>
      typeof segment === 'number' ? segment : String(segment),
    ),
    code: issue.code ?? 'unknown',
    constraint: issueConstraint(issue),
  }));
}

/** ``zod/v4`` also resolves under zod@3.25's compat shim, which *is* zod-core
 *  4.0 — it declares ``{ major: 4, minor: 0 }`` too, so nothing at the type
 *  level separates the shim from a genuine zod@4.0. ``toJSONSchema`` on
 *  ``ZodType`` landed in 4.2, which is why the peer range floors there rather
 *  than at ^4.0. Without this guard the mismatch surfaces only as a structural
 *  diff over ``ZodType``'s members, which never mentions versions. */
type ZodVersionMismatch = {
  readonly ['cosmo-ai requires zod@^4.2; the resolved "zod/v4" is older (zod@4.0/4.1, or the zod@3.25 compat shim)']: never;
};
type ZodV4Guard = 'toJSONSchema' extends keyof z.ZodType ? never : ZodVersionMismatch;

/** Convert a Zod object schema into a {@link ToolInput}: the dialect JSON
 *  Schema plus a validator whose issues are sanitized from structured
 *  fields only. Throws ``ToolSchemaError`` at the call when the schema
 *  cannot be expressed in the restricted dialect; ``opts.name`` labels
 *  that error with the tool the schema is for. */
export function zodInput<S extends z.ZodType>(
  schema: [ZodV4Guard] extends [never] ? S : ZodV4Guard,
  opts?: { name?: string },
): ToolInput<z.output<S>> {
  const raw = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  const parameters = buildToolParameters(raw, opts?.name ?? 'zodInput');
  return mintToolInput<z.output<S>>({
    parameters,
    validate: async (args) => {
      const result = await schema.safeParseAsync(args);
      if (result.success) {
        return { ok: true, value: result.data as z.output<S> };
      }
      return {
        ok: false,
        issues: sanitizeIssues(result.error.issues as readonly ZodIssueLike[]),
      };
    },
  });
}
