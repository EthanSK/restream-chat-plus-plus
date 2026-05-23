# Changelog

## v0.1.62 — fix broken sends post-v0.1.61 (split chat-partition auth after Developer ID signing)

Critical hotfix for the regression Ethan reported 2026-05-23 right
after manually installing the signed v0.1.61: every outgoing message
silently failed, no errors in the UI, and `chat-send.jsonl` was empty
so the failure was invisible from disk.

**Codex xhigh diagnosis (root cause):** the v0.1.59 ad-hoc → v0.1.61
signed Developer ID transition split the app's auth state. OAuth token
was repaired by the post-install sign-in (the OAuth flow uses the
`persist:restream-oauth` partition + `safeStorage`, which survived the
identity flip). But the chat-session cookies that the
chat.restream.io webchat itself writes into that partition —
`accessXsrfToken`, `refreshToken`, `refreshXsrfToken` — were wiped,
because codesigning a different identity flipped the partition's
scope. The OAuth callback's redirect only writes analytics cookies (it
never passes through chat.restream.io), so every send returned
`no-session-cookies` at the pre-`performSend()` cookie gate. The JSONL
writer lives inside `performSend()`, so zero rows were emitted.

**Three deltas:**

1. **`ensureRestreamChatCookies` helper** (`src/main/chat-send.ts`):
   exported function that guarantees the chat partition has an
   `accessXsrfToken` before declaring the app send-ready. Three-stage
   strategy: (a) read the jar — already present → return; (b) run the
   existing hidden cookie-provisioner (BrowserWindow → chat.restream.io,
   harvests cookies via the live webchat boot); (c) if hidden fails and
   `interactiveFallback: true`, surface a visible chat.restream.io
   window so the user can complete the handshake interactively. Auto-
   destroys after 60s or when the XSRF cookie appears.

2. **Wired from `AUTH_START`** (`src/main/main.ts:692`): after
   `oauth.authenticate()` succeeds, call `ensureRestreamChatCookies`
   with `interactiveFallback: true` before `chat.setToken` / `chat.start`.
   Errors swallowed so a transient hydration failure doesn't gate the
   auth path — the renderer can still try to send and gets the
   preflight log row below if cookies are still missing.

3. **Preflight diagnostic logging** (`src/main/chat-send.ts:521 / 529`):
   `chat-send.jsonl` now captures a `{phase:"preflight", reason, ...}`
   row whenever `sendChatText` bails out before `performSend()` —
   covering `no-session-cookies`, `no-active-connections`, and
   `empty-text`. Records the cookie names (not values) so the v0.1.62
   split-auth signature (analytics cookies present, no XSRF) is
   instantly recognisable on disk. The existing POST records now carry
   `phase: "send"` for unambiguous `jq` filtering.

**Workaround if v0.1.62 doesn't catch your case:** fully sign out + sign
in. The post-OAuth `ensureRestreamChatCookies` call will harvest the
chat-session cookies. Worst case: quit + delete
`~/Library/Application Support/Restream Chat Plus Plus/Partitions/restream-oauth/`
+ relaunch to force fresh cookie provisioning.

## v0.1.61 — visible feedback during update download + signature-mismatch error pane

Fixes the silent-failure mode Ethan hit on 2026-05-23 (voice 13:31 BST):
clicking Install Update produced an "Installing…" spinner + a 3s toast
that said "Downloading update…", then **dead air**. The download was
actually failing 22 seconds later with `Code signature ... did not pass
validation` (Squirrel rejected the ad-hoc → Developer-ID identity
swap), but the renderer never heard about it because the `error` event
in `src/main/updater.ts` only logged + reset internal state without
broadcasting an `UpdateInfo` to the renderer.

**Three deltas:**

1. `triggerSquirrelDownload()` now broadcasts a `kind: 'downloading'`
   payload IMMEDIATELY (before `autoUpdater.checkForUpdates()` fires)
   so the banner flips out of `available` the moment the IPC round-
   trip resolves. `checking-for-update` + `update-available` also
   rebroadcast — the banner shows an indeterminate progress bar with
   the version label ("Downloading Restream Chat++ v0.1.61…") until
   Squirrel reports its first chunk.

2. The Squirrel `error` event now broadcasts a `kind: 'error'`
   `UpdateInfo` with three new fields:
   - `errorCategory`: `signature-mismatch` | `network` | `staging` |
     `unknown` — categorised by `categoriseUpdaterError()` so the
     banner can pick the right user-facing wording.
   - `errorReleaseUrl`: the GH releases URL the banner offers as the
     manual-fallback "Open GitHub Releases" button.
   - `error`: the raw Squirrel error string for the `unknown` branch.

   The banner renders a persistent red error pane (not a transient
   toast) with the categorised headline + recovery guidance + the
   manual-fallback button. For signature mismatch specifically it
   tells the user to reinstall from GitHub Releases.

3. The `download-progress` event now forwards `bytesPerSecond` +
   `total` + `transferred` (not just `percent`). The banner shows
   concrete activity — bytes-downloaded / bytes-total / KB-or-MB-per-
   second / elapsed time — instead of just an integer percent that may
   sit at 0 for tens of seconds. Adds a "Squirrel hasn't reported
   progress yet" hint after 30s of dead air so the user knows the
   click did kick the pipeline.

Also extended `UpdateInfo` with `downloadBytesTransferred`,
`downloadBytesTotal`, `downloadBytesPerSecond`, `downloadStartedAt`,
`errorCategory`, `errorReleaseUrl`. `BannerState` adds an `'error'`
state.

- `src/main/updater.ts` — new `categoriseUpdaterError`,
  `rememberPendingDownloadVersion`, immediate `downloading` broadcast,
  `error` event → renderer broadcast, extra bytes fields in
  `download-progress` forwarder.
- `src/main/github-update-check.ts` — calls
  `rememberPendingDownloadVersion(tagName)` when GH says an update is
  available, so subsequent Squirrel-side broadcasts carry the version
  string (Squirrel itself doesn't know the version until
  `update-downloaded` fires).
- `src/renderer/UpdateBanner.tsx` — new `decideErrorCopy`, `formatBytes`,
  `formatSpeed` pure helpers; `DownloadingPane` sub-component renders
  bytes + speed + elapsed-time + stalled-hint; new `error` state
  renders the persistent error pane.
- `src/renderer/App.tsx` — resets `updateDismissed` on Squirrel-side
  `error` payloads (carries `errorReleaseUrl`) so the error pane is
  always visible on the new error broadcast.
- `src/renderer/styles.css` — `.update-banner-error` red theme +
  `.update-banner-progress-meta` row for bytes/speed/elapsed.
- Regression tests in `src/__tests__/update-progress-feedback.test.ts`
  (immediate-downloading broadcast, error-event broadcast,
  category-recognition) and
  `src/__tests__/update-banner-error-pane.test.tsx` (error-pane render,
  downloading-pane bytes/speed display, formatBytes/formatSpeed
  helpers).

## v0.1.60 — fix double send-sound (audio dupe sibling of v0.1.59)

Fix the audio counterpart to the v0.1.59 visual-duplicate bug. After
v0.1.59 the feed correctly showed one entry per sent message, but the
TTS (and native notification) still played TWICE: once when the user
hit Enter, once when the server echo arrived and the dedupe replaced
the placeholder in place. Voice 2026-05-23: "In Restream Chat++, the
newest version, I no longer see double messages sent, but I hear
double messages sent. One when I click enter, one when it's sent."

**Root cause:** App.tsx's side-effect useEffect was keyed on
`[messages]` and treated EVERY array reference change as a fresh
"new last message" to speak. The optimistic-send flow produces two
such reference changes per sent message — placeholder insert, then
echo dedupe-replace — and the useEffect dutifully spoke each one.
The v0.1.59 visual fix made these two transitions converge on the
same displayed entry, but the side-effect trigger still fired twice.

**Fix:** new pure helper `shouldTriggerSideEffects` gates the useEffect
on two conditions:

1. `pendingSend === undefined` — never speak optimistic placeholders or
   failed-send entries. Only confirmed echoes (and incoming messages)
   qualify. This kills the Enter-press "first sound".
2. `m.id !== lastSpokenIdRef.current` — defensive guard against
   re-firing on the same id when a dedupe-replace mid-array doesn't
   actually move the last element (e.g. a viewer message arrived
   between the placeholder and the echo).

App.tsx now stores the last spoken id in a ref and consults the helper
before enqueueing TTS / dispatching `rcpp.notify`.

- New `shouldTriggerSideEffects(lastMessage, lastProcessedId)` in
  `src/renderer/chat-message-reducers.ts`.
- Wired into App.tsx's existing side-effect useEffect; behind a single
  early-return guard. No refactor of the surrounding logic.
- Regression tests in `src/__tests__/chat-message-reducers.test.ts`
  including a full optimistic-send lifecycle simulation that asserts
  exactly ONE trigger per logically-sent message, plus the
  viewer-message-between-placeholder-and-echo edge case.

## v0.1.59 — fix duplicate-message bug on send

Fix the regression introduced in v0.1.43 where every message the user sent
via the inline chat input rendered TWICE in the feed: once as the
"sending…" optimistic placeholder, and once as the WebSocket `reply_created`
echo. The placeholder's `pendingSend` flag never cleared and the user saw
each message duplicated.

**Root cause:** the renderer mints a `clientId` (uuid) when the user hits
Enter, ships it down to Restream as `clientReplyUuid`, and assigns it as
the optimistic placeholder's `id`. The WS echoes the reply back with BOTH
`clientReplyUuid` (round-tripped from the POST) AND `replyUuid` (Restream's
server-side reply id). The normaliser in `src/main/normalize.ts` preferred
`replyUuid` first, so the surfaced ChatMessage's `id` was the server id —
which did NOT match the placeholder's `clientReplyUuid`-based id. The
`dedupeOptimisticOnEcho` reducer's `id` lookup missed, fell through to
the append branch, and the echo joined the feed as a SECOND entry instead
of replacing the placeholder.

**Fix:** flip the priority in `normalize.ts` so `clientReplyUuid` wins when
present, falling back to `replyUuid` only for replies that have no
client-minted uuid (e.g. history replay, replies sent from the official
Restream Chat webchat). End-to-end the echo's `id` now matches the
optimistic placeholder's `id` and the dedupe replaces in place.

- One-line change in `src/main/normalize.ts` (the `reply_created` id
  resolution).
- Updated `src/__tests__/normalize.test.ts` — flipped the existing
  assertion to expect `clientReplyUuid` and added two new regression
  tests: the duplicate-bug end-to-end case, and the webchat-only
  `replyUuid`-fallback case.

## v0.1.48 — seed `^viewer$` into regex-ignore lists

Add `^viewer$` (anchored, case-insensitive via the uniform `i` flag the
filter compiler applies to every pattern) to both `filters.tts.ignoreRegex`
and `filters.notifications.ignoreRegex` so the generic anonymous-platform
"Viewer" placeholder username's messages — whose text is literally
`Viewer` / `viewer` / `VIEWER` — never wake TTS or notifications.

- `DEFAULT_SETTINGS` now ships with the seed populated, so fresh installs
  get it out of the box.
- One-time migration (`seed-viewer-ignore-regex`) injects the entry into
  existing persisted settings on first launch after upgrade. The migration
  is idempotent — if the user later deletes the entry from the Settings
  drawer, it does NOT come back; if the entry was already present
  (manually added), the migration is a no-op for that list.
- Tracked via a new `settingsMigrationsApplied: string[]` field on the
  electron-store schema so future seeds follow the same pattern.

## v0.1.47 — disable auto-reconnect polling

Disable the WebSocket auto-reconnect loop per Ethan voice 3630 — the 60s
retry (v0.1.45) and the legacy exponential-backoff fallback were both
generating constant network traffic against `api.restream.io` that Ethan
suspected was clogging his Wi-Fi / ISP.

- On any disconnect, the WS client now flips state to `disconnected` and
  stays there. No retry timer is scheduled.
- The manual **Reconnect** toolbar button still works — it goes through
  `performFullReconnect()` → `chat.reconnect()` and bypasses the
  auto-retry path entirely.
- Other polling is unchanged:
  - GitHub update poller stays on its 1-hour cadence (not the culprit).
  - WebSocket heartbeat ping stays on 30s (intrinsic to the WS protocol).
  - Periodic chat-context REST refresh stays on 10 minutes (low frequency).
- Test-only escape hatch: `client.setAutoReconnectEnabled(true)` restores
  the v0.1.45 polling behaviour. Production default is `false`.

## v0.1.46 — connection-status flicker fix

Coalesce sub-750ms connection-status dips so the channels panel stops
flashing during Restream's boot-storm of `connected → connecting →
connected` cycles.

## v0.1.45 — unified auto-reconnect (superseded by v0.1.47)

Auto-reconnect was rewritten to use the same OAuth-refresh + reconnect
flow as the manual button, on a 60s cadence. Subsequently disabled by
default in v0.1.47 due to network-traffic concerns.

## [0.1.53] - 2026-05-22

### Reverted

Reverts v0.1.49, v0.1.50, v0.1.51, v0.1.52 — the post-v0.1.47 reconnect/auth patches all chased the wrong layer. The v0.1.52 boot path stopped calling `resumeAuth()` for users with a missing or rotated Keychain Safe Storage entry, leaving them silently stuck on "Idle" with no path forward. v0.1.47's auto-reconnect-disabled change is preserved (you can manually click Reconnect when needed).

If you were stuck on Idle after updating to v0.1.49-v0.1.52: this restores the v0.1.48 connection + auth code path.

## [0.1.54] - 2026-05-22

### Kept (re-applied) — real fixes from v0.1.52

- **Install Update banner error** ("update could not start"): re-entry guard + `downloadInFlight` / `updateDownloaded` flags.
- **"Restart" button no-op**: `notifyUser: false` + `quitAndInstallStagedUpdate()` with deferred quit + 1.5s fallback `app.relaunch()`.
- **Sign-out-on-every-update**: oauth `decryptTokenAsync` now distinguishes `'threw'` (preserve blob — transient Keychain prompt) from `'unparseable'` (wipe).
- **Sign Out button doing nothing**: `window.confirm()` returns `false` synchronously in Electron BrowserWindow — replaced with native `dialog.showMessageBox` via new `AUTH_CONFIRM_LOGOUT` IPC channel.
- **Refresh-token loop ("refresh-failed" cascades)**: coalesce concurrent `refresh()` calls behind `refreshPromise` (Restream rotates refresh tokens); 4xx response now triggers `logout()` so UI flips to the sign-in screen instead of silent Idle.

### Dropped (still reverted from v0.1.49/v0.1.50/v0.1.51)

- Pre-`open` retry budget + early-close 30s retry window — they patched the WS-retry layer when the actual user-facing bug was in boot/auth. Reverting these restores the v0.1.48 connection code path.

## [0.1.55] - 2026-05-22

### Fixed

- **Stuck on "Idle" after WS dropped mid-session.** v0.1.47 disabled all auto-reconnect (Ethan voice 3630 — to stop network polling). That accidentally killed the post-successful-connect recovery path too — a single WS blip after hours of healthy connection landed silently on Idle forever, even with the fixes shipped in v0.1.49-v0.1.54. v0.1.55 adds ONE post-connect retry after `POST_CONNECT_RETRY_DELAY_MS` (30s) when the WS reached `'open'` at least once this session. Strictly one-shot — not polling. Pre-`'open'` failures still go straight to disconnected (preserves the no-pre-connect-polling promise from v0.1.47).

### Tests

- Updated `ws-auto-reconnect-unified.test.ts` to assert the new one-shot behaviour + added a separate test verifying pre-`'open'` failures DON'T trigger the retry (v0.1.47 silent-disconnect preserved for that path).
