import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API is proxied so the browser only ever talks to one origin (no CORS).
// LAYERS_API and LAYERS_WEB_PORT let a second copy run beside the first, for screenshots.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.LAYERS_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': process.env.LAYERS_API ?? 'http://127.0.0.1:8000' },
  },
});
