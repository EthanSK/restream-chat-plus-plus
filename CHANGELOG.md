# Changelog

## v0.1.52 — Auto-update flow trio + Sign Out fix + refresh-failed recovery

Fix for Ethan voices 3714 + 3715 + 3719 + 3720, five distinct bugs across
the auth, update, and connection layers:

**Bug 4 — "Sign out" button does nothing.** Ethan voice 3719: clicking
Sign out had no effect — no dialog, no state change, button stayed.
Root cause: the renderer's `onSignOut` handler called
`shouldProceedWithSignOut(window.confirm)`. In our Electron
BrowserWindow config (`sandbox: false`, `contextIsolation: true`),
`window.confirm` returns `false` synchronously without ever showing a
dialog — so the guard short-circuited and `authLogout()` was never
called.

**Fix in `src/renderer/auth-guards.ts`, `src/main/main.ts`, `src/preload.ts`:**
- Replace `window.confirm` with a `dialog.showMessageBox` round-trip
  through a new `AUTH_CONFIRM_LOGOUT` IPC channel. The native modal
  always renders reliably.
- `shouldProceedWithSignOut` is now async; tests updated to use
  `mockResolvedValue` instead of `mockReturnValue`, and a new
  "fail-closed on IPC throw" case was added.

**Bug 5 — Stuck on Idle with no recovery (OAuth refresh-failed loop).**
Ethan voice 3720 + `~/Library/Logs/Restream Chat++/reconnect-events.jsonl`
showed 11+ consecutive `refresh-failed` entries across multiple hours.
v0.1.47-v0.1.51 all fixed the WS retry layer, but the actual failure is
in the OAuth refresh layer: Restream rotates refresh tokens (every
successful refresh returns a NEW `refresh_token` that invalidates the
prior one), and the prior implementation had two problems:

1. **No coalescing of concurrent refreshes.** WS reconnect loop + manual
   button + renderer mount could all fire `refresh()` in parallel; one
   would "win" and rotate the token; the rest tried the now-invalidated
   token and got `invalid_grant`. Now wrapped in an in-flight
   `refreshPromise` so concurrent callers share the same round-trip.
2. **No fatal-error detection.** A 4xx response was swallowed as
   `undefined` and we kept retrying the (permanently dead) token
   forever. Now, a 4xx response triggers `logout()` — wipes the dead
   tokens, surfaces `authenticated: false` to the renderer via the
   existing AUTH_STATUS push, and the UI flips to the sign-in screen
   so the user has a clear "Sign in" path instead of a stuck "Idle"
   indicator. 5xx is still treated as transient (token preserved).

**Tests added (vitest unit tests):**
- `sign-out-confirm.test.ts` (updated) — async guard, fail-closed on
  IPC throw.
- `oauth-refresh-failure.test.ts` (new) — coalescing, 4xx-wipes-state,
  5xx-preserves-state, network-error-preserves-state, 200-rotates-pair.

---

Fix for Ethan voices 3714 + 3715, three distinct bugs in the same flow:

**Bug 1 — "Install Update" banner button sometimes errors.** Clicking the
button after Squirrel had already started downloading (or after the
update was already staged) called `autoUpdater.checkForUpdates()` a
second time, which throws `"The command is disabled and cannot be
executed"` on macOS — Squirrel's state machine refuses to re-enter the
check loop while a session is active. The banner surfaced this as the
cryptic "Update could not start" toast.

**Fix:** track Squirrel session state (`downloadInFlight`,
`updateDownloaded`) in `src/main/updater.ts`. When the user clicks
Install Update on a banner that's still showing `available` but a
download is in fact already in flight (or even already finished and
staged), return `{ ok: true, reason: 'already-downloading' | 'already-
staged', mode: 'squirrel' }` instead of calling `checkForUpdates()`
again. The banner's existing in-flight `downloading` / `ready-to-
install` state transitions then take over visibly within seconds.

**Bug 2 — "Update Ready" Restart button silently no-ops.** Two listeners
were racing on every `update-downloaded` event: our banner-flip
forwarder AND the `update-electron-app` library's built-in
`notifyUser: true` native dialog. When the user clicked "Later" on the
native dialog, Squirrel's state machine internally cleared the staged
update — but our banner still showed "Update ready - Restart" with our
`updateDownloaded` flag set. Clicking Restart then called
`quitAndInstall()` against an empty staged slot; Squirrel silently
no-op'd; nothing happened.

**Fix:**
- Pass `notifyUser: false` to `updateElectronApp({...})` so the banner
  is the single source of truth for the Restart prompt.
- Defer the actual `autoUpdater.quitAndInstall()` to `setImmediate()`
  inside the IPC handler so the renderer's pending Promise can resolve
  cleanly BEFORE the app tears down.
- Belt-and-braces: after 1.5 s, if the app is still running (Squirrel
  silently no-op'd anyway), force a `app.relaunch() + app.exit(0)` so
  the user always sees the restart they clicked for.

**Bug 3 — Signed out on every update.** This was the most damaging one.
The v0.1.38 OAuth boot-path safety code wrapped `safeStorage.
decryptString` in a 2-second timeout, and on timeout wiped the
`tokenEnc` blob — on the assumption that a timeout always meant
"Keychain ACL is broken." But after a Sparkle in-place update the new
binary's CDHash differs from the old one (same Developer ID, same
bundle ID, different signed binary hash), so the macOS Keychain ACL
`partition_id` check fails and SecurityAgent pops the "Allow" prompt
on the next decrypt. The user takes longer than 2 seconds to find and
click "Always Allow"; we wiped the blob; next read had nothing to
decrypt; user had to re-OAuth from scratch. Every. Single. Update.

**Fix in `src/main/oauth.ts`:**
- Raise the decrypt timeout from 2 s → 30 s, plenty of time for the
  user to interact with the SecurityAgent prompt.
- More important: on timeout, PRESERVE the blob. Surface signed-out
  for THIS launch (so the UI doesn't hang waiting on the prompt), but
  don't touch `tokenEnc`. Next launch — after the user has clicked
  "Always Allow" once and the Keychain trust is in place — decrypts
  cleanly and the user stays signed in across all future updates.
- Only an actual decrypt THROW (genuine "this ciphertext is junk" —
  bad base64, JSON parse error, missing accessToken) still triggers
  the wipe-and-force-re-auth path. That's the case where preserving
  the blob would just loop the failure every launch.

**Sign-out fix is structural, not a workaround.** The Developer ID
`T34G959ZG8` and bundle ID `com.ethansk.restream-chat-plus-plus` are
stable across all releases (verified via `codesign -dvvv` on the
installed bundle), so the SecurityAgent prompt only fires once per
fresh binary (i.e. once per update). After clicking "Always Allow",
the Keychain trust is in place for that binary's CDHash and decrypt
succeeds without prompting. The v0.1.52 change is to give the user
enough time to click Allow before we panic-wipe the blob.

**Test additions (vitest unit tests):**
- `update-flow-fixes.test.ts` (new) — pins the Install Update re-entry
  guard, the Restart deferred-quit-with-fallback behaviour, and the
  `notifyUser: false` config.
- `oauth-persistence.test.ts` (updated) — the v0.1.38 "wipe on timeout"
  test is replaced with the v0.1.52 "PRESERVE on timeout" assertion.
  New test simulates a full Sparkle-update cycle: first launch times
  out, second launch (token still on disk) decrypts successfully.

## v0.1.51 — Post-open "early close" one-shot retry + boot-path logging

Fix for Ethan voice 3709: "I updated Restream Chat++ to 0.1.50 and it's
still stuck on idle." The earlier v0.1.49 / v0.1.50 work covered ONLY
the **pre-`'open'`** handshake-failure path. Production logs on the
v0.1.50 build show a different failure mode that the prior fixes don't
catch: the WS **opens** successfully, frames flow for a fraction of a
second, then the server immediately fires `'close'`. The most common
trigger is Restream sending a WS-level `connection_replaced` when a
second client grabs the same session token (e.g. the prior app
instance still alive after a Sparkle update swap, an open
`chat.restream.io` tab, or a stale `Restream Chat` app). An immediate
server-side auth reject right after handshake produces the same shape.

Pre-v0.1.51 behaviour: `'open'` flips `hasEverConnectedThisSession=true`,
the subsequent close hits the v0.1.47 short-circuit (auto-reconnect
off + ever-connected = true), and we land on `'disconnected'` silently
— NO entry in `reconnect-events.jsonl`, no banner explaining why, just
a dead app. From the user's perspective, indistinguishable from "stuck
on idle".

**Fix — post-open "early close" one-shot retry.** If the WS closes
within `EARLY_CLOSE_WINDOW_MS` (30 seconds) of the `'open'` event, we
schedule exactly ONE retry via the unified-reconnect provider — same
shape as the v0.1.49 pre-open retry, just gated on a new flag
(`earlyCloseRetryUsedThisSession`) so the two budgets are independent.
After this one retry (regardless of outcome), or for any close
**outside** the 30s window, we fall through to the v0.1.47 default and
stay on `'disconnected'`. No 5s polling loop — the budget guard
prevents the v0.1.50 regression that hardened the pre-open path.

**The two budgets stack but don't collide.** A session that fails pre-
`'open'` AND then has a post-open early close gets at most TWO retries
total (one from each budget), then `'disconnected'`. New test:
`v0.1.51: initial-connect + early-close budgets are SEPARATE one-shots`.

**Boot-path logging in `main.ts`.** `resumeAuth()` now writes
structured entries to `main.log` at every decision point: which leg ran
(cached token / refresh / no-token), whether `chat.start()` was called,
the token's `expiresAtMs`/`msUntilExpiry`, and the final `chat.getState()`.
Pre-v0.1.51 the only thing in `main.log` was Squirrel update chatter —
there was no record of whether the WS layer even got invoked, which
made diagnosing this v0.1.50 case much harder than it should have been.

**New regression tests in `src/__tests__/ws-reconnect.test.ts`:**

- `v0.1.51: post-open early close (within 30s) gets ONE retry`
- `v0.1.51: post-open early close one-shot budget — second early close goes to disconnected`
- `v0.1.51: close AFTER the 30s window is treated as steady-state drop (no retry)`
- `v0.1.51: initial-connect + early-close budgets are SEPARATE one-shots`

Two existing tests were updated to advance fake timers past the 30s
window so they exercise the steady-state path explicitly (they were
relying on the pre-v0.1.51 "any post-open close goes straight to
disconnected" assumption that no longer holds).

## v0.1.50 — Codex-blocking fix to v0.1.49

Codex review of v0.1.49 caught two production-only paths that re-armed
the one-shot retry and could either spin into an infinite 5s polling
loop or swallow the retry entirely. Both are fixed before users update.

**Fix 1 — provider path no longer re-arms the initial-retry budget.**
The auto-retry in `scheduleInitialConnectRetry` calls the
`performFullReconnect` provider, which calls `chat.reconnect()` — and
`reconnect()` resets BOTH `hasEverConnectedThisSession` AND
`initialRetryUsedThisSession`. If the retry handshake also closed
before `'open'`, `handleDisconnect` re-entered with both flags reset
and fired ANOTHER 5s retry — infinite 5s polling, strictly worse than
the 60s loop Ethan disabled in v0.1.47. Unit tests missed it because
they exercised the no-provider fallback (bare `this.connect()`), but
production always goes through the provider path.

Fix: `reconnect({preserveInitialBudget?: boolean})` — the provider-
triggered path passes `true` and keeps the budget flags untouched. The
manual Reconnect button (default — flag omitted) still resets the
budget; a user click is an explicit "try again from scratch" gesture.

**Fix 2 — per-socket terminal-event guard.**
`handleDisconnect` calls `clearTimers()` first thing. The `ws` library
commonly emits BOTH `'error'` and `'close'` for the same socket on
DNS / TCP-RST / TLS-abort pre-handshake failures. The first event
armed the 5s retry timer; the second wiped it AND consumed the
one-shot budget (`initialRetryUsedThisSession=true`), leaving the
user on `disconnected` with no recovery — the exact case v0.1.49 was
meant to fix.

Fix: a `WeakSet<WebSocket>` tags sockets the first time
`handleDisconnect` runs for them. Subsequent terminal events from the
same socket are no-ops. The `WeakSet` doesn't leak — closed sockets
GC normally.

**New regression tests in `src/__tests__/ws-reconnect.test.ts`:**

- `provider-triggered retry with second pre-open failure does NOT loop`
- `ws emits both 'error' and 'close' for same socket — retry still fires`
- `double-fire after connected doesn't run handleDisconnect twice`

All three FAIL on the unpatched v0.1.49 code. Total tests: 393 → 396.

## v0.1.49 — one-shot initial-connect retry (fix "stuck on idle")

Fix for Ethan voice 3692: "Restream Chat++ is stuck on idle. I just
signed in. Can you investigate?". With v0.1.47's auto-reconnect fully
disabled, the very first WebSocket handshake after sign-in / app launch
had no recovery if it closed before reaching `connected` — a transient
network blip, an `api.restream.io` blip, a TLS hiccup, or even a
pre-emptive `close 1006` would land the user on `disconnected` (or, on
a brand-new launch, leave the renderer on its initial `idle`
placeholder) with no automatic recovery and no obvious cue beyond the
small toolbar Reconnect icon.

v0.1.49 adds a **one-shot 5-second retry** scoped narrowly to the
initial-connect path:

- Fires at most ONCE per `start()` / `reconnect()` session.
- Only fires if the WS has NEVER reached `connected` this session
  (`hasEverConnectedThisSession === false`). Once a successful connect
  lands, all future disconnects go straight to `disconnected` per
  v0.1.47's behaviour — no change to the post-connected path.
- After the retry, regardless of outcome, the v0.1.47 default takes
  over. We never loop, we never poll. The whole network-traffic
  rationale Ethan cited in voice 3630 is preserved.
- Runs through the unified `performFullReconnect()` provider so the
  retry handshake gets the same OAuth-refresh + `chat.reconnect()`
  pipeline as the manual button — covers the "token expired during the
  handshake gap" case.
- `setAutoReconnectEnabled(true)` (test-only opt-in) still restores the
  full v0.1.45 polling behaviour.

Regression tests in `src/__tests__/ws-reconnect.test.ts`:

- `initial-connect failure (no open before close) gets ONE 5s retry`
- `initial-connect retry fires AT MOST ONCE — second failure goes to disconnected`
- `once we reach connected, a subsequent disconnect goes straight to disconnected (no retry)`
- `manual reconnect() resets the one-shot budget for the new session`

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
