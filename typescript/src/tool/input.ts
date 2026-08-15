/**
 * ``ToolInput`` — the vendor-free contract between a schema converter and
 * the core ``tool()`` builder: a validate function plus the already-converted
 * dialect JSON Schema.
 *
 * The type is nominally branded with a non-exported ``unique symbol``, so a
 * structurally-shaped object literal does not satisfy it: only converter
 * entry points (``zodInput`` today) can mint one, which makes "input must be
 * convertible" a compile-time fact rather than a construction-time throw.
 * The brand is type-level only; nothing extra is serialized.
 */

import type { ToolInputIssue } from './errors';

declare const TOOL_INPUT_BRAND: unique symbol;

/** A converter's validate outcome: the parsed (possibly transformed) value,
 *  or sanitized issues built from structured fields only. */
export type ToolInputParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ToolInputIssue[] };

/** A validator + dialect-converted schema pair, minted only by converter
 *  entry points (e.g. ``zodInput`` from ``cosmo-ai/tool/zod``). */
export type ToolInput<T> = {
  readonly [TOOL_INPUT_BRAND]: true;
  /** Wire-ready dialect JSON Schema describing the accepted input. */
  readonly parameters: Record<string, unknown>;
  /** Validate raw args; issues must already be sanitized (no submitted
   *  values). */
  readonly validate: (
    args: Record<string, unknown>,
  ) => Promise<ToolInputParseResult<T>>;
};

/** @internal — converter-only constructor for {@link ToolInput}. Not
 *  exported from any public entry point. */
export function mintToolInput<T>(opts: {
  parameters: Record<string, unknown>;
  validate: (args: Record<string, unknown>) => Promise<ToolInputParseResult<T>>;
}): ToolInput<T> {
  return {
    parameters: opts.parameters,
    validate: opts.validate,
  } as ToolInput<T>;
}

/**
 * The Standard Schema V1 interface (https://standardschema.dev) — vendored
 * per the spec's guidance so accepting any compliant validator does not add
 * a dependency.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export declare namespace StandardSchemaV1 {
  export type Result<Output> =
    | { readonly value: Output; readonly issues?: undefined }
    | { readonly issues: readonly Issue[] };

  export interface Issue {
    readonly message: string;
    readonly path?: readonly (PropertyKey | PathSegment)[] | undefined;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }

  export type InferOutput<S extends StandardSchemaV1> = NonNullable<
    S['~standard']['types']
  >['output'];
}

/** Normalize a Standard Schema issue path into the sanitized issue path
 *  shape (symbols stringified — the dialect never emits symbol keys). */
export function standardIssuePath(
  path: readonly (PropertyKey | StandardSchemaV1.PathSegment)[] | undefined,
): (string | number)[] {
  if (path === undefined) return [];
  return path.map((segment) => {
    const key =
      typeof segment === 'object' && segment !== null ? segment.key : segment;
    return typeof key === 'number' ? key : String(key);
  });
}
