// Auto-update wiring for Restream Chat++.
//
// Uses the `update-electron-app` wrapper, which polls
// `https://update.electronjs.org/<owner>/<repo>/<platform>-<arch>/<version>`
// (Electron's free public service for open-source apps) and surfaces a
// native restart-to-update dialog when a new release ships.
//
// Notes:
// - The service requires the GitHub repo to be PUBLIC. Ours is.
// - Auto-update only works when the app is signed + notarized on macOS
//   (Squirrel.Mac refuses unsigned updates). The CI release job handles
//   that; local `npm run make` produces unsigned builds that simply skip
//   auto-update (the `update-electron-app` helper bails early when the
//   app is in dev or not packaged).
// - `update-electron-app` swallows errors from update.electronjs.org so
//   they don't disrupt the user; we surface them through electron-log.

import { app, autoUpdater, BrowserWindow, dialog, shell } from 'electron';
import log from 'electron-log/main';
import { updateElectronApp, UpdateSourceType } from 'update-electron-app';
import { IPC, UpdateInfo } from '../shared/types';
import { performGithubUpdateCheck } from './github-update-check';
// v0.1.69 (voice 4015) — structured error log. The updater already writes
// to electron-log's main.log via `log.error/warn`, but main.log is plain
// text and isn't grep-friendly across subsystems. Mirror the operational
// failure paths (Squirrel error event, signature mismatch, sync throw
// from checkForUpdates, quitAndInstall failures) into app-errors.jsonl
// so a single structured-log walk covers updater + oauth + WS + send.
import { appendErrorLog, errorToString } from './structured-log';

const REPO = 'EthanSK/restream-chat-plus-plus';

let configured = false;
// True once `updateElectronApp({...})` has run, i.e. `autoUpdater.setFeedURL`
// has been called. We must not invoke `autoUpdater.checkForUpdates()` before
// this — the native autoUpdater throws synchronously without a feed URL,
// which in turn surfaces the macOS "this command is disabled and cannot be
// executed" alert when the throw happens inside a menu click handler.
let feedURLReady = false;
// Re-entrancy guard: stop the user spam-clicking the menu item while a
// check is already mid-flight (each click adds a `once` listener; without
// this guard multiple "you're on the latest version" dialogs would stack).
let checkInFlight = false;
// True after Squirrel emits `update-downloaded` — guards `quitAndInstall()`
// so the renderer's Restart button can't trigger a sync throw if it
// somehow fires before the download settled. v0.1.25.
let updateDownloaded = false;
// True while Squirrel's `autoUpdater` is in the "checking-for-update" or
// "update-available; downloading" state. Calling `checkForUpdates()` again
// during this window throws "The command is disabled and cannot be
// executed" on macOS — Squirrel's state machine refuses re-entry while a
// session is active. v0.1.52: tracked so the renderer "Install Update"
// button can short-circuit instead of bouncing the error back to the UI.
let downloadInFlight = false;
// v0.1.61 — epoch ms of when the current download session armed. Forwarded
// to the renderer in every `kind: 'downloading'` payload so the banner can
// render elapsed time + "this download has been running for >2 min without
// reported progress" warnings. Reset to undefined on terminal events
// (`update-downloaded`, `error`).
let downloadStartedAt: number | undefined;
// v0.1.61 — most recent `latestVersion` resolved from GH Releases. The
// Squirrel-side `download-progress` event doesn't carry the new version
// string, so we cache it from the most recent `available` UpdateInfo
// broadcast and include it on every `downloading` payload so the banner
// can show "Downloading Restream Chat++ v0.1.61… 42%" instead of an
// anonymous percentage.
let pendingDownloadVersion: string | undefined;

/**
 * Push an UpdateInfo payload to every live BrowserWindow via the existing
 * `IPC.UPDATE_STATUS` channel — shared with the GH-Releases poller so the
 * renderer's `onUpdateStatus` subscription handles both signal sources
 * uniformly. We deliberately do NOT route through `github-update-check`'s
 * internal `broadcast()` because that helper is gated on a meaningful
 * payload diff (kind/latestVersion/error) — Squirrel emits dozens of
 * `download-progress` events with the same kind, and they all need to
 * reach the renderer for the percentage to animate. v0.1.25.
 */
function broadcastSquirrelStatus(info: UpdateInfo): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(IPC.UPDATE_STATUS, info);
    } catch (err) {
      log.error('[updater] broadcast failed', err);
    }
  }
}

/**
 * Subscribe to Squirrel's autoUpdater events and forward each into the
 * renderer's `UpdateBanner` via `IPC.UPDATE_STATUS` so the user gets live
 * feedback while a background download is in flight. v0.1.25.
 *
 * Events of interest:
 *   - `download-progress` (newer Electron + Squirrel-mac builds) — fires
 *     with `{ percent, bytesPerSecond, total, transferred }`. We forward
 *     `percent` only; the banner's progress bar doesn't need the rest.
 *     NOTE: not every Squirrel.Mac build emits this event; on older
 *     builds the user sees an indeterminate "Downloading…" bar instead.
 *   - `update-downloaded` — fires once the new bundle is staged + ready
 *     to apply. Renderer flips to the `ready-to-install` state.
 *
 * `update-electron-app`'s `notifyUser: true` ALSO listens to
 * `update-downloaded` and shows its own native restart-to-update dialog.
 * That's fine: both UI paths coexist — the user can click either the
 * banner's Restart button or the dialog's button; both call
 * `quitAndInstall()` in the end.
 */
/**
 * v0.1.61 — categorise the raw Squirrel/ShipIt error message so the
 * renderer can pick the right user-facing wording + recovery action.
 *
 * The most-common silent-failure path on Ethan's MBP is the
 * ad-hoc-signed → Developer-ID-signed transition (the user is running
 * an ad-hoc build because Mini hadn't released signed builds yet; the
 * staged Developer-ID bundle fails Squirrel's `SecCodeCheckValidity`
 * against the running app's designated requirement, which is what
 * surfaces as "Code signature at URL ... did not pass validation: code
 * failed to satisfy specified code requirement(s)"). Without
 * categorisation the renderer would show a raw codesign-API string;
 * with categorisation we show "This update needs a manual reinstall"
 * + a button to open the GitHub releases page.
 */
export function categoriseUpdaterError(
  raw: unknown,
): 'signature-mismatch' | 'network' | 'staging' | 'unknown' {
  const msg =
    typeof raw === 'string'
      ? raw
      : typeof (raw as Error | undefined)?.message === 'string'
        ? (raw as Error).message
        : String(raw ?? '');
  const lc = msg.toLowerCase();
  if (
    lc.includes('code signature') ||
    lc.includes('code requirement') ||
    lc.includes('codesign') ||
    lc.includes('team identifier') ||
    lc.includes('not pass validation') ||
    lc.includes('not signed') ||
    lc.includes('signature is missing')
  ) {
    return 'signature-mismatch';
  }
  if (
    lc.includes('shipit') ||
    lc.includes('install failed') ||
    lc.includes('no such file') ||
    lc.includes('permission') ||
    lc.includes('staging') ||
    lc.includes('eperm') ||
    lc.includes('enoent')
  ) {
    return 'staging';
  }
  if (
    lc.includes('connect') ||
    lc.includes('network') ||
    lc.includes('timeout') ||
    lc.includes('etimedout') ||
    lc.includes('econnreset') ||
    lc.includes('econnrefused') ||
    lc.includes('enotfound') ||
    lc.includes('socket') ||
    lc.includes('tls') ||
    lc.includes('certificate') ||
    lc.includes('http') ||
    lc.includes('dns')
  ) {
    return 'network';
  }
  return 'unknown';
}

function attachSquirrelProgressForwarders(): void {
  // `download-progress` isn't in Electron's `autoUpdater` d.ts (Squirrel
  // emits it internally). Cast through EventEmitter so we can subscribe
  // without TS complaining about the unknown event name. Runtime contract
  // from Squirrel: the callback receives a single
  // `{ percent, bytesPerSecond?, total?, transferred? }` object. v0.1.61
  // forwards `bytesPerSecond` / `total` / `transferred` too so the banner
  // can show concrete bytes + KB/s feedback rather than a bare percent
  // that may stay at 0 for tens of seconds.
  (autoUpdater as unknown as NodeJS.EventEmitter).on(
    'download-progress',
    (progress?: {
      percent?: number;
      bytesPerSecond?: number;
      total?: number;
      transferred?: number;
    }) => {
      try {
        const raw = progress?.percent;
        const percent =
          typeof raw === 'number' && Number.isFinite(raw)
            ? Math.max(0, Math.min(100, raw))
            : undefined;
        const bps =
          typeof progress?.bytesPerSecond === 'number' &&
          Number.isFinite(progress.bytesPerSecond) &&
          progress.bytesPerSecond >= 0
            ? progress.bytesPerSecond
            : undefined;
        const total =
          typeof progress?.total === 'number' &&
          Number.isFinite(progress.total) &&
          progress.total >= 0
            ? progress.total
            : undefined;
        const transferred =
          typeof progress?.transferred === 'number' &&
          Number.isFinite(progress.transferred) &&
          progress.transferred >= 0
            ? progress.transferred
            : undefined;
        broadcastSquirrelStatus({
          kind: 'downloading',
          currentVersion: app.getVersion(),
          latestVersion: pendingDownloadVersion,
          downloadPercent: percent,
          downloadBytesPerSecond: bps,
          downloadBytesTotal: total,
          downloadBytesTransferred: transferred,
          downloadStartedAt,
          checkedAt: Date.now(),
        });
      } catch (err) {
        log.error('[updater] download-progress forward failed', err);
      }
    },
  );

  // v0.1.52: track Squirrel session state so triggerSquirrelDownload() can
  // short-circuit when re-clicking the Install Update banner. Squirrel
  // emits these strings via the `checking-for-update` and `update-available`
  // events; once we see them we know calling checkForUpdates() again would
  // throw "The command is disabled and cannot be executed".
  autoUpdater.on('checking-for-update', () => {
    downloadInFlight = true;
    // v0.1.64 — clear the cached error so a successful subsequent check
    // doesn't surface a stale "last update failed" message via the MCP
    // `update_download_status` tool. Without this reset the agent UI
    // would keep showing the previous error even after recovery.
    lastErrorMessage = undefined;
    lastErrorCategory = undefined;
    // v0.1.61 — broadcast an early `downloading` payload (indeterminate
    // bar, 0% known) so the banner transitions out of `available` state
    // the moment Squirrel acknowledges the click. Without this the user
    // sees the "Installing…" spinner for ~3s, then the toast auto-
    // dismisses, then dead air until the (sometimes-omitted) first
    // `download-progress` event lands — Ethan's exact "I see a snap
    // about downloading update but then nothing happens" complaint
    // (Voice 3760, 2026-05-23).
    broadcastSquirrelStatus({
      kind: 'downloading',
      currentVersion: app.getVersion(),
      latestVersion: pendingDownloadVersion,
      downloadStartedAt,
      checkedAt: Date.now(),
    });
  });
  autoUpdater.on('update-available', () => {
    downloadInFlight = true;
    // v0.1.61 — same intent as the `checking-for-update` rebroadcast,
    // but this event fires AFTER Squirrel has confirmed there is in
    // fact a newer bundle on the feed. The banner uses the second
    // payload to flip from "indeterminate / waiting for first chunk"
    // to "indeterminate / Squirrel says it's downloading" — even
    // though both render identically today the disk log + telemetry
    // separation makes future debugging easier.
    broadcastSquirrelStatus({
      kind: 'downloading',
      currentVersion: app.getVersion(),
      latestVersion: pendingDownloadVersion,
      downloadStartedAt,
      checkedAt: Date.now(),
    });
  });
  autoUpdater.on('update-not-available', () => {
    downloadInFlight = false;
    downloadStartedAt = undefined;
  });
  autoUpdater.on('error', (err) => {
    // v0.1.61 — broadcast the error to the renderer so the banner can
    // surface a persistent error pane with the manual-fallback link.
    // Pre-v0.1.61 this handler only reset `downloadInFlight` and logged;
    // the renderer never heard about the failure and the banner sat in
    // `downloading` indeterminate forever (exactly the symptom Ethan
    // reported on 2026-05-23 — Squirrel's signature-mismatch error
    // fired after ~22s of "downloading" and the UI showed no signal).
    log.warn('[updater] autoUpdater error event', err);
    // v0.1.69 (voice 4015): every Squirrel.Mac error gets a structured row
    // so the categorisation (signature-mismatch / network / staging /
    // unknown) survives outside the rendered UpdateBanner state. Pre-
    // v0.1.69 it only landed in main.log + as a renderer payload.
    appendErrorLog({
      subsystem: 'updater',
      phase: 'updater.squirrel-error-event',
      errorMessage: errorToString(err),
      context: { category: categoriseUpdaterError(err) },
    });
    downloadInFlight = false;
    downloadStartedAt = undefined;
    try {
      const message = String((err as Error)?.message ?? err ?? 'unknown');
      const category = categoriseUpdaterError(err);
      // v0.1.64 — persist error to module state so the MCP `update_download_status`
      // tool can report WHY a previous download bailed without scraping the
      // log file. Cleared in `checking-for-update` and `update-downloaded`.
      lastErrorMessage = message;
      lastErrorCategory = category;
      broadcastSquirrelStatus({
        kind: 'error',
        currentVersion: app.getVersion(),
        latestVersion: pendingDownloadVersion,
        error: message,
        errorCategory: category,
        errorReleaseUrl: UPDATE_RELEASE_PAGE_URL,
        checkedAt: Date.now(),
      });
    } catch (broadcastErr) {
      log.error('[updater] error broadcast failed', broadcastErr);
    }
  });

  autoUpdater.on(
    'update-downloaded',
    (_evt: Electron.Event, _releaseNotes?: string, releaseName?: string) => {
      try {
        updateDownloaded = true;
        downloadInFlight = false;
        downloadStartedAt = undefined;
        // v0.1.64 — successful download clears the cached error so the
        // MCP `update_download_status` tool stops flagging a previous
        // failure. The renderer banner is independent and already handles
        // this via the `ready-to-install` broadcast.
        lastErrorMessage = undefined;
        lastErrorCategory = undefined;
        broadcastSquirrelStatus({
          kind: 'ready-to-install',
          currentVersion: app.getVersion(),
          // `releaseName` is the version string per Electron's autoUpdater
          // contract on macOS (Squirrel.Mac sets it to the new bundle's
          // CFBundleShortVersionString).
          latestVersion:
            typeof releaseName === 'string' ? releaseName : pendingDownloadVersion,
          checkedAt: Date.now(),
        });
        log.info('[updater] update downloaded, ready to install', { releaseName });
      } catch (err) {
        log.error('[updater] update-downloaded forward failed', err);
      }
    },
  );
}

/**
 * v0.1.61 — cache the latest `latestVersion` resolved by the GH-Releases
 * poller so the Squirrel-side progress/ready broadcasts can carry it.
 * Squirrel itself doesn't know the human-readable tag name until
 * `update-downloaded` fires (Squirrel.Mac's `releaseName` field is set
 * during bundle staging), so without this cache the banner has no version
 * string to show in the "Downloading Restream Chat++ v0.1.61…" header.
 *
 * Called from `github-update-check.ts` on every `available` broadcast.
 * Idempotent / no-op when version is undefined (e.g. an `up-to-date`
 * payload).
 */
export function rememberPendingDownloadVersion(version: string | undefined): void {
  if (typeof version === 'string' && version.length > 0) {
    pendingDownloadVersion = version;
  }
}

/**
 * v0.1.64 — coarse-grained download-state machine, exported so the
 * in-process HTTP MCP can answer `update_download_status` without
 * re-implementing the bookkeeping.
 *
 *   - 'idle'              → no check / download / staged update in flight.
 *                           Default at boot.
 *   - 'checking'          → Squirrel is talking to update.electronjs.org
 *                           but the new-version probe hasn't resolved yet.
 *                           Set by the `checking-for-update` event listener.
 *   - 'downloading'       → Squirrel has confirmed there's a newer bundle
 *                           and the zip is being pulled from GH releases.
 *                           Set by `update-available` / `download-progress`.
 *   - 'ready-to-install'  → Squirrel staged the bundle into ShipIt's
 *                           working dir; calling `quitAndInstall` from
 *                           here will swap the bundle and relaunch.
 *   - 'error'             → Squirrel emitted an `error` event. The last
 *                           error message is preserved on `lastErrorMessage`.
 *
 * This is a derived view of the existing module-level flags
 * (`downloadInFlight`, `updateDownloaded`, etc.) rather than a separate
 * state machine, so there is exactly one source of truth — the existing
 * IPC broadcast path. Reading is O(1).
 */
export type UpdateDownloadState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready-to-install'
  | 'error';

/**
 * Last error message Squirrel surfaced. Reset to undefined the next time
 * the autoUpdater enters `checking-for-update` (so subsequent successful
 * runs don't keep showing a stale error). The MCP `update_download_status`
 * tool exposes this so an agent can see why a previous download bailed
 * without scraping the log file.
 */
let lastErrorMessage: string | undefined;
let lastErrorCategory: 'signature-mismatch' | 'network' | 'staging' | 'unknown' | undefined;

/**
 * v0.1.64 — read the current Squirrel download state. Pure read; never
 * touches any side effect. Designed for the MCP `update_download_status`
 * tool but suitable for any in-process consumer (e.g. an About-window
 * status line, future tray badge).
 */
export function getDownloadState(): {
  state: UpdateDownloadState;
  pendingVersion: string | undefined;
  downloadStartedAt: number | undefined;
  lastErrorMessage: string | undefined;
  lastErrorCategory: typeof lastErrorCategory;
} {
  // Resolve to the most specific terminal state first. Order matters:
  // `updateDownloaded` wins over `downloadInFlight` (Squirrel can briefly
  // show both true between `update-downloaded` and the next state push,
  // though our event handlers clear `downloadInFlight` immediately).
  let state: UpdateDownloadState;
  if (lastErrorMessage) {
    state = 'error';
  } else if (updateDownloaded) {
    state = 'ready-to-install';
  } else if (downloadInFlight) {
    // `downloadInFlight` is set on both `checking-for-update` AND
    // `update-available` / first `download-progress`. We can't easily
    // distinguish the two without adding a second flag — for now anything
    // in-flight surfaces as `downloading` since that's the user-actionable
    // state (the difference between "Squirrel is talking to GH" and
    // "Squirrel is pulling bytes" is invisible at the MCP layer). A
    // future enhancement could split this if the renderer banner needs it.
    state = 'downloading';
  } else {
    state = 'idle';
  }
  return {
    state,
    pendingVersion: pendingDownloadVersion,
    downloadStartedAt,
    lastErrorMessage,
    lastErrorCategory,
  };
}

/**
 * v0.1.64 — exposed for the MCP `update_install_now` tool. Same guard
 * semantics as `quitAndInstallStagedUpdate` (refuses if no update staged)
 * but reachable as a named export from outside the IPC handler.
 *
 * This is just an alias — kept for naming clarity at the MCP boundary
 * (`updateInstallNow()` reads more naturally than reusing the rendererfacing
 * `quitAndInstallStagedUpdate`).
 */
export function triggerInstallNow(): { ok: boolean; reason?: string } {
  return quitAndInstallStagedUpdate();
}

/**
 * v0.1.64 — return a defensive snapshot of internal updater bookkeeping
 * for unit tests. Not part of the MCP surface; exported so the
 * Vitest suite can assert state transitions without spying on module
 * internals.
 */
export function _getUpdaterInternalsForTest(): {
  configured: boolean;
  feedURLReady: boolean;
  checkInFlight: boolean;
  updateDownloaded: boolean;
  downloadInFlight: boolean;
  downloadStartedAt: number | undefined;
  pendingDownloadVersion: string | undefined;
  lastErrorMessage: string | undefined;
} {
  return {
    configured,
    feedURLReady,
    checkInFlight,
    updateDownloaded,
    downloadInFlight,
    downloadStartedAt,
    pendingDownloadVersion,
    lastErrorMessage,
  };
}

/**
 * Renderer-triggered restart. Bound to `IPC.UPDATE_QUIT_AND_INSTALL` in
 * `main.ts`. `autoUpdater.quitAndInstall()` throws synchronously if no
 * update has been staged — guarded with `updateDownloaded` so the
 * Restart button can't accidentally crash the app. v0.1.25.
 */
export function quitAndInstallStagedUpdate(): { ok: boolean; reason?: string } {
  if (!updateDownloaded) {
    log.warn('[updater] quit-and-install requested but no update staged');
    return { ok: false, reason: 'no-update-downloaded' };
  }
  try {
    log.info('[updater] quit-and-install triggered from renderer');
    // v0.1.52 fix: schedule the actual restart on the next tick so the IPC
    // round-trip can complete and we can return a result to the renderer
    // BEFORE the app starts tearing down. Sparkle's `quitAndInstall()` on
    // macOS posts an NSAlert to dismiss any open dialogs and then forces a
    // restart immediately — when called synchronously inside an ipcMain
    // handler, the renderer's pending Promise can be dropped without ever
    // resolving, and the user-visible "click Restart, nothing happens"
    // symptom appears (the Restart button stays clickable, the toast
    // never fires). Async-scheduling the actual restart lets the IPC
    // reply land first.
    //
    // We also call `app.relaunch()` BEFORE `quitAndInstall()` as a belt-
    // and-braces safeguard: if Squirrel's `quitAndInstall()` silently
    // no-ops (e.g. the staged update was already consumed by an earlier
    // update-electron-app native dialog), the relaunch+quit pair still
    // produces a visible restart, so the user always sees the action
    // happen. The Squirrel state machine treats `quit()` after
    // `quitAndInstall()` as a no-op if Squirrel has already initiated the
    // bundle swap, so this is safe in the normal path.
    setImmediate(() => {
      try {
        log.info('[updater] firing autoUpdater.quitAndInstall() (deferred)');
        autoUpdater.quitAndInstall();
        // Fallback: if Squirrel didn't actually restart (no staged bundle
        // to install), give it 1.5s and then force-relaunch ourselves. The
        // user clicked Restart — they need to see SOMETHING happen.
        setTimeout(() => {
          log.warn(
            '[updater] still running after quitAndInstall — forcing relaunch+quit',
          );
          try {
            app.relaunch();
            app.exit(0);
          } catch (relaunchErr) {
            log.error('[updater] forced relaunch failed', relaunchErr);
          }
        }, 1500);
      } catch (err) {
        log.error('[updater] deferred quit-and-install threw', err);
        // Last-resort: force a relaunch so the user still sees a restart.
        try {
          app.relaunch();
          app.exit(0);
        } catch (relaunchErr) {
          log.error('[updater] last-resort relaunch failed', relaunchErr);
        }
      }
    });
    return { ok: true };
  } catch (err) {
    log.error('[updater] quit-and-install threw', err);
    // v0.1.69 (voice 4015): the user clicked Restart — if this throws
    // they see nothing. Structured row so we can see post-install
    // attempts that didn't make it past the sync entry point. Note
    // most of the failure modes are in the DEFERRED setImmediate
    // branch above; this catch is the early-return path.
    appendErrorLog({
      subsystem: 'updater',
      phase: 'updater.quit-and-install-threw',
      errorMessage: errorToString(err),
    });
    return { ok: false, reason: String((err as Error)?.message ?? err) };
  }
}

/**
 * Result of triggering Squirrel's in-app download from the renderer's
 * "Download" button. v0.1.32+.
 *
 *   - 'started'              → autoUpdater.checkForUpdates() was kicked.
 *                              Squirrel will emit `download-progress` and
 *                              `update-downloaded` events which the
 *                              progress forwarders broadcast as
 *                              `IPC.UPDATE_STATUS` payloads — the banner
 *                              transitions through 'downloading' →
 *                              'ready-to-install' automatically.
 *   - 'not-packaged'         → dev mode; nothing to do.
 *   - 'unsupported-platform' → Linux; no Squirrel support compiled in.
 *   - 'feed-unavailable'     → `updateElectronApp({...})` never settled
 *                              (unsigned build, network problem at boot,
 *                              etc.). User is told in-app rather than
 *                              being silently bounced to the browser.
 *   - 'error'                → `autoUpdater.checkForUpdates()` threw.
 */
/**
 * v0.1.39: `mode` discriminator added so the renderer can pick the
 * right user-facing toast. `squirrel` = in-app pipeline kicked
 * (banner will transition through `downloading` automatically);
 * `browser` = main-process fallback successfully bounced the user to
 * the GitHub release page in their default browser. On failure
 * (`ok: false`) the renderer renders an error toast with the
 * release-page URL as a manual-fallback link.
 */
export type StartDownloadResult =
  | { ok: true; reason: 'started'; mode: 'squirrel' }
  | { ok: true; reason: 'already-downloading'; mode: 'squirrel' }
  | { ok: true; reason: 'already-staged'; mode: 'squirrel' }
  | { ok: true; reason: 'opened-release-page'; mode: 'browser'; fallbackReason: string }
  | {
      ok: false;
      reason: 'not-packaged' | 'unsupported-platform' | 'feed-unavailable' | 'error';
      error?: string;
      /**
       * Always populated on failure so the renderer can offer a manual
       * "click here" link as last-resort fallback (e.g. shell.openExternal
       * threw too — extremely rare but possible on locked-down systems).
       */
      releaseUrl: string;
    };

/**
 * Renderer-triggered in-app download. Bound to
 * `IPC.UPDATE_DOWNLOAD_START` in `main.ts`. Click handler for the
 * `UpdateBanner`'s "Download" button when the banner is in `available`
 * state.
 *
 * Pre-v0.1.32 this button opened the GitHub release page in the user's
 * default browser via `shell.openExternal`. That side-stepped the entire
 * Squirrel pipeline we'd already wired in v0.1.25 (Squirrel emits
 * download-progress → renderer shows progress bar → Squirrel emits
 * update-downloaded → renderer shows Restart button → user clicks →
 * quitAndInstall swaps the bundle). v0.1.32 wires the button to fire
 * `autoUpdater.checkForUpdates()` instead so the in-app pipeline
 * actually runs.
 *
 * `autoUpdater.checkForUpdates()` is idempotent — calling it while
 * a download is already in flight is a no-op. We guard against a stray
 * call before the feed URL is configured because the native autoUpdater
 * throws synchronously in that case (same root cause as
 * `checkForUpdatesInteractive`).
 */
export const UPDATE_RELEASE_PAGE_URL =
  'https://github.com/EthanSK/restream-chat-plus-plus/releases';

export function triggerSquirrelDownload(): StartDownloadResult {
  if (!app.isPackaged) {
    log.info('[updater] download requested in dev/unpackaged build — no-op');
    return { ok: false, reason: 'not-packaged', releaseUrl: UPDATE_RELEASE_PAGE_URL };
  }
  if (process.platform === 'linux') {
    // Squirrel.Mac handles macOS, Squirrel.Windows handles win32; Linux
    // updates ship as .deb / .rpm packages outside the Electron auto-
    // update pipeline. We surface this distinctly so the renderer (or
    // a main-process dialog) can route the user to the right path.
    log.info('[updater] download requested on linux — no in-app updater');
    return {
      ok: false,
      reason: 'unsupported-platform',
      releaseUrl: UPDATE_RELEASE_PAGE_URL,
    };
  }
  if (!feedURLReady) {
    // `configureAutoUpdater()` never settled — common on unsigned builds
    // where `updateElectronApp({...})` throws because Squirrel.Mac refuses
    // an unsigned feed. Without this guard, calling checkForUpdates()
    // would throw synchronously ("Update feed URL is not set"). v0.1.32.
    log.warn('[updater] download requested but feed URL not ready');
    return {
      ok: false,
      reason: 'feed-unavailable',
      releaseUrl: UPDATE_RELEASE_PAGE_URL,
    };
  }
  // v0.1.52: short-circuit when an update has already been downloaded.
  // Calling `checkForUpdates()` after `update-downloaded` throws "The
  // command is disabled and cannot be executed" — Squirrel's state
  // machine refuses to re-enter the check loop while a staged bundle is
  // pending install. Surface this as a success so the banner shows
  // "Downloading update…" while the renderer transitions to ready-to-
  // install on the next UpdateInfo broadcast.
  if (updateDownloaded) {
    log.info('[updater] download requested but update already staged — no-op');
    return { ok: true, reason: 'already-staged', mode: 'squirrel' };
  }
  // v0.1.52: same guard against re-clicking while Squirrel is already
  // mid-download. Without this, the second click triggers the "command
  // is disabled" throw and the user sees the cryptic "Update could not
  // start" toast even though the download is in fact progressing in
  // the background.
  if (downloadInFlight) {
    log.info('[updater] download requested but already in flight — no-op');
    return { ok: true, reason: 'already-downloading', mode: 'squirrel' };
  }
  try {
    log.info('[updater] kicking autoUpdater.checkForUpdates() from renderer');
    downloadInFlight = true;
    downloadStartedAt = Date.now();
    // v0.1.61 — broadcast a `downloading` payload IMMEDIATELY (before
    // Squirrel even fires `checking-for-update`) so the banner flips
    // away from `available` the moment the IPC round-trip resolves.
    // Without this, on slow Squirrel start-ups the banner stays in
    // `available` for several seconds while the Installing… toast
    // auto-dismisses, leaving the user with no feedback at all. The
    // banner renders an indeterminate progress bar in this state.
    broadcastSquirrelStatus({
      kind: 'downloading',
      currentVersion: app.getVersion(),
      latestVersion: pendingDownloadVersion,
      downloadStartedAt,
      checkedAt: Date.now(),
    });
    autoUpdater.checkForUpdates();
    return { ok: true, reason: 'started', mode: 'squirrel' };
  } catch (err) {
    // Reset the flag — the throw means the check never actually started,
    // so re-entry would otherwise be incorrectly blocked on the next click.
    downloadInFlight = false;
    downloadStartedAt = undefined;
    log.error('[updater] checkForUpdates() threw', err);
    // v0.1.69 (voice 4015): synchronous throw from autoUpdater is the
    // less-common cousin of the async `error` event but they happen for
    // similar reasons (feed URL race, sandbox restrictions). One row
    // per occurrence makes both paths uniformly discoverable.
    appendErrorLog({
      subsystem: 'updater',
      phase: 'updater.check-for-updates-threw',
      errorMessage: errorToString(err),
      context: { category: categoriseUpdaterError(err) },
    });
    // v0.1.61 — also broadcast an `error` payload so the renderer can
    // show a persistent error pane (matching the async error-event
    // path). Without this the banner would briefly flip to `downloading`
    // then sit there forever after the synchronous throw.
    try {
      const message = String((err as Error)?.message ?? err);
      // v0.1.64 — persist error to module state for the MCP status tool.
      lastErrorMessage = message;
      lastErrorCategory = categoriseUpdaterError(err);
      broadcastSquirrelStatus({
        kind: 'error',
        currentVersion: app.getVersion(),
        latestVersion: pendingDownloadVersion,
        error: message,
        errorCategory: categoriseUpdaterError(err),
        errorReleaseUrl: UPDATE_RELEASE_PAGE_URL,
        checkedAt: Date.now(),
      });
    } catch (broadcastErr) {
      log.error('[updater] sync-throw error broadcast failed', broadcastErr);
    }
    return {
      ok: false,
      reason: 'error',
      error: String((err as Error)?.message ?? err),
      releaseUrl: UPDATE_RELEASE_PAGE_URL,
    };
  }
}

export function configureAutoUpdater(): void {
  if (configured) return;
  configured = true;

  // Skip in dev — `update-electron-app` already short-circuits when
  // `!app.isPackaged`, but this also avoids the misleading log line.
  if (!app.isPackaged) {
    log.info('[updater] skipping auto-update (not packaged / dev mode)');
    return;
  }

  try {
    updateElectronApp({
      updateSource: {
        type: UpdateSourceType.ElectronPublicUpdateService,
        repo: REPO,
      },
      // Poll every hour. The default is also 1h; we set it explicitly so
      // tweaking later is one line.
      updateInterval: '1 hour',
      logger: log,
      // v0.1.52: was `true`. The built-in "Restart to Install" dialog
      // competes with our in-app `UpdateBanner` — both listen for
      // `update-downloaded`, both call `quitAndInstall()` on user
      // confirmation. When the user dismissed the native dialog with
      // "Later", Squirrel's state machine internally reset the staged
      // update, so the banner's Restart button then silently no-op'd —
      // exactly Ethan's "click Restart, nothing happens" symptom.
      // Single source of truth = the banner.
      notifyUser: false,
    });
    feedURLReady = true;
    // Wire Squirrel download-progress + update-downloaded forwarders so
    // the renderer's `UpdateBanner` can show a progress bar + restart
    // button respectively. Must be attached AFTER `updateElectronApp`
    // configures the feed URL — before that, the autoUpdater isn't set
    // up. v0.1.25.
    attachSquirrelProgressForwarders();
    log.info('[updater] auto-update configured for', REPO);
  } catch (err) {
    log.error('[updater] failed to configure auto-update', err);
    // v0.1.69 (voice 4015): configure failure is rare but completely
    // disables the in-app updater for the session — `feedURLReady`
    // stays false → every download click bails with 'feed-unavailable'.
    // Worth a row so we can see if this happens repeatedly on a given
    // user (unsigned build, network blip at boot, etc).
    appendErrorLog({
      subsystem: 'updater',
      phase: 'updater.configure-failed',
      errorMessage: errorToString(err),
    });
  }
}

/**
 * Resolve a usable parent window for `dialog.showMessageBox`.
 *
 * `dialog.showMessageBox(null, opts)` is NOT a valid Electron overload —
 * the first arg must be a real `BrowserWindow` or omitted entirely.
 * Passing `null` throws `TypeError: Error processing argument at index 0`,
 * which inside a menu-click handler bubbles up to the native menu validator
 * and is surfaced by macOS as "this command is disabled and cannot be
 * executed". Always normalise to either a live window or `undefined`.
 */
function resolveParent(parent: BrowserWindow | null): BrowserWindow | undefined {
  if (parent && !parent.isDestroyed()) return parent;
  const fallback = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  return fallback && !fallback.isDestroyed() ? fallback : undefined;
}

/**
 * Show a message box that works whether or not we have a parent window.
 * Electron requires the two-arg form when `parent` is truthy and the
 * one-arg form when it isn't; mixing them up throws synchronously.
 */
async function safeMessageBox(
  parent: BrowserWindow | undefined,
  opts: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  try {
    return parent
      ? await dialog.showMessageBox(parent, opts)
      : await dialog.showMessageBox(opts);
  } catch (err) {
    log.error('[updater] showMessageBox failed', err);
    // v0.1.83 — on a dialog-SHOW FAILURE return a sentinel `response: -1`
    // (NOT `0`). WHY: button index 0 is a real, actionable choice at some
    // call sites — for the "Update available" dialog index 0 is "Open
    // Release Page", and the caller does `if (response === 0) await
    // shell.openExternal(releaseUrl)`. If a thrown dialog mapped to `0`,
    // a FAILED dialog would silently open the user's browser to the
    // release page with no prompt — a confusing, unrequested side effect.
    // `-1` matches no `response === <n>` check at any call site, so a
    // dialog failure now correctly maps to "no action taken". The other
    // call sites ignore the return value entirely, so this is safe for
    // them too.
    return { response: -1, checkboxChecked: false };
  }
}

/**
 * Triggered by the "Check for Updates Now…" menu item.
 *
 * v0.1.37 rewrite: this is now backed by the **GH-Releases pipeline**
 * (`performGithubUpdateCheck`) so the user-facing dialog ALWAYS agrees
 * with the in-app banner. Pre-v0.1.37 the menu used Squirrel's
 * `autoUpdater.checkForUpdates()`, which on unsigned macOS builds
 * resolves to `update-not-available` and shows "you're on the latest
 * version" — even when GH Releases is reporting a newer release that
 * the banner is already advertising. Voice 3351 flagged this two-
 * sources-of-truth mismatch directly: "Your dialogue says you're on
 * the latest version, but then the top banner says update available
 * 0.1.36. Is it looking at a different source? Maybe that's the
 * problem."
 *
 * After producing the authoritative GH-Releases verdict, this function
 * ALSO kicks Squirrel's `autoUpdater.checkForUpdates()` in the
 * background when the feed is ready (signed packaged builds) so the
 * in-app download → restart-to-install flow still runs without the
 * user needing to click Install on the banner. On unsigned / dev /
 * Linux Squirrel is skipped entirely and the dialog offers an "Open
 * Releases" button that drops the user on the GitHub release page.
 *
 * IMPORTANT: this function must never throw synchronously. The
 * Electron menu-click dispatcher treats a sync throw as a failed
 * action invocation and macOS surfaces it as the cryptic alert "this
 * command is disabled and cannot be executed". All known throw sites
 * are caught and converted into user-visible dialogs.
 */
export async function checkForUpdatesInteractive(
  parent: BrowserWindow | null,
): Promise<void> {
  const owner = resolveParent(parent);

  if (checkInFlight) {
    log.info('[updater] check already in flight, ignoring duplicate click');
    return;
  }
  checkInFlight = true;

  try {
    // 1. Hit GH Releases — authoritative source. `performGithubUpdateCheck`
    //    broadcasts `UPDATE_STATUS` so the banner state syncs to the
    //    dialog automatically (no two-sources-of-truth window).
    const info = await performGithubUpdateCheck(true);

    // 2. Render dialog based on the GH-Releases verdict.
    if (info.kind === 'available') {
      const latest = info.latestVersion ?? '(unknown)';
      const releaseUrl = info.releaseUrl ?? `https://github.com/${REPO}/releases`;
      const detail =
        `You're running ${info.currentVersion}. Latest is ${latest}.\n\n` +
        (app.isPackaged && process.platform !== 'linux' && feedURLReady
          ? "The update is downloading in the background — you'll be prompted to restart once it's ready."
          : 'Open the release page to install manually (this build is not connected to the in-app update feed).');
      const buttons = ['Open Release Page', 'OK'];
      // Index 0 = "Open Release Page", index 1 = "OK" (default/cancel).
      const OPEN_RELEASE_PAGE = 0;
      const { response } = await safeMessageBox(owner, {
        type: 'info',
        message: `Update available (${latest}).`,
        detail,
        buttons,
        defaultId: 1,
        cancelId: 1,
      });
      // v0.1.83 — only open the browser when the dialog ACTUALLY succeeded
      // AND the user picked "Open Release Page". On a dialog-show failure
      // `safeMessageBox` now returns the sentinel `-1` (see its catch),
      // which deliberately does NOT equal `OPEN_RELEASE_PAGE`, so a failed
      // dialog no longer opens the release page unprompted. The strict
      // `=== OPEN_RELEASE_PAGE` check also means any future button reorder
      // is the only thing that can change which action this triggers.
      if (response === OPEN_RELEASE_PAGE) await shell.openExternal(releaseUrl);

      // 3. Kick Squirrel in the background if it can actually run.
      //    Wrapped in a try/catch because the native autoUpdater
      //    throws synchronously if anything is misconfigured — we
      //    don't want that to leak into the menu-click dispatcher.
      if (app.isPackaged && process.platform !== 'linux' && feedURLReady) {
        try {
          log.info('[updater] kicking Squirrel checkForUpdates() from menu');
          autoUpdater.checkForUpdates();
        } catch (err) {
          log.error('[updater] background Squirrel kick threw', err);
        }
      }
    } else if (info.kind === 'up-to-date') {
      await safeMessageBox(owner, {
        type: 'info',
        message: `You're on the latest version (${info.currentVersion}).`,
        buttons: ['OK'],
      });
    } else if (info.kind === 'error') {
      await safeMessageBox(owner, {
        type: 'warning',
        message: 'Update check failed.',
        detail: info.error ?? 'Unknown error.',
        buttons: ['OK'],
      });
    } else if (info.kind === 'disabled') {
      // Forcing through performGithubUpdateCheck(true) should never
      // resolve to `disabled` — `force=true` bypasses the autoCheck
      // gate. Guard defensively anyway.
      await safeMessageBox(owner, {
        type: 'info',
        message: 'Update checks are currently disabled in Settings.',
        buttons: ['OK'],
      });
    }
    // `checking` is transient — `performGithubUpdateCheck` resolves
    // with a terminal kind, never `checking`, so we don't handle it.
  } catch (err) {
    log.error('[updater] interactive check failed', err);
    await safeMessageBox(owner, {
      type: 'warning',
      message: 'Update check failed.',
      detail: String((err as Error)?.message ?? err),
      buttons: ['OK'],
    });
  } finally {
    checkInFlight = false;
  }
}
