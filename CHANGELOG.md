# Changelog

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
