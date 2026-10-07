import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Every build gets an id, written next to the app and compiled into it. The server remembers the id it
// started with, so the app can tell when it is newer than the running server (restart needed).
const BUILD_ID = new Date().toISOString();

const buildIdFile: Plugin = {
  name: 'propmaster-build-id',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'build-id.txt', source: BUILD_ID });
  },
};

// The web app builds into dist/web, which `propmaster ui` serves.
// In development (`npm run web:dev`) Vite serves the app and forwards /api to a running `propmaster ui`.
export default defineConfig({
  root: __dirname,
  plugins: [react(), buildIdFile],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4400' } },
});
