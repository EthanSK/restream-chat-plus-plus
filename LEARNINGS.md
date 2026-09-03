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
**Date:** 2026-09-03T12:33:00Z
**Trigger:** Ethan: “getting so many messages from X ages later ... why isn't it smart enough to know it's from me ... even for Twitch sometimes and YT”.
**Symptom:** Messages sent through RC++ appeared immediately as the normal optimistic/`reply_created` self row, then separate `REEEthan X` rows leaked into the combined feed roughly 31–37 minutes later. They were silenced only because Ethan's username regex happened to match, not because RC++ identified them as self. Direct Twitch/Kick self events could leak through the same way after 30 seconds.
**Root cause:** Restream/X accepted each send immediately, then its connector delivered the platform copy much later as an ordinary `event` with a new message ID. RC++ marked only `reply_created` as self and never compared an ordinary event's stable `eventPayload.author.id` with the authenticated owner ID already present in the matching `connection_info`. The direct-provider aggregator also required a same-text pending send within 30 seconds before suppressing a message that Twitch/Kick had already marked `self:true`.
**Fix:** v0.1.111 caches each Restream connection owner's stable platform ID and suppresses an ordinary platform event only when its author ID exactly matches that owner. It deliberately does not guess from username or display name. Direct Twitch/Kick now treat their authenticated `self:true` identity as authoritative at every age; the pending text/time match remains diagnostic correlation only.
**Commit:** `fc1639b` (`fix(chat): suppress delayed platform self echoes (v0.1.111)`)
**Guard:** `ws-self-platform-echo.test.ts` covers exact X, YouTube, and Twitch owner-ID suppression, same-display-name/different-ID forwarding, and missing-owner-ID fail-open behavior. `direct-chat-liveness.test.ts` proves a direct Twitch self event with no pending-send correlation is suppressed while a viewer event still forwards. All 65 test files / 727 tests pass; typecheck is clean; lint has 0 errors (186 pre-existing warnings); and the local arm64 package reports exact version 0.1.111. Main CI run `33754964988` and tagged release run `33754977861` passed. The published arm64 ZIP matches its release checksum, reports exact version 0.1.111, passes strict deep verification, is accepted as `Notarized Developer ID`, has a valid stapled ticket, and gives the app Team ID `T34G959ZG8`. GitHub latest release and public `version.json` both point to v0.1.111. The exact published build is installed and connected from `/Applications/Restream Chat Plus Plus.app`; its installed `app.asar` contains both new suppression paths. OBS++ streaming and recording PIDs remained alive across the brief RC++ restart, and signed v0.1.110 is preserved in the app's Install Backups folder.
---

---
**Date:** 2026-08-29T15:27:23Z
**Trigger:** Ethan: “when i first start the app it always shows sign in instead of loading if its loading”.
**Symptom:** A signed-in user could briefly see the actionable Sign in to Restream button during cold start before the saved session finished restoring, then the normal connected UI replaced it.
**Root cause:** Startup auth had one completion latch but only the `did-finish-load` AUTH_STATUS push waited for it. The renderer also performed an immediate AUTH_STATUS pull; that handler awaited Keychain decrypt but did not await the refresh-token leg. With an expired access token, the pull could therefore return `authenticated:false` while `resumeAuthWithCookieRepair()` was still refreshing the saved session. The renderer correctly treated that first answer as final and removed its loading overlay.
**Fix:** v0.1.110 routes the AUTH_STATUS pull through `readStartupAuthStatus()`, which waits for the same `startupAuthDone` promise as the push before reading OAuth truth. The existing Checking sign-in overlay now remains authoritative throughout decrypt/refresh and Sign in appears only after startup resolves genuinely signed out. Later status reads remain immediate because the promise is already settled.
**Commit:** `99d5623` (`fix(auth): keep startup loading until session resolves (v0.1.110)`)
**Guard:** `startup-auth-status.test.ts` keeps the startup promise unresolved and proves neither OAuth read runs nor a status settles until restoration finishes, then pins both restored signed-in and conclusively signed-out results. Existing `auth-bootstate.test.ts` continues to pin the renderer loading-overlay transitions. All 64 test files / 721 tests pass; typecheck is clean; lint has 0 errors (186 pre-existing warnings); and the arm64 package reports exact version 0.1.110. Main CI run `33260501925`, main build-only release run `33260501970`, and tagged release run `33260659942` all passed. The published arm64 ZIP matches its release checksum, reports exact version 0.1.110, passes strict deep verification, is accepted as `Notarized Developer ID`, has a valid stapled ticket, and gives both the outer app and nested `libffmpeg.dylib` Team ID `T34G959ZG8`. The GitHub latest-release API and public `version.json` both point to v0.1.110. A verified notarized install-ready copy is preserved at `out/published-v0.1.110/Restream Chat Plus Plus.app`. Local installation is deliberately pending: installed v0.1.109 is running and OBS++ is actively recording through `obs-ffmpeg-mux`, so quitting or replacing the app would cross an unsafe live boundary.
---

---
**Date:** 2026-08-29T13:52:00Z
**Trigger:** Ethan: “install update is so shit ... redo the install update system from scratch”; screenshot showed v0.1.107 available while v0.1.106 displayed “Update is already being prepared in the background”.
**Symptom:** Clicking Install Update left the yellow available banner in place and showed a transient blue toast claiming a hidden background operation was already running. The action looked stale and contradictory even though Squirrel later staged the update.
**Root cause:** Update state had two owners. `github-update-check.ts` discovered a release and silently started native Squirrel, while `updater.ts` separately tracked native flags and deliberately dropped every `kind:'downloading'` payload behind `SUPPRESS_FOREGROUND_DOWNLOAD_UI`. The renderer therefore kept presenting an actionable available button for an operation that had already started elsewhere. Layered guards, timers, retries, and a forced `app.relaunch()` fallback accumulated around that split state instead of making the transition contract explicit.
**Fix:** v0.1.108 replaces both owners with one `UpdateController`. Background polling is metadata-only. Download Update synchronously publishes `downloading` before the sole native `checkForUpdates()` entry point; native events drive visible progress and `ready-to-install`; Restart & Install calls `quitAndInstall()` once and reports a bounded no-restart failure rather than launching the old bundle. GUI, menu, IPC, and MCP read the same state. The unused `update-electron-app` dependency and its independent timer are removed.
**Commit:** `532d37d` / `v0.1.108`
**Guard:** `update-controller.test.ts` pins discovery-without-download, immediate visible transition, duplicate coalescing, monotonic progress, bounded network retries, non-retryable signature/staging failures, staged-state check freezing, and one deferred install call. `updater-architecture-guard.test.ts` rejects multiple native entry points, hidden download suppression, background native checks, and forced relaunch/exit fallbacks. `update-banner-visible-flow.test.tsx` pins Download Update → visible progress → Restart & Install → installing. All 719 tests pass, typecheck is clean, and lint has no errors (pre-existing warnings only). Main CI run `33255034540`, the main build-only release run `33255034536`, and tagged release run `33255169689` all passed. The published arm64 ZIP matches its release checksum, reports exact version 0.1.108, passes strict deep verification, is accepted as `Notarized Developer ID`, has a valid stapled ticket, and gives both the outer app and nested `libffmpeg.dylib` Team ID `T34G959ZG8`. The public updater returns HTTP 200 from v0.1.107 and points at v0.1.108; public `version.json` also reports 0.1.108. A verified notarized install-ready copy is preserved at `out/published-v0.1.108/Restream Chat Plus Plus.app`. For real acceptance, v0.1.109 was deliberately published with no behavior changes and the installed v0.1.108 app was left untouched: release run `33259021321` passed, its arm64 ZIP matched the checksum, reported exact version 0.1.109, passed strict signing and notarization checks, and both public updater metadata sources pointed from v0.1.108 to v0.1.109. This preserves the exact live update transition for Ethan to test rather than pre-installing the target behind his back.
---

---
**Date:** 2026-08-29T12:25:11Z
**Trigger:** Ethan: "after doing Check for Updates I see the yellow banner for a split second then" a red `Update failed (v0.1.106)` banner saying `The command is disabled and cannot be executed`.
**Symptom:** The installed v0.1.105 app correctly discovered v0.1.106, briefly showed the available state, then showed a native-updater failure even though v0.1.106 finished downloading and staging 13 seconds later.
**Root cause:** `performGithubUpdateCheck(true)` called `rememberPendingDownloadVersion`, which started Squirrel's native background check. After the update-available dialog resolved, `checkForUpdatesInteractive` bypassed the existing guard and called `autoUpdater.checkForUpdates()` directly a second time. At 13:15:40 the overlapping command made Squirrel emit `The command is disabled and cannot be executed`; the original operation then emitted `update-downloaded` at 13:15:53. The background path also waited for Squirrel's asynchronous `checking-for-update` event before marking `downloadInFlight`, leaving an unnecessary event-gap race.
**Fix:** v0.1.107 arms `downloadInFlight` synchronously before every accepted background native check, releases it on a synchronous start failure, and routes the interactive menu reconciliation through `triggerSquirrelDownload()` instead of directly re-entering Electron. Joining an active operation preserves explicit user intent so a genuine native-feed disagreement still shows the existing manual fallback.
**Commit:** v0.1.107 release
**Guard:** `update-flow-fixes.test.ts` reproduces the exact ordering—GitHub starts a background check, the menu/download path follows immediately before any Squirrel event—and proves only one native command is issued. It also proves a synchronous background-start failure releases the guard. All 769 tests pass, typecheck is clean, and lint has zero errors (pre-existing warnings only). The local arm64 v0.1.107 bundle passed strict deep Developer ID verification, Gatekeeper assessment, and nested `libffmpeg.dylib` Team-ID verification. Both the main and tagged GitHub workflows succeeded; the published macOS ZIP matched its release checksum, reported exact version 0.1.107, and passed strict deep verification plus Gatekeeper as `Notarized Developer ID`, with the outer app and nested `libffmpeg.dylib` both owned by Team ID `T34G959ZG8`. The public updater returned HTTP 200 for both v0.1.105 and v0.1.106 and pointed at v0.1.107, while public `version.json` also reported 0.1.107. Local installation and live updater acceptance remain pending because OBS++ was actively recording; do not quit or replace Restream Chat++ across that boundary.
---

---
**Date:** 2026-08-29T11:45:00Z
**Trigger:** Ethan asked to remove Restream Chat++'s obsolete lifetime system-sleep blocker without weakening background TTS.
**Symptom:** The installed v0.1.105 main process owned a macOS `NoIdleSleepAssertion` named `Electron` for essentially its full uptime, preventing normal idle system sleep whenever Restream Chat++ was open.
**Root cause:** v0.1.74 added `powerSaveBlocker.start('prevent-app-suspension')` as one layer of a renderer Web-Speech reliability workaround and never stopped it until app quit. Electron maps that blocker to a system idle-sleep assertion; it is not merely an App Nap guard. Since v0.1.81, renderer Web Speech has been removed and incoming chat decisions plus native OS speech run in the main process, so the original browser-TTS motivation is obsolete.
**Fix:** v0.1.106 removes the `powerSaveBlocker` import and lifetime startup call while leaving `TtsDispatcher`, `NativeTtsEngine`, and chat delivery unchanged. Normal macOS idle system sleep is therefore no longer suppressed by Restream Chat++.
**Commit:** `cfc9612`
**Guard:** `system-sleep-policy.test.ts` scans production main-process sources and rejects Electron `powerSaveBlocker` use or `prevent-app-suspension`. Existing native TTS dispatcher/engine tests continue to pin the background speaking path. All 767 tests pass, typecheck is clean, and lint has zero errors. The v0.1.106 release workflow built and published every platform artifact successfully; GitHub's macOS arm64 update endpoint returns HTTP 200 for v0.1.105 and points at the signed v0.1.106 ZIP. Do not use a lifetime system-sleep assertion as a substitute for reliable background message handling. Local installation and physical TTS acceptance remain intentionally unclaimed until Ethan installs the update.
---

---
**Date:** 2026-08-25T12:33:13Z
**Trigger:** Ethan: "why does rc++ say twitch is offline when its treaming"
**Symptom:** The direct Twitch row showed `OFFLINE` while the public Twitch channel was live with one viewer. `direct-chat.jsonl` ended with a healthy keepalive, a server close, and one scheduled reconnect; the persisted `twitchTokenEnc` was then absent, so the toolbar Reconnect action repaired Kick but skipped Twitch.
**Root cause:** `TwitchChatSource` returned `undefined` for temporary network/provider failures and permanent token rejection alike, and `connectWithToken()` responded to either by deleting the stored token and entering `disconnected`. Its socket, hourly validation, send, and viewer paths could also refresh concurrently even though Twitch rotates refresh tokens, allowing one request to invalidate another. The old toolbar retry then excluded every disconnected source. The live log did not record the failed authorization HTTP response, so it cannot distinguish a transient provider failure from the concurrent-refresh race after the fact; both proven code paths had the same destructive outcome.
**Fix:** v0.1.105 gives Twitch validation and refresh explicit `ok` / `transient` / `invalid` outcomes, serializes token refresh, preserves authorization and backoff-retries transient failures, clears only after an explicit Twitch rejection or revocation, and lets toolbar Reconnect retry a disconnected source that still has authorization.
**Commit:** working-tree implementation
**Guard:** `direct-chat-liveness.test.ts` covers transient refresh and validation failures without token loss, recovery after the outage clears, explicit 401/400 rejection, one refresh for concurrent callers, and toolbar recovery from disconnected. All 766 tests pass, typecheck is clean, and lint reports zero errors (pre-existing warnings only). Keep transient provider health failures separate from permanent OAuth rejection; never delete a direct-provider token from an ambiguous failure result.
---

---
**Date:** 2026-08-17T15:05:00Z
**Trigger:** Ethan: "why am I getting this banner all of a sudden; this is the second time"
**Symptom:** Restream Chat++ automatically showed a red “Update failed — The server sent an invalid response” banner once per hour even though chat remained connected and no newer update existed.
**Root cause:** The installed local build was v0.1.103 while GitHub's latest public release was v0.1.97. The authoritative GitHub API correctly returned v0.1.97, but a separate blind Squirrel poll requested `update.electronjs.org/.../0.1.103`; that service returned HTTP 404 “No updates found,” which Electron converted into an invalid-response error and the renderer treated as actionable.
**Fix:** v0.1.104 makes the GitHub Releases result the source of truth. The native feed is configured at startup but only checked after GitHub reports a version newer than the running app; the existing hourly native timer becomes a retry/fallback only while a real newer release is pending.
**Commit:** `10bae7e`
**Guard:** `update-flow-fixes.test.ts` proves startup and repeated hourly ticks never touch Squirrel without a newer GitHub version, and that a newer remembered release still starts exactly one native background check and stays frozen after staging. All 760 tests pass, typecheck is clean, and lint has zero errors. The Developer-ID-signed v0.1.104 bundle passed strict deep verification, Gatekeeper, and nested `libffmpeg.dylib` Team-ID verification; after installation it relaunched on the Built-in Retina Display, restored the Twitch and Kick sockets, logged the guarded native-check skip, and resolved GitHub's v0.1.97 as up to date without an updater error.
---

---
**Date:** 2026-08-17T12:50:00Z
**Trigger:** Ethan: "what's this clapped alignment"
**Symptom:** A live Twitch or Kick source chip showed its separator at the top right and wrapped the numeric viewer count onto a second line.
**Root cause:** The flex row could shrink each source chip, and the viewer fragment `· 1` retained a normal wrapping opportunity at its space. The status dot and source name therefore stayed on the first line while the count dropped below them.
**Fix:** v0.1.103 makes source chips and their viewer-count fragments non-shrinking and non-wrapping, preserving the existing compact one-row design.
**Commit:** working-tree implementation
**Guard:** `chat-sources-bar.test.tsx` pins `flex: 0 0 auto` and `white-space: nowrap` on both relevant style rules. The signed installed v0.1.103 app was manually verified at the existing 460px-wide window with `Twitch · 1` and `Kick · 1` each rendered on one row.
---

---
**Date:** 2026-08-17T12:20:00Z
**Trigger:** Ethan: "messages sent from Twitch don't show up in Restream Chat++ ... same with Kick"
**Symptom:** Chat++ could send to Twitch and Kick, both direct-source chips stayed green, and both provider viewer counts updated, but messages originating on either platform no longer reached the combined feed.
**Root cause:** Direct send, direct receive, and viewer count use separate transports. The direct-source status was set to `connected` when Twitch EventSub or the Kick relay socket opened, but neither source had a liveness guard that could revoke that green state after a network interruption left the socket open but no longer delivering inbound data. The current app had experienced repeated DNS/offline failures, while the independently polled provider viewer APIs later recovered, so the counts did not prove the chat sockets were healthy. The old build also had no direct-source lifecycle/frame log, which prevented proving the exact last provider frame after the fact.
**Fix:** v0.1.101 adds a 75-second Twitch EventSub inbound watchdog, a 30-second Kick relay application heartbeat with a two-miss budget, automatic forced reconnect through the existing token-preserving source lifecycle, and `direct-chat.jsonl` lifecycle/message-forwarding evidence. The toolbar Reconnect action now refreshes Restream plus every currently active direct source without revoking Twitch or Kick authorization.
**Commit:** working-tree implementation
**Guard:** `direct-chat-liveness.test.ts` reproduces a green Twitch source with no keepalives, a green Kick source with no pong, and a healthy Kick relay that continues answering. All 754 app tests and the relay signature test pass, both TypeScript projects typecheck, and lint reports zero errors (pre-existing warnings only). Do not treat viewer polling or a last-known green socket-open state as proof that inbound provider chat is live.
---

---
**Date:** 2026-08-15T17:08:00Z
**Trigger:** Live Twitch and Kick account setup for direct read and send chat.
**Symptom:** One transient Twitch token-poll fetch failure abandoned an otherwise valid device authorization. Kick's consent screen also disclosed that the requested `user:read` scope included the account email even though Chat++ only needed broadcaster identity. After approving the narrowed Kick grant, Chat++ returned to Disconnected before contacting the channel or relay because the token-exchange scope did not satisfy its local permission check.
**Root cause:** Twitch's Device Code poll treated transport failure as a terminal OAuth reply. Kick loaded identity from `GET /public/v1/users`, which requires the broader `user:read` scope; Kick's authenticated `GET /public/v1/channels` already returns the broadcaster ID and slug under `channel:read`. Chat++ also treated the token-exchange response as the authoritative effective Kick grant even though Kick documents token introspection as the endpoint that reports an active token's scopes.
**Fix:** v0.1.100 keeps Twitch polling after transport errors until the device code expires, removes Kick `user:read`, derives Kick identity from authenticated channel data, and updates the encrypted token's scope from successful introspection before checking permissions. A genuinely missing grant now names the omitted scope rather than falling back to assumed access.
**Commit:** working-tree implementation
**Guard:** Kick scope tests reject assumed permissions and pin explicit missing-grant reporting; the identity parser test pins the channel response contract and README pins the minimum scopes. Keep OAuth scopes to the least privilege supported by official provider endpoints; do not restore `user:read` merely to fetch the same broadcaster ID.
---

---
**Date:** 2026-08-15T14:33:14Z
**Trigger:** Ethan: "my messages should also go to Kick and Twitch etc not just read from them"
**Symptom:** Direct Twitch and Kick connections could populate the combined timeline, but the composer still posted only through Restream. Because those destinations were deliberately disabled in Restream, a Chat++ reply never reached them.
**Root cause:** v0.1.98 deliberately stopped at receive-only provider adapters. The outgoing queue had a single Restream sender, its optimistic confirmation depended on Restream's WebSocket echo, and it had no per-destination progress to prevent duplicate sends after partial failure.
**Fix:** v0.1.100 adds official Twitch `POST /helix/chat/messages` and Kick `POST /public/v1/chat` senders, requests their write scopes, and fans one queued message out to Restream plus eligible direct providers. The target set freezes on the first attempt and confirmed successes persist across automatic and manual retries. Provider self-echoes are suppressed while the renderer confirms the original optimistic row from the aggregate send result.
**Commit:** working-tree implementation
**Guard:** Fan-out tests pin target selection and retry isolation; provider tests pin official request bodies and authorization errors; the optimistic reducer test pins direct confirmation without an echo. Never send directly to Twitch or Kick when Restream already reports that same platform connected, or one composer action will appear twice there. All 751 tests pass, typecheck is clean, and lint reports zero errors (pre-existing warnings only).
---

---
**Date:** 2026-08-15T12:53:09Z
**Trigger:** Ethan: "also the normal view count is now cut off"
**Symptom:** Opening the existing Restream live-viewer breakdown after adding the Chat sources row clipped the panel's heading, platform names, and channel identifiers against the app window's left edge; counts and live pills remained visible.
**Root cause:** v0.1.96 correctly changed the panel from left-opening to right-opening, but it still positioned the 280px panel relative to the small viewer chip. Later header controls moved that chip left far enough that a trigger-relative panel extended beyond the viewport on the current scaled macOS window.
**Fix:** v0.1.99 makes the toolbar the containing block and the viewer-count wrapper position-neutral, then places the breakdown 12px inside the toolbar's right edge. The panel therefore stays inside the window regardless of where wrapping or added controls place the trigger.
**Commit:** working-tree implementation
**Guard:** `viewer-count.test.tsx` requires the toolbar containing block, neutral trigger wrapper, and 12px right inset. All 13 focused viewer-count tests and typecheck pass.
---

---
**Date:** 2026-08-17T12:44:00Z
**Trigger:** Ethan: "combine the individual Twitch and Kick live viewers in this main viewers trigger and dropdown"
**Symptom:** Direct Twitch and Kick counts were visible on their source chips, but the main eye total and dropdown still described only Restream destinations.
**Root cause:** The renderer already held both live sources, but `ViewerCount` consumed only `ViewerStatsSnapshot`; direct counts stayed isolated in `DirectChatConnection` even though they represented the same user-facing total.
**Fix:** v0.1.102 derives one toolbar total from the live Restream snapshot plus connected live direct sources, keeps Restream and Direct rows in separate dropdown sections, and remains visible for a direct-only stream.
**Commit:** working-tree implementation
**Guard:** Renderer tests cover the combined total, direct-only live and unknown-count states, section order, offline-count suppression, and the existing close paths. The installed signed app was manually verified with Restream 0 + 0 + unknown and direct Twitch 1 + Kick 1 producing a toolbar total of 2.
---

---
**Date:** 2026-08-15T12:37:56Z
**Trigger:** Ethan: "set it up both twitch and kick. also we should be able to see the view count for each individually"
**Symptom:** The direct Twitch and Kick source controls showed connection health but no provider-specific audience count, while Restream's existing viewer total could not represent destinations disabled in Restream.
**Root cause:** Direct chat and Restream viewer statistics are independent transports. Twitch exposes `viewer_count` through Helix Get Streams, and Kick exposes its own `viewer_count` through the authenticated user-livestream endpoint; neither value arrives in the direct chat event stream.
**Fix:** v0.1.99 polls each provider's official live endpoint every 30 seconds while its direct chat source is connected and carries that provider's independent live state/count through `DirectChatConnection` into the source chip and connection panel. An empty stream result means offline; a polling error preserves the last confirmed value and never disconnects chat.
**Commit:** working-tree implementation
**Guard:** Parser tests cover offline and numeric live responses for both providers; the source-row test proves simultaneous Twitch and Kick counts stay separate. The full suite passes 737/737 tests, typecheck is clean, and lint reports zero errors.
---

---
**Date:** 2026-08-14T19:27:00Z
**Trigger:** Local v0.1.98 installation for offline Twitch/Kick connection verification.
**Symptom:** The manually signed app passed `codesign --verify --deep --strict` but terminated at launch with a dyld `Library missing` crash. The crash report named `libffmpeg.dylib` and said the mapped file and process had different Team IDs.
**Root cause:** Raw `codesign --force --deep` signed the outer Electron bundle but left Electron's vendor-signed nested `libffmpeg.dylib` under a different Team ID. Deep verification alone did not prove that hardened-runtime library loading would accept every nested binary.
**Fix:** Repackage a clean arm64 app and sign it with `@electron/osx-sign.signAsync`, using the Developer ID identity, hardened runtime, and project entitlements. Reinstall the newly signed bundle only after both the outer app and `libffmpeg.dylib` reported Team ID `T34G959ZG8`; the app then launched normally.
**Commit:** working-tree packaging verification
**Guard:** Never use raw `codesign --deep` as the local Electron release-signing workflow. Use `@electron/osx-sign` (the same signer Electron Forge uses), run strict deep verification, inspect a nested runtime library's Team ID, then perform an actual cold launch before replacing the verified rollback copy.
---

---
**Date:** 2026-08-14T19:15:00Z
**Trigger:** Ethan: "integrate the restream chat thing ... Twitch button and the Kick button that we can connect and see"
**Symptom:** Twitch and Kick chat disappeared from the combined Restream Chat++ feed when those destinations were disabled in Restream, even though OBS sent to the platforms directly.
**Root cause:** The app had only one inbound transport: Restream's combined Chat API WebSocket. Restream does not aggregate a platform chat after that destination is disabled, and Kick's official API delivers chat through signed public webhooks rather than a desktop WebSocket endpoint.
**Fix:** v0.1.98 adds independent Twitch Device Code/EventSub and Kick PKCE/signed-webhook-relay sources. Their messages enter the existing main-process feed, filter, notification, and TTS path. A compact second header row exposes separate Restream, Twitch, and Kick health plus Connect/Disconnect controls. Provider tokens use OS-keyring encryption; macOS Keychain or environment variables hold app/relay credentials. The cross-source deduper rejects exact message-ID replays and same-message copies seen through different transports without dropping repeated text from one source.
**Commit:** working-tree implementation
**Guard:** Keep platform destinations and chat-source connections independent. Use Twitch's public-client flow without a secret; verify Kick's RSA signature before relaying; never store provider tokens in plaintext; keep direct replies routed through Restream until official provider-specific send support is deliberately added. Tests cover both normalizers, token/connection states, cross-source deduplication, source-row UX, and forged Kick signatures.
---

---
**Date:** 2026-08-12T14:55:00Z
**Trigger:** Ethan: "whta hapnede to yt view count investiage log and cu"
**Symptom:** During a live four-platform stream, the viewer popover showed `TOTAL 0`, Facebook/Twitch/X as `0`, and YouTube as `LIVE —` even though YouTube chat remained connected. The supplied screenshot was captured at 2026-08-12T14:52:27Z.
**Root cause:** Restream's separate Streaming Updates feed kept YouTube `online:true` but temporarily supplied no numeric YouTube `viewers` value. `viewer-stats.jsonl` records YouTube changing from `1` to `null` at 14:47:43Z while the other three platforms remained numeric zero; it changed back to `1` at 14:53:19Z, 52 seconds after the screenshot. The chat feed independently kept receiving heartbeats and reported the exact YouTube event `yVuv1MZeG1c` connected, so this was not a YouTube-chat disconnect or a dead local socket. Computer Use then confirmed the unchanged live app showed `TOTAL 1` and `YouTube ... LIVE 1`. Earlier logs show the same upstream number/null cycling, so the exact provider-side reason for omitting the count remains unknown.
**Fix:** No code, reconnect, restart, destination, or stream-setting change. Let the next Restream `updateStatuses` frame restore the numeric value. The current renderer behavior is intentional: an online platform with no numeric count renders `—`, while the aggregate can remain `0` when another online platform reports numeric zero. At 2026-08-12T15:07Z, Gmail confirmed `Message sent` from the matching account to `support@restream.io` with subject `Intermittent YouTube live viewer count missing while channel remains online`; the report included the event ID and transition timestamps but no raw logs, access token, attachments, or unrelated data.
**Commit:** working-tree investigation note
**Guard:** For a live `—` row, correlate the screenshot timestamp with `~/Library/Logs/Restream Chat++/viewer-stats.jsonl`, distinguish `online:true/viewers:null` from socket lifecycle errors, and verify current state through Computer Use before changing anything. Do not infer a chat outage from the separate viewer feed.
---

---
**Date:** 2026-08-09T12:16:45Z
**Trigger:** Ethan: "is youtube chat in restream down or smth check myresteam chat+"
**Symptom:** Restream Chat++ stayed globally Connected but the channels panel showed YouTube alone as `ERROR youtube_livechat_not_found`; Twitch, Facebook, X, and Discord remained connected, and no YouTube messages for the current broadcast reached the app.
**Root cause:** This incident was upstream of Restream Chat++. Its live Chat API WebSocket remained healthy and kept delivering heartbeats. Restream initially reported the exact YouTube event `QqwxyKLdPmA` connected, then changed it to `youtube_livechat_not_found` at 2026-08-09T11:38:35Z and repeated that state. At investigation time, YouTube's public watch page reported the same event live and exposed `liveChatRenderer`, while Restream's public status page reported Chat operational with no recent incident. Restream began reporting the same event connected again at 2026-08-09T12:31:20Z and kept reconnecting successfully afterward without any destination, event, OBS, YouTube, or stream-setting change. That evidence supports a transient per-broadcast Restream-to-YouTube chat lookup failure, not a broad outage or a local client/socket failure; the exact upstream provider cause remains unknown.
**Fix:** No code, destination, OBS, or stream-setting change. A manual Restream Chat++ Reconnect at 2026-08-09T12:20:21Z safely refreshed OAuth and rebuilt the chat/viewer WebSockets, but Restream immediately returned the same YouTube-only `youtube_livechat_not_found` state while all other connections succeeded. The connection then recovered autonomously about 11 minutes later. Avoid restarting the app or toggling a live destination as a first response; confirm the exact event in `raw-frames.jsonl`, verify public YouTube live-chat availability, then report the per-broadcast failure to Restream Support. At 2026-08-09T12:26Z Gmail confirmed delivery of the timestamped evidence and safe-recovery result to Restream's official `support@restream.io` address from the matching Restream account email; no raw logs or unrelated personal data were attached.
**Commit:** working-tree investigation note
**Guard:** For a single-platform connection error, inspect recent `connection_info` plus continuing heartbeats in `~/Library/Logs/Restream Chat++/raw-frames.jsonl`. Separate app/socket health, Restream's per-channel reason, the exact public event state, and the provider status page before calling it a client bug or global outage.
---

---
**Date:** 2026-08-08T13:38:00Z
**Trigger:** Ethan: "the silence user btn doesnt fully work ... it needs to turn off notifs and stt for that user when i click it"
**Symptom:** Clicking the per-row Silence user button looked inert. Live evidence showed Twitch author `burntballs_` continued to be read before the settings edit, while the saved anchored rule `^burntballs_$` proved the button path could add a TTS rule. The clicked historical row never changed, the action did not touch the notification username filter, and speech already in flight/queued was unaffected, so Ethan had to open Settings and add rules manually.
**Root cause:** The v0.1.91 implementation fire-and-forgot a whole renderer Settings snapshot into `SETTINGS_SET`, updated only `filters.tts.ignoreUsernameRegex`, attached ignored badges only when a message first arrived, exposed no success/failure state, and gave the native TTS queue only a message ID (no author identity for targeted cancellation).
**Fix:** The per-row action now invokes atomic main-process `SETTINGS_SILENCE_USER`: main reloads current Settings, adds an exact regex-escaped rule to both TTS and notification username filters (respecting an existing broader rule), saves once, and cancels only that user's current/queued native speech. The renderer predicts both rules for immediate feedback, reconciles the returned Settings, surfaces IPC failures, recomputes old-row badges from live patterns, and replaces the hover button with persistent `✓ Silenced` only when both side effects are suppressed.
**Commit:** v0.1.97 release
**Guard:** `silence-user-button.test.tsx` exercises the real MessageRow click and live historical-row transition; `hide-user.test.ts` pins the shared both-filter reducer and partial-axis completion; `tts-dispatch.test.ts` pins username propagation into native enqueue; `tts-native.test.ts` pins exact case-insensitive author cancellation while preserving other viewers' queued speech. Verification: all 721 tests pass, typecheck is clean, lint has zero errors (pre-existing warnings only), and production packaging succeeds.
---

---
**Date:** 2026-08-01T14:23:22Z
**Trigger:** Ethan: "Restream Chat++ notifications arrive but no user's message is spoken"
**Symptom:** Incoming messages, including `@TW_Guesty`, logged `tts_decision: read`, `native_speak_start`, and `native_speak_end` with exit code 0, but no speech was audible. Notifications and music remained audible, and neither the TTS mute nor username filters were responsible.
**Root cause:** The persisted macOS TTS configuration had drifted to `voiceURI: "Daniel (Enhanced)"` at volume `0.54`; the current `say -v '?'` list exposes `Daniel`, not `Daniel (Enhanced)`. The live correction changed both variables to the verified working pair (`Daniel`, volume `1`), so this incident did not independently prove whether the stale voice name or attenuation was the sole cause.
**Fix:** Through the running app's MCP settings bridge, set `voiceURI` to `Daniel` and TTS volume to `1`, leaving TTS enabled and unmuted. No app restart, reinstall, or macOS audio-service restart was needed.
**Commit:** working-tree investigation note
**Guard:** Verify the selected voice against the current native voice list, then confirm `list_settings` and a real incoming-message `native_speak_start` row. Physical acceptance in this incident: Ethan heard the plain `say -v Daniel` test and then heard three real Restream messages; their log rows used `voice: "Daniel"`, `volume: 1`, and exited 0.
---

---
**Date:** 2026-07-14T12:52:59Z
**Trigger:** Ethan: "also total live viewers is cut off" + screenshot
**Symptom:** Opening the live-viewer breakdown near the toolbar's right edge showed only the panel's left portion. The Total label appeared without its value, and the header close button, live/offline pills, and per-platform counts were all outside the clipped window area.
**Root cause:** `.viewer-popover` was absolutely positioned with `left: 0` relative to `.viewer-count-panel`. Because the viewer chip sits in the toolbar's right-hand cluster, the 280px panel grew rightward beyond the BrowserWindow viewport.
**Fix:** v0.1.96 in `src/renderer/styles.css`: anchor the viewer popover inward with `right: 0; left: auto`; retain the existing viewport-capped width.
**Commit:** this release commit (PR follows)
**Guard:** `src/__tests__/viewer-count.test.tsx` statically pins the `.viewer-popover` right-edge anchor and rejects a regression to `left: 0`. Full suite 714/714 green, typecheck clean, lint 0 errors. Rebuilt arm64 app passed strict Developer-ID signature and Gatekeeper assessment; live visual verification at the narrow 460px window showed `TOTAL 1`, close button, all LIVE pills, and per-platform counts fully visible.
---

---
**Date:** 2026-07-14T12:44:20Z
**Trigger:** Ethan: "my restream chat++ app wont update ... install update and restart ... same update banner"
**Symptom:** A release was downloaded and the banner showed Restart, but the first Restart relaunched the old version with the same banner. A later re-download/restart could succeed. Production evidence: v0.1.95 staged at 2026-07-13 20:16, hourly checks continued through 2026-07-14 13:15, the 13:20 Restart failed with `No update available, can't quit and install`, and only the fresh 13:20 download installed successfully at 13:30.
**Root cause:** `update-electron-app` owns an unconditional internal `setInterval(autoUpdater.checkForUpdates)`. It kept polling after Squirrel.Mac emitted `update-downloaded`. Those later `update-available`/`update-not-available` cycles invalidated Squirrel's native staged-install slot, while our module-level `updateDownloaded=true` remained stale and continued presenting Restart.
**Fix:** v0.1.96 in `src/main/updater.ts`: configure the same `update.electronjs.org` feed directly with `autoUpdater.setFeedURL`, own the startup/hourly checks, and skip every background native check while a check/download is in flight or an update is staged. The in-app banner remains the only Restart surface.
**Commit:** this release commit (PR follows)
**Guard:** `src/__tests__/update-flow-fixes.test.ts` advances three hourly intervals after `update-downloaded` and proves `checkForUpdates` is never called again; direct-feed configuration is pinned. Full suite 714/714 green, typecheck clean, lint 0 errors (pre-existing warnings only). A local arm64 package was Developer-ID signed, installed over `/Applications/Restream Chat Plus Plus.app`, relaunched connected with no update banner, and passed strict deep signature verification.
---

---
**Date:** 2026-07-13T13:17:27Z
**Trigger:** task: live viewer count display (2026-07-13)
**Symptom:** Feature request: show live viewer count in the app like the official Restream chat does. Open question was WHERE the number comes from — the chat WS raw-frames.jsonl carries NO viewer data (only heartbeat/connection_info/connection_closed/event/reply_*/relay_* actions).
**Root cause:** n/a (new feature). Data source discovered: Restream's SEPARATE 'Streaming Updates' WebSocket wss://streaming.api.restream.io/ws?accessToken=<same OAuth bearer as chat WS; needs stream.read scope which the app already requests>. Docs: developers.restream.io/private-api/streaming-updates. On connect it replays ~1min of updates then streams live. The 'updateStatuses' frames carry per-channel viewers:number|null + online:boolean + platformId/channelId/channelIdentifier/updatedAt. viewers is null on platforms that hide it (X/Twitter commonly). No token -> HTTP 400 on handshake. REST alternative (GET /v2/user/events/{id}/analytics/viewers) is HISTORICAL only, not live — WS is the right source.
**Fix:** v0.1.94. Pure core src/shared/viewer-stats-core.ts (applyStreamingUpdate folds updateStatuses/deleteOutgoing into a channelId map; aggregateViewerStats sums viewers over ONLINE channels, null-total when all hidden; sweepStaleViewerStats 5min TTL so a dead socket can't freeze the count). Thin socket shell src/main/viewer-stats.ts (5s->5min backoff, ws ping keepalive w/ 2-missed-pong terminate since the feed is silent when not live, 60s TTL sweep timer, viewer-stats.jsonl lifecycle log via appendJsonl). main.ts: every chat.setToken site also feeds viewerStats (sign-in, startup-resume via fan-out shim, performFullReconnect, transient-refresh recovery); stop on AUTH_LOGOUT + before-quit; IPC.VIEWER_STATS push + VIEWER_STATS_GET pull (mount-race pattern). Renderer: ViewerCount.tsx chip in toolbar next to ChannelsPanel — hidden when not live, '—' when live-but-counts-hidden, sum + per-platform native tooltip otherwise. Optional-chained rcpp.getViewerStats?./onViewerStats?. so old preloads/partial test mocks degrade quietly.
**Commit:** this feature commit (PR follows)
**Guard:** src/__tests__/viewer-stats.test.ts (fold/replace/delete/malformed/aggregate/TTL/platform-name + client no-token lifecycle) + viewer-count.test.tsx (render rules incl act() wrapper gotcha: react-test-renderer toJSON() is null without act in this repo's React-19 env). 705/705 green, typecheck+lint clean.
---

---
**Date:** 2026-07-08T14:26:07Z
**Trigger:** task: focus chat input on app activate
**Symptom:** Feature request: when RC++ becomes frontmost (Dock click / Cmd+Tab / window click), the chat message input should auto-focus so Ethan can type immediately without clicking it. ALSO hit the stale-local-repo trap: local main was 4 commits behind origin which had already released v0.1.92, so the first version bump to 0.1.92 collided — shipped as 0.1.93 after rebasing onto origin/main.
**Root cause:** n/a (new feature, not a bug). ChatInputInline owns the textarea ref; nothing focused it on window activation.
**Fix:** v0.1.93. Main (src/main/main.ts): createMainWindow adds mainWindow.on('focus') to send IPC.FOCUS_CHAT_INPUT; app.on('activate') also sends it on the already-open-window branch. IPC.FOCUS_CHAT_INPUT added in src/shared/types.ts; preload onFocusChatInput subscription in src/preload.ts. Renderer (src/renderer/ChatInputInline.tsx): new useEffect ABOVE the !authenticated early-return (hook-order rule) subscribes to BOTH window.rcpp.onFocusChatInput AND the window focus DOM event, both calling a guarded focusInput() that focuses taRef.current — skips if input unmounted, if there is an active non-collapsed text selection, or if focus is already in another editable field. typeof window guard keeps it inert under node vitest env.
**Commit:** (this feature commit; see PR #8)
**Guard:** chat-input-hook-order.test.ts pins hooks-above-early-return (new useEffect sits above it). Full suite 684/684 green, typecheck clean. Thorough inline comments at all four edit sites.
---

---
**Date:** 2026-06-22T17:24:56Z
**Trigger:** Ethan: "the update mechanism is super dodge... install update in the banner does nothing, or restart too does nothing"
**Symptom:** Install Update could feel like a dead click when the GitHub banner said a newer release existed but Squirrel answered `update-not-available`; Restart could also feel dead because the renderer ignored `{ ok:false, reason:'no-update-downloaded' }` from main.
**Root cause:** The update UI had idempotent/native mismatch branches with no visible renderer consequence. `triggerSquirrelDownload()` reset state silently on user-clicked `update-not-available`, and an already-staged click returned `already-staged` without rebroadcasting `ready-to-install`. In the ready banner, App.tsx fired `void rcpp.quitAndInstall()`, so refused/stale Restart results were discarded.
**Fix:** v0.1.92: updater.ts tracks whether a Squirrel check was launched by the visible Install button; if that user-clicked check emits `update-not-available` while `pendingDownloadVersion` is newer than `app.getVersion()`, it logs `updater.squirrel-not-available-after-user-click` and broadcasts a visible error pane with the GitHub Releases fallback. Already-staged clicks rebroadcast `ready-to-install`. UpdateBanner.tsx now handles `already-downloading` / `already-staged` toasts and awaits Restart IPC, showing `Restarting…` plus an error toast on refusal. App.tsx returns the Restart promise instead of fire-and-forget.
**Commit:** this commit
**Guard:** src/__tests__/update-progress-feedback.test.ts user-click/no-update mismatch + already-staged rebroadcast + quiet background no-update; src/__tests__/update-banner-installing-state.test.tsx idempotent Install toasts + Restart busy/error feedback; update-banner-download-wiring/error-pane tests updated for async Restart. Full local suite: 684 tests pass, typecheck clean.
---

---
**Date:** 2026-06-22T15:12:27Z
**Trigger:** task: silence user button
**Symptom:** Per-row 'Hide user' button fully dropped a user's messages from the feed AND suppressed all side effects; Ethan wanted messages to still SHOW but not be read by TTS.
**Root cause:** Button fed settings.hiddenUsers (drops rows + gates side-effects) instead of the TTS username ignore axis.
**Fix:** Repurposed button to 'Silence user' (v0.1.91): new pure helper addSilencedUser() in src/shared/message-filters.ts adds an anchored regex-escaped ^name$ entry to settings.filters.tts.ignoreUsernameRegex; App.tsx handleSilenceUser persists via the same nested-spread as SettingsDrawer.patchTtsUsernameFilter; renamed onHideUser→onSilenceUser + CSS .hide-user-btn→.silence-user-btn. hiddenUsers plumbing left dormant for the Settings list/unhide.
**Commit:** 68bf53d
**Guard:** src/__tests__/hide-user.test.ts: addSilencedUser suite (escape/anchor/dedupe/no-op/superstring-no-overmatch) + handler-simulation suite (click writes TTS list, leaves hiddenUsers untouched, silenced user stays visible but ignoredByTts).
---

---
**Date:** 2026-06-09T17:20:30Z
**Trigger:** voice 4512
**Symptom:** Sent chat message never appeared in app and left ZERO log trace (no 'send' row, no 'preflight' row, no 'optimistic-timeout' row in chat-send.jsonl). Send dropped during a connection-in-flux window right after a 'replaced' drain. Also: the queue tried each send EXACTLY ONCE — no retry, no reconnect-between-attempts — so a transient failure (no-session-cookies / no-active-connections / lapsed token / un-sniffed showId) permanently lost the message.
**Root cause:** (1) The runSend wrapper's 'not-authenticated' early bail in main.ts returned without writing any chat-send.jsonl row (sendChatText, which owns preflight logging, was never reached) — the silent-drop, zero-trace gap. (2) chat-send-queue.ts ran runSend once and emitted 'sent'/'failed' with no retry loop at all.
**Fix:** v0.1.90 (voice 4512): chat-send-queue.ts now wraps each send in a BOUNDED exponential-backoff retry loop (up to 5 attempts; ~1s,2s,4s,8s,16s capped) with a managed reconnect/'refresh' (performFullReconnect) between attempts, wired via new reconnectBetweenRetries option. isRetryableSendFailure() classifies transient reasons. SAFETY: only ok:false (== no confirmed 200) is ever re-POSTed, always reusing the same clientReplyUuid (Restream dedupes) → no double-send; ok:true short-circuits. New 'retrying' ChatSendStatus + ChatMessage.pendingSend='retrying' + sendAttempt/sendMaxAttempts render 'sending… (retry N/5)' so the message is ALWAYS visible. Terminal 'failed' renders a clickable ⚠ 'tap to retry' (handleRetrySend re-runs the loop). Every attempt writes a 'retry-attempt' chat-send.jsonl row; the not-authenticated gate in main.ts now emits a 'preflight' row — closes the zero-trace gap.
**Commit:** e770de2
**Guard:** src/__tests__/chat-send-retry.test.ts (retry ladder + reconnect-between + recover-mid-retry → sent + exhaust → failed + no double-POST + same-uuid + per-attempt logging + reconnect-throw resilience) + chat-message-reducers.test.ts (applyRetryingSendStatus, failed strips counters). Existing single-attempt tests pinned with maxSendAttempts:1.
---

---
**Date:** 2026-06-08T18:43:21Z
**Trigger:** voice 4507
**Symptom:** App had two update UIs: a flaky top-bar download progress bar (Install Update button → foreground autoUpdater.checkForUpdates → broadcasts kind:downloading → DownloadingPane) that hits transient 'internet appears offline' errors and dead-ends ('worked after about three times'), vs a reliable snackbar+Restart path (background hourly Squirrel poll silently downloads → ready-to-install → Restart → quitAndInstall → quick toast, no re-download). Ethan wanted the reliable one everywhere.
**Root cause:** update-electron-app's hourly background poll already downloads the bundle silently (main.log: checking-for-update → update downloaded, ready to install, no user action). But the banner's available-state Install Update button kicked a SEPARATE foreground download AND broadcast kind:downloading, forcing the top-bar progress pane — the path that fails on a network blip (logs 12:16 burned all 3 v0.1.85 retries → error pane). Two surfaces for the same download; the foreground one is the flaky one.
**Fix:** src/main/updater.ts: added exported const SUPPRESS_FOREGROUND_DOWNLOAD_UI=true and gated it at the single broadcastSquirrelStatus choke point — every kind:'downloading' payload is now dropped (from ALL sources: user click, checking-for-update/update-available rebroadcasts, download-progress chunks, retry rebroadcasts). Banner never enters the flaky top-bar DownloadingPane; stays in 'available' (snackbar after click) until the BACKGROUND download fires update-downloaded → ready-to-install → Restart → quitAndInstall (the reliable snackbar path). checkForUpdates() still kicked (idempotent nudge), all internal state/retry/MCP bookkeeping intact, error pane NOT gated. UpdateBanner.tsx decideToast squirrel copy changed to 'Update downloading in the background — you will be prompted to restart…'. v0.1.89.
**Commit:** 1f3dbf7 (LEARNINGS line is self-referential to this commit)
**Guard:** src/__tests__/update-progress-feedback.test.ts rewritten: asserts NO kind:downloading reaches renderer from click/checking/update-available/download-progress, ready-to-install still fires, error pane still passes through, SUPPRESS_FOREGROUND_DOWNLOAD_UI===true. update-banner-installing-state.test.tsx toast copy assertions updated. 650 tests green, typecheck clean. Reversible: flip the const to re-enable top-bar bar.
---

---
**Date:** 2026-06-08T17:06:13Z
**Trigger:** voice 4504
**Symptom:** Own sent message keeps stuck red ⚠ 'unconfirmed' badge even after the v0.1.87 auto-reconnect re-subscribes and the message actually delivered. The 30s OPTIMISTIC_SEND_TIMEOUT_MS flipped the placeholder to pendingSend:'failed' during the echo-dead window; nothing ever downgraded it back.
**Root cause:** Two gaps after v0.1.87. (1) A LATE WS echo (arriving after the 30s timeout, common right after a resubscribe) technically already cleared the ⚠ via dedupeOptimisticOnEcho replacing any pendingSend!==undefined placeholder, but it was undetected/unlogged. (2) When NO echo replays after re-subscribe (Restream doesn't always replay queued replies), nothing cleared the ⚠ even though the POST had returned HTTP 200 (= it delivered). No signal told the renderer 'a managed reconnect just succeeded' to sweep those.
**Fix:** v0.1.88. ws-client.ts emits new 'reconnect-succeeded' event on the SUCCESS branch of both managed-recovery paths (v0.1.86 drain + v0.1.87 unconfirmed-send via emitReconnectSucceeded). main.ts forwards it to renderer over new IPC.CONN_RECONNECT_SUCCEEDED, and the manual Reconnect handler sends the same IPC directly on success. Renderer (App.tsx): tracks HTTP-200 sends in httpOkSendsRef (from the queue's 'sent' ChatSendStatus, capped 2000), on onReconnectSucceeded runs resolveLingeringFailedSendsOnReconnect() which clears ⚠ ONLY for failed sends whose id is in the HTTP-200 set (genuine non-200 failures stay flagged; never re-sends). Late-echo path logs late-echo-resolved when an echo resolves a 'failed' placeholder. New chat-send.jsonl rows: late-echo-resolved + reconnect-sweep-cleared.
**Commit:** 5c5271c
**Guard:** src/__tests__/send-warning-resolution.test.ts (4 spec cases a-d: late echo clears ⚠, reconnect sweep clears HTTP-200, NOT no-200, confirmed unaffected) + ws-unconfirmed-send-recovery.test.ts new cases (emits reconnect-succeeded on unconfirmed + drain success, NOT on provider fail). 647 tests pass, typecheck clean. Thorough inline comments at every new decision point.
---

---
**Date:** 2026-06-07T14:20:55Z
**Trigger:** voice/msg send-warning auto-reconnect request 2026-06-07
**Symptom:** Sent chat message shows red ⚠ unconfirmed badge: POST to /api/client/reply returns 200 {success:true} but no matching ws-echo-received (reply_created) frame arrives within the renderer's 30s OPTIMISTIC_SEND_TIMEOUT_MS guard. Clicking the manual Reconnect button restores it.
**Root cause:** The chat WS goes echo-dead (stale/replaced socket) so sends stop round-tripping, but connection_closed may NOT have drained the connections map to zero — so v0.1.86's handleAllConnectionsDrained never fires. No automatic recovery existed for this echo-dead-but-not-drained state.
**Fix:** v0.1.87: renderer optimistic-send timeout (App.tsx) fires rcpp.notifyUnconfirmedSend() -> IPC.CHAT_SEND_UNCONFIRMED -> main chat.requestUnconfirmedSendRecovery() in ws-client.ts runs the SAME managed reconnect (performFullReconnect -> OAuth refresh + chat.reconnect -> re-subscribe) the manual button uses. Reuses v0.1.86 debounce(2s)+cooldown(45s)+replace-war state so the two triggers never fire competing reconnects. Does NOT re-send the message (POST already 200 = avoid dup).
**Commit:** 3796309
**Guard:** src/__tests__/ws-unconfirmed-send-recovery.test.ts (8 tests: 1 unconfirmed->1 reconnect, burst->1, cooldown suppresses 2nd, confirmed send->no reconnect, replace-war stand-down, no-provider/socket-closed bails, listener reporting). Thorough inline comments at the requestUnconfirmedSendRecovery decision ladder + UNCONFIRMED_SEND_COOLDOWN_MS comment block.
---

---
**Date:** 2026-06-06T14:14:01Z
**Trigger:** voice 4491
**Symptom:** TTS silently went dead for 47 min mid-stream; chat feed stopped getting new messages but the app still looked 'connected' (heartbeats flowing)
**Root cause:** Restream sent connection_closed reason:'replaced' for ALL platform connections at once, draining the in-memory connections map to empty WHILE the WS socket stayed OPEN. Zero subscriptions => no chat 'event' frames => decideTtsAction never called. Stale-inbound watchdog couldn't catch it (heartbeats keep lastInboundFrameAt fresh so staleForMs never crossed 90s); nothing went through handleDisconnect (socket never closed) so the managed re-subscribe (chat.reconnect via reconnectProvider) never fired.
**Fix:** ws-client.ts handleAllConnectionsDrained(): on connection_closed draining active connections to 0 while socket OPEN, schedule ONE debounced (2s) managed reconnect via reconnectProvider (re-subscribes); debounce coalesces the per-platform 'replaced' burst. Replace-war guard: a 2nd drain within 60s of our own recovery = competing client, stand down (no ping-pong) + surface ConnectionState.warning. Added lastChatTrafficAt observability (NOT a reconnect trigger). New structured log rows. Surfaced warning inline in renderer status label.
**Commit:** 6299a3e
**Guard:** src/__tests__/ws-subscription-recovery.test.ts: (a) drain-all schedules exactly ONE reconnect, (b) replace-war guard blocks 2nd + warns, (c) quiet-but-connected does NOT reconnect, + socket-not-open bail + attempt-listener report. 629/629 pass. Thorough inline comments at every decision point.
---

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
**Fix:** v0.1.74 originally used four stacked layers: (1) webPreferences.backgroundThrottling:false + webContents.setBackgroundThrottling(false) on main window. (2) app.commandLine.appendSwitch disable-background-timer-throttling / disable-renderer-backgrounding / disable-backgrounding-occluded-windows before app.ready. (3) a lifetime powerSaveBlocker assertion, removed in v0.1.106 after native main-process TTS made it obsolete and live `pmset` evidence proved it prevented idle system sleep. (4) LOAD-BEARING at the time: browser TTSEngine.speak() detected isPageHidden() and routed the utterance to the native window.rcpp.ttsNative say bridge instead of speechSynthesis when hidden; v0.1.81 later removed renderer Web Speech entirely in favour of native main-process TTS.
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
