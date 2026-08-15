/** Unit tests for the agent + per-run options → external ``session-config``
 *  mapping. Client-level wiring (``agent.start()`` → transport) is covered by
 *  ``agent_start.test.ts``; these pin the pure mapping itself. Python's
 *  ``tests/test_agent.py`` is the cross-SDK reference for the partition:
 *  persona fields ride under ``agent``, per-run transport fields under
 *  ``session``. */

import { describe, expect, it } from 'vitest';

import { buildAgentSessionConfig, type RealtimeTool } from '../agent';
import type { ScreenCapture } from '../../tool/screen';
import { SDK_NAME, SDK_VERSION } from '../../constants';

describe('buildAgentSessionConfig', () => {
  it('always stamps the type discriminator and SDK identity', () => {
    const config = buildAgentSessionConfig({}, {});
    expect(config.type).toBe('session-config');
    expect(config.sdk).toEqual({ name: SDK_NAME, version: SDK_VERSION });
  });

  it('serializes an unconfigured agent to type/sdk and nothing else', () => {
    // No audio block: a caller that configured no audio sends none, so every
    // knob takes its server default and the body stays compatible with a
    // backend that predates any one of them.
    const config = buildAgentSessionConfig({}, {});
    expect(JSON.parse(JSON.stringify(config))).toEqual({
      type: 'session-config',
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      agent: { type: 'inline' },
    });
  });

  it('routes persona fields onto the agent block', () => {
    const config = buildAgentSessionConfig(
      {
        instructions: 'You are terse.',
        model: 'gemini',
        modelOptions: {
          provider: 'gemini',
          temperature: 0.7,
          maxOutputTokens: 4096,
          thinkingLevel: 'high',
        },
        voice: { name: 'Charon', speakingStyle: 'warm' },
        interruptionSensitivity: 'high',
      },
      {},
    );
    expect(config.agent).toEqual({
      type: 'inline',
      instructions: 'You are terse.',
      model: 'gemini',
      model_options: {
        provider: 'gemini',
        temperature: 0.7,
        max_output_tokens: 4096,
        thinking_level: 'high',
      },
      voice: { name: 'Charon', speaking_style: 'warm' },
      interruption_sensitivity: 'high',
    });
  });

  it('maps the Gemini endpointing knobs onto their wire names', () => {
    const config = buildAgentSessionConfig(
      {
        modelOptions: {
          provider: 'gemini',
          includeThoughts: false,
          endOfSpeechSensitivity: 'high',
          silenceDurationMs: 200,
          prefixPaddingMs: 100,
        },
      },
      {},
    );
    expect(config.agent).toEqual({
      type: 'inline',
      model_options: {
        provider: 'gemini',
        include_thoughts: false,
        end_of_speech_sensitivity: 'high',
        silence_duration_ms: 200,
        prefix_padding_ms: 100,
      },
    });
  });

  it('maps the Gemini server_vad turn-detection opt-out onto the wire', () => {
    const config = buildAgentSessionConfig(
      { modelOptions: { provider: 'gemini', turnDetection: 'server_vad' } },
      {},
    );
    expect(config.agent).toEqual({
      type: 'inline',
      model_options: { provider: 'gemini', turn_detection: 'server_vad' },
    });
  });

  it('maps the Gemini cosmo_vad selection and its tuning block onto the wire', () => {
    const config = buildAgentSessionConfig(
      {
        modelOptions: {
          provider: 'gemini',
          turnDetection: 'cosmo_vad',
          cosmoVad: { pauseMs: 250, prefixMs: 300, maxHoldMs: 900 },
        },
      },
      {},
    );
    expect(config.agent).toEqual({
      type: 'inline',
      model_options: {
        provider: 'gemini',
        turn_detection: 'cosmo_vad',
        cosmo_vad: { pause_ms: 250, prefix_ms: 300, max_hold_ms: 900 },
      },
    });
  });

  it('sends only the knobs the selected OpenAI turn detector reads', () => {
    const serverVad = buildAgentSessionConfig(
      {
        modelOptions: {
          provider: 'openai',
          turnDetection: 'server_vad',
          silenceDurationMs: 200,
          prefixPaddingMs: 100,
        },
      },
      {},
    );
    expect(serverVad.agent).toEqual({
      type: 'inline',
      model_options: {
        provider: 'openai',
        turn_detection: 'server_vad',
        silence_duration_ms: 200,
        prefix_padding_ms: 100,
      },
    });

    const semanticVad = buildAgentSessionConfig(
      { modelOptions: { provider: 'openai', turnDetection: 'semantic_vad', eagerness: 'high' } },
      {},
    );
    expect(semanticVad.agent).toEqual({
      type: 'inline',
      model_options: {
        provider: 'openai',
        turn_detection: 'semantic_vad',
        eagerness: 'high',
      },
    });
  });

  it('leaves an unconfigured OpenAI block at the bare discriminator', () => {
    const config = buildAgentSessionConfig({ modelOptions: { provider: 'openai' } }, {});
    expect(config.agent).toEqual({
      type: 'inline',
      model_options: { provider: 'openai' },
    });
  });

  it('passes server and client tool specs through in order', () => {
    const config = buildAgentSessionConfig(
      {
        tools: [
          { kind: 'web_search' },
          { kind: 'examine_image' },
          {
            kind: 'client',
            name: 'lookup',
            description: 'Look something up.',
            parameters: { type: 'object' },
          },
        ],
      },
      {},
    );
    expect(config.agent?.tools).toEqual([
      { kind: 'web_search' },
      { kind: 'examine_image' },
      {
        kind: 'client',
        name: 'lookup',
        description: 'Look something up.',
        parameters: { type: 'object' },
      },
    ]);
  });

  it('serializes every typed server-tool opt-in as its bare kind', () => {
    const config = buildAgentSessionConfig(
      {
        tools: [
          { kind: 'web_search' },
          { kind: 'examine_image' },
          { kind: 'detect_objects' },
          { kind: 'point_at_object' },
          { kind: 'end_call' },
        ],
      },
      {},
    );
    expect(JSON.parse(JSON.stringify(config.agent?.tools))).toEqual([
      { kind: 'web_search' },
      { kind: 'examine_image' },
      { kind: 'detect_objects' },
      { kind: 'point_at_object' },
      { kind: 'end_call' },
    ]);
  });

  it('declares the screen locator as a bare kind, in authored order, without capturing', () => {
    const captures: ScreenCapture[] = [];
    const config = buildAgentSessionConfig(
      {
        tools: [
          { kind: 'web_search' },
          {
            kind: 'screen_locate',
            capture: () => {
              const taken: ScreenCapture = {
                imageJpeg: new Uint8Array([0xff, 0xd8]),
                elements: [],
              };
              captures.push(taken);
              return taken;
            },
          },
        ],
      },
      {},
    );
    expect(captures).toHaveLength(0);
    expect(JSON.parse(JSON.stringify(config.agent?.tools))).toEqual([
      { kind: 'web_search' },
      { kind: 'screen_locate' },
    ]);
  });

  it('keeps the locator unauthorable without a handler — it only exists to drive one', () => {
    // @ts-expect-error the declaration follows the handler, never config alone
    const authored: RealtimeTool = { kind: 'screen_locate' };
    expect(authored).toBeDefined();
  });

  it('keeps transfer_call off the authorable tool union', () => {
    // The kind is not part of the authorable surface, so a config carrying
    // one is a compile error here and fails schema validation at connect.
    // @ts-expect-error the kind is retired from the authorable surface
    const authored: RealtimeTool = { kind: 'transfer_call' };
    expect(authored).toBeDefined();
  });

  it('keeps the generic server reference off the authorable tool union', () => {
    // @ts-expect-error the kind is retired from the authorable surface
    const authored: RealtimeTool = { kind: 'server', name: 'cosmo.web_search' };
    expect(authored).toBeDefined();
  });

  it('omits agent.tools for an empty tool list', () => {
    const config = buildAgentSessionConfig({ tools: [], voice: 'Breezy' }, {});
    expect(config.agent).toEqual({
      type: 'inline',
      voice: { name: 'Breezy' },
    });
  });

  it('strips local-only tool fields from the wire body', () => {
    // A background tool serializes identically to a plain client tool:
    // the server infers deferral from the reply, so neither ``handler``
    // nor the ``background`` marker may cross the wire.
    const config = buildAgentSessionConfig(
      {
        tools: [
          {
            kind: 'client',
            name: 'lookup',
            description: 'd',
            parameters: { type: 'object' },
            handler: async () => null,
          },
          {
            kind: 'client',
            background: true,
            name: 'export_report',
            description: 'd',
            parameters: { type: 'object' },
            handler: async (_args, job) => {
              job.ack();
            },
          },
        ],
      },
      {},
    );
    expect(config.agent?.tools).toEqual([
      { kind: 'client', name: 'lookup', description: 'd', parameters: { type: 'object' } },
      {
        kind: 'client',
        name: 'export_report',
        description: 'd',
        parameters: { type: 'object' },
      },
    ]);
  });

  it('routes the persona greeting onto the agent block', () => {
    const config = buildAgentSessionConfig({ greeting: 'Welcome back!' }, {});
    expect(config.agent).toEqual({
      type: 'inline',
      greeting: 'Welcome back!',
    });
    expect(config.session).toBeUndefined();
  });

  it('puts noise cancellation on the agent block and continuity on the session block', () => {
    // Audio handling is agent config (configured once), not a per-run
    // param — matches Python/Swift and the external protocol's agent block.
    const config = buildAgentSessionConfig(
      {
        instructions: 'You are a support agent.',
        voice: 'Puck',
        audio: { noiseCancellation: true },
      },
      { resumeSessionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' },
    );
    expect(config.agent).toEqual({
      type: 'inline',
      instructions: 'You are a support agent.',
      voice: { name: 'Puck' },
      audio: { noise_cancellation: true },
    });
    expect(config.session).toEqual({
      experimental: { resume_session_id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' },
    });
  });

  it('sends an explicit false when noise cancellation is opted out of', () => {
    // The server default is on, so the opt-out has to reach the wire as a
    // value — an omitted field would read back as the default.
    const config = buildAgentSessionConfig(
      { voice: 'Puck', audio: { noiseCancellation: false } },
      {},
    );
    expect(config.agent).toEqual({
      type: 'inline',
      voice: { name: 'Puck' },
      audio: { noise_cancellation: false },
    });
  });

  it('leaves a catalog launch free of an audio block', () => {
    // The stored agent's audio options run verbatim; a block synthesized
    // here would trip the same guard that rejects a caller-set value.
    const config = buildAgentSessionConfig({ name: 'driver-pay' }, {});
    expect(config.agent).toEqual({ type: 'catalog', name: 'driver-pay' });
  });

  it('routes the per-run recording opt-out onto the session block', () => {
    const config = buildAgentSessionConfig({}, { storeRecording: false });
    expect(config.session).toEqual({ store_recording: false });
    // Unset stays off the wire — the server default (record) applies.
    expect(buildAgentSessionConfig({}, {}).session).toBeUndefined();
  });

  it('routes the catalog-agent name and inputs onto the tagged agent block', () => {
    const config = buildAgentSessionConfig(
      { name: 'driver-pay', inputs: { caller_name: 'Sam', city: 'NYC' } },
      {},
    );
    expect(config.agent).toEqual({
      type: 'catalog',
      name: 'driver-pay',
      inputs: { caller_name: 'Sam', city: 'NYC' },
    });
  });

  it('serializes a bare catalog launch to just the tag and name so the stored config runs verbatim', () => {
    const config = buildAgentSessionConfig({ name: 'driver-pay' }, {});
    expect(JSON.parse(JSON.stringify(config.agent))).toEqual({
      type: 'catalog',
      name: 'driver-pay',
    });
  });


  it('throws when stored-config fields reach a catalog launch', () => {
    // The factory split makes these unrepresentable at the type level; the
    // runtime guard covers hand-built personas.
    expect(() =>
      buildAgentSessionConfig({ name: 'driver-pay', instructions: 'be terse' }, {}),
    ).toThrow(/stored config verbatim.*instructions/);
    expect(() =>
      buildAgentSessionConfig({ name: 'driver-pay', greeting: 'Hi!' }, {}),
    ).toThrow(/stored config verbatim.*greeting/);
    expect(() =>
      buildAgentSessionConfig(
        { name: 'driver-pay', audio: { noiseCancellation: true } },
        {},
      ),
    ).toThrow(/audio/);
  });

  it('lets the catalog-exempt fields ride alongside the name', () => {
    const config = buildAgentSessionConfig(
      {
        name: 'driver-pay',
        inputs: { caller_name: 'Sam' },
        tools: [{ kind: 'web_search' }],
        voice: { name: 'Puck', speakingStyle: 'warm' },
      },
      {},
    );
    expect(config.agent).toEqual({
      type: 'catalog',
      name: 'driver-pay',
      inputs: { caller_name: 'Sam' },
      tools: [{ kind: 'web_search' }],
      voice: { name: 'Puck', speaking_style: 'warm' },
    });
  });

  it('prunes the empty session block so absent fields take server defaults', () => {
    const config = buildAgentSessionConfig({}, {});
    expect(config.agent).toEqual({ type: 'inline' });
    expect(config.session).toBeUndefined();
  });

  // The partially-set-cosmo-block prune case is gone with the outbound
  // fields: ``surface`` is the block's only remaining member, so a set field
  // alongside an undefined one can't be expressed. The empty-block case above
  // still covers ``prune``.
});

describe('reserved SDK tool names', () => {
  // The SDK owns the name and schema of the tools it ships, so a caller's
  // tool taking one would swap it for something the model was told behaves
  // differently. Caught here rather than at the server's 422.
  const callerTool = (name: string) =>
    ({
      kind: 'client' as const,
      name,
      description: 'mine',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({}),
    });

  it('rejects a caller tool claiming the SDK prefix', () => {
    expect(() =>
      buildAgentSessionConfig({ tools: [callerTool('cosmo_sdk_draw_box')] }, {}),
    ).toThrow(/reserved for tools/);
  });

  it('leaves the natural name free for a caller', () => {
    expect(() =>
      buildAgentSessionConfig({ tools: [callerTool('draw_box')] }, {}),
    ).not.toThrow();
  });
});
