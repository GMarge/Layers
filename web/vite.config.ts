import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API is proxied so the browser only ever talks to one origin (no CORS).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
});
