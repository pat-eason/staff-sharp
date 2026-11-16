import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development, /api goes to the running compose stack (its nginx proxies to the Go API).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:8484', changeOrigin: true } },
  },
});
