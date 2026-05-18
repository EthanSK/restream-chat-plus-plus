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
