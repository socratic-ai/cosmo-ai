import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CosmoRealtimeProvider,
  MicToggle,
  RealtimeAudio,
  RealtimeClient,
  useTranscript,
  useTransportState,
} from 'cosmo-ai';

import type { BoardOrientation } from './board_vision';
import { FrameCapture } from './frame_capture';
import { REFEREE_ALERT_TAG, REFEREE_INSTRUCTIONS } from './instructions';
import { Referee, type RefereeEvent } from './referee';
import { startRefereeLoop } from './referee_loop';
import { makeAnalyzePositionTool } from './analysis/analyze_position';
import {
  disposeAnalysisEngine,
  warmAnalysisEngine,
} from './analysis/stockfish_transport';
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

type BoardSource = 'camera' | 'screen';

async function openBoardStream(source: BoardSource): Promise<MediaStream> {
  if (source === 'screen') {
    return navigator.mediaDevices.getDisplayMedia({ video: true });
  }
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'environment',
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
}

function describeVerdict(event: RefereeEvent): string {
  switch (event.kind) {
    case 'game_started':
      return 'Game on — starting position recognized';
    case 'legal_move':
      return `${event.mover} played ${event.san}`;
    case 'illegal_move':
      return `ILLEGAL: ${event.description}`;
    case 'out_of_turn':
      return `Out of turn: ${event.mover} played ${event.san}`;
    case 'board_scrambled':
      return 'Board unclear — waiting for a clean position';
  }
}

/** Forward a referee event into the session: silent context for normal play,
 *  a spoken interjection for violations. */
function forward(client: RealtimeClient, event: RefereeEvent): void {
  switch (event.kind) {
    case 'game_started':
      void client.sendContext('[board] New game from the starting position. White to move.');
      break;
    case 'legal_move':
      void client.sendContext(
        `[board] ${event.mover} played ${event.san}. Position (FEN): ${event.fen}`,
      );
      break;
    case 'illegal_move':
      void client.sendText(
        `${REFEREE_ALERT_TAG} Illegal move on the board: ${event.description}. ` +
          `Observed placement: ${event.observed}. Call it out now.`,
        { transcript: false },
      );
      break;
    case 'out_of_turn':
      void client.sendText(
        `${REFEREE_ALERT_TAG} ${event.mover} just played ${event.san} — but it is not ` +
          `${event.mover}'s turn. Call it out now.`,
        { transcript: false },
      );
      break;
    case 'board_scrambled':
      void client.sendContext(
        '[board] The board changed in a way no single move explains ' +
          '(pieces knocked over or mid-adjustment). Waiting for it to settle.',
      );
      break;
  }
}

function SessionView({
  stream,
  verdict,
  readError,
  onEnd,
}: {
  stream: MediaStream;
  verdict: string;
  readError: string | null;
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
          {live ? 'Watching' : bad ? 'Not connected' : transport}
        </span>
        <MicToggle />
        <button className="btn btn-ghost" onClick={onEnd}>
          End session
        </button>
      </div>

      <RealtimeAudio />

      <div className="session-grid">
        <div className="stage-col">
          <video ref={videoRef} autoPlay muted playsInline />
          <div className={`verdict${verdict.startsWith('ILLEGAL') ? ' bad' : ''}`}>
            {verdict || 'Set up the starting position to begin'}
          </div>
          {readError && <div className="err">{readError}</div>}
        </div>

        <div className="chat-col">
          <p className="chat-head">Conversation</p>
          <div className="transcript scroll" ref={scrollRef}>
            {transcript.length === 0 ? (
              <p className="empty">Say hello, or ask what the referee can see.</p>
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
  const [source, setSource] = useState<BoardSource>('camera');
  const [orientation, setOrientation] = useState<BoardOrientation | 'auto'>('white');
  const [connecting, setConnecting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState('');
  const [readError, setReadError] = useState<string | null>(null);

  const clientRef = useRef<RealtimeClient | null>(null);
  const captureRef = useRef<FrameCapture | null>(null);
  const stopLoopRef = useRef<(() => void) | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const teardown = useCallback(() => {
    stopLoopRef.current?.();
    stopLoopRef.current = null;
    void clientRef.current?.disconnect();
    clientRef.current = null;
    captureRef.current?.dispose();
    captureRef.current = null;
    disposeAnalysisEngine();
    setStream(null);
    setVerdict('');
    setReadError(null);
  }, []);

  useEffect(() => teardown, [teardown]);

  const handleStart = useCallback(async () => {
    if (!apiKey) return;
    setConnecting(true);
    setStartError(null);
    setCosmoBaseUrl(baseUrl);

    const pinned = orientation === 'auto' ? undefined : orientation;
    const vision = { baseUrl, apiKey };
    const referee = new Referee();
    let capture: FrameCapture | null = null;
    const client = new RealtimeClient({ apiKey });
    try {
      capture = new FrameCapture(await openBoardStream(source));
      warmAnalysisEngine();
      await client
        .agent({
          instructions: REFEREE_INSTRUCTIONS,
          tools: [
            makeBoardPositionTool({
              vision,
              getCapture: () => captureRef.current,
              referee,
              orientation: pinned,
            }),
            makeAnalyzePositionTool(),
          ],
          greeting:
            "Hi, I'm your referee — set the pieces up in the starting position and I'll follow along.",
        })
        .start();

      captureRef.current = capture;
      clientRef.current = client;
      setStream(capture.stream);
      stopLoopRef.current = startRefereeLoop({
        capture,
        vision,
        referee,
        orientation: pinned,
        onEvent: (event) => {
          setVerdict(describeVerdict(event));
          setReadError(null);
          forward(client, event);
        },
        onReadError: (error) => {
          setReadError(error instanceof Error ? error.message : String(error));
        },
      });
    } catch (err) {
      capture?.dispose();
      void client.disconnect();
      setStartError(
        err instanceof Error && /401|invalid/i.test(err.message)
          ? 'That key was rejected. Check it matches the server below — a key from one environment will not work against another.'
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setConnecting(false);
    }
  }, [apiKey, baseUrl, source, orientation]);

  const client = clientRef.current;

  return (
    <div className={`shell${client && stream ? ' wide' : ''}`}>
      <header className="masthead">
        <p className="eyebrow">Cosmo Realtime</p>
        <h1>Chess referee</h1>
        <p className="lede">
          Point a camera at your board. The referee follows every move — and speaks up,
          unprompted, when someone breaks the rules.
        </p>
      </header>

      {client && stream ? (
        <CosmoRealtimeProvider client={client} maxTranscriptLength={50}>
          <SessionView stream={stream} verdict={verdict} readError={readError} onEnd={teardown} />
        </CosmoRealtimeProvider>
      ) : (
        <>
          <div className="field-row">
            <div className="field">
              <label htmlFor="src">Board source</label>
              <select
                id="src"
                value={source}
                onChange={(e) => setSource(e.target.value as BoardSource)}
              >
                <option value="camera">Camera</option>
                <option value="screen">Screen share (lichess, chess.com)</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="or">Side nearest the camera</label>
              <select
                id="or"
                value={orientation}
                onChange={(e) => setOrientation(e.target.value as BoardOrientation | 'auto')}
              >
                <option value="white">White</option>
                <option value="black">Black</option>
                <option value="auto">Detect from the board</option>
              </select>
            </div>
          </div>

          <button
            className="btn btn-primary"
            onClick={() => void handleStart()}
            disabled={connecting || !apiKey}
          >
            {connecting ? 'Connecting…' : apiKey ? 'Start refereeing' : 'Add a key below to start'}
          </button>
          {startError && <div className="err">{startError}</div>}

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
        </>
      )}
    </div>
  );
}
