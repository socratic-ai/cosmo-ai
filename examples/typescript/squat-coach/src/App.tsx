'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RealtimeProvider,
  RealtimeAudio,
  MicToggle,
  useRealtimeSessionContext,
  useTranscript,
  useTransportState,
  RealtimeClient,
  type RealtimeClientOptions,
  type RealtimeSession,
} from 'cosmo-ai';
import { tool } from 'cosmo-ai/tool';
import { zodInput } from 'cosmo-ai/tool/zod';
import { z } from 'zod/v4';

// Prefill from a gitignored .env for local dev convenience (see .env.example).
// Never hardcode a key here — this file is committed.
const BASE_URL_DEFAULT = import.meta.env.VITE_COSMO_BASE_URL ?? 'https://platform.askcosmo.ai';

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
const API_KEY_DEFAULT = import.meta.env.VITE_COSMO_API_KEY ?? '';

type SceneEvent = {
  rep_id: number;
  t_ms: number;
  knee_flexion_deg: number;
  torso_lean_deg: number;
  eccentric_ms?: number | null;
  concentric_ms?: number | null;
  heel_rise_norm?: number | null;
  lr_knee_asymmetry_deg?: number | null;
  camera_view: string;
  frontal_plane_claim_valid: boolean;
  note?: string;
};

type SceneState = {
  source_video: string;
  camera_view: string;
  n_reps_detected: number;
  events: SceneEvent[];
};

type CoachingFinding = {
  title: string;
  detail: string;
  source: 'measured' | 'visual' | 'both';
  rep_ids: number[];
  start_ms?: number;
  end_ms?: number;
  confidence: 'low' | 'medium' | 'high';
  priority: number;
};

type Coaching = {
  session_summary: string;
  reliability: { reps_trustworthy: number[]; reps_disputed: number[]; note: string };
  findings: CoachingFinding[];
  disagreements: { what: string; resolution: string }[];
};

function buildInstructions(scene: SceneState, coaching: Coaching | null): string {
  const disputed = new Set(coaching?.reliability.reps_disputed ?? []);
  const lines = scene.events
    .filter((e) => !disputed.has(e.rep_id))
    .map(
      (e) =>
        `  rep ${e.rep_id} @ t=${(e.t_ms / 1000).toFixed(1)}s — knee flexion ${e.knee_flexion_deg}deg, ` +
        `torso lean ${e.torso_lean_deg}deg` +
        (e.eccentric_ms ? `, down ${(e.eccentric_ms / 1000).toFixed(1)}s / up ${((e.concentric_ms ?? 0) / 1000).toFixed(1)}s` : '') +
        (e.heel_rise_norm != null ? `, heel rise ${e.heel_rise_norm}` : '') +
        (e.lr_knee_asymmetry_deg != null ? `, L/R difference ${e.lr_knee_asymmetry_deg}deg` : '') +
        (e.frontal_plane_claim_valid ? '' : ' (side camera — no valgus/rotation claims)'),
    )
    .join('\n');

  const analysis = coaching
    ? `
A visual review also watched the footage and caught things joint angles cannot measure.
Its conclusions, most important first:

${coaching.findings
  .slice()
  .sort((a, b) => a.priority - b.priority)
  .map(
    (f) =>
      `  ${f.priority}. ${f.title} — ${f.detail}\n     (reps ${f.rep_ids.join(', ') || 'n/a'}; ${f.confidence} confidence; from: ${f.source})`,
  )
  .join('\n')}

Overall: ${coaching.session_summary}
${
  disputed.size > 0
    ? `\nIMPORTANT — reps ${[...disputed].join(', ')} were NOT real reps (${coaching.reliability.note}). \
They have been removed from the measurements above. Never mention them or cite numbers from them.`
    : ''
}${
        coaching.disagreements.length > 0
          ? `\nWhere the two sources disagreed:\n${coaching.disagreements
              .map((d) => `  - ${d.what}: ${d.resolution}`)
              .join('\n')}`
          : ''
      }

Lead with the highest-priority finding. A "visual" finding was seen but not measured — say it as an \
observation ("your back looked like it rounded"), not a measurement. A "measured" finding has real \
numbers behind it and can be stated precisely.
`
    : '\n(No visual review ran for this session — you only have the measurements above.)\n';

  return `You are a squat-form coach talking with someone about a set they just recorded.

Measured by a deterministic pose pipeline (MediaPipe joint angles — no vision model, these numbers \
are reliable but only cover what joint angles can express):
${lines}
${analysis}
Two kinds of questions, handled differently:
1. About THIS set ("what did I do wrong", "show me rep 6") — answer only from what's above. Camera \
view is ${scene.camera_view}, so never claim knee valgus or rotation unless it's frontal. If the \
data can't answer, say so plainly rather than guessing.
2. General coaching knowledge ("why does depth matter", "how do I fix this") — answer freely from \
your own knowledge. Don't deflect these just because they aren't about this video.

When you reference a specific rep, call play_video with a ~2-3 second window around its timestamp \
so they can see it, then talk through it. Its input is a list of segments — \
{segments: [{t_start, t_end, label}]}, up to 4, played in order — so to compare two reps ("your \
fifth versus your sixth"), pass both windows in ONE call rather than two, and label them ("rep 5", \
"rep 6"). A segment can also carry repeat (1-3) to play the same moment back to back — use it when \
the user asks to watch something again or a subtle fault needs a second look. The call comes back as soon as the first clip starts, so its result never tells you about \
its own playback; what it does carry is previous_playback, the record of what actually happened \
during your PREVIOUS call — whether each clip finished, or the user paused or scrubbed away partway \
through. Read it before assuming they saw what you showed them, and offer a replay if they didn't. \
If the user says they didn't see something you played, do NOT insist that it played — call \
play_video with an empty segments list ({segments: []}): that plays nothing and returns \
previous_playback, so you can check what actually happened and answer with evidence.

When the user questions your data ("I think that's wrong"), don't retreat to generalities — cite \
the specific per-rep numbers from the data above and their provenance, name the measurement's known \
weakness (heel/foot tracking is the noisiest signal; visual findings are observations, not numbers), \
and offer a replay of the exact moment so they can judge with their own eyes. If what they see \
contradicts a noisy measurement, the replay wins.

Keep it conversational and brief — this is spoken, not a written report. Open with the most \
important thing you found, then let them drive.`;
}

function waitForEvent(el: HTMLVideoElement, event: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => cleanup(() => reject(new Error(`timed out waiting for ${event}`))), timeoutMs);
    const onEvent = () => cleanup(resolve);
    const onError = () => {
      const err = el.error;
      cleanup(() => reject(new Error(`video error (code ${err?.code ?? '?'}): ${err?.message || 'unknown'}`)));
    };
    const cleanup = (fn: () => void) => {
      clearTimeout(timeout);
      el.removeEventListener(event, onEvent);
      el.removeEventListener('error', onError);
      fn();
    };
    el.addEventListener(event, onEvent, { once: true });
    el.addEventListener('error', onError, { once: true });
  });
}

// HTMLMediaElement is a state machine, not a stateless player — a tool call
// that fires after a prior call left the element errored/aborted must reset
// it explicitly. Only reload when actually broken/uninitialized; reloading a
// healthy element aborts its in-flight fetch and Chrome reports that abort
// as a spurious error.
async function ensureMetadata(el: HTMLVideoElement): Promise<void> {
  if (el.readyState >= HTMLMediaElement.HAVE_METADATA && !el.error) return;
  el.pause();
  el.load();
  if (el.readyState < HTMLMediaElement.HAVE_METADATA) {
    await waitForEvent(el, 'loadedmetadata');
  }
}

type PlaybackSegment = { t_start: number; t_end: number; label?: string };

type PlaybackEntry = {
  label?: string;
  requested: [number, number];
  started_at_ms: number;
  outcome: 'completed' | 'interrupted' | 'error';
  actually_played: [number, number];
  user_paused_at?: number;
  user_seeked_to?: number;
  error?: string;
};

type PlayVideoResult = {
  ok: boolean;
  playing?: string;
  queued?: number;
  reason?: string;
  error?: string;
  previous_playback: PlaybackEntry[];
};

const LEDGER_LIMIT = 10;
const SEGMENT_GAP_MS = 400;

const round2 = (n: number) => Number(n.toFixed(2));

function makePlayVideoTool(videoRef: React.RefObject<HTMLVideoElement | null>) {
  let busy: Promise<unknown> = Promise.resolve();
  let generation = 0;
  const ledger: PlaybackEntry[] = [];
  // A segment ends on whichever comes first: its end time, the user taking the
  // element over, an error, or a newer tool call. Detaching only on the first
  // of those leaks listeners that later pause someone else's clip, and leaves
  // the queue waiting on a segment nobody is playing.
  let active: { finish: (outcome: PlaybackEntry['outcome'], error?: string) => void } | null = null;

  const record = (entry: PlaybackEntry) => {
    ledger.push(entry);
    if (ledger.length > LEDGER_LIMIT) ledger.shift();
  };

  async function beginSegment(
    el: HTMLVideoElement,
    seg: PlaybackSegment,
  ): Promise<{ playing: string; done: Promise<PlaybackEntry> }> {
    await ensureMetadata(el);
    const duration = Number.isFinite(el.duration) ? el.duration : Infinity;
    const start = Math.min(Math.max(seg.t_start, 0), duration);
    const end = Math.min(Math.max(seg.t_end, start + 0.1), duration);
    el.pause();
    el.currentTime = start;
    if (el.seeking) await waitForEvent(el, 'seeked');
    await el.play();

    const entry: PlaybackEntry = {
      label: seg.label,
      requested: [seg.t_start, seg.t_end],
      started_at_ms: Date.now(),
      outcome: 'completed',
      actually_played: [round2(start), round2(start)],
    };
    let lastTime = start;

    const done = new Promise<PlaybackEntry>((resolve) => {
      const detach = () => {
        el.removeEventListener('timeupdate', onTick);
        el.removeEventListener('ended', onEnded);
        el.removeEventListener('pause', onPause);
        el.removeEventListener('seeking', onSeeking);
        el.removeEventListener('error', onError);
      };
      const finish = (outcome: PlaybackEntry['outcome'], error?: string) => {
        detach();
        entry.outcome = outcome;
        // After a user seek currentTime is already the destination, so the last
        // tick before it is where playback actually stopped.
        entry.actually_played = [round2(start), round2(entry.user_seeked_to == null ? el.currentTime : lastTime)];
        if (error) entry.error = error;
        if (active === handle) active = null;
        record(entry);
        resolve(entry);
      };
      const onTick = () => {
        lastTime = el.currentTime;
        if (el.currentTime >= end) {
          detach();
          el.pause();
          finish('completed');
        }
      };
      const onEnded = () => finish('completed');
      const onPause = () => {
        entry.user_paused_at = round2(el.currentTime);
        finish('interrupted');
      };
      const onSeeking = () => {
        entry.user_seeked_to = round2(el.currentTime);
        finish('interrupted');
      };
      const onError = () => finish('error', el.error?.message || `video error (code ${el.error?.code ?? '?'})`);
      const handle = { finish };

      el.addEventListener('timeupdate', onTick);
      el.addEventListener('ended', onEnded);
      el.addEventListener('pause', onPause);
      el.addEventListener('seeking', onSeeking);
      el.addEventListener('error', onError);
      active = handle;
    });

    return { playing: `${start.toFixed(1)}s-${end.toFixed(1)}s`, done };
  }

  return tool({
    name: 'play_video',
    description:
      'Plays one or more clips of the squat set so the user can see the moment being discussed; segments play in order, so pass two to compare reps. ' +
      "Returns as soon as the first clip starts — the result's previous_playback reports what actually played during the PREVIOUS call, including clips the user paused or skipped.",
    input: zodInput(
      z.object({
        segments: z
          .array(
            z.object({
              t_start: z.number().min(0).finite().describe('segment start time in seconds'),
              t_end: z.number().min(0).finite().describe('segment end time in seconds'),
              label: z.string().optional().describe("short name for this segment, e.g. 'rep 5'"),
              repeat: z.number().optional().describe('play this segment this many times back to back (1-3, default 1) — use for "watch it again" moments'),
            }),
          )
          // No .min/.max here: they compile to minItems/maxItems, which the
          // restricted tool-schema dialect rejects at session start. Bounds
          // are enforced in the handler instead.
          .describe('1-4 segments, played in order'),
      }),
    ),
    // Serialized: overlapping calls would seek/play the same element out from
    // under each other (one call's 'seeked' wait racing another's currentTime write).
    handler: ({ segments: requestedSegments }) => {
      // Bounded repeats expand into plain serial plays through the same queue —
      // an unbounded loop param was rejected in review because nothing but the
      // next tool call could stop it. Total plays capped at 8.
      const segments = requestedSegments.slice(0, 4).flatMap((seg) => {
        const times = Math.max(1, Math.min(3, Math.round(seg.repeat ?? 1)));
        return Array.from({ length: times }, (_, r) => ({
          ...seg,
          label: times > 1 ? `${seg.label ?? 'clip'} (${r + 1}/${times})` : seg.label,
        }));
      }).slice(0, 8);
      const gen = ++generation;
      active?.finish('interrupted');
      const previous_playback = ledger.splice(0);
      if (segments.length === 0) {
        // Empty segments = a status query: report what actually played without
        // starting playback. Lets the model answer "did you see it?" with
        // evidence instead of asserting.
        const query: PlayVideoResult = { ok: true, reason: 'status query — nothing played', previous_playback };
        return Promise.resolve(query);
      }
      let started!: (result: PlayVideoResult) => void;
      const result = new Promise<PlayVideoResult>((resolve) => {
        started = resolve;
      });

      const run = busy.then(async () => {
        const el = videoRef.current;
        if (!el) {
          started({ ok: false, reason: 'video element not mounted', previous_playback });
          return;
        }
        for (const [i, seg] of segments.entries()) {
          if (gen !== generation) {
            if (i === 0) started({ ok: false, reason: 'superseded by a newer play_video call', previous_playback });
            return;
          }
          let done: Promise<PlaybackEntry>;
          try {
            const begun = await beginSegment(el, seg);
            done = begun.done;
            if (i === 0) {
              started({ ok: true, playing: begun.playing, queued: segments.length - 1, previous_playback });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            record({
              label: seg.label,
              requested: [seg.t_start, seg.t_end],
              started_at_ms: Date.now(),
              outcome: 'error',
              actually_played: [round2(el.currentTime), round2(el.currentTime)],
              error: message,
            });
            if (i === 0) started({ ok: false, error: message, previous_playback });
            return;
          }
          const entry = await done;
          if (entry.outcome !== 'completed') return;
          if (i < segments.length - 1) await new Promise((r) => setTimeout(r, SEGMENT_GAP_MS));
        }
      });
      busy = run.catch(() => {});
      return result;
    },
  });
}

type ProcessVideoResponse = {
  jobId: string;
  sceneState: SceneState;
  overlayVideoUrl: string;
  rawVideoUrl: string;
  coaching: Coaching | null;
  coachingError: string | null;
};

const STAGES = [
  'Reading the video',
  'Tracking movement',
  'Reviewing your form',
  'Writing up notes',
];

function UploadStep({ onProcessed }: { onProcessed: (r: ProcessVideoResponse) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Stage timings are illustrative, not measured — the backend is one request
  // with no progress events to subscribe to. Total runtime varies a lot (clip
  // length, then Gemini), so the last stage holds and shows elapsed time
  // rather than completing early and looking frozen.
  useEffect(() => {
    if (!busy) return;
    const marks = [0, 12000, 30000, 62000];
    const timers = marks.map((ms, i) => setTimeout(() => setStage(i), ms));
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => {
      timers.forEach(clearTimeout);
      clearInterval(tick);
    };
  }, [busy]);

  const submit = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setStage(0);
    try {
      const form = new FormData();
      form.append('video', file);
      const res = await fetch('/api/process-video', { method: 'POST', body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Upload failed (${res.status})`);
      }
      onProcessed(await res.json());
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [file, onProcessed]);

  const pick = (f: File | undefined) => f && setFile(f);

  return (
    <>
      <div
        className={`dropzone${dragOver ? ' over' : ''}${file ? ' has-file' : ''}`}
        onClick={() => !busy && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (!busy && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => { e.preventDefault(); if (!busy) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!busy) pick(e.dataTransfer.files?.[0]);
        }}
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-label="Choose a video"
      >
        <div className="dz-icon">{file ? '🎬' : '⬆'}</div>
        {file ? (
          <>
            <p className="dz-title dz-file">{file.name}</p>
            <p className="dz-sub">Click to choose a different one</p>
          </>
        ) : (
          <>
            <p className="dz-title">Drop a video of your set</p>
            <p className="dz-sub">or click to browse</p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => pick(e.target.files?.[0])}
        />
      </div>

      {!busy && (
        <button className="btn btn-primary" onClick={submit} disabled={!file}>
          Analyze my form
        </button>
      )}

      {busy && (
        <div className="progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${Math.min(88, ((stage + 1) / STAGES.length) * 88)}%` }} />
          </div>
          <div className="stages">
            {STAGES.map((label, i) => (
              <div key={label} className={`stage${i === stage ? ' active' : i < stage ? ' done' : ''}`}>
                <span className="stage-dot" />
                {label}
              </div>
            ))}
          </div>
          <p className="hint">
            {elapsed}s elapsed{elapsed > 100 ? ' — longer clips take a few minutes' : ''}
          </p>
        </div>
      )}

      {error && <div className="err">{error}</div>}
      {!busy && !error && (
        <p className="hint">Works best on one continuous take with your whole body in frame.</p>
      )}
    </>
  );
}

function Findings({ coaching }: { coaching: Coaching }) {
  const sorted = [...coaching.findings].sort((a, b) => a.priority - b.priority);
  return (
    <div className="findings">
      {sorted.map((f, i) => (
        <div key={i} className={`finding p${Math.min(f.priority, 3)}`}>
          <div className="finding-head">
            <span className="finding-title">{f.title}</span>
            <span className={`tag ${f.source === 'measured' ? 'measured' : 'seen'}`}>
              {f.source === 'measured' ? 'measured' : f.source === 'both' ? 'measured + seen' : 'seen'}
            </span>
            {f.rep_ids.length > 0 && (
              <span className="tag">rep {f.rep_ids.join(', ')}</span>
            )}
          </div>
          <p className="finding-detail">{f.detail}</p>
        </div>
      ))}
    </div>
  );
}

function SessionView({
  videoRef,
  videoUrl,
  onReset,
  onEnded,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoUrl: string;
  onReset: () => void;
  onEnded: () => void;
}) {
  const session = useRealtimeSessionContext();
  const transport = useTransportState();
  const transcript = useTranscript();
  const scrollRef = useRef<HTMLDivElement>(null);

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
          {live ? 'Listening' : bad ? 'Not connected' : transport}
        </span>
        <MicToggle />
        <button
          className="btn btn-ghost"
          onClick={() => {
            void session?.end();
            onEnded();
          }}
        >
          End session
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            void session?.end();
            onReset();
          }}
        >
          New video
        </button>
      </div>

      <RealtimeAudio />

      <div className="session-grid">
        <div className="stage-col">
          <video ref={videoRef} src={videoUrl} controls preload="auto" playsInline />
        </div>

        <div className="chat-col">
          <p className="chat-head">Conversation</p>
          <div className="transcript scroll" ref={scrollRef}>
            {transcript.length === 0 ? (
              <p className="empty">Say hello, or ask what you should work on.</p>
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
  const [connecting, setConnecting] = useState(false);
  const [scene, setScene] = useState<SceneState | null>(null);
  const [coaching, setCoaching] = useState<Coaching | null>(null);
  const [coachingError, setCoachingError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState(API_KEY_DEFAULT);
  const [baseUrl, setBaseUrl] = useState(BASE_URL_DEFAULT);
  const [startError, setStartError] = useState<string | null>(null);
  const [session, setSession] = useState<RealtimeSession | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleProcessed = useCallback((r: ProcessVideoResponse) => {
    setScene(r.sceneState);
    setCoaching(r.coaching ?? null);
    setCoachingError(r.coachingError ?? null);
    setVideoUrl(r.overlayVideoUrl);
  }, []);

  // Keep the analysis; just drop the dead session so the start button returns.
  const handleEnded = useCallback(() => {
    setSession(null);
    setConnecting(false);
  }, []);

  const handleReset = useCallback(() => {
    setSession(null);
    setScene(null);
    setCoaching(null);
    setCoachingError(null);
    setVideoUrl(null);
    setStartError(null);
  }, []);

  const handleStart = useCallback(async () => {
    if (!scene || !apiKey) return;
    setConnecting(true);
    setStartError(null);
    setCosmoBaseUrl(baseUrl);
    const opts: RealtimeClientOptions = { apiKey };
    const client = new RealtimeClient(opts);
    try {
      const started = await client
        .agent({
          instructions: buildInstructions(scene, coaching),
          tools: [makePlayVideoTool(videoRef)],
          greeting: coaching?.session_summary
            ? "Hey — I went through your set. Want to walk through it?"
            : "Hey — I looked at your set. Want me to walk you through what I found?",
        })
        .start();
      setSession(started);
    } catch (err) {
      setStartError(
        err instanceof Error && /401|invalid/i.test(err.message)
          ? 'That key was rejected. Check it matches the server below — a key from one environment will not work against another.'
          : err instanceof Error ? err.message : String(err),
      );
    } finally {
      setConnecting(false);
    }
  }, [scene, coaching, apiKey, baseUrl]);

  return (
    <div className={`shell${session ? " wide" : ""}`}>
      <header className="masthead">
        <p className="eyebrow">Cosmo Realtime</p>
        <h1>Squat coach</h1>
        <p className="lede">
          Upload a set. Get a coach who has already watched it, and can show you the moment
          it's talking about.
        </p>
      </header>

      {!scene || !videoUrl ? (
        <UploadStep onProcessed={handleProcessed} />
      ) : session == null ? (
        <>
          {coaching && <Findings coaching={coaching} />}
          {coachingError && (
            <p className="hint">
              Detailed review unavailable — the coach will work from movement data alone.
            </p>
          )}

          <button className="btn btn-primary" onClick={handleStart} disabled={connecting || !apiKey}>
            {connecting ? 'Connecting…' : apiKey ? 'Talk to your coach' : 'Add a key below to start'}
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
      ) : (
        <RealtimeProvider session={session} maxTranscriptLength={50}>
          <SessionView
            videoRef={videoRef}
            videoUrl={videoUrl}
            onReset={handleReset}
            onEnded={handleEnded}
          />
        </RealtimeProvider>
      )}
    </div>
  );
}
