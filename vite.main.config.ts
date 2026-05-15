import { defineConfig } from 'vite';

// Keep node built-ins external; ws + electron-store get bundled in.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['electron'],
    },
  },
});
