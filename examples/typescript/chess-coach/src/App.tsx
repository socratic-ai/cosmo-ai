import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RealtimeProvider,
  MicToggle,
  RealtimeAudio,
  RealtimeClient,
  RealtimeSession,
  useTranscript,
  useTransportState,
} from 'cosmo-ai';

import type { BoardOrientation } from './board_vision';
import { FrameCapture } from './frame_capture';
import { COACH_INSTRUCTIONS } from './instructions';
import { makeAnalyzePositionTool } from './analysis/analyze_position';
import {
  disposeAnalysisEngine,
  warmAnalysisEngine,
} from './analysis/stockfish_transport';
import { SPEECH_PEAK_THRESHOLD, monitorMicLevel, type MicMonitor } from './mic_check';
import { makeBoardPositionTool } from './tools';

// Prefill from a gitignored .env for local dev convenience (see .env.example).
// Never hardcode a key here — this file is committed.
const BASE_URL_DEFAULT = import.meta.env.VITE_COSMO_BASE_URL ?? 'https://platform.askcosmo.ai';
const API_KEY_DEFAULT = import.meta.env.VITE_COSMO_API_KEY ?? '';

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

type Phase = 'idle' | 'starting' | 'live';

async function openBoardStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ video: true });
}

function SessionView({
  stream,
  warning,
  onEnd,
}: {
  stream: MediaStream;
  warning: string | null;
  onEnd: () => void;
}) {
  const transport = useTransportState();
  const transcript = useTranscript();
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (el) el.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  const live = transport === 'ready' || transport === 'connected';
  const bad = transport === 'failed' || transport === 'disconnected';

  return (
    <>
      <div className="session-bar">
        <span className={`status${live ? ' live' : bad ? ' bad' : ''}`}>
          <span className="status-dot" />
          {live ? 'Coaching' : bad ? 'Not connected' : transport}
        </span>
        <MicToggle />
        <button className="btn btn-ghost" onClick={onEnd}>
          End session
        </button>
      </div>

      <RealtimeAudio />
      {warning && <div className="err">{warning}</div>}

      <div className="session-grid">
        <div className="stage-col">
          <video ref={videoRef} autoPlay muted playsInline />
        </div>

        <div className="chat-col">
          <p className="chat-head">Conversation</p>
          <div className="transcript scroll" ref={scrollRef}>
            {transcript.length === 0 ? (
              <p className="empty">Say hello, or ask what to play.</p>
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
        </div>
      </div>
    </>
  );
}

export function App() {
  const [apiKey, setApiKey] = useState(API_KEY_DEFAULT);
  const [baseUrl, setBaseUrl] = useState(BASE_URL_DEFAULT);
  const [orientation, setOrientation] = useState<BoardOrientation | 'auto'>('auto');
  const [phase, setPhase] = useState<Phase>('idle');
  const [startError, setStartError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const [micPeak, setMicPeak] = useState(0);
  const [micDevice, setMicDevice] = useState<string | null>(null);
  const [micHeard, setMicHeard] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

  const sessionRef = useRef<RealtimeSession | null>(null);
  const captureRef = useRef<FrameCapture | null>(null);
  const micMonitorRef = useRef<MicMonitor | null>(null);
  const [session, setSession] = useState<RealtimeSession | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  // Watch the mic while idle: a session started on a silent device does not
  // error, it hallucinates, so the meter has to answer "is it hearing me?"
  // before the session exists to ask.
  useEffect(() => {
    if (phase !== 'idle') return;
    let monitor: MicMonitor | null = null;
    let cancelled = false;
    void monitorMicLevel(({ peak, deviceLabel }) => {
      setMicPeak(peak);
      setMicDevice(deviceLabel);
      if (peak > SPEECH_PEAK_THRESHOLD) setMicHeard(true);
    })
      .then((m) => {
        if (cancelled) m.stop();
        else {
          monitor = m;
          micMonitorRef.current = m;
        }
      })
      .catch((err: unknown) => {
        setMicError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      monitor?.stop();
      micMonitorRef.current = null;
    };
  }, [phase]);

  const handleEnded = useCallback((reason: string | null) => {
    const spent = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    setWarning(null);
    setNote(reason === null || reason === 'client_ended' ? null : `Session ended (${reason}).`);
    captureRef.current?.dispose();
    captureRef.current = null;
    disposeAnalysisEngine();
    setStream(null);
    void (async () => {
      try {
        await spent?.close();
      } catch (err) {
        console.error('[chess-coach] close failed', err);
      }
      setPhase('idle');
    })();
  }, []);

  const start = useCallback(async () => {
    if (!apiKey || phase !== 'idle') return;
    setPhase('starting');
    setStartError(null);
    setNote(null);
    setWarning(null);
    setCosmoBaseUrl(baseUrl);

    // Release the preflight mic before the SDK opens its own capture.
    micMonitorRef.current?.stop();
    micMonitorRef.current = null;

    const pinned = orientation === 'auto' ? undefined : orientation;
    const vision = { baseUrl, apiKey };
    let capture: FrameCapture | null = null;
    let session: RealtimeSession;
    try {
      capture = new FrameCapture(await openBoardStream());
      // Before start(): the greeting can provoke a board read before start()
      // resolves, and a null capture there reads to the model as "no screen
      // share" on a session that has one.
      captureRef.current = capture;
      warmAnalysisEngine();
      const live = new RealtimeClient({ apiKey });
      session = await live
        .agent({
          instructions: COACH_INSTRUCTIONS,
          tools: [
            makeBoardPositionTool({
              vision,
              getCapture: () => captureRef.current,
              orientation: pinned,
            }),
            makeAnalyzePositionTool(),
          ],
          greeting:
            "Hi, I'm your chess coach — show me the board and tell me where the game stands.",
        })
        .start();
    } catch (err) {
      capture?.dispose();
      captureRef.current = null;
      console.error('[chess-coach] session start failed', err);
      // An abandoned session (a refresh mid-call) holds its slot for a short
      // window; a fresh start 429s until it is reclaimed.
      const busy = (err as { status?: number }).status === 429;
      setStartError(
        busy
          ? 'A previous session is still finishing — try again in a minute.'
          : err instanceof Error && /401|invalid/i.test(err.message)
            ? 'That key was rejected. Check it matches the server below — a key from one environment will not work against another.'
            : err instanceof Error
              ? err.message
              : String(err),
      );
      setPhase('idle');
      return;
    }

    sessionRef.current = session;

    // A tool the server refuses is silently absent from the model's menu —
    // it simply never calls it, which reads as the coach ignoring the board.
    session.on('ready', (ev) => {
      if (ev.rejectedTools.length === 0) return;
      console.error('[chess-coach] server rejected tools', ev.rejectedTools);
      setWarning(
        `This backend rejected: ${ev.rejectedTools.map((t) => t.name).join(', ')}`,
      );
    });
    // Fires exactly once on any exit path, so teardown has one funnel.
    session.on('session_ended', (ev) => handleEnded(ev.reason ?? null));

    setStream(capture.stream);
    setSession(session);
    setPhase('live');
  }, [apiKey, baseUrl, orientation, phase, handleEnded]);

  const end = useCallback(async () => {
    // Ending cleanly frees the server slot now, so a restart doesn't 429.
    try {
      await sessionRef.current?.end();
    } catch (err) {
      console.error('[chess-coach] end failed', err);
      handleEnded('client_ended');
    }
  }, [handleEnded]);

  // Unmount leaves nothing running: the screen-share indicator stays lit and
  // the engine worker survives if the tracks and wasm are not released too.
  useEffect(
    () => () => {
      void sessionRef.current?.end();
      captureRef.current?.dispose();
      captureRef.current = null;
      micMonitorRef.current?.stop();
      disposeAnalysisEngine();
    },
    [],
  );

  useEffect(() => {
    document.body.classList.toggle('lesson', phase !== 'live');
    return () => document.body.classList.remove('lesson');
  }, [phase]);

  if (phase === 'live' && session !== null && stream !== null) {
    return (
      <div className="shell wide">
        <RealtimeProvider session={session} maxTranscriptLength={50}>
          <SessionView stream={stream} warning={warning} onEnd={() => void end()} />
        </RealtimeProvider>
      </div>
    );
  }

  const micBar = Math.min(100, Math.round(micPeak * 400));
  const steps: { label: string; state: 'todo' | 'current' | 'done' }[] = [
    { label: 'Connect', state: apiKey ? 'done' : 'current' },
    { label: 'Microphone', state: micHeard ? 'done' : apiKey ? 'current' : 'todo' },
    { label: 'Play', state: apiKey && micHeard ? 'current' : 'todo' },
  ];

  return (
    <div className="shell lesson-shell">
      <article className="lesson-card">
        <header className="masthead">
          <p className="eyebrow">
            <span className="eyebrow-glyph" aria-hidden="true">
              ♟
            </span>
            Lesson 1
          </p>
          <h1>Let’s set up your board.</h1>
          <p className="lede">
            Share the tab with your game — lichess, chess.com, anywhere. I’ll read the
            position, run the engine, and we’ll talk it through together. I won’t just
            hand you the move.
          </p>
        </header>

        <ol className="stepper">
          {steps.map((step, i) => (
            <li key={step.label} className={`step ${step.state}`}>
              <span className="step-head">
                <span className="step-n">{step.state === 'done' ? '✓' : i + 1}</span>
                {step.label}
              </span>
              <span className="step-track">
                <span className="step-fill" />
              </span>
            </li>
          ))}
        </ol>

        <div className="field">
          <label htmlFor="or">Which side are you playing?</label>
          <select
            id="or"
            value={orientation}
            onChange={(e) => setOrientation(e.target.value as BoardOrientation | 'auto')}
          >
            <option value="auto">Work it out from the board</option>
            <option value="white">White</option>
            <option value="black">Black</option>
          </select>
        </div>

        <div className="field">
          <label>Microphone {micDevice && <span className="muted">— {micDevice}</span>}</label>
          <div className="meter">
            <div className="meter-fill" style={{ width: `${micBar}%` }} />
          </div>
          <p className={micHeard ? 'ok' : 'empty'}>
            {micError
              ? `Microphone blocked: ${micError}`
              : micHeard
                ? 'I can hear you.'
                : 'Say something — the bar should move before we begin.'}
          </p>
        </div>

        <button
          className="btn btn-primary"
          onClick={() => void start()}
          disabled={phase === 'starting' || !apiKey}
        >
          {phase === 'starting'
            ? 'Connecting…'
            : apiKey
              ? 'Start the lesson  →'
              : 'Add a key below to start'}
        </button>
        {startError && <div className="err">{startError}</div>}
        {note && <p className="empty">{note}</p>}

        <details className="settings" open={!apiKey}>
          <summary>Connection</summary>
          <div className="field">
            <label htmlFor="k">API key</label>
            <input
              id="k"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="cosmo_…"
            />
          </div>
          <div className="field">
            <label htmlFor="u">Server</label>
            <input id="u" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
        </details>
      </article>
    </div>
  );
}
