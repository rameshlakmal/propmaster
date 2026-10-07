import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The web app builds into dist/web, which `propmaster ui` serves.
// In development (`npm run web:dev`) Vite serves the app and forwards /api to a running `propmaster ui`.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4400' } },
});
