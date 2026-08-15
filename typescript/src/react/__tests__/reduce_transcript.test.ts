import { describe, expect, it } from 'vitest';
import { reduceTranscript } from '../transcript_reducer';
import type { TranscriptDeltaEvent } from '../../core/events';

function ev(overrides: Partial<TranscriptDeltaEvent>): TranscriptDeltaEvent {
  return {
    id: 'id',
    turnId: 't1',
    role: 'user',
    text: '',
    isFinal: false,
    append: false,
    ...overrides,
  };
}

describe('reduceTranscript', () => {
  it('final replaces the accumulated bubble — no duplication', () => {
    // Reproduces the bug: a cumulative full-text interim followed by a
    // cumulative full-text final flagged append. Final must replace, not concat.
    let t = reduceTranscript([], ev({ id: 't1-0', text: 'Äh, not really.', append: false }), Infinity);
    t = reduceTranscript(t, ev({ id: 't1-1', text: 'Äh, not really.', isFinal: true, append: true }), Infinity);
    expect(t).toHaveLength(1);
    expect(t[0]?.text).toBe('Äh, not really.');
    expect(t[0]?.isFinal).toBe(true);
  });

  it('streaming fragments append', () => {
    let t = reduceTranscript([], ev({ id: 't1-0', text: 'Hello', append: false }), Infinity);
    t = reduceTranscript(t, ev({ id: 't1-1', text: ' there', append: true }), Infinity);
    expect(t).toHaveLength(1);
    expect(t[0]?.text).toBe('Hello there');
  });

  it('final after fragments replaces with the cumulative full text', () => {
    let t = reduceTranscript([], ev({ id: 't1-0', text: 'Hel', append: false }), Infinity);
    t = reduceTranscript(t, ev({ id: 't1-1', text: 'lo', append: true }), Infinity);
    t = reduceTranscript(t, ev({ id: 't1-2', text: 'Hello.', isFinal: true, append: true }), Infinity);
    expect(t).toHaveLength(1);
    expect(t[0]?.text).toBe('Hello.');
  });

  it('different turn starts a new bubble', () => {
    let t = reduceTranscript([], ev({ id: 't1-0', text: 'first', isFinal: true, append: false }), Infinity);
    t = reduceTranscript(t, ev({ id: 't2-0', turnId: 't2', text: 'second', isFinal: true, append: true }), Infinity);
    expect(t).toHaveLength(2);
    expect(t[1]?.text).toBe('second');
  });

  it('agent deltas interleaved with a user transcript stay ONE agent bubble', () => {
    // The bug: a speech-to-speech provider streams the user's ASR between the agent's own deltas,
    // so the second agent delta is flagged append:false (prev role was user) and
    // used to spawn a fresh "Oh" / "there" fragment. Same turnId ⇒ one bubble.
    let t = reduceTranscript([], ev({ id: 't1-0', role: 'assistant', text: 'Oh', append: false }), Infinity);
    t = reduceTranscript(t, ev({ id: 't1-1', role: 'user', text: 'wait', append: false }), Infinity);
    t = reduceTranscript(t, ev({ id: 't1-2', role: 'assistant', text: ' there', append: false }), Infinity);
    const agent = t.filter((b) => b.role === 'assistant');
    expect(agent).toHaveLength(1);
    expect(agent[0]?.text).toBe('Oh there');
    expect(t.filter((b) => b.role === 'user')).toHaveLength(1);
  });

  it('user cumulative final does not duplicate after interleaving', () => {
    // "Hey, what's up? Hey, what's up?" — the cumulative user final landed as a
    // second bubble because append was false (prev event was the agent).
    let t = reduceTranscript([], ev({ id: 't1-0', role: 'user', text: "Hey, what's up?", append: false }), Infinity);
    t = reduceTranscript(t, ev({ id: 't1-1', role: 'assistant', text: 'Hi', append: false }), Infinity);
    t = reduceTranscript(t, ev({ id: 't1-2', role: 'user', text: "Hey, what's up?", isFinal: true, append: false }), Infinity);
    const user = t.filter((b) => b.role === 'user');
    expect(user).toHaveLength(1);
    expect(user[0]?.text).toBe("Hey, what's up?");
  });

  it('empty or whitespace-only event does not create a blank bubble', () => {
    let t = reduceTranscript([], ev({ id: 't1-0', role: 'assistant', text: '', append: false }), Infinity);
    expect(t).toHaveLength(0);
    // Whitespace-only must be gated too — matches the store (both use isBlankDelta).
    t = reduceTranscript(t, ev({ id: 't1-1', role: 'assistant', text: '   ', append: false }), Infinity);
    expect(t).toHaveLength(0);
  });
});
