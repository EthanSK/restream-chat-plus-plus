# Changelog

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
