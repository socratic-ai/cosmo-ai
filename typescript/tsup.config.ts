import { defineConfig } from 'tsup';

// Public entry points. The barrel (`index`) is what external consumers use;
// the deep entries exist so the Cosmo frontend can import the same subpaths
// it always has (`cosmo-ai/core/state`, etc.) against the built
// package. Keep this list in sync with the `exports` map in package.json
// (a `./*` wildcard maps every subpath to its dist file).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    presets: 'src/presets.ts',
    'core/realtime_client': 'src/core/realtime_client.ts',
    'core/events': 'src/core/events.ts',
    'core/types': 'src/core/types.ts',
    'core/state': 'src/core/state.ts',
    'core/transcript_fold': 'src/core/transcript_fold.ts',
    'core/transcript_reducer': 'src/core/transcript_reducer.ts',
    'transport/types': 'src/transport/types.ts',
    'react/RealtimeProvider': 'src/react/RealtimeProvider.tsx',
    'react/hooks': 'src/react/hooks.ts',
    'react/transcript_reducer': 'src/react/transcript_reducer.ts',
    'react/components/RealtimeAudio': 'src/react/components/RealtimeAudio.tsx',
    'react/components/StartAudio': 'src/react/components/StartAudio.tsx',
    tool: 'src/tool/index.ts',
    'tool/draw': 'src/tool/draw.ts',
    'tool/screen': 'src/tool/screen.ts',
    'tool/video_geometry': 'src/tool/video_geometry.ts',
    'tool/zod': 'src/tool/zod.ts',
    'wire/types.gen': 'src/wire/types.gen.ts',
    'desktop/local_desktop_preset_union.gen':
      'src/desktop/local_desktop_preset_union.gen.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  splitting: true,
  // No sourcemaps: tsup embeds absolute build paths in chunk maps, which
  // would make the packed tarball's bytes depend on the checkout location —
  // the lockfile pins the tarball's integrity hash, so the pack must be
  // byte-reproducible on every machine that builds it.
  sourcemap: false,
  clean: true,
  external: ['react', 'react-dom', 'livekit-client', 'zod'],
  tsconfig: './tsconfig.json',
  outDir: 'dist',
});
