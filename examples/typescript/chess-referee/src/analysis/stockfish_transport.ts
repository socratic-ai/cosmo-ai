/**
 * Browser transport: the `stockfish` package's engine .js is itself a
 * worker script speaking UCI over postMessage, so the Worker IS the engine.
 *
 * The single-threaded lite build is deliberate: the multithreaded builds
 * need SharedArrayBuffer and therefore COOP/COEP headers on every response,
 * which most dev servers and static hosts don't send. Single-threaded lite
 * reaches coaching depth sub-second and runs anywhere.
 *
 * The engine .js + .wasm are copied to `public/stockfish/` at install time
 * (scripts/copy_stockfish.mjs): the emscripten loader fetches the .wasm
 * relative to the script URL, which a bundler-transformed worker URL would
 * break.
 */

import { UciEngine, type UciTransport } from './engine';

export const STOCKFISH_WORKER_URL = '/stockfish/stockfish-18-lite-single.js';

export function createStockfishTransport(
  workerUrl: string = STOCKFISH_WORKER_URL,
): UciTransport {
  const worker = new Worker(workerUrl);
  return {
    send: (command) => worker.postMessage(command),
    onLine: (listener) => {
      worker.addEventListener('message', (event: MessageEvent<string>) => {
        listener(String(event.data));
      });
    },
    terminate: () => worker.terminate(),
  };
}

let engine: UciEngine | null = null;

/** One engine for the app, started on first use (or by {@link warmAnalysisEngine}). */
export function analysisEngine(): UciEngine {
  if (engine === null) {
    engine = new UciEngine(createStockfishTransport());
  }
  return engine;
}

/** Start the worker + wasm load early so the first tool call doesn't pay it. */
export function warmAnalysisEngine(): void {
  analysisEngine();
}

export function disposeAnalysisEngine(): void {
  engine?.close();
  engine = null;
}
