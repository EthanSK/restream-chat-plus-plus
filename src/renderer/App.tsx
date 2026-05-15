import React, { useEffect, useMemo, useRef, useState } from 'react';
import { rcpp } from './api';
import {
  AuthStatus,
  ChatMessage,
  ConnectionState,
  DEFAULT_SETTINGS,
  Platform,
  Settings,
} from '../shared/types';
import { ChatFeed } from './ChatFeed';
import { SettingsDrawer } from './SettingsDrawer';
import { TTSEngine, RateLimiter } from './tts';

const MAX_MESSAGES = 1000;

export function App(): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [auth, setAuth] = useState<AuthStatus>({ authenticated: false });
  const [conn, setConn] = useState<ConnectionState>({ status: 'idle', attempt: 0 });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const ttsRef = useRef<TTSEngine | undefined>(undefined);
  const notifyLimiterRef = useRef<RateLimiter>(new RateLimiter(DEFAULT_SETTINGS.notifications.maxPerMinute));

  // Init: load auth + settings, subscribe to events.
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
    })();

    const offAuth = rcpp.onAuthStatus(setAuth);
    const offConn = rcpp.onConnectionState(setConn);
    const offChat = rcpp.onChatMessage((m) => {
      setMessages((prev) => {
        const next = [...prev, m];
        if (next.length > MAX_MESSAGES) next.splice(0, next.length - MAX_MESSAGES);
        return next;
      });
    });
    const offMenu = rcpp.onMenuOpenSettings(() => setDrawerOpen(true));
    return () => {
      alive = false;
      offAuth();
      offConn();
      offChat();
      offMenu();
    };
  }, []);

  // Forward each new message to TTS + native notifications, honoring filters.
  useEffect(() => {
    if (messages.length === 0) return;
    const m = messages[messages.length - 1];
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
    const s = await rcpp.authLogout();
    setAuth(s);
    setMessages([]);
  };

  return (
    <div className="app">
      <div className="titlebar">Restream Chat++</div>
      <div className="toolbar">
        <span className={`status-dot ${conn.status}`} />
        <span className="status-label">{statusLabel(conn, auth)}</span>
        <span className="spacer" />
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
      <ChatFeed messages={visibleMessages} authenticated={auth.authenticated} />
      {drawerOpen && (
        <SettingsDrawer
          settings={settings}
          onChange={updateSettings}
          onClose={() => setDrawerOpen(false)}
          voices={ttsRef.current?.voices() ?? []}
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
