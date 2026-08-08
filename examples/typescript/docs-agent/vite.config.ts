import { defineConfig, loadEnv, type HtmlTagDescriptor } from 'vite';
import react from '@vitejs/plugin-react';

// One proxy: /local → this example's own backend, for fetching a pasted URL.
// The Cosmo backend needs none — /api/v1/external/* answers wildcard CORS, so
// the browser calls it directly. (The LiveKit connection that follows is a
// WebSocket to an absolute URL and is not subject to CORS either.)
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      react(),
      {
        // The SDK reads its backend from a `cosmo-base-url` meta tag (no tag
        // → production). Inject one only when .env names a different backend.
        name: 'cosmo-base-url-meta',
        transformIndexHtml(): HtmlTagDescriptor[] {
          const base = env.VITE_COSMO_BASE_URL?.trim();
          if (!base) return [];
          return [
            { tag: 'meta', attrs: { name: 'cosmo-base-url', content: base }, injectTo: 'head' },
          ];
        },
      },
    ],
    server: {
      port: 7870,
      proxy: {
        '/local': 'http://localhost:7871',
      },
    },
  };
});
