'use client';

import { useEffect } from 'react';

import { useAgentState } from '../hooks';

const STYLE_TAG_ID = 'cosmo-realtime-bar-visualizer-keyframes';

const KEYFRAMES = `
@keyframes cosmo-rtbv-idle-pulse {
  0%, 100% { transform: scaleY(0.45); opacity: 0.5; }
  50% { transform: scaleY(0.7); opacity: 0.85; }
}
@keyframes cosmo-rtbv-wave {
  0% { transform: scaleY(0.4); }
  33% { transform: scaleY(0.9); }
  66% { transform: scaleY(0.6); }
  100% { transform: scaleY(0.4); }
}
@keyframes cosmo-rtbv-active {
  0%, 100% { transform: scaleY(0.3); }
  50% { transform: scaleY(1); }
}
`;

/** Inject the BarVisualizer keyframes once per document. Keyframes are
 *  global by definition — we de-dupe by id rather than re-injecting on
 *  every mount. */
function ensureKeyframes(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_TAG_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_TAG_ID;
  style.textContent = KEYFRAMES;
  document.head.appendChild(style);
}

const BAR_COUNT = 5;

const BAR_CONFIG: Record<
  'idle' | 'listening' | 'thinking' | 'speaking',
  { animation: string; duration: string }
> = {
  idle: { animation: 'cosmo-rtbv-idle-pulse', duration: '1.6s' },
  listening: { animation: 'cosmo-rtbv-idle-pulse', duration: '1.2s' },
  thinking: { animation: 'cosmo-rtbv-wave', duration: '0.9s' },
  speaking: { animation: 'cosmo-rtbv-active', duration: '0.6s' },
};

export type BarVisualizerProps = {
  className?: string;
};

/**
 * Lightweight bar visualizer reflecting the SDK's ``AgentState``.
 *
 * Pure CSS keyframes — we don't tap the analyser node here so the
 * primitive stays embeddable in places that don't want to hold a live
 * ``AudioContext``. For frequency-accurate waveforms use the existing
 * ``<Waveform />`` feature component.
 */
export function BarVisualizer({ className }: BarVisualizerProps) {
  useEffect(() => {
    ensureKeyframes();
  }, []);
  const agentState = useAgentState();
  const config = BAR_CONFIG[agentState];

  return (
    <div
      role="presentation"
      data-scope="realtime-bar-visualizer"
      data-agent-state={agentState}
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        height: '20px',
      }}
    >
      {Array.from({ length: BAR_COUNT }).map((_, i) => (
        <span
          key={i}
          style={{
            display: 'inline-block',
            width: '3px',
            height: '100%',
            borderRadius: '1px',
            background: 'currentColor',
            transformOrigin: 'center',
            animationName: config.animation,
            animationDuration: config.duration,
            animationIterationCount: 'infinite',
            animationTimingFunction: 'ease-in-out',
            animationDelay: `${i * 0.08}s`,
          }}
        />
      ))}
    </div>
  );
}
