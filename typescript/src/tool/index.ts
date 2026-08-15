/**
 * First-class client-tool builder: ``tool({ input, handler })``.
 *
 * One runtime schema drives the model-facing JSON Schema, runtime
 * validation, and the handler's argument types::
 *
 *     import { tool } from 'cosmo-ai/tool';
 *     import { zodInput } from 'cosmo-ai/tool/zod';
 *
 *     const getWeather = tool({
 *       name: 'get_weather',
 *       description: 'Current weather for a city',
 *       input: zodInput(z.object({ city: z.string(), unit: z.enum(['c', 'f']) })),
 *       handler: async ({ city, unit }) => ({ tempC: await lookup(city) }),
 *     });
 *
 * The builder lowers to the existing spec types ({@link ClientToolSpec} /
 * {@link BackgroundClientToolSpec}); hand-written raw ``parameters`` remain
 * the advanced escape hatch. The emitted schema is checked against the
 * backend's restricted dialect when the tool is constructed, so a schema
 * the server would reject fails at startup instead of surfacing as a
 * ``ready.rejectedTools`` entry at connect.
 *
 * Three input forms:
 *
 * 1. ``{ input: ToolInput }`` — the typed path. Only converter entry points
 *    (``zodInput`` from ``cosmo-ai/tool/zod``) mint a ``ToolInput``.
 * 2. ``{ parameters }`` — the raw escape hatch: hand-written dialect JSON
 *    Schema, handler args typed ``Record<string, unknown>``, no validation.
 * 3. ``{ input: StandardSchemaV1, unsafeParameters }`` — for vendors without
 *    a converter. The field name is the warning: nothing keeps the validator
 *    and the model-facing schema in agreement, and issue lines carry only
 *    the failing path (a foreign vendor's issue ``message`` may embed
 *    submitted values, so it is never used).
 *
 * A malformed model call throws {@link ToolInputValidationError} inside the
 * synthesized handler before user code runs; the dispatch layer turns it
 * into the ``{ok: false, error}`` envelope so the model can self-correct.
 * PreToolUse hooks still see (and may rewrite) raw args — validation applies
 * to the post-hook args.
 *
 * Validation semantics are the runtime schema library's own. The emitted
 * schema describes the **accepted input**; the handler receives the
 * **validator's output** (transforms are legal).
 */

import type {
  BackgroundClientToolSpec,
  ClientToolSpec,
} from '../core/agent';
import type { ClientToolJob } from '../core/client_tool_jobs';

import {
  ToolInputValidationError,
  formatInvalidInput,
  type ToolInputIssue,
} from './errors';
import {
  standardIssuePath,
  type StandardSchemaV1,
  type ToolInput,
} from './input';
import { buildToolParameters, checkSchemaDialect, textViolation } from './schema';

export { ToolInputValidationError, ToolSchemaError } from './errors';
export type { ToolInputIssue } from './errors';
export type { StandardSchemaV1, ToolInput, ToolInputParseResult } from './input';

const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;
const MAX_DESCRIPTION_LEN = 2048;

/** The reply envelope's ``result`` slot is ``object | null`` across the
 *  cross-SDK contract, so handler results stay object-shaped. */
type ToolResult = Record<string, unknown> | null | undefined | void;

type CommonOptions = {
  name: string;
  description: string;
};

export type TypedToolOptions<T, R extends ToolResult> = CommonOptions & {
  input: ToolInput<T>;
  parameters?: undefined;
  unsafeParameters?: undefined;
  background?: false;
  handler: (args: T) => Promise<R>;
};

export type TypedBackgroundToolOptions<T> = CommonOptions & {
  input: ToolInput<T>;
  parameters?: undefined;
  unsafeParameters?: undefined;
  background: true;
  handler: (args: T, job: ClientToolJob) => Promise<void>;
};

export type RawToolOptions<R extends ToolResult> = CommonOptions & {
  input?: undefined;
  parameters: Record<string, unknown>;
  unsafeParameters?: undefined;
  background?: false;
  handler?: (args: Record<string, unknown>) => Promise<R>;
};

export type RawBackgroundToolOptions = CommonOptions & {
  input?: undefined;
  parameters: Record<string, unknown>;
  unsafeParameters?: undefined;
  background: true;
  handler?: (args: Record<string, unknown>, job: ClientToolJob) => Promise<void>;
};

export type UnsafeToolOptions<S extends StandardSchemaV1, R extends ToolResult> =
  CommonOptions & {
    input: S;
    parameters?: undefined;
    unsafeParameters: Record<string, unknown>;
    background?: false;
    handler: (args: StandardSchemaV1.InferOutput<S>) => Promise<R>;
  };

export type UnsafeBackgroundToolOptions<S extends StandardSchemaV1> =
  CommonOptions & {
    input: S;
    parameters?: undefined;
    unsafeParameters: Record<string, unknown>;
    background: true;
    handler: (
      args: StandardSchemaV1.InferOutput<S>,
      job: ClientToolJob,
    ) => Promise<void>;
  };

export function tool<T, R extends ToolResult>(
  opts: TypedToolOptions<T, R>,
): ClientToolSpec;
export function tool<T>(opts: TypedBackgroundToolOptions<T>): BackgroundClientToolSpec;
export function tool<R extends ToolResult>(opts: RawToolOptions<R>): ClientToolSpec;
export function tool(opts: RawBackgroundToolOptions): BackgroundClientToolSpec;
export function tool<S extends StandardSchemaV1, R extends ToolResult>(
  opts: UnsafeToolOptions<S, R>,
): ClientToolSpec;
export function tool<S extends StandardSchemaV1>(
  opts: UnsafeBackgroundToolOptions<S>,
): BackgroundClientToolSpec;
export function tool(
  opts:
    | TypedToolOptions<unknown, ToolResult>
    | TypedBackgroundToolOptions<unknown>
    | RawToolOptions<ToolResult>
    | RawBackgroundToolOptions
    | UnsafeToolOptions<StandardSchemaV1, ToolResult>
    | UnsafeBackgroundToolOptions<StandardSchemaV1>,
): ClientToolSpec | BackgroundClientToolSpec {
  checkName(opts.name);
  checkDescription(opts.name, opts.description);
  const { parameters, validate } = resolveInput(opts);

  if (opts.background === true) {
    const authored = opts.handler;
    const handler =
      authored === undefined
        ? undefined
        : async (args: Record<string, unknown>, job: ClientToolJob): Promise<void> => {
            await authored((await validate(args)) as Record<string, unknown>, job);
          };
    return {
      kind: 'client',
      background: true,
      name: opts.name,
      description: opts.description,
      parameters,
      handler,
    };
  }

  const authored = opts.handler;
  const handler =
    authored === undefined
      ? undefined
      : async (
          args: Record<string, unknown>,
        ): Promise<Record<string, unknown> | null | undefined | void> => {
          const result = await authored((await validate(args)) as Record<string, unknown>);
          return checkedResult(result, opts.name);
        };
  return {
    kind: 'client',
    name: opts.name,
    description: opts.description,
    parameters,
    handler,
  };
}

type ResolvedInput = {
  parameters: Record<string, unknown>;
  /** Identity for the raw form; throws {@link ToolInputValidationError} on
   *  a malformed model call otherwise. */
  validate: (args: Record<string, unknown>) => Promise<never> | Promise<unknown>;
};

function isToolInput(value: unknown): value is ToolInput<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ToolInput<unknown>).validate === 'function' &&
    typeof (value as ToolInput<unknown>).parameters === 'object'
  );
}

function resolveInput(
  opts:
    | TypedToolOptions<unknown, ToolResult>
    | TypedBackgroundToolOptions<unknown>
    | RawToolOptions<ToolResult>
    | RawBackgroundToolOptions
    | UnsafeToolOptions<StandardSchemaV1, ToolResult>
    | UnsafeBackgroundToolOptions<StandardSchemaV1>,
): ResolvedInput {
  if (opts.parameters !== undefined) {
    checkSchemaDialect(opts.parameters, opts.name);
    return { parameters: opts.parameters, validate: async (args) => args };
  }
  if (opts.unsafeParameters !== undefined) {
    const schema = opts.input;
    checkSchemaDialect(opts.unsafeParameters, opts.name);
    return {
      parameters: opts.unsafeParameters,
      validate: (args) => validateStandard(schema, args, opts.name),
    };
  }
  const input = opts.input;
  if (!isToolInput(input)) {
    throw new TypeError(
      `tool '${opts.name}': input must be a ToolInput minted by a converter ` +
        `entry point (e.g. zodInput from 'cosmo-ai/tool/zod'); a bare ` +
        `Standard Schema needs the unsafeParameters form`,
    );
  }
  return {
    parameters: input.parameters,
    validate: async (args) => {
      const parsed = await input.validate(args);
      if (!parsed.ok) {
        throw new ToolInputValidationError(
          formatInvalidInput(opts.name, parsed.issues),
          { issues: parsed.issues },
        );
      }
      return parsed.value;
    },
  };
}

/** Validate through a bare Standard Schema. Issue lines carry the failing
 *  path only — a foreign vendor's ``message`` may embed submitted values. */
async function validateStandard(
  schema: StandardSchemaV1,
  args: Record<string, unknown>,
  toolName: string,
): Promise<unknown> {
  const result = await schema['~standard'].validate(args);
  if (result.issues === undefined) return result.value;
  const issues: ToolInputIssue[] = result.issues.map((issue) => ({
    path: standardIssuePath(issue.path),
    code: 'invalid',
    constraint: 'invalid',
  }));
  throw new ToolInputValidationError(formatInvalidInput(toolName, issues), {
    issues,
  });
}

function checkName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `tool name '${name}' must match ${NAME_RE.source}`,
    );
  }
}

function checkDescription(name: string, description: string): void {
  if (description === '') {
    throw new Error(
      `tool '${name}' has no description — the description is model-facing ` +
        `and required`,
    );
  }
  if (description.length > MAX_DESCRIPTION_LEN) {
    throw new Error(
      `tool '${name}' description is ${description.length} characters; the ` +
        `protocol limit is ${MAX_DESCRIPTION_LEN}`,
    );
  }
  const reason = textViolation(description, { allowNewlines: true });
  if (reason !== null) {
    throw new Error(`tool '${name}' description ${reason}`);
  }
}

/** Fail closed on a handler return the wire cannot carry: the reply
 *  envelope's ``result`` slot is ``object | null``, so a non-object return
 *  is a handler bug surfaced as a tool error. */
function checkedResult(
  result: unknown,
  toolName: string,
): Record<string, unknown> | null | undefined {
  if (
    result === null ||
    result === undefined ||
    (typeof result === 'object' && !Array.isArray(result))
  ) {
    return result as Record<string, unknown> | null | undefined;
  }
  throw new TypeError(
    `tool handler '${toolName}' returned ${typeof result}; a client tool ` +
      `result must be an object (serialized as the JSON object the model ` +
      `receives), null, or undefined`,
  );
}
