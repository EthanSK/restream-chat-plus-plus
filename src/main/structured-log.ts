// ---------------------------------------------------------------------------
// v0.1.69 (voice 4015) — shared structured logging + log-retention rotation
// ---------------------------------------------------------------------------
//
// Ethan voice 4015 (2026-05-24, ~17:06 BST):
//   "The easiest solution is you add proper logging, then you can investigate
//    exactly what the problem was. It should have all the information needed
//    to debug and diagnose every type of error. And feel free to have a
//    buffer so it gets rid of the old ones after, like, a week or something."
//
// Why this module exists:
// ------------------------
// Pre-v0.1.69 each subsystem grew its OWN ad-hoc jsonl logger (the
// chat-send.jsonl pattern in chat-send.ts, the tts-events.jsonl pattern in
// main.ts, the reconnect-events.jsonl pattern in main.ts, the
// compose-requests.jsonl pattern in main.ts). For ANY new failure path we
// either copy-pasted that boilerplate (path resolve + mkdir + JSON.stringify
// + appendFileSync + swallow-errors) or — far more commonly — just left a
// `console.error` that disappears into volatile stderr the moment the app
// quits. That meant entire categories of error (OAuth refresh failures,
// WebSocket frame parse errors, Keychain ACL drift, IPC handler crashes,
// updater errors, normalize drops) were INVISIBLE on disk and had to be
// reproduced live to diagnose.
//
// This module gives every subsystem a uniform jsonl appender + a single
// 7-day retention rotation step. New error sites pick ONE of two helpers:
//
//   - `appendErrorLog({ subsystem, phase, ...details })` — generic app-
//     wide error log at `app-errors.jsonl`. Use for any catch/throw site
//     that doesn't already have a domain-specific jsonl. Includes a
//     `subsystem` tag so log forensics can grep by component
//     (`'oauth'`, `'ws'`, `'main'`, `'updater'`, etc.) without needing
//     to know which file the error came from.
//
//   - `appendJsonl(filename, record)` — write to a NAMED jsonl file. Use
//     when the subsystem already has a dedicated log (chat-send.jsonl,
//     tts-events.jsonl, etc.) so existing log readers + tests don't
//     break. We don't rip out the existing per-domain files because they
//     have distinct grep / forensic value (chat-send.jsonl reads as a
//     send-pipeline timeline; mixing oauth refreshes into it would
//     muddle that signal).
//
// Both helpers are FAIL-SOFT — every fs call is wrapped in try/catch and
// errors are swallowed (forwarded to console.error so dev-mode users see
// them, but never thrown). Logging must NEVER break the parent flow.
//
// Buffer / retention: every jsonl file under the app logs dir is pruned
// to the last RETENTION_DAYS days (default 7) at app boot + once every
// 24 h while the app is running. Pruning is line-by-line ts-based — a
// malformed line is preserved (keeps any non-jsonl debugging artifacts
// like the legacy compose-requests.jsonl "logger-attached" string).
// Files smaller than PRUNE_MIN_SIZE_BYTES are skipped to avoid IO on
// tiny logs (and to give the first 24h of a fresh install a buffer
// before any prune work touches disk).
//
// Path resolution: every file lives under Electron's `app.getPath('logs')`
// dir (macOS = ~/Library/Logs/Restream Chat Plus Plus). When called from
// a unit-test environment without Electron (no `app` module), the resolver
// returns undefined and every appender becomes a silent no-op — same
// pattern as `chat-send.ts`'s `getElectron()` lazy resolve.
//
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

/**
 * v0.1.69 (voice 4015) — retention window for jsonl log pruning. 7 days
 * is Ethan's explicit ask ("gets rid of the old ones after, like, a week
 * or something"). At RC++'s observed log volumes (~1-10 KiB/day chat-send,
 * <100 KiB/day raw-frames per active stream) this caps total log disk
 * usage well under a megabyte per file.
 */
export const RETENTION_DAYS = 7;

/**
 * Minimum file size before the pruner will rewrite a file. Skipping
 * smaller files saves a read+parse+write cycle on logs that haven't
 * accumulated enough volume to matter (a 1 KiB chat-send.jsonl with
 * three entries doesn't benefit from being pruned to one). Tuned to
 * 100 KiB — about a thousand JSONL lines on typical RC++ payloads.
 */
export const PRUNE_MIN_SIZE_BYTES = 100_000;

/**
 * How often the in-app prune timer fires. 24 h keeps long-running
 * sessions (Ethan streams for hours at a time) from accumulating
 * unbounded logs across days without ever quitting the app.
 */
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Lazy-resolve the Electron app logs directory. We can't `import { app }`
 * at module top-level because this module is imported under Vitest where
 * the electron binary isn't installed — same lazy-require trick used in
 * `chat-send.ts` and `ws-client.ts`.
 *
 * Returns undefined when Electron isn't available (unit tests) so the
 * appenders silently no-op rather than throwing.
 */
function tryGetLogsDir(): string | undefined {
  // Vitest sets VITEST=true; bail before requiring electron so tests
  // don't trigger an Electron binary download on CI.
  if (process.env.VITEST) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as typeof import('electron');
    const dir = electron.app?.getPath?.('logs');
    if (!dir) return undefined;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return undefined;
  }
}

/**
 * Subsystem identifiers used in `AppErrorLogRecord.subsystem`. Open union
 * (string) so subsystems we don't anticipate yet can still log without a
 * type-system rebuild, but the documented identifiers should be preferred
 * for grep consistency.
 *
 * Add new identifiers here when a new module starts emitting error logs.
 */
export type AppErrorSubsystem =
  | 'oauth'
  | 'ws'
  | 'normalize'
  | 'chat-send'
  | 'chat-send-queue'
  | 'main'
  | 'updater'
  | 'github-update'
  | 'mcp'
  | 'tts'
  | 'credentials'
  | 'store'
  | 'log-prune'
  | string;

/**
 * One row in `app-errors.jsonl` — the catch-all structured error log.
 *
 * Every error-producing code site should emit one of these instead of (or
 * in addition to) a bare `console.error`. The shape mirrors what the
 * existing chat-send.jsonl rows carry but with a wider audience:
 *
 *   - `subsystem` — coarse-grained component identifier for grep.
 *   - `phase` — fine-grained event name within the subsystem
 *     (`'oauth.refresh-failed'`, `'ws.frame-parse-error'`, etc.).
 *     Convention: `<subsystem>.<event>` so the phase alone uniquely
 *     identifies the call site.
 *   - `errorMessage` — best-effort string extracted from the raw error.
 *     Always present; falls back to "unknown" when the catch block has
 *     no error object.
 *   - `httpStatus` — optional for HTTP-call sites (oauth refresh,
 *     github update check, send POST). Null if not applicable.
 *   - `context` — open-shaped record for any additional state worth
 *     capturing (token expiry timestamps, frame contents up to a cap,
 *     URLs being requested, etc.). Values should be primitives or
 *     small JSON-safe objects — large blobs go into a separate file.
 */
export interface AppErrorLogRecord {
  /** ISO 8601 timestamp. Set by `appendErrorLog`; callers don't supply it. */
  ts?: string;
  subsystem: AppErrorSubsystem;
  phase: string;
  errorMessage: string;
  httpStatus?: number | null;
  context?: Record<string, unknown>;
}

/**
 * Append a JSONL row to a named file under the app logs dir.
 *
 * - Adds a `ts` field at the FRONT of the record if not already present.
 * - Swallows every error (logging must never break the parent flow). On
 *   failure we forward the failure itself to console.error so dev-mode
 *   developers can see why a row didn't land, but production users won't
 *   notice anything.
 * - Filename must end in `.jsonl` (enforced for grep-pattern consistency).
 *
 * The Electron `app.getPath('logs')` dir is created on first call.
 */
export function appendJsonl(
  filename: string,
  record: Record<string, unknown>,
): void {
  try {
    if (!filename.endsWith('.jsonl')) {
      // Defensive: surface the bad filename to dev-mode console without
      // throwing — the caller's flow keeps going.
      console.error('[structured-log] appendJsonl rejected non-.jsonl filename:', filename);
      return;
    }
    const dir = tryGetLogsDir();
    if (!dir) return;
    const file = path.join(dir, filename);
    const enriched =
      record.ts === undefined
        ? { ts: new Date().toISOString(), ...record }
        : record;
    const line = JSON.stringify(enriched) + '\n';
    fs.appendFileSync(file, line, 'utf8');
  } catch (err) {
    // never break delivery on a logging failure — only log the meta-error
    console.error('[structured-log] appendJsonl failed', filename, err);
  }
}

/**
 * Append a typed error row to `app-errors.jsonl` — the shared catch-all
 * structured error log. Use from any catch/throw site that doesn't
 * already have a domain-specific jsonl file. Sets `ts` automatically.
 *
 * Convenience: prefer this over `appendJsonl('app-errors.jsonl', {...})`
 * because the typed `AppErrorLogRecord` shape catches missing/typo'd
 * fields at compile time.
 */
export function appendErrorLog(record: AppErrorLogRecord): void {
  appendJsonl('app-errors.jsonl', record as unknown as Record<string, unknown>);
}

/**
 * Best-effort extract a human-readable message from an arbitrary thrown
 * value. Handles `Error` instances, string throws, and anything else via
 * `String()`. Returns `"unknown"` for null/undefined so the log row's
 * `errorMessage` is always a non-empty string.
 *
 * Use at every catch site:
 *   } catch (err) {
 *     appendErrorLog({
 *       subsystem: 'oauth',
 *       phase: 'oauth.refresh-threw',
 *       errorMessage: errorToString(err),
 *     });
 *   }
 */
export function errorToString(err: unknown): string {
  if (err == null) return 'unknown';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || err.name || 'Error';
  try {
    return String(err);
  } catch {
    return 'unknown';
  }
}

/**
 * Prune all *.jsonl files under the app logs dir, dropping any line whose
 * `ts` field is older than `retentionDays` days.
 *
 * Implementation:
 *   - Walks every `.jsonl` file in the logs dir non-recursively (we don't
 *     create subdirs).
 *   - Skips files smaller than `PRUNE_MIN_SIZE_BYTES` (no point reading +
 *     rewriting a 50-line file).
 *   - For each kept-or-dropped line: parse JSON, read `ts`, compare against
 *     cutoff. Malformed lines (parse error or missing/unparseable ts) are
 *     PRESERVED — keeps any legacy / non-row debugging artifacts safe.
 *   - Atomic-ish rewrite: write to `<file>.tmp` then `rename` over the
 *     original. Avoids leaving a half-written file if the process crashes
 *     mid-prune.
 *   - Per-file try/catch — a failure on one file does NOT block pruning
 *     other files.
 *
 * Reports a one-line summary per touched file via `appendErrorLog` (with
 * subsystem `'log-prune'`) so the log-rotation itself is auditable from
 * `app-errors.jsonl`. Errors are also surfaced there. No console output
 * unless the whole walk fails.
 */
export async function pruneJsonlLogs(
  retentionDays: number = RETENTION_DAYS,
): Promise<{ filesPruned: number; totalLinesDropped: number }> {
  let filesPruned = 0;
  let totalLinesDropped = 0;
  try {
    const dir = tryGetLogsDir();
    if (!dir) return { filesPruned, totalLinesDropped };

    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const files = await fs.promises.readdir(dir);

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const fullPath = path.join(dir, file);
      try {
        // Skip files smaller than the threshold — tiny logs aren't worth
        // the read+rewrite IO. This also gives a fresh install a 24-h
        // buffer before any prune happens (you'd have to generate >100KB
        // in 24h to trigger one, which means the file genuinely needs it).
        const stat = await fs.promises.stat(fullPath);
        if (stat.size < PRUNE_MIN_SIZE_BYTES) continue;

        const content = await fs.promises.readFile(fullPath, 'utf8');
        // Split on \n; filter empty strings (handles a trailing newline
        // without producing a phantom empty line). Each surviving entry
        // is a complete jsonl row.
        const lines = content.split('\n').filter((s) => s.length > 0);
        const kept: string[] = [];
        let dropped = 0;
        for (const line of lines) {
          try {
            const obj = JSON.parse(line) as { ts?: unknown };
            const tsRaw = obj?.ts;
            const tsMs =
              typeof tsRaw === 'string'
                ? Date.parse(tsRaw)
                : typeof tsRaw === 'number'
                  ? tsRaw
                  : NaN;
            if (Number.isFinite(tsMs) && tsMs >= cutoffMs) {
              kept.push(line);
            } else if (!Number.isFinite(tsMs)) {
              // Malformed / missing ts — PRESERVE so we don't accidentally
              // wipe non-row debugging artifacts.
              kept.push(line);
            } else {
              dropped += 1;
            }
          } catch {
            // Unparseable JSON — preserve (per the "keep weird artifacts"
            // rule). The compose-requests.jsonl logger historically writes
            // a one-line `logger-attached` note that may or may not be
            // valid JSON depending on Electron version.
            kept.push(line);
          }
        }

        if (dropped > 0) {
          totalLinesDropped += dropped;
          filesPruned += 1;
          const tmp = fullPath + '.tmp';
          // Atomic-ish: write tmp + rename over the original so a crash
          // mid-write doesn't leave a truncated file.
          await fs.promises.writeFile(
            tmp,
            kept.join('\n') + (kept.length > 0 ? '\n' : ''),
            'utf8',
          );
          await fs.promises.rename(tmp, fullPath);
          appendErrorLog({
            subsystem: 'log-prune',
            phase: 'log-prune.file-rewritten',
            errorMessage: 'ok',
            context: {
              file,
              dropped,
              kept: kept.length,
              sizeBefore: stat.size,
            },
          });
        }
      } catch (perFileErr) {
        // One file's failure doesn't block the rest of the walk. Report
        // the failure into the log itself so the prune-result row is
        // self-documenting.
        appendErrorLog({
          subsystem: 'log-prune',
          phase: 'log-prune.file-failed',
          errorMessage: errorToString(perFileErr),
          context: { file },
        });
      }
    }
  } catch (err) {
    // Whole-walk failure is genuinely unusual (readdir EACCES, etc.) —
    // surface to console.error so dev users see it. Production users
    // see nothing; the next prune tick retries.
    console.error('[structured-log] pruneJsonlLogs failed', err);
    appendErrorLog({
      subsystem: 'log-prune',
      phase: 'log-prune.walk-failed',
      errorMessage: errorToString(err),
    });
  }
  return { filesPruned, totalLinesDropped };
}

/**
 * Returns the path to a named jsonl under the app logs dir. Useful for
 * code that needs to reveal a log in Finder ("Reveal Logs in Finder" menu
 * item) or for tests that want to read back a row. Returns undefined when
 * the logs dir can't be resolved (Vitest / non-Electron context).
 */
export function resolveLogPath(filename: string): string | undefined {
  const dir = tryGetLogsDir();
  if (!dir) return undefined;
  return path.join(dir, filename);
}
