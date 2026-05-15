import type { ChatMessage, Platform } from '../shared/types';

export type NormalizeDropReason =
  | 'not-object'
  | 'not-event-action'
  | 'no-payload'
  | 'no-text';

export interface NormalizeResult {
  message?: ChatMessage;
  /**
   * Why an event-action frame produced no ChatMessage. Set whenever
   * `message` is undefined AND the frame had `action === 'event'` (or no
   * action at all, since we accept bare payloads too). Used by the
   * ws-client to log silent drops so we can extend the parser later.
   */
  drop?: { reason: NormalizeDropReason; eventTypeId?: unknown };
}

/**
 * Normalize a raw Restream WebSocket event into a ChatMessage, or return
 * a drop reason explaining why it didn't.
 *
 * Restream emits events as
 *   { action: "event", payload: { connectionIdentifier, eventIdentifier,
 *                                 eventSourceId, eventTypeId, eventPayload,
 *                                 userId }, timestamp }
 *
 * Reference: https://developers.restream.io/chat/actions
 *            https://developers.restream.io/chat/events
 */
export function normalizeRestreamEventDetailed(raw: unknown): NormalizeResult {
  if (!raw || typeof raw !== 'object') return { drop: { reason: 'not-object' } };
  const r = raw as Record<string, any>;

  // The Restream Chat WS protocol sends action-tagged envelopes.
  // Drop non-event actions (heartbeat, connection_info, connection_closed,
  // reply_*, relay_*). If `action` is absent, accept the payload anyway —
  // this is the legacy / test-fixture shape and we don't want to silently
  // drop it.
  if (r.action && r.action !== 'event') return { drop: { reason: 'not-event-action' } };

  const payload =
    r.payload?.eventPayload ?? r.eventPayload ?? r.payload ?? r;
  const eventTypeId = r.payload?.eventTypeId ?? r.eventTypeId;

  if (!payload || typeof payload !== 'object') {
    return { drop: { reason: 'no-payload', eventTypeId } };
  }

  const platform: Platform = mapEventTypeId(eventTypeId) ?? guessPlatform(payload);
  const username =
    payload.author?.displayName ??
    payload.author?.name ??
    payload.author?.username ??
    payload.username ??
    payload.displayName ??
    payload.userName ??
    'unknown';
  const text =
    payload.text ??
    payload.message ??
    payload.body ??
    payload.content ??
    '';
  if (!text || typeof text !== 'string') {
    return { drop: { reason: 'no-text', eventTypeId } };
  }
  const ts = payload.timestamp ?? payload.createdAt ?? Date.now();
  const id =
    payload.id ??
    payload.messageId ??
    payload.eventIdentifier ??
    r.payload?.eventIdentifier ??
    `${platform}-${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const color =
    payload.author?.color ?? payload.color ?? undefined;
  return {
    message: {
      id: String(id),
      platform,
      username: String(username),
      text: String(text),
      ts:
        typeof ts === 'string'
          ? Date.parse(ts) || Date.now()
          : Number(ts) || Date.now(),
      color,
      raw,
    },
  };
}

/** Thin wrapper that preserves the original undefined-or-message contract for callers
 * that don't care about drop reasons (e.g. the existing test suite). */
export function normalizeRestreamEvent(raw: unknown): ChatMessage | undefined {
  return normalizeRestreamEventDetailed(raw).message;
}

// Restream documents numeric eventTypeIds per platform.
// Source: https://developers.restream.io/chat/events
//   1  = Discord Text
//   2  = DLive Text
//   4  = Twitch Text                  (author.displayName)
//   5  = YouTube Text                 (author.displayName)
//   7  = YouTube Super Chat
//   8  = YouTube Super Sticker
//   11 = Facebook Personal Text       (author.name)
//   13 = Facebook Public Page Text    (author.name)
//   21 = LinkedIn Text                (author.name)
//   22 = Trovo Text                   (author.name)
//   24 = X Text                       (author.displayName)
//   25 = Kick Text                    (author.username)
//   26 = Kick Subscription
//   32 = Rumble Text                  (author.displayName)
// Note: Restream's Chat API does NOT carry a TikTok text event today; the
// platform is exposed only via guessPlatform fallback for legacy / unknown ids.
function mapEventTypeId(id: unknown): Platform | undefined {
  switch (id) {
    case 4:
      return 'twitch';
    case 5:
      return 'youtube';
    case 7:
    case 8:
      return 'youtube'; // Super Chat / Super Sticker still carry author + text
    case 11:
    case 13:
      return 'facebook';
    case 22:
      return 'trovo';
    case 24:
      return 'x';
    case 25:
      return 'kick';
    case 32:
      return 'rumble';
    default:
      return undefined;
  }
}

function guessPlatform(payload: any): Platform {
  const s = JSON.stringify(payload).toLowerCase();
  if (s.includes('twitch')) return 'twitch';
  if (s.includes('youtube')) return 'youtube';
  if (s.includes('facebook')) return 'facebook';
  if (s.includes('kick.com') || s.includes('"kick"')) return 'kick';
  if (s.includes('trovo')) return 'trovo';
  if (s.includes('rumble')) return 'rumble';
  if (s.includes('tiktok')) return 'tiktok';
  return 'unknown';
}
