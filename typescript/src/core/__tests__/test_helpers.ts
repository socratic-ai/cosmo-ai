import type {
  InlineAgentConfig,
  SessionResponse,
} from '../../wire/types.gen';
import type {
  RealtimeClientMessage,
  RealtimeServerMessage,
} from '../../transport/envelope';
import type { RealtimeSession, RealtimeSessionEvent } from '../session';
import type {
  RealtimeCloseInfo,
  RealtimeConnectOptions,
  RealtimeTransport,
  RpcInvocation,
} from '../../transport/types';

export type FakeTransport = RealtimeTransport & {
  lastConfig: () => RealtimeConnectOptions['config'] | undefined;
  lastPublishMicrophone: () => boolean | undefined;
  /** Every payload passed to ``send``,
    lastDisconnectOpts: () => disconnectOpts, in order. */
  sent: RealtimeClientMessage[];
  /** Feed one wire frame to the engine, as if it arrived off the data channel. */
  emitMessage: (message: RealtimeServerMessage) => void;
  /** Fire an unsolicited transport close. */
  emitClose: (info?: RealtimeCloseInfo) => void;
  /** The opts of the last ``disconnect`` call, or null if never called. */
  lastDisconnectOpts: () => { sendEndFrame?: boolean } | null | undefined;
  emitReconnecting: () => void;
  emitReconnected: () => void;
  /** RPC methods registered on the transport, by name. */
  rpcMethods: Map<string, (invocation: RpcInvocation) => Promise<string>>;
  /** Byte-stream payloads passed to ``sendBytes``, in order. */
  sentBytes: Array<{ topic: string; data: Uint8Array }>;
  /** Invoke a registered RPC method as the session agent would. */
  invokeRpc: (
    name: string,
    payload: string,
    opts?: { callerIsAgent?: boolean },
  ) => Promise<string>;
};

/** Minimal in-memory transport for the agent/session suites: records the
 *  last ``connect`` options — the wire ``session-config`` body and the
 *  mic-publish flag — and every ``send``, and exposes ``emit*`` triggers so
 *  tests can feed wire frames and transport lifecycle events. */
export function makeFakeTransport(
  options: { connectError?: Error; sessionResponse?: SessionResponse } = {},
): FakeTransport {
  let captured: RealtimeConnectOptions | undefined;
  let disconnectOpts: { sendEndFrame?: boolean } | null | undefined;
  const sent: RealtimeClientMessage[] = [];
  const messageListeners = new Set<(msg: RealtimeServerMessage) => void>();
  const closeListeners = new Set<(info?: RealtimeCloseInfo) => void>();
  const reconnectingListeners = new Set<() => void>();
  const reconnectedListeners = new Set<() => void>();
  const rpcMethods = new Map<string, (invocation: RpcInvocation) => Promise<string>>();
  const sentBytes: Array<{ topic: string; data: Uint8Array }> = [];
  return {
    registerRpcMethod: (name, handler) => {
      rpcMethods.set(name, handler);
      return () => {
        rpcMethods.delete(name);
      };
    },
    rpcMethods,
    invokeRpc: (name, payload, opts = {}) => {
      const handler = rpcMethods.get(name);
      if (handler === undefined) {
        return Promise.reject(new Error(`no rpc method registered: ${name}`));
      }
      return handler({
        payload,
        callerIdentity: 'agent:fake-session',
        callerIsAgent: opts.callerIsAgent ?? true,
      });
    },
    connect: async (opts: RealtimeConnectOptions): Promise<void> => {
      if (options.connectError !== undefined) throw options.connectError;
      captured = opts;
      // The real transport always fires this the instant the session-start
      // POST returns; mirror it so client state under test isn't emptier
      // than production.
      const response = options.sessionResponse ?? fakeSessionResponse('sess-fake');
      opts.onSessionStarted?.(response.session_id);
      // Phase values are arbitrary — the real computation is pinned in the
      // transport's own suite. What matters here is that a started client
      // exposes timings at all, and that ``serverTimings`` rides through.
      opts.onConnectTimings?.({
        wsMs: 1,
        roomMs: 2,
        micMs: 3,
        totalConnectMs: 6,
        serverTimings: response.timings ?? null,
      });
    },
    disconnect: async (opts?: { sendEndFrame?: boolean }): Promise<void> => {
      disconnectOpts = opts ?? null;
    },
    send: async (message: RealtimeClientMessage): Promise<void> => {
      sent.push(message);
    },
    sendBytes: async (data: Uint8Array, topic: string): Promise<void> => {
      sentBytes.push({ topic, data });
    },
    setMicMuted: async (): Promise<void> => {},
    getInputStream: () => null,
    getOutputAudioElement: () => null,
    attachAudioElement: () => {},
    onMessage: (cb) => {
      messageListeners.add(cb);
      return () => {
        messageListeners.delete(cb);
      };
    },
    onClose: (cb) => {
      closeListeners.add(cb);
      return () => {
        closeListeners.delete(cb);
      };
    },
    onReconnecting: (cb) => {
      reconnectingListeners.add(cb);
      return () => {
        reconnectingListeners.delete(cb);
      };
    },
    onReconnected: (cb) => {
      reconnectedListeners.add(cb);
      return () => {
        reconnectedListeners.delete(cb);
      };
    },
    sent,
    sentBytes,
    lastConfig: () => captured?.config,
    lastPublishMicrophone: () => captured?.publishMicrophone,
    lastDisconnectOpts: () => disconnectOpts,
    emitMessage: (message) => {
      for (const cb of messageListeners) cb(message);
    },
    emitClose: (info) => {
      for (const cb of closeListeners) cb(info);
    },
    emitReconnecting: () => {
      for (const cb of reconnectingListeners) cb();
    },
    emitReconnected: () => {
      for (const cb of reconnectedListeners) cb();
    },
  };
}

/** A session-start response for tests that only care about the id.
 *  ``timings`` stays absent — suites pinning the server breakdown pass
 *  their own. */
export function fakeSessionResponse(
  sessionId: string,
  overrides: Partial<SessionResponse> = {},
): SessionResponse {
  return {
    livekit_url: 'ws://fake.invalid',
    token: 'fake-token',
    room_name: `room-${sessionId}`,
    session_id: sessionId,
    ...overrides,
  };
}

/** A final assistant transcript frame, the way the wire carries it. */
export function transcriptFrame(text: string): RealtimeServerMessage {
  return { type: 'transcript', role: 'ASSISTANT', text, is_final: true };
}

/** Pull exactly ``count`` items off the session stream (fewer if it ends). */
export async function collect(
  session: RealtimeSession,
  count: number,
): Promise<RealtimeSessionEvent[]> {
  const iterator = session[Symbol.asyncIterator]();
  const events: RealtimeSessionEvent[] = [];
  for (let i = 0; i < count; i++) {
    const result = await iterator.next();
    if (result.done === true) break;
    events.push(result.value);
  }
  return events;
}

/** Drain the session stream to its terminal item. */
export async function drain(session: RealtimeSession): Promise<RealtimeSessionEvent[]> {
  const events: RealtimeSessionEvent[] = [];
  for await (const event of session) events.push(event);
  return events;
}

/** Narrow a captured session-config's agent block to the inline variant —
 *  the union's reference member lacks the persona fields these tests pin. */
export function inlineAgent(
  config: RealtimeConnectOptions['config'] | undefined,
): InlineAgentConfig | undefined {
  const agent = config?.agent;
  if (agent === undefined || agent.type === 'catalog') return undefined;
  return agent;
}
