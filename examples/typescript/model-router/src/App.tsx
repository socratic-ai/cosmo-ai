'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarVisualizer,
  CosmoRealtimeProvider,
  MicToggle,
  RealtimeAudio,
  RealtimeClient,
  StartAudio,
  TokenSource,
  useAgentState,
  useMicLevel,
  useOutputLevel,
  useRealtimeError,
  useTransportState,
  useTranscript,
  type RealtimeClientOptions,
  type TransportState,
} from 'cosmo-ai';

import { route, type RouteResult } from './route';

// Prefill from a gitignored .env for local dev convenience (see .env.example).
// Never hardcode a key here — this file is committed. Gated on `DEV` (a
// compile-time-literal boolean Vite dead-code-eliminates) rather than just
// trusting `pages:build`'s `VITE_COSMO_API_KEY=` override: that blanking only
// covers the `pages:build` script, so a plain `npm run build` with a real key
// still in `.env` would otherwise inline it into the shipped bundle. This
// gate makes that impossible regardless of which build script gets run —
// the literal read of the env var is compiled out of any production build.
const API_KEY_DEFAULT = import.meta.env.DEV ? (import.meta.env.VITE_COSMO_API_KEY ?? '') : '';

// Display only — the SDK resolves its backend itself, from the
// `cosmo-base-url` meta tag vite.config.ts injects when VITE_COSMO_BASE_URL
// is set (production otherwise), and calls it directly: /api/v1/external/*
// answers wildcard CORS, so no proxy is involved in either mode.
const SESSION_TARGET = import.meta.env.VITE_COSMO_BASE_URL || 'https://platform.askcosmo.ai';

// `import.meta.env.PROD` is true only for a built bundle (`vite build` /
// `npm run pages:build`), never for `vite dev` — which is also exactly when
// the /token Pages Function is reachable (a plain `npm run dev` never serves
// it). A deployed build's key stays server-side in that Function, so what the
// box collects there is an access password the page trades for short-lived
// end-user tokens; under `vite dev` the box always collects a real API key.
const HOSTED = import.meta.env.PROD;

/** Stable per-browser identity for hosted mode — Cosmo meters and scopes per
 *  this id, so each visitor gets their own auto-provisioned project. */
function externalUserId(): string {
  const KEY = 'model-router-user';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `visitor-${crypto.randomUUID()}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

function mintHeaders(password: string): Record<string, string> {
  return { authorization: `Bearer ${password}`, 'x-external-user-id': externalUserId() };
}

const PROVIDER_META: Record<
  RouteResult['provider'],
  { label: string; solid: string; soft: string; text: string }
> = {
  gemini: { label: 'Gemini', solid: '#2563eb', soft: '#eff6ff', text: '#1d4ed8' },
  openai: { label: 'OpenAI', solid: '#16a34a', soft: '#f0fdf4', text: '#15803d' },
  openai_mini: { label: 'OpenAI mini', solid: '#64748b', soft: '#f1f5f9', text: '#475569' },
};

const STATUS_META: Record<TransportState, { label: string; color: string; pulse: boolean }> = {
  disconnected: { label: 'Disconnected', color: 'var(--color-idle)', pulse: false },
  'requesting-permission': { label: 'Requesting mic…', color: 'var(--color-warning)', pulse: true },
  connecting: { label: 'Connecting…', color: 'var(--color-warning)', pulse: true },
  connected: { label: 'Connected', color: 'var(--color-warning)', pulse: true },
  ready: { label: 'Live', color: 'var(--color-success)', pulse: false },
  reconnecting: { label: 'Reconnecting…', color: 'var(--color-warning)', pulse: true },
  disconnecting: { label: 'Disconnecting…', color: 'var(--color-idle)', pulse: false },
  failed: { label: 'Failed', color: 'var(--color-danger-text)', pulse: false },
};

export function App() {
  const [apiKey, setApiKey] = useState(API_KEY_DEFAULT);
  const [client, setClient] = useState<RealtimeClient | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [intent, setIntent] = useState('');
  // `RouteResult` for the session `client` currently holds — set alongside
  // `client` itself so the badge/rationale never reference the wrong run.
  const [pendingRoute, setPendingRoute] = useState<RouteResult | null>(null);

  // Synchronous in-flight guard: `connecting` state isn't visible until the
  // next render, so a second Enter/click fired before that commit would
  // still pass a `connecting`-only check and open a second, orphaned
  // RealtimeClient session. A ref is readable/settable immediately.
  const startingRef = useRef(false);

  const handleConnect = useCallback(async () => {
    if (startingRef.current) return;
    const text = intent.trim();
    if (!text || !apiKey) return;

    startingRef.current = true;
    const result = route(text);
    setConnectError(null);
    setConnecting(true);
    // Hosted: the box held a password, traded for short-lived end-user tokens
    // by this deployment's /token Function — TokenSource keeps one fresh.
    // Local: the box held an API key, sent to the backend directly.
    const opts: RealtimeClientOptions = HOSTED
      ? { token: TokenSource.endpoint('/token', { headers: () => mintHeaders(apiKey) }) }
      : { apiKey };
    try {
      const c = new RealtimeClient(opts);
      await c.agent(result.agentConfig).start();
      setClient(c);
      setPendingRoute(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setConnectError(
        err instanceof Error && /401|invalid/i.test(message)
          ? `That key was rejected by ${SESSION_TARGET} — a key from one environment will not work against another.`
          : /not available for this workspace/i.test(message)
            ? `${message} (openai/openai_mini routes need the realtime-openai-provider-enabled flag on for this workspace — try an intent that routes to Gemini instead, e.g. "help me practice a speech".)`
            : message,
      );
    } finally {
      startingRef.current = false;
      setConnecting(false);
    }
  }, [apiKey, intent]);

  const handleDisconnect = useCallback(() => {
    setClient(null);
    setPendingRoute(null);
    void client?.disconnect().catch((err) => {
      console.error('[model-router] disconnect failed', err);
    });
  }, [client]);

  return (
    <main
      style={{
        maxWidth: 720,
        margin: '56px auto',
        padding: '0 20px 64px',
      }}
    >
      <div
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-card)',
          padding: '32px 32px 28px',
        }}
      >
        <header style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: '-0.01em' }}>
            Model Router
          </h1>
          <p style={{ color: 'var(--color-text-muted)', margin: '6px 0 0', fontSize: 14.5 }}>
            Type what you want to do — the router picks the provider, model
            options, and voice for it.
          </p>
        </header>

        {connectError && (
          <p
            role="alert"
            style={{
              background: 'var(--color-danger-bg)',
              border: '1px solid var(--color-danger-border)',
              color: 'var(--color-danger-text)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 14px',
              marginBottom: 20,
              fontSize: 13,
            }}
          >
            {connectError}
          </p>
        )}

        {client ? (
          <CosmoRealtimeProvider client={client} maxTranscriptLength={40}>
            <Session
              intent={intent}
              pendingRoute={pendingRoute}
              onDisconnect={handleDisconnect}
              onConnectError={setConnectError}
            />
          </CosmoRealtimeProvider>
        ) : (
          <>
            <section style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
              <input
                className="mr-input"
                type="text"
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !connecting) {
                    e.preventDefault();
                    void handleConnect();
                  }
                }}
                placeholder="e.g. help me practice a speech"
                disabled={connecting}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="mr-button mr-button-primary"
                onClick={() => void handleConnect()}
                disabled={connecting || !intent.trim() || !apiKey}
              >
                {connecting ? 'Connecting…' : 'Start session'}
              </button>
            </section>

            <details className="mr-settings" open={!apiKey}>
              <summary>Connection</summary>
              <div style={{ marginTop: 10 }}>
                <label
                  htmlFor="k"
                  style={{ display: 'block', fontSize: 12.5, color: 'var(--color-text-muted)', marginBottom: 6 }}
                >
                  {HOSTED ? 'Access password' : 'API key'}
                </label>
                <input
                  id="k"
                  className="mr-input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={HOSTED ? '' : 'cosmo_…'}
                  style={{ width: '100%' }}
                />
                <p style={{ fontSize: 12, color: 'var(--color-text-faint)', margin: '8px 0 0' }}>
                  {HOSTED ? (
                    <>
                      This deployment keeps its Cosmo key server-side; the
                      password lets the page mint its own short-lived tokens.
                    </>
                  ) : (
                    <>
                      A workspace API key with the <code>realtime:use</code>{' '}
                      scope, sent to <code>{SESSION_TARGET}</code>. Set{' '}
                      <code>VITE_COSMO_API_KEY</code> in <code>.env</code> to
                      skip pasting it every run.
                    </>
                  )}
                </p>
              </div>
            </details>
          </>
        )}
      </div>
    </main>
  );
}

/** Everything that needs the SDK's React context — mounted only once
 *  `client` exists, so these hooks never run against a null client. */
function Session({
  intent,
  pendingRoute,
  onDisconnect,
  onConnectError,
}: {
  intent: string;
  pendingRoute: RouteResult | null;
  onDisconnect: () => void;
  onConnectError: (message: string | null) => void;
}) {
  const transportState = useTransportState();
  const agentState = useAgentState();
  const transcript = useTranscript();
  const error = useRealtimeError();

  const [ttfwMs, setTtfwMs] = useState<number | null>(null);
  const startRef = useRef<number | null>(null);
  const capturedRef = useRef(false);

  const isLive = transportState === 'ready';

  useEffect(() => {
    startRef.current = performance.now();
    capturedRef.current = false;
    setTtfwMs(null);
  }, [pendingRoute]);

  // Only accept the agent's first speech once this session is fully live —
  // guards against attributing a straggling 'speaking' event from a
  // just-torn-down previous session to the current one.
  useEffect(() => {
    if (isLive && agentState === 'speaking' && !capturedRef.current && startRef.current !== null) {
      capturedRef.current = true;
      setTtfwMs(performance.now() - startRef.current);
    }
  }, [isLive, agentState]);

  useEffect(() => {
    if (error) onConnectError(`[${error.code}] ${error.message}`);
  }, [error, onConnectError]);

  const status = STATUS_META[transportState];

  return (
    <>
      <section style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <input className="mr-input" type="text" value={intent} disabled style={{ flex: 1 }} />
        <button type="button" className="mr-button" onClick={onDisconnect}>
          Disconnect
        </button>
      </section>

      {pendingRoute && (
        <section
          style={{
            display: 'flex',
            gap: 14,
            alignItems: 'flex-start',
            marginBottom: 20,
            padding: '14px 16px',
            borderRadius: 'var(--radius)',
            background: PROVIDER_META[pendingRoute.provider].soft,
            borderLeft: `3px solid ${PROVIDER_META[pendingRoute.provider].solid}`,
          }}
        >
          <span
            style={{
              display: 'inline-block',
              padding: '3px 12px',
              borderRadius: 999,
              background: PROVIDER_META[pendingRoute.provider].solid,
              color: '#fff',
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              marginTop: 1,
            }}
          >
            {PROVIDER_META[pendingRoute.provider].label}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p
              style={{
                margin: 0,
                fontSize: 13.5,
                lineHeight: 1.5,
                color: PROVIDER_META[pendingRoute.provider].text,
              }}
            >
              {pendingRoute.rationale}
            </p>
            <p
              style={{
                margin: '6px 0 0',
                fontSize: 12,
                color: 'var(--color-text-muted)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              Time to first word:{' '}
              <strong style={{ color: 'var(--color-text)' }}>
                {ttfwMs === null ? 'measuring…' : `${Math.round(ttfwMs)} ms`}
              </strong>
            </p>
          </div>
        </section>
      )}

      <section
        style={{
          display: 'flex',
          gap: 14,
          alignItems: 'center',
          marginBottom: 20,
          paddingBottom: 20,
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <span
          className={status.pulse ? 'mr-status-dot mr-status-dot--pulse' : 'mr-status-dot'}
          style={{ background: status.color }}
        />
        <span style={{ fontSize: 13.5, color: 'var(--color-text-muted)' }}>{status.label}</span>
        <div style={{ flex: 1 }} />
        <MicToggle />
        <StartAudio>
          {({ blocked, start }) =>
            blocked ? (
              <button type="button" className="mr-button" onClick={() => void start()}>
                Tap to enable audio
              </button>
            ) : null
          }
        </StartAudio>
      </section>

      <section style={{ display: 'flex', gap: 24, alignItems: 'center', marginBottom: 24 }}>
        <div style={{ color: isLive ? 'var(--color-success)' : 'var(--color-text-faint)' }}>
          <BarVisualizer />
        </div>
        <LevelMeters />
      </section>

      <section>
        <h2
          style={{
            fontSize: 13,
            fontWeight: 600,
            margin: '0 0 10px',
            color: 'var(--color-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          Transcript
        </h2>
        <ol
          style={{
            listStyle: 'none',
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxHeight: 320,
            overflowY: 'auto',
            background: 'var(--color-surface-muted)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            padding: 14,
          }}
        >
          {transcript.length === 0 ? (
            <li style={{ color: 'var(--color-text-faint)', fontSize: 13.5 }}>No transcript yet.</li>
          ) : (
            transcript.map((entry) => {
              const isUser = entry.role === 'user';
              return (
                <li
                  key={entry.id}
                  className="mr-bubble"
                  style={{
                    display: 'flex',
                    justifyContent: isUser ? 'flex-end' : 'flex-start',
                    opacity: entry.isFinal ? 1 : 0.6,
                  }}
                >
                  <span
                    style={{
                      maxWidth: '78%',
                      padding: '8px 12px',
                      borderRadius: 'var(--radius)',
                      fontSize: 13.5,
                      lineHeight: 1.45,
                      background: isUser ? 'var(--color-primary)' : 'var(--color-surface)',
                      color: isUser ? '#fff' : 'var(--color-text)',
                      border: isUser ? 'none' : '1px solid var(--color-border)',
                    }}
                  >
                    {entry.text}
                  </span>
                </li>
              );
            })
          )}
        </ol>
      </section>

      <RealtimeAudio />
    </>
  );
}

// Isolated so a `volume` tick from useMicLevel/useOutputLevel only
// re-renders this subtree, not the whole panel (transcript, buttons, etc.).
function LevelMeters() {
  const micLevel = useMicLevel();
  const outputLevel = useOutputLevel();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
      <LevelBar label="Mic" value={micLevel} color="var(--color-success)" />
      <LevelBar label="Bot" value={outputLevel} color="var(--color-primary)" />
    </div>
  );
}

function LevelBar({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.min(100, Math.round(value * 100));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
      <span style={{ width: 28, color: 'var(--color-text-muted)' }}>{label}</span>
      <div
        style={{
          flex: 1,
          height: 6,
          background: 'var(--color-border)',
          borderRadius: 999,
          overflow: 'hidden',
        }}
      >
        <div className="mr-level-fill" style={{ width: `${pct}%`, height: '100%', background: color }} />
      </div>
      <span
        style={{
          width: 34,
          textAlign: 'right',
          color: 'var(--color-text-muted)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {pct}%
      </span>
    </div>
  );
}
