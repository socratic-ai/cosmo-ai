import { naturalness, type AgentConfig, type ModelOptions } from 'cosmo-ai';

export type RoutedProvider = 'gemini' | 'openai' | 'openai_mini';

export type RouteResult = {
  provider: RoutedProvider;
  rationale: string;
  agentConfig: AgentConfig;
};

type RouteRule = {
  keywords: string[];
  provider: RoutedProvider;
  modelOptions: ModelOptions;
  speakingStyle: string;
  rationale: string;
};

const RULES: RouteRule[] = [
  {
    keywords: ['practice', 'speech', 'presentation', 'rehearse'],
    provider: 'gemini',
    modelOptions: {
      provider: 'gemini',
      thinkingLevel: 'low',
      endOfSpeechSensitivity: 'low',
      silenceDurationMs: 1200,
    },
    speakingStyle: naturalness('human'),
    rationale:
      'Rehearsal needs patience and warm delivery — Gemini, low interrupt sensitivity, human naturalness.',
  },
  {
    keywords: ['quick', 'bill', 'account', 'simple'],
    provider: 'openai_mini',
    modelOptions: { provider: 'openai_mini' },
    speakingStyle: naturalness('warm'),
    rationale: 'Short factual ask — cheapest/fastest tier, no tuning needed.',
  },
  {
    keywords: ['error', 'bug', 'not working', 'fix'],
    provider: 'openai',
    modelOptions: { provider: 'openai', turnDetection: 'semantic_vad', eagerness: 'low' },
    speakingStyle: naturalness('delivery'),
    rationale:
      'Debugging needs the user to finish describing the problem — OpenAI semantic VAD, low eagerness.',
  },
  {
    keywords: ['urgent', 'asap', 'emergency', 'right now'],
    provider: 'openai',
    modelOptions: {
      provider: 'openai',
      turnDetection: 'server_vad',
      silenceDurationMs: 400,
      prefixPaddingMs: 100,
    },
    speakingStyle: naturalness('warm'),
    rationale: 'Time pressure — OpenAI fixed-window VAD tuned for fast turn-taking.',
  },
  {
    keywords: ['brainstorm', 'ideas', 'explore', 'think through'],
    provider: 'gemini',
    modelOptions: { provider: 'gemini', thinkingLevel: 'high', temperature: 0.9 },
    speakingStyle: naturalness('delivery'),
    rationale: 'Open-ended ideation benefits from more reasoning depth — Gemini, thinkingLevel high.',
  },
];

// Gemini, not openai_mini: this is what any unmatched input lands on,
// including someone's very first, exploratory message — unlike the openai/
// openai_mini RULES above (a deliberate choice to test that path), a
// feature-gated provider here would break the demo by default on any
// workspace without realtime-openai-provider-enabled (see README).
const FALLBACK: RouteRule = {
  keywords: [],
  provider: 'gemini',
  modelOptions: { provider: 'gemini' },
  speakingStyle: naturalness('warm'),
  rationale: 'No strong signal in the intent — Gemini, the provider every workspace has.',
};

/**
 * Maps free-text user intent to a provider + model/voice configuration.
 * Deterministic keyword matching, first rule wins; always resolves via
 * `FALLBACK` when nothing matches.
 */
export function route(intent: string): RouteResult {
  const lower = intent.toLowerCase();
  const rule = RULES.find((r) => r.keywords.some((kw) => lower.includes(kw))) ?? FALLBACK;

  return {
    provider: rule.provider,
    rationale: rule.rationale,
    agentConfig: {
      // The backend resolves provider from `model` (accepts the bare
      // provider name), never from `modelOptions.provider` — that field only
      // tunes whichever provider `model` selects. Omitting it here would
      // silently start every routed session on the platform default
      // (Gemini) regardless of what modelOptions/the badge claim.
      model: rule.provider,
      modelOptions: rule.modelOptions,
      voice: { speakingStyle: rule.speakingStyle },
    },
  };
}
