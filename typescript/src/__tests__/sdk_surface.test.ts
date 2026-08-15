import { describe, it, expect, expectTypeOf } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as Sdk from '..';

function barrelSource(): string {
  const barrelPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');
  return fs.readFileSync(barrelPath, 'utf-8');
}

describe('SDK surface', () => {
  it('exports the canonical symbols', () => {
    expect(typeof Sdk.RealtimeClient).toBe('function');
    expect(typeof Sdk.RealtimeAgent).toBe('function');
    expect(typeof Sdk.RealtimeSession).toBe('function');
    expect(typeof Sdk.CosmoRealtimeProvider).toBe('function');
    expect(typeof Sdk.RealtimeAudio).toBe('function');
    expect(typeof Sdk.useMicLevel).toBe('function');
    expect(typeof Sdk.useOutputLevel).toBe('function');
    expect(typeof Sdk.useRealtimeError).toBe('function');
    expect(typeof Sdk.useRealtimeSession).toBe('function');
    expect(typeof Sdk.DialError).toBe('function');
    expect(typeof Sdk.SessionStartError).toBe('function');
    expect(typeof Sdk.SessionBusyError).toBe('function');
    expect(typeof Sdk.SessionEntitlementError).toBe('function');
    expect(typeof Sdk.SessionConfigError).toBe('function');
    expect(typeof Sdk.VersionMismatchError).toBe('function');
    expect(typeof Sdk.SessionStartTransportError).toBe('function');
    expect(typeof Sdk.CredentialError).toBe('function');
    expect(typeof Sdk.MintTokenError).toBe('function');
    expect(typeof Sdk.RealtimeError).toBe('function');
    expect(typeof Sdk.Hook).toBe('function');
    expect(typeof Sdk.sessionStart).toBe('function');
    expect(typeof Sdk.preToolUse).toBe('function');
    expect(typeof Sdk.postToolUse).toBe('function');
    expect(typeof Sdk.sessionEnd).toBe('function');
    expect(typeof Sdk.parseSkillMd).toBe('function');
    expect(typeof Sdk.drawBox).toBe('function');
    expect(typeof Sdk.drawPoint).toBe('function');
    expect(typeof Sdk.notShown).toBe('function');
    expect(typeof Sdk.screenClickElement).toBe('function');
    expect(typeof Sdk.screenHighlightElement).toBe('function');
    expect(typeof Sdk.screenHighlightBox).toBe('function');
    expect(typeof Sdk.notClicked).toBe('function');
    expect(typeof Sdk.SkillParseError).toBe('function');
  });

  it('exports the agent/session type vocabulary (compile-time)', () => {
    const config: Sdk.AgentConfig = {
      instructions: 'be terse',
      voice: 'Puck',
      greeting: 'Hi!',
      audio: { noiseCancellation: true },
    };
    const tool: Sdk.RealtimeTool = { kind: 'web_search' };
    const optIns: Sdk.RealtimeTool[] = [
      { kind: 'web_search' } satisfies Sdk.WebSearchToolSpec,
      { kind: 'examine_image' } satisfies Sdk.ExamineImageToolSpec,
      { kind: 'detect_objects' } satisfies Sdk.DetectObjectsToolSpec,
      { kind: 'point_at_object' } satisfies Sdk.PointAtObjectToolSpec,
      // The one opt-in that carries configuration: the locator grounds against
      // a screenshot and element list only the client can produce.
      {
        kind: 'screen_locate',
        capture: () => ({ imageJpeg: new Uint8Array(), elements: [] }),
      } satisfies Sdk.ScreenLocateTool,
    ];
    const lifecycle: Sdk.SessionLifecycleState = {
      kind: 'disconnected',
      disconnectReason: 'client_ended',
    };
    const reason: Sdk.DisconnectReason = 'server_ended';
    const silence: Sdk.SilenceTimeout = {
      trigger: 'user.speech.timeout',
      timeout_seconds: 10,
      action: { type: 'end_call', farewell: 'Goodbye.' },
    };
    const sessionEnd: Sdk.SessionEndContext = {
      event: 'SessionEnd',
      reason: 'client_ended',
      detail: null,
      sessionId: null,
    };
    expect(config.audio?.noiseCancellation).toBe(true);
    expect(tool.kind).toBe('web_search');
    expect(optIns.map((t) => t.kind)).toEqual([
      'web_search',
      'examine_image',
      'detect_objects',
      'point_at_object',
      'screen_locate',
    ]);
    expect(lifecycle.disconnectReason).toBe('client_ended');
    expect(reason).toBe('server_ended');
    expect(silence.timeout_seconds).toBe(10);
    expect(sessionEnd.event).toBe('SessionEnd');
  });

  it('does not export the retired RealtimeConnectArgs shape', () => {
    expect('RealtimeConnectArgs' in Sdk).toBe(false);
    expect(barrelSource()).not.toMatch(/RealtimeConnectArgs/);
  });

  it('does not export the retired TransferCallToolSpec shape', () => {
    expect('TransferCallToolSpec' in Sdk).toBe(false);
    expect(barrelSource()).not.toMatch(/TransferCallToolSpec/);
  });

  it('does not export the retired ScreenInteraction conformer shape', () => {
    // The composite screen capability is gone: a capture handler plus the
    // renderer slots replaced the one object with four methods.
    expect(barrelSource()).not.toMatch(/ScreenInteraction/);
    expect(barrelSource()).not.toMatch(/ScreenHighlightResult/);
  });

  it('keeps Cosmo-only symbols out of the neutral barrel', () => {
    expect('COSMO_ASSISTANT_TOOL' in Sdk).toBe(false);
    expect('COSMO_APP_CONNECTOR_TOOL' in Sdk).toBe(false);
  });

  it('keeps Cosmo-internal config off the neutral agent config (compile-time)', () => {
    // Cosmo product concepts never ride the neutral agent config — the
    // cosmo wire block is gone entirely; a regression here fails
    // ``tsc --noEmit``.
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('projectId');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('conversationId');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('surface');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('workflowId');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('playgroundAgentId');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('attachedResourceIds');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('structuredInputs');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('ambience');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('outboundPhoneNumber');
  });

  it('does not leak the app-internal session manager through the public barrel', () => {
    expect('realtimeSessionManager' in Sdk).toBe(false);
    expect('appRealtimeSessionManager' in Sdk).toBe(false);
  });

  it('does not expose raw analyser methods', () => {
    expect('getInputAnalyser' in Sdk).toBe(false);
    expect('getOutputAnalyser' in Sdk).toBe(false);
  });

  it('does not expose the unimplemented client-tools shape', () => {
    // ClientToolDef + connect-args clientTools were a "reserved but throws
    // on use" foot-gun — keep them out of the public barrel until the
    // dispatch path actually ships.
    expect('ClientToolDef' in Sdk).toBe(false);
  });

  it('does not leak start/end/connect session verbs on RealtimeClient', () => {
    // ``client.agent({...}).start()`` is the only public way to open a
    // session; the engine method behind it is the @internal _startSession.
    const proto = (Sdk.RealtimeClient.prototype ?? {}) as unknown as Record<string, unknown>;
    expect('start' in proto).toBe(false);
    expect('end' in proto).toBe(false);
    expect('connect' in proto).toBe(false);
  });

  it('does not leak livekit-client symbols through the barrel', () => {
    expect(barrelSource()).not.toMatch(/from ['"]livekit-client['"]/);
  });

  it('keeps zod off the barrel so it stays an optional peer', () => {
    // Re-exporting zodInput here would make `zod` resolve for every
    // consumer of `cosmo-ai`, not just importers of `cosmo-ai/tool/zod`.
    expect(barrelSource()).not.toMatch(/from ['"]zod(\/|['"])/);
    expect(barrelSource()).not.toMatch(/from ['"]\.\/tool\/zod['"]/);
  });

  it('does not re-export livekit DataPacket_Kind from the transport surface', () => {
    expect('DataPacket_Kind' in Sdk).toBe(false);
  });
});
