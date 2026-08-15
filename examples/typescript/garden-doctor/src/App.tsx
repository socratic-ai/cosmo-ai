import { useCallback, useEffect, useState } from 'react';

import { CosmoRealtimeProvider, SessionBusyError, TokenSource, useRealtimeSession } from 'cosmo-ai';

import { gardenDoctorAgent } from './agent';
import { useCamera } from './camera/use_camera';
import { LiveView } from './LiveView';

// Prefill from a gitignored .env for local dev convenience (see .env.example).
// Never hardcode a key here — this file is committed.
const API_KEY_DEFAULT = import.meta.env.VITE_COSMO_API_KEY ?? '';

// A build with no key inlined is a deployed one: its key stays server-side in
// the /token Function, so what the box collects is an access password the
// page trades for short-lived end-user tokens.
const HOSTED = API_KEY_DEFAULT === '';

// Same-origin by default. A build that doesn't ship next to its Function —
// e.g. bundled into a native shell — names the deployed endpoint absolutely.
const TOKEN_ENDPOINT = import.meta.env.VITE_TOKEN_ENDPOINT || '/token';

/** Stable per-browser identity for hosted mode — Cosmo meters and scopes per
 *  this id, so each visitor gets their own auto-provisioned project. */
function externalUserId(): string {
  const KEY = 'garden-doctor-user';
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

export function App() {
  const camera = useCamera();
  const [credential, setCredential] = useState(API_KEY_DEFAULT);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraWarning, setCameraWarning] = useState<string | null>(null);

  // The hook owns the session lifecycle: a single-use client per run, the
  // mic released before the next start, every exit path funnelled into one
  // teardown. The camera stays this app's job.
  const { phase, client, start, end, error, warning, endedReason } = useRealtimeSession({
    makeAgent: (c) => c.agent(gardenDoctorAgent()),
    // Hosted: the box held a password, traded for short-lived end-user tokens
    // by this deployment's /token Function — TokenSource keeps one fresh.
    // Local: the box held an API key, sent to the backend directly.
    clientOptions: HOSTED
      ? { token: TokenSource.endpoint(TOKEN_ENDPOINT, { headers: () => mintHeaders(credential) }) }
      : { apiKey: credential },
  });

  // Whatever ended the session — End button, hangup tool, network loss —
  // the camera goes with it.
  const stopCamera = camera.stop;
  useEffect(() => {
    if (phase === 'ending') void stopCamera();
  }, [phase, stopCamera]);

  const startVisit = useCallback(async () => {
    if (!credential || phase !== 'idle') return;
    setCameraError(null);
    setCameraWarning(null);

    try {
      await camera.start();
    } catch (err) {
      console.error('[garden-doctor] camera denied', err);
      setCameraError('The doctor needs the camera — allow access and try again.');
      return;
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
    try {
      await camera.publish(session);
    } catch (err) {
      console.error('[garden-doctor] camera publish failed', err);
      setCameraWarning('The camera is not streaming — the doctor cannot see.');
    }
  }, [camera, credential, phase, start]);

  if (phase === 'live') {
    return (
      <CosmoRealtimeProvider client={client}>
        <LiveView
          stream={camera.stream}
          mirrored={camera.facingMode === 'user'}
          canFlip={camera.canFlip}
          onFlip={() => void camera.flip()}
          onEnd={() => void end()}
          warning={warning ?? cameraWarning}
        />
      </CosmoRealtimeProvider>
    );
  }

  // Refresh-abandoned sessions are reclaimed after a short window; a fresh
  // start can 429 until then. Say so instead of the raw error.
  const startError =
    error === null
      ? null
      : error instanceof SessionBusyError
        ? 'The line is busy — try again in a minute.'
        : error.message;

  return (
    <div className="start">
      <p className="eyebrow">Cosmo Realtime</p>
      <h1>Garden Doctor</h1>
      <p className="lede">
        A live house call for your plants: point the camera, ask out loud, and
        watch the doctor mark what it sees.
      </p>
      {HOSTED && (
        <input
          type="password"
          value={credential}
          placeholder="Access password"
          autoComplete="current-password"
          onChange={(event) => setCredential(event.target.value)}
        />
      )}
      {(cameraError ?? startError) !== null && <p className="err">{cameraError ?? startError}</p>}
      {endedReason !== null && <p className="note">{`Call ended (${endedReason}).`}</p>}
      <button
        className="btn primary"
        onClick={() => void startVisit()}
        disabled={!credential || phase !== 'idle'}
      >
        {phase === 'starting' ? 'Connecting…' : 'Start the visit'}
      </button>
      {HOSTED && (
        <p className="fine">
          This deployment keeps its Cosmo key server-side; the password lets
          the page mint its own short-lived tokens.
        </p>
      )}
    </div>
  );
}
