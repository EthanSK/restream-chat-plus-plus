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
**Date:** 2026-06-02T15:47:37Z
**Trigger:** voice 7280
**Symptom:** Electron auto-update flaky: clicking Install Update + Restart failed the first ~2-3 times before working; transient network blip mid-download dead-ended on an error pane with no retry, forcing manual re-clicks
**Root cause:** Squirrel autoUpdater 'error' event (network category) only reset downloadInFlight + broadcast an error pane — nothing auto-retried. The hourly GH-Releases poll also fired once and waited a full hour on a transient blip. Each manual Install click = one attempt, so it 'worked after about three times'.
**Fix:** Added bounded auto-retry. updater.ts: network-category Squirrel errors auto-re-arm checkForUpdates() on 5s/15s/45s backoff (max 3); signature-mismatch/staging/unknown still surface immediately. Counter resets on fresh user download, update-downloaded, update-not-available. github-update-check.ts: automatic poll wrapped in checkWithQuickRetry (10s/30s, 2 retries). New downloadRetryAttempt/downloadRetryMax UpdateInfo fields for the banner.
**Commit:** a6d5122
**Guard:** src/__tests__/update-download-retry.test.ts + update-check-retry.test.ts (backoff ladder, budget exhaustion, category gating, counter reset). Thorough inline comments at every retry decision point.
---

---
**Date:** 2026-05-31T18:35:21Z
**Trigger:** Codex review of v0.1.83 TTS work; v0.1.84
**Symptom:** Muting/disabling TTS (renderer toggle, header mute, or MCP set_tts_enabled) didn't stop in-flight/queued native speech; closing main window while OAuth helper open left no way to reopen via Dock; Linux spd-say cancel didn't stop daemon playback
**Root cause:** Cancel-on-silence lived in renderer App.tsx as two separate IPCs (cancel then setSettings) — race let a message slip through; MCP path went through main saveSettings which never cancelled. activate handler keyed off BrowserWindow.getAllWindows().length not mainWindow. spd-say SIGTERM only kills the client, daemon keeps playing.
**Fix:** Moved cancel into main saveSettings (snapshot prev tts, gate on shared shouldCancelNativeTtsOnSettingsChange, call nativeTts.cancel() atomically with persist; removed renderer cancel). activate: if(!mainWindow)createMainWindow(). cancel(): on linux-spd adapter also spawn spd-say --cancel.
**Commit:** 1505f2d
**Guard:** src/__tests__/mute-cancels-inflight.test.ts (behavioural + source wiring), activate-recreates-main-window.test.ts, tts-native.test.ts spd-say --cancel cases
---

---
**Date:** 2026-05-31T17:48:59Z
**Trigger:** Codex menu-bar review (v0.1.83 ship task)
**Symptom:** Preferences… menu item throws macOS 'this command is disabled and cannot be executed' alert after the window is closed then app/menu kept alive (mac), and separately a dialog-show failure silently opened the release page in the browser
**Root cause:** 1) mainWindow declared null + assigned on create but NEVER nulled on close, and no closed listener; on macOS window-all-closed only quits non-darwin so the app+menu outlive the window. mainWindow became a stale NON-null handle to a DESTROYED BrowserWindow; the mainWindow?. optional-chain guard short-circuits null but NOT destroyed, so .webContents threw synchronously -> Electron menu dispatcher surfaces it as the 'command is disabled' alert. 2) safeMessageBox catch returned { response: 0 } on a dialog-show throw, and the Update-available dialog treats index 0 as 'Open Release Page' (if response===0 shell.openExternal), so a FAILED dialog opened the browser unprompted.
**Fix:** 1) Added mainWindow.on('closed', () => { mainWindow = null }) in createMainWindow (root cause); now every mainWindow?. guard short-circuits after close and app.on('activate') recreates+reassigns. Factored the Preferences handler into exported openSettingsFromMenu(win) which bails on null OR isDestroyed() + try/catch; same isDestroyed() guard on the chat-feed context-menu popup. 2) safeMessageBox now returns sentinel { response: -1 } on a thrown dialog (matches no action at any call site); action site uses named OPEN_RELEASE_PAGE=0 const. Other safeMessageBox callers ignore the return so unaffected.
**Commit:** 605a07e
**Guard:** Tests: src/__tests__/menu-preferences-destroyed-window.test.ts (openSettingsFromMenu null/destroyed/live/throw cases) + 3 new cases in updater-menu-reconciliation.test.ts (thrown dialog does NOT open browser, index 0 does, index 1 does not). Thorough inline comments at both fix sites explaining the macOS stale-destroyed-window mechanism and the dialog-fail sentinel.
---

---
**Date:** 2026-05-31T17:30:21Z
**Trigger:** Codex review of new native TTS code (v0.1.81); shipped as v0.1.82
**Symptom:** Hitting mute (or turning TTS off) mid-utterance didn't stop speech: the current utterance played to the end and every already-queued chat message still spoke. Also: spam-clicking the Settings voice-preview dropped samples. Also: Linux chosen voice never applied; macOS voices with numeric-region locales (ar_001/es_419) missing from the dropdown; MCP set_tts_pitch description claimed it affected pitch when it's inert since v0.1.81.
**Root cause:** v0.1.81 native-TTS code. (1) decideTtsAction muted/engine-disabled gates only run on the NEXT incoming message — they suppress FUTURE enqueues but never touch the in-flight subprocess or the FIFO queue the native engine holds in main; toggleMuted/patchTts only flipped settings.tts.muted/enabled. (2) NativeTtsEngine.settle() on the killed-child exit path did 'if(cancelling){cancelling=false;return;}' BEFORE drain(); an enqueue() during the cancelling window couldn't self-start (this.current still=dying child) so the queued item sat idle until the next enqueue. (3) linux-spd buildSpeakSpec passed the voice via -t (voice TYPE) but parseSpdVoiceList lists synthesis-voice NAMES. (4) parseSayVoiceList locale regex required [A-Z]{2,4} region, dropping numeric M49 regions. (5) stale description.
**Fix:** v0.1.82. (1) New pure predicate shouldCancelNativeTtsOnSettingsChange(prev,next) in src/shared/side-effect-decision.ts returns true ONLY on transition INTO silence (muted false->true OR enabled true->false). App.tsx updateSettings snapshots prev tts flags before setSettings and calls rcpp.ttsNative.cancel() (TTS_NATIVE_CANCEL -> NativeTtsEngine.cancel: SIGTERMs child + clears queue) when it returns true. Un-mute/re-enable never cancels (cancel-only, no replay). Header button + both Settings rows funnel through the one updateSettings chokepoint. (2) settle() now, after clearing cancelling, drains if this.queue.length>0 && current cleared. (3) -t -> -y (--synthesis-voice). (4) region group widened to [A-Z0-9]{2,4}. (5) description marked back-compat/inert.
**Commit:** 4a7311d
**Guard:** tts-native.test.ts: cancel->enqueue->killed-exit->plays, plain-cancel-stays-idle, preview-while-playing-still-speaks, numeric-region parse (ar_001/es_419), spd-say -y flag asserted + -t absent. side-effect-decision.test.ts: 8 predicate cases (both INTO-silence triggers true, reverse/no-change/undefined-muted false). mute-cancels-inflight.test.ts: source-level App.tsx wiring guard (snapshot-before-setState, cancel gated by predicate, toggleMuted has no direct cancel). 600 tests pass, typecheck clean.
---

---
**Date:** 2026-05-31T16:18:43Z
**Trigger:** Ethan: 'lets just use system voice for everything then. no more browser one. do it.'
**Symptom:** Spoken chat (TTS) silent / unreliable: renderer Chromium window.speechSynthesis fired but produced no audio whenever the window wasn't foreground (covered/other-Space/minimised/backgrounded/locked) and could silently latch even in foreground on Electron 42. Browser engine was win/linux path + Settings preview + voice enumeration.
**Root cause:** The app still depended on the renderer Web-Speech engine for non-mac chat playback, the Settings voice preview, and voice-list enumeration (speechSynthesis.getVoices()). Chromium throttles/suspends that engine off-foreground, so speak() was swallowed. v0.1.80 had already made macOS always-native but kept browser for everything else.
**Fix:** v0.1.81: removed the renderer Web-Speech engine ENTIRELY; speak ALL chat + the Settings preview via the native OS voice on every platform. Generalised src/main/tts-native.ts into a cross-platform engine (macOS say; Windows PowerShell System.Speech; Linux spd-say>espeak-ng>espeak; no-engine => log once + no-op). dispatchSpeak() always native (dropped isMacNative/isWindowGenuinelyHidden/speakBrowser + the TTS_SPEAK_BROWSER IPC + onSpeakBrowser + speakBrowserCommand + isPageHidden fallback). Repointed preview to native via new IPC.TTS_NATIVE_PREVIEW; voice dropdown to native TTS_NATIVE_GET_VOICES (App fetches once). Removed tts.engine setting + Engine dropdown + Pitch slider (no cross-platform native pitch; tts.pitch kept inert for back-compat + MCP). Removed the now-pointless --disable-features=MacWebContentsOcclusion switch. SECURITY: untrusted chat text never reaches a shell — args array + shell:false everywhere; macOS/Linux pass text as a --guarded argv slot; Windows passes text+voice as base64 ENV VARS decoded inside the PS script (only self-generated integer volume/rate spliced literally).
**Commit:** c939a5b
**Guard:** src/__tests__/tts-dispatch.test.ts (always-native, no browser path) + src/__tests__/tts-native.test.ts (per-platform adapter selection incl. Linux which-probe fallback, rate/volume mapping for all platform scales, 4 voice-list parsers, and a SECURITY suite proving untrusted text is argv-only on mac/linux + base64-env-not-script on Windows). 584 tests pass, typecheck + lint clean. CAVEAT: Windows/Linux native paths are unit-tested only — not runtime-verified from macOS (macOS say path smoke-tested live).
---

---
**Date:** 2026-05-31T15:47:33Z
**Trigger:** Ethan: havent been hearing voice, should it always use system voice instead of electron, can volume n stuff work with that
**Symptom:** no TTS audio heard at all; spoken-chat feature silent on macOS
**Root cause:** main-process TtsDispatcher used the renderer Web-Speech (Chromium speechSynthesis) voice whenever the window was visible-or-merely-covered, only using native say when genuinely hidden. Chromium throttles/suspends the renderer speech engine whenever the window is not foreground (covered, other Space, backgrounded, locked) and can silently latch even in foreground on Electron 42, so speak() fired but produced no sound.
**Fix:** v0.1.80: added isMacNative() dep to TtsDispatcher; dispatchSpeak() now ALWAYS routes to the native macOS say subprocess on darwin (foreground AND background), dropping background-detection on macOS entirely. say is immune to renderer throttling + honours volume (inline [[volm]]), rate (-r), voice (-v); only pitch is unsupported. Non-macOS keeps the prior visibility-based browser/native selection unchanged. main.ts wires isMacNative: () => process.platform === 'darwin'. Renderer Web-Speech engine stays for non-mac + the Settings voice-preview button; incoming chat on macOS never reaches it so no double-speak.
**Commit:** 72e4331
**Guard:** src/__tests__/tts-dispatch.test.ts v0.1.80 suite: 7 cases pinning macOS-always-native (visible+hidden+flip), volume/voice/rate flow-through to native, undefined-voiceURI→system-default-voice fallback, mute+disabled still skip on native path, and a non-macOS regression guard (visible still uses browser). 630 tests pass, typecheck clean.
---

---
**Date:** 2026-05-31T14:48:15Z
**Trigger:** Ethan: did u remove it from speaking out my own messages? should be an option, maybe regex configurable
**Symptom:** own messages not spoken by TTS / wanted it configurable
**Root cause:** v0.1.72 (commit 9121eee, voice 4352) added a HARD self-skip in decideTtsAction gate 2 (src/shared/side-effect-decision.ts) — message.self===true returned skip:'self' unconditionally, with the docstring explicitly stating 'no setting re-enables self-speak (YAGNI)'. The legacy shouldTriggerSideEffects self-gate in chat-message-reducers.ts is dead (v0.1.76 moved all TTS decisions to the main-process TtsDispatcher); the live gate was the decider's gate 2.
**Fix:** Added settings.tts.speakSelf boolean (types.ts + DEFAULT_SETTINGS, default true, persisted via existing electron-store shallow-merge). decideTtsAction gate 2 (src/shared/side-effect-decision.ts) now skips self messages ONLY when speakSelf===false; otherwise they fall through the normal ladder so the existing TTS regex skip-filter (settings.filters.tts.ignoreRegex, safe try/catch compile + invalid-pattern UI hint) also applies to own messages. 'Speak my own messages' toggle added in SettingsDrawer.tsx Text-to-Speech section. Notification path still self-skips unconditionally (toggle is SPEECH-only). v0.1.79.
**Commit:** 422c811
**Guard:** side-effect-decision.test.ts cases 2/2b/2c + tts-dispatch.test.ts self speaks/skips; 623 tests pass, typecheck clean
---

---
**Date:** 2026-05-31T14:37:00Z
**Trigger:** Ethan: "need flex wrap on header of cha++ coz it gets cut off"
**Symptom:** App header content cut off / clipped — on a narrow window the rightmost toolbar items (Settings / Sign out) overflowed past the window edge and became unreachable.
**Root cause:** `.toolbar` is a single `display: flex` row (`align-items: center`, NO `flex-wrap`) whose child controls grew over successive versions — status dot + label, Reconnect, ChannelsPanel (one chip per connected platform), spacer, the v0.1.77 🔊/🔇 Mute button, Logs, Settings, and Sign out / "Sign in to Restream". cha++ is often run in a slim sidebar window, so they overflowed horizontally and clipped. The toolbar has no fixed `height` and no `overflow: hidden`, so wrapping was simply never enabled — items just ran off the edge.
**Fix:** src/renderer/styles.css:132 `.toolbar` — added `flex-wrap: wrap` + `row-gap: 8px`. Overflowing items now drop to a second row; the toolbar grows taller (no fixed height/overflow) and the chat area below flows down so the wrapped row stays visible. The `.spacer` (flex:1) still right-aligns the cluster on the first row. Shipped in v0.1.78 (version bump commit eef4b4d).
**Commit:** 4d34503
**Guard:** Thorough inline comment block at `.toolbar` explaining why wrap is needed + the no-fixed-height/overflow invariant that keeps wrapped rows visible. 620/620 vitest tests pass, typecheck clean.
---

---
**Date:** 2026-05-30T22:30:17Z
**Trigger:** voice 4438
**Symptom:** No fast way to silence the app speaking incoming chat aloud (TTS) without quitting or digging into Settings
**Root cause:** TTS on/off was only controllable via the detailed Settings 'Enabled' toggle; no header-level instant mute, and toggling 'enabled' would clobber the distinction between 'feature off' and 'temporarily silenced'
**Fix:** Added dedicated settings.tts.muted boolean (types.ts + DEFAULT_SETTINGS, persisted via existing electron-store shallow-merge). Header emoji button in App.tsx (toggleMuted) + Settings 'Muted' row both write the same field. Source of truth = new gate 6b in shared decideTtsAction (side-effect-decision.ts): skips reason 'muted' BEFORE backend choice, silencing both browser Web-Speech AND native say. Messages still render; notifications unaffected. commit 4fdf74e
**Commit:** 4fdf74e
**Guard:** tts-dispatch.test.ts (muted->skip both backends, unmute resumes, notif unaffected) + side-effect-decision.test.ts (gate 6b ordering). 620 tests pass, typecheck clean.
---

---
**Date:** 2026-05-30T16:46:12Z
**Trigger:** Ethan voice 4414, 2026-05-30
**Symptom:** TTS robustness depended on the renderer: chat→speak decision/filter/queue/rate-limit lived in the renderer (App.tsx + side-effect-decision.ts), so a wedged/slow/dead renderer could swallow a message. Native say fallback also ignored the volume slider. Ethan voice 4414: must NEVER miss a message; move ALL TTS decision/dispatch to background (main) process; volume + every other control must still work.
**Root cause:** Decision logic was renderer-side; main only forwarded CHAT_MESSAGE. Native engine (tts-native.ts) built say args as -v/-r only, never applying volume (say has no --volume flag and the v0.1.42 code chose to document it as unsupported).
**Fix:** v0.1.76. (1) Moved the pure deciders to src/shared/ (message-filters.ts + side-effect-decision.ts) with re-export shims left at the old src/renderer/ paths so all imports/tests keep working. (2) New src/main/tts-dispatch.ts (TtsDispatcher) runs decideTtsAction/decideNotificationAction in MAIN, owns the rate limiters (MainRateLimiter) + same-id guard, and picks the backend by window visibility: visible/covered -> push IPC.TTS_SPEAK_BROWSER to renderer (browser Web-Speech honours volume/voice/rate/PITCH); genuinely hidden (mainWindow.isMinimized()||!isVisible()) -> nativeTts.enqueue (renderer-independent never-miss path). Wired into chat.on('message') in main.ts alongside the existing feed-forward. (3) tts-native.ts now applies volume via the inline say command [[volm 0.0-1.0]] (buildSayText + clampSayVolume) prepended to the spoken text — verified working on Tahoe. (4) Renderer side-effect useEffect deleted; renderer is now a thin executor: TTSEngine.speakBrowserCommand(payload) speaks one utterance through the hardened speak path honouring payload settings; notifications fire from main. Removed dead renderer refs (lastSpokenIdRef, notifyLimiterRef, RateLimiter import).
**Commit:** 0cb3dff
**Guard:** src/__tests__/tts-dispatch.test.ts (17 cases: backend flips on visibility, all-settings-flow-through for both paths, pitch-only-degrades-when-hidden, decision gates suppress, main-side rate-limit cap+recovery, notification silent honours soundEnabled, thrown backend swallowed). tts-native.test.ts updated + 4 new volume cases (clampSayVolume, buildSayText, per-utterance + settings-fallback volume in say text). 611/611 tests pass, typecheck clean. VERDICT: volume + every control work in the normal visible case (incl pitch); only PITCH degrades, and ONLY in the rare genuinely-hidden state (say has no pitch knob) — restored instantly when window visible. Live Mini verification still recommended: minimise window, send chat, confirm native say speaks at slider volume.
---

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

