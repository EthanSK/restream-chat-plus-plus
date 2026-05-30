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
**Date:** 2026-05-30T14:27:02Z
**Trigger:** Ethan voice 4407 follow-up, 2026-05-30
**Symptom:** Ethan PREFERS the browser (Web Speech) voice in the background, not the native 'say' voice — v0.1.74 made native the default for ALL backgrounded/occluded states. He asked 'is there actually nothing we can do?'
**Root cause:** macOS marks a window merely COVERED by other windows as occluded; Chromium's MacWebContentsOcclusion feature reacts by flipping the WebContents to HIDDEN, so document.visibilityState goes 'hidden' and speechSynthesis is suspended even though the window is just covered, not minimised. v0.1.74 therefore routed the common covered-window case to native say.
**Fix:** v0.1.75 (main.ts, before app.ready): app.commandLine.appendSwitch('disable-features', 'MacWebContentsOcclusion,CalculateNativeWinOcclusion') — single comma-separated value (appendSwitch on the same key OVERWRITES, does NOT merge; this is the ONLY disable-features call, verified by grep). A merely-covered window now stays visibilityState==='visible' so isPageHidden() returns false and the BROWSER voice keeps speaking (Ethan's preference). tts.ts logic unchanged (already keys off isPageHidden); comments updated to frame native say as a LAST-RESORT safety net.
**Commit:** WORKING-TREE-uncommitted
**Guard:** Existing tts-background-fallback.test.ts pins ordering (visible->speechSynthesis, hidden->native). 594/594 pass, typecheck clean. HARD LIMIT documented in comments: occlusion flag only rescues covered-windows; MINIMISED / other-Space / Cmd-H-hidden still report hidden -> Chromium hard-suspends speechSynthesis -> native say covers them. Live Mini verification still needed: cover window, send chat msg, confirm browser voice speaks + NO background_native_fallback event.
---

---
**Date:** 2026-05-30T13:44:36Z
**Trigger:** Ethan voice 4407 2026-05-30
**Symptom:** TTS doesn't speak incoming chat when app backgrounded too long (message renders but no speech)
**Root cause:** Default TTS engine is renderer-side window.speechSynthesis (DEFAULT_SETTINGS.tts.engine='browser', types.ts:266). Chromium SUSPENDS speechSynthesis while the page is hidden/occluded and throttles backgrounded renderer timers to ~1/min; speak() is silently swallowed (no onstart/onend/onerror). Chat msgs still render because the WS frame is received in MAIN and pushed over IPC (never throttled). BrowserWindow webPreferences (main.ts) had no backgroundThrottling:false; app had no disable-*-backgrounding switches; no powerSaveBlocker (App Nap could suspend app). Native main-process say(1) engine existed (v0.1.42) but wasn't the default and ignores the volume slider.
**Fix:** v0.1.74 four stacked layers: (1) webPreferences.backgroundThrottling:false + webContents.setBackgroundThrottling(false) on main window. (2) app.commandLine.appendSwitch disable-background-timer-throttling / disable-renderer-backgrounding / disable-backgrounding-occluded-windows before app.ready. (3) powerSaveBlocker.start('prevent-app-suspension') held for app lifetime. (4) LOAD-BEARING: browser TTSEngine.speak() detects isPageHidden() and routes the utterance to the native window.rcpp.ttsNative say bridge instead of speechSynthesis when hidden; foreground keeps Web Speech so the volume slider works. New 'background_native_fallback' TtsLogEvent for forensics.
**Commit:** WORKING-TREE-uncommitted
**Guard:** src/__tests__/tts-background-fallback.test.ts (5 cases). 594/594 tests pass, typecheck clean.
---

---
**Date:** 2026-05-29T18:00:00Z
**Trigger:** voice 4364, 2026-05-28
**Symptom:** (a) v0.1.47 disabled WS auto-reconnect by default; Ethan wanted it back on because brief network blips left him on "disconnected" until manual click. (b) Ethan reported "YoWSG" (wildswanxx) message "didn't get read aloud" but his logs were too blind to confirm — only `speak_called` rows existed, no row for SKIPPED messages so any TTS miss was undebuggable from logs.
**Root cause:** (a) v0.1.47 was a wifi-clog mitigation that's been superseded by v0.1.70's TransientRefreshRetryController (2m-30m capped exp backoff absorbs transient refresh failures) + the existing 60s WS-backoff cap (worst-case ~1 attempt/min steady-state, not the runaway loop the v0.1.47 disable was guarding against). (b) Per-message decision was silently short-circuited at SIX possible gates (pending-send, self, same-id-reprocess, platform-disabled, hidden-user, engine-disabled, content-regex, username-regex) and NONE of them emitted a log row. Forensic grep of the actual incident showed the wildswanxx messages DID get spoken (speak_called → onstart → onend all present). The actually-missed message was bunnysabbat's Unicode-obfuscated "Ai Viewers streamboo.com" scam, correctly skipped by the user's own `Viewe`/`streamboo` content-regex — but invisible to the user without per-gate decision logging.
**Fix:** v0.1.73. (a) Comment block in src/main/ws-client.ts:53-95 explains the v0.1.47→v0.1.73 reversal; field-default stays false so unit tests retain deterministic control; main.ts calls `chat.setAutoReconnectEnabled(true)` AFTER `setReconnectProvider` is installed so the first auto tick goes through the unified `performFullReconnect()` path. (b) New pure module src/renderer/side-effect-decision.ts with `decideTtsAction` + `decideNotificationAction` walks the SAME gate ladder App.tsx historically used (pending-send → self → same-id → platform → hidden-user → engine-disabled → username-regex → content-regex → READ). App.tsx's side-effect useEffect now calls these helpers, emits a `tts_decision` / `notification_decision` JSONL row via `rcpp.ttsLog` BEFORE the engine call (so a crash inside engine doesn't hide the decision), then drives the engine based on the same decision. The notification path has a SECOND gate inside the renderer (RateLimiter.tryConsume) that emits an additional `skip:rate-limited` row when the decider said notify but the limiter rejected. Two new TtsLogEvent union members + two new reason-taxonomy types (TtsDecisionReason / NotificationDecisionReason) in src/shared/types.ts.
**Commit:** 90c6910
**Guard:** src/__tests__/side-effect-decision.test.ts (24 cases: gate-order pin per gate, regex-source surfaced in extra, defensive non-string handling, real-world Ethan 2026-05-29 replay for wildswanxx → READ and bunnysabbat → content-regex skip). Existing ws-backoff.test.ts + self-ignore.test.ts (untouched, both still green). 589/589 tests pass.
**Non-bug found:** The wildswanxx "yo wsg reeethan" message Ethan thought was unread WAS spoken (tts-events.jsonl: speak_called at 17:05:47.539Z, onstart at 17:05:47.765Z, onend at 17:05:49.024Z). Likely cause of the user perception: audio output device issue (Focusrite drop?) — TTS engine fired correctly but he didn't hear it. The actual silent-skip was bunnysabbat's spam message, correctly filtered by his own regex. Going forward the new decision logs make this verifiable in one grep.
---

---
**Date:** 2026-05-29T00:21:51Z
**Trigger:** voice 4352, 2026-05-28
**Symptom:** User's own messages were read aloud by TTS and triggered native notifications; v0.1.26 had reverted self-ignore as a hard default, but voice 4352 (2026-05-28) reverses that direction
**Root cause:** App.tsx side-effect useEffect had no self check; the only existing gate was the lapsed v0.1.10 implementation that removed in v0.1.26. With multiple side-effect paths (TTS, notifications, future ones), scattering 'if (m.self) return' across each is brittle and historically drifts (v0.1.10 -> v0.1.26 regression). Hidden-user list also needed a fully persistent storage path separate from the regex ignore lists
**Fix:** Single gate at shouldTriggerSideEffects in src/renderer/chat-message-reducers.ts — added 'if (lastMessage.self === true) return false' so every caller automatically inherits the suppression. Hidden-user list lives in settings.hiddenUsers (persistent electron-store array) + composes via compileHiddenUsersSet/isHiddenUser helpers. Hide-user hover button in ChatFeed; Unhide UI in SettingsDrawer's new Hidden Users section. Username regex axis added to applyMessageFilters as the second composable matching axis (OR with content)
**Commit:** 9121eee
**Guard:** src/__tests__/self-ignore.test.ts (10 cases pinning self-ignore at the gate point + simulating App.tsx TTS+notification paths together) + src/__tests__/hide-user.test.ts (25 cases pinning compileHiddenUsersSet/isHiddenUser/addHiddenUser/removeHiddenUser + JSON round-trip + end-to-end hide/unhide). Updated existing chat-message-reducers.test.ts cases that asserted self-echoes triggered (pre-v0.1.72 contract)
---

---
**Date:** 2026-05-26T15:42:19Z
**Trigger:** voice 4198 2026-05-26
**Symptom:** Cold start showed Sign In button before main-process decrypt finished; user accidentally clicked it kicking off unwanted OAuth flow
**Root cause:** Renderer useState<AuthStatus> defaulted to { authenticated:false } synchronously at mount; main process's getTokenAsync + pushAuthStatus took ~1-2s, during which the 'signed out' UI was clickable
**Fix:** Added AuthBootState discriminator (checking|checking-slow|signed_in|signed_out|verify_failed) tracked alongside AuthStatus; renderer renders a centered spinner overlay above toolbar until first AUTH_STATUS arrives (initial pull OR push); 5s slow subtitle + 15s retry escalation; defence-in-depth: Sign In JSX returns null while bootPending. src/renderer/auth-bootstate.ts + App.tsx
**Commit:** e6549f1
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

