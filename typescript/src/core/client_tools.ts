/**
 * Internal binding of client-tool handlers to the transport RPC bridge —
 * the TS port of the reference SDK's ``_client_tools.py``.
 *
 * The public surface (``ClientToolSpec`` / ``BackgroundClientToolSpec``
 * with a ``handler``) carries no transport vocabulary. This module adapts
 * each handler into an RPC method whose request payload is the
 * JSON-encoded args and whose reply is the JSON envelope
 * ``{ok, result, error}``.
 *
 * A ``ClientToolSpec`` handler is plain (``(args) => result``). A
 * ``BackgroundClientToolSpec`` handler (``(args, job) => void``) receives a
 * ``ClientToolJob``: it calls ``job.ack(note)`` to release the RPC reply
 * early (a ``deferred`` envelope) and keeps running; when the work finishes
 * it calls ``job.complete(...)`` / ``job.fail(...)``, which publishes a
 * ``tool_job_result`` message the server injects into the live session.
 *
 * Only the session's agent participant may invoke a client tool; an
 * invocation from any non-agent caller is rejected so the transport
 * surfaces an error to the caller rather than running the handler.
 */

import { log } from './logger';
import type { RpcInvocation, Unsubscribe } from '../transport/types';

import { ToolInputValidationError } from '../tool/errors';
import type {
  BackgroundClientToolHandler,
  BackgroundClientToolSpec,
  ClientToolHandler,
  RealtimeTool,
} from './agent';
import {
  ClientToolJob,
  type ClientToolJobSink,
  TRUNCATION_SUFFIX,
  encodedLength,
} from './client_tool_jobs';
import type { HookEngine, ToolOutcome } from './hooks';

// Cap the serialized reply so a runaway handler result cannot exceed the
// transport's payload ceiling. Error text, ack notes, and success results
// are all shortened to fit rather than dropped. Pinned against
// ``sdk-client-tool-vectors.json`` so the three SDKs cannot drift.
/** @internal — shared with the tests and the conformance vectors. */
export const MAX_REPLY_BYTES = 15 * 1024;

/** @internal */
export const TRUNCATION_MARKER_KEY = 'cosmo_sdk_truncated';

/** @internal */
export const TRUNCATION_MARKER_NOTE =
  'partial result — do not answer as if it were complete; ' +
  'narrow the request or say what is missing.';

function newJobId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function replyEnvelope(opts: {
  ok: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
  deferred?: boolean;
  jobId?: string;
}): string {
  const envelope: Record<string, unknown> = {
    ok: opts.ok,
    result: opts.result,
    error: opts.error,
  };
  // Only a deferred ack carries these keys, so a normal reply is byte-unchanged.
  if (opts.deferred === true) {
    envelope.deferred = true;
    envelope.job_id = opts.jobId;
  }
  return JSON.stringify(envelope);
}

/** Serialize ``build(text)``, shrinking ``text`` until the envelope fits
 *  the size cap. */
function fitReply(text: string, build: (text: string) => string): string {
  let envelope = build(text);
  if (encodedLength(envelope) <= MAX_REPLY_BYTES) return envelope;
  log.warn('[realtime] client tool reply truncated to fit the size cap');
  // JSON-escaping and the multi-byte suffix make the encoded size hard to
  // predict from the text length, so shrink the kept prefix until the full
  // envelope fits. Scalars, not UTF-16 units — slicing mid-surrogate would
  // put a lone surrogate on the wire.
  const scalars = Array.from(text);
  let keep = scalars.length;
  while (keep > 0) {
    const truncated = scalars.slice(0, keep).join('') + TRUNCATION_SUFFIX;
    envelope = build(truncated);
    const overshoot = encodedLength(envelope) - MAX_REPLY_BYTES;
    if (overshoot <= 0) return envelope;
    keep -= Math.max(overshoot, 1);
  }
  return build(TRUNCATION_SUFFIX);
}

/** An ``{ok: false}`` envelope whose serialized form fits the size cap,
 *  truncating the error text if needed. */
function errorReply(message: string): string {
  return fitReply(message, (text) =>
    replyEnvelope({ ok: false, result: null, error: text }),
  );
}

/** The deferred-ack success envelope, truncating the note if needed so the
 *  reply fits the size cap. */
function deferredReply(note: string, jobId: string): string {
  return fitReply(note, (text) =>
    replyEnvelope({
      ok: true,
      result: text !== '' ? { note: text } : {},
      error: null,
      deferred: true,
      jobId,
    }),
  );
}

function shrinkOne(text: string, maxScalars: number): string {
  const scalars = Array.from(text);
  if (scalars.length <= maxScalars) return text;
  const shortened = scalars.slice(0, maxScalars).join('') + TRUNCATION_SUFFIX;
  // Never spend more bytes than the string being replaced: the suffix is
  // longer than what it stands in for on a short string. Keeping the whole
  // string there is both smaller and truthful, and it is what makes the
  // shortened size rise monotonically with the allowance — the property
  // `successReply`'s binary search needs to be able to prune.
  return encodedLength(shortened) >= encodedLength(text) ? text : shortened;
}

/** Shorten every string in ``value`` to at most ``maxScalars`` Unicode
 *  scalars, leaving any string the suffix would not actually shrink. Applied
 *  to the original each time, so a second pass never truncates a suffix the
 *  first wrote. Scalars rather than `String.length`'s UTF-16 units: the one
 *  unit all three SDKs count identically, and slicing on it cannot strand a
 *  lone surrogate. Pinned by `replyLimits.shrink`.
 *
 *  @internal — exported for the conformance vectors. */
export function shrinkStrings(value: unknown, maxScalars: number): unknown {
  if (typeof value === 'string') return shrinkOne(value, maxScalars);
  if (Array.isArray(value)) return value.map((item) => shrinkStrings(item, maxScalars));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        shrinkStrings(item, maxScalars),
      ]),
    );
  }
  return value;
}

/** What one top-level entry costs the envelope — its key as well as its value,
 *  since a long key spends the same bytes a long value does. */
function entryBytes(key: string, value: unknown): number {
  return encodedLength(JSON.stringify({ [key]: value }));
}

function longestStringLength(value: unknown): number {
  if (typeof value === 'string') return Array.from(value).length;
  if (Array.isArray(value)) {
    return value.reduce<number>((max, item) => Math.max(max, longestStringLength(item)), 0);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (max, item) => Math.max(max, longestStringLength(item)),
      0,
    );
  }
  return 0;
}

/** The envelope for ``result`` plus the truncation marker: the note, and how
 *  much of ``originalBytes`` survived. */
function markedEnvelope(
  result: Record<string, unknown>,
  originalBytes: number,
): string {
  return replyEnvelope({
    ok: true,
    result: {
      ...result,
      [TRUNCATION_MARKER_KEY]: {
        note: TRUNCATION_MARKER_NOTE,
        kept_bytes: encodedLength(JSON.stringify(result)),
        original_bytes: originalBytes,
      },
    },
    error: null,
  });
}

/** An ``{ok: true}`` envelope whose serialized form fits the size cap.
 *
 *  An over-budget result is shortened structurally rather than by cutting
 *  the serialized envelope, so the reply the model reads is always
 *  well-formed JSON: strings shrink to the largest common allowance that
 *  fits, and if the non-string structure alone still overflows, top-level
 *  entries are dropped largest-first. Either way the result carries
 *  ``TRUNCATION_MARKER_KEY`` so the model knows to ask a narrower question
 *  instead of reading the reply as the whole answer. */
function successReply(result: Record<string, unknown>): {
  reply: string;
  truncated: boolean;
} {
  const envelope = replyEnvelope({ ok: true, result, error: null });
  if (encodedLength(envelope) <= MAX_REPLY_BYTES) {
    return { reply: envelope, truncated: false };
  }
  const originalBytes = encodedLength(JSON.stringify(result));

  // Largest per-string allowance that fits. JSON escaping makes encoded size
  // unpredictable from character counts, so search rather than compute it.
  let low = 0;
  let high = longestStringLength(result);
  let best: string | null = null;
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    const candidate = markedEnvelope(
      shrinkStrings(result, mid) as Record<string, unknown>,
      originalBytes,
    );
    if (encodedLength(candidate) <= MAX_REPLY_BYTES) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best !== null) return { reply: best, truncated: true };

  // Non-string structure (long arrays, many keys) is what overflows: drop
  // top-level entries, biggest first, until what remains fits. Each entry is
  // sized once, and how many to drop is found by binary search — dropping more
  // only ever shrinks the reply, so the fit is monotone in the count.
  const fields = shrinkStrings(result, 0) as Record<string, unknown>;
  const widestFirst = Object.keys(fields).sort((a, b) => {
    const delta = entryBytes(b, fields[b]) - entryBytes(a, fields[a]);
    return delta !== 0 ? delta : (a < b ? 1 : -1);
  });
  const afterDropping = (count: number): string => {
    const dropped = new Set(widestFirst.slice(0, count));
    return markedEnvelope(
      Object.fromEntries(Object.entries(fields).filter(([key]) => !dropped.has(key))),
      originalBytes,
    );
  };
  low = 1;
  high = widestFirst.length;
  let fitted: string | null = null;
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    const candidate = afterDropping(mid);
    if (encodedLength(candidate) <= MAX_REPLY_BYTES) {
      fitted = candidate;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return { reply: fitted ?? markedEnvelope({}, originalBytes), truncated: true };
}

/** Build the success envelope for a handler result, shortening it to fit the
 *  payload ceiling when it has to. The outcome carries the handler's own
 *  result, not the shortened one — the cap is a transport property, not a
 *  tool failure. */
function envelopeResult(result: Record<string, unknown> | null): {
  reply: string;
  outcome: ToolOutcome;
} {
  if (result === null) {
    return { reply: replyEnvelope({ ok: true, result, error: null }), outcome: { kind: 'ok', result } };
  }
  const built = successReply(result);
  if (built.truncated) {
    log.warn('[realtime] client tool result truncated to fit the reply size limit');
  }
  return { reply: built.reply, outcome: { kind: 'ok', result } };
}

/** Decode the RPC request payload into an args object, or return an error
 *  message string for a malformed payload. */
function decodeArgs(payload: string): Record<string, unknown> | string {
  let parsed: unknown;
  try {
    parsed = payload === '' ? {} : JSON.parse(payload);
  } catch {
    log.warn('[realtime] client tool args were not valid JSON');
    return 'client tool args were not valid JSON';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'client tool args must be a JSON object';
  }
  return parsed as Record<string, unknown>;
}

/** @internal — shared with the SDK tools that report a handler's failure to
 *  the model as prose rather than as an RPC error. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message !== '' ? err.message : err.name;
  return String(err);
}

/** A PreToolUse hook can rewrite valid model args into invalid handler
 *  args; the resulting INVALID_INPUT envelope would wrongly tell the model
 *  to retry. Only this layer knows a rewrite happened, so surface it as a
 *  structured event for the developer (the envelope is unchanged). */
function warnIfHookRewriteBrokeValidation(
  err: unknown,
  toolName: string,
  argsRewritten: () => boolean,
): void {
  if (err instanceof ToolInputValidationError && argsRewritten()) {
    log.warn('[realtime] client tool validation failed after hook rewrite', {
      tool: toolName,
    });
  }
}

/** Key-order-insensitive, matching the reference SDK's dict inequality. */
function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => jsonEquals(item, b[i]));
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const aKeys = Object.keys(a);
    return (
      aKeys.length === Object.keys(b).length &&
      aKeys.every((key) => key in b && jsonEquals(a[key], b[key]))
    );
  }
  return false;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wasRewritten(
  decoded: Record<string, unknown>,
  resolved: Record<string, unknown>,
): boolean {
  return resolved !== decoded && !jsonEquals(resolved, decoded);
}

/** Run PreToolUse. Returns ``{args}`` to proceed with possibly rewritten
 *  args, or ``{deniedReply}`` when a hook denied the call. */
async function applyPreHook(
  hooks: HookEngine | null,
  sessionId: string | null,
  opts: { toolName: string; args: Record<string, unknown> },
): Promise<
  { args: Record<string, unknown>; deniedReply: null } | { args: null; deniedReply: string }
> {
  if (hooks === null || sessionId === null) {
    return { args: opts.args, deniedReply: null };
  }
  const decision = await hooks.runPreToolUse({
    toolName: opts.toolName,
    arguments: opts.args,
    sessionId,
  });
  if (decision.denied) {
    const reason = decision.reason ?? 'denied by hook';
    await hooks.runPostToolUse({
      event: 'PostToolUse',
      toolName: opts.toolName,
      arguments: decision.arguments,
      outcome: { kind: 'denied', reason },
      sessionId,
    });
    return { args: null, deniedReply: errorReply(reason) };
  }
  return { args: decision.arguments, deniedReply: null };
}

async function firePostHook(
  hooks: HookEngine | null,
  sessionId: string | null,
  toolName: string,
  args: Record<string, unknown>,
  outcome: ToolOutcome,
): Promise<void> {
  if (hooks === null || sessionId === null) return;
  await hooks.runPostToolUse({
    event: 'PostToolUse',
    toolName,
    arguments: args,
    outcome,
    sessionId,
  });
}

/** Decode the RPC request, run PreToolUse hooks, run a plain handler, build
 *  the reply envelope, then fire PostToolUse with the final outcome. */
export async function invokeClientToolHandler(
  handler: ClientToolHandler,
  payload: string,
  opts: { toolName: string; hooks?: HookEngine | null; sessionId?: string | null },
): Promise<string> {
  const decoded = decodeArgs(payload);
  if (typeof decoded === 'string') return errorReply(decoded);

  const hooks = opts.hooks ?? null;
  const sessionId = opts.sessionId ?? null;
  const pre = await applyPreHook(hooks, sessionId, {
    toolName: opts.toolName,
    args: decoded,
  });
  if (pre.deniedReply !== null) return pre.deniedReply;

  let reply: string;
  let outcome: ToolOutcome;
  try {
    const result = await handler(pre.args);
    ({ reply, outcome } = envelopeResult(result ?? null));
  } catch (err) {
    log.error('[realtime] client tool handler failed', { tool: opts.toolName }, err);
    warnIfHookRewriteBrokeValidation(err, opts.toolName, () =>
      wasRewritten(decoded, pre.args),
    );
    const message = errorMessage(err);
    reply = errorReply(message);
    outcome = { kind: 'error', message };
  }

  await firePostHook(hooks, sessionId, opts.toolName, pre.args, outcome);
  return reply;
}

/** Drive a background handler: decode, PreToolUse, then run it on a
 *  sink-owned task and race two outcomes — the handler calling ``job.ack``
 *  (deferred reply, the run kept alive) versus the handler settling before
 *  it acks (an inline error reply now — per the cross-SDK contract a
 *  background handler must ack or complete, never answer by returning).
 *  PostToolUse fires at the terminal signal for a deferred call (in
 *  ``ClientToolJob``), or here for a pre-ack failure. */
export async function invokeBackgroundClientToolHandler(
  handler: BackgroundClientToolHandler,
  payload: string,
  opts: {
    toolName: string;
    sink: ClientToolJobSink;
    hooks?: HookEngine | null;
    sessionId?: string | null;
  },
): Promise<string> {
  const decoded = decodeArgs(payload);
  if (typeof decoded === 'string') return errorReply(decoded);

  const hooks = opts.hooks ?? null;
  const sessionId = opts.sessionId ?? null;
  const pre = await applyPreHook(hooks, sessionId, {
    toolName: opts.toolName,
    args: decoded,
  });
  if (pre.deniedReply !== null) return pre.deniedReply;
  const resolvedArgs = pre.args;

  const job = new ClientToolJob({
    jobId: newJobId(),
    toolName: opts.toolName,
    sink: opts.sink,
    hooks,
    sessionId,
    arguments: resolvedArgs,
  });
  void opts.sink.spawn(() =>
    runBackgroundHandler(handler, resolvedArgs, job, opts.toolName, () =>
      wasRewritten(decoded, resolvedArgs),
    ),
  );

  const raced = await job.raceOutcome;
  switch (raced.kind) {
    case 'acked':
      // Deferred: the run keeps going (the sink owns it); the terminal
      // result and PostToolUse arrive later via job.complete / job.fail.
      log.info('[realtime] client tool deferred', {
        tool: opts.toolName,
        jobId: job.jobId,
      });
      return deferredReply(raced.note, job.jobId);
    case 'finished-without-ack': {
      const message = 'background client tool returned without acking or completing';
      log.warn('[realtime] client tool job finished without ack', {
        tool: opts.toolName,
      });
      await firePostHook(hooks, sessionId, opts.toolName, resolvedArgs, {
        kind: 'error',
        message,
      });
      return errorReply(message);
    }
    case 'failed-before-ack':
      await firePostHook(hooks, sessionId, opts.toolName, resolvedArgs, {
        kind: 'error',
        message: raced.message,
      });
      return errorReply(raced.message);
  }
}

/** Run a background handler. A throw after ``ack`` becomes ``job.fail``
 *  (the deferred reply already went out); a throw before ``ack`` — or a
 *  clean return without acking — settles the dispatcher's reply race so it
 *  can build the inline error reply. */
async function runBackgroundHandler(
  handler: BackgroundClientToolHandler,
  args: Record<string, unknown>,
  job: ClientToolJob,
  toolName: string,
  argsRewritten: () => boolean,
): Promise<void> {
  try {
    await handler(args, job);
    job.settleUnacked({ kind: 'finished-without-ack' });
    if (job.acked && !job.settled) {
      // An acked job the handler abandoned (returned without complete/fail):
      // settle it as a failure so the server-side call is not left waiting.
      log.warn('[realtime] client tool job abandoned', {
        tool: toolName,
        jobId: job.jobId,
      });
      try {
        await job.fail({ error: 'background client tool returned without completing' });
      } catch (publishErr) {
        log.error(
          '[realtime] client tool job failure result undeliverable',
          { tool: toolName, jobId: job.jobId },
          publishErr,
        );
      }
    }
  } catch (err) {
    const message = errorMessage(err);
    warnIfHookRewriteBrokeValidation(err, toolName, argsRewritten);
    if (job.acked) {
      log.error(
        '[realtime] client tool background handler failed after ack',
        { tool: toolName },
        err,
      );
      try {
        await job.fail({ error: message });
      } catch (publishErr) {
        // Sink-owned tasks are settle-only: an undeliverable failure result
        // is logged, never rethrown into the tracked promise.
        log.error(
          '[realtime] client tool job failure result undeliverable',
          { tool: toolName, jobId: job.jobId },
          publishErr,
        );
      }
    } else {
      log.error(
        '[realtime] client tool handler failed',
        { tool: toolName },
        err,
      );
      job.settleUnacked({ kind: 'failed-before-ack', message });
    }
  }
}

export function isBackgroundClientTool(
  tool: RealtimeTool,
): tool is BackgroundClientToolSpec {
  return tool.kind === 'client' && tool.background === true;
}

/** The slice of the transport the client-tool runtime binds to. */
export type ClientToolRpcRegistrar = {
  registerRpcMethod(
    name: string,
    handler: (invocation: RpcInvocation) => Promise<string>,
  ): Unsubscribe;
};

/** Wrap an RPC body with the agent-only caller guard: client tools run
 *  locally on the user's machine, so only the session agent may drive them.
 *  Throws so the transport surfaces an RPC error to a non-agent caller
 *  rather than a well-formed error envelope. */
function guardAgentCaller(
  toolName: string,
  body: (invocation: RpcInvocation) => Promise<string>,
): (invocation: RpcInvocation) => Promise<string> {
  return async (invocation: RpcInvocation): Promise<string> => {
    if (!invocation.callerIsAgent) {
      log.error('[realtime] client tool caller rejected', {
        tool: toolName,
        callerIdentity: invocation.callerIdentity,
      });
      throw new Error('client tools may only be invoked by the session agent');
    }
    return body(invocation);
  };
}

/** Adapt a structured RPC handler (`args -> result object`) into a transport
 *  RPC handler: agent-only caller guard, arg decode, and the
 *  `{ok, result, error}` envelope. The TS mirror of the reference SDK's
 *  `make_rpc_handler` — used by register-without-advertise capabilities (e.g.
 *  the screen locator's capture step) that register RPC methods directly
 *  rather than through {@link registerClientToolHandlers}. */
export function makeRpcHandler(
  name: string,
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
): (invocation: RpcInvocation) => Promise<string> {
  return guardAgentCaller(name, async (invocation) => {
    const decoded = decodeArgs(invocation.payload);
    if (typeof decoded === 'string') return errorReply(decoded);
    let result: Record<string, unknown>;
    try {
      result = await handler(decoded);
    } catch (err) {
      log.error('[realtime] rpc handler failed', { tool: name }, err);
      return errorReply(errorMessage(err));
    }
    return envelopeResult(result).reply;
  });
}

/** Register one RPC method per client tool that carries a handler.
 *
 *  Tools without a handler are skipped — they are declared to the agent
 *  but not locally executable. A ``BackgroundClientToolSpec`` is registered
 *  as long-running (driven through ``jobSink``).
 *
 *  Returns a disposer that unregisters every method this call installed.
 *  If a registration throws mid-loop, the already-installed methods are
 *  unregistered before the error propagates — the transport never keeps a
 *  partial tool set. */
export function registerClientToolHandlers(
  registrar: ClientToolRpcRegistrar,
  tools: readonly RealtimeTool[],
  opts: {
    hooks?: HookEngine | null;
    /** The session id for hook contexts, or a getter resolved per invocation
     *  — registration may happen pre-connect, before the id is minted. */
    sessionId?: string | null | (() => string | null);
    jobSink?: ClientToolJobSink | null;
  } = {},
): Unsubscribe {
  const hooks = opts.hooks ?? null;
  const sessionIdOpt = opts.sessionId ?? null;
  const resolveSessionId = (): string | null =>
    typeof sessionIdOpt === 'function' ? sessionIdOpt() : sessionIdOpt;
  const jobSink = opts.jobSink ?? null;
  const unsubscribes: Unsubscribe[] = [];
  const unregisterAll = (): void => {
    for (const unsubscribe of unsubscribes.splice(0)) {
      try {
        unsubscribe();
      } catch (err) {
        log.error('[realtime] client tool unregistration failed', err);
      }
    }
  };
  try {
    for (const tool of tools) {
      if (tool.kind !== 'client') continue;
      let invoke: ((invocation: RpcInvocation) => Promise<string>) | null = null;
      if (isBackgroundClientTool(tool)) {
        const handler = tool.handler;
        if (handler !== undefined) {
          invoke = (invocation) => {
            if (jobSink === null) {
              log.error(
                '[realtime] background client tool has no session job sink',
                { tool: tool.name },
              );
              return Promise.resolve(
                errorReply('background client tool has no session job sink'),
              );
            }
            return invokeBackgroundClientToolHandler(handler, invocation.payload, {
              toolName: tool.name,
              sink: jobSink,
              hooks,
              sessionId: resolveSessionId(),
            });
          };
        }
      } else {
        const handler = tool.handler;
        if (handler !== undefined) {
          invoke = (invocation) =>
            invokeClientToolHandler(handler, invocation.payload, {
              toolName: tool.name,
              hooks,
              sessionId: resolveSessionId(),
            });
        }
      }
      if (invoke === null) continue;
      unsubscribes.push(
        registrar.registerRpcMethod(tool.name, guardAgentCaller(tool.name, invoke)),
      );
      log.info('[realtime] client tool registered', {
        tool: tool.name,
        background: isBackgroundClientTool(tool),
      });
    }
  } catch (err) {
    unregisterAll();
    throw err;
  }
  return unregisterAll;
}
