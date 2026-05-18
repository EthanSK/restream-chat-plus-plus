import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Enables React 18+/19 `act()` semantics in react-test-renderer.
    // Without this, TestRenderer.create() returns a tree whose
    // `toJSON()` is `null` and effects don't flush. v0.1.39.
    setupFiles: ['src/__tests__/_setup-react-act-env.ts'],
  },
});
