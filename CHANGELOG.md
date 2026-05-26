# Changelog

## v0.1.71 — cold-start auth flicker fix (voice 4198, 2026-05-26)

Ethan voice 4198 (2026-05-26):
> The Restream Chat plus plus app, when I first opened it, it said I was
> signed out. But then it signed in, and there needs to be some loading.
> Yeah, I accidentally signed in while it's loading.

On cold start the renderer's `useState<AuthStatus>({ authenticated: false })`
defaulted to a synchronously-rendered "signed out" UI: the toolbar
showed the "Sign in to Restream" button before the main process had
finished its async `oauth.getTokenAsync()` decrypt (~1-2s on cold
start). During that window a click on Sign In kicked off a fresh
OAuth round-trip the user did NOT want.

v0.1.71 fixes this with a separate `AuthBootState` discriminator that
starts in `'checking'` and only transitions to `'signed_in'` /
`'signed_out'` once the renderer has observed a real AUTH_STATUS
from the main process (either via the initial `rcpp.authStatus()`
pull OR the deferred `onAuthStatus` push, whichever wins).

### What's new

- **Cold-start spinner overlay.** While `authBoot` is `'checking'` or
  `'checking-slow'`, a centered card with a spinner + "Checking
  sign-in…" message covers the full app surface (z-index above the
  toolbar). The toolbar's Sign In button is ALSO suppressed at the JSX
  layer as a defence-in-depth — overlay covers it visually, JSX gate
  blocks the click handler entirely.
- **Slow + fail tiers.** At 5s elapsed the spinner gains a "Still
  checking…" subtitle (so the user doesn't think the app is hung). At
  15s with still no AUTH_STATUS the overlay flips to a "Couldn't
  verify sign-in — try again" affordance with a retry button that
  re-runs `rcpp.authStatus()` and re-arms the state machine.
- **AuthBootState type.** Five-state discriminator
  (`'checking' | 'checking-slow' | 'signed_in' | 'signed_out' | 'verify_failed'`)
  plus pure reducers in `src/renderer/auth-bootstate.ts`. Single helper
  `applyAuthStatus()` in `App.tsx` is the only call site that mutates
  both `auth` + `authBoot` together so every AUTH_STATUS source (initial
  pull, push, sign-in result, sign-out result, retry) goes through one
  path.

### Tests

- `src/__tests__/auth-bootstate.test.ts` — 25 cases pinning every
  reducer transition (including the timer-race safety case where a
  late slow/fail timer fires after `applyAuthStatus` has already
  resolved). All 530 tests across the repo pass.

### Notes

- The v0.1.70 transient-refresh banner (mid-session refresh failure)
  is orthogonal and unchanged. v0.1.70 = "we WERE signed in, hit a
  blip, recovering"; v0.1.71 = "we don't know yet, please wait". The
  v0.1.71 spinner only renders during cold-start; once we've resolved
  once, the v0.1.70 banner takes over for mid-session blips.

## v0.1.70 — transient-refresh self-heal (sign-out diagnosis 2026-05-25)

Ethan reported being unexpectedly signed out today. Disk forensics in
`~/Library/Logs/Restream Chat++/reconnect-events.jsonl` showed a single
`failureReason:refresh-failed` row at `2026-05-24T19:14:39Z` — one
`fetch threw` in `oauth.refresh()` (almost certainly network sleep,
given the `471944ms` stale-inbound that preceded it). The refresh
token was STILL on disk and valid, but `performFullReconnect` saw
`refresh()` returned undefined and pushed
`AUTH_STATUS { authenticated: false }` to the renderer → renderer
flipped to the bare sign-in screen. The WS auto-retry gave up after
one attempt; nothing retried for 19 hours.

v0.1.70 fixes this by discriminating transient (5xx / `fetch threw`)
from fatal (4xx / invalid_grant) refresh failures and adding a
periodic refresh-retry watchdog with exponential backoff that
auto-recovers when the network comes back. A single transient blip
never permanently signs the user out again.

### What's new

- **`OAuthCoordinator.getLastRefreshFailure()` — classify the last
  refresh outcome.** Returns `'none' | 'fatal' | 'transient'`. The
  4xx wipe branch sets `'fatal'`, the 5xx + fetch-threw branches set
  `'transient'`, and the success path resets to `'none'`. Pre-v0.1.70
  callers couldn't tell these apart (everything was `undefined`).
- **Transient-refresh-retry watchdog (`src/main/transient-refresh-retry.ts`).**
  Single-instance state machine with exponential 2m → 4m → 8m → 16m →
  30m schedule (capped). Arm on a transient failure; cancel on
  AUTH_LOGOUT / successful chat.reconnect / before-quit. Idempotent —
  concurrent arm() calls coalesce onto one outstanding timer (so the
  60s WS auto-retry doesn't stack parallel ladders).
- **`AuthStatus` gains `tokenLikelyValid` + `reconnectingDueToTransient`.**
  Set when the main process is in a recoverable transient-failure
  state. Renderer keys off these to render a "Reconnecting — your
  session may resume automatically. [Retry now]" banner instead of the
  bare sign-in CTA.
- **Boot-time recovery via startup-auth-resume.** If the very first
  `oauth.refresh()` at launch fails transiently (common after
  wake-from-sleep mid-VPN-handshake), the watchdog arms on first
  launch so the user gets the self-healing experience even on a fresh
  process.
- **Structured logging.** New `app-errors.jsonl` phases:
  `oauth.transient-refresh-keep-trying` (initial arming),
  `oauth.transient-refresh-recovery-tick` (per-tick), and
  `oauth.transient-refresh-recovered` / `oauth.transient-refresh-give-up`
  (terminal).

### Tests

- `src/__tests__/oauth-refresh-failure.test.ts` — adds 5 cases pinning
  `getLastRefreshFailure()` classification across all four outcomes
  plus the transient→success reset.
- `src/__tests__/transient-refresh-retry.test.ts` — new file pinning
  the controller state machine: arms at 2m, doubles, caps at 30m,
  recovery success path, fatal give-up path, coalescing of concurrent
  arms, cancel teardown, defensive refresh-throws → re-arm.

## v0.1.69 — exhaustive error-path logging + 7-day jsonl retention (voice 4015)

Ethan voice 4015 (2026-05-24, ~17:06 BST):
> The easiest solution is you add proper logging, then you can investigate
> exactly what the problem was. It should have all the information needed to
> debug and diagnose every type of error. And feel free to have a buffer so
> it gets rid of the old ones after, like, a week or something.

v0.1.69 sweeps every error-producing call site in the main process and
makes sure each one lands a structured row on disk. Pre-v0.1.69 entire
categories of failure (OAuth refresh, Keychain ACL drift, WebSocket frame
parse errors, Squirrel update errors, IPC handler crashes, MCP startup,
GH update poll) only landed in volatile `console.error` — they vanished
the moment the app quit, which made remote post-mortem essentially
impossible. Now every catch site mirrors into the shared `app-errors.jsonl`
file alongside its existing console output, and a 7-day prune step keeps
the logs dir under budget.

### What's new

- **`app-errors.jsonl` — single grep-able error log across every subsystem.**
  Lives at `~/Library/Logs/Restream Chat Plus Plus/app-errors.jsonl` on
  macOS. Every row is `{ ts, subsystem, phase, errorMessage, httpStatus?,
  context? }`. Subsystem identifiers: `oauth`, `ws`, `chat-send`,
  `chat-send-queue`, `main`, `updater`, `github-update`, `mcp`,
  `credentials`, `log-prune`.
- **7-day jsonl retention.** A prune step runs ~5s after window-shown +
  every 24 h thereafter. Walks every `*.jsonl` file under the app logs
  dir; drops lines whose `ts` is older than 7 days; atomic rewrite via
  `<file>.tmp` + rename so a mid-prune crash can't leave a truncated
  file. Files smaller than 100 KiB are skipped (no IO on tiny logs).
  Pruner's own runs / failures land back in `app-errors.jsonl` under
  the `log-prune` subsystem so the rotation itself is auditable.
- **Catch-all `unhandledRejection` + `uncaughtException` listeners.** Any
  async glitch or sync throw outside an IPC handler now lands as
  `main.unhandled-rejection` / `main.uncaught-exception` rows instead of
  vanishing into Node's default warning stream.
- **New `src/main/structured-log.ts` module** with `appendErrorLog`,
  `appendJsonl`, `errorToString`, `pruneJsonlLogs`, `resolveLogPath`
  helpers. All fail-soft — logging must never break the parent flow.

### Subsystem audit — error paths newly covered

- **`oauth.ts`** — `deferred-decrypt-threw`, `safe-storage-encrypt-failed`,
  `safe-storage-decrypt-failed`, `safe-storage-decrypt-timeout`,
  `decrypt-unparseable`, `wipe-token-enc-failed`, `refresh-fatal` (4xx
  invalid_grant → wipe), `refresh-transient` (5xx → keep), `refresh-fetch-threw`,
  `exchange-code-failed`, `exchange-code-no-access-token`. The
  refresh-fatal row is the single most important OAuth diagnostic — it
  pins WHY a previously-signed-in user is suddenly looking at the sign-in
  screen.
- **`ws-client.ts`** — `connect-no-token`, `frame-parse-error`,
  `abnormal-close` (codes !== 1000/1001), `socket-error`, `stale-inbound`
  (heartbeat timeout). Existing `raw-frames.jsonl` rows are preserved
  alongside.
- **`chat-send.ts`** — `cookie-read-failed`. The existing chat-send.jsonl
  `preflight` / `send` / `send-failed-final` rows already covered the
  hot path.
- **`chat-send-queue.ts`** — `run-send-threw`, `emit-pending-failed`,
  `emit-sent-failed` (new — pre-v0.1.69 only the `failed` IPC emit was
  logged), `emit-failed-failed`. Mirrors continue into chat-send.jsonl's
  `status-emit-failed` row for backward compat.
- **`updater.ts`** — `squirrel-error-event` (with category tag),
  `check-for-updates-threw`, `quit-and-install-threw`, `configure-failed`.
- **`github-update-check.ts`** — `non-2xx`, `missing-tag-name`,
  `fetch-threw`.
- **`main.ts`** — `post-auth-cookie-not-ok`, `post-auth-cookie-threw`,
  `send-chat-text-handler-threw`, `chat-send-enqueue-handler-failed`,
  `chat-send-log-event-handler-failed`, `unhandled-rejection`,
  `uncaught-exception`.
- **`startup-auth-resume.ts`** — `startup-auth-resume-threw`,
  `startup-cookie-not-ok`, `startup-cookie-threw`.
- **`credentials.ts`** — `keychain-read-failed`, `keychain-account-read-failed`.
  Keychain failures were previously caught with bare `catch {} return
  undefined`, so the upstream "Missing Restream credentials" error had
  no signal as to why.

### Internal changes

- `src/main/structured-log.ts` — new module (~280 lines) with
  fail-soft jsonl appender + 7-day pruner.
- All affected files import `{ appendErrorLog, errorToString }` and emit
  rows alongside their existing `console.error` / `electronLog.error` /
  `log.warn` calls — backward-compatible (no existing log paths removed).
- `main.ts` wires the prune timer (`setTimeout(5s)` initial + `setInterval(24h)`),
  clears the interval on `before-quit` so Node can exit cleanly,
  installs `process.on('unhandledRejection')` and `process.on('uncaughtException')`.

### Tests

- No existing tests should regress — every new appendErrorLog call is
  additive alongside the existing console paths.
- The structured-log module is VITEST-aware: `tryGetLogsDir()` returns
  undefined under Vitest so every appender is a silent no-op. This
  matches the existing `tryGetElectronApp()` pattern in `ws-client.ts`.

### Not in this release

- No build / sign / notarize from MBP. Mini-CC will pick this up via
  the release pipeline.
- Codex review skipped per `feedback_codex_disabled.md` standing rule.

## v0.1.68 — chat-send.jsonl forensics + partial-success semantics (voice 4013)

Ethan voice 4013 (2026-05-24) was explicit about two things: (1) keep
ignoring Restream's downstream platform-fan-out failures (Twitter
`internal_error`, Discord missing perms, etc.) because they're not RC++'s
problem to surface — Restream's own dashboard already does that — and
(2) any future ⚠ icon on an outgoing message must be diagnosable from
disk logs alone, without needing the renderer DevTools open. v0.1.68
hardens the first contract with an explanatory code comment and beefs
up `chat-send.jsonl` with four new row types so the second contract is
actually possible.

### What's new

- **Optimistic-send timeout 15s → 30s.** The renderer-side stuck-send
  guard now waits 30s before flagging a placeholder as failed. The old
  15s value was tight enough that genuinely-slow-but-fine sends (cold
  TLS resume after sign-in, slow Restream backend, REST hydration on a
  flaky connection) could trip a false ⚠. 30s gives the whole pipeline
  (preflight + REST hydration + attempt #1 + retry + Restream backend +
  WS echo round-trip) enough headroom to complete on a sluggish link.
- **Richer `chat-send.jsonl` logging on every ⚠ path.** Four new row
  shapes land in the same file as the existing per-POST + preflight rows:
  - `phase: "send-failed-final"` — written at the catch-all
    `send-failed` exit of `sendChatText`. Captures `clientReplyUuid`,
    `elapsedMs` (wall-clock end to end), `retryAttempted`,
    `lastHttpStatus`, `lastErrorMessage`. One greppable row per fully-
    failed send.
  - `phase: "status-emit-failed"` — written by `chat-send-queue.ts`
    when the IPC `emitStatus` callback throws while pushing a `failed`
    status to the renderer. Pre-v0.1.68 these swallowed into
    `console.warn`; now they reach disk so we can correlate against a
    stuck placeholder.
  - `phase: "optimistic-timeout"` — written by the renderer-side guard
    when the 30s timer fires. Carries `clientReplyUuid`, `elapsedMs`,
    and a best-effort `queueState`. Relayed over a new
    `CHAT_SEND_LOG_EVENT` IPC because the renderer can't write files
    directly.
  - `phase: "ws-echo-received"` — written on every accepted
    `reply_created` frame. Lets log forensics correlate
    `optimistic-timeout` rows against eventual late-arriving echoes —
    the smoking gun for "send went through fine, just slowly enough
    that the UI flagged it" vs "send genuinely never arrived".
- **Explanatory comment on the 2xx success path** in `chat-send.ts`
  documenting why a `{ failures: [...] }` body inside a 2xx response is
  still treated as success. No behavior change — just future-proofing
  against someone reading the diff and "fixing" it.

### Internal changes

- `src/main/chat-send.ts` — extended `ChatSendLogRecord` discriminated
  union with the four new row types; added `startedAt` wall-clock anchor
  and `emitFinalFailure` helper; both `send-failed` returns now emit a
  `send-failed-final` row before handing failure back to the queue.
- `src/main/chat-send-queue.ts` — new `logChatSend` option threaded
  through from main.ts; emit-failure branch now also writes a
  `status-emit-failed` row alongside the existing console.warn.
- `src/renderer/optimistic-send-timeout.ts` — bumped constant
  15_000 → 30_000; added `logOptimisticSendTimeout()` that relays a row
  via `window.rcpp.emitChatSendLogEvent`.
- `src/main/normalize.ts` — added optional `NormalizeLogSink` param to
  the pure function; existing callers unchanged. Fires
  `onWsEchoReceived` once per accepted `reply_created` frame.
- `src/main/ws-client.ts` — added `setNormalizeLogSink()` setter; the
  WS message handler threads it into `normalizeRestreamEventDetailed`.
- `src/main/main.ts` — wires `appendChatSendLog` into the queue's
  `logChatSend` slot and the ChatClient's `setNormalizeLogSink`; adds
  a `CHAT_SEND_LOG_EVENT` IPC handler that relays renderer-side rows
  into the same file with phase + payload validation.
- `src/preload.ts` — exposes `rcpp.emitChatSendLogEvent` so the
  renderer can ship structured rows over IPC.
- `src/shared/types.ts` — registers the new `CHAT_SEND_LOG_EVENT` IPC
  channel.

### Tests

- `src/__tests__/optimistic-send-timeout.test.ts` — updated description
  string from "15 seconds" → "30 seconds" to match the bumped constant.
  No assertion changes needed (tests reference `OPTIMISTIC_SEND_TIMEOUT_MS`
  by name, not the literal value).
- Full vitest suite green (475 passing).

### Not in this release

- No build / sign / notarize from MBP. Mini-CC will pick this up via
  the release pipeline when the bridge restores.
- Codex review skipped per `feedback_codex_disabled.md` standing rule.

## v0.1.67 — revert v0.1.66 `keychain-access-groups` (launch-failed in production)

Ethan voice 3995 follow-up #2 (2026-05-24): v0.1.66 shipped the
Codex-suggested `app.configureWebAuthn({ touchID })` + paired
`keychain-access-groups` entitlement, but installed-and-launched on
Mini it died with:

```
launchd job spawn failed (NSPOSIXErrorDomain 162)
taskgated-helper: Disallowing com.ethansk.restream-chat-plus-plus
  because no eligible provisioning profiles found
```

On modern macOS, declaring `keychain-access-groups` in a Developer ID
build REQUIRES bundling a Developer ID provisioning profile at
`Contents/embedded.provisionprofile`. Without one, `taskgated-helper`
refuses the launch outright — the app dies before any JS runs.

### What was reverted

- `build/entitlements.mac.plist`: removed the `keychain-access-groups`
  array.
- `src/main/main.ts`: removed the `app.configureWebAuthn({ touchID })`
  call.

### What stayed (still valuable independent of platform passkeys)

- `src/main/oauth.ts`: the v0.1.65 UA strip + v0.1.66 permission-handler
  scope fix + `loadURL(url, { userAgent })` scoping. These are correct
  regardless of whether the macOS passkey sheet ever appears, because
  Google may still surface security-key / cross-device-passkey flows
  via the same WebAuthn API.

### Next step for full platform-passkey support

Provisioning-profile work needs to happen out-of-band:

1. Apple Developer Portal: register a keychain-access-group for team
   `T34G959ZG8` covering bundle `com.ethansk.restream-chat-plus-plus`.
2. Generate + download a Developer ID Application provisioning profile
   that includes that group.
3. Bundle it as `Contents/embedded.provisionprofile` during electron-
   forge packaging (via `packagerConfig.osxSign.optionsForFile` or a
   custom `afterCopy` hook).
4. Re-add the entitlement + the `configureWebAuthn` call.

Tracked as a TODO; not blocking the v0.1.65 UA / permission-handler
fix from shipping. Sign-in via password / 2FA / security key still
works in v0.1.67.

## v0.1.66 — Google passkey sign-in actually surfaces the macOS passkey sheet

Ethan voice 3995 follow-up (2026-05-24): Codex xhigh review on v0.1.65
caught that the previous fix was incomplete — Google's WebAuthn ceremony
would still abort silently because Electron's macOS platform
authenticator was never enabled, and the permission allow-list leaked to
the chat-send partition.

### Codex-flagged fixes (CONCERNS, all critical)

1. **`app.configureWebAuthn({ touchID })` on `app.ready`** —
   Without this call, Electron returns `false` from
   `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`,
   so Google's WebAuthn JS skips the platform-authenticator path
   entirely and the macOS passkey sheet never appears. Added in
   `src/main/main.ts` early in `app.on('ready')`, guarded on
   `process.platform === 'darwin'`. Paired with a new
   `keychain-access-groups` entry in `build/entitlements.mac.plist`
   (`T34G959ZG8.com.ethansk.restream-chat-plus-plus.webauthn`) so the
   signed app can actually read/write WebAuthn metadata in the
   keychain.

2. **Permission-handler scope leak** — `persist:restream-oauth` is
   reused by `src/main/chat-send.ts`'s hidden cookie-provisioner +
   interactive recovery windows. Electron returns the same `Session`
   object for that partition string within a process, so the v0.1.65
   handler auto-approved passkey requests for chat-send windows too.
   Fixed by capturing the OAuth window's `webContents.id` at install
   time and gating approval on `wc.id === oauthWebContentsId` inside
   the handler closure. Everything else defaults to deny.

3. **UA scoping** — switched from `setUserAgent()` (mutates the shared
   Session) to `loadURL(url, { userAgent })` (scoped to this single
   load). The `restream-chat-plus-plus/<ver>` token isn't actually in
   the default Electron 42 UA per Codex's runtime probe, but the regex
   keeps the alternation as defence-in-depth.

### Notes

- Passkey credentials are device-bound (Secure Enclave) and not synced
  via iCloud Keychain. They live in the keychain access group named
  above; changing team ID or bundle ID will invalidate any existing
  passkey.
- The `promptReason` shown in the Touch ID sheet is
  `"sign in to <rpId> with your passkey"` where `<rpId>` is filled
  in by macOS (`google.com` for the Google sign-in flow).

## v0.1.65 — Google passkey sign-in unblocked (UA + permission handler)

Ethan voice 3995 (2026-05-24): signing in to Google via Restream OAuth
detects the WebAuthn ceremony but the macOS passkey sheet never appears.

### Root causes (both fixed; v0.1.66 added a third)

1. Google sniffs the UA and refuses to start a WebAuthn ceremony when
   it sees `Electron/<ver>` — their allow-list excludes embedded
   runtimes. Fixed by stripping the Electron product token from the
   OAuth BrowserWindow's UA before the first navigation.

2. Electron's default permission handler denies unknown permissions, so
   even if Google had started the ceremony, `publickey-credentials-get`
   and `publickey-credentials-create` were silently rejected. Fixed by
   installing `setPermissionRequestHandler` on the OAuth window's
   session that allow-lists only those two permissions.

### Followed up by v0.1.66

This release was shipped pending Codex xhigh review per voice 3995
("Ask Codex as well"). Codex flagged 3 CONCERNS — see the v0.1.66
entry above. The third root cause (missing `app.configureWebAuthn`)
was identified there. v0.1.65 alone would have left the passkey sheet
still not appearing in production; v0.1.66 is the actual shipping fix.

## v0.1.64 — MCP-driven update orchestration + download-state diagnostics

Ethan voice 3869 (2026-05-23): "There should be MCP to update it. You
should be able to update it over MCP properly and see it through."

### What's new

Four new MCP tools let an agent drive the auto-update flow end-to-end
without touching the UI:

- `update_check_now` — force a GH-Releases poll; returns the resulting
  UpdateInfo so the agent knows if a newer version exists.
- `update_download_status` — coarse download-state machine
  (`idle` / `checking` / `downloading` / `ready-to-install` / `error`)
  plus pending version, elapsed time, last error message, and last error
  category (`signature-mismatch` / `network` / `staging` / `unknown`).
- `update_install_now` — programmatic equivalent of clicking the
  renderer's "Restart to install" button. Refuses unless a bundle is
  staged.
- `update_logs_tail` — return the last N lines of `main.log` filtered to
  updater-relevant events. Lets an agent diagnose a stuck download
  without leaving the MCP surface.

### Phase 1 diagnosis (why v0.1.62 → v0.1.63 felt stuck)

The download actually succeeded at 17:08:56 — `[updater] update
downloaded, ready to install { releaseName: 'Restream Chat++ v0.1.63' }`
fired and the renderer was sent `kind: 'ready-to-install'`. But:

- The MCP `get_status` tool hardcoded `latestUpdateInfo: null`, so any
  agent querying state from outside the UI couldn't see that the bundle
  was staged. Fixed in v0.1.64 — the bridge now reads
  `getLastUpdateInfo()` from the GH poller.
- The hourly poll at 18:08 then re-kicked Squirrel which fired
  `update-not-available` (no newer release exists), causing internal
  state to ping-pong and giving the impression "the download was reset"
  even though the staged bundle was still on disk.

### Internal changes

- `src/main/updater.ts` — new `getDownloadState()` accessor + persisted
  `lastErrorMessage` / `lastErrorCategory` cleared on
  `checking-for-update` and `update-downloaded`, set on `error` and
  `triggerSquirrelDownload` synchronous throws.
- `src/main/mcp-server.ts` — bridge wires `latestUpdateInfo` (was `null`),
  `getUpdateDownloadState`, `triggerInstallNow`, `getLastUpdateInfo` into
  the `LiveSettingsBridge`.
- `src/mcp/tools.ts` — four new tools registered after the legacy
  `check_for_updates_now` (kept for backwards compatibility).

### Tests

- New `src/__tests__/mcp-update-tools.test.ts` — covers all four tools
  via the in-process bridge: idle state, downloading state, ready state,
  error state, install-when-not-staged refusal, log-tail filtering.

## v0.1.63 — startup cookie repair + stuck-send guard

Fixes the "send is broken after auto-update" bug that v0.1.62 only partly addressed.

### The bug

v0.1.62 added cookie-session repair after fresh sign-in, but users who updated in-app
(token preserved) never hit the sign-in path — so their chat-session cookies stayed
wiped. Every send silently bailed at the preflight check and the message sat forever
with a sending spinner.

### The fix

- Cookie repair now also fires during startup whenever a stored token is restored,
  not only on fresh sign-in. Both paths are covered.
- Added a 15-second timeout on optimistic-send placeholders. If neither the echo nor
  an explicit failure arrives in that window, the message flips to a red warning with
  a clear tooltip — no more perpetually-sending UI.
- Silent-fail audit: every send-pipeline failure now reaches the renderer.
- Toast/banner now warns "Restream chat session expired. Please sign out and sign in again."
  on cookie-bail, instead of a silent red icon.

### Silent-fail audit

- `resumeAuth()` was the missed startup path: stored-token resume and refresh-token
  resume both started chat without hydrating chat.restream.io cookies. Both now repair
  cookies after `chat.start()`.
- `chat-send.ts` preflight bails (`empty-text`, `no-active-connections`,
  `no-session-cookies` before cold-start, and `no-session-cookies` after the headless
  provisioner still fails) all write `phase: "preflight"` rows to `chat-send.jsonl`.
- `chat-send-queue.ts` already emitted `failed` for every `{ ok: false }` result and
  for thrown sends; v0.1.63 keeps that contract and adds regression coverage for the
  `no-session-cookies` preflight case.
- `App.tsx` now has a renderer-side timeout for any future silent-bail path, including
  swallowed fire-and-forget IPC failures where no queue status arrives.

### New tests

- Startup cookie repair fires when token is restored from disk.
- Optimistic placeholder times out and transitions to failed after 15s.
- Preflight bails are logged to chat-send.jsonl and surfaced to the renderer.

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
