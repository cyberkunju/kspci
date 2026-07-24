import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build output goes to dist/, which catalyst.json points to as the client source.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      // Local dev: forward API calls to `catalyst serve`
      '/server': 'http://localhost:3000'
    }
  }
});
