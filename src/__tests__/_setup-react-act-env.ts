// React 18+/19 require `globalThis.IS_REACT_ACT_ENVIRONMENT = true` for
// `act()` from react-test-renderer to actually batch updates and run
// effects synchronously. Without it, TestRenderer.create() returns
// `{ toJSON: () => null }` until the first act() and effects don't
// flush — which makes every stateful test silently fail with a `null`
// tree. Setting this in a Vitest setup file ensures every test file
// has the flag without each one having to remember to set it.
//
// Loaded via `setupFiles` in vitest.config.ts. v0.1.39.
//
// The cast through `unknown` is needed because TypeScript doesn't know
// about the React-internal `IS_REACT_ACT_ENVIRONMENT` global. We avoid
// a `declare global` block to keep this file an isolated module rather
// than a global-augmenting one (which would require it to live next to
// other `.d.ts` augmentations).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

export {};
