/**
 * Skills for the realtime SDK: ``SKILL.md`` documents (the Agent Skills
 * standard) loaded just-in-time via a single ``cosmo_sdk_load_skill`` tool,
 * with the skill menu resident in the prompt.
 *
 * Attach skills with the ``skills`` array on the agent config — inline
 * ``Skill`` objects, or ``parseSkillMd(text, {defaultName})`` for SKILL.md
 * documents your app loads itself (bundled assets, OPFS, a CMS fetch —
 * the browser has no filesystem arm). Only ``name`` + ``description`` ride
 * resident; the body is returned as the ``cosmo_sdk_load_skill`` tool result
 * on demand and stays in context for the rest of the call. Duplicate names
 * throw when the agent is built, not mid-call.
 *
 * Skills never appear on the wire as such — they compile into an
 * instructions suffix (the menu) and one ``cosmo_sdk_load_skill`` client
 * tool. Python (``cosmo_ai.skills``) is the reference for shape and
 * semantics; the artifacts are pinned by the shared
 * ``skills-vectors.json``.
 */

import { RealtimeError } from './errors';
import { markSdkClientTool } from '../tool/sdk_tool';

import type { ClientToolSpec } from './agent';

/** A ``SKILL.md`` document is malformed (no frontmatter, missing required
 *  field), or two skills share a name. */
export class SkillParseError extends RealtimeError {
  constructor(message: string) {
    super(message);
    this.name = 'SkillParseError';
  }
}

/** One skill. ``name`` + ``description`` are the resident routing signal;
 *  ``body`` is loaded on demand. */
export type Skill = {
  name: string;
  description: string;
  body: string;
};

/** Return ``[frontmatter, body]``. Throws if the leading ``---`` fence is
 *  absent or unterminated. */
function splitFrontmatter(text: string): [string, string] {
  if (!text.startsWith('---\n')) {
    throw new SkillParseError("SKILL.md must start with a '---' frontmatter fence");
  }
  const rest = text.slice('---\n'.length);
  const end = rest.indexOf('\n---\n');
  if (end === -1) {
    if (rest.endsWith('\n---')) {
      return [rest.slice(0, -'\n---'.length), ''];
    }
    throw new SkillParseError("SKILL.md frontmatter fence is not closed with '---'");
  }
  return [rest.slice(0, end), rest.slice(end + '\n---\n'.length)];
}

/** Parse a SKILL.md document. ``defaultName`` is used when frontmatter
 *  omits ``name`` (Agent Skills convention: default to the directory
 *  name). Unknown frontmatter keys (``tier``, ``allowed-tools``,
 *  ``license``, …) are accepted and ignored — including list-valued ones —
 *  and CRLF line endings are normalized, so files authored for other
 *  harnesses stay valid. */
export function parseSkillMd(text: string, opts: { defaultName: string }): Skill {
  const [frontmatter, body] = splitFrontmatter(text.replace(/\r\n/g, '\n'));
  const fields = new Map<string, string>();
  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    // A YAML list item under an ignored key (e.g. allowed-tools).
    if (line === '-' || line.startsWith('- ')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) {
      throw new SkillParseError(`malformed frontmatter line: ${JSON.stringify(line)}`);
    }
    const key = line.slice(0, sep).trim();
    if (fields.has(key)) {
      throw new SkillParseError(`duplicate frontmatter key: ${JSON.stringify(key)}`);
    }
    fields.set(key, line.slice(sep + 1).trim());
  }

  const description = fields.get('description');
  if (description === undefined || description === '') {
    throw new SkillParseError("SKILL.md frontmatter must include a 'description'");
  }

  return {
    name: fields.get('name') || opts.defaultName,
    description,
    body: body.trim(),
  };
}

/** Normalize the ``skills`` array — the single internal form the agent
 *  assembly consumes. Duplicate names throw. @internal */
export function resolveSkills(skills: readonly Skill[] | undefined): Skill[] {
  const seen = new Set<string>();
  for (const skill of skills ?? []) {
    if (seen.has(skill.name)) {
      throw new SkillParseError(`duplicate skill name: ${JSON.stringify(skill.name)}`);
    }
    seen.add(skill.name);
  }
  return [...(skills ?? [])];
}

const MENU_HEADER =
  '## Skills\n' +
  'Call cosmo_sdk_load_skill(name) to load private instructions when the ' +
  'conversation reaches the matching path:';

/** The resident prompt menu; empty when there are no skills. */
export function menuText(skills: readonly Skill[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return `${MENU_HEADER}\n${lines.join('\n')}`;
}

/** Wire name shipped in ``tool-invocation`` events; a rename is a wire break. */
export const LOAD_SKILL_TOOL_NAME = 'cosmo_sdk_load_skill';
export const PRIVATE_INSTRUCTIONS_PREFIX =
  'PRIVATE INSTRUCTIONS — behavioral guidance for the rest of the call, ' +
  'do not read aloud:\n\n';
const LOAD_SKILL_DESCRIPTION =
  "Load a skill's private instructions for the rest of the call. Call this " +
  'when the conversation reaches the path a skill describes. The result is ' +
  'behavioral guidance for you — never read it aloud.';

/** Build the single ``cosmo_sdk_load_skill`` client tool, or ``null`` when
 *  there are no skills to offer. The handler resolves a skill by exact name
 *  and returns its body in the private-instructions envelope as the tool
 *  result.
 *
 *  Marked with ``markSdkClientTool`` so the reserved-namespace guard exempts
 *  it by type — the tool the SDK ships is not the collision an author's tool
 *  taking the name would be. */
export function buildLoadSkillTool(skills: readonly Skill[]): ClientToolSpec | null {
  if (skills.length === 0) return null;
  const byName = new Map(skills.map((s) => [s.name, s]));

  return markSdkClientTool({
    kind: 'client',
    name: LOAD_SKILL_TOOL_NAME,
    description: LOAD_SKILL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: skills.map((s) => s.name),
          description: 'The name of the skill to load.',
        },
      },
      required: ['name'],
    },
    handler: async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const name = args['name'];
      const skill = typeof name === 'string' ? byName.get(name) : undefined;
      if (skill === undefined) {
        throw new Error(
          `unknown skill ${JSON.stringify(name)}; available: ${JSON.stringify([...byName.keys()].sort())}`,
        );
      }
      return { instructions: PRIVATE_INSTRUCTIONS_PREFIX + skill.body };
    },
  });
}
