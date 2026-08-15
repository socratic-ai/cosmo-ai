/**
 * Session usage-summary REST unit (``GET sessions/{id}/usage``).
 *
 * Mirror of the Python SDK's ``RealtimeSession.usage``: an authenticated
 * read of one session's usage summary — duration, talk time, and token
 * counts in provider-reported units. Kept free of the ``livekit-client``
 * dependency (like ``verify.ts`` and ``transport/dial.ts``).
 */

import { log } from './logger';
import { parseErrorDetail } from '../transport/error_detail';

/** Lifecycle state of a voice session. Open-ended — treat an unknown value
 *  defensively. */
export type SessionStatus = 'active' | 'completed' | 'error' | (string & {});

/** Whether a session's detailed usage summary is available.
 *
 *  ``pending`` while the session runs and for a short window after it ends,
 *  before the summary is written. ``recorded`` once it is there and the
 *  numbers are final. ``unavailable`` once that window has passed without
 *  one arriving: a session with no turn or speech activity records none,
 *  and neither does one torn down abnormally. Open-ended — treat an
 *  unknown value defensively. */
export type UsageStatus = 'pending' | 'recorded' | 'unavailable' | (string & {});

/** Token usage reported by the session's model provider, split by direction
 *  and modality. The live ``cosmo.usage`` event's counters plus the input
 *  and output totals, with the same cumulative semantics. */
export type SessionTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputAudioTokens: number;
  inputTextTokens: number;
  inputImageTokens: number;
  inputCachedTokens: number;
  outputAudioTokens: number;
  outputTextTokens: number;
};

/** Usage summary for one session, in provider-reported units.
 *
 *  ``durationSeconds`` is set once the session ends. The rest of the detail
 *  arrives with the summary, so it is present only while ``usageStatus`` is
 *  ``recorded``, at which point the numbers are final. ``tokens`` is null
 *  when the provider reports none. */
export type SessionUsage = {
  status: SessionStatus;
  usageStatus: UsageStatus;
  durationSeconds: number | null;
  turnCount: number | null;
  userSpeakingSeconds: number | null;
  agentSpeakingSeconds: number | null;
  provider: string | null;
  model: string | null;
  tokens: SessionTokenUsage | null;
};

/** ``code`` carried on :class:`UsageError`. The server's slug when the
 *  rejection carried one, or a client-side synthetic (``transport_error``,
 *  ``invalid_response``). Open-ended — treat unknown codes defensively. */
export type UsageErrorCode = string;

/** ``usage()`` failed. */
export class UsageError extends Error {
  readonly name = 'UsageError';
  readonly code: UsageErrorCode;

  constructor(code: UsageErrorCode, message: string) {
    super(message || code);
    this.code = code;
  }
}

export type GetUsageArgs = {
  sessionId: string;
  usageUrl: string;
  getAuthHeaders: () => Record<string, string> | Promise<Record<string, string>>;
};

/** Place the authenticated usage GET. Server rejections raise
 *  :class:`UsageError` carrying the server slug; a network failure raises
 *  ``transport_error`` and a malformed success raises
 *  ``invalid_response``. */
export async function getUsage(args: GetUsageArgs): Promise<SessionUsage> {
  let response: Response;
  try {
    response = await fetch(args.usageUrl, {
      method: 'GET',
      headers: await args.getAuthHeaders(),
    });
  } catch (err) {
    throw new UsageError(
      'transport_error',
      err instanceof Error ? err.message : 'Usage request failed to send.',
    );
  }
  if (!response.ok) {
    const { code, message } = await parseErrorDetail(response);
    log.warn('[realtime] usage rejected', {
      sessionId: args.sessionId,
      status: response.status,
      code,
    });
    throw new UsageError(code, message);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new UsageError(
      'invalid_response',
      err instanceof Error ? err.message : 'Usage response was not JSON.',
    );
  }
  const usage = extractSessionUsage(body);
  if (usage === null) {
    throw new UsageError('invalid_response', 'Usage response had an unexpected shape.');
  }
  return usage;
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') return undefined;
  return value;
}

function extractTokenUsage(value: unknown): SessionTokenUsage | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const fields = [
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'input_audio_tokens',
    'input_text_tokens',
    'input_image_tokens',
    'input_cached_tokens',
    'output_audio_tokens',
    'output_text_tokens',
  ] as const;
  const parsed: Record<string, number> = {};
  for (const field of fields) {
    const v = raw[field];
    if (v === null || v === undefined) {
      parsed[field] = 0;
    } else if (typeof v === 'number') {
      parsed[field] = v;
    } else {
      return undefined;
    }
  }
  return {
    inputTokens: parsed.input_tokens,
    outputTokens: parsed.output_tokens,
    totalTokens: parsed.total_tokens,
    inputAudioTokens: parsed.input_audio_tokens,
    inputTextTokens: parsed.input_text_tokens,
    inputImageTokens: parsed.input_image_tokens,
    inputCachedTokens: parsed.input_cached_tokens,
    outputAudioTokens: parsed.output_audio_tokens,
    outputTextTokens: parsed.output_text_tokens,
  };
}

function extractSessionUsage(body: unknown): SessionUsage | null {
  if (typeof body !== 'object' || body === null) return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.status !== 'string') return null;
  if (typeof obj.usage_status !== 'string') return null;
  const durationSeconds = optionalNumber(obj.duration_seconds);
  const turnCount = optionalNumber(obj.turn_count);
  const userSpeakingSeconds = optionalNumber(obj.user_speaking_seconds);
  const agentSpeakingSeconds = optionalNumber(obj.agent_speaking_seconds);
  if (
    durationSeconds === undefined ||
    turnCount === undefined ||
    userSpeakingSeconds === undefined ||
    agentSpeakingSeconds === undefined
  ) {
    return null;
  }
  const provider = obj.provider;
  if (provider !== null && provider !== undefined && typeof provider !== 'string') return null;
  const model = obj.model;
  if (model !== null && model !== undefined && typeof model !== 'string') return null;
  const tokens = extractTokenUsage(obj.tokens);
  if (tokens === undefined) return null;
  return {
    status: obj.status,
    usageStatus: obj.usage_status,
    durationSeconds,
    turnCount,
    userSpeakingSeconds,
    agentSpeakingSeconds,
    provider: provider ?? null,
    model: model ?? null,
    tokens,
  };
}
