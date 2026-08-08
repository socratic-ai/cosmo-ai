import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The pipeline backend runs separately (npm run server). Proxying keeps the
// browser same-origin, so uploads and generated videos need no CORS setup.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 7860,
    proxy: {
      '/api': 'http://localhost:7861',
      '/generated': 'http://localhost:7861',
    },
  },
});
