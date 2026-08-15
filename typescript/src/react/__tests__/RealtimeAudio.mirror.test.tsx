// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useEffect, type MutableRefObject } from 'react';

import type { RealtimeClient } from '../../core/realtime_client';
import { CosmoRealtimeProvider, useRealtimeAudioElementRef } from '../RealtimeProvider';
import { RealtimeAudio } from '../components/RealtimeAudio';

function fakeClient(): RealtimeClient {
  return {
    attachAudioElement: vi.fn(),
    setMicMuted: vi.fn(),
    on: vi.fn(() => () => undefined),
    getSnapshot: () => ({
      transportState: 'disconnected',
      agentState: 'idle',
      mediaState: {
        mic: 'unknown',
        screen: { kind: 'inactive' },
        output: 'silent',
      },
      error: null,
    }),
  } as unknown as RealtimeClient;
}

describe('RealtimeAudio -> provider audioElementRef mirror', () => {
  it('populates audioElementRef.current with the <audio> element after mount', () => {
    let captured: HTMLAudioElement | null | undefined;

    function Probe() {
      const ref: MutableRefObject<HTMLAudioElement | null> = useRealtimeAudioElementRef();
      // Read *after* RealtimeAudio's mount effect populates the ref —
      // effects run children-first, so this fires after the mirror.
      useEffect(() => {
        captured = ref.current;
      });
      return null;
    }

    render(
      <CosmoRealtimeProvider client={fakeClient()}>
        <RealtimeAudio />
        <Probe />
      </CosmoRealtimeProvider>,
    );

    expect(captured).toBeInstanceOf(HTMLAudioElement);
  });
});
