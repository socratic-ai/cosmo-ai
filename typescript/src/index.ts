// WebSocket wire types live under ``./wire/`` and are generated from
// the backend's OpenAPI schema. The generated code is self-contained —
// no host-project path aliases — so an external ``npm install cosmo-ai``
// resolves cleanly.

export { setLogLevel, getLogLevel } from './core/logger';
export type { LogLevel } from './core/logger';
export { RealtimeClient } from './core/realtime_client';
export type { RealtimeClientOptions } from './core/realtime_client';

export { RealtimeAgent } from './core/agent';
export type {
  AgentConfig,
  AmbienceConfig,
  AudioConfig,
  BackgroundClientToolHandler,
  BackgroundClientToolSpec,
  ClientToolHandler,
  CatalogAgentOptions,
  ClientToolSpec,
  DetectObjectsToolSpec,
  EndCallToolSpec,
  ExamineImageToolSpec,
  CosmoVadConfig,
  GeminiModelOptions,
  GrokModelOptions,
  ModelOptions,
  OpenAIMiniModelOptions,
  OpenAIModelOptions,
  PointAtObjectToolSpec,
  RealtimeTool,
  SessionStartOptions,
  VoiceConfig,
  WebSearchToolSpec,
} from './core/agent';

export {
  DRAW_BOX_TOOL_NAME,
  DRAW_POINT_TOOL_NAME,
  drawBox,
  drawPoint,
  notShown,
  parseDrawBoxRequest,
  parseDrawPointRequest,
  shown,
} from './tool/draw';
export type {
  DrawBoxRequest,
  DrawOutcome,
  DrawPointRequest,
  NotShown,
  NormalizedBox,
  NormalizedPoint,
} from './tool/draw';

export {
  SCREEN_CLICK_TOOL_NAME,
  SCREEN_HIGHLIGHT_BOX_TOOL_NAME,
  SCREEN_HIGHLIGHT_TOOL_NAME,
  clicked,
  landedOnControl,
  landedOnEstimate,
  notClicked,
  parseScreenHighlightBoxRequest,
  screenClickElement,
  screenHighlightBox,
  screenHighlightElement,
} from './tool/screen';
export type {
  ScreenAffordance,
  ScreenBox,
  ScreenCapture,
  ScreenCaptureHandler,
  ScreenCaptureRequest,
  ScreenLocateTool,
  ScreenClickAction,
  ScreenClickButton,
  ScreenClickOutcome,
  ScreenClickRequest,
  ScreenElement,
  ScreenElementHint,
  ScreenHighlightBoxRequest,
  ScreenHighlightOutcome,
  ScreenHighlightRequest,
  ScreenPlacement,
} from './tool/screen';

export { boxRect, pointPosition } from './tool/video_geometry';
export type {
  Point,
  Rect,
  Size,
  VideoContentMode,
  VideoPlacement,
} from './tool/video_geometry';

export { ClientToolJob } from './core/client_tool_jobs';

export { AudioPublishAlreadyActiveError, RealtimeError } from './core/errors';

export {
  Hook,
  postToolUse,
  preToolUse,
  sessionEnd,
  sessionStart,
} from './core/hooks';
export type {
  HookEventName,
  ServerHook,
  PostToolUseContext,
  PostToolUseHook,
  PreToolUseContext,
  PreToolUseHook,
  PreToolUseResult,
  ServerHookAction,
  SessionStartContext,
  SessionStartHook,
  SessionStartResult,
  SessionEndContext,
  SessionEndHook,
  ToolOutcome,
} from './core/hooks';

export { SkillParseError, parseSkillMd } from './core/skills';
export type { Skill } from './core/skills';

export type {
  EndCall as EndCall,
  EndOfSpeechSensitivity,
  InterruptionSensitivity,
  Say as Say,
  SemanticEagerness,
  SessionStartTimings,
  SilenceTimeout as SilenceTimeout,
  ThinkingLevel,
} from './wire/types.gen';

export type { SessionConnectTimings } from './core/state';

export { RealtimeSession } from './core/session';
export type {
  RealtimeSessionEvent,
  SessionEndedEventItem,
  UnknownEvent,
} from './core/session';

export { CredentialError, MintTokenError } from './core/auth';
export type { MintedToken, MintTokenErrorCode } from './core/auth';

export { TokenSource } from './core/token_source';
export type { FetchedToken, TokenSourceEndpointOptions } from './core/token_source';

export { VerifyError } from './core/verify';
export type {
  CredentialInfo,
  CredentialKind,
  VerifyErrorCode,
  VerifyWorkspace,
} from './core/verify';

export { UsageError } from './core/usage';
export type {
  SessionStatus,
  UsageErrorCode,
  UsageStatus,
  SessionTokenUsage,
  SessionUsage,
} from './core/usage';

export { CosmoRealtimeProvider, useRealtimeClient } from './react/RealtimeProvider';
export type {
  CosmoRealtimeProviderProps,
  RealtimeClientLike,
  RealtimeSnapshotState,
  RealtimeTranscriptItem,
  RealtimeToolCallItem,
} from './react/RealtimeProvider';

export {
  useTransportState,
  useAgentState,
  useMediaState,
  useTranscript,
  useToolCalls,
  useRealtimeError,
  useMicLevel,
  useOutputLevel,
} from './react/hooks';

export { useRealtimeSession } from './react/use_realtime_session';
export type {
  RealtimeSessionEndSummary,
  RealtimeSessionPhase,
  RealtimeSessionStartResult,
  UseRealtimeSessionOptions,
  UseRealtimeSessionResult,
} from './react/use_realtime_session';
export type { RejectedTool } from './wire/types.gen';

export { RealtimeAudio } from './react/components/RealtimeAudio';
export { MicToggle } from './react/components/MicToggle';
export { BarVisualizer } from './react/components/BarVisualizer';
export { StartAudio } from './react/components/StartAudio';

export { NotReadyError } from './core/types';
export type {
  ErrorEvent,
  ErrorCode,
  ScreenShareState,
} from './core/types';

export { DialError } from './transport/dial';
export type { DialResult, DialErrorCode } from './transport/dial';

export {
  SessionStartError,
  SessionBusyError,
  SessionEntitlementError,
  SessionConfigError,
  VersionMismatchError,
  SessionStartTransportError,
} from './transport/session_start_error';
export type { RealtimeSessionStartDetail } from './transport/session_start_error';

export type {
  TransportState,
  AgentState,
  DisconnectReason,
  MediaState,
  OutputState,
  MicState,
  SessionLifecycleState,
} from './core/state';

export type {
  UserSpeechTimeoutEvent,
  TranscriptDeltaEvent,
  ModelTextEvent,
  ToolCallEvent,
  ToolResultEvent,
  ToolDispatchStartedEvent,
  ReconnectingEvent,
  TurnCompleteEvent,
  PongEvent,
  VolumeEvent,
  ReadyEvent,
  ResolvedAgentInfo,
  RealtimeEventMap,
  RealtimeEventName,
  Unsubscribe,
} from './core/events';

export { SDK_NAME, SDK_VERSION } from './constants';

export type { NaturalnessRung } from './presets';
export {
  naturalness,
  NATURALNESS_INSTRUCTIONS,
  NATURALNESS_RUNGS,
  NATURALNESS_VERSION,
} from './presets';
