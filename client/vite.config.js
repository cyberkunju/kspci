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
      // API target for `/server/*`. Defaults to a local `catalyst serve`
      // (localhost:3000). Set KSP_API_TARGET to develop the frontend against
      // the live Catalyst deployment (real data, no local backend), e.g.:
      //   KSP_API_TARGET=https://ksp.cyberkunju.com npm run dev
      '/server': {
        target: process.env.KSP_API_TARGET || 'http://localhost:3000',
        changeOrigin: true,
        secure: true,
      },
    },
  }
});
