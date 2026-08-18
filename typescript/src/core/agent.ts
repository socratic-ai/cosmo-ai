/**
 * ``RealtimeAgent`` — the reusable persona, and the cross-SDK entry point
 * for opening sessions.
 *
 * Build an agent once (``client.agent({instructions, voice, tools})``) and
 * start any number of sessions from it (``agent.start()``). Python
 * (``cosmo_ai.Agent``) is the reference for shape and semantics.
 */

import type {
  InterruptionSensitivity,
  EndOfSpeechSensitivity,
  InlineAgentConfig,
  CatalogAgentConfig,
  SemanticEagerness,
  SessionConfig,
  SessionParams,
  SilenceTimeout as SilenceTimeout,
  ThinkingLevel,
} from '../wire/types.gen';

import { SDK_NAME, SDK_VERSION } from '../constants';
import { isSdkClientTool } from '../tool/sdk_tool';
import type { ScreenLocateTool } from '../tool/screen';
import type { ClientToolJob } from './client_tool_jobs';
import { Hook, HookEngine, type ServerHook, resolveHooks } from './hooks';
import type { RealtimeClient } from './realtime_client';
import type { RealtimeSession } from './session';
import {
  type Skill,
  buildLoadSkillTool,
  menuText,
  resolveSkills,
} from './skills';

/** An async client-tool handler: the returned object is the tool result
 *  reported back to the agent. Throw to surface a tool error. ``args`` is
 *  the decoded tool-call arguments. */
export type ClientToolHandler = (
  args: Record<string, unknown>,
) => Promise<Record<string, unknown> | null | undefined | void>;

/** A background client-tool handler: ack the call with ``job.ack(note)``
 *  (releasing the RPC reply while the handler keeps running), then deliver
 *  the result later with ``job.complete(...)`` / ``job.fail(...)`` — never
 *  by returning a value. */
export type BackgroundClientToolHandler = (
  args: Record<string, unknown>,
  job: ClientToolJob,
) => Promise<void>;

/** A tool the client executes locally: the SDK declares it at session
 *  start and the server routes matching invocations back over the
 *  transport RPC bridge. Attach a ``handler`` to execute the tool; a spec
 *  without one is still declared to the agent but not locally executable
 *  (the invocation surfaces only as a ``tool-invocation`` event). */
export type ClientToolSpec = {
  kind: 'client';
  background?: undefined;
  name: string;
  description: string;
  /** JSON-Schema object describing the tool's arguments. */
  parameters: Record<string, unknown>;
  /** Local execution callback — never serialized to the wire. */
  handler?: ClientToolHandler;
};

/** A long-running client tool, declared explicitly (the cross-SDK,
 *  arity-free shape): the handler acks the call immediately and delivers
 *  its terminal result later through the ``ClientToolJob``. Serializes to
 *  the same ``kind: 'client'`` wire shape as ``ClientToolSpec`` — the
 *  server infers deferral from the reply, so nothing on the wire changes. */
export type BackgroundClientToolSpec = {
  kind: 'client';
  background: true;
  name: string;
  description: string;
  /** JSON-Schema object describing the tool's arguments. */
  parameters: Record<string, unknown>;
  /** Local execution callback — never serialized to the wire. */
  handler?: BackgroundClientToolHandler;
};

/** Opt-in to the server-executed web-search tool. The server owns the
 *  model-facing declaration — zero-config. */
export type WebSearchToolSpec = {
  kind: 'web_search';
};

/** Opt-in to the server-executed frame-examination tool: reads the
 *  freshest frame of the published video at full resolution to answer a
 *  fine-detail question. Zero-config. */
export type ExamineImageToolSpec = {
  kind: 'examine_image';
};

/** Opt-in to the server-executed object locator that returns boxes — one
 *  per matching instance. Zero-config. */
export type DetectObjectsToolSpec = {
  kind: 'detect_objects';
};

/** Opt-in to the server-executed object locator that returns points.
 *  Zero-config. */
export type PointAtObjectToolSpec = {
  kind: 'point_at_object';
};

/** Opt-in to the server-executed hang-up, so the agent can end the call
 *  itself. Zero-config. Ending binds the call, not just the agent — every
 *  leg drops — and the spoken goodbye is allowed to finish first. Without
 *  it the agent can't hang up. */
export type EndCallToolSpec = {
  kind: 'end_call';
};

export type RealtimeTool =
  | ClientToolSpec
  | BackgroundClientToolSpec
  | WebSearchToolSpec
  | ExamineImageToolSpec
  | DetectObjectsToolSpec
  | PointAtObjectToolSpec
  | ScreenLocateTool
  | EndCallToolSpec;

/** Tuning for the ``cosmo_vad`` turn detector. Every knob names the
 *  detector's own machinery, so a caller always knows which endpointer a
 *  setting touches; an unset knob keeps the server default. */
export type CosmoVadConfig = {
  /** Silence (ms, 0–5000) that triggers the end-of-turn inference. */
  pauseMs?: number;
  /** Audio (ms, 0–5000) kept from before speech was detected, so a turn's
   *  opening syllable is not clipped. */
  prefixMs?: number;
  /** Total silence (ms, 0–5000) after which the turn ends regardless of the
   *  classifier's verdict. */
  maxHoldMs?: number;
};

/** Gemini-realtime model knobs. Valid only when ``model`` runs on Gemini;
 *  the ``provider`` discriminator makes setting these for another provider a
 *  type error rather than a silent no-op.
 *
 *  ``turnDetection`` selects which detector ends the user's turn, and each
 *  detector owns its knobs: ``endOfSpeechSensitivity``, ``silenceDurationMs``
 *  and ``prefixPaddingMs`` tune the provider's ``server_vad``; the
 *  ``cosmoVad`` block tunes ``cosmo_vad``. The union makes pairing a knob
 *  with the other detector a type error; the server rejects the same pairing
 *  rather than silently ignoring it. */
export type GeminiModelOptions = {
  provider: 'gemini';
  /** Sampling temperature (0–2) — higher is more varied, lower more
   *  deterministic. Unset uses the provider default. */
  temperature?: number;
  /** Cap on tokens per model response. Unset uses the provider default. */
  maxOutputTokens?: number;
  /** Reasoning depth. Unset keeps the server's per-mode default. */
  thinkingLevel?: ThinkingLevel;
  /** Stream thought summaries alongside the answer. Only worth enabling for
   *  an app that reads them. Unset keeps the server's per-mode default. */
  includeThoughts?: boolean;
} & (
  | {
      /** Opts the session into the provider's silence-window detection,
       *  which is what the three knobs on this branch tune. Unset (the
       *  default) is Cosmo's semantic turn detection; the knobs are unread
       *  under it. */
      turnDetection?: 'server_vad';
      /** How readily the model decides the user's turn ended — the
       *  end-of-turn counterpart to ``interruptionSensitivity``'s
       *  speech-start gate. ``high`` endpoints sooner, so the assistant
       *  answers faster but is more likely to cut in on a mid-thought
       *  pause. Read only with ``server_vad``. Unset keeps the provider
       *  default. */
      endOfSpeechSensitivity?: EndOfSpeechSensitivity;
      /** Silence (ms, 0–5000) that ends the user's turn. Read only with
       *  ``server_vad``. Unset keeps the provider default. */
      silenceDurationMs?: number;
      /** Audio (ms, 0–5000) kept from before speech was detected, so a
       *  turn's opening syllable is not clipped. Read only with
       *  ``server_vad``. Unset keeps the provider default. */
      prefixPaddingMs?: number;
      cosmoVad?: never;
    }
  | {
      /** Names the default detector explicitly: Cosmo's own semantic
       *  detector — a pause triggers one end-of-turn inference, so a
       *  mid-thought pause holds the turn open. */
      turnDetection: 'cosmo_vad';
      /** Tuning for the ``cosmo_vad`` detector. Unset keeps the server
       *  defaults. */
      cosmoVad?: CosmoVadConfig;
      endOfSpeechSensitivity?: never;
      silenceDurationMs?: never;
      prefixPaddingMs?: never;
    }
);

/** OpenAI-Realtime model knobs. OpenAI Realtime pins its own sampling and
 *  token limits, so only turn-taking is tunable here.
 *
 *  ``turnDetection`` decides which of the remaining knobs apply: ``eagerness``
 *  belongs to ``semantic_vad``, the two window knobs to ``server_vad``. The
 *  union makes pairing one with the other detector a type error; the server
 *  rejects the same pairing rather than silently ignoring it. */
export type OpenAIModelOptions =
  | {
      provider: 'openai';
      /** Ends the turn after a fixed window of silence. Unset keeps the
       *  provider default, which is this detector. */
      turnDetection?: 'server_vad';
      /** Silence (ms, 0–5000) that ends the user's turn. */
      silenceDurationMs?: number;
      /** Audio (ms, 0–5000) kept from before speech was detected. */
      prefixPaddingMs?: number;
      eagerness?: never;
    }
  | {
      provider: 'openai';
      /** Ends the turn as soon as the utterance reads as complete. */
      turnDetection: 'semantic_vad';
      /** How eagerly the classifier closes the user's turn — ``high``
       *  answers sooner, ``low`` waits longer for them to continue. */
      eagerness?: SemanticEagerness;
      silenceDurationMs?: never;
      prefixPaddingMs?: never;
    };

/** OpenAI-Realtime mini-tier model knobs — the same API on a faster, cheaper
 *  model, and equally untunable today. */
export type OpenAIMiniModelOptions = {
  provider: 'openai_mini';
};

/** xAI Grok Voice model knobs — untunable today, like the OpenAI mini
 *  tier. */
export type GrokModelOptions = {
  provider: 'grok';
};

/** Provider-scoped model knobs, discriminated on ``provider``. Each knob is
 *  honored only by its provider — ``thinkingLevel`` lives only on the Gemini
 *  block — so an illegal pairing is a type error. ``model`` selects the
 *  concrete model within the chosen provider. */
export type ModelOptions =
  | GeminiModelOptions
  | OpenAIModelOptions
  | OpenAIMiniModelOptions
  | GrokModelOptions;

/** How the agent sounds — the prebuilt voice and the per-run speaking
 *  style. Accepted anywhere a plain voice-id string is, when a speaking
 *  style rides along. */
export type VoiceConfig = {
  /** Provider voice id. Unset lets the upstream pick per session. */
  name?: string;
  /** "How to speak" instruction appended after the persona. */
  speakingStyle?: string;
};

/** Background-ambience bed mixed into the assistant's OUTPUT audio.
 *  Presence of the object enables the bed; omit it for none. */
export type AmbienceConfig = {
  /** Named ambience bed to play; unset uses the default bed. */
  track?: 'office';
  /** Bed level relative to full scale (dB, -60..0); sits under speech. */
  gainDb?: number;
};

/** The agent's audio pipeline, configured once — not per run. */
export type AudioConfig = {
  /** Whether the agent emits audio. ``false`` runs the session text-only:
   *  input transcription and text output are unaffected. Rejected at
   *  session start when the resolved model cannot run text-only. */
  output?: boolean;
  /** Apply background-voice cancellation to the user's inbound audio.
   *  Off unless set to ``true``. */
  noiseCancellation?: boolean;
  /** Background-ambience bed on the assistant's output; present = enabled. */
  ambience?: AmbienceConfig;
};

/** The inline persona — what the agent is, independent of any one run.
 *  To run a workspace catalog agent by handle instead, use
 *  ``client.catalogAgent(name, {...})`` — this type has no catalog-launch
 *  fields, so the two cannot be mixed. */
export type AgentConfig = {
  /** System instructions. Replaces the server's neutral default when set. */
  instructions?: string;
  /** Concrete model to run, within the provider named by ``modelOptions``.
   *  Unknown or workspace-unavailable values are rejected at session start. */
  model?: string;
  /** Provider-scoped model knobs (sampling, reasoning depth, turn-taking),
   *  discriminated on ``provider``. Each knob is honored only by its provider,
   *  so an illegal pairing is a type error. Unset keeps every provider default. */
  modelOptions?: ModelOptions;
  /** How the agent sounds: the voice id as a plain string, or a
   *  ``VoiceConfig`` when a speaking style rides along. */
  voice?: string | VoiceConfig;
  /** Tool set for the session: client-executed specs plus server-tool
   *  opt-ins. Unset → the session runs with no tools. */
  tools?: RealtimeTool[];
  /** How readily user audio barges in over the assistant. */
  interruptionSensitivity?: InterruptionSensitivity;
  /** Opening line the assistant speaks as soon as the model session opens.
   *  Part of the persona: what this agent says to open a call. A resumed
   *  session never re-greets. */
  greeting?: string;
  /** The agent's audio pipeline — output emission, inbound noise
   *  cancellation, and the ambience bed. Part of the agent config so an
   *  agent's audio handling is configured once, not per run. Unset sends no
   *  audio block at all, so every knob keeps its server default —
   *  ``noiseCancellation`` among them, which is off. */
  audio?: AudioConfig;
  /** Skills for this agent: the skill menu is folded into the instructions
   *  at ``start()`` and a ``cosmo_sdk_load_skill`` client tool serves skill
   *  bodies on demand. Duplicate names throw when the agent is built. Skills
   *  never cross the wire as such. */
  skills?: Skill[];
  /** One list, two kinds of hooks: in-process client hooks built by the
   *  seam factories (``sessionStart(fn)``, ``preToolUse(fn, {matcher})``,
   *  …; list order is fold order) and declarative server hooks
   *  (``SilenceTimeout``) the server executes even if this process dies
   *  mid-call. */
  hooks?: (Hook | ServerHook)[];
};

/** Per-run ride-alongs for ``client.catalogAgent(name, {...})`` — the
 *  stored config runs verbatim, so there are no persona fields here;
 *  sending one with a catalog launch is a type error, not a server rejection. */
export type CatalogAgentOptions = {
  /** Values for the referenced agent's declared input fields, substituted
   *  into the resolved prompt's ``{{key}}`` placeholders. */
  inputs?: Record<string, string>;
  /** Client-executed declarations (plus server-tool opt-ins), used
   *  verbatim as the session's tool set — the stored agent config carries
   *  no tools, so nothing is merged in. */
  tools?: RealtimeTool[];
  /** Per-run voice: the override id as a plain string, or a ``VoiceConfig``
   *  carrying a speaking style. The voice id is the one cosmetic exception
   *  to "stored config runs verbatim" — it never changes what the agent
   *  says (cf. Vapi's per-call assistant overrides). */
  voice?: string | VoiceConfig;
  /** In-process client hooks (seam-factory ``Hook``s). Server hooks are
   *  stored config — declare them on the catalog agent, not here. */
  hooks?: Hook[];
};

/** @internal — the resolved persona a ``RealtimeAgent`` holds: an inline
 *  config, or a catalog launch (``name`` set) whose only other fields
 *  are the ``CatalogAgentOptions`` ride-alongs. The public factories keep
 *  the two shapes apart at the type level. */
export type ResolvedAgentConfig = AgentConfig & {
  name?: string;
  inputs?: Record<string, string>;
};

/** Per-run, transport-level options for one ``agent.start()``. Persona
 *  fields — including ``greeting`` and the ``audio`` pipeline — live
 *  on ``AgentConfig``; build another agent to change them. */
export type SessionStartOptions = {
  /** Resume the named prior session — natively when the resumption handle
   *  is still warm, otherwise by seeding the new upstream session with the
   *  prior transcript. */
  resumeSessionId?: string;
  /** Persist this run's recording artifacts (audio/video/transcript/tool
   *  events) server-side. Unset stores as much as the account's consents
   *  allow. The per-artifact options below win over this one. */
  storeRecording?: boolean;
  /** Persist this run's audio. Narrowing only: a session can request less
   *  storage than the account permits, never more. Unset defers to
   *  ``storeRecording``, then to those consents. */
  storeAudio?: boolean;
  /** Persist this run's transcript and tool-call events. Same contract as
   *  ``storeAudio``. */
  storeTranscript?: boolean;
  /** Persist this run's screen-share video and screenshots. Same contract as
   *  ``storeAudio``. */
  storeVideo?: boolean;
  /** Publish the local microphone track into the room. Defaults to ``true``
   *  (a normal voice session). Set ``false`` to join as a silent observer —
   *  e.g. an operator watching a session that dials an outbound call via
   *  ``session.dial()``, where a second mic in the room would echo the
   *  callee's audio.
   *
   *  Client-side only (the backend never sees it). The agent's ear is
   *  unaffected either way — the worker binds its input to whichever
   *  participant actually carries the voice (a published mic, or the
   *  answered phone leg). */
  publishMicrophone?: boolean;
};

function prune<T extends object>(obj: T): T | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as T;
}

/** Wire form of ``voice``: a plain string is the voice id shorthand. */
function toWireVoice(
  voice: string | VoiceConfig | undefined,
): { name?: string; speaking_style?: string } | undefined {
  if (voice === undefined) return undefined;
  if (typeof voice === 'string') return { name: voice };
  return prune({ name: voice.name, speaking_style: voice.speakingStyle });
}

/** Wire form of ``audio``. An explicitly present ``ambience`` survives as
 *  ``{}`` even with every knob unset — presence is what enables the bed. */
function toWireAudio(audio: AudioConfig | undefined):
  | {
      output?: boolean;
      noise_cancellation?: boolean;
      ambience?: { track?: 'office'; gain_db?: number };
    }
  | undefined {
  if (audio === undefined) return undefined;
  const ambience =
    audio.ambience === undefined
      ? undefined
      : (prune({ track: audio.ambience.track, gain_db: audio.ambience.gainDb }) ?? {});
  return prune({
    output: audio.output,
    noise_cancellation: audio.noiseCancellation,
    ambience,
  });
}

/** The wire form of a client tool: the declared spec with every local-only
 *  execution field (``handler``, the ``background`` marker) excluded by
 *  type, so a new local field cannot leak onto the wire unnoticed. */
type WireClientTool = Omit<ClientToolSpec, 'handler' | 'background'>;

/** Zero-config typed server-tool opt-ins serialize as their bare kind —
 *  including ``screen_locate``, whose local capture handler is stripped the
 *  same way a client tool's is. */
type WireServerToolOptIn = {
  kind:
    | 'web_search'
    | 'examine_image'
    | 'detect_objects'
    | 'point_at_object'
    | 'screen_locate'
    | 'end_call';
};

/** Strip local-only fields (``handler``, ``capture``, the ``background``
 *  marker) so the wire body carries only the declared spec — a background tool
 *  serializes identically to a plain client tool. */
function toWireTool(
  tool: RealtimeTool,
): WireServerToolOptIn | WireClientTool {
  if (
    tool.kind === 'web_search' ||
    tool.kind === 'examine_image' ||
    tool.kind === 'detect_objects' ||
    tool.kind === 'point_at_object' ||
    tool.kind === 'screen_locate' ||
    tool.kind === 'end_call'
  ) {
    return { kind: tool.kind };
  }
  const { name, description, parameters } = tool;
  return { kind: 'client', name, description, parameters };
}

/** Map the ergonomic (camelCase) model options onto the wire's provider-scoped
 *  block. Only the selected provider's knobs cross the wire. */
function toWireModelOptions(
  mo: ModelOptions,
): NonNullable<InlineAgentConfig['model_options']> {
  switch (mo.provider) {
    case 'gemini':
      return {
        provider: 'gemini',
        ...prune({
          temperature: mo.temperature,
          max_output_tokens: mo.maxOutputTokens,
          thinking_level: mo.thinkingLevel,
          include_thoughts: mo.includeThoughts,
          ...(mo.turnDetection === 'cosmo_vad'
            ? {
                turn_detection: mo.turnDetection,
                cosmo_vad: mo.cosmoVad
                  ? prune({
                      pause_ms: mo.cosmoVad.pauseMs,
                      prefix_ms: mo.cosmoVad.prefixMs,
                      max_hold_ms: mo.cosmoVad.maxHoldMs,
                    })
                  : undefined,
              }
            : {
                turn_detection: mo.turnDetection,
                end_of_speech_sensitivity: mo.endOfSpeechSensitivity,
                silence_duration_ms: mo.silenceDurationMs,
                prefix_padding_ms: mo.prefixPaddingMs,
              }),
        }),
      };
    case 'openai':
      return {
        provider: 'openai',
        ...prune(
          mo.turnDetection === 'semantic_vad'
            ? { turn_detection: mo.turnDetection, eagerness: mo.eagerness }
            : {
                turn_detection: mo.turnDetection,
                silence_duration_ms: mo.silenceDurationMs,
                prefix_padding_ms: mo.prefixPaddingMs,
              },
        ),
      };
    case 'openai_mini':
      return { provider: 'openai_mini' };
    case 'grok':
      return { provider: 'grok' };
  }
}

/** Fold the skills into the persona: the menu rides resident in the
 *  instructions and the ``cosmo_sdk_load_skill`` tool joins the tool set.
 *  That tool sits in the reserved namespace, so a caller tool claiming its
 *  name is rejected at config assembly rather than colliding here. */
function applySkills(config: AgentConfig): AgentConfig {
  const skills = resolveSkills(config.skills);
  const loadTool = buildLoadSkillTool(skills);
  if (loadTool === null) return config;
  const menu = menuText(skills);
  const instructions = config.instructions
    ? `${config.instructions}\n\n${menu}`
    : menu;
  return { ...config, instructions, tools: [...(config.tools ?? []), loadTool] };
}

/** Client-tool names reserved for the tools the SDK ships itself. The SDK
 *  owns those names and schemas, so a caller's tool taking one would swap it
 *  for something the model was told behaves differently. The wider ``cosmo_``
 *  namespace belongs to server tools; this is the slice carved out of it for
 *  client-executed SDK tools. */
export const SDK_TOOL_NAME_PREFIX = 'cosmo_sdk_';

/** Thrown while the caller is still looking at the tool that caused it,
 *  rather than surfacing as the server's 422 at session start. The SDK's own
 *  renderers pass by construction — see ``markSdkClientTool`` — so taking an
 *  SDK tool's exact name is rejected like any other squat. */
function assertNoReservedToolNames(tools: RealtimeTool[] | undefined): void {
  for (const tool of tools ?? []) {
    if (tool.kind !== 'client') continue;
    if (!tool.name.startsWith(SDK_TOOL_NAME_PREFIX)) continue;
    if (isSdkClientTool(tool)) continue;
    throw new Error(
      `${tool.name}: the ${SDK_TOOL_NAME_PREFIX} prefix is reserved for tools ` +
        'the SDK ships — rename your tool',
    );
  }
}

/** Map one agent + per-run options onto the external ``session-config``
 *  wire body. ``undefined`` fields are omitted (server defaults apply). */
export function buildAgentSessionConfig(
  config: ResolvedAgentConfig,
  opts: SessionStartOptions & { serverHooks?: ServerHook[] },
): SessionConfig {
  assertNoReservedToolNames(config.tools);
  const wireTools =
    config.tools !== undefined && config.tools.length > 0
      ? config.tools.map(toWireTool)
      : undefined;

  let agent: CatalogAgentConfig | InlineAgentConfig | undefined;
  if (config.name !== undefined) {
    // A catalog launch carries only per-run ride-alongs; the factory
    // split keeps stored config out at the type level — guard here so a
    // derived or hand-built config with stored fields fails before it
    // touches the wire.
    const offending = [
      ['instructions', config.instructions],
      ['model', config.model],
      ['modelOptions', config.modelOptions],
      ['interruptionSensitivity', config.interruptionSensitivity],
      ['greeting', config.greeting],
      ['audio', config.audio],
      ['hooks (server)', (opts.serverHooks ?? []).length > 0 ? opts.serverHooks : undefined],
    ]
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    if (offending.length > 0) {
      throw new Error(
        'a catalog agent runs its stored config verbatim — remove: ' +
          offending.join(', '),
      );
    }
    agent = {
      type: 'catalog',
      name: config.name,
      ...prune({
        inputs: config.inputs,
        tools: wireTools,
        voice: toWireVoice(config.voice),
      }),
    };
  } else {
    const fields = prune({
      instructions: config.instructions,
      model: config.model,
      model_options:
        config.modelOptions !== undefined
          ? toWireModelOptions(config.modelOptions)
          : undefined,
      voice: toWireVoice(config.voice),
      interruption_sensitivity: config.interruptionSensitivity,
      hooks: (opts.serverHooks ?? []).length > 0 ? opts.serverHooks : undefined,
      tools: wireTools,
      greeting: config.greeting,
      audio: toWireAudio(config.audio),
    });
    agent = { type: 'inline', ...fields };
  }

  const session: SessionParams = {
    store_recording: opts.storeRecording,
    store_audio: opts.storeAudio,
    store_transcript: opts.storeTranscript,
    store_video: opts.storeVideo,
    experimental:
      opts.resumeSessionId !== undefined
        ? { resume_session_id: opts.resumeSessionId }
        : undefined,
  };

  return {
    type: 'session-config',
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    agent,
    session: prune(session),
  };
}

export class RealtimeAgent {
  private readonly client: RealtimeClient;
  /** Resolved persona (client defaults already applied). Frozen. */
  readonly config: Readonly<ResolvedAgentConfig>;

  /** @internal — construct via ``client.agent()`` / ``client.catalogAgent()``. */
  constructor(client: RealtimeClient, config: ResolvedAgentConfig) {
    // Validate at build, not at start() — a duplicate skill name or a
    // malformed hooks element throws the instant the agent is built,
    // matching the Python reference.
    resolveSkills(config.skills);
    resolveHooks(config.hooks);
    this.client = client;
    this.config = Object.freeze({ ...config });
  }

  /** Open one session from this persona. Resolves once the transport is
   *  connected (room joined); wait for the ``ready`` event before the
   *  first send. Rejects on handshake or transport failure — the caller
   *  never receives a session for a run that failed to start. A server
   *  rejection throws the most specific ``SessionStartError`` subclass
   *  (``SessionBusyError``, ``SessionEntitlementError``, ``SessionConfigError``,
   *  ``VersionMismatchError``); a request that never reached the server
   *  throws ``SessionStartTransportError``. Each start is independent —
   *  sessions from one client run concurrently. */
  async start(opts: SessionStartOptions = {}): Promise<RealtimeSession> {
    const { clientHooks, serverHooks } = resolveHooks(this.config.hooks);
    const effective = applySkills(this.config);
    const config = buildAgentSessionConfig(effective, { ...opts, serverHooks });
    const tools = effective.tools ?? [];
    return this.client._startSession({
      config,
      publishMicrophone: opts.publishMicrophone ?? true,
      clientTools: tools.filter(
        (tool): tool is ClientToolSpec | BackgroundClientToolSpec =>
          tool.kind === 'client',
      ),
      screenLocate: tools.find(
        (tool): tool is ScreenLocateTool => tool.kind === 'screen_locate',
      ),
      hooks: clientHooks.length > 0 ? new HookEngine(clientHooks) : undefined,
    });
  }
}
