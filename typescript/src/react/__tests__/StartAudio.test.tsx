// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { RealtimeClient } from '../../core/realtime_client';
import { RealtimeProvider } from '../RealtimeProvider';
import { StartAudio } from '../components/StartAudio';

function fakeClient(output: 'blocked' | 'silent'): RealtimeClient {
  return {
    attachAudioElement: vi.fn(),
    setMicMuted: vi.fn(),
    resumeAudioPlayback: vi.fn(async () => undefined),
    on: vi.fn(() => () => undefined),
    getSnapshot: () => ({
      transportState: 'disconnected',
      agentState: 'idle',
      mediaState: {
        mic: 'unknown',
        screen: { kind: 'inactive' },
        output,
      },
      error: null,
    }),
  } as unknown as RealtimeClient;
}

describe('StartAudio default affordance', () => {
  it('renders a default unlock button while playback is blocked', () => {
    render(
      <RealtimeProvider client={fakeClient('blocked')}>
        <StartAudio />
      </RealtimeProvider>,
    );

    expect(screen.getByRole('button', { name: 'Tap to enable voice' })).toBeTruthy();
  });

  it('renders nothing by default once playback is unblocked', () => {
    const { container } = render(
      <RealtimeProvider client={fakeClient('silent')}>
        <StartAudio />
      </RealtimeProvider>,
    );

    expect(container.querySelector('button')).toBeNull();
  });

  it('hands the render prop the blocked flag instead of rendering the default', () => {
    render(
      <RealtimeProvider client={fakeClient('silent')}>
        <StartAudio>{({ blocked }) => <span>blocked: {String(blocked)}</span>}</StartAudio>
      </RealtimeProvider>,
    );

    expect(screen.getByText(/blocked: false/)).toBeTruthy();
  });
});
