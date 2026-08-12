/**
 * Minimal UCI client for a Stockfish wasm engine.
 *
 * The transport is one message-port-shaped seam (`send` strings in, lines
 * out) so the same client drives a browser `Worker` in the app and the
 * `stockfish` package's Node loader in tests.
 */

export interface UciTransport {
  send(command: string): void;
  onLine(listener: (line: string) => void): void;
  terminate(): void;
}

export type EngineLine = {
  multipv: number;
  depth: number;
  /** Centipawns from the side-to-move's point of view; mate folded in. */
  scoreCp: number;
  /** Signed moves-to-mate from the side to move, when the line ends in mate. */
  mateIn: number | null;
  /** Principal variation as UCI moves, e.g. ["e2e4", "e7e5"]. */
  pv: string[];
};

/** Mirrors the backend's MATE_SCORE so mate lines outrank any cp eval. */
export const MATE_SCORE = 100_000;

const READY_TIMEOUT_MS = 20_000;
const SEARCH_GRACE_MS = 5_000;

export class EngineError extends Error {}

export class UciEngine {
  private transport: UciTransport;
  /** Search is not concurrency-safe; calls queue behind this chain. */
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(line: string) => void>();
  private ready: Promise<void>;

  constructor(transport: UciTransport, options?: { multiPv?: number }) {
    this.transport = transport;
    transport.onLine((line) => {
      for (const listener of this.listeners) listener(line);
    });
    this.ready = this.handshake(options?.multiPv ?? 3);
  }

  private async handshake(multiPv: number): Promise<void> {
    const uciok = this.waitFor((line) => line === 'uciok', READY_TIMEOUT_MS);
    this.transport.send('uci');
    await uciok;
    this.transport.send(`setoption name MultiPV value ${multiPv}`);
    const readyok = this.waitFor((line) => line === 'readyok', READY_TIMEOUT_MS);
    this.transport.send('isready');
    await readyok;
  }

  /** Resolves with the first line matching `match`; rejects after `timeoutMs`. */
  private waitFor(
    match: (line: string) => boolean,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const listener = (line: string) => {
        if (!match(line)) return;
        cleanup();
        resolve(line);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new EngineError(`engine did not respond within ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
      };
      this.listeners.add(listener);
    });
  }

  /**
   * Top-`multiPv` lines for a full FEN, bounded by `movetimeMs`.
   *
   * Only the final depth's `info` lines are kept: the engine restates every
   * multipv rank each iteration, so lines from earlier, shallower iterations
   * are superseded.
   */
  analyze(fen: string, movetimeMs: number): Promise<EngineLine[]> {
    const run = this.chain.then(async () => {
      await this.ready;
      const lines = new Map<number, EngineLine>();
      const collector = (line: string) => {
        const parsed = parseInfoLine(line);
        if (parsed) lines.set(parsed.multipv, parsed);
      };
      this.listeners.add(collector);
      try {
        const done = this.waitFor(
          (line) => line.startsWith('bestmove'),
          movetimeMs + SEARCH_GRACE_MS,
        );
        this.transport.send('ucinewgame');
        this.transport.send(`position fen ${fen}`);
        this.transport.send(`go movetime ${movetimeMs}`);
        await done;
      } finally {
        this.listeners.delete(collector);
      }
      return [...lines.values()].sort((a, b) => a.multipv - b.multipv);
    });
    // Keep the chain alive past a failed call so the next one still runs.
    this.chain = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.transport.terminate();
  }
}

/** Parses one `info ... multipv N ... score cp|mate S ... pv ...` line. */
export function parseInfoLine(line: string): EngineLine | null {
  if (!line.startsWith('info ') || !line.includes(' pv ')) return null;
  const tokens = line.split(/\s+/);
  let multipv = 1;
  let depth = 0;
  let scoreCp: number | null = null;
  let mateIn: number | null = null;
  let pv: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    switch (tokens[i]) {
      case 'multipv':
        multipv = Number(tokens[++i]);
        break;
      case 'depth':
        depth = Number(tokens[++i]);
        break;
      case 'score': {
        const kind = tokens[++i];
        const value = Number(tokens[++i]);
        if (kind === 'cp') scoreCp = value;
        else if (kind === 'mate') {
          mateIn = value;
          scoreCp = value > 0 ? MATE_SCORE - value : -MATE_SCORE - value;
        }
        break;
      }
      case 'pv':
        pv = tokens.slice(i + 1);
        i = tokens.length;
        break;
    }
  }
  if (scoreCp === null || pv.length === 0) return null;
  return { multipv, depth, scoreCp, mateIn, pv };
}
