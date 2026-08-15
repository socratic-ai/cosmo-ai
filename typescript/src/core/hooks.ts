/**
 * Hooks for the realtime SDK: in-process lifecycle callbacks fired by the
 * session at four seams (``SessionStart``, ``PreToolUse``, ``PostToolUse``,
 * ``SessionEnd``), plus declarative server hooks the SERVER executes.
 *
 * Two kinds of hooks, one idea (when X happens, do Y), one ``hooks: [...]``
 * list on the agent:
 *
 * - **client hooks** — your callbacks, run in-process. Declare with the seam
 *   factories: ``sessionStart(fn)``, ``preToolUse(fn, {matcher})``,
 *   ``postToolUse(fn)``, ``sessionEnd(fn)``. List order is fold order.
 * - **server hooks** — wire config the server executes, working even if this
 *   process dies mid-call: a ``SilenceTimeout`` with a ``say`` or
 *   ``end_call`` action.
 *
 * Every seam hangs off something this process does, which is what makes it a
 * seam rather than a notification: ``SessionStart`` rewrites the config before
 * it is sent, ``PreToolUse`` gates a local handler, ``PostToolUse`` reads that
 * handler's outcome, and ``SessionEnd`` fires even when the socket dropped and
 * no frame ever arrived. Anything the SERVER did reaches you as an event —
 * ``on('user_speech_timeout')`` for a fired silence hook — never as a hook.
 *
 * Observer-grade by default; the two client-controlled seams honor
 * overrides — ``SessionStart`` may inject ``additionalContext`` into the
 * instructions and ``PreToolUse`` may deny or rewrite a local client-tool
 * call. A throwing hook is isolated and never breaks the session. Python
 * (``cosmo_ai.hooks``) is the reference for shape and semantics; the
 * matcher grammar and fold rules are pinned by the shared conformance
 * vectors shared across the SDKs.
 */

import { log } from './logger';
import type {
  SilenceTimeout,
  UserSpeechTimeoutEvent,
} from '../wire/types.gen';

import type { DisconnectReason } from './state';

/** A server-executed hook — wire config, not a callback. The family's
 *  extension point: becomes a union when a second server-hook kind lands. */
export type ServerHook = SilenceTimeout;

// A hook runs in-process on the session's hot path (SessionStart blocks
// session establishment; PreToolUse/PostToolUse are awaited inline in the
// tool-call RPC reply during a live voice turn). Nothing bounds a hook's
// runtime, so a slow hook (e.g. a network call) stalls that path; this only
// warns, it never cancels or times out a hook.
const SLOW_HOOK_WARN_THRESHOLD_MS = 200;

// ── Tool outcome (what PostToolUse observes) ───────────────────────────

export type ToolOutcome =
  | { kind: 'ok'; result: Record<string, unknown> | null }
  | { kind: 'error'; message: string }
  | { kind: 'denied'; reason: string };

// ── Per-event contexts ─────────────────────────────────────────────────

export type SessionStartContext = {
  // The session id does not exist until the handshake completes; read the
  // ``ready`` event for the started id.
  event: 'SessionStart';
};

export type PreToolUseContext = {
  event: 'PreToolUse';
  toolName: string;
  /** Read-only view; rewrite via ``PreToolUseResult.updatedArguments``. */
  arguments: Readonly<Record<string, unknown>>;
  sessionId: string;
};

export type PostToolUseContext = {
  event: 'PostToolUse';
  toolName: string;
  arguments: Record<string, unknown>;
  outcome: ToolOutcome;
  sessionId: string;
};

export type SessionEndContext = {
  event: 'SessionEnd';
  reason: DisconnectReason;
  detail: string | null;
  sessionId: string | null;
};

/** The server action a fired silence timeout performed (``say`` or
 *  ``end_call``), as reported on the wire frame. */
export type ServerHookAction = UserSpeechTimeoutEvent['action'];

// ── Per-event results ──────────────────────────────────────────────────

export type SessionStartResult = {
  additionalContext?: string | null;
};

export type PreToolUseResult = {
  permission?: 'allow' | 'deny';
  reason?: string;
  updatedArguments?: Record<string, unknown>;
};

/** Folded result of all PreToolUse hooks for one tool call. */
export type PreToolUseOutcome = {
  denied: boolean;
  reason: string | null;
  arguments: Record<string, unknown>;
};

export type SessionStartHook = (
  ctx: SessionStartContext,
) =>
  | SessionStartResult
  | null
  | undefined
  | void
  | Promise<SessionStartResult | null | undefined | void>;

export type PreToolUseHook = (
  ctx: PreToolUseContext,
) => PreToolUseResult | null | undefined | void | Promise<PreToolUseResult | null | undefined | void>;

export type PostToolUseHook = (ctx: PostToolUseContext) => void | Promise<void>;

export type SessionEndHook = (ctx: SessionEndContext) => void | Promise<void>;

// ── Matcher grammar ────────────────────────────────────────────────────

/** Normative matcher grammar, shared with the Python and Swift SDKs via
 *  ``hook-matcher-vectors.json``: glob-style
 *  ``*`` ``?`` ``[seq]`` ``[!seq]``, case-sensitive, matched against the
 *  full tool name, no path semantics. A malformed pattern is rejected at
 *  registration (``validateMatcher``) rather than reaching this function,
 *  so every pattern seen here is well-formed. */
export function toolNameMatches(toolName: string, pattern: string): boolean {
  return translateMatcher(pattern).test(toolName);
}

/** Reject an unterminated ``[...]`` group at hook-registration time.
 *
 *  The glob grammar treats a stray ``[`` as a literal character, so e.g.
 *  ``matcher="[delete_*"`` would silently never match any real tool name
 *  instead of erroring. For a ``PreToolUse`` deny matcher that is a silent
 *  fail-open (the guard never fires), so this fails loud instead. */
export function validateMatcher(pattern: string): void {
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    if (pattern[i] === '[') {
      let j = i + 1;
      if (j < n && pattern[j] === '!') j += 1;
      if (j < n && pattern[j] === ']') j += 1;
      while (j < n && pattern[j] !== ']') j += 1;
      if (j >= n) {
        throw new Error(
          `malformed hook matcher ${JSON.stringify(pattern)}: unterminated '[' at index ${String(i)}`,
        );
      }
      i = j + 1;
    } else {
      i += 1;
    }
  }
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function translateMatcher(pattern: string): RegExp {
  let out = '';
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i];
    i += 1;
    if (c === '*') {
      out += '.*';
    } else if (c === '?') {
      out += '.';
    } else if (c === '[') {
      let j = i;
      if (j < n && pattern[j] === '!') j += 1;
      if (j < n && pattern[j] === ']') j += 1;
      while (j < n && pattern[j] !== ']') j += 1;
      if (j >= n) {
        out += '\\[';
      } else {
        let stuff = pattern.slice(i, j).replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
        if (stuff.startsWith('!')) stuff = `^${stuff.slice(1)}`;
        else if (stuff.startsWith('^')) stuff = `\\${stuff}`;
        out += `[${stuff}]`;
        i = j + 1;
      }
    } else {
      out += c.replace(REGEXP_SPECIALS, '\\$&');
    }
  }
  // ``s`` so ``*`` / ``?`` match newlines, mirroring Python's ``(?s:...)``.
  return new RegExp(`^(?:${out})$`, 's');
}

// ── Declared hooks + the seam factories ────────────────────────────────

export type HookEventName =
  | 'SessionStart'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionEnd';

type AnyHookCallback =
  | SessionStartHook
  | PreToolUseHook
  | PostToolUseHook
  | SessionEndHook;

/** One declared client hook: the seam it fires at, the callback, and (for
 *  the tool seams) an optional matcher. Built by the seam factories; list
 *  order in ``hooks: [...]`` is fold order. */
export class Hook {
  readonly event: HookEventName;
  /** @internal */
  readonly callback: AnyHookCallback;
  readonly matcher: string | null;

  /** @internal — construct via the seam factories. */
  constructor(event: HookEventName, callback: AnyHookCallback, matcher: string | null) {
    this.event = event;
    this.callback = callback;
    this.matcher = matcher;
    Object.freeze(this);
  }
}

/** Declare a ``SessionStart`` hook — may return a ``SessionStartResult``
 *  to inject ``additionalContext`` into the instructions. */
export function sessionStart(fn: SessionStartHook): Hook {
  return new Hook('SessionStart', fn, null);
}

/** Declare a ``PreToolUse`` hook — may deny or rewrite a local client-tool
 *  call. ``matcher`` restricts it to matching tool names (glob grammar); a
 *  malformed matcher throws here, not at session start. */
export function preToolUse(fn: PreToolUseHook, opts?: { matcher?: string }): Hook {
  if (opts?.matcher !== undefined) validateMatcher(opts.matcher);
  return new Hook('PreToolUse', fn, opts?.matcher ?? null);
}

/** Declare a ``PostToolUse`` observer, fired with the final ``ToolOutcome``
 *  of each local client-tool call. */
export function postToolUse(fn: PostToolUseHook, opts?: { matcher?: string }): Hook {
  if (opts?.matcher !== undefined) validateMatcher(opts.matcher);
  return new Hook('PostToolUse', fn, opts?.matcher ?? null);
}

/** Declare a ``SessionEnd`` observer, fired exactly once at teardown. */
export function sessionEnd(fn: SessionEndHook): Hook {
  return new Hook('SessionEnd', fn, null);
}

/** Split one unified ``hooks: [...]`` list into the client hooks (folded
 *  in-process, in list order) and the server hooks (wire config). Rejects
 *  anything that is neither. @internal */
export function resolveHooks(
  hooks: readonly (Hook | ServerHook)[] | undefined,
): { clientHooks: Hook[]; serverHooks: ServerHook[] } {
  const clientHooks: Hook[] = [];
  const serverHooks: ServerHook[] = [];
  for (const hook of hooks ?? []) {
    if (hook instanceof Hook) {
      clientHooks.push(hook);
    } else if (
      hook !== null &&
      typeof hook === 'object' &&
      // ``trigger`` is optional on the wire type; the required
      // ``timeout_seconds`` is the reliable discriminator.
      typeof (hook as ServerHook).timeout_seconds === 'number'
    ) {
      serverHooks.push(hook);
    } else {
      throw new Error(
        'hooks elements must be seam-factory Hooks or server hooks (SilenceTimeout)',
      );
    }
  }
  return { clientHooks, serverHooks };
}

// ── HookEngine ─────────────────────────────────────────────────────────

/** Dispatch engine over one agent's declared client hooks. Immutable —
 *  built from the resolved ``Hook`` list at session start; fold semantics
 *  are pinned by the shared hook-engine vectors. @internal */
export class HookEngine {
  private readonly sessionStartHooks: SessionStartHook[] = [];
  private readonly preToolUseHooks: { matcher: string | null; hook: PreToolUseHook }[] =
    [];
  private readonly postToolUseHooks: { matcher: string | null; hook: PostToolUseHook }[] =
    [];
  private readonly sessionEndHooks: SessionEndHook[] = [];

  constructor(hooks: readonly Hook[]) {
    for (const hook of hooks) {
      switch (hook.event) {
        case 'SessionStart':
          this.sessionStartHooks.push(hook.callback as SessionStartHook);
          break;
        case 'PreToolUse':
          this.preToolUseHooks.push({
            matcher: hook.matcher,
            hook: hook.callback as PreToolUseHook,
          });
          break;
        case 'PostToolUse':
          this.postToolUseHooks.push({
            matcher: hook.matcher,
            hook: hook.callback as PostToolUseHook,
          });
          break;
        case 'SessionEnd':
          this.sessionEndHooks.push(hook.callback as SessionEndHook);
          break;
      }
    }
  }

  /** Fold every SessionStart hook's ``additionalContext`` in list order;
   *  ``null`` when no hook contributed context. */
  async runSessionStart(ctx: SessionStartContext): Promise<string | null> {
    const chunks: string[] = [];
    for (const hook of this.sessionStartHooks) {
      const out = await callHook(hook, ctx);
      if (out === null || out === undefined) continue;
      if (out.additionalContext) chunks.push(out.additionalContext);
    }
    return chunks.length > 0 ? chunks.join('\n\n') : null;
  }

  async runPreToolUse(opts: {
    toolName: string;
    arguments: Record<string, unknown>;
    sessionId: string;
  }): Promise<PreToolUseOutcome> {
    let current: Record<string, unknown> = { ...opts.arguments };
    for (const { matcher, hook } of this.preToolUseHooks) {
      if (matcher !== null && !toolNameMatches(opts.toolName, matcher)) continue;
      const out = await callHook(hook, {
        event: 'PreToolUse',
        toolName: opts.toolName,
        arguments: Object.freeze({ ...current }),
        sessionId: opts.sessionId,
      });
      if (out === null || out === undefined) continue;
      if (out.permission === 'deny') {
        log.info('[realtime] hook denied tool', {
          tool: opts.toolName,
          reason: out.reason,
        });
        return {
          denied: true,
          // ``||`` not ``??``: an empty-string reason folds to the default,
          // matching Python's ``reason or "denied by hook"``.
          reason: out.reason || 'denied by hook',
          arguments: current,
        };
      }
      if (out.updatedArguments !== undefined) {
        current = { ...out.updatedArguments };
      }
    }
    return { denied: false, reason: null, arguments: current };
  }

  async runPostToolUse(ctx: PostToolUseContext): Promise<void> {
    for (const { matcher, hook } of this.postToolUseHooks) {
      if (matcher !== null && !toolNameMatches(ctx.toolName, matcher)) continue;
      await callHook(hook, ctx);
    }
  }

  async runSessionEnd(ctx: SessionEndContext): Promise<void> {
    for (const hook of this.sessionEndHooks) {
      await callHook(hook, ctx);
    }
  }
}

async function callHook<Ctx extends { event: string }, R>(
  hook: (ctx: Ctx) => R | Promise<R>,
  ctx: Ctx,
): Promise<R | null> {
  const start = performance.now();
  try {
    return await hook(ctx);
  } catch (err) {
    log.error('[realtime] hook failed', { hookEvent: ctx.event }, err);
    return null;
  } finally {
    const elapsedMs = performance.now() - start;
    if (elapsedMs > SLOW_HOOK_WARN_THRESHOLD_MS) {
      log.warn('[realtime] slow hook', { hookEvent: ctx.event, elapsedMs });
    }
  }
}
