// v0.1.76 — re-export shim.
//
// The implementation moved to `src/shared/side-effect-decision.ts` so the
// MAIN process can run the SAME well-tested decision-gate ladder
// (`decideTtsAction` / `decideNotificationAction`) the renderer used to run.
// v0.1.76 moves all TTS decision/dispatch into the main process (Ethan voice
// 4414) so robustness never depends on the renderer being alive/visible —
// see src/main/tts-dispatch.ts. The decision logic itself is unchanged + still
// pure/DOM-free; only its location moved.
//
// This shim keeps every existing renderer/test import path
// (`./side-effect-decision`) working unchanged. New code should import from
// `../shared/side-effect-decision` directly.
export * from '../shared/side-effect-decision';
