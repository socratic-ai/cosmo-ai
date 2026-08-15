import { defineConfig, loadEnv, type HtmlTagDescriptor } from 'vite';
import react from '@vitejs/plugin-react';

// No proxy: /api/v1/external/* answers wildcard CORS, so the browser calls
// the Cosmo backend directly, and /token (local dev via `wrangler pages dev`,
// deployed via Cloudflare Pages) is same-origin already.
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
    server: { port: 7872 },
  };
});
