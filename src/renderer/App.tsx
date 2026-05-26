import React, { useEffect, useMemo, useRef, useState } from 'react';
import { rcpp } from './api';
import {
  AuthBootState,
  AuthStatus,
  ChatConnection,
  ChatMessage,
  ConnectionState,
  DEFAULT_SETTINGS,
  Platform,
  Settings,
  UpdateInfo,
} from '../shared/types';
import {
  AUTH_BOOT_FAIL_THRESHOLD_MS,
  AUTH_BOOT_SLOW_THRESHOLD_MS,
  initialAuthBootState,
  isAuthBootPending,
  reduceAuthBootOnFailTimeout,
  reduceAuthBootOnSlowTimeout,
  reduceAuthBootOnStatus,
  shouldRenderBootOverlay,
} from './auth-bootstate';
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
import {
  applyOptimisticSendTimeout,
  logOptimisticSendTimeout,
  optimisticSendTimeoutStatus,
  OPTIMISTIC_SEND_TIMEOUT_MS,
} from './optimistic-send-timeout';
import { sendFailureNoticeText } from './send-failure-copy';

const MAX_MESSAGES = 1000;

interface SendNotice {
  id: number;
  text: string;
}

export function App(): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [auth, setAuth] = useState<AuthStatus>({ authenticated: false });
  // v0.1.71 cold-start flicker fix (voice 4198, 2026-05-26).
  //
  // Tracks whether we've heard from the main process about the user's
  // auth state yet. Initial value is 'checking' — the renderer
  // DELIBERATELY does NOT trust its synchronous `auth` default (which
  // is `{ authenticated: false }` purely because that's the only safe
  // shape for `useState`'s initialiser). Until we observe a real
  // AUTH_STATUS via either the initial pull (`rcpp.authStatus()`
  // resolving) OR the deferred push (`onAuthStatus` firing), we render
  // a centered "Checking sign-in…" spinner overlay that blocks ALL
  // toolbar clicks — including the Sign In button. This stops Ethan
  // from accidentally re-OAuthing during the ~1-2s cold-start window
  // where the renderer is up but the main process hasn't yet decrypted
  // the stored OAuth token. See `auth-bootstate.ts` for the full
  // explanation + state-machine definition.
  const [authBoot, setAuthBoot] = useState<AuthBootState>(initialAuthBootState);
  // Refs to the slow + fail timeout handles so we can cancel them as
  // soon as a real AUTH_STATUS lands (otherwise the spinner would still
  // escalate to "Still checking…" mid-render even though we already
  // resolved). Bookkeeping data — lives in refs because changing the
  // handle shouldn't re-render the chat feed.
  const authBootSlowTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const authBootFailTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [conn, setConn] = useState<ConnectionState>({ status: 'idle', attempt: 0 });
  const [connections, setConnections] = useState<ChatConnection[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [sendNotice, setSendNotice] = useState<SendNotice | null>(null);
  // Banner-dismiss is session-only by design (see UpdateBanner.tsx docstring) —
  // we want a soft nag, not a sticky one. The next launch re-checks and
  // re-shows the banner if the user hasn't actually installed the new build.
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const ttsRef = useRef<TtsEngineLike | undefined>(undefined);
  const notifyLimiterRef = useRef<RateLimiter>(new RateLimiter(DEFAULT_SETTINGS.notifications.maxPerMinute));
  // v0.1.63 — one timeout per renderer-minted optimistic send. The map lives
  // in a ref because these handles are lifecycle bookkeeping, not render data:
  // changing them should not re-render the chat feed. Every handle is cleared
  // when the matching WS echo arrives, when the main-process queue reports an
  // explicit failure, when chat is cleared, and on unmount.
  const optimisticSendTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const sendNoticeSeqRef = useRef(0);
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

  const showSendNotice = (text: string): void => {
    // The id makes repeated identical failures visible as fresh state changes.
    // Without it, two consecutive `no-session-cookies` bails would set the
    // same string twice and React could preserve the previous dismissed banner.
    sendNoticeSeqRef.current += 1;
    setSendNotice({ id: sendNoticeSeqRef.current, text });
  };

  const clearOptimisticSendTimeout = (
    clientId: string,
    reason: 'echo' | 'failed-status' | 'replace' | 'clear-chat' | 'sign-out' | 'unmount',
  ): void => {
    const timeout = optimisticSendTimeoutsRef.current.get(clientId);
    if (!timeout) return;
    clearTimeout(timeout);
    optimisticSendTimeoutsRef.current.delete(clientId);
    // `reason` is deliberately part of the helper contract even though we
    // don't log it today. It forces each caller to name the state-machine
    // transition that retired the timer, which keeps future edits honest.
    void reason;
  };

  const clearAllOptimisticSendTimeouts = (
    reason: 'clear-chat' | 'sign-out' | 'unmount',
  ): void => {
    for (const clientId of optimisticSendTimeoutsRef.current.keys()) {
      clearOptimisticSendTimeout(clientId, reason);
    }
  };

  const scheduleOptimisticSendTimeout = (clientId: string): void => {
    // Defensive replace: client ids are UUIDs, so a duplicate should not
    // happen. If a future caller passes a reused id, replacing the old timer
    // avoids two callbacks racing to mark the same placeholder failed.
    clearOptimisticSendTimeout(clientId, 'replace');
    const timeout = setTimeout(() => {
      optimisticSendTimeoutsRef.current.delete(clientId);
      // v0.1.63 stuck-send guard. This is deliberately a renderer-side
      // safety net, not the primary send-failure path. The main process
      // should emit `failed` for every `{ ok:false }` send result, and startup
      // cookie repair should prevent the v0.1.62 cookie-bail path entirely.
      // If either contract regresses, this timer turns the placeholder into
      // `pendingSend: "failed"` after 30s so Ethan never stares at an
      // indefinite "sending" state with no explanation.
      //
      // v0.1.68 (voice 4013): timeout bumped 15s → 30s and we now write a
      // structured `optimistic-timeout` row to chat-send.jsonl so log
      // forensics can spot the renderer-side bail without needing the
      // UI. Cross-references the placeholder's `clientReplyUuid` against
      // any later `ws-echo-received` row to see whether the send DID
      // actually land just too slowly for the guard to wait.
      setMessages((prev) => applyOptimisticSendTimeout(prev, clientId));
      logOptimisticSendTimeout(clientId);
      const notice = sendFailureNoticeText(optimisticSendTimeoutStatus(clientId));
      if (notice) showSendNotice(notice);
    }, OPTIMISTIC_SEND_TIMEOUT_MS);
    optimisticSendTimeoutsRef.current.set(clientId, timeout);
  };

  // v0.1.71 — single helper invoked by every AUTH_STATUS source (initial
  // pull, push channel, sign-in result, sign-out result, retry). Updates
  // BOTH the existing `auth` shape AND the cold-start `authBoot`
  // discriminator atomically, and cancels the slow/fail timers so the
  // spinner overlay teardown happens exactly when the first real status
  // lands. Calling this multiple times is safe — the timer-clear helpers
  // are idempotent and the reducer keeps signed_in/signed_out in sync.
  const applyAuthStatus = (next: AuthStatus): void => {
    setAuth(next);
    setAuthBoot((prev) => reduceAuthBootOnStatus(prev, next));
    if (authBootSlowTimerRef.current) {
      clearTimeout(authBootSlowTimerRef.current);
      authBootSlowTimerRef.current = undefined;
    }
    if (authBootFailTimerRef.current) {
      clearTimeout(authBootFailTimerRef.current);
      authBootFailTimerRef.current = undefined;
    }
  };

  // v0.1.71 — retry button on the verify_failed overlay state. Re-runs
  // the initial AUTH_STATUS pull and re-arms the spinner state machine
  // so a network hiccup that pushed us into the 15s timeout can self-
  // recover without forcing the user to relaunch the app.
  const retryAuthCheck = async (): Promise<void> => {
    setAuthBoot('checking');
    // Re-arm both timers from scratch — the previous instances were
    // cleared the moment they fired, so this is a clean start.
    authBootSlowTimerRef.current = setTimeout(() => {
      setAuthBoot((prev) => reduceAuthBootOnSlowTimeout(prev));
    }, AUTH_BOOT_SLOW_THRESHOLD_MS);
    authBootFailTimerRef.current = setTimeout(() => {
      setAuthBoot((prev) => reduceAuthBootOnFailTimeout(prev));
    }, AUTH_BOOT_FAIL_THRESHOLD_MS);
    try {
      const a = await rcpp.authStatus();
      applyAuthStatus(a);
    } catch (err) {
      console.error('[App] auth retry failed', err);
      // Leave the spinner up; the fail timer will eventually re-escalate
      // back to verify_failed and the user can try again.
    }
  };

  // Init: load auth + settings + current connection state, subscribe to events.
  useEffect(() => {
    let alive = true;
    // v0.1.71 — arm the slow + fail timers BEFORE we await the initial
    // `rcpp.authStatus()`. If the main process is healthy, the await
    // resolves within ~1-2s and `applyAuthStatus` clears both timers
    // before the 5s slow threshold fires. If the main process is slow
    // (network, OAuth refresh in flight), the spinner adds the "Still
    // checking…" subtitle at 5s. If it never responds (main stuck), we
    // escalate to the retry affordance at 15s.
    authBootSlowTimerRef.current = setTimeout(() => {
      if (!alive) return;
      setAuthBoot((prev) => reduceAuthBootOnSlowTimeout(prev));
    }, AUTH_BOOT_SLOW_THRESHOLD_MS);
    authBootFailTimerRef.current = setTimeout(() => {
      if (!alive) return;
      setAuthBoot((prev) => reduceAuthBootOnFailTimeout(prev));
    }, AUTH_BOOT_FAIL_THRESHOLD_MS);
    (async () => {
      const a = await rcpp.authStatus();
      if (!alive) return;
      // applyAuthStatus replaces setAuth + clears the boot timers — DO
      // NOT call setAuth(a) directly here, that would leave the spinner
      // overlay stuck on screen until the next push.
      applyAuthStatus(a);
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

    // v0.1.71 — push channel goes through applyAuthStatus too so the
    // very FIRST AUTH_STATUS (whichever source wins the race — initial
    // pull or did-finish-load push) tears down the cold-start spinner.
    const offAuth = rcpp.onAuthStatus(applyAuthStatus);
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
      //
      // v0.1.63: clear the renderer-side stuck-send timeout at the same
      // state-machine transition. The echo is the server-confirmed success
      // path; leaving the timer armed would let a stale callback later repaint
      // an already-confirmed message as failed.
      clearOptimisticSendTimeout(flagged.id, 'echo');
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
      // Explicit queue failures win over the timeout guard. The queue knows
      // the real reason (`no-session-cookies`, `send-failed`, auth drift,
      // thrown fetch, etc.), so cancel the generic 15s timer before painting
      // the specific failure into the placeholder.
      clearOptimisticSendTimeout(status.clientId, 'failed-status');
      setMessages((prev) => applyFailedSendStatus(prev, status));
      const notice = sendFailureNoticeText(status);
      if (notice) showSendNotice(notice);
    });
    const offMenu = rcpp.onMenuOpenSettings(() => setDrawerOpen(true));
    // "Clear chat" can be triggered from either the chat-feed right-click
    // context menu or the application menu's Chat → Clear Chat (Cmd+K).
    // Both flow through the same main → renderer broadcast so we only need
    // one renderer-side listener that resets the buffer via the pure
    // `clearChatMessages` reducer. v0.1.18.
    const offClear = rcpp.onChatClear(() => {
      // Clearing the feed is an explicit user action. Pending placeholders no
      // longer exist after this reducer, so their timeout callbacks must not
      // fire later and resurrect a confusing send-failed banner.
      clearAllOptimisticSendTimeouts('clear-chat');
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
      clearAllOptimisticSendTimeouts('unmount');
      // v0.1.71 — drop cold-start spinner timers on unmount so they
      // can't fire setState after we've torn down (React would warn).
      if (authBootSlowTimerRef.current) {
        clearTimeout(authBootSlowTimerRef.current);
        authBootSlowTimerRef.current = undefined;
      }
      if (authBootFailTimerRef.current) {
        clearTimeout(authBootFailTimerRef.current);
        authBootFailTimerRef.current = undefined;
      }
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
    // Start the timer only after the placeholder exists locally. If the main
    // process drops a preflight send without emitting `failed`, this callback
    // is the UX backstop that flips the message to a red warning after 15s.
    scheduleOptimisticSendTimeout(clientId);
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
      // v0.1.71 — route through applyAuthStatus so the boot-state
      // discriminator stays in sync (an explicit sign-in click after
      // a cold-start verify_failed should also clear the spinner).
      applyAuthStatus(s);
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
    // v0.1.71 — applyAuthStatus instead of bare setAuth so the boot
    // discriminator transitions signed_in → signed_out cleanly.
    applyAuthStatus(s);
    clearAllOptimisticSendTimeouts('sign-out');
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

  // v0.1.71 — derive both booleans once per render so the JSX below stays
  // readable. `bootPending` gates the auth-keyed UI (toolbar Sign In, chat
  // input, chat feed CTA). `overlayVisible` controls the spinner cover.
  const bootPending = isAuthBootPending(authBoot);
  const overlayVisible = shouldRenderBootOverlay(authBoot);

  return (
    <div className="app">
      <div className="titlebar">Restream Chat++</div>
      {/*
       * v0.1.71 cold-start spinner overlay (voice 4198, 2026-05-26).
       *
       * Renders ABOVE the toolbar so it physically blocks any click on
       * the "Sign in to Restream" button during the cold-start window
       * (~1-2s in the happy case, up to 15s in the degraded case). The
       * overlay is full-app width but only covers the upper portion of
       * the viewport so the user can still see we haven't crashed.
       *
       * Three visual states keyed off `authBoot`:
       *   - 'checking'      → spinner + "Checking sign-in…"
       *   - 'checking-slow' → spinner + "Checking sign-in…" + subtitle
       *                       "Still checking…"
       *   - 'verify_failed' → no spinner; "Couldn't verify sign-in" copy
       *                       + Try again button that calls
       *                       `retryAuthCheck` and re-arms the state
       *                       machine.
       *
       * The overlay uses `pointer-events: auto` on its content but
       * `pointer-events: none` on its outer corners is NOT enough — we
       * need the entire surface to absorb clicks so a mis-aim on the
       * "Sign in" button can't fall through. CSS uses `position:
       * absolute; inset: 0; z-index: 50` to cover everything including
       * the toolbar.
       */}
      {overlayVisible && (
        <div
          className={`auth-boot-overlay auth-boot-${authBoot}`}
          role="status"
          aria-live="polite"
          // Block ANY click that aims at the toolbar Sign In button by
          // absorbing the event at the overlay layer. Belt-and-braces
          // because the toolbar is hidden under the overlay AND the
          // toolbar's auth-keyed buttons are themselves gated on
          // `!bootPending`, but a stray pointer event landing on either
          // surface stays harmless.
          onClick={(e) => e.stopPropagation()}
        >
          {authBoot === 'verify_failed' ? (
            <>
              <div className="auth-boot-message">
                Couldn&rsquo;t verify sign-in — try again
              </div>
              <button
                className="btn primary"
                type="button"
                onClick={() => void retryAuthCheck()}
              >
                Try again
              </button>
            </>
          ) : (
            <>
              <div className="auth-boot-spinner" aria-hidden="true" />
              <div className="auth-boot-message">Checking sign-in&hellip;</div>
              {authBoot === 'checking-slow' && (
                <div className="auth-boot-subtitle">Still checking&hellip;</div>
              )}
            </>
          )}
        </div>
      )}
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
      {sendNotice && (
        <div
          key={sendNotice.id}
          className="send-notice"
          role="alert"
          aria-live="assertive"
        >
          <span className="send-notice-text">{sendNotice.text}</span>
          <button
            className="send-notice-dismiss"
            type="button"
            aria-label="Dismiss send warning"
            onClick={() => setSendNotice(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      {/*
       * v0.1.70 (sign-out diagnosis 2026-05-25) — transient-refresh
       * recovery banner.
       *
       * Renders when: NOT authenticated AND tokenLikelyValid is true
       * (the main process flagged that `tokenEnc` is still on disk and
       * we're inside the periodic refresh-retry watchdog loop). In this
       * state the user has NOT been signed out — a single network blip
       * tripped oauth.refresh() and the watchdog is retrying on a 2m →
       * 4m → 8m … exponential ladder. The banner tells the user
       * recovery is in progress and offers a manual "Retry now" button
       * that invokes the same CONN_RECONNECT IPC the toolbar button
       * uses — so an impatient user can force the next attempt instead
       * of waiting for the next scheduled tick.
       *
       * Reuses the .send-notice class for visual consistency with the
       * other transient-failure banner. Keeps the surface minimal:
       * one sentence + one button, no dismiss (we WANT the user to
       * know the app is mid-recovery — dismissing it would hide the
       * fact that they're effectively offline).
       */}
      {!auth.authenticated && auth.tokenLikelyValid && (
        <div
          className="send-notice reconnecting-notice"
          role="status"
          aria-live="polite"
        >
          <span className="send-notice-text">
            Reconnecting — your session may resume automatically.
          </span>
          <button
            className="send-notice-dismiss"
            type="button"
            aria-label="Retry reconnect now"
            // Invokes the same IPC the toolbar Reconnect button uses,
            // which goes through performFullReconnect → oauth.refresh()
            // → on success, the main process pushes
            // `authenticated: true` and this banner disappears.
            onClick={() => void onReconnect()}
            disabled={reconnecting}
          >
            {reconnecting ? 'Retrying…' : 'Retry now'}
          </button>
        </div>
      )}
      <div className="toolbar">
        <span className={`status-dot ${conn.status}`} />
        {/*
         * v0.1.71 — while bootState is still resolving, the status label
         * reads "Checking sign-in…" instead of the misleading "Not signed
         * in" default. Once we have a real AUTH_STATUS, statusLabel takes
         * over and reflects the actual conn/auth state. (The overlay
         * sitting on top of the toolbar covers this anyway, but the
         * `aria-live="polite"` overlay text is what a screen reader picks
         * up; the toolbar label stays accurate underneath.)
         */}
        <span className="status-label">
          {bootPending ? 'Checking sign-in…' : statusLabel(conn, auth)}
        </span>
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
        ) : bootPending ? (
          // v0.1.71 — defence-in-depth. The overlay covers the toolbar
          // already, but we ALSO suppress the bare Sign In button so a
          // bug in the overlay's z-index/positioning can't expose a
          // clickable Sign In during the cold-start window. The overlay
          // is the user-facing affordance; the absence of any toolbar
          // CTA here is purely a safety net.
          null
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
