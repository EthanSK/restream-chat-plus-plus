// GitHub-Releases-backed update checker (v0.1.19).
//
// Why this exists alongside `update-electron-app`:
// ------------------------------------------------
// `update-electron-app` is wired through Electron's native autoUpdater
// (Squirrel.Mac on macOS, NSIS on Windows). Both refuse to apply an unsigned
// update. Restream Chat++ ships UNSIGNED today (Apple signing secrets aren't
// in CI yet) which means the Squirrel feed is effectively dead — the app
// polls the feed, the feed serves a payload, Squirrel.Mac downloads it,
// signature check fails, Squirrel discards it silently. Result: the user
// gets stranded on whatever version they first installed.
//
// This module hits GitHub's public Releases API directly. It only needs to
// answer two questions:
//   1. "Is there a newer release than the running version?"
//   2. "What's the release page URL?"
// Both are public-API queries — no auth required, no signing involved. When
// a newer version exists we broadcast an UPDATE_STATUS to the renderer which
// surfaces a "Download" banner.
//
// v0.1.32: the banner's Download button no longer opens the release page
// in the system browser. It fires `IPC.UPDATE_DOWNLOAD_START` in main →
// Squirrel `autoUpdater.checkForUpdates()` → the in-app pipeline takes
// over (progress bar → Restart to install). On builds where Squirrel
// can't run (unsigned / dev / Linux) the main-process handler pops a
// native info dialog with an explicit "Reveal Release Page" button —
// the user can still get to the release page, just not via a silent
// browser bounce from the primary banner click.
//
// Polling cadence:
//   - First check fires ~3s after the app is `ready` (so we don't compete
//     with the WS handshake / OAuth refresh for the user's bandwidth).
//   - After that, every 1 hour while the process is alive.
//   - Plus on-demand via the "Check for Updates Now…" menu item.
//
// All checks are short-circuited if `settings.update.autoCheck === false`,
// except the on-demand path which is always allowed.

import { app, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { IPC, UpdateInfo } from '../shared/types';
import { isNewerVersion } from '../shared/version';
import { rememberPendingDownloadVersion } from './updater';
// v0.1.69 (voice 4015) — structured error log for GH-Releases fetch
// failures (network blip, 4xx from GH API, schema regression). These
// previously landed in main.log only.
import { appendErrorLog, errorToString } from './structured-log';

const REPO = 'EthanSK/restream-chat-plus-plus';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const HOUR_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// v0.1.85 (voice 7280) — CHECK-RETRY RESILIENCE.
//
// The hourly poll fires `performGithubUpdateCheck()` once. If the GH API
// request transiently fails (Wi-Fi handoff, DNS hiccup, GH rate-limit blip,
// 5xx), pre-v0.1.85 the renderer got an `error` UpdateInfo and then nothing
// re-checked for a FULL HOUR. That meant a user could miss an available
// update for an hour after one transient blip — and since the in-app download
// is gated on the banner showing `available`, a flaky check directly feeds the
// "update never seems to show up / is flaky" symptom Ethan reported.
//
// Fix: the AUTOMATIC poll paths (`first check` + hourly tick) now use
// `checkWithQuickRetry()`, which re-attempts on an `error` result with a short
// bounded backoff (10s → 30s, 2 retries) before settling. The on-demand
// (forced) menu/button path is NOT wrapped — the user can just click again,
// and a fast manual loop shouldn't be slowed by our backoff waits.
// ---------------------------------------------------------------------------
const CHECK_RETRY_DELAYS_MS = [10_000, 30_000];

let intervalHandle: NodeJS.Timeout | undefined;
let firstCheckTimer: NodeJS.Timeout | undefined;
// Pending check-retry timer so a quit (`stopGithubUpdatePoller`) can cancel it.
let checkRetryTimer: NodeJS.Timeout | undefined;
let lastInfo: UpdateInfo | undefined;
let lastBroadcast: UpdateInfo | undefined;
let getAutoCheck: () => boolean = () => true;

/**
 * Push an UpdateInfo to every live BrowserWindow. We also cache the latest
 * payload so a renderer that mounts after a check has already completed can
 * pull-fetch via `UPDATE_STATUS_GET` and not miss the banner.
 *
 * To keep the renderer quiet, we ONLY broadcast if the payload meaningfully
 * differs from the previous one (kind / latestVersion / error). Otherwise
 * the hourly poll would re-render the empty `up-to-date` state every hour
 * for no reason.
 */
function broadcast(info: UpdateInfo): void {
  lastInfo = info;
  const changed =
    !lastBroadcast ||
    lastBroadcast.kind !== info.kind ||
    lastBroadcast.latestVersion !== info.latestVersion ||
    lastBroadcast.error !== info.error;
  if (!changed) {
    log.info('[updater-gh] skipping broadcast (unchanged):', info.kind);
    return;
  }
  lastBroadcast = info;
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(IPC.UPDATE_STATUS, info);
    } catch (err) {
      log.error('[updater-gh] broadcast failed', err);
    }
  }
}

/**
 * Perform one GH-Releases-API check. Always resolves an UpdateInfo (never
 * throws) so the caller doesn't have to wrap every invocation in try/catch.
 *
 * `force=true` bypasses the autoCheck setting — used by the on-demand menu
 * item / button which the user explicitly asked to fire.
 */
export async function performGithubUpdateCheck(force = false): Promise<UpdateInfo> {
  const currentVersion = app.getVersion();
  const now = Date.now();

  if (!force && !getAutoCheck()) {
    const disabled: UpdateInfo = {
      kind: 'disabled',
      currentVersion,
      checkedAt: now,
    };
    broadcast(disabled);
    return disabled;
  }

  // Broadcast `checking` so the renderer can show a spinner while the
  // network round-trip is in flight. We DON'T cache this in `lastInfo`
  // because it would overwrite the most recent terminal state (e.g.
  // `available`), making a fresh renderer mount lose the banner. v0.1.25.
  //
  // v0.1.35: track `checking` as the most recent broadcast in `lastBroadcast`
  // so the subsequent terminal payload (`up-to-date` / `available` / `error`)
  // ALWAYS differs from the cached "last sent" and is therefore broadcast.
  //
  // Pre-v0.1.35 bug: if two consecutive polls both resolved to `up-to-date`,
  // the second resolution was suppressed by the "skip unchanged" guard in
  // `broadcast()` — but the renderer had already seen `checking` from the
  // raw send below. Result: banner stuck on "Checking for updates…" forever.
  // Repro path: app boots → 3s poll → `up-to-date` (cached). User clicks
  // "Check for Updates" menu → raw `checking` push → fetch resolves to
  // `up-to-date` again → broadcast() compares `up-to-date === up-to-date` →
  // skips → renderer never gets the terminal state → spinner forever.
  //
  // Mutating `lastBroadcast` here means the post-fetch `broadcast()` call
  // sees `lastBroadcast.kind === 'checking'` and ALWAYS pushes the terminal
  // payload. We do NOT touch `lastInfo` — the on-mount pull-fetch
  // (`getLastUpdateInfo`) should still return the most recent TERMINAL
  // state, not the transient checking state.
  const checkingInfo: UpdateInfo = {
    kind: 'checking',
    currentVersion,
    checkedAt: now,
  };
  lastBroadcast = checkingInfo;
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(IPC.UPDATE_STATUS, checkingInfo);
    } catch (err) {
      log.error('[updater-gh] checking broadcast failed', err);
    }
  }

  try {
    log.info('[updater-gh] checking', RELEASES_URL);
    // AbortController gives us a hard timeout — `fetch()` itself has no
    // timeout option in Node/Electron's undici, so a stalled connection
    // would otherwise hang for the OS-default ~120s. 15s is plenty for the
    // GH API on a healthy network and a reasonable cap on a flaky one.
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(RELEASES_URL, {
        method: 'GET',
        headers: {
          // GH recommends a User-Agent header; required if running in an
          // environment without one (Electron's fetch sets a default but
          // being explicit avoids any surprise rate-limit treatment).
          'User-Agent': `restream-chat-plus-plus/${currentVersion}`,
          // Pin to the public v3 API explicitly so a future default change
          // doesn't break the parser.
          Accept: 'application/vnd.github+json',
        },
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      // 404 is the common case for a fresh repo with no published releases,
      // but in our case we have plenty so any non-2xx is genuinely a
      // problem worth surfacing.
      const errInfo: UpdateInfo = {
        kind: 'error',
        currentVersion,
        error: `GitHub API returned HTTP ${res.status}`,
        checkedAt: now,
      };
      log.warn('[updater-gh] non-2xx response', res.status);
      // v0.1.69 (voice 4015): every non-2xx GH response gets a structured
      // row so we can see if the hourly poll is flapping (rate-limit, GH
      // outage, network blip). Useful when correlating across multiple
      // users' logs in support.
      appendErrorLog({
        subsystem: 'github-update',
        phase: 'github-update.non-2xx',
        errorMessage: `GitHub API returned HTTP ${res.status}`,
        httpStatus: res.status,
        context: { url: RELEASES_URL },
      });
      broadcast(errInfo);
      return errInfo;
    }

    const json: unknown = await res.json();
    // The relevant fields on the latest-release response are tag_name and
    // html_url — see https://docs.github.com/en/rest/releases/releases#get-the-latest-release
    const tagName =
      json && typeof json === 'object' && 'tag_name' in json && typeof (json as Record<string, unknown>).tag_name === 'string'
        ? ((json as Record<string, unknown>).tag_name as string)
        : undefined;
    const htmlUrl =
      json && typeof json === 'object' && 'html_url' in json && typeof (json as Record<string, unknown>).html_url === 'string'
        ? ((json as Record<string, unknown>).html_url as string)
        : `https://github.com/${REPO}/releases`;

    if (!tagName) {
      const malformed: UpdateInfo = {
        kind: 'error',
        currentVersion,
        error: 'GitHub API response missing tag_name',
        checkedAt: now,
      };
      log.warn('[updater-gh] malformed GH payload');
      // v0.1.69 (voice 4015): GH schema regression is a rare-but-real
      // event (they change the API once a decade); structured row pins
      // the date so we know which day to look at GH's changelog if
      // every user's update banner breaks at once.
      appendErrorLog({
        subsystem: 'github-update',
        phase: 'github-update.missing-tag-name',
        errorMessage: 'GitHub API response missing tag_name',
      });
      broadcast(malformed);
      return malformed;
    }

    if (isNewerVersion(tagName, currentVersion)) {
      const available: UpdateInfo = {
        kind: 'available',
        currentVersion,
        latestVersion: tagName,
        releaseUrl: htmlUrl,
        checkedAt: now,
      };
      log.info('[updater-gh] update available', { tagName, currentVersion });
      // v0.1.61 — seed the Squirrel-side cache so subsequent
      // `download-progress` + `error` broadcasts can include the
      // human-readable version string. Squirrel itself doesn't know the
      // tag name until `update-downloaded` fires (which is the LAST
      // event), so without this the banner header would render
      // "Downloading update… 42%" with no version label.
      try {
        rememberPendingDownloadVersion(tagName);
      } catch (err) {
        log.warn('[updater-gh] rememberPendingDownloadVersion failed', err);
      }
      broadcast(available);
      return available;
    }

    const upToDate: UpdateInfo = {
      kind: 'up-to-date',
      currentVersion,
      checkedAt: now,
    };
    log.info('[updater-gh] up to date', { tagName, currentVersion });
    broadcast(upToDate);
    return upToDate;
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    log.error('[updater-gh] check failed', message);
    // v0.1.69 (voice 4015): network / abort / DNS fail. The structured
    // row contains the error message so post-mortem can see if a chronic
    // user is being blocked by a corp firewall, or a flaky home WiFi.
    appendErrorLog({
      subsystem: 'github-update',
      phase: 'github-update.fetch-threw',
      errorMessage: message,
    });
    const failed: UpdateInfo = {
      kind: 'error',
      currentVersion,
      error: message,
      checkedAt: now,
    };
    broadcast(failed);
    return failed;
  }
}

/**
 * v0.1.85 — run an AUTOMATIC update check that re-attempts on a transient
 * `error` result with a short bounded backoff. Resolves with the FINAL
 * UpdateInfo (the first non-error result, or the last error if the budget
 * is exhausted). Each attempt already broadcasts its own UpdateInfo via
 * `broadcast()`, so the renderer sees the transient error → checking →
 * recovered transitions live.
 *
 * Only the `error` kind triggers a retry — `available` / `up-to-date` /
 * `disabled` are terminal and returned immediately. `attempt` is 0-based:
 * attempt 0 is the initial try, attempts 1..N consume `CHECK_RETRY_DELAYS_MS`.
 *
 * The optional `delay` injection (defaults to a real `setTimeout` Promise)
 * lets the Vitest suite drive the backoff deterministically.
 */
export async function checkWithQuickRetry(
  delay: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => {
      checkRetryTimer = setTimeout(resolve, ms);
    }),
): Promise<UpdateInfo> {
  let last = await performGithubUpdateCheck();
  for (let attempt = 0; attempt < CHECK_RETRY_DELAYS_MS.length; attempt += 1) {
    // Only a transient failure is worth re-attempting. A `disabled` result
    // means the user turned auto-check off — respect that and stop.
    if (last.kind !== 'error') break;
    const wait = CHECK_RETRY_DELAYS_MS[attempt];
    log.warn(
      `[updater-gh] check failed (${last.error ?? 'unknown'}) — quick-retry ${attempt + 1}/${CHECK_RETRY_DELAYS_MS.length} in ${wait}ms`,
    );
    await delay(wait);
    last = await performGithubUpdateCheck();
  }
  return last;
}

/**
 * Start the GH update poller. Called once from `app.on('ready')`. Safe to
 * call repeatedly — duplicate calls are a no-op once the interval is armed.
 *
 * The provided `autoCheckGetter` is read at every check tick so toggling
 * the Settings switch takes effect on the next interval without needing a
 * restart.
 */
export function startGithubUpdatePoller(autoCheckGetter: () => boolean): void {
  getAutoCheck = autoCheckGetter;

  // In dev (when not packaged) we still run the GH check — unlike the
  // Squirrel path, GH polling has no signing requirement and the banner
  // gives us a way to dogfood the update flow locally. It just won't be
  // able to actually INSTALL anything; clicking Download opens the
  // releases page in the browser.

  if (intervalHandle) {
    log.info('[updater-gh] poller already running');
    return;
  }

  // Delay the first check ~3s so we don't compete with OAuth resume + WS
  // handshake during boot. Single-shot.
  // v0.1.85 — use the quick-retry wrapper so a transient blip at boot
  // (Wi-Fi not yet associated, DNS warming up) doesn't strand the user on
  // an error banner for a full hour until the next interval tick.
  firstCheckTimer = setTimeout(() => {
    void checkWithQuickRetry();
  }, 3_000);

  intervalHandle = setInterval(() => {
    void checkWithQuickRetry();
  }, HOUR_MS);
  log.info('[updater-gh] poller armed (1h interval)');
}

/**
 * Stop the GH update poller. Used for cleanup if we ever decide to disable
 * mid-session; not used today but kept for symmetry.
 */
export function stopGithubUpdatePoller(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
  if (firstCheckTimer) {
    clearTimeout(firstCheckTimer);
    firstCheckTimer = undefined;
  }
  // v0.1.85 — also cancel a pending quick-retry backoff so a quit mid-retry
  // doesn't leave a dangling timer.
  if (checkRetryTimer) {
    clearTimeout(checkRetryTimer);
    checkRetryTimer = undefined;
  }
}

/** Return the most recently broadcast UpdateInfo, or `undefined` if no check has yet completed. */
export function getLastUpdateInfo(): UpdateInfo | undefined {
  return lastInfo;
}
