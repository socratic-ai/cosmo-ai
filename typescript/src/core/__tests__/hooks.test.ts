import { describe, expect, it, vi } from 'vitest';

import {
  type Hook,
  HookEngine,
  postToolUse,
  preToolUse,
  sessionEnd,
  sessionStart,
  validateMatcher,
  type PostToolUseContext,
} from '../hooks';

const SESSION = 'sess-1';

describe('HookEngine.runPreToolUse', () => {
  it('allows by default and passes arguments through', async () => {
    const hooks: Hook[] = [];
    const outcome = await new HookEngine(hooks).runPreToolUse({
      toolName: 'get_balance',
      arguments: { account: 'a1' },
      sessionId: SESSION,
    });
    expect(outcome).toEqual({ denied: false, reason: null, arguments: { account: 'a1' } });
  });

  it('deny short-circuits later hooks and carries the reason', async () => {
    const hooks: Hook[] = [];
    const later = vi.fn();
    hooks.push(preToolUse(() => ({ permission: 'deny', reason: 'nope' })));
    hooks.push(preToolUse(later));
    const outcome = await new HookEngine(hooks).runPreToolUse({
      toolName: 'get_balance',
      arguments: {},
      sessionId: SESSION,
    });
    expect(outcome.denied).toBe(true);
    expect(outcome.reason).toBe('nope');
    expect(later).not.toHaveBeenCalled();
  });

  it.each([{ reason: undefined }, { reason: '' }])(
    'deny with reason $reason folds to the default',
    async ({ reason }) => {
      const hooks: Hook[] = [];
      hooks.push(preToolUse(() => ({ permission: 'deny', reason })));
      const outcome = await new HookEngine(hooks).runPreToolUse({
        toolName: 't',
        arguments: {},
        sessionId: SESSION,
      });
      expect(outcome.reason).toBe('denied by hook');
    },
  );

  it('rewrites chain: each hook sees the previous rewrite', async () => {
    const hooks: Hook[] = [];
    const seen: unknown[] = [];
    hooks.push(preToolUse((ctx) => {
      seen.push(ctx.arguments);
      return { updatedArguments: { step: 1 } };
    }));
    hooks.push(preToolUse((ctx) => {
      seen.push(ctx.arguments);
      return { updatedArguments: { step: 2 } };
    }));
    const outcome = await new HookEngine(hooks).runPreToolUse({
      toolName: 't',
      arguments: { step: 0 },
      sessionId: SESSION,
    });
    expect(seen).toEqual([{ step: 0 }, { step: 1 }]);
    expect(outcome.arguments).toEqual({ step: 2 });
  });

  it('matcher filters which hooks fire', async () => {
    const hooks: Hook[] = [];
    const matched = vi.fn();
    const unmatched = vi.fn();
    hooks.push(preToolUse(matched, { matcher: 'get_*' }));
    hooks.push(preToolUse(unmatched, { matcher: 'set_*' }));
    await new HookEngine(hooks).runPreToolUse({
      toolName: 'get_balance',
      arguments: {},
      sessionId: SESSION,
    });
    expect(matched).toHaveBeenCalledTimes(1);
    expect(unmatched).not.toHaveBeenCalled();
  });

  it('a throwing hook is isolated and treated as no-decision', async () => {
    const hooks: Hook[] = [];
    hooks.push(preToolUse(() => {
      throw new Error('boom');
    }));
    const outcome = await new HookEngine(hooks).runPreToolUse({
      toolName: 't',
      arguments: { a: 1 },
      sessionId: SESSION,
    });
    expect(outcome).toEqual({ denied: false, reason: null, arguments: { a: 1 } });
  });
});

describe('HookEngine.runPostToolUse', () => {
  it('fires matching hooks with the outcome', async () => {
    const hooks: Hook[] = [];
    const seen: PostToolUseContext[] = [];
    hooks.push(postToolUse((ctx) => {
      seen.push(ctx);
    }));
    await new HookEngine(hooks).runPostToolUse({
      event: 'PostToolUse',
      toolName: 't',
      arguments: { a: 1 },
      outcome: { kind: 'ok', result: { done: true } },
      sessionId: SESSION,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].outcome).toEqual({ kind: 'ok', result: { done: true } });
  });

  it('a throwing post hook does not block later hooks', async () => {
    const hooks: Hook[] = [];
    const later = vi.fn();
    hooks.push(postToolUse(() => {
      throw new Error('boom');
    }));
    hooks.push(postToolUse(later));
    await new HookEngine(hooks).runPostToolUse({
      event: 'PostToolUse',
      toolName: 't',
      arguments: {},
      outcome: { kind: 'error', message: 'x' },
      sessionId: SESSION,
    });
    expect(later).toHaveBeenCalledTimes(1);
  });
});

describe('declaration guards', () => {
  it('a malformed matcher is rejected at declaration', () => {
    expect(() => {
      preToolUse(() => undefined, { matcher: '[delete_*' });
    }).toThrow(/unterminated/);
  });
});

describe('validateMatcher', () => {
  it.each(['*', 'tool[12]', 'tool[!12]', 'tool[]]', 'plain'])(
    'accepts %j',
    (pattern) => {
      expect(() => {
        validateMatcher(pattern);
      }).not.toThrow();
    },
  );

  it.each(['[', 'tool[', 'tool[!', 'tool[12', 'a[b'])(
    'rejects unterminated %j',
    (pattern) => {
      expect(() => {
        validateMatcher(pattern);
      }).toThrow(/unterminated/);
    },
  );
});

describe('HookEngine.runSessionStart', () => {
  it('concatenates additional context in registration order', async () => {
    const hooks: Hook[] = [];
    hooks.push(sessionStart(() => ({ additionalContext: 'first' })));
    hooks.push(sessionStart(() => undefined));
    hooks.push(sessionStart(() => Promise.resolve({ additionalContext: 'second' })));
    const extra = await new HookEngine(hooks).runSessionStart({ event: 'SessionStart' });
    expect(extra).toBe('first\n\nsecond');
  });

  it('returns null when no hook contributes context', async () => {
    const hooks: Hook[] = [];
    hooks.push(sessionStart(() => undefined));
    hooks.push(sessionStart(() => ({})));
    hooks.push(sessionStart(() => ({ additionalContext: '' })));
    const extra = await new HookEngine(hooks).runSessionStart({ event: 'SessionStart' });
    expect(extra).toBeNull();
  });

  it('isolates a throwing hook and keeps folding the rest', async () => {
    const hooks: Hook[] = [];
    hooks.push(sessionStart(() => {
      throw new Error('boom');
    }));
    hooks.push(sessionStart(() => ({ additionalContext: 'kept' })));
    const extra = await new HookEngine(hooks).runSessionStart({ event: 'SessionStart' });
    expect(extra).toBe('kept');
  });
});

describe('HookEngine.runSessionEnd', () => {
  it('runs every stop hook with the context', async () => {
    const hooks: Hook[] = [];
    const seen: unknown[] = [];
    hooks.push(sessionEnd((ctx) => {
      seen.push(ctx);
    }));
    hooks.push(sessionEnd((ctx) => {
      seen.push(ctx.reason);
    }));
    await new HookEngine(hooks).runSessionEnd({
      event: 'SessionEnd',
      reason: 'client_ended',
      detail: null,
      sessionId: SESSION,
    });
    expect(seen).toEqual([
      { event: 'SessionEnd', reason: 'client_ended', detail: null, sessionId: SESSION },
      'client_ended',
    ]);
  });

  it('isolates a throwing stop hook', async () => {
    const hooks: Hook[] = [];
    const later = vi.fn();
    hooks.push(sessionEnd(() => {
      throw new Error('boom');
    }));
    hooks.push(sessionEnd(later));
    await new HookEngine(hooks).runSessionEnd({
      event: 'SessionEnd',
      reason: 'transport_error',
      detail: 'x',
      sessionId: null,
    });
    expect(later).toHaveBeenCalledTimes(1);
  });
});

