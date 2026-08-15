/**
 * JSON-Schema handling for authored client tools, against the backend's
 * restricted dialect (``client_declared.py``: allowlisted keys, top-level
 * ``type: "object"``, depth ≤ 6, ≤ 64 properties total). The TS port of the
 * reference SDK's strict builder pipeline (``_internal/schema.py``): inline
 * refs, silently drop only what doesn't change what the model should
 * produce, and throw {@link ToolSchemaError} at construction for anything
 * the dialect cannot express — otherwise the model would keep producing
 * args that bounce at runtime.
 *
 * The dialect check mirrors the backend gate node-for-node — depth counts
 * from 1 at the top level, the property cap is global across the schema —
 * and is pinned against the shared vectors in
 * ``client-tool-schema-vectors.json``.
 */

import { ToolSchemaError } from './errors';

const SCHEMA_ALLOWED_KEYS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'description',
  'anyOf',
  'default',
  'maxLength',
  'minLength',
  'maximum',
  'minimum',
]);
const SCHEMA_NUMERIC_KEYS = new Set(['maxLength', 'minLength', 'maximum', 'minimum']);
const SCHEMA_ALLOWED_TYPES = new Set([
  'object',
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'null',
]);
const SCHEMA_MAX_DEPTH = 6;
const SCHEMA_MAX_PROPERTIES = 64;

// Mirrors the backend's ``text_sanitize``: control characters and forged
// ``---`` prompt-section fences are rejected there, so catch them here at
// construction instead of at connect.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_EXCEPT_NEWLINE_RE = /[\x00-\x09\x0b-\x1f\x7f]/;
const PROMPT_FENCE_RE = /^[ \t]*-{3,}.*$/m;

/** First sanitization violation in ``value``, or ``null`` if clean. */
export function textViolation(
  value: string,
  opts: { allowNewlines: boolean },
): string | null {
  const controlRe = opts.allowNewlines
    ? CONTROL_CHARS_EXCEPT_NEWLINE_RE
    : CONTROL_CHARS_RE;
  if (controlRe.test(value)) return 'contains a control character';
  if (PROMPT_FENCE_RE.test(value)) return 'contains a prompt section delimiter';
  return null;
}

const ESCAPE_HATCH_HINT =
  'rewrite the schema within the dialect or pass hand-written raw ' +
  '`parameters` instead';

const SAFE_DROP_KEYS = new Set(['title', '$schema']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Inline ``$defs``/``$ref`` (and merge single-element ``allOf`` wrappers a
 *  generator emits for annotated nested schemas). Recursive schemas throw —
 *  the dialect has no way to express them. */
function inlineRefs(schema: Record<string, unknown>, toolName: string): unknown {
  const defs = isRecord(schema.$defs) ? schema.$defs : {};

  function resolve(node: unknown, stack: readonly string[]): unknown {
    if (Array.isArray(node)) return node.map((item) => resolve(item, stack));
    if (!isRecord(node)) return node;
    let out: Record<string, unknown> = { ...node };
    delete out.$defs;
    const allOf = out.allOf;
    if (Array.isArray(allOf) && allOf.length === 1 && isRecord(allOf[0])) {
      delete out.allOf;
      out = { ...allOf[0], ...out }; // sibling keys (description, default) win
    }
    const ref = out.$ref;
    if (typeof ref === 'string') {
      delete out.$ref;
      const defName = ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : ref;
      if (defName === ref || !(defName in defs)) {
        throw new ToolSchemaError({
          code: 'forbidden_key',
          message: `${toolName}: unresolvable $ref '${ref}'`,
        });
      }
      if (stack.includes(defName)) {
        throw new ToolSchemaError({
          code: 'recursive_schema',
          message:
            `${toolName}: recursive schema '${defName}' cannot be expressed ` +
            `in the tool-schema dialect; ${ESCAPE_HATCH_HINT}`,
        });
      }
      const resolved = resolve(defs[defName], [...stack, defName]);
      out = { ...(isRecord(resolved) ? resolved : {}), ...out };
    }
    return Object.fromEntries(
      Object.entries(out).map(([key, value]) => [key, resolve(value, stack)]),
    );
  }

  return resolve(schema, []);
}

/** Safe normalization: drop ``title``/``$schema``, drop
 *  ``additionalProperties`` when ``true``, rewrite ``const`` as a one-value
 *  ``enum``. ``additionalProperties: false`` and schema-valued
 *  ``additionalProperties`` throw — dropping them would tell the model
 *  extra keys are fine while validation rejects them. */
function normalizeNode(node: unknown, toolName: string): unknown {
  if (Array.isArray(node)) return node.map((item) => normalizeNode(item, toolName));
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  let constValue: unknown = undefined;
  let hasConst = false;
  for (const [key, value] of Object.entries(node)) {
    if (SAFE_DROP_KEYS.has(key)) continue;
    if (key === 'additionalProperties') {
      if (value === true) continue;
      const detail =
        value === false
          ? "'additionalProperties: false' (a strict/extra-forbid schema)"
          : "schema-valued 'additionalProperties' (a map type)";
      throw new ToolSchemaError({
        code: 'additional_properties_forbidden',
        message:
          `${toolName}: ${detail} cannot be expressed in the tool-schema ` +
          `dialect; use default extra-key handling, ${ESCAPE_HATCH_HINT}`,
      });
    }
    if (key === 'const') {
      hasConst = true;
      constValue = value;
      continue;
    }
    if (key === 'properties' && isRecord(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, normalizeNode(v, toolName)]),
      );
    } else if (key === 'items') {
      out[key] = normalizeNode(value, toolName);
    } else if (key === 'anyOf' && Array.isArray(value)) {
      out[key] = value.map((v) => normalizeNode(v, toolName));
    } else {
      out[key] = value;
    }
  }
  if (hasConst && !('enum' in out)) out.enum = [constValue];
  return out;
}

function isScalar(value: unknown): boolean {
  return (
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  );
}

function checkNode(
  node: unknown,
  opts: { depth: number; counts: { properties: number }; toolName: string },
): void {
  const { depth, counts, toolName } = opts;
  if (depth > SCHEMA_MAX_DEPTH) {
    throw new ToolSchemaError({
      code: 'max_depth_exceeded',
      message: `${toolName}: schema nesting exceeds depth ${SCHEMA_MAX_DEPTH}`,
    });
  }
  if (!isRecord(node)) {
    throw new ToolSchemaError({
      code: 'node_not_object',
      message: `${toolName}: schema node is not an object`,
    });
  }
  for (const [key, value] of Object.entries(node)) {
    if (!SCHEMA_ALLOWED_KEYS.has(key)) {
      throw new ToolSchemaError({
        code: 'forbidden_key',
        message:
          `${toolName}: schema key '${key}' is not in the restricted ` +
          `tool-schema dialect; ${ESCAPE_HATCH_HINT}`,
      });
    }
    if (key === 'type') {
      if (typeof value !== 'string' || !SCHEMA_ALLOWED_TYPES.has(value)) {
        throw new ToolSchemaError({
          code: 'forbidden_type',
          message: `${toolName}: schema type '${String(value)}' is not allowed`,
        });
      }
    } else if (key === 'description') {
      if (typeof value !== 'string') {
        throw new ToolSchemaError({
          code: 'invalid_text',
          message: `${toolName}: schema description is not a string`,
        });
      }
      const reason = textViolation(value, { allowNewlines: true });
      if (reason !== null) {
        throw new ToolSchemaError({
          code: 'invalid_text',
          message: `${toolName}: schema description ${reason}`,
        });
      }
    } else if (key === 'required') {
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        throw new ToolSchemaError({
          code: 'invalid_required',
          message: `${toolName}: schema 'required' is not a list of strings`,
        });
      }
    } else if (key === 'enum') {
      if (!Array.isArray(value) || !value.every(isScalar)) {
        throw new ToolSchemaError({
          code: 'invalid_enum',
          message: `${toolName}: schema 'enum' is not a list of scalars`,
        });
      }
    } else if (key === 'properties') {
      if (!isRecord(value)) {
        throw new ToolSchemaError({
          code: 'invalid_properties',
          message: `${toolName}: schema 'properties' is not an object`,
        });
      }
      counts.properties += Object.keys(value).length;
      if (counts.properties > SCHEMA_MAX_PROPERTIES) {
        throw new ToolSchemaError({
          code: 'max_properties_exceeded',
          message: `${toolName}: schema exceeds ${SCHEMA_MAX_PROPERTIES} properties`,
        });
      }
      for (const [propName, propSchema] of Object.entries(value)) {
        if (textViolation(propName, { allowNewlines: false }) !== null) {
          throw new ToolSchemaError({
            code: 'invalid_text',
            message: `${toolName}: schema property name is not a clean string`,
          });
        }
        checkNode(propSchema, { depth: depth + 1, counts, toolName });
      }
    } else if (key === 'items') {
      checkNode(value, { depth: depth + 1, counts, toolName });
    } else if (key === 'anyOf') {
      if (!Array.isArray(value)) {
        throw new ToolSchemaError({
          code: 'invalid_any_of',
          message: `${toolName}: schema 'anyOf' is not a list`,
        });
      }
      for (const variant of value) {
        checkNode(variant, { depth: depth + 1, counts, toolName });
      }
    } else if (key === 'default') {
      if (typeof value === 'string') {
        const reason = textViolation(value, { allowNewlines: false });
        if (reason !== null) {
          throw new ToolSchemaError({
            code: 'invalid_text',
            message: `${toolName}: schema default ${reason}`,
          });
        }
      } else if (
        typeof value !== 'number' &&
        typeof value !== 'boolean' &&
        value !== null
      ) {
        throw new ToolSchemaError({
          code: 'invalid_default',
          message: `${toolName}: schema 'default' must be a scalar`,
        });
      }
    } else if (SCHEMA_NUMERIC_KEYS.has(key)) {
      if (typeof value !== 'number') {
        throw new ToolSchemaError({
          code: 'invalid_bound',
          message: `${toolName}: schema '${key}' is not a number`,
        });
      }
    }
  }
}

/** Throw {@link ToolSchemaError} unless ``schema`` is a top-level object
 *  schema entirely within the restricted dialect. */
export function checkSchemaDialect(schema: unknown, toolName: string): void {
  if (!isRecord(schema) || schema.type !== 'object') {
    throw new ToolSchemaError({
      code: 'top_level_not_object',
      message: `${toolName}: parameters must declare top-level type 'object'`,
    });
  }
  checkNode(schema, { depth: 1, counts: { properties: 0 }, toolName });
}

/** Strict pipeline for an authored schema: inline refs → normalize →
 *  dialect check. Returns the wire-ready ``parameters`` object. */
export function buildToolParameters(
  schema: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> {
  const inlined = inlineRefs(schema, toolName);
  const normalized = normalizeNode(inlined, toolName);
  checkSchemaDialect(normalized, toolName);
  return normalized as Record<string, unknown>;
}
