// v0.1.76 — re-export shim.
//
// The implementation moved to `src/shared/message-filters.ts` so the
// MAIN process can import the exact same pure filtering logic the renderer
// uses (the v0.1.76 background-TTS-dispatch work runs the side-effect
// decision in main — see src/main/tts-dispatch.ts). The module was always
// DOM-free + pure, so the move is purely about which directory it lives in.
//
// This shim keeps every existing renderer/test import path
// (`./message-filters`) working unchanged — no call-site churn. New code
// should import from `../shared/message-filters` directly.
export * from '../shared/message-filters';
