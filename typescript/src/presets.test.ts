import { describe, expect, it } from 'vitest';

import {
  NATURALNESS_INSTRUCTIONS,
  NATURALNESS_RUNGS,
  naturalness,
  type NaturalnessRung,
} from './presets';

describe('voice-naturalness preset catalog', () => {
  it('exposes exactly the three rungs, in order', () => {
    expect(NATURALNESS_RUNGS).toEqual(['warm', 'delivery', 'human']);
  });

  it('resolves the human rung to its verbatim instruction text', () => {
    expect(naturalness('human')).toBe(NATURALNESS_INSTRUCTIONS.human);
    expect(naturalness('human')).toContain('You talk like a real person, not a script.');
  });

  it.each(NATURALNESS_RUNGS)('rung %s resolves to a non-empty string', (rung: NaturalnessRung) => {
    expect(naturalness(rung)).toBe(NATURALNESS_INSTRUCTIONS[rung]);
    expect(naturalness(rung).length).toBeGreaterThan(0);
  });

  it('gives each rung distinct prompt text', () => {
    const texts = NATURALNESS_RUNGS.map((rung) => naturalness(rung));
    expect(new Set(texts).size).toBe(NATURALNESS_RUNGS.length);
  });
});
