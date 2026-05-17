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
import { SettingsDrawer } from './SettingsDrawer';
import { UpdateBanner } from './UpdateBanner';
import { TTSEngine, RateLimiter } from './tts';
import { shouldProceedWithSignOut } from './auth-guards';
import { clearChatMessages } from './chat-actions';

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
  const ttsRef = useRef<TTSEngine | undefined>(undefined);
  const notifyLimiterRef = useRef<RateLimiter>(new RateLimiter(DEFAULT_SETTINGS.notifications.maxPerMinute));

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
      ttsRef.current = new TTSEngine(s.tts);
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
      setMessages((prev) => {
        const next = [...prev, m];
        if (next.length > MAX_MESSAGES) next.splice(0, next.length - MAX_MESSAGES);
        return next;
      });
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
    // check (hourly + once at startup) AND on every explicit "Check Now".
    // Reset the per-session dismiss flag whenever the LATEST tag advances:
    // if the user dismissed v0.1.24 and we now see v0.1.25 is out, the
    // user almost certainly wants to know.
    const offUpdate = rcpp.onUpdateStatus((info) => {
      setUpdateInfo((prev) => {
        if (
          info.kind === 'available' &&
          prev?.latestVersion &&
          info.latestVersion &&
          info.latestVersion !== prev.latestVersion
        ) {
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
      offMenu();
      offClear();
      offUpdate();
    };
  }, []);

  // Forward each new message to TTS + native notifications, honoring filters.
  // Self-originated messages (reply_created echoes of Ethan's own outgoing
  // replies) are skipped — TTS-reading your own message back at you and
  // popping a native notification for it is just annoying.
  useEffect(() => {
    if (messages.length === 0) return;
    const m = messages[messages.length - 1];
    if (m.self) return;
    if (!settings.filter.platforms[m.platform]) return;

    if (settings.tts.enabled) {
      ttsRef.current?.enqueue(m);
    }
    if (settings.notifications.enabled) {
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
    setSettings(next);
    ttsRef.current?.updateSettings(next.tts);
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
    if (!shouldProceedWithSignOut(typeof window !== 'undefined' ? window.confirm : undefined)) {
      return;
    }
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
        onDownload={(url) => void rcpp.openExternal(url)}
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
      />
      {drawerOpen && (
        <SettingsDrawer
          settings={settings}
          onChange={updateSettings}
          onClose={() => setDrawerOpen(false)}
          voices={ttsRef.current?.voices() ?? []}
          onPreviewVoice={(uri) => ttsRef.current?.previewVoice(uri)}
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
