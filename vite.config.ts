/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the build works under https://<org>.github.io/<repo>/
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1500 },
  // Rules tests (rules-tests/) need the Firestore emulator; see npm run test:rules.
  test: { include: ['src/**/*.test.ts'] },
});
