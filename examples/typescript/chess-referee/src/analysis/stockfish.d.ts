/** The `stockfish` package ships no types; only the Node loader is imported
 *  (in tests) — the browser loads the engine .js directly as a worker. */
declare module 'stockfish' {
  function initEngine(flavor?: string): Promise<{
    sendCommand: (command: string) => void;
    listener: ((line: string) => void) | undefined;
  }>;
  export default initEngine;
}
