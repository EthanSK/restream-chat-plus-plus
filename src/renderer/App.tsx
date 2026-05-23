import React, { useEffect, useMemo, useRef, useState } from 'react';
import { rcpp } from './api';
import {
  AuthStatus,
  ChatConnection,
  ChatMessage,
  ConnectionState,
  DEFAULT_SETTINGS,
  Platform,
  Settings,
  UpdateInfo,
} from '../shared/types';
import { ChannelsPanel } from './ChannelsPanel';
import { ChatFeed } from './ChatFeed';
import { ChatInputInline } from './ChatInputInline';
import {
  dispatchEnqueueChatSend,
  mintChatClientId,
} from './chat-send-client';
import { SettingsDrawer } from './SettingsDrawer';
import { UpdateBanner } from './UpdateBanner';
import { makeTtsEngine, RateLimiter, type TtsEngineLike } from './tts';
import { shouldProceedWithSignOut } from './auth-guards';
import { clearChatMessages } from './chat-actions';
import {
  applyMessageFilters,
  compileIgnorePatterns,
} from './message-filters';
import {
  applyFailedSendStatus,
  dedupeOptimisticOnEcho,
  pushOptimisticMessage,
  shouldTriggerSideEffects,
} from './chat-message-reducers';

const MAX_MESSAGES = 1000;

export function App(): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [auth, setAuth] = useState<AuthStatus>({ authenticated: false });
  const [conn, setConn] = useState<ConnectionState>({ status: 'idle', attempt: 0 });
  const [connections, setConnections] = useState<ChatConnection[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  // Banner-dismiss is session-only by design (see UpdateBanner.tsx docstring) —
  // we want a soft nag, not a sticky one. The next launch re-checks and
  // re-shows the banner if the user hasn't actually installed the new build.
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const ttsRef = useRef<TtsEngineLike | undefined>(undefined);
  const notifyLimiterRef = useRef<RateLimiter>(new RateLimiter(DEFAULT_SETTINGS.notifications.maxPerMinute));
  // v0.1.60 — id of the message we most recently triggered side effects
  // for (TTS speak + native notify). Used by the side-effect useEffect
  // below to skip both (a) optimistic-placeholder inserts that haven't
  // been confirmed by the server yet, and (b) re-fires whose last
  // element didn't actually change identity (e.g. a dedupe-replace
  // mid-array). See `shouldTriggerSideEffects` for the full reasoning.
  const lastSpokenIdRef = useRef<string | undefined>(undefined);

  // v0.1.26 — compile the user's regex-ignore lists ONCE per Settings change
  // and stash both in refs so the mount-only `onChatMessage` subscription
  // can read the freshest lists without being torn down on every tweak.
  const ttsIgnoreCompiled = useMemo(
    () => compileIgnorePatterns(settings.filters?.tts?.ignoreRegex ?? []),
    [settings.filters?.tts?.ignoreRegex],
  );
  const notifIgnoreCompiled = useMemo(
    () => compileIgnorePatterns(settings.filters?.notifications?.ignoreRegex ?? []),
    [settings.filters?.notifications?.ignoreRegex],
  );
  const ttsIgnoreRef = useRef<RegExp[]>(ttsIgnoreCompiled);
  const notifIgnoreRef = useRef<RegExp[]>(notifIgnoreCompiled);
  useEffect(() => {
    ttsIgnoreRef.current = ttsIgnoreCompiled;
  }, [ttsIgnoreCompiled]);
  useEffect(() => {
    notifIgnoreRef.current = notifIgnoreCompiled;
  }, [notifIgnoreCompiled]);

  // Init: load auth + settings + current connection state, subscribe to events.
  useEffect(() => {
    let alive = true;
    (async () => {
      const a = await rcpp.authStatus();
      if (!alive) return;
      setAuth(a);
      const s = await rcpp.getSettings();
      if (!alive) return;
      setSettings(s);
      // v0.1.42 — engine kind comes from settings (native | browser).
      // `makeTtsEngine` picks the right implementation; the renderer
      // talks to the polymorphic `TtsEngineLike` surface from here on.
      ttsRef.current = makeTtsEngine(s.tts);
      notifyLimiterRef.current = new RateLimiter(s.notifications.maxPerMinute);
      // Pull-fetch the current connection state. The push channel
      // (onConnectionState) only delivers UPDATES — if the main process
      // already transitioned the WS to 'connecting' / 'connected' BEFORE we
      // attached our listener (common on the auth-resume code path where
      // chat.start() runs synchronously inside app.on('ready')), the
      // renderer would otherwise stay stuck on its initial 'idle'
      // placeholder while the feed body shows 'Listening for chat…'.
      // This is the fix for the status-dot-says-idle / feed-says-listening
      // mismatch (bug #1).
      try {
        const initialConn = await rcpp.connectionState();
        if (!alive) return;
        setConn(initialConn);
      } catch (err) {
        console.error('[App] failed to fetch initial conn state', err);
      }
      // Pull-fetch the connections list on mount for the same reason as
      // connectionState above — the connection_info push channel only
      // delivers UPDATES, so if Restream replayed its current set BEFORE
      // we attached `onConnections`, the channels panel would stay empty.
      try {
        const initialConnections = await rcpp.getConnections();
        if (!alive) return;
        setConnections(initialConnections);
      } catch (err) {
        console.error('[App] failed to fetch initial connections', err);
      }
      // Pull-fetch the most recent UpdateInfo on mount. The GH poller's
      // first check fires ~3s after `app.ready`, so a renderer that mounts
      // before that won't have anything to fetch yet — the subsequent push
      // (onUpdateStatus) covers the case. Renderers that mount AFTER the
      // check completed get the banner immediately via this pull.
      try {
        const u = await rcpp.getUpdateStatus();
        if (!alive) return;
        if (u) setUpdateInfo(u);
      } catch (err) {
        console.error('[App] failed to fetch initial update status', err);
      }
    })();

    const offAuth = rcpp.onAuthStatus(setAuth);
    const offConn = rcpp.onConnectionState(setConn);
    const offConnections = rcpp.onConnections(setConnections);
    const offChat = rcpp.onChatMessage((m) => {
      // v0.1.26: apply regex-ignore filters BEFORE pushing to state so
      // the resulting ChatMessage carries `ignoredByTts` /
      // `ignoredByNotifications`. The forward-to-side-effects useEffect
      // below reads those flags to skip TTS / notifications, and
      // ChatFeed renders the "regex-ignored" badge from the same flags.
      const flags = applyMessageFilters(
        m.text,
        ttsIgnoreRef.current,
        notifIgnoreRef.current,
      );
      const flagged: ChatMessage =
        flags.ignoredByTts || flags.ignoredByNotifications
          ? { ...m, ...flags }
          : m;
      // v0.1.43: dedupe against any locally-minted optimistic placeholder
      // (the WS rebroadcasts the streamer's own outgoing reply as a
      // `reply_created` echo, normalised with `id === clientReplyUuid`).
      // If we already have a placeholder with this id, REPLACE it with
      // the echo so the feed shows the user's message exactly once.
      setMessages((prev) => dedupeOptimisticOnEcho(prev, flagged, MAX_MESSAGES));
    });
    // v0.1.43 — listen for queue lifecycle updates and flip the matching
    // optimistic placeholder. `pending` is a no-op (the placeholder is
    // already in the feed from the click handler). `sent` doesn't touch
    // state either — the WS echo replaces the placeholder via the
    // dedupe path above. `failed` keeps the placeholder visible with a
    // small ⚠ + tooltip carrying the error.
    const offSendStatus = rcpp.onChatSendStatus((status) => {
      if (status.status !== 'failed') return;
      setMessages((prev) => applyFailedSendStatus(prev, status));
    });
    const offMenu = rcpp.onMenuOpenSettings(() => setDrawerOpen(true));
    // "Clear chat" can be triggered from either the chat-feed right-click
    // context menu or the application menu's Chat → Clear Chat (Cmd+K).
    // Both flow through the same main → renderer broadcast so we only need
    // one renderer-side listener that resets the buffer via the pure
    // `clearChatMessages` reducer. v0.1.18.
    const offClear = rcpp.onChatClear(() => {
      setMessages((prev) => clearChatMessages(prev));
    });
    // Live update-check broadcasts — fires when the GH poller completes a
    // check (hourly + once at startup), on every explicit "Check Now",
    // AND on Squirrel `download-progress` / `update-downloaded` events
    // (v0.1.25). Reset the per-session dismiss flag in two cases:
    //
    //   1. New `available` tag — if the user dismissed v0.1.24 and we now
    //      see v0.1.25 is out, they almost certainly want to know.
    //   2. Transition to `downloading` / `ready-to-install` — even if the
    //      user dismissed the earlier `available` banner, once Squirrel
    //      has started downloading we want the progress + Restart UI to
    //      surface.
    // Live Settings push from the in-process HTTP MCP server (v0.1.36+).
    // Fires when an MCP client (Claude Code, etc.) mutates Settings via
    // tools like `set_voice` / `set_tts_volume`. We replace local
    // settings state + re-init the TTS engine + rate limiter so the
    // changes take effect immediately — no restart required.
    const offSettingsPush = rcpp.onSettingsPush((next) => {
      setSettings((prev) => {
        // v0.1.42 — if the engine kind changed (native ↔ browser), tear
        // down the old engine and construct a fresh one. The factory in
        // `makeTtsEngine` picks the right backing implementation; both
        // satisfy `TtsEngineLike` so App.tsx never needs to know which
        // is in use beyond this swap site.
        const engineChanged = prev?.tts?.engine !== next.tts.engine;
        if (engineChanged) {
          try {
            ttsRef.current?.cancel();
          } catch (err) {
            console.error('[App] TTSEngine.cancel on engine swap failed', err);
          }
          ttsRef.current = makeTtsEngine(next.tts);
        } else {
          try {
            ttsRef.current?.updateSettings(next.tts);
          } catch (err) {
            console.error('[App] TTSEngine.updateSettings on push failed', err);
          }
        }
        return next;
      });
      try {
        notifyLimiterRef.current = new RateLimiter(next.notifications.maxPerMinute);
      } catch (err) {
        console.error('[App] rate limiter re-init on push failed', err);
      }
    });
    const offUpdate = rcpp.onUpdateStatus((info) => {
      setUpdateInfo((prev) => {
        const newAvailable =
          info.kind === 'available' &&
          prev?.latestVersion &&
          info.latestVersion &&
          info.latestVersion !== prev.latestVersion;
        const stateProgressed =
          info.kind === 'downloading' || info.kind === 'ready-to-install';
        // v0.1.61 — also reset on Squirrel-side errors that carry an
        // `errorReleaseUrl` (the only kind the banner actually shows for
        // `error`). Without this, a user who dismissed the `available`
        // banner and then clicked Install Update via the menu would
        // never see the resulting failure surface in the UI.
        const erroredVisibly =
          info.kind === 'error' &&
          typeof (info as { errorReleaseUrl?: string }).errorReleaseUrl ===
            'string';
        if (newAvailable || stateProgressed || erroredVisibly) {
          setUpdateDismissed(false);
        }
        return info;
      });
    });
    return () => {
      alive = false;
      offAuth();
      offConn();
      offConnections();
      offChat();
      offSendStatus();
      offMenu();
      offClear();
      offSettingsPush();
      offUpdate();
    };
  }, []);

  // v0.1.43 — non-blocking send. Mint the optimistic placeholder, push
  // it into the feed synchronously, fire the enqueue IPC. The renderer
  // NEVER awaits the result so the user can spam-send. The placeholder's
  // `id` is the same uuid we ship to Restream as `clientReplyUuid`; the
  // eventual WS echo arrives with that same id and the `onChatMessage`
  // listener above replaces the placeholder in place.
  const handleInlineSend = (text: string): void => {
    const clientId = mintChatClientId();
    const optimistic: ChatMessage = {
      id: clientId,
      platform: 'unknown',
      username: 'You',
      text,
      ts: Date.now(),
      self: true,
      pendingSend: 'sending',
    };
    setMessages((prev) => pushOptimisticMessage(prev, optimistic, MAX_MESSAGES));
    dispatchEnqueueChatSend(text, clientId);
  };

  // Forward each new message to TTS + native notifications, honouring the
  // platform filter and the v0.1.26 regex-ignore lists.
  //
  // v0.1.26 product direction: ALL messages are read aloud / notified by
  // default, including the user's own `self: true` reply_created echoes.
  // v0.1.10's self-exclusion is deliberately removed. Users who want to
  // silence their own outgoing messages add a regex to the corresponding
  // `Settings.filters.*.ignoreRegex` list — the per-message `ignoredByTts`
  // / `ignoredByNotifications` flags set at insertion time tell us to
  // skip the side effect AND render the badge.
  useEffect(() => {
    if (messages.length === 0) return;
    const m = messages[messages.length - 1];
    // v0.1.60 — gate side effects (TTS + notification) to fire exactly
    // once per logically-sent message. The optimistic-send flow inserts
    // a `pendingSend: 'sending'` placeholder on Enter, then REPLACES it
    // in place when the WS echo arrives. Both transitions change the
    // `messages` array reference, so without this gate the send-sound
    // would play twice (once on Enter, once on echo). Voice 2026-05-23:
    // "I hear double messages sent. One when I click enter, one when
    // it's sent. It should just be the one when it's sent now."
    if (!shouldTriggerSideEffects(m, lastSpokenIdRef.current)) return;
    if (!settings.filter.platforms[m.platform]) return;

    lastSpokenIdRef.current = m.id;
    if (settings.tts.enabled && !m.ignoredByTts) {
      ttsRef.current?.enqueue(m);
    }
    if (settings.notifications.enabled && !m.ignoredByNotifications) {
      if (notifyLimiterRef.current.tryConsume()) {
        rcpp.notify(`${m.username} (${m.platform})`, m.text);
      }
    }
    // We only react to the freshest message; intentionally omitting `settings` from deps when it changes mid-batch is fine because the engine + limiter pick up updates via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const visibleMessages = useMemo(
    () => messages.filter((m) => settings.filter.platforms[m.platform] !== false),
    [messages, settings.filter.platforms],
  );

  const updateSettings = async (next: Settings) => {
    // v0.1.42: detect engine-kind change BEFORE setState so we can swap
    // the engine instance synchronously rather than racing the next
    // render. Avoids a brief window where the new engine setting is in
    // state but the old engine is still attached.
    const engineChanged = settings.tts.engine !== next.tts.engine;
    setSettings(next);
    if (engineChanged) {
      try {
        ttsRef.current?.cancel();
      } catch (err) {
        console.error('[App] TTSEngine.cancel on engine swap failed', err);
      }
      ttsRef.current = makeTtsEngine(next.tts);
    } else {
      ttsRef.current?.updateSettings(next.tts);
    }
    notifyLimiterRef.current = new RateLimiter(next.notifications.maxPerMinute);
    await rcpp.setSettings(next);
  };

  const onSignIn = async () => {
    try {
      const s = await rcpp.authStart();
      setAuth(s);
    } catch (e) {
      // The main process will surface the error in the next CONN_STATE update;
      // we just keep the UI responsive.
      console.error(e);
    }
  };

  const onSignOut = async () => {
    // Sign-out is destructive — it clears the OAuth token and forces a full
    // re-auth round-trip on next launch. Ethan accidentally clicked the
    // button once and lost the session; guard with a confirm dialog so a
    // mis-click is recoverable. Tests cover the cancel-path-does-not-clear
    // behaviour via the `shouldProceedWithSignOut` helper below.
    //
    // v0.1.52: route the confirm through native `dialog.showMessageBox`
    // in the main process via AUTH_CONFIRM_LOGOUT IPC — `window.confirm`
    // in our Electron BrowserWindow was returning `false` without ever
    // rendering a dialog, so the previous implementation made the Sign
    // Out button silently no-op. Ethan voice 3719.
    const proceed = await shouldProceedWithSignOut(rcpp.authConfirmLogout);
    if (!proceed) return;
    const s = await rcpp.authLogout();
    setAuth(s);
    setMessages([]);
  };

  const onReconnect = async () => {
    if (reconnecting) return;
    setReconnecting(true);
    try {
      await rcpp.reconnect();
    } catch (err) {
      console.error('[App] reconnect failed', err);
    } finally {
      // Drop the spinner shortly after — the actual state will be reflected
      // by the status dot via the CONN_STATE stream. Keep a small floor so
      // the icon doesn't flash.
      setTimeout(() => setReconnecting(false), 400);
    }
  };

  return (
    <div className="app">
      <div className="titlebar">Restream Chat++</div>
      <UpdateBanner
        info={updateInfo}
        dismissed={updateDismissed}
        onDismiss={() => setUpdateDismissed(true)}
        // v0.1.32: in-app download via Squirrel `checkForUpdates()`.
        // No more `rcpp.openExternal(releaseUrl)` browser bounce.
        // v0.1.39: returns the StartDownloadResult so the banner can
        // surface a toast describing the outcome of the click.
        onStartDownload={() => rcpp.startUpdateDownload()}
        onRestart={() => void rcpp.quitAndInstall()}
      />
      <div className="toolbar">
        <span className={`status-dot ${conn.status}`} />
        <span className="status-label">{statusLabel(conn, auth)}</span>
        {auth.authenticated && (
          <button
            className={`btn icon ghost reconnect-btn${reconnecting ? ' spinning' : ''}`}
            title="Reconnect"
            aria-label="Reconnect"
            disabled={reconnecting}
            onClick={() => void onReconnect()}
          >
            {/* Inline SVG so we avoid an icon-font dependency. */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
        )}
        {auth.authenticated && <ChannelsPanel connections={connections} />}
        <span className="spacer" />
        <button
          className="btn ghost"
          title="Reveal raw-frames.jsonl in Finder for debugging"
          onClick={() => void rcpp.revealLogs()}
        >
          Logs
        </button>
        {auth.authenticated ? (
          <>
            <button className="btn ghost" onClick={() => setDrawerOpen(true)}>
              Settings
            </button>
            <button className="btn" onClick={onSignOut}>
              Sign out
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={onSignIn}>
            Sign in to Restream
          </button>
        )}
      </div>
      <ChatFeed
        messages={visibleMessages}
        authenticated={auth.authenticated}
        connection={conn}
      />
      <ChatInputInline
        authenticated={auth.authenticated}
        connected={conn.status === 'connected'}
        onSend={handleInlineSend}
      />
      {drawerOpen && (
        <SettingsDrawer
          settings={settings}
          onChange={updateSettings}
          onClose={() => setDrawerOpen(false)}
          voices={ttsRef.current?.voices() ?? []}
          onPreviewVoice={(uri) => ttsRef.current?.previewVoice(uri)}
          // v0.1.42 — native engine has its own voice fetch over IPC.
          // We feed the function down regardless of engine kind; the
          // drawer only calls it when `settings.tts.engine === 'native'`.
          getNativeVoices={() =>
            rcpp.ttsNative?.getVoices?.() ?? Promise.resolve([])
          }
        />
      )}
    </div>
  );
}

function statusLabel(conn: ConnectionState, auth: AuthStatus): string {
  if (!auth.authenticated) return 'Not signed in';
  switch (conn.status) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return `Reconnecting (attempt ${conn.attempt})`;
    case 'error':
      return `Error: ${conn.lastError ?? 'unknown'}`;
    case 'disconnected':
      return 'Disconnected';
    default:
      return 'Idle';
  }
}

// Re-export Platform so JSX consumers can use it without an extra import chain.
export type { Platform };
