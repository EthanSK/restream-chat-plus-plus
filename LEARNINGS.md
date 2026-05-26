# Learnings

Per-repo institutional memory for fixes. Every entry below is a real bug we hit + how we solved it. Check this file BEFORE attempting a same-looking fix.

Maintained by the `learnings` skill — see `~/.claude/skills/learnings/skill.md`.

## Format

Each entry looks like:

```
---
**Date:** YYYY-MM-DDTHH:MM:SSZ
**Trigger:** <voice N / message snippet / null>
**Symptom:** <what was visible>
**Root cause:** <what we actually found>
**Fix:** <file:line + short prose + commit SHA>
**Guard:** <test / lint / watchdog / comment that prevents regression — or 'none'>
---
```

## Entries

(newest first)

---
**Date:** 2026-05-26T15:42:19Z
**Trigger:** voice 4198 2026-05-26
**Symptom:** Cold start showed Sign In button before main-process decrypt finished; user accidentally clicked it kicking off unwanted OAuth flow
**Root cause:** Renderer useState<AuthStatus> defaulted to { authenticated:false } synchronously at mount; main process's getTokenAsync + pushAuthStatus took ~1-2s, during which the 'signed out' UI was clickable
**Fix:** Added AuthBootState discriminator (checking|checking-slow|signed_in|signed_out|verify_failed) tracked alongside AuthStatus; renderer renders a centered spinner overlay above toolbar until first AUTH_STATUS arrives (initial pull OR push); 5s slow subtitle + 15s retry escalation; defence-in-depth: Sign In JSX returns null while bootPending. src/renderer/auth-bootstate.ts + App.tsx
**Commit:** PENDING
**Guard:** src/__tests__/auth-bootstate.test.ts — 25 cases pinning the reducer transitions (cold-start happy path, degraded 5s→15s path, timer-race safety, terminal idempotence)
---

---
**Date:** 2026-05-25T11:58:05Z
**Trigger:** Ethan 2026-05-25 'why am i not signed into restream chat ++'
**Symptom:** User signed out despite valid tokenEnc still on disk; single transient refresh-failed row preceded by 471944ms stale-inbound
**Root cause:** performFullReconnect treated EVERY undefined refresh() return as fatal (4xx and 5xx and fetch-throw looked identical from the call site), pushed AUTH_STATUS{authenticated:false} → renderer flipped to bare sign-in CTA. WS auto-retry gave up after one attempt; nothing else retried.
**Fix:** v0.1.70 added OAuthCoordinator.getLastRefreshFailure() ('none'|'fatal'|'transient'). 5xx + fetch-throw set transient; 4xx sets fatal; success resets to none. performFullReconnect now branches on classification: transient → push tokenLikelyValid+reconnectingDueToTransient and arm TransientRefreshRetryController (2m→4m→8m→16m→30m capped exponential backoff). Cancel on AUTH_LOGOUT / chat.reconnect success / before-quit. Renderer shows 'Reconnecting — your session may resume automatically. [Retry now]' banner instead of sign-in CTA.
**Commit:** a59300b
**Guard:** src/__tests__/transient-refresh-retry.test.ts (12 cases pinning the state machine: 2m base, doubles, 30m cap, success/fatal/coalescing/cancel/throw-handling) + 5 new cases in oauth-refresh-failure.test.ts pinning getLastRefreshFailure() classification across all 4 outcomes. Plus extensive inline comment blocks in src/main/transient-refresh-retry.ts + src/main/oauth.ts referencing this bug.
---

