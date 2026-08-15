/**
 * Zero-argument credential resolution.
 *
 * A client constructed with no credential and no ``getAuthHeaders`` resolves
 * one from, in order: ``COSMO_API_KEY`` in the environment, then the ``cosmo
 * login`` credentials file (``COSMO_CREDENTIALS_FILE`` or
 * ``~/.cosmo/credentials``) at the profile named by ``COSMO_PROFILE``. The
 * profile's ``base_url`` travels with the key — a stored credential is only
 * valid against the backend it was issued for — and a ``COSMO_BASE_URL``
 * naming a different backend is refused rather than obeyed.
 *
 * Node-only: a browser has no environment and no credentials file, so
 * :func:`resolveCredentialFromRuntime` short-circuits to ``null`` there and
 * the client keeps its credential-less (cookie / host-app) behavior.
 *
 * The file is TOML written exclusively by the Cosmo CLI. Rather than take a
 * TOML dependency (this package has zero runtime dependencies), the parser
 * accepts the strict subset the CLI's writer emits — flat tables, basic
 * strings, integers, booleans — and fails closed on anything else.
 *
 * Resolution semantics are pinned by the cross-SDK conformance vectors at
 * ``credentials-resolution-vectors.json``.
 */

import { CredentialError } from './auth';

export type CredentialsErrorCode =
  | 'no_credential'
  | 'profile_not_found'
  | 'file_invalid'
  | 'expired'
  | 'base_url_mismatch';

export type ResolvedCredential = {
  apiKey: string;
  /** The origin to reach the backend at, or ``null`` for the SDK's normal
   *  default. A profile's stored ``base_url`` for a file credential (a
   *  conflicting ``COSMO_BASE_URL`` throws instead of overriding);
   *  ``COSMO_BASE_URL`` itself for an environment credential. */
  baseUrl: string | null;
  source: 'env' | 'file';
};

const CREDENTIALS_VERSION = 1;
const DEFAULT_PROFILE = 'default';
const REQUIRED_FIELDS = ['slug', 'api_key', 'api_key_id', 'base_url', 'expires_at'] as const;

type EnvMap = Record<string, string | undefined>;

/** The pure chain: environment map + file text in, credential out.
 *
 *  Split from :func:`resolveCredentialFromRuntime` so the conformance
 *  vectors can drive it without touching the process environment or
 *  filesystem. Throws :class:`CredentialError` with a vector
 *  ``code`` on every failure, including ``no_credential``.
 */
export function resolveCredential(
  env: EnvMap,
  fileText: string | null,
  pathDisplay: string,
  nowMs: number,
): ResolvedCredential {
  const envBase = env.COSMO_BASE_URL?.trim() || null;

  const envKey = env.COSMO_API_KEY?.trim();
  if (envKey) return { apiKey: envKey, baseUrl: envBase, source: 'env' };

  const profile = env.COSMO_PROFILE || DEFAULT_PROFILE;
  if (fileText === null) {
    throw new CredentialError(
      'No Cosmo credential found. Pass apiKey or token, set COSMO_API_KEY, ' +
        `or sign in with: cosmo login (credentials file checked: ${pathDisplay})`,
      'no_credential',
    );
  }

  const entry = loadProfile(fileText, profile, pathDisplay);
  rejectExpired(entry.expires_at, profile, pathDisplay, nowMs);
  rejectBaseUrlConflict(envBase, entry.base_url, profile, pathDisplay);
  return { apiKey: entry.api_key, baseUrl: entry.base_url, source: 'file' };
}

/** Run the chain against the real environment and filesystem (Node only).
 *
 *  Returns ``null`` when there is nothing to resolve — off Node, or with no
 *  env var and no credentials file — so the client can keep its
 *  credential-less mode. An unusable file (bad format, missing fields,
 *  expired key) still throws: the user set up file auth and it failed.
 */
export async function resolveCredentialFromRuntime(): Promise<ResolvedCredential | null> {
  if (typeof process === 'undefined' || !process.versions?.node) return null;
  // An Electron renderer (or a bundler-shimmed browser context) has a window;
  // a credentials file on disk is a server/CLI concern, never a page's.
  if (typeof window !== 'undefined') return null;

  const env = process.env as EnvMap;
  try {
    if (env.COSMO_API_KEY?.trim()) {
      return resolveCredential(env, null, '(not read)', Date.now());
    }
    const { path, text } = await readCredentialsFile(env);
    return resolveCredential(env, text, path, Date.now());
  } catch (err) {
    if (err instanceof CredentialError && err.code === 'no_credential') {
      return null;
    }
    throw err;
  }
}

async function readCredentialsFile(
  env: EnvMap,
): Promise<{ path: string; text: string | null }> {
  // Variable specifiers so browser bundlers don't chase Node builtins into
  // a browser build; this function only runs behind the Node guard above.
  const fsSpecifier = 'node:fs/promises';
  const osSpecifier = 'node:os';
  const fs = (await import(/* @vite-ignore */ fsSpecifier)) as typeof import('node:fs/promises');
  const os = (await import(/* @vite-ignore */ osSpecifier)) as typeof import('node:os');
  const path = env.COSMO_CREDENTIALS_FILE || `${os.homedir()}/.cosmo/credentials`;
  try {
    return { path, text: await fs.readFile(path, 'utf8') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { path, text: null };
    const reason = err instanceof Error ? err.message : String(err);
    throw new CredentialError(
      `Cannot read ${path}: ${reason}. Fix its permissions, or point ` +
        'COSMO_CREDENTIALS_FILE elsewhere.',
      'file_invalid',
    );
  }
}

// ─── File reading ─────────────────────────────────────────────────────────

type ProfileEntry = Record<(typeof REQUIRED_FIELDS)[number], string>;

function loadProfile(
  fileText: string,
  profile: string,
  pathDisplay: string,
): ProfileEntry {
  const document = parseCredentialsToml(fileText, pathDisplay);
  rejectUnreadableVersion(document.version, pathDisplay);

  const entry = document.tables.get(profile);
  if (entry === undefined) {
    const present = [...document.tables.keys()].sort().join(', ');
    throw new CredentialError(
      `No '${profile}' credentials in ${pathDisplay}. ` +
        `Profiles present: ${present || '(none)'}. Run: cosmo login`,
      'profile_not_found',
    );
  }

  const values: Partial<ProfileEntry> = {};
  const missing: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    const value = entry.get(field);
    if (typeof value === 'string' && value !== '') values[field] = value;
    else missing.push(field);
  }
  if (missing.length > 0) {
    throw new CredentialError(
      `Profile '${profile}' in ${pathDisplay} is missing: ${missing.join(', ')}. ` +
        'Run: cosmo login',
      'file_invalid',
    );
  }
  return values as ProfileEntry;
}

function rejectUnreadableVersion(version: TomlValue | undefined, pathDisplay: string): void {
  if (version === undefined) {
    throw new CredentialError(
      `${pathDisplay} predates the versioned credentials format. ` +
        'Run: cosmo login (rewrites it, keeping a .bak copy)',
      'file_invalid',
    );
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new CredentialError(
      `${pathDisplay}: 'version' must be a positive integer, found ${String(version)}. ` +
        'Move it aside or delete it, then run: cosmo login',
      'file_invalid',
    );
  }
  if (version > CREDENTIALS_VERSION) {
    throw new CredentialError(
      `${pathDisplay} was written by a newer Cosmo CLI (format ${version}; this ` +
        `SDK understands ${CREDENTIALS_VERSION}). Upgrade the cosmo-ai package.`,
      'file_invalid',
    );
  }
}

/** A stored key is only valid where it was minted; a differing
 *  ``COSMO_BASE_URL`` would send it to a backend that never issued it and
 *  fail as an unexplained 401. Refuse with the remediation instead. */
function rejectBaseUrlConflict(
  envBase: string | null,
  storedBase: string,
  profile: string,
  pathDisplay: string,
): void {
  if (envBase === null || originKey(envBase) === originKey(storedBase)) return;
  throw new CredentialError(
    `COSMO_BASE_URL is ${envBase}, but the stored key for profile '${profile}' ` +
      `was issued by ${storedBase} (${pathDisplay}). Unset COSMO_BASE_URL, sign ` +
      `in against ${envBase} with \`cosmo login\`, or pass a key for that ` +
      'backend explicitly / via COSMO_API_KEY.',
    'base_url_mismatch',
  );
}

/** The effective origin — scheme, host, default-aware port — so
 *  ``https://x`` and ``https://x:443/`` compare equal. An unparseable value
 *  falls back to plain string comparison (fail closed). ``URL`` already
 *  lowercases the host and drops scheme-default ports. */
function originKey(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.hostname}:${url.port || defaultPort(url.protocol)}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

function defaultPort(protocol: string): string {
  return protocol === 'https:' ? '443' : protocol === 'http:' ? '80' : '';
}

function rejectExpired(
  expiresAt: string,
  profile: string,
  pathDisplay: string,
  nowMs: number,
): void {
  const expiryMs = parseRfc3339Ms(expiresAt);
  if (expiryMs === null) {
    throw new CredentialError(
      `Profile '${profile}' in ${pathDisplay} has an unreadable expires_at: ` +
        `'${expiresAt}'. Run: cosmo login`,
      'file_invalid',
    );
  }
  if (nowMs >= expiryMs) {
    throw new CredentialError(
      `The stored API key for profile '${profile}' expired at ${expiresAt} ` +
        `(${pathDisplay}). Run: cosmo login`,
      'expired',
    );
  }
}

function parseRfc3339Ms(value: string): number | null {
  // ``Date.parse`` reads a timezone-less timestamp as local time where the
  // other SDKs reject it; require an explicit offset so all three agree.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// ─── TOML subset parser ───────────────────────────────────────────────────

type TomlValue = string | number | boolean;
type ParsedDocument = {
  version: TomlValue | undefined;
  tables: Map<string, Map<string, TomlValue>>;
};

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function invalid(pathDisplay: string, lineNo: number, reason: string): never {
  throw new CredentialError(
    `${pathDisplay} is not a readable credentials file (line ${lineNo}: ${reason}). ` +
      'Move it aside or delete it, then run: cosmo login',
    'file_invalid',
  );
}

function parseCredentialsToml(text: string, pathDisplay: string): ParsedDocument {
  const topLevel = new Map<string, TomlValue>();
  const tables = new Map<string, Map<string, TomlValue>>();
  let current: Map<string, TomlValue> = topLevel;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;

    if (line.startsWith('[')) {
      const name = parseTableHeader(line, pathDisplay, lineNo);
      if (tables.has(name)) invalid(pathDisplay, lineNo, `duplicate table '${name}'`);
      current = new Map();
      tables.set(name, current);
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) invalid(pathDisplay, lineNo, 'expected `key = value`');
    const key = line.slice(0, eq).trim();
    if (!BARE_KEY.test(key)) invalid(pathDisplay, lineNo, `unsupported key '${key}'`);
    if (current.has(key)) invalid(pathDisplay, lineNo, `duplicate key '${key}'`);
    current.set(key, parseValue(line.slice(eq + 1).trim(), pathDisplay, lineNo));
  }

  return { version: topLevel.get('version'), tables };
}

function parseTableHeader(line: string, pathDisplay: string, lineNo: number): string {
  const inner = stripTrailingComment(line, pathDisplay, lineNo);
  if (!inner.endsWith(']')) invalid(pathDisplay, lineNo, 'unterminated table header');
  const name = inner.slice(1, -1).trim();
  if (BARE_KEY.test(name)) return name;
  if (name.startsWith('"')) {
    const { value, rest } = parseBasicString(name, pathDisplay, lineNo);
    if (rest.trim() !== '') invalid(pathDisplay, lineNo, 'unsupported table header');
    return value;
  }
  invalid(pathDisplay, lineNo, `unsupported table header '${name}'`);
}

function parseValue(raw: string, pathDisplay: string, lineNo: number): TomlValue {
  if (raw.startsWith('"')) {
    const { value, rest } = parseBasicString(raw, pathDisplay, lineNo);
    const trailing = rest.trim();
    if (trailing !== '' && !trailing.startsWith('#')) {
      invalid(pathDisplay, lineNo, 'unexpected text after string value');
    }
    return value;
  }
  const bare = stripTrailingComment(raw, pathDisplay, lineNo);
  if (bare === 'true') return true;
  if (bare === 'false') return false;
  if (/^[+-]?\d+$/.test(bare)) return Number.parseInt(bare, 10);
  return invalid(pathDisplay, lineNo, `unsupported value '${bare}'`);
}

/** A comment may follow a non-string value; a lone ``#`` inside one cannot
 *  occur in the subset (strings carry their own handling). */
function stripTrailingComment(raw: string, _pathDisplay: string, _lineNo: number): string {
  const hash = raw.indexOf('#');
  return (hash === -1 ? raw : raw.slice(0, hash)).trim();
}

const ESCAPES: Record<string, string> = {
  '\\': '\\',
  '"': '"',
  n: '\n',
  t: '\t',
  r: '\r',
  f: '\f',
  b: '\b',
};

function parseBasicString(
  raw: string,
  pathDisplay: string,
  lineNo: number,
): { value: string; rest: string } {
  let out = '';
  let i = 1; // past the opening quote
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') return { value: out, rest: raw.slice(i + 1) };
    if (ch === '\\') {
      const next = raw[i + 1];
      if (next === 'u' || next === 'U') {
        const width = next === 'u' ? 4 : 8;
        const hex = raw.slice(i + 2, i + 2 + width);
        if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) {
          invalid(pathDisplay, lineNo, 'bad unicode escape');
        }
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 2 + width;
        continue;
      }
      const mapped = next === undefined ? undefined : ESCAPES[next];
      if (mapped === undefined) invalid(pathDisplay, lineNo, `unsupported escape '\\${next}'`);
      out += mapped;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return invalid(pathDisplay, lineNo, 'unterminated string');
}
