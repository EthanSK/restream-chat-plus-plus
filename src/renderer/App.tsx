import React, { useEffect, useMemo, useRef, useState } from 'react';
import { rcpp } from './api';
import {
  AuthBootState,
  AuthStatus,
  ChatConnection,
  ChatMessage,
  ConnectionState,
  DEFAULT_SETTINGS,
  NativeVoiceWire,
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
// v0.1.81 — the renderer no longer owns ANY speech engine. Speech is the native
// OS voice in the MAIN process (src/main/tts-native.ts); the browser Web-Speech
// `TTSEngine` + `makeTtsEngine` factory were deleted. The Settings voice list
// is fetched from main over IPC and the voice preview is an IPC call too. The
// only thing still imported from ./tts is nothing (it's now just pure helpers
// used by SettingsDrawer directly).
import { shouldProceedWithSignOut } from './auth-guards';
import { clearChatMessages } from './chat-actions';
import {
  addHiddenUser,
  applyMessageFilters,
  compileHiddenUsersSet,
  compileIgnorePatterns,
  isHiddenUser,
} from './message-filters';
import {
  applyFailedSendStatus,
  applyRetryingSendStatus,
  dedupeOptimisticOnEcho,
  isLateEchoForFailedSend,
  pushOptimisticMessage,
  resolveLingeringFailedSendsOnReconnect,
} from './chat-message-reducers';
// v0.1.76 — the TTS/notification decision-gate evaluator
// (decideTtsAction / decideNotificationAction) now runs in the MAIN process
// (src/main/tts-dispatch.ts), NOT here. The renderer no longer imports it.
import {
  applyOptimisticSendTimeout,
  logLateEchoResolved,
  logOptimisticSendTimeout,
  logReconnectSweepCleared,
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
  // v0.1.81 — the renderer holds NO speech engine anymore. All speech (incoming
  // chat AND the Settings voice preview) goes through the native OS voice in the
  // MAIN process. The only TTS-adjacent renderer state is the native VOICE LIST
  // shown in the Settings dropdown, fetched once from main over IPC. undefined =
  // not yet fetched (drawer shows "Loading…"); [] = fetched-but-none/failed.
  const [nativeVoices, setNativeVoices] = useState<NativeVoiceWire[] | undefined>(undefined);
  // v0.1.76 — the notification rate limiter + the whole TTS/notification
  // decision live in the MAIN process now (TtsDispatcher). The renderer only
  // renders the feed + computes display-only badge flags; it neither decides
  // nor speaks anything.
  // v0.1.63 — one timeout per renderer-minted optimistic send. The map lives
  // in a ref because these handles are lifecycle bookkeeping, not render data:
  // changing them should not re-render the chat feed. Every handle is cleared
  // when the matching WS echo arrives, when the main-process queue reports an
  // explicit failure, when chat is cleared, and on unmount.
  const optimisticSendTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // v0.1.88 (voice 4504) — set of clientIds (== optimistic placeholder ids ==
  // Restream clientReplyUuids) whose POST returned HTTP 200, learned from the
  // queue's `'sent'` ChatSendStatus (emitted ONLY on a 2xx POST). This is the
  // GATE for the reconnect-success sweep: when a managed reconnect succeeds we
  // clear the lingering ⚠ ONLY for sends in this set — empirically every
  // 200-send round-trips once the WS re-subscribes, so its ⚠ was a false alarm
  // from the 30s echo-timeout firing during the dead window. A send that never
  // POSTed 200 (HTTP error / no-session-cookies / no-active-connections /
  // network throw) is a GENUINE failure, is NOT in this set, and KEEPS its ⚠.
  //
  // Lives in a ref (lifecycle bookkeeping, not render data). Entries are pruned
  // when the matching ⚠ is actually cleared (late echo OR reconnect sweep), on
  // clear-chat, and on sign-out, with a hard size cap so a long session can't
  // grow it unbounded. We deliberately do NOT delete on a normal confirmed echo
  // immediately — see the onChatSendStatus 'sent' handler for the retention
  // rationale (a late echo or a reconnect sweep may still need to consult it).
  const httpOkSendsRef = useRef<Set<string>>(new Set());
  // Hard cap so the HTTP-200 set can't grow without bound across a marathon
  // stream. Old entries are the oldest-resolved sends; if we ever exceed this
  // we drop the oldest-inserted ids (Set preserves insertion order). 2000 is
  // ~2x the MAX_MESSAGES feed cap so a fully-failed-then-recovered feed is
  // still fully covered.
  const HTTP_OK_SENDS_MAX = 2000;
  const sendNoticeSeqRef = useRef(0);
  // v0.1.76 — the same-id-reprocess guard (lastSpokenIdRef) moved to the MAIN
  // process (TtsDispatcher.lastProcessedId) with the rest of the decision
  // logic. The renderer no longer tracks which message it last "spoke".

  // v0.1.26 — compile the user's regex-ignore lists ONCE per Settings change
  // and stash both in refs so the mount-only `onChatMessage` subscription
  // can read the freshest lists without being torn down on every tweak.
  //
  // v0.1.72 adds TWO more compiled lists per axis: username-regex (the
  // second matching axis added in voice 4352). Same ref-pattern so the
  // onChatMessage handler picks up the latest compiled set without
  // re-subscribing.
  const ttsIgnoreCompiled = useMemo(
    () => compileIgnorePatterns(settings.filters?.tts?.ignoreRegex ?? []),
    [settings.filters?.tts?.ignoreRegex],
  );
  const notifIgnoreCompiled = useMemo(
    () => compileIgnorePatterns(settings.filters?.notifications?.ignoreRegex ?? []),
    [settings.filters?.notifications?.ignoreRegex],
  );
  const ttsUsernameIgnoreCompiled = useMemo(
    () => compileIgnorePatterns(settings.filters?.tts?.ignoreUsernameRegex ?? []),
    [settings.filters?.tts?.ignoreUsernameRegex],
  );
  const notifUsernameIgnoreCompiled = useMemo(
    () =>
      compileIgnorePatterns(settings.filters?.notifications?.ignoreUsernameRegex ?? []),
    [settings.filters?.notifications?.ignoreUsernameRegex],
  );
  const ttsIgnoreRef = useRef<RegExp[]>(ttsIgnoreCompiled);
  const notifIgnoreRef = useRef<RegExp[]>(notifIgnoreCompiled);
  const ttsUsernameIgnoreRef = useRef<RegExp[]>(ttsUsernameIgnoreCompiled);
  const notifUsernameIgnoreRef = useRef<RegExp[]>(notifUsernameIgnoreCompiled);
  useEffect(() => {
    ttsIgnoreRef.current = ttsIgnoreCompiled;
  }, [ttsIgnoreCompiled]);
  useEffect(() => {
    notifIgnoreRef.current = notifIgnoreCompiled;
  }, [notifIgnoreCompiled]);
  useEffect(() => {
    ttsUsernameIgnoreRef.current = ttsUsernameIgnoreCompiled;
  }, [ttsUsernameIgnoreCompiled]);
  useEffect(() => {
    notifUsernameIgnoreRef.current = notifUsernameIgnoreCompiled;
  }, [notifUsernameIgnoreCompiled]);

  // v0.1.72 — compile the hidden-users list into a lowercase Set once per
  // settings change. Used by both ChatFeed (to hide the row from the
  // visible feed) and the side-effect gate (so hidden users' messages
  // don't wake TTS / notifications either — hidden means hidden across
  // every surface).
  const hiddenUsersSet = useMemo(
    () => compileHiddenUsersSet(settings.hiddenUsers ?? []),
    [settings.hiddenUsers],
  );
  const hiddenUsersSetRef = useRef<Set<string>>(hiddenUsersSet);
  useEffect(() => {
    hiddenUsersSetRef.current = hiddenUsersSet;
  }, [hiddenUsersSet]);

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
    // v0.1.88 (voice 4504): the optimistic placeholders these ids tracked are
    // gone (clear-chat empties the feed; sign-out resets it; unmount tears the
    // whole renderer down), so the HTTP-200 tracking set has nothing left to
    // sweep — flush it too. Without this, the set would keep ids for messages
    // that no longer exist, leaking memory across a long session of
    // clear-chats and never matching a sweep again.
    httpOkSendsRef.current.clear();
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
      // v0.1.87 (send-warning auto-reconnect request 2026-06-07): a send that
      // never got its WS echo within the 30s guard means the chat WS is most
      // likely stale/replaced — the POST landed (200) but the round-trip echo
      // is dead. Ethan confirmed clicking Reconnect fixes it, so do the
      // equivalent automatically: nudge main to run the SAME managed reconnect
      // (re-subscribe) the manual button uses, so FUTURE sends confirm again.
      // We do NOT re-send THIS message — the POST already succeeded; re-sending
      // would risk a duplicate. main owns the debounce + cooldown + replace-war
      // guard (see ws-client.ts requestUnconfirmedSendRecovery), so a burst of
      // unconfirmed sends coalesces into one reconnect and a persistently-broken
      // upstream can't loop. Fire-and-forget; guarded against a missing bridge
      // method (older preload) so it never breaks the timeout's primary job of
      // flipping the placeholder to the visible ⚠ state.
      try {
        rcpp.notifyUnconfirmedSend?.();
      } catch {
        // self-healing nudge must never break the stuck-send guard
      }
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
      // v0.1.81 — fetch the native OS voice list from main (cached there) for
      // the Settings dropdown. No renderer speech engine to construct anymore.
      // Best-effort: a failure leaves the dropdown on "System default" only.
      void rcpp.ttsNative
        ?.getVoices?.()
        .then((list) => {
          if (alive) setNativeVoices(list);
        })
        .catch((err) => {
          console.error('[App] getVoices failed', err);
          if (alive) setNativeVoices([]);
        });
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
      //
      // v0.1.72 — apply BOTH axes (content + username) per side-effect.
      // The compiled username regex lists live in *UsernameIgnoreRef and
      // are passed down so the helper can OR-compose content + username
      // matches. See `applyMessageFilters` docstring for the contract.
      const flags = applyMessageFilters(
        m.text,
        ttsIgnoreRef.current,
        notifIgnoreRef.current,
        m.username,
        ttsUsernameIgnoreRef.current,
        notifUsernameIgnoreRef.current,
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
      // v0.1.88 (voice 4504): LATE-ECHO RESOLUTION.
      //
      // `dedupeOptimisticOnEcho` replaces ANY placeholder with `pendingSend !==
      // undefined` — which INCLUDES a `'failed'` (timed-out ⚠) one — so a LATE
      // echo (arriving after the 30s OPTIMISTIC_SEND_TIMEOUT_MS already flipped
      // the placeholder to ⚠) ALREADY clears the warning just by being deduped
      // in. The failed placeholder is never auto-removed from the feed, so it's
      // always still there for a late echo to match by id, however late the echo
      // arrives. So we don't need to CHANGE the resolution — we only DETECT it
      // to emit a structured log row. This is the common case right after an
      // auto-reconnect re-subscribe, where Restream replays/echoes the queued
      // reply ~5s past the 30s guard.
      //
      // The detection MUST read the CURRENT feed (`prev`), not the `messages`
      // captured by this mount-only listener closure (which is the stale
      // initial value). So we do it inside the setMessages updater, latching a
      // flag we act on AFTER setState returns (logging is a side effect — it
      // must not run inside the reducer, which React may call twice in Strict
      // Mode). The HTTP-200 set is pruned here too: the id is now resolved, so
      // it can no longer need a reconnect sweep.
      let wasLateEchoForFailed = false;
      setMessages((prev) => {
        wasLateEchoForFailed = isLateEchoForFailedSend(prev, flagged);
        return dedupeOptimisticOnEcho(prev, flagged, MAX_MESSAGES);
      });
      if (wasLateEchoForFailed) {
        logLateEchoResolved(flagged.id);
      }
      // The id is now resolved (whether on-time or late) — drop it from the
      // HTTP-200 tracking set so that set only ever holds ids that might STILL
      // need a reconnect sweep. Harmless if the id was never in it.
      httpOkSendsRef.current.delete(flagged.id);
    });
    // v0.1.43 — listen for queue lifecycle updates and flip the matching
    // optimistic placeholder. `pending` is a no-op (the placeholder is
    // already in the feed from the click handler). `sent` doesn't touch
    // state either — the WS echo replaces the placeholder via the
    // dedupe path above. `failed` keeps the placeholder visible with a
    // small ⚠ + tooltip carrying the error.
    const offSendStatus = rcpp.onChatSendStatus((status) => {
      // v0.1.88 (voice 4504): record HTTP-200 sends so the reconnect-success
      // sweep can tell "Restream accepted this POST (it WILL deliver once we
      // re-subscribe)" from "this send genuinely never landed". The queue emits
      // `'sent'` ONLY on a 2xx POST (see chat-send-queue.ts `result.ok` path),
      // so it's the authoritative HTTP-200 signal. `'pending'` is the enqueue
      // ack (no POST yet) and is ignored. We track the clientId here rather
      // than touching the feed — `'sent'` does NOT replace the placeholder (the
      // WS echo does that); it only tells us the POST succeeded, which is
      // exactly the gate the sweep needs. Capped to avoid unbounded growth on a
      // long stream (drop oldest-inserted; Set preserves insertion order).
      if (status.status === 'sent') {
        const set = httpOkSendsRef.current;
        set.add(status.clientId);
        if (set.size > HTTP_OK_SENDS_MAX) {
          const oldest = set.values().next().value;
          if (oldest !== undefined) set.delete(oldest);
        }
        return;
      }
      // v0.1.90 (voice 4512) — intermediate retry status. The bounded
      // exponential-backoff loop in main flips the placeholder to
      // "sending… (retry N/5)" between attempts so Ethan always SEES his
      // message fighting to deliver. We KEEP the optimistic-send timeout
      // armed across retries — if the whole loop eventually succeeds the
      // echo clears it; if it ends in terminal 'failed' that status cancels
      // it (below). A 'retrying' is NOT a failure and NOT an HTTP-200, so it
      // touches neither the timeout nor the httpOkSends set.
      if (status.status === 'retrying') {
        setMessages((prev) => applyRetryingSendStatus(prev, status));
        return;
      }
      if (status.status !== 'failed') return;
      // Explicit queue failures win over the timeout guard. The queue knows
      // the real reason (`no-session-cookies`, `send-failed`, auth drift,
      // thrown fetch, etc.), so cancel the generic 15s timer before painting
      // the specific failure into the placeholder.
      clearOptimisticSendTimeout(status.clientId, 'failed-status');
      // v0.1.88: a queue-reported `'failed'` means the POST did NOT return 200
      // (preflight bail or non-2xx). Make sure this id is NOT considered an
      // HTTP-200 send — otherwise a later reconnect sweep would wrongly clear a
      // GENUINE failure. (It normally wouldn't be in the set at all, but a
      // pathological out-of-order status sequence shouldn't leave it stale.)
      httpOkSendsRef.current.delete(status.clientId);
      setMessages((prev) => applyFailedSendStatus(prev, status));
      const notice = sendFailureNoticeText(status);
      if (notice) showSendNotice(notice);
    });
    // v0.1.88 (voice 4504): RECONNECT-SUCCESS SWEEP.
    //
    // Main pushes CONN_RECONNECT_SUCCEEDED whenever a MANAGED reconnect
    // succeeds + re-subscribes — the v0.1.86 drain-to-zero recovery, the
    // v0.1.87 unconfirmed-send recovery, OR the manual Reconnect button. When
    // that happens, any optimistic send still showing the red ⚠
    // (`pendingSend:'failed'`) whose POST returned HTTP 200 has — empirically —
    // ALREADY delivered (every 200-send round-trips once the WS re-subscribes;
    // the ⚠ was a false alarm from the 30s echo-timeout firing during the dead
    // window). Sweep those and clear the ⚠. The `resolveLingeringFailedSends...`
    // reducer GATES on the HTTP-200 set so a send that never POSTed 200 (a
    // genuine failure) keeps its ⚠. We never re-send anything (POST already
    // landed → re-sending risks a duplicate); this is a pure visual resolution.
    //
    // Why a sweep AND late-echo resolution? They cover different timings: the
    // late echo clears a SPECIFIC message the instant Restream echoes it back;
    // the sweep is the catch-all for messages whose echo never arrives even
    // after re-subscribe (Restream doesn't always replay every queued reply) —
    // those we resolve on the strength of the HTTP-200 alone once the
    // connection is provably healthy again.
    const offReconnectSucceeded = rcpp.onReconnectSucceeded((reason) => {
      // Latch the cleared ids out of the updater so the side effects (pruning
      // the HTTP-200 set + emitting the single sweep log row) run exactly ONCE
      // after setState, not inside the reducer (React may call a reducer twice
      // in Strict Mode). The reducer stays pure: compute `next`, record which
      // ids it resolved.
      const clearedIds: string[] = [];
      setMessages((prev) => {
        const { next, clearedCount } = resolveLingeringFailedSendsOnReconnect(
          prev,
          httpOkSendsRef.current,
        );
        if (clearedCount > 0) {
          // Record exactly which placeholders this sweep resolved so we can
          // prune them from the HTTP-200 set afterward. Reassigning the array's
          // contents (not the binding) keeps the latched value correct even if
          // the reducer runs twice — the second run recomputes the same set.
          clearedIds.length = 0;
          for (const m of prev) {
            if (m.pendingSend === 'failed' && httpOkSendsRef.current.has(m.id)) {
              clearedIds.push(m.id);
            }
          }
        }
        return next;
      });
      if (clearedIds.length > 0) {
        for (const id of clearedIds) httpOkSendsRef.current.delete(id);
        logReconnectSweepCleared(reason, clearedIds.length);
      }
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
    // tools like `set_voice` / `set_tts_volume`. We just replace local
    // settings state so the UI reflects the change. v0.1.81 — there's no
    // renderer TTS engine to re-init anymore: the live native engine in MAIN
    // reads the persisted settings per-utterance + gets a settings push of its
    // own, so MCP voice/volume/rate changes take effect on the next message
    // with no renderer involvement.
    const offSettingsPush = rcpp.onSettingsPush((next) => {
      setSettings(next);
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
    // v0.1.81 — there is no longer a renderer speech listener. Speech happens
    // entirely in MAIN via the native OS voice engine; the old
    // `IPC.TTS_SPEAK_BROWSER` channel + the renderer's browser-speak executor
    // were removed when the Web-Speech engine was deleted.
    return () => {
      alive = false;
      offAuth();
      offConn();
      offConnections();
      offChat();
      offSendStatus();
      offReconnectSucceeded();
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

  // v0.1.90 (voice 4512) — MANUAL "tap to retry" on a terminally-failed send.
  // After the 5x auto-retry loop exhausts, the placeholder shows the ⚠
  // "failed — tap to retry" affordance. Clicking it re-runs the WHOLE loop:
  // we re-enqueue with the SAME clientId (== the placeholder id == the Restream
  // clientReplyUuid) so (a) the existing placeholder is reused in-place rather
  // than spawning a duplicate row, and (b) Restream dedupes on the uuid if the
  // original send had somehow reached it. We flip the placeholder straight back
  // to 'sending' and re-arm the optimistic-send timeout so the retry has the
  // same stuck-send safety net as a fresh send.
  const handleRetrySend = (message: ChatMessage): void => {
    // Only retry our own failed placeholders. Guard against a stale/incoming
    // row sneaking in (defence-in-depth; the UI only wires this on failed self
    // placeholders).
    if (message.pendingSend !== 'failed' || message.self !== true) return;
    const text = message.text;
    if (typeof text !== 'string' || text.trim().length === 0) return;
    const clientId = message.id;
    // Flip the existing placeholder back to 'sending' (clear the ⚠ + counters).
    setMessages((prev) =>
      prev.map((m) =>
        m.id === clientId
          ? {
              ...m,
              pendingSend: 'sending',
              pendingError: undefined,
              sendAttempt: undefined,
              sendMaxAttempts: undefined,
            }
          : m,
      ),
    );
    // Re-arm the stuck-send timeout (re-uses the same id; scheduleOptimistic…
    // defensively clears any prior timer for this id first).
    scheduleOptimisticSendTimeout(clientId);
    // Re-enqueue — runs the full bounded retry loop again in main.
    dispatchEnqueueChatSend(text, clientId);
  };

  // TTS + NOTIFICATION DISPATCH LIVE ENTIRELY IN THE MAIN PROCESS.
  // ===========================================================================
  // The renderer NO LONGER decides whether/what to speak or notify, and (as of
  // v0.1.81) it no longer SPEAKS anything either. The whole decision/filter/
  // rate-limit/same-id ladder + the actual speech run in the BACKGROUND (main)
  // process — see src/main/tts-dispatch.ts (TtsDispatcher) + src/main/
  // tts-native.ts (the cross-platform native OS voice engine), wired into
  // `chat.on('message')` in main.ts. This is PRIORITY #1 from voice 4414: "it
  // must NEVER miss a message" — a wedged/dead/slow renderer can't swallow a
  // message because nothing about speech depends on the renderer.
  //
  // What the renderer does now:
  //   - Renders the feed (onChatMessage, above) — unchanged.
  //   - Computes the `ignoredByTts` / `ignoredByNotifications` BADGE flags for
  //     the feed via applyMessageFilters in onChatMessage — display-only, NOT a
  //     side-effect decision. (The authoritative decision is main's.)
  //   - Shows the native voice list + fires the voice-preview IPC in Settings.
  //
  // Notifications likewise fire from main (the dispatcher calls Electron's
  // Notification directly, honouring soundEnabled). The rate limiters live in
  // main (TtsDispatcher.ttsLimiter / notifLimiter) so they survive a reload.

  // v0.1.72 — also drop messages whose `username` is in `hiddenUsers`
  // (case-insensitive exact match). Re-runs every render so historical
  // messages already in the buffer disappear the instant the user clicks
  // Hide on a row (NOT just for future arrivals). The Set is rebuilt
  // only when settings.hiddenUsers changes (see `hiddenUsersSet` useMemo
  // above), so the per-row check is O(1).
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (m) =>
          settings.filter.platforms[m.platform] !== false &&
          !isHiddenUser(m.username, hiddenUsersSet),
      ),
    [messages, settings.filter.platforms, hiddenUsersSet],
  );

  // v0.1.72 — handler for the per-row "Hide user" hover button. Appends
  // the username to `settings.hiddenUsers` (de-duped, case-insensitive)
  // and persists via the normal updateSettings IPC round-trip. Async
  // because settings persist is async; the renderer doesn't await the
  // promise so the click feels instant — the in-memory `setSettings`
  // call in updateSettings flips the local state synchronously, which
  // re-runs `visibleMessages` on the next render, which hides the row.
  const handleHideUser = (username: string): void => {
    // Defensive: skip empty / whitespace-only usernames so a malformed
    // ChatMessage can't poison the hidden list with `""`. addHiddenUser
    // also guards but it never hurts to check at the call site too.
    if (typeof username !== 'string' || username.trim().length === 0) return;
    const nextHidden = addHiddenUser(settings.hiddenUsers ?? [], username);
    // Bail if nothing actually changed (already hidden) to avoid an
    // unnecessary settings persist / IPC round-trip.
    if (nextHidden.length === (settings.hiddenUsers ?? []).length) {
      const before = (settings.hiddenUsers ?? []).map((u) => u.toLowerCase());
      const after = nextHidden.map((u) => u.toLowerCase());
      if (before.every((u, i) => u === after[i])) return;
    }
    void updateSettings({
      ...settings,
      hiddenUsers: nextHidden,
    });
  };

  // v0.1.77 (Ethan voice 4438, 2026-05-30) — header ONE-CLICK MUTE toggle.
  //
  // Flips `settings.tts.muted` and persists it through the normal
  // updateSettings round-trip (which setState's locally for an instant UI
  // flip AND IPCs to main, where the TtsDispatcher reads the new value on the
  // very next message). The renderer button is JUST a switch — it does not
  // decide whether to speak; the main-process dispatcher's `muted` gate
  // (shared decideTtsAction) is the source of truth that silences both the
  // browser and native speech paths. Mute leaves every other TTS setting
  // untouched so un-muting restores the user's config exactly.
  const toggleMuted = (): void => {
    void updateSettings({
      ...settings,
      tts: { ...settings.tts, muted: !settings.tts.muted },
    });
  };

  const updateSettings = async (next: Settings) => {
    setSettings(next);
    // v0.1.84 — the "cancel in-flight/queued native TTS on a mute-on / disable-
    // off transition" logic MOVED to the MAIN process (saveSettings in main.ts).
    // It used to live HERE and fired `rcpp.ttsNative.cancel()` BEFORE the
    // `rcpp.setSettings(next)` persist below — two separate IPCs with a race
    // window: a chat message arriving in main between them read the still-
    // unmuted settings and got spoken after mute. Doing the cancel atomically
    // inside saveSettings (which the `await rcpp.setSettings(next)` call at the
    // end of this function triggers via IPC.SETTINGS_SET) closes that window AND
    // covers the MCP path (set_tts_enabled) that never went through here at all.
    // So there is deliberately NO cancel() call in the renderer any more — the
    // single source of truth is the main-process saveSettings.
    //
    // v0.1.81 — no renderer engine to swap. Push the voice/rate/volume slice to
    // the MAIN native engine so the Settings voice-PREVIEW (which the engine
    // speaks using its own current rate/volume) reflects live slider changes
    // immediately. Chat playback reads settings per-message in main, so this
    // push is only load-bearing for the preview's rate/volume. Fire-and-forget.
    try {
      rcpp.ttsNative?.updateSettings?.({
        voiceURI: next.tts.voiceURI,
        rate: next.tts.rate,
        volume: next.tts.volume,
      });
    } catch (err) {
      console.error('[App] ttsNative.updateSettings failed', err);
    }
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
        {/*
         * v0.1.77 (Ethan voice 4438, 2026-05-30) — ONE-CLICK MUTE button.
         *
         * Compact emoji toggle for silencing spoken chat (TTS) instantly,
         * without quitting the app or opening Settings. 🔊 = speaking enabled,
         * 🔇 = muted. One click flips `settings.tts.muted` via `toggleMuted`,
         * which persists through updateSettings (instant local flip + IPC to
         * main). The main-process dispatcher's `muted` gate is what actually
         * stops speech on BOTH the browser and native paths; this button only
         * flips the setting. Tooltip + aria-label reflect the CURRENT state's
         * ACTION ("Mute speech" when currently on, "Unmute speech" when muted).
         * Styled `btn icon` to match the existing reconnect icon button.
         * Always shown (independent of auth) so Ethan can silence speech the
         * moment chat starts pouring in. Settings drawer's "Enabled" switch and
         * this button stay in sync automatically because both read/write the
         * same `settings.tts` object (see SettingsDrawer's Muted row).
         */}
        <button
          className={`btn icon ghost mute-btn${settings.tts.muted ? ' muted' : ''}`}
          title={settings.tts.muted ? 'Unmute speech' : 'Mute speech'}
          aria-label={settings.tts.muted ? 'Unmute speech' : 'Mute speech'}
          aria-pressed={settings.tts.muted}
          onClick={toggleMuted}
        >
          {settings.tts.muted ? '🔇' : '🔊'}
        </button>
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
        // v0.1.72 — per-row hover affordance fires this callback with the
        // author's username. App.tsx owns the settings + persists the
        // hidden-users list. ChatFeed is a pure render layer here; it
        // just surfaces the button + relays the click.
        onHideUser={handleHideUser}
        // v0.1.90 (voice 4512) — manual "tap to retry" on a ⚠ failed send.
        // ChatFeed relays the click on the ⚠ affordance; App re-runs the loop.
        onRetrySend={handleRetrySend}
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
          // v0.1.81 — the voice list is the NATIVE OS voice list fetched from
          // main (undefined while loading, [] if none/failed). Preview speaks
          // through the native engine in main via IPC. No renderer engine.
          nativeVoices={nativeVoices}
          onPreviewVoice={(uri) => rcpp.ttsNative?.preview?.(uri)}
        />
      )}
    </div>
  );
}

function statusLabel(conn: ConnectionState, auth: AuthStatus): string {
  if (!auth.authenticated) return 'Not signed in';
  switch (conn.status) {
    case 'connected':
      // v0.1.86 (voice 4491): the socket can be 'connected' yet carry a
      // non-fatal warning — currently the "replace-war" case where another
      // Restream client/tab grabbed the chat session and we stood down from
      // reconnecting (see ConnectionState.warning). Show it inline so the
      // user knows to close the competing client; the dot stays green-ish.
      return conn.warning ? `Connected — ${conn.warning}` : 'Connected';
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
