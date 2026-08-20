/** The output side-tap follows the audio element.
 *
 * A browser host mounts its ``<audio>`` on a later render than the connect,
 * and the transport plays through its own fallback until that arrives. An
 * analyser built once, at connect, is therefore built against the wrong
 * element (or none at all) and reads silence for the whole call — which is
 * what ``useOutputLevel`` and every speaker indicator downstream of it show.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionEngine } from '../session_engine';
import type { RealtimeTransport } from '../../transport/types';

/** Minimal Web Audio stand-in: node has no AudioContext, and the real graph
 *  is not what is under test — which element the tap is built from is. */
class FakeAudioContext {
  static sourcedElements: HTMLAudioElement[] = [];
  readonly destination = {} as AudioNode;
  createMediaElementSource(el: HTMLAudioElement) {
    if (FakeAudioContext.sourcedElements.includes(el)) {
      // Matches the browser: one source per element, ever.
      throw new Error('InvalidStateError: element already connected');
    }
    FakeAudioContext.sourcedElements.push(el);
    return { connect: vi.fn(), disconnect: vi.fn() } as unknown as MediaElementAudioSourceNode;
  }
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() } as unknown as MediaStreamAudioSourceNode;
  }
  createAnalyser() {
    return { fftSize: 0, frequencyBinCount: 128, getFloatTimeDomainData: vi.fn() } as unknown as AnalyserNode;
  }
  close() {
    return Promise.resolve();
  }
}

/** Transport whose output element changes after connect, as LiveKit's does
 *  when a host element replaces the fallback. */
function transportWithSwappableOutput(): RealtimeTransport & {
  setOutput: (el: HTMLAudioElement | null) => void;
} {
  let output: HTMLAudioElement | null = null;
  return {
    connect: async () => {},
    disconnect: async () => {},
    send: async () => {},
    setMicMuted: async () => {},
    getInputStream: () => null,
    getOutputAudioElement: () => output,
    attachAudioElement: (el: HTMLAudioElement | null) => {
      output = el;
    },
    onMessage: () => () => {},
    onClose: () => () => {},
    onReconnecting: () => () => {},
    onReconnected: () => () => {},
    setOutput: (el) => {
      output = el;
    },
  } as RealtimeTransport & { setOutput: (el: HTMLAudioElement | null) => void };
}

function makeEngine(transport: RealtimeTransport): SessionEngine {
  return new SessionEngine({
    createTransport: () => transport,
    startUrl: () => 'https://api.example.com/start',
    dialUrl: (id) => `https://api.example.com/${id}/dial`,
    usageUrl: (id) => `https://api.example.com/${id}/usage`,
    resolveAuthHeaders: async () => ({}),
    onStartUnauthorized: () => {},
  });
}

describe('output analyser', () => {
  beforeEach(() => {
    FakeAudioContext.sourcedElements = [];
    (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
  });

  it('builds the tap when the element is attached after the connect', () => {
    const transport = transportWithSwappableOutput();
    const engine = makeEngine(transport);
    // Stand in for a completed connect without driving the whole start path.
    (engine as unknown as { connection: RealtimeTransport }).connection = transport;

    expect(engine.getOutputAnalyser()).toBeNull();

    const hostElement = { id: 'host' } as unknown as HTMLAudioElement;
    engine.attachAudioElement(hostElement);

    expect(engine.getOutputAnalyser()).not.toBeNull();
    expect(FakeAudioContext.sourcedElements).toEqual([hostElement]);
  });

  it('rebuilds against the new element when one replaces another', () => {
    const transport = transportWithSwappableOutput();
    const engine = makeEngine(transport);
    (engine as unknown as { connection: RealtimeTransport }).connection = transport;

    const fallback = { id: 'fallback' } as unknown as HTMLAudioElement;
    engine.attachAudioElement(fallback);
    const firstAnalyser = engine.getOutputAnalyser();

    const hostElement = { id: 'host' } as unknown as HTMLAudioElement;
    engine.attachAudioElement(hostElement);

    expect(engine.getOutputAnalyser()).not.toBe(firstAnalyser);
    expect(FakeAudioContext.sourcedElements).toEqual([fallback, hostElement]);
  });

  it('does not re-source an unchanged element', () => {
    const transport = transportWithSwappableOutput();
    const engine = makeEngine(transport);
    (engine as unknown as { connection: RealtimeTransport }).connection = transport;

    const hostElement = { id: 'host' } as unknown as HTMLAudioElement;
    engine.attachAudioElement(hostElement);
    const analyser = engine.getOutputAnalyser();

    // A second attach of the same element must not throw (the browser
    // rejects a repeat createMediaElementSource) and must keep the tap.
    engine.attachAudioElement(hostElement);

    expect(engine.getOutputAnalyser()).toBe(analyser);
    expect(FakeAudioContext.sourcedElements).toEqual([hostElement]);
  });
});
