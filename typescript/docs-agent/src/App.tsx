'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CosmoRealtimeProvider,
  RealtimeClient,
  type RealtimeClientOptions,
} from 'cosmo-ai';
import type { PDFDocumentProxy } from 'pdfjs-dist';

import { buildInstructions, greetingFor } from './agent/instructions';
import { makeDocumentTools, type StateRef } from './agent/tools';
import { scrollNote, selectionNote } from './context_notes';
import type { DocSection, DocumentSource } from './document';
import { HtmlViewer } from './html/HtmlViewer';
import { AgentPanel } from './panel/AgentPanel';
import { loadPdf } from './pdf/load';
import { PdfViewer } from './pdf/PdfViewer';

// Prefill from a gitignored .env for local dev convenience (see .env.example).
// Never hardcode a key here — this file is committed.
const API_KEY_DEFAULT = import.meta.env.VITE_COSMO_API_KEY ?? '';

// Which Cosmo backend the dev server proxies to. Display only — the value is
// read by vite.config.ts at dev-server start, not used to make requests here.
const SESSION_TARGET = import.meta.env.VITE_COSMO_BASE_URL ?? 'https://platform.askcosmo.ai';

// A build with no key inlined is one served by a proxy that holds the key
// itself, so what the box collects is an access password, not a credential.
const HOSTED = API_KEY_DEFAULT === '';

type FetchUrlResponse = {
  url: string;
  title: string;
  sections: DocSection[];
  blocks: string[];
};

type OpenDoc =
  | { doc: DocumentSource; kind: 'pdf'; pdf: PDFDocumentProxy }
  | { doc: DocumentSource; kind: 'html'; blocks: string[] };

/** The password is checked here rather than on first use, so a wrong one is
 *  reported at the point it was typed instead of surfacing later as a failure
 *  to open a document. */
function UnlockStep({ onUnlock }: { onUnlock: (password: string) => void }) {
  const [password, setPassword] = useState('');
  const [checking, setChecking] = useState(false);
  const [rejected, setRejected] = useState(false);

  const submit = async () => {
    if (!password || checking) return;
    setChecking(true);
    setRejected(false);
    try {
      const res = await fetch('/auth/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${password}` },
      });
      if (res.ok) onUnlock(password);
      else setRejected(true);
    } catch (err) {
      console.error('Access check failed', err);
      setRejected(true);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="open-step">
      <div className="unlock">
        <strong>This deployment is password-protected</strong>
        <span>Its Cosmo key stays server-side; the password unlocks the proxy that attaches it.</span>
        <div className="url-row">
          <input
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            placeholder="Access password"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
          <button className="btn btn-primary" onClick={() => void submit()} disabled={!password || checking}>
            {checking ? 'Checking…' : 'Unlock'}
          </button>
        </div>
        {rejected && <p className="unlock-error">That password was not accepted.</p>}
      </div>
    </div>
  );
}

function OpenStep({
  onOpen,
  onError,
  credential,
}: {
  onOpen: (open: OpenDoc) => void;
  onError: (message: string | null) => void;
  credential: string;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<'pdf' | 'url' | null>(null);

  const openPdf = async (file: File) => {
    setBusy('pdf');
    onError(null);
    try {
      const { pdf, doc } = await loadPdf(file);
      onOpen({ kind: 'pdf', pdf, doc });
    } catch (err) {
      onError(`Could not read that PDF: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const openUrl = async () => {
    if (!url.trim()) return;
    setBusy('url');
    onError(null);
    try {
      const res = await fetch('/local/fetch-url', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        body: JSON.stringify({ url }),
      });
      const body = (await res.json()) as FetchUrlResponse | { error: string };
      if (!res.ok || 'error' in body) {
        throw new Error('error' in body ? body.error : `HTTP ${res.status}`);
      }
      onOpen({
        kind: 'html',
        blocks: body.blocks,
        doc: { kind: 'html', title: body.title, origin: body.url, sections: body.sections },
      });
    } catch (err) {
      onError(
        err instanceof TypeError
          ? 'Could not reach the local URL backend — is `npm run server` running?'
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="open-step">
      <label className={`drop${busy === 'pdf' ? ' busy' : ''}`}>
        <input
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void openPdf(file);
            e.target.value = '';
          }}
        />
        <strong>{busy === 'pdf' ? 'Reading…' : 'Choose a PDF'}</strong>
        <span>It stays in your browser — only the text you ask about reaches the agent.</span>
      </label>

      <div className="or">or</div>

      <div className="url-row">
        <input
          value={url}
          placeholder="https://example.com/article"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void openUrl();
          }}
        />
        <button className="btn btn-primary" onClick={() => void openUrl()} disabled={busy !== null || !url.trim()}>
          {busy === 'url' ? 'Fetching…' : 'Open link'}
        </button>
      </div>
    </div>
  );
}

export function App() {
  const [open, setOpen] = useState<OpenDoc | null>(null);
  const [sectionIndex, setSectionIndex] = useState(0);
  const [apiKey, setApiKey] = useState(API_KEY_DEFAULT);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<RealtimeClient | null>(null);

  // The tools read through this ref, so scrolling and selecting never require
  // restarting the session.
  const stateRef = useRef<StateRef>({ current: null });
  const selectionRef = useRef<string | null>(null);
  const clientRef = useRef<RealtimeClient | null>(null);

  useEffect(() => {
    stateRef.current.current = open
      ? { doc: open.doc, view: { sectionIndex, selection: selectionRef.current } }
      : null;
  }, [open, sectionIndex]);

  // Silent context note when the reader scrolls to a different section. The
  // first section is skipped: the greeting already covers where we start.
  const lastNotified = useRef<number>(0);
  useEffect(() => {
    const live = clientRef.current;
    if (!live || !open || sectionIndex === lastNotified.current) return;
    lastNotified.current = sectionIndex;
    const section = open.doc.sections[sectionIndex];
    if (!section) return;
    void live
      .sendContext(scrollNote(section.label, sectionIndex, open.doc.sections.length))
      .catch(() => {
        // Not ready yet, or already ended — the tools still report the true
        // position, so a dropped note costs nothing.
      });
  }, [sectionIndex, open]);

  // Selection is read on mouse/key release rather than every selectionchange,
  // which fires continuously while dragging.
  useEffect(() => {
    const capture = () => {
      const text = window.getSelection()?.toString().trim() ?? '';
      const next = text.length > 1 ? text : null;
      if (next === selectionRef.current) return;
      selectionRef.current = next;
      const state = stateRef.current.current;
      if (state) state.view.selection = next;
      if (next && clientRef.current) {
        void clientRef.current.sendContext(selectionNote(next)).catch(() => {});
      }
    };
    document.addEventListener('mouseup', capture);
    document.addEventListener('keyup', capture);
    return () => {
      document.removeEventListener('mouseup', capture);
      document.removeEventListener('keyup', capture);
    };
  }, []);

  const handleConnect = useCallback(async () => {
    if (!open || !apiKey) return;
    setConnecting(true);
    setError(null);
    // Our own origin, not the Cosmo one: the dev server proxies /api through.
    // A browser calling the backend directly is refused by its CORS policy,
    // which surfaces as a bare "Failed to fetch" (see vite.config.ts). An
    // apiKey client requires a baseUrl — only a minted token may omit it.
    const opts: RealtimeClientOptions = { apiKey, baseUrl: window.location.origin };
    try {
      const c = new RealtimeClient(opts);
      await c
        .agent({
          instructions: buildInstructions(open.doc),
          greeting: greetingFor(open.doc),
          tools: makeDocumentTools(stateRef.current),
        })
        .start();
      clientRef.current = c;
      lastNotified.current = sectionIndex;
      setClient(c);
    } catch (err) {
      setError(
        err instanceof Error && /401|invalid/i.test(err.message)
          ? `That key was rejected by ${SESSION_TARGET} — a key from one environment will not work against another.`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setConnecting(false);
    }
  }, [open, apiKey, sectionIndex]);

  const handleEnd = useCallback(() => {
    clientRef.current = null;
    setClient(null);
  }, []);

  // A new document means a new session: SDK clients are single-attempt, so
  // the old one is closed and dropped rather than reused.
  const handleClose = useCallback(() => {
    void clientRef.current?.disconnect();
    clientRef.current = null;
    setClient(null);
    setOpen(null);
    setSectionIndex(0);
    lastNotified.current = 0;
    selectionRef.current = null;
    setError(null);
  }, []);

  const current = open?.doc.sections[sectionIndex];

  return (
    <div className={`shell${open ? ' reading' : ''}`}>
      <header className="masthead">
        <div>
          <p className="eyebrow">Cosmo Realtime</p>
          <h1>{open ? open.doc.title : 'Docs agent'}</h1>
          {open ? (
            <p className="sub">
              {current?.label ?? '—'} · {open.doc.sections.length}{' '}
              {open.doc.kind === 'pdf' ? 'pages' : 'sections'}
            </p>
          ) : (
            <p className="lede">
              Open a PDF or a link, read it, and ask the agent about whatever you're looking at.
            </p>
          )}
        </div>
        {open && (
          <button className="btn btn-ghost" onClick={handleClose}>
            Open something else
          </button>
        )}
      </header>

      {error && <div className="err">{error}</div>}

      {HOSTED && !apiKey ? (
        <UnlockStep onUnlock={setApiKey} />
      ) : !open ? (
        <OpenStep onOpen={setOpen} onError={setError} credential={apiKey} />
      ) : (
        <div className="reader">
          {open.kind === 'pdf' ? (
            <PdfViewer pdf={open.pdf} onSectionChange={setSectionIndex} />
          ) : (
            <HtmlViewer blocks={open.blocks} onSectionChange={setSectionIndex} />
          )}

          {client ? (
            <CosmoRealtimeProvider client={client} maxTranscriptLength={80}>
              <AgentPanel onEnd={handleEnd} />
            </CosmoRealtimeProvider>
          ) : (
            <aside className="panel">
              <div className="panel-intro">
                <h2>Cosmo</h2>
                <p>Start a session and ask about the page you're on, out loud.</p>
                <button className="btn btn-primary" onClick={() => void handleConnect()} disabled={connecting || !apiKey}>
                  {connecting
                    ? 'Connecting…'
                    : apiKey
                      ? 'Start talking'
                      : `Add ${HOSTED ? 'the password' : 'a key'} below to start`}
                </button>
              </div>

              <details className="settings" open={!apiKey}>
                <summary>Connection</summary>
                <div className="field">
                  <label htmlFor="k">{HOSTED ? 'Access password' : 'API key'}</label>
                  <input
                    id="k"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={HOSTED ? '' : 'cosmo_…'}
                  />
                </div>
                <p className="field-note">
                  {HOSTED ? (
                    <>
                      This deployment keeps its Cosmo key server-side; the password unlocks the proxy that
                      attaches it.
                    </>
                  ) : (
                    <>
                      Proxied to <code>{SESSION_TARGET}</code> by the dev server. Change it with
                      <code> VITE_COSMO_BASE_URL</code> in <code>.env</code> and restart.
                    </>
                  )}
                </p>
              </details>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
