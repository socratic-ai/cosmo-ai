import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type HtmlTagDescriptor } from 'vite';

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
      port: 7882,
      // Phone browsers only allow camera and microphone on HTTPS, and this app
      // is meant to be cooked with, so on-device testing goes through a tunnel.
      // Whichever one you have:
      //   cloudflared tunnel --url http://localhost:7882
      //   ngrok http 7882
      allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app'],
    },
  };
});
