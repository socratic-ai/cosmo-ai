import { useCallback, useEffect, useState } from 'react';

import {
  CosmoRealtimeProvider,
  SessionBusyError,
  SessionEntitlementError,
  SessionStartError,
  useRealtimeSession,
  type RealtimeSession,
} from 'cosmo-ai';

import { sousChefAgent } from './agent/agent';
import { useCamera } from './camera/use_camera';
import { cookStore } from './state/cook';
import { ChefFace } from './ui/Avatar';
import { LiveView } from './ui/LiveView';

// Read from a gitignored .env (see .env.example). Never hardcode a key here —
// this file is committed, and Vite inlines VITE_* values into the bundle, so a
// build made with a key in .env is a build that publishes it. Anything you
// deploy should mint short-lived end-user tokens instead; the token-server
// example alongside this one is that server.
const API_KEY = import.meta.env.VITE_COSMO_API_KEY ?? '';

// Both providers run this agent unchanged. Set VITE_REALTIME_PROVIDER=gemini
// in .env to cook on Gemini instead.
const PROVIDER = import.meta.env.VITE_REALTIME_PROVIDER === 'gemini' ? 'gemini' : 'openai';

const NO_KEY_NOTE =
  'Add a Cosmo API key to .env as VITE_COSMO_API_KEY, then restart the dev server.';

const VOICE_ONLY_NOTE =
  'No camera — I can still find recipes, walk the steps, and run timers; I just cannot look at the pan.';

/** Session-start rejections are typed, so the start screen can say what went
 *  wrong instead of showing a status line. This agent asks for the OpenAI
 *  provider, which is the rejection worth naming precisely. */
function describeStartError(error: Error): string {
  if (error instanceof SessionBusyError) {
    return 'The kitchen line is busy — try again in a minute.';
  }
  if (error instanceof SessionEntitlementError) {
    return `This workspace's plan does not cover the session: ${error.message}`;
  }
  if (error instanceof SessionStartError && error.detail?.code === 'model_unavailable') {
    return 'This workspace cannot run the OpenAI realtime provider yet — see the README.';
  }
  return error.message;
}

/** Hand a restarted session the cook already in progress. Card state is local,
 *  so it survives a dropped connection even though the agent's memory does
 *  not — this is what stops it starting the recipe over. */
async function reorient(session: RealtimeSession): Promise<void> {
  const cook = cookStore.getState();
  if (cook.recipe === null) return;
  const timers =
    cook.timers
      .map((timer) => `"${timer.label}" ${String(Math.round(timer.remainingSeconds))}s left`)
      .join(', ') || 'none';
  await session.sendContext(
    `A cook is already in progress: "${cook.recipe.title}", on step ${String(cook.stepIndex)} ` +
      `("${cook.recipe.steps[cook.stepIndex]?.text ?? ''}"). Running timers: ${timers}. ` +
      'Pick up from there; do not start the recipe over.',
  );
}

export function App() {
  const camera = useCamera();
  const [cameraNote, setCameraNote] = useState<string | null>(null);

  // The hook owns the session lifecycle: a single-use client per run, the mic
  // released before the next start, every exit path funnelled into one
  // teardown. The camera and the card stay this app's job.
  const { phase, client, start, end, error, warning, endedReason, lastEnd } = useRealtimeSession({
    makeAgent: (live) => live.agent(sousChefAgent(cookStore, PROVIDER)),
    clientOptions: { apiKey: API_KEY },
  });

  // Whatever ended the session — End button, hangup tool, network loss — the
  // camera goes with it. The card does not: timers keep counting down, and
  // one tap reconnects into the same cook.
  const stopCamera = camera.stop;
  useEffect(() => {
    if (phase === 'ending') void stopCamera();
  }, [phase, stopCamera]);

  // A cook the user ended is finished, so the next start begins with an empty
  // card. Any other ending — a dropped connection, a server hangup — is an
  // interruption, and the card is what makes reconnecting into it possible.
  useEffect(() => {
    if (lastEnd === null) return;
    if (lastEnd.reason === 'client_ended' || lastEnd.reason === 'client_closed') {
      cookStore.reset();
    }
  }, [lastEnd]);

  // Timers run off wall-clock deltas rather than a tick count, so a phone that
  // throttles background timers still shows the right time left. The clock is
  // not gated on the session either: a pan does not stop cooking because the
  // connection dropped, and the remaining time `reorient` hands the next
  // session is only true if it kept running. `tick` is a no-op with no timers.
  useEffect(() => {
    let last = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      cookStore.tick((now - last) / 1000);
      last = now;
    }, 500);
    return () => {
      clearInterval(interval);
    };
  }, []);

  const startCooking = useCallback(async () => {
    if (API_KEY === '' || phase !== 'idle') return;
    setCameraNote(null);

    // Unlike a camera app, this one is still useful blind: a denied camera
    // costs the doneness checks and nothing else.
    let cameraLive = false;
    try {
      await camera.start();
      cameraLive = true;
    } catch (err) {
      console.error('[sous-chef] camera unavailable', err);
      setCameraNote(VOICE_ONLY_NOTE);
    }

    const result = await start();
    if (!result.ok) {
      await camera.stop();
      return;
    }
    const session = result.session;

    // ``start()`` resolves while the transport is still connecting, and video
    // can only publish on a live session.
    try {
      await session.waitUntilReady();
    } catch {
      return; // The session ended before it got going; teardown handles it.
    }

    if (cameraLive) {
      try {
        await camera.publish(session);
      } catch (err) {
        console.error('[sous-chef] camera publish failed', err);
        setCameraNote(VOICE_ONLY_NOTE);
      }
    }

    try {
      await reorient(session);
    } catch (err) {
      console.error('[sous-chef] could not describe the cook in progress', err);
    }
  }, [camera, phase, start]);

  if (phase === 'live') {
    return (
      <CosmoRealtimeProvider client={client}>
        <LiveView
          stream={camera.stream}
          note={warning ?? cameraNote}
          onEnd={() => void end()}
        />
      </CosmoRealtimeProvider>
    );
  }

  const startError = error === null ? null : describeStartError(error);

  return (
    <main className="app start">
      <div className="start-face">
        <ChefFace />
      </div>
      <p className="eyebrow">Cosmo Realtime</p>
      <h1>Sous-Chef</h1>
      <p className="lede">
        Prop your phone against the backsplash, name a dish, and cook with your
        hands free. It finds the recipe, keeps the steps in time with you, runs
        the timers, and looks at the pan when it matters.
      </p>
      {API_KEY === '' && <p className="err">{NO_KEY_NOTE}</p>}
      {startError !== null && <p className="err">{startError}</p>}
      {cameraNote !== null && <p className="note">{cameraNote}</p>}
      {endedReason !== null && <p className="note">{`Session ended (${endedReason}).`}</p>}
      <button
        className="btn primary"
        onClick={() => void startCooking()}
        disabled={API_KEY === '' || phase !== 'idle'}
      >
        {phase === 'idle' ? 'Start cooking' : 'Connecting…'}
      </button>
    </main>
  );
}
