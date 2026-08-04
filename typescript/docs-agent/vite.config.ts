import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Two proxies, for two different reasons:
//
// /api  → the Cosmo backend. Its ALLOWED_ORIGINS admits no third-party
//         origin, so a browser calling it directly gets "Disallowed CORS
//         origin", which surfaces as a bare "Failed to fetch". Proxying makes
//         the app same-origin. (The LiveKit connection that follows is a
//         WebSocket to an absolute URL and is not subject to CORS.)
//
// /local → this example's own backend, for fetching a pasted URL.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const cosmo = env.VITE_COSMO_BASE_URL || 'https://platform.askcosmo.ai';

  return {
    plugins: [react()],
    server: {
      port: 7870,
      proxy: {
        '/api': { target: cosmo, changeOrigin: true },
        '/local': 'http://localhost:7871',
      },
    },
  };
});
