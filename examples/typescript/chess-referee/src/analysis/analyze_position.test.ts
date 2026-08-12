import { describe, expect, it } from 'vitest';

import { makeAnalyzePositionTool } from './analyze_position';
import type { UciEngine } from './engine';

describe('makeAnalyzePositionTool', () => {
  // tool() validates the name and emitted JSON Schema against the backend's
  // restricted dialect at construction, so this pins "the server would
  // accept this tool" without a session.
  it('constructs a client tool spec the server accepts', () => {
    const spec = makeAnalyzePositionTool(() => {
      throw new Error('engine must not start at construction time');
    });
    expect(spec.kind).toBe('client');
    expect(spec.name).toBe('analyze_position');
    expect(spec.parameters).toMatchObject({
      type: 'object',
      required: ['position', 'side_to_move'],
    });
  });

  it('rejects a malformed model call before the engine is touched', async () => {
    const spec = makeAnalyzePositionTool(() => {
      throw new Error('engine must not start on invalid input');
    });
    await expect(
      spec.handler!({ position: 'x', side_to_move: 'purple' }),
    ).rejects.toThrow();
  });

  it('runs the handler against a stubbed engine', async () => {
    const engine = {
      analyze: async () => [
        { multipv: 1, depth: 12, scoreCp: 45, mateIn: null, pv: ['e2e4', 'e7e5'] },
      ],
    } as unknown as UciEngine;
    const result = (await makeAnalyzePositionTool(() => engine).handler!({
      position: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
      side_to_move: 'white',
    })) as Record<string, unknown>;
    expect(result.status).toBe('ok');
    expect(result.top_moves).toEqual([
      { rank: 1, move: 'e4', eval: '+0.45', line: ['e4', 'e5'] },
    ]);
  });
});
