import { useEffect, useRef, useState } from 'react';
import {
  MicToggle,
  RealtimeAudio,
  StartAudio,
  useRealtimeClient,
  useToolCalls,
  useTranscript,
  useTransportState,
} from 'cosmo-ai';

export function AgentPanel({ onEnd }: { onEnd: () => void }) {
  const client = useRealtimeClient();
  const transport = useTransportState();
  const transcript = useTranscript();
  const toolCalls = useToolCalls();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [micError, setMicError] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  const live = transport === 'ready' || transport === 'connected';
  const bad = transport === 'failed' || transport === 'disconnected';

  const send = () => {
    const text = draft.trim();
    if (!text || !live) return;
    setDraft('');
    void client.sendText(text);
  };

  return (
    <aside className="panel">
      <div className="panel-bar">
        <span className={`status${live ? ' live' : bad ? ' bad' : ''}`}>
          <span className="status-dot" />
          {live ? 'Listening' : bad ? 'Not connected' : transport}
        </span>
        <MicToggle
          className="btn mic"
          label={{ muted: 'Muted', unmuted: 'Mic on' }}
          onError={() => setMicError(true)}
        />
        <button
          className="btn btn-ghost"
          onClick={() => {
            void client.disconnect();
            onEnd();
          }}
        >
          End
        </button>
      </div>

      {micError && <div className="err">Could not toggle the microphone. Try again.</div>}

      <RealtimeAudio />
      <StartAudio>
        {({ blocked, start }) =>
          blocked ? (
            <button className="btn" onClick={() => void start()}>
              Tap to enable voice
            </button>
          ) : null
        }
      </StartAudio>

      <div className="transcript" ref={scrollRef}>
        {transcript.length === 0 ? (
          <p className="empty">Ask about the page you're on, or anything else in the document.</p>
        ) : (
          transcript.map((item) => (
            <div
              key={item.id}
              className={`bubble ${item.role === 'user' ? 'user' : 'assistant'}${item.isFinal ? '' : ' partial'}`}
            >
              {item.text}
            </div>
          ))
        )}
      </div>

      {toolCalls.length > 0 && (
        <details className="tools">
          <summary>Document lookups ({toolCalls.length})</summary>
          <ul>
            {toolCalls.slice(-8).map((call) => (
              <li key={call.toolCallId}>
                <code>{call.name}</code>
                <span className={`tool-status ${call.status}`}>{call.status}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="composer">
        <input
          value={draft}
          placeholder="…or type instead"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
          disabled={!live}
        />
        <button className="btn" onClick={send} disabled={!live || !draft.trim()}>
          Send
        </button>
      </div>
    </aside>
  );
}
