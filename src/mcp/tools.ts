// MCP tool registry for Restream Chat++.
//
// Each tool entry carries:
//   - `name`           — the wire-level tool name agents call
//   - `description`    — user-facing rationale (shown by the MCP client UI)
//   - `inputSchema`    — JSON-Schema object describing the expected
//                        arguments. Hand-rolled (no Zod dep) to keep the
//                        bundle tiny.
//   - `handler`        — async function that receives the (validated) args
//                        and returns the MCP "content" payload.
//
// Handlers are split into two categories:
//   1. **Settings tools** — operate ONLY on the electron-store JSON via
//      `store-io.ts`. Safe to call whether or not the GUI is running; the
//      GUI re-reads settings on every renderer-side `IPC.SETTINGS_GET`
//      pull, so an MCP-side mutation flows through naturally.
//   2. **Runtime tools** — require a running GUI process to introspect or
//      mutate live state (recent message buffer, connection list, voice
//      list, force-update-check, sign-out). Without an in-process channel
//      we surface a clear `{ guiNotIntrospectable: true, hint: ... }`
//      payload rather than silently lying.
//
// Tool name conventions follow the stats-widget MCP pattern (snake_case,
// noun-action ordering) so an agent that's used the stats widget can
// reach for the same shapes here.

import fs from 'node:fs';
import {
  DEFAULT_SETTINGS,
  type Settings,
} from '../shared/types';
import {
  loadSettings,
  mutateSettings,
  resolveStorePath,
  writeStoreFile,
} from './store-io';

// Lazy-resolve electron's `app.getVersion()`. Static `import { app } from
// 'electron'` would break vitest (no `electron` module under plain Node).
// Production callers always run inside an Electron process via the
// `--mcp-stdio` flag; the require() succeeds there.
function tryGetAppVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as {
      app?: { getVersion?: () => string };
    };
    return electron?.app?.getVersion?.() ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * JSON-Schema fragment used for `tools/list` responses. We keep these as
 * plain JS objects rather than importing ajv / zod-to-json-schema — the
 * MCP protocol accepts any valid JSON-Schema-shaped object and clients
 * (Claude, the MCP Inspector) render them directly.
 */
export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * Handler receives the parsed `arguments` object from the JSON-RPC
   * `tools/call` request. Returns the data payload — the dispatch layer
   * wraps it in the MCP `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`
   * envelope. Throwing here surfaces a JSON-RPC error to the caller.
   */
  handler: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<unknown>;
}

/**
 * Optional in-process bridge for the HTTP MCP transport. When the MCP
 * server is hosted INSIDE the running Electron main process (v0.1.36+
 * `--mcp-http` architecture), the context can provide:
 *
 *   - `readSettings()`   — read the LIVE in-memory Settings (so MCP
 *                          reads see the current renderer state, not
 *                          just whatever was persisted to disk).
 *   - `writeSettings(s)` — replace the LIVE in-memory Settings AND
 *                          persist to disk AND broadcast to the
 *                          renderer via IPC. The main process wires
 *                          this through the same store + IPC the
 *                          Settings drawer uses, so MCP mutations
 *                          show up immediately in the running UI.
 *
 * When ABSENT (the path Vitest tests and the legacy `--mcp-stdio`
 * deprecated entry exercise), tools fall back to direct file I/O via
 * `store-io.ts` — same behaviour as v0.1.29-v0.1.35.
 */
export interface LiveSettingsBridge {
  readSettings: () => Settings;
  writeSettings: (next: Settings) => Settings;
  /**
   * Optional: drop the OAuth token from the running app + persisted
   * store. Wired by `mcp-server.ts` to the same logout flow the
   * renderer's Sign-Out menu uses. When absent, the `sign_out` tool
   * falls back to its file-only path (works whether or not the GUI is
   * running, but the in-memory OAuth state remains until restart).
   */
  signOut?: () => Promise<void> | void;
  /**
   * Optional: live connection-state snapshot for `get_status`. When the
   * MCP runs in-process this surfaces the WS connection state + last
   * update info so the response isn't full of `null` placeholders.
   */
  getRuntimeStatus?: () => {
    connectionStatus?: unknown;
    latestUpdateInfo?: unknown;
    connections?: unknown;
    voices?: unknown;
  };
  /**
   * Optional: tell the renderer to clear its in-memory chat-message
   * buffer (Cmd+K equivalent). When absent, `clear_chat` returns its
   * `guiNotIntrospectable` hint as before.
   */
  clearChat?: () => void;
  /**
   * Optional: force an immediate GH-Releases update check, returning
   * the resulting UpdateInfo. When absent, `check_for_updates_now`
   * returns the legacy hint payload.
   */
  checkForUpdatesNow?: () => Promise<unknown>;
  /**
   * v0.1.64 — read the current Squirrel download state machine without
   * relying on side-channel renderer broadcasts. Returns the same shape
   * `getDownloadState()` does in `src/main/updater.ts`.
   *
   * Used by the MCP `update_download_status` tool so an external agent
   * can poll while a download is in flight (e.g. wait until the bundle
   * is staged then call `update_install_now`). Optional so the tool
   * keeps working under the legacy `--mcp-stdio` path (returns the
   * standard "GUI not introspectable" hint).
   */
  getUpdateDownloadState?: () => {
    state: 'idle' | 'checking' | 'downloading' | 'ready-to-install' | 'error';
    pendingVersion: string | undefined;
    downloadStartedAt: number | undefined;
    lastErrorMessage: string | undefined;
    lastErrorCategory:
      | 'signature-mismatch'
      | 'network'
      | 'staging'
      | 'unknown'
      | undefined;
  };
  /**
   * v0.1.64 — programmatic equivalent of clicking the renderer
   * UpdateBanner's "Restart to install" button. Returns the same shape
   * `quitAndInstallStagedUpdate` does (`{ ok, reason }`). Refuses if
   * no update has been staged — the caller is expected to poll
   * `getUpdateDownloadState()` until `state === 'ready-to-install'`
   * before invoking this.
   *
   * SAFETY: this will close the app and re-launch the new bundle —
   * any unsaved renderer state will be lost. Voice 3869 (2026-05-23)
   * authorised this; the agent decides when to install.
   */
  triggerInstallNow?: () => { ok: boolean; reason?: string };
  /**
   * v0.1.64 — return the last GH-Releases poller result. Same payload
   * shape as the IPC `UPDATE_STATUS` push (the renderer's `UpdateInfo`).
   * Used by the MCP `update_check_now` companion when an agent wants
   * the CACHED (most recent) check result without forcing a fresh
   * network round-trip.
   */
  getLastUpdateInfo?: () => unknown;
}

export interface ToolContext {
  /** Absolute path to the electron-store JSON file. */
  storePath: string;
  /** App version (`app.getVersion()` when running under Electron). */
  appVersion: string;
  /**
   * Live-state bridge into the running GUI's main process. When set,
   * tools use it instead of direct file I/O so MCP changes flow through
   * the same IPC path the renderer uses and update the live UI without
   * a restart. v0.1.36.
   */
  live?: LiveSettingsBridge;
}

/**
 * Build the runtime context every tool needs. Exported so unit tests can
 * inject a tmp store path + a fixed version string.
 */
export function buildToolContext(opts: {
  storePath?: string;
  appVersion?: string;
  live?: LiveSettingsBridge;
} = {}): ToolContext {
  return {
    storePath: opts.storePath ?? resolveStorePath(),
    appVersion: opts.appVersion ?? tryGetAppVersion(),
    live: opts.live,
  };
}

/**
 * Read settings via the live bridge (if any) or fall back to the on-disk
 * JSON. Keep tool handlers small by routing all reads through this.
 */
function readSettingsVia(ctx: ToolContext): Settings {
  if (ctx.live) return ctx.live.readSettings();
  return loadSettings(ctx.storePath);
}

/**
 * Apply a mutator either through the live bridge (in-process MCP) or via
 * the on-disk file (standalone / tests). Returns the resulting Settings.
 */
function mutateSettingsVia(
  ctx: ToolContext,
  mutate: (current: Settings) => Settings,
): Settings {
  if (ctx.live) {
    const current = ctx.live.readSettings();
    const next = mutate(current);
    return ctx.live.writeSettings(next);
  }
  return mutateSettings(ctx.storePath, mutate);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
//
// We hand-validate args (rather than depend on zod / ajv) so the MCP
// bundle stays tiny. Each helper throws a clear human-readable error
// that the dispatch layer surfaces as a JSON-RPC `-32602 Invalid params`.

function requireNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`Missing or non-numeric arg "${key}"`);
  }
  return v;
}

function requireBoolean(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  if (typeof v !== 'boolean') {
    throw new Error(`Missing or non-boolean arg "${key}"`);
  }
  return v;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Missing or empty string arg "${key}"`);
  }
  return v;
}

function requireRange(value: number, min: number, max: number, key: string): number {
  if (value < min || value > max) {
    throw new Error(`Arg "${key}" out of range: ${value} not in [${min}, ${max}]`);
  }
  return value;
}

/**
 * Validate that a candidate regex string actually parses. We compile it
 * with the `i` flag (mirroring `compileIgnorePatterns` in the renderer's
 * `message-filters.ts`) so a pattern that compiles here is guaranteed to
 * compile in the running app. Throws a human-readable error on syntax
 * failure.
 */
function validateRegex(pattern: string): void {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, 'i');
  } catch (err) {
    throw new Error(
      `Invalid regex "${pattern}": ${(err as Error)?.message ?? 'parse error'}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tool: list_settings
// ---------------------------------------------------------------------------

const listSettings: ToolDefinition = {
  name: 'list_settings',
  description:
    'Return the full Settings object as currently persisted to disk. ' +
    'Includes TTS prefs, notification prefs, platform filters, regex ' +
    'ignore lists, and update-checker prefs.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    return readSettingsVia(ctx);
  },
};

// ---------------------------------------------------------------------------
// Tool: get_filters
// ---------------------------------------------------------------------------

const getFilters: ToolDefinition = {
  name: 'get_filters',
  description:
    'Return the current regex ignore lists for TTS + notifications. ' +
    'These are case-insensitive patterns matched against ChatMessage.text. ' +
    'An empty list means EVERY incoming message gets the side effect.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const s = readSettingsVia(ctx);
    return {
      tts: s.filters.tts.ignoreRegex,
      notifications: s.filters.notifications.ignoreRegex,
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: get_status
// ---------------------------------------------------------------------------

const getStatus: ToolDefinition = {
  name: 'get_status',
  description:
    'Return a snapshot of high-level app status: current version, whether ' +
    'an auth token is persisted on disk (best-effort — cannot inspect the ' +
    'live OAuth state from outside the GUI), and whether auto-update ' +
    'checks are enabled. Live connection state + last-update-info are ' +
    'NOT available from the standalone MCP process — those require a ' +
    'running GUI and an in-process IPC channel we do not yet have.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const s = readSettingsVia(ctx);
    // Detect token presence without decrypting — both the legacy `token`
    // key and the v0.1.15+ `tokenEnc` key are read directly from the
    // store file. We only report presence (boolean) — never the value.
    let hasToken = false;
    try {
      const raw = fs.readFileSync(ctx.storePath, 'utf8');
      const parsed = JSON.parse(raw);
      hasToken = !!(parsed?.token || parsed?.tokenEnc);
    } catch {
      // Missing / malformed → hasToken stays false. Not a hard error.
    }
    // When running in-process (v0.1.36 HTTP MCP) the live bridge can
    // surface the WS connection state + most-recent UpdateInfo so the
    // status snapshot is fully populated. Outside the live bridge
    // (legacy --mcp-stdio path / vitest) we keep these null so the
    // schema shape stays stable.
    const runtime = ctx.live?.getRuntimeStatus?.();
    return {
      appVersion: ctx.appVersion,
      hasPersistedAuthToken: hasToken,
      autoUpdateCheckEnabled: s.update.autoCheck,
      ttsEnabled: s.tts.enabled,
      notificationsEnabled: s.notifications.enabled,
      connectionStatus: runtime?.connectionStatus ?? null,
      latestUpdateInfo: runtime?.latestUpdateInfo ?? null,
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: get_voices
// ---------------------------------------------------------------------------
//
// Voice enumeration is a renderer-only API (`speechSynthesis.getVoices()`).
// The MCP process has no access to that. We surface a clear note rather
// than fabricating a list.

const getVoices: ToolDefinition = {
  name: 'get_voices',
  description:
    'List available TTS voices. Currently requires the running GUI to ' +
    'enumerate (Web Speech API lives in the renderer) — the standalone ' +
    'MCP process cannot reach it. Returns the persisted voiceURI so ' +
    'agents can confirm which one is selected.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const s = readSettingsVia(ctx);
    const runtime = ctx.live?.getRuntimeStatus?.();
    return {
      currentVoiceURI: s.tts.voiceURI ?? null,
      voices: runtime?.voices ?? null,
      hint:
        runtime?.voices != null
          ? undefined
          : 'Voice enumeration requires the live renderer process. Open the ' +
            'Settings drawer in Restream Chat++ to see the full list. To ' +
            'select a voice, call `set_voice` with the desired voiceURI ' +
            '(e.g. "com.apple.voice.compact.en-GB.Daniel" on macOS).',
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: list_recent_messages
// ---------------------------------------------------------------------------

const listRecentMessages: ToolDefinition = {
  name: 'list_recent_messages',
  description:
    'List the most recent chat messages. Currently requires the running ' +
    'GUI to introspect (messages are buffered in the renderer; we do not ' +
    'persist them to disk). Returns a not-introspectable note.',
  inputSchema: {
    type: 'object',
    properties: {
      count: {
        type: 'number',
        description: 'Maximum messages to return (default 20)',
        minimum: 1,
        maximum: 500,
      },
    },
    additionalProperties: false,
  },
  handler: async (_args, _ctx) => {
    // The recent-message buffer is purely a renderer artefact (we never
    // persist it). Even with the in-process HTTP MCP transport in
    // v0.1.36 we don't pipe the renderer buffer through to the main
    // process yet, so this still returns the hint payload. A future
    // change can wire `webContents.executeJavaScript()` to read the
    // ChatFeed state.
    return {
      messages: null,
      hint:
        'Recent-message buffer lives in the renderer and is not exposed ' +
        'to the MCP process. A future loopback IPC channel can surface ' +
        'this when implemented.',
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: list_connections
// ---------------------------------------------------------------------------

const listConnections: ToolDefinition = {
  name: 'list_connections',
  description:
    'List connected streaming platforms (Twitch, YouTube, etc.) per ' +
    "Restream's `connection_info` WS frame. Requires the running GUI — " +
    'live WS state is not persisted to disk.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const runtime = ctx.live?.getRuntimeStatus?.();
    if (runtime?.connections != null) {
      return { connections: runtime.connections };
    }
    return {
      connections: null,
      hint:
        'Live WS connection list is only available while the GUI is ' +
        'connected. The persisted platform-filter map is available via ' +
        '`list_settings` → `filter.platforms`.',
    };
  },
};

// ---------------------------------------------------------------------------
// Write tools — all hit `mutateSettings()` which round-trips through
// the JSON file atomically.
// ---------------------------------------------------------------------------

const setVoice: ToolDefinition = {
  name: 'set_voice',
  description:
    'Set the TTS voice by Web Speech API voiceURI. Pass the full URI ' +
    '(e.g. "com.apple.voice.compact.en-GB.Daniel"). Use `get_voices` ' +
    'to find the current selection.',
  inputSchema: {
    type: 'object',
    properties: { voiceURI: { type: 'string' } },
    required: ['voiceURI'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const voiceURI = requireString(args, 'voiceURI');
    return mutateSettingsVia(ctx, (s) => ({
      ...s,
      tts: { ...s.tts, voiceURI },
    }));
  },
};

const setTtsVolume: ToolDefinition = {
  name: 'set_tts_volume',
  description: 'Set TTS volume in [0, 1].',
  inputSchema: {
    type: 'object',
    properties: { volume: { type: 'number', minimum: 0, maximum: 1 } },
    required: ['volume'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const volume = requireRange(requireNumber(args, 'volume'), 0, 1, 'volume');
    return mutateSettingsVia(ctx, (s) => ({
      ...s,
      tts: { ...s.tts, volume },
    }));
  },
};

const setTtsRate: ToolDefinition = {
  name: 'set_tts_rate',
  description: 'Set TTS rate in [0.5, 2]. 1.0 = natural speed.',
  inputSchema: {
    type: 'object',
    properties: { rate: { type: 'number', minimum: 0.5, maximum: 2 } },
    required: ['rate'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const rate = requireRange(requireNumber(args, 'rate'), 0.5, 2, 'rate');
    return mutateSettingsVia(ctx, (s) => ({
      ...s,
      tts: { ...s.tts, rate },
    }));
  },
};

const setTtsPitch: ToolDefinition = {
  name: 'set_tts_pitch',
  description: 'Set TTS pitch in [0, 2]. 1.0 = natural pitch.',
  inputSchema: {
    type: 'object',
    properties: { pitch: { type: 'number', minimum: 0, maximum: 2 } },
    required: ['pitch'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const pitch = requireRange(requireNumber(args, 'pitch'), 0, 2, 'pitch');
    return mutateSettingsVia(ctx, (s) => ({
      ...s,
      tts: { ...s.tts, pitch },
    }));
  },
};

const setTtsEnabled: ToolDefinition = {
  name: 'set_tts_enabled',
  description: 'Enable / disable TTS read-aloud globally.',
  inputSchema: {
    type: 'object',
    properties: { enabled: { type: 'boolean' } },
    required: ['enabled'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const enabled = requireBoolean(args, 'enabled');
    return mutateSettingsVia(ctx, (s) => ({
      ...s,
      tts: { ...s.tts, enabled },
    }));
  },
};

const setNotificationsEnabled: ToolDefinition = {
  name: 'set_notifications_enabled',
  description: 'Enable / disable native desktop notifications for new messages.',
  inputSchema: {
    type: 'object',
    properties: { enabled: { type: 'boolean' } },
    required: ['enabled'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const enabled = requireBoolean(args, 'enabled');
    return mutateSettingsVia(ctx, (s) => ({
      ...s,
      notifications: { ...s.notifications, enabled },
    }));
  },
};

const setPlayNotificationSound: ToolDefinition = {
  name: 'set_play_notification_sound',
  description: 'Toggle whether notifications play a sound (silent vs audible).',
  inputSchema: {
    type: 'object',
    properties: { enabled: { type: 'boolean' } },
    required: ['enabled'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const enabled = requireBoolean(args, 'enabled');
    return mutateSettingsVia(ctx, (s) => ({
      ...s,
      notifications: { ...s.notifications, soundEnabled: enabled },
    }));
  },
};

// ---------------------------------------------------------------------------
// Filter regex tools — append / remove entries
// ---------------------------------------------------------------------------
//
// We accept the user's regex verbatim; the value is matched
// case-insensitively at runtime via `compileIgnorePatterns` in the
// renderer's `message-filters.ts`. Invalid patterns are rejected HERE so
// the agent gets clear feedback at call time, not a silent skip at the
// runtime compile step.

const addTtsFilter: ToolDefinition = {
  name: 'add_tts_filter',
  description:
    'Append a regex to the TTS ignore list. Matched against message ' +
    'text (case-insensitive). Throws if the regex is syntactically invalid.',
  inputSchema: {
    type: 'object',
    properties: { regex: { type: 'string' } },
    required: ['regex'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const regex = requireString(args, 'regex');
    validateRegex(regex);
    return mutateSettingsVia(ctx, (s) => {
      // Dedupe — pushing the same pattern repeatedly is a no-op rather
      // than producing a duplicate entry.
      const next = s.filters.tts.ignoreRegex.includes(regex)
        ? s.filters.tts.ignoreRegex
        : [...s.filters.tts.ignoreRegex, regex];
      return {
        ...s,
        filters: { ...s.filters, tts: { ...s.filters.tts, ignoreRegex: next } },
      };
    });
  },
};

const removeTtsFilter: ToolDefinition = {
  name: 'remove_tts_filter',
  description:
    'Remove a regex from the TTS ignore list by exact-match value. ' +
    'No-op if the pattern is not present.',
  inputSchema: {
    type: 'object',
    properties: { regex: { type: 'string' } },
    required: ['regex'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const regex = requireString(args, 'regex');
    return mutateSettingsVia(ctx, (s) => ({
      ...s,
      filters: {
        ...s.filters,
        tts: {
          ...s.filters.tts,
          ignoreRegex: s.filters.tts.ignoreRegex.filter((p) => p !== regex),
        },
      },
    }));
  },
};

const addNotificationFilter: ToolDefinition = {
  name: 'add_notification_filter',
  description:
    'Append a regex to the notifications ignore list. Same semantics as ' +
    '`add_tts_filter` but for the desktop-notification side effect.',
  inputSchema: {
    type: 'object',
    properties: { regex: { type: 'string' } },
    required: ['regex'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const regex = requireString(args, 'regex');
    validateRegex(regex);
    return mutateSettingsVia(ctx, (s) => {
      const next = s.filters.notifications.ignoreRegex.includes(regex)
        ? s.filters.notifications.ignoreRegex
        : [...s.filters.notifications.ignoreRegex, regex];
      return {
        ...s,
        filters: {
          ...s.filters,
          notifications: { ...s.filters.notifications, ignoreRegex: next },
        },
      };
    });
  },
};

const removeNotificationFilter: ToolDefinition = {
  name: 'remove_notification_filter',
  description:
    'Remove a regex from the notifications ignore list. Exact-match value.',
  inputSchema: {
    type: 'object',
    properties: { regex: { type: 'string' } },
    required: ['regex'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const regex = requireString(args, 'regex');
    return mutateSettingsVia(ctx, (s) => ({
      ...s,
      filters: {
        ...s.filters,
        notifications: {
          ...s.filters.notifications,
          ignoreRegex: s.filters.notifications.ignoreRegex.filter(
            (p) => p !== regex,
          ),
        },
      },
    }));
  },
};

const setAutoUpdateCheck: ToolDefinition = {
  name: 'set_auto_update_check',
  description:
    'Enable / disable the periodic GH-Releases-API update poller. The ' +
    'menu "Check for Updates Now…" item ignores this flag and always runs.',
  inputSchema: {
    type: 'object',
    properties: { enabled: { type: 'boolean' } },
    required: ['enabled'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const enabled = requireBoolean(args, 'enabled');
    return mutateSettingsVia(ctx, (s) => ({
      ...s,
      update: { ...s.update, autoCheck: enabled },
    }));
  },
};

// ---------------------------------------------------------------------------
// Runtime-only commands that need a live GUI — we expose them but they
// return a `{ guiNotIntrospectable: true }` payload until a loopback IPC
// channel ships. Keeping them in the tool list lets agents discover the
// API surface; the hint string tells them why their call was a no-op.
// ---------------------------------------------------------------------------

const clearChat: ToolDefinition = {
  name: 'clear_chat',
  description:
    'Clear the local message buffer (the chat feed in the running GUI). ' +
    'When the in-process HTTP MCP is the host (v0.1.36+), this triggers ' +
    'the same Cmd+K path the menu item uses. Outside the running app, ' +
    'returns a clear hint payload.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    if (ctx.live?.clearChat) {
      ctx.live.clearChat();
      return { ok: true };
    }
    return {
      ok: false,
      guiNotIntrospectable: true,
      hint:
        'Cmd+K in the running GUI or the chat-feed context menu clears the ' +
        'buffer. The standalone MCP cannot trigger this without a loopback ' +
        'IPC channel.',
    };
  },
};

const checkForUpdatesNow: ToolDefinition = {
  name: 'check_for_updates_now',
  description:
    'Force an immediate GH-Releases update check, bypassing the autoCheck ' +
    'setting. With the in-process HTTP MCP (v0.1.36+) this returns the ' +
    'resulting UpdateInfo directly; without it, returns a clear hint.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    if (ctx.live?.checkForUpdatesNow) {
      const info = await ctx.live.checkForUpdatesNow();
      return { ok: true, updateInfo: info };
    }
    return {
      ok: false,
      guiNotIntrospectable: true,
      hint:
        'Use the "Check for Updates Now…" menu item in the running GUI. ' +
        'The standalone MCP cannot trigger this without a loopback IPC ' +
        'channel.',
    };
  },
};

const signOut: ToolDefinition = {
  name: 'sign_out',
  description:
    "Sign out of Restream (clears the persisted OAuth token). Bypasses " +
    "the GUI's confirmation prompt because the agent is calling it " +
    'deliberately. Operates on disk directly — works whether or not the ' +
    'GUI is running. WARNING: irreversible; the user will need to ' +
    're-authenticate next launch.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    // In-process MCP (v0.1.36+) — route through the live OAuth
    // coordinator so the in-memory token + WS chat client + renderer
    // auth state all clear in lockstep. No restart needed.
    if (ctx.live?.signOut) {
      await ctx.live.signOut();
      return { ok: true, viaLiveBridge: true };
    }
    // Fallback (legacy --mcp-stdio / vitest): delete both the legacy
    // `token` and the v0.1.15+ `tokenEnc` keys so a partial-cleanup-
    // then-relaunch can't accidentally resume on a half-stale token.
    // `settings` and everything else passes through.
    let raw: string;
    try {
      raw = fs.readFileSync(ctx.storePath, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === 'ENOENT') {
        return { ok: true, alreadySignedOut: true };
      }
      throw err;
    }
    const parsed = JSON.parse(raw);
    delete parsed.token;
    delete parsed.tokenEnc;
    // Write back via the same atomic-rename routine as other mutations.
    writeStoreFile(ctx.storePath, parsed);
    return {
      ok: true,
      guiNotifyHint:
        'If the GUI is running, you may need to restart it for the sign-out ' +
        'to take effect — the OAuthCoordinator caches the token in memory.',
    };
  },
};

// ---------------------------------------------------------------------------
// v0.1.64 — update orchestration tools.
// ---------------------------------------------------------------------------
//
// Ethan voice 3869 (2026-05-23): "There should be MCP to update it. You
// should be able to update it over MCP properly and see it through."
//
// These four tools form a complete end-to-end update flow that an agent
// can drive without touching the UI:
//
//   1. `update_check_now`        → force a GH-Releases poll; returns
//                                  the resulting UpdateInfo so the agent
//                                  knows if there's a newer version
//                                  (kind === 'available') or not
//                                  (kind === 'up-to-date').
//   2. `update_download_status`  → coarse-grained download-state machine
//                                  (idle / checking / downloading /
//                                  ready-to-install / error) + version +
//                                  elapsed time + last error if any.
//                                  Poll this while a download is in
//                                  flight.
//   3. `update_install_now`      → install + relaunch when the state
//                                  reaches 'ready-to-install'. Refuses
//                                  if no bundle is staged. SAFETY: this
//                                  WILL close the app and restart — any
//                                  unsaved renderer state is lost.
//   4. `update_logs_tail`        → return the last N lines of main.log
//                                  filtered to updater events so the
//                                  agent can investigate a stuck or
//                                  failed download without leaving the
//                                  MCP surface.
//
// All four are HTTP-MCP-only — they REQUIRE the in-process bridge
// (`ctx.live`). The legacy `--mcp-stdio` path returns the standard
// `guiNotIntrospectable` hint because file-only access can't reach the
// running autoUpdater. v0.1.36+ ships with the HTTP MCP enabled by
// default so this is not a regression for any deployed user.

const updateCheckNowV2: ToolDefinition = {
  name: 'update_check_now',
  description:
    'v0.1.64 — Force an immediate GitHub-Releases update check, bypassing ' +
    'the autoCheck setting. Returns the full UpdateInfo payload (kind, ' +
    'currentVersion, latestVersion, releaseUrl, error if any) so the agent ' +
    'can decide whether to proceed to download. Companion to ' +
    '`update_download_status`, `update_install_now`, and `update_logs_tail`. ' +
    'This is the v0.1.64 replacement for `check_for_updates_now`; the older ' +
    'tool stays for backwards compatibility but new agents should call this one.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    // The v0.1.64 tool surface deliberately mirrors the v0.1.36 one for
    // backwards compatibility; we just route through the live bridge if
    // available so the response shape matches the renderer's UpdateInfo.
    if (ctx.live?.checkForUpdatesNow) {
      const info = await ctx.live.checkForUpdatesNow();
      const last = ctx.live.getLastUpdateInfo?.();
      // Surface BOTH the fresh check result AND the last cached result.
      // In practice they should be identical (the GH poller broadcasts on
      // every check) but exposing them separately helps the agent debug
      // a "I forced a check but state didn't change" scenario.
      return { ok: true, updateInfo: info, lastBroadcast: last };
    }
    return {
      ok: false,
      guiNotIntrospectable: true,
      hint:
        'update_check_now requires the in-process HTTP MCP transport ' +
        '(v0.1.36+). The legacy --mcp-stdio path cannot reach the running ' +
        "autoUpdater. Open the Restream Chat++ GUI and try again.",
    };
  },
};

const updateDownloadStatus: ToolDefinition = {
  name: 'update_download_status',
  description:
    "v0.1.64 — Return the current Squirrel auto-update download state " +
    'machine. States: idle, checking, downloading, ready-to-install, error. ' +
    'Includes pendingVersion (the tag being downloaded), downloadStartedAt ' +
    '(epoch ms), elapsedSeconds (derived), lastErrorMessage, and ' +
    'lastErrorCategory (signature-mismatch / network / staging / unknown). ' +
    "Poll this in a loop while you've kicked a download via " +
    '`update_check_now` until state==="ready-to-install", then call ' +
    '`update_install_now`. Stable shape — safe for agent state machines.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    if (!ctx.live?.getUpdateDownloadState) {
      return {
        ok: false,
        guiNotIntrospectable: true,
        hint:
          'update_download_status requires the in-process HTTP MCP transport ' +
          '(v0.1.36+). Open the Restream Chat++ GUI and try again.',
      };
    }
    const snap = ctx.live.getUpdateDownloadState();
    // Derive elapsed time on the server side so the agent doesn't have to
    // compute it (and so a network round-trip delay between snapshot capture
    // and agent receipt doesn't skew its calculation).
    const elapsedSeconds =
      typeof snap.downloadStartedAt === 'number'
        ? Math.max(0, Math.floor((Date.now() - snap.downloadStartedAt) / 1000))
        : null;
    // Also surface the LAST UpdateInfo broadcast (kind / latestVersion /
    // download bytes / etc.) so a single MCP call gives the agent every
    // piece of state it might need without a follow-up call. The
    // UpdateInfo payload is the same shape the renderer sees; we route
    // through `getLastUpdateInfo` so we don't fabricate fields.
    const lastInfo = ctx.live.getLastUpdateInfo?.() ?? null;
    return {
      ok: true,
      state: snap.state,
      pendingVersion: snap.pendingVersion ?? null,
      downloadStartedAt: snap.downloadStartedAt ?? null,
      elapsedSeconds,
      lastErrorMessage: snap.lastErrorMessage ?? null,
      lastErrorCategory: snap.lastErrorCategory ?? null,
      lastUpdateInfo: lastInfo,
    };
  },
};

const updateInstallNow: ToolDefinition = {
  name: 'update_install_now',
  description:
    "v0.1.64 — Trigger the staged update install + relaunch. Equivalent to " +
    "clicking the renderer 'Restart to install' button. SAFETY: this WILL " +
    'close the app and restart — any unsaved renderer state is lost. ' +
    "Refuses with reason='no-update-downloaded' if no bundle is staged; " +
    'always call `update_download_status` first and verify ' +
    'state==="ready-to-install" before invoking this. ' +
    'Voice 3869 (2026-05-23) authorised the agent to drive update flow ' +
    'end-to-end.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    if (!ctx.live?.triggerInstallNow) {
      return {
        ok: false,
        guiNotIntrospectable: true,
        hint:
          'update_install_now requires the in-process HTTP MCP transport ' +
          '(v0.1.36+). Open the Restream Chat++ GUI and try again.',
      };
    }
    // `triggerInstallNow` schedules `autoUpdater.quitAndInstall()` on the
    // next tick so the JSON-RPC response can land BEFORE the app starts
    // tearing down (we copied this from the renderer Restart flow, which
    // had the same race in v0.1.40). The shape matches
    // `quitAndInstallStagedUpdate`.
    const result = ctx.live.triggerInstallNow();
    return result;
  },
};

const updateLogsTail: ToolDefinition = {
  name: 'update_logs_tail',
  description:
    'v0.1.64 — Return the last N lines of main.log filtered to updater ' +
    "events ([updater], [updater-gh], Squirrel, download-progress, " +
    'update-downloaded, signature, error). Lets an agent investigate why ' +
    'a download stalled or failed without leaving the MCP surface. ' +
    "Default `lines`=200, max=2000. Returns the matched lines as a single " +
    'string (newline-joined) plus the absolute path of the log file so the ' +
    "agent can reveal it manually if needed. macOS: ~/Library/Logs/" +
    'Restream Chat++/main.log',
  inputSchema: {
    type: 'object',
    properties: {
      lines: {
        type: 'number',
        description: 'Number of trailing lines to return after filtering (default 200, max 2000).',
        minimum: 1,
        maximum: 2000,
      },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    // Resolve the log file path. electron-log defaults to
    // `${app.getPath('logs')}/main.log` — same as `safe.tail` in the Reveal
    // Logs menu item. We use the live-bridge accessor if available, falling
    // back to a best-effort guess so the test path (no Electron) still
    // returns a useful answer.
    const lines = typeof args.lines === 'number' ? Math.floor(args.lines) : 200;
    const max = Math.max(1, Math.min(lines, 2000));
    const candidates = resolveLogPathCandidates();
    let resolvedPath: string | null = null;
    let raw = '';
    for (const c of candidates) {
      try {
        raw = fs.readFileSync(c, 'utf8');
        resolvedPath = c;
        break;
      } catch {
        // Try the next candidate.
      }
    }
    if (resolvedPath === null) {
      return {
        ok: false,
        hint:
          'main.log not found at any of the standard electron-log paths. ' +
          'On macOS the file should be at ~/Library/Logs/Restream Chat++/main.log. ' +
          'Has the app ever been run? Try opening Restream Chat++ once.',
        triedPaths: candidates,
      };
    }
    // Filter to updater-relevant lines. We use a coarse OR over the names
    // updater.ts + github-update-check.ts + Squirrel emit. This is the same
    // pattern Ethan used manually when grepping the log (see the diagnosis
    // session 2026-05-23).
    const allLines = raw.split('\n');
    const filterRe =
      /\[updater\]|\[updater-gh\]|update-downloaded|update-not-available|update-available|download-progress|download-started|download stalled|Squirrel|ShipIt|code signature|quitAndInstall|checkForUpdates|autoUpdater/i;
    const matched: string[] = [];
    for (const ln of allLines) {
      if (filterRe.test(ln)) matched.push(ln);
    }
    const tail = matched.slice(-max);
    return {
      ok: true,
      logPath: resolvedPath,
      lineCount: tail.length,
      totalLogLines: allLines.length,
      totalMatchedLines: matched.length,
      lines: tail.join('\n'),
    };
  },
};

/**
 * v0.1.64 helper for `update_logs_tail` — return an ordered list of likely
 * main.log paths. We can't `import { app } from 'electron'` at module top
 * (Vitest under plain Node has no electron module), so we resolve lazily
 * and tolerate misses.
 */
function resolveLogPathCandidates(): string[] {
  const candidates: string[] = [];
  // 1. Electron's `app.getPath('logs')` — the canonical path, available
  //    when running inside the packaged Electron process.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as {
      app?: { getPath?: (key: string) => string };
    };
    const dir = electron?.app?.getPath?.('logs');
    if (typeof dir === 'string' && dir.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const path = require('node:path') as typeof import('node:path');
      candidates.push(path.join(dir, 'main.log'));
    }
  } catch {
    // not running under electron — fall through to platform defaults.
  }
  // 2. Platform-specific fallbacks. Mirrors electron-log defaults so
  //    the tool still works under unit tests.
  if (process.platform === 'darwin') {
    const home = process.env.HOME ?? '';
    if (home) {
      // Use the productName from package.json — `Restream Chat++` (the
      // npm name is `restream-chat-plus-plus`; productName is what
      // electron-log uses for the directory).
      candidates.push(`${home}/Library/Logs/Restream Chat++/main.log`);
      candidates.push(`${home}/Library/Logs/Restream Chat Plus Plus/main.log`);
    }
  } else if (process.platform === 'linux') {
    const home = process.env.HOME ?? '';
    if (home) {
      candidates.push(`${home}/.config/Restream Chat++/logs/main.log`);
    }
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? '';
    if (appData) {
      candidates.push(`${appData}\\Restream Chat++\\logs\\main.log`);
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Tool registry — single source of truth used by the dispatcher.
// ---------------------------------------------------------------------------

export const TOOLS: ToolDefinition[] = [
  listSettings,
  getFilters,
  getStatus,
  getVoices,
  listRecentMessages,
  listConnections,
  setVoice,
  setTtsVolume,
  setTtsRate,
  setTtsPitch,
  setTtsEnabled,
  setNotificationsEnabled,
  setPlayNotificationSound,
  addTtsFilter,
  removeTtsFilter,
  addNotificationFilter,
  removeNotificationFilter,
  setAutoUpdateCheck,
  clearChat,
  checkForUpdatesNow,
  signOut,
  // v0.1.64 update-orchestration tools. Listed AFTER the legacy
  // `checkForUpdatesNow` to keep the order stable for snapshot tests.
  updateCheckNowV2,
  updateDownloadStatus,
  updateInstallNow,
  updateLogsTail,
];

/**
 * Map of tool name → definition for O(1) dispatch.
 */
export const TOOLS_BY_NAME: Map<string, ToolDefinition> = new Map(
  TOOLS.map((t) => [t.name, t]),
);

/**
 * Re-export `DEFAULT_SETTINGS` for the smoke-test path so an external
 * agent can confirm the binary loaded the same schema build.
 */
export { DEFAULT_SETTINGS };
export type { Settings };
