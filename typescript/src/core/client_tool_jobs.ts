/**
 * Background client-tool job model — the TS port of the reference SDK's
 * ``_client_tool_jobs.py``.
 *
 * A ``BackgroundClientToolSpec`` handler receives a ``ClientToolJob`` to
 * ack the call and deliver its terminal result later. This module holds
 * that model — the per-invocation ``ClientToolJob`` and the session-scoped
 * ``ClientToolJobSink`` that owns the in-flight handler work and the
 * reverse-channel publish path. The dispatch that drives them (the
 * ack-vs-inline race) lives in ``./client_tools``.
 */

import { log } from './logger';
import type { ToolJobResult } from '../wire/types.gen';

import { SAFE_PACKET_BYTES } from '../transport/envelope';
import type { HookEngine, ToolOutcome } from './hooks';

/** @internal — shared with the dispatch in ``./client_tools``. */
export const TRUNCATION_SUFFIX = '… [truncated]';

// A deferred tool's terminal result rides the reliable data channel, which
// caps ~15 KiB per packet. The model only ever sees ``summary``/``error``,
// so an oversized ``result`` is replaced with a small marker rather than
// silently failing the whole publish and stranding the call. Text fields
// are truncated to keep the message deliverable, and a final fit pass
// bounds the *serialized message* — per-field caps alone can't, since JSON
// escaping inflates capped text past the packet budget.
const MAX_TERMINAL_TEXT_CHARS = 2048;
const MAX_TERMINAL_RESULT_BYTES = 8 * 1024;
const MAX_JOB_MESSAGE_BYTES = SAFE_PACKET_BYTES;

let _encoder: TextEncoder | null = null;
/** @internal — shared with the dispatch in ``./client_tools``. */
export function encodedLength(text: string): number {
  if (_encoder === null) _encoder = new TextEncoder();
  return _encoder.encode(text).length;
}

function capText(text: string | null): string | null {
  if (text !== null && text.length > MAX_TERMINAL_TEXT_CHARS) {
    return text.slice(0, MAX_TERMINAL_TEXT_CHARS) + TRUNCATION_SUFFIX;
  }
  return text;
}

function capResult(
  result: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (result === null) return null;
  const encoded = encodedLength(JSON.stringify(result));
  if (encoded <= MAX_TERMINAL_RESULT_BYTES) return result;
  log.warn('[realtime] client tool job result truncated', { bytes: encoded });
  return { _truncated: true, _original_bytes: encoded };
}

function shrink(text: string | undefined, keep: number): string | undefined {
  if (text === undefined || text.length <= keep) return text;
  return text.slice(0, keep) + TRUNCATION_SUFFIX;
}

/** Shrink an over-budget message until it is deliverable: degrade
 *  ``result`` to the truncation marker, then halve the text fields. */
function fitForChannel(message: ToolJobResult): ToolJobResult {
  const encoded = (m: ToolJobResult): number =>
    encodedLength(JSON.stringify(m));
  if (encoded(message) <= MAX_JOB_MESSAGE_BYTES) return message;
  log.warn('[realtime] client tool job message shrunk to fit', {
    tool: message.tool_name,
    jobId: message.job_id,
    bytes: encoded(message),
  });
  let fitted = message;
  if (fitted.result !== undefined) {
    fitted = { ...fitted, result: { _truncated: true } };
  }
  let keep = MAX_TERMINAL_TEXT_CHARS;
  while (encoded(fitted) > MAX_JOB_MESSAGE_BYTES && keep > 0) {
    keep = Math.floor(keep / 2);
    fitted = {
      ...fitted,
      summary: shrink(fitted.summary, keep),
      error: shrink(fitted.error, keep),
    };
  }
  return fitted;
}

/** Session-scoped owner of background client-tool work.
 *
 *  Holds the reverse-channel publish path (``tool_job_result`` over the
 *  data channel) and the set of in-flight handler runs. ``close()`` marks
 *  the sink closed on session teardown — the handler promises themselves
 *  cannot be cancelled in JS, but their terminal deliveries are dropped
 *  once closed. One instance per session; the engine constructs it and
 *  passes it into ``registerClientToolHandlers``. */
export class ClientToolJobSink {
  private readonly publishFn: (message: ToolJobResult) => Promise<void>;
  private readonly isOpenFn: () => boolean;
  private readonly inflight = new Set<Promise<void>>();
  private closed = false;

  constructor(opts: {
    publish: (message: ToolJobResult) => Promise<void>;
    isOpen: () => boolean;
  }) {
    this.publishFn = opts.publish;
    this.isOpenFn = opts.isOpen;
  }

  isOpen(): boolean {
    return !this.closed && this.isOpenFn();
  }

  async publish(message: ToolJobResult): Promise<void> {
    await this.publishFn(message);
  }

  /** Run ``body`` as a tracked background task. The wrapper in
   *  ``client_tools`` never rejects, so tracked promises are settle-only. */
  spawn(body: () => Promise<void>): Promise<void> {
    const task = body().finally(() => {
      this.inflight.delete(task);
    });
    this.inflight.add(task);
    return task;
  }

  /** Mark the sink closed; later terminal deliveries are dropped. */
  close(): void {
    this.closed = true;
  }

  /** Await every currently-tracked handler run. Lets tests observe a job's
   *  terminal delivery after the dispatcher returns the deferred reply. */
  async drain(): Promise<void> {
    await Promise.all([...this.inflight]);
  }
}

/** What the dispatcher's reply race resolves to. @internal */
export type ClientToolJobRaceOutcome =
  | { kind: 'acked'; note: string }
  | { kind: 'finished-without-ack' }
  | { kind: 'failed-before-ack'; message: string };

/** Handle a background client tool uses to ack the call, then deliver its
 *  terminal result later.
 *
 *  Passed as the second argument to a ``BackgroundClientToolHandler``.
 *  Call ``ack(note)`` to release the RPC reply while the handler keeps
 *  running, then ``complete({result, summary})`` or ``fail({error})`` when
 *  the work finishes. The terminal methods publish a ``tool_job_result``
 *  message the server injects into the live session. All three are
 *  idempotent; a terminal call after the session has closed is dropped. */
export class ClientToolJob {
  readonly jobId: string;
  readonly toolName: string;
  private readonly sink: ClientToolJobSink;
  private readonly hooks: HookEngine | null;
  private readonly sessionId: string | null;
  private readonly toolArguments: Record<string, unknown>;
  private ackedFlag = false;
  private terminal = false;
  private raceSettled = false;
  private settleRace!: (outcome: ClientToolJobRaceOutcome) => void;
  /** @internal — awaited by the dispatcher's ack-vs-inline race. */
  readonly raceOutcome: Promise<ClientToolJobRaceOutcome>;

  /** @internal — constructed by the dispatch in ``./client_tools``. */
  constructor(opts: {
    jobId: string;
    toolName: string;
    sink: ClientToolJobSink;
    hooks: HookEngine | null;
    sessionId: string | null;
    arguments: Record<string, unknown>;
  }) {
    this.jobId = opts.jobId;
    this.toolName = opts.toolName;
    this.sink = opts.sink;
    this.hooks = opts.hooks;
    this.sessionId = opts.sessionId;
    this.toolArguments = opts.arguments;
    this.raceOutcome = new Promise((resolve) => {
      this.settleRace = resolve;
    });
  }

  get acked(): boolean {
    return this.ackedFlag;
  }

  /** @internal — true once a terminal result was delivered (unlatched again
   *  by a failed publish, which leaves the job retryable). */
  get settled(): boolean {
    return this.terminal;
  }

  /** Release the RPC reply as a deferred ack. ``note`` is the model-facing
   *  text spoken at acceptance. Later ``ack`` calls are ignored. */
  ack(note = ''): void {
    if (this.ackedFlag) {
      log.warn('[realtime] client tool job ack ignored', {
        tool: this.toolName,
        jobId: this.jobId,
      });
      return;
    }
    this.ackedFlag = true;
    this.settle({ kind: 'acked', note });
  }

  /** Deliver a successful terminal result. Idempotent once delivered; a
   *  failed publish rejects and leaves the job retryable. */
  async complete(
    opts: { result?: Record<string, unknown> | null; summary?: string | null } = {},
  ): Promise<void> {
    const result = opts.result ?? null;
    await this.deliver({
      status: 'completed',
      result,
      summary: opts.summary ?? null,
      error: null,
      outcome: { kind: 'ok', result: result ?? {} },
    });
  }

  /** Deliver a failed terminal result. Idempotent once delivered; a failed
   *  publish rejects and leaves the job retryable. */
  async fail(opts: { error: string }): Promise<void> {
    await this.deliver({
      status: 'failed',
      result: null,
      summary: null,
      error: opts.error,
      outcome: { kind: 'error', message: opts.error },
    });
  }

  /** @internal — called by the handler wrapper when the handler settles
   *  before acking; no-op once the race is settled (i.e. once acked). */
  settleUnacked(outcome: ClientToolJobRaceOutcome): void {
    this.settle(outcome);
  }

  private settle(outcome: ClientToolJobRaceOutcome): void {
    if (this.raceSettled) return;
    this.raceSettled = true;
    this.settleRace(outcome);
  }

  private async deliver(opts: {
    status: 'completed' | 'failed';
    result: Record<string, unknown> | null;
    summary: string | null;
    error: string | null;
    outcome: ToolOutcome;
  }): Promise<void> {
    if (!this.ackedFlag) {
      // Complete/fail without a prior ack still needs the RPC reply to go
      // out deferred, or the worker never registers the job and this result
      // is dropped as unregistered. Ack now (empty note) so it lands.
      log.warn('[realtime] client tool job terminal before ack', {
        tool: this.toolName,
        jobId: this.jobId,
      });
      this.ack('');
    }
    if (this.terminal) {
      log.warn('[realtime] client tool job terminal ignored', {
        tool: this.toolName,
        jobId: this.jobId,
      });
      return;
    }
    this.terminal = true;
    if (!this.sink.isOpen()) {
      log.warn('[realtime] client tool job terminal after close', {
        tool: this.toolName,
        jobId: this.jobId,
      });
      return;
    }
    const message = fitForChannel({
      type: 'tool_job_result',
      job_id: this.jobId,
      tool_name: this.toolName,
      status: opts.status,
      result: capResult(opts.result) ?? undefined,
      summary: capText(opts.summary) ?? undefined,
      error: capText(opts.error) ?? undefined,
    });
    try {
      await this.sink.publish(message);
    } catch (err) {
      // A failed publish must not latch the job as delivered: unlatch so
      // the caller can retry, and rethrow so the dropped result is
      // observable instead of silently lost.
      this.terminal = false;
      log.error(
        '[realtime] client tool job publish failed',
        { tool: this.toolName, jobId: this.jobId },
        err,
      );
      throw err;
    }
    if (this.hooks !== null && this.sessionId !== null) {
      await this.hooks.runPostToolUse({
        event: 'PostToolUse',
        toolName: this.toolName,
        arguments: this.toolArguments,
        outcome: opts.outcome,
        sessionId: this.sessionId,
      });
    }
  }
}
