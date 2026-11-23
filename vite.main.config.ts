import { defineConfig } from 'vite';

// Keep node built-ins external; ws + electron-store get bundled in.
export default defineConfig({
  build: {
    rollupOptions: {
      // Keep SQLite resolved by the packaged Electron runtime. The Node 22
      // build runner does not expose it through builtinModules for Forge.
      external: ['electron', 'node:sqlite'],
    },
  },
});
