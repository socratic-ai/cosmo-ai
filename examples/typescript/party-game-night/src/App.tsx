import { useCallback, useRef, useState } from 'react';

import { CosmoRealtimeProvider, RealtimeClient, type RealtimeSession } from 'cosmo-ai';

import { partyGameNightAgent } from './agent';
import { GameStore } from './game/state';
import { LiveView } from './LiveView';

// Prefill from a gitignored .env for local dev convenience (see .env.example).
// Never hardcode a key here — this file is committed.
const API_KEY_DEFAULT = import.meta.env.VITE_COSMO_API_KEY ?? '';

type Phase = 'idle' | 'starting' | 'live';

export function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [apiKey, setApiKey] = useState(API_KEY_DEFAULT);
  const [client, setClient] = useState<RealtimeClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // One store for the whole evening: it survives across sessions, so a
  // dropped call resumes with the scores still on the strip.
  const storeRef = useRef<GameStore | null>(null);
  if (storeRef.current === null) storeRef.current = new GameStore();
  const store = storeRef.current;

  const clientRef = useRef<RealtimeClient | null>(null);
  const sessionRef = useRef<RealtimeSession | null>(null);

  const handleEnded = useCallback((reason: string | null) => {
    // A client is single-use, and an abandoned one keeps the microphone it
    // captured. The start button stays disabled until the release lands.
    const spent = clientRef.current;
    clientRef.current = null;
    sessionRef.current = null;
    setClient(null);
    setWarning(null);
    setNote(reason === null || reason === 'client_ended' ? null : `The show ended (${reason}).`);
    void (async () => {
      try {
        await spent?.disconnect();
      } catch (err) {
        console.error('[party-game-night] disconnect failed', err);
      }
      setPhase('idle');
    })();
  }, []);

  const start = useCallback(async () => {
    if (!apiKey || phase !== 'idle') return;
    setPhase('starting');
    setError(null);
    setNote(null);
    setWarning(null);

    let live: RealtimeClient;
    let session: RealtimeSession;
    try {
      live = new RealtimeClient({ apiKey });
      session = await live.agent(partyGameNightAgent(store)).start();
    } catch (err) {
      console.error('[party-game-night] session start failed', err);
      // Refresh-abandoned sessions are reclaimed after a short window; a
      // fresh start can 429 until then. Say so instead of the raw error.
      const busy = (err as { status?: number }).status === 429;
      setError(
        busy
          ? 'The stage is still busy — try again in a minute.'
          : err instanceof Error
            ? err.message
            : String(err),
      );
      setPhase('idle');
      return;
    }

    clientRef.current = live;
    sessionRef.current = session;

    session.on('ready', (ev) => {
      if (ev.rejectedTools.length === 0) return;
      const names = ev.rejectedTools.map((tool) => tool.name).join(', ');
      console.error('[party-game-night] server rejected tools', ev.rejectedTools);
      setWarning(`This backend rejected: ${names}`);
    });
    // Fires exactly once on any exit path — End button, the MC's own
    // end_call, network loss — so every teardown funnels through here.
    session.on('session_ended', (ev) => handleEnded(ev.reason ?? null));

    setClient(live);
    setPhase('live');
  }, [apiKey, phase, store, handleEnded]);

  const end = useCallback(async () => {
    // A clean end frees the server slot immediately (no 429 on restart);
    // the session_ended handler does the teardown.
    try {
      await sessionRef.current?.end();
    } catch (err) {
      console.error('[party-game-night] end failed', err);
      handleEnded('client_ended');
    }
  }, [handleEnded]);

  if (phase === 'live' && client !== null) {
    return (
      <CosmoRealtimeProvider client={client}>
        <LiveView store={store} warning={warning} onEnd={() => void end()} />
      </CosmoRealtimeProvider>
    );
  }

  return (
    <div className="start">
      <div className="marquee">
        <p className="eyebrow">Cosmo Realtime presents</p>
        <h1>
          Party
          <br />
          Game Night
        </h1>
      </div>
      <p className="lede">
        An AI game-show host on your TV: it conjures the board, flips the
        answers you shout, and keeps score — one device, the whole room playing.
      </p>
      {API_KEY_DEFAULT === '' && (
        <input
          type="password"
          value={apiKey}
          placeholder="Cosmo API key (realtime:use)"
          autoComplete="off"
          onChange={(event) => setApiKey(event.target.value)}
        />
      )}
      {error !== null && <p className="err">{error}</p>}
      {note !== null && <p className="note">{note}</p>}
      <button
        className="btn primary"
        onClick={() => void start()}
        disabled={!apiKey || phase === 'starting'}
      >
        {phase === 'starting' ? 'Warming up the stage…' : 'Start game night'}
      </button>
      <p className="fine">Best on the biggest screen in the room, volume up.</p>
    </div>
  );
}
