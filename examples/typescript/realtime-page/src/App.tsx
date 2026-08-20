'use client';

import { useCallback, useState } from 'react';
import {
  RealtimeProvider,
  RealtimeAudio,
  MicToggle,
  useRealtimeSessionContext,
  useTranscript,
  useToolCalls,
  useTransportState,
  RealtimeClient,
  type RealtimeClientOptions,
  type RealtimeSession,
} from 'cosmo-ai';
import { tool } from 'cosmo-ai/tool';
import { zodInput } from 'cosmo-ai/tool/zod';
import { z } from 'zod/v4';

const BASE_URL_DEFAULT = 'https://platform.askcosmo.ai';

/** Name the backend from inside the page. The SDK reads ``COSMO_BASE_URL``
 *  on Node; a browser has no environment, so it reads this tag instead —
 *  normally written by the server that rendered the page. */
function setCosmoBaseUrl(baseUrl: string): void {
  let tag = document.querySelector('meta[name="cosmo-base-url"]');
  if (tag === null) {
    tag = document.createElement('meta');
    tag.setAttribute('name', 'cosmo-base-url');
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', baseUrl);
}

const getLocalTime = tool({
  name: 'get_local_time',
  description: 'Returns the local wall-clock time.',
  input: zodInput(
    z.object({
      locale: z.string().describe('BCP 47 locale tag, e.g. "en-US"').optional(),
    }),
  ),
  handler: async ({ locale }) => ({
    time: new Date().toLocaleTimeString(locale),
  }),
});

function SessionForm({
  onStart,
  disabled,
}: {
  onStart: (apiKey: string, baseUrl: string) => void;
  disabled: boolean;
}) {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(BASE_URL_DEFAULT);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (apiKey) onStart(apiKey, baseUrl);
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 400 }}>
      <label style={{ fontWeight: 600 }}>API Key</label>
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="cosmo_..."
        required
        style={{ padding: '6px 8px', fontFamily: 'monospace' }}
      />
      <label style={{ fontWeight: 600 }}>Base URL</label>
      <input
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 12 }}
      />
      <button type="submit" disabled={disabled} style={{ marginTop: 8, padding: '8px 16px', cursor: 'pointer' }}>
        Start Session
      </button>
    </form>
  );
}

function SessionView() {
  const session = useRealtimeSessionContext();
  const transport = useTransportState();
  const transcript = useTranscript();
  const toolCalls = useToolCalls();

  const handleEnd = useCallback(() => {
    void session?.end();
  }, [session]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ padding: '2px 10px', background: '#e2f8e8', borderRadius: 12, fontSize: 13 }}>
          {transport}
        </span>
        <MicToggle />
        <button onClick={handleEnd} style={{ padding: '6px 14px', cursor: 'pointer' }}>
          End Session
        </button>
      </div>

      <RealtimeAudio />

      <section>
        <h3 style={{ margin: '0 0 8px' }}>Transcript</h3>
        {transcript.length === 0 && (
          <p style={{ color: '#888', fontStyle: 'italic' }}>Waiting for speech…</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {transcript.map((item) => (
            <div
              key={item.id}
              style={{
                padding: '6px 10px',
                borderRadius: 8,
                background: item.role === 'user' ? '#dbeafe' : '#f3f4f6',
                alignSelf: item.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
                opacity: item.isFinal ? 1 : 0.65,
              }}
            >
              <strong style={{ fontSize: 11, textTransform: 'uppercase', color: '#555' }}>
                {item.role}
              </strong>
              <p style={{ margin: '2px 0 0', fontSize: 14 }}>{item.text}</p>
            </div>
          ))}
        </div>
      </section>

      {toolCalls.length > 0 && (
        <section>
          <h3 style={{ margin: '0 0 8px' }}>Tool Calls</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {toolCalls.map((tc) => (
              <div
                key={tc.toolCallId}
                style={{ padding: '6px 10px', background: '#fef9c3', borderRadius: 8, fontSize: 13 }}
              >
                <strong>{tc.name}</strong>
                <span
                  style={{
                    marginLeft: 8,
                    color: tc.status === 'ok' ? '#15803d' : tc.status === 'error' ? '#b91c1c' : '#92400e',
                  }}
                >
                  [{tc.status}]
                </span>
                {tc.summary && <span style={{ marginLeft: 8, color: '#555' }}>{tc.summary}</span>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function App() {
  const [connecting, setConnecting] = useState(false);
  const [session, setSession] = useState<RealtimeSession | null>(null);

  const handleStart = useCallback(
    async (apiKey: string, baseUrl: string) => {
      setConnecting(true);
      setCosmoBaseUrl(baseUrl);
      const opts: RealtimeClientOptions = { apiKey };
      const client = new RealtimeClient(opts);
      try {
        setSession(await client.agent({ tools: [getLocalTime] }).start());
      } finally {
        setConnecting(false);
      }
    },
    [],
  );

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '40px auto', padding: '0 20px' }}>
      <h1 style={{ marginBottom: 8 }}>Cosmo Realtime Hello World</h1>
      <p style={{ color: '#555', marginBottom: 24, fontSize: 14 }}>
        Demo page for <code>cosmo-ai</code> — voice + transcript + tool calls.
      </p>

      {session == null ? (
        <SessionForm onStart={handleStart} disabled={connecting} />
      ) : (
        <RealtimeProvider session={session} maxTranscriptLength={50}>
          <SessionView />
        </RealtimeProvider>
      )}
    </div>
  );
}
