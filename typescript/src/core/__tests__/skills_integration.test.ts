/** Skills wired through ``agent.start()``: the hot menu folds into the
 *  sent instructions, ``cosmo_sdk_load_skill`` joins the declared tools and
 *  executes over the RPC bridge. Python's ``tests/test_skills_integration.py``
 *  is the cross-SDK reference. */

import { describe, expect, it, vi } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { RealtimeClient } from '../realtime_client';
import {
  LOAD_SKILL_TOOL_NAME,
  PRIVATE_INSTRUCTIONS_PREFIX,
  type Skill,
} from '../skills';
import { inlineAgent, makeFakeTransport } from './test_helpers';

vi.mock('livekit-client', () => ({
  Room: class {},
  RoomEvent: {},
  Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
  ConnectionState: { Connected: 'connected' },
  LocalVideoTrack: class {},
  RemoteTrack: class {},
}));

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'billing',
    description: 'Handle plan and invoice questions.',
    body: 'Always confirm the account id first.',
    ...overrides,
  };
}

describe('skills through agent.start()', () => {
  it('duplicate skill names throw at agent build', () => {
    const client = new RealtimeClient({ transportFactory: () => makeFakeTransport() });
    expect(() => client.agent({ skills: [makeSkill(), makeSkill()] })).toThrow(
      /duplicate skill name/,
    );
  });

  it('rejects a caller tool that claims the reserved cosmo_sdk_load_skill name', async () => {
    // The SDK's own load-skill tool now lives in the reserved cosmo_sdk_
    // namespace, so a caller tool taking that name is rejected at config
    // assembly — it never silently drops the skills.
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });

    await expect(
      client
        .agent({
          instructions: 'Be helpful.',
          skills: [makeSkill()],
          tools: [
            { kind: 'client', name: LOAD_SKILL_TOOL_NAME, description: 'mine', parameters: {} },
          ],
        })
        .start(),
    ).rejects.toThrow(/reserved/);
  });

  it('adds the load_skill tool and the menu to the sent config', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const skills = [makeSkill()];

    await client.agent({ instructions: 'Be helpful.', skills }).start();

    const agent = inlineAgent(fake.lastConfig());
    expect(agent?.instructions).toContain('Be helpful.');
    expect(agent?.instructions).toContain('## Skills');
    expect(agent?.instructions).toContain('- billing: Handle plan and invoice questions.');
    expect(agent?.tools).toEqual([
      expect.objectContaining({ kind: 'client', name: LOAD_SKILL_TOOL_NAME }),
    ]);
  });

  it('makes the menu the sole instructions when none are supplied', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const skills = [makeSkill()];

    await client.agent({ skills }).start();

    const instructions = inlineAgent(fake.lastConfig())?.instructions;
    expect(instructions?.startsWith('## Skills')).toBe(true);
  });

  it('leaves a caller tool named load_skill in place alongside the skills tool and menu', async () => {
    // ``load_skill`` is now an ordinary caller name — the SDK moved its tool
    // into the reserved namespace — so a caller tool taking it coexists with
    // the skills' own cosmo_sdk_load_skill tool and menu.
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });

    await client
      .agent({
        instructions: 'Be helpful.',
        skills: [makeSkill()],
        tools: [
          {
            kind: 'client',
            name: 'load_skill',
            description: 'caller-owned',
            parameters: { type: 'object' },
          },
        ],
      })
      .start();

    const agent = inlineAgent(fake.lastConfig());
    const clientToolNames = (agent?.tools ?? [])
      .filter((t) => t.kind === 'client')
      .map((t) => (t as { name: string }).name);
    expect(clientToolNames).toContain('load_skill');
    expect(clientToolNames).toContain(LOAD_SKILL_TOOL_NAME);
    expect(agent?.instructions?.startsWith('Be helpful.\n\n## Skills')).toBe(true);
  });

  it('an empty skills array adds no tool and no menu', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });

    await client.agent({ instructions: 'Be helpful.', skills: [] }).start();

    const agent = inlineAgent(fake.lastConfig());
    expect(agent?.instructions).toBe('Be helpful.');
    expect(agent?.tools).toBeUndefined();
  });

  it('serves a skill body over the RPC bridge', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const skills = [makeSkill()];

    await client.agent({ skills }).start();

    const reply = await fake.invokeRpc(LOAD_SKILL_TOOL_NAME, '{"name": "billing"}');
    expect(JSON.parse(reply)).toEqual({
      ok: true,
      result: {
        instructions: `${PRIVATE_INSTRUCTIONS_PREFIX}Always confirm the account id first.`,
      },
      error: null,
    });
  });
});
