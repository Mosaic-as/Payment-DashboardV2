import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the build works under https://<org>.github.io/<repo>/
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1500 },
});
