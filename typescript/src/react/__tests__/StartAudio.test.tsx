// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { RealtimeSession } from '../../core/session';
import { RealtimeProvider } from '../RealtimeProvider';
import { StartAudio } from '../components/StartAudio';

function fakeSession(output: 'blocked' | 'silent'): RealtimeSession {
  return {
    attachAudioElement: vi.fn(),
    setMuted: vi.fn(),
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
  } as unknown as RealtimeSession;
}

describe('StartAudio default affordance', () => {
  it('renders a default unlock button while playback is blocked', () => {
    render(
      <RealtimeProvider session={fakeSession('blocked')}>
        <StartAudio />
      </RealtimeProvider>,
    );

    expect(screen.getByRole('button', { name: 'Tap to enable voice' })).toBeTruthy();
  });

  it('renders nothing by default once playback is unblocked', () => {
    const { container } = render(
      <RealtimeProvider session={fakeSession('silent')}>
        <StartAudio />
      </RealtimeProvider>,
    );

    expect(container.querySelector('button')).toBeNull();
  });

  it('hands the render prop the blocked flag instead of rendering the default', () => {
    render(
      <RealtimeProvider session={fakeSession('silent')}>
        <StartAudio>{({ blocked }) => <span>blocked: {String(blocked)}</span>}</StartAudio>
      </RealtimeProvider>,
    );

    expect(screen.getByText(/blocked: false/)).toBeTruthy();
  });
});
