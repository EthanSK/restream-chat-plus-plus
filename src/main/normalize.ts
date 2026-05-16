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
 * Additionally — and this is the v0.1.10 fix for "my own messages don't
 * show up in the feed even though they show in the official app" — we now
 * also normalise `reply_created` frames. Restream's Chat WS is read-only
 * for third-party clients, but the OFFICIAL Restream Chat webchat sends
 * replies via Restream's private API and the WS rebroadcasts them to all
 * subscribers (us included) as `reply_created`. Those carry just text /
 * connectionIdentifiers / eventSourceId, so we surface them as
 * `self: true` ChatMessages with username "You" and the corresponding
 * platform inferred from `eventSourceId` (when it's not the meta "all
 * connections" id of 1).
 *
 * Reference: https://developers.restream.io/chat/actions
 *            https://developers.restream.io/chat/events
 *            https://developers.restream.io/chat/reply
 */
export function normalizeRestreamEventDetailed(raw: unknown): NormalizeResult {
  if (!raw || typeof raw !== 'object') return { drop: { reason: 'not-object' } };
  const r = raw as Record<string, any>;

  // `reply_created` is the streamer's own outgoing reply (echoed by the WS
  // to every subscriber). Surface it as a self-message so the user can see
  // their own posts inline with incoming chat — the official Restream Chat
  // app does the same thing visually.
  if (r.action === 'reply_created') {
    const p = (r.payload ?? {}) as Record<string, any>;
    const text = typeof p.text === 'string' ? p.text : '';
    if (!text) return { drop: { reason: 'no-text' } };
    // Platform inference: when the reply is sent to ALL connections,
    // eventSourceId === 1 ("Restream" source). For direct replies the id
    // matches the destination platform. Fall back to inspecting the first
    // connectionIdentifier (formatted "<userId>-<platform>-<channelId>") to
    // recover the platform for common replies too — otherwise every
    // outgoing common reply renders as "unknown" which looks broken.
    const platform: Platform =
      mapEventSourceId(p.eventSourceId) ?? guessPlatformFromConnectionIds(p.connectionIdentifiers);
    const ts = Date.now();
    const id =
      (typeof p.replyUuid === 'string' && p.replyUuid) ||
      (typeof p.clientReplyUuid === 'string' && p.clientReplyUuid) ||
      `self-${ts}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      message: {
        id: String(id),
        platform,
        username: 'You',
        text,
        ts,
        self: true,
        raw,
      },
    };
  }

  // The Restream Chat WS protocol sends action-tagged envelopes.
  // Drop non-event actions (heartbeat, connection_info, connection_closed,
  // relay_*, the OTHER reply_* lifecycle actions). If `action` is absent,
  // accept the payload anyway — this is the legacy / test-fixture shape
  // and we don't want to silently drop it.
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
    payload.author?.nickname ?? // Discord-style
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
//   1  = Discord Text                 (author.name / author.nickname)
//   2  = DLive Text                   (author.username / author.name)
//   3  = DLive Emoji                  (same shape + link)
//   4  = Twitch Text                  (author.displayName)
//   5  = YouTube Text                 (author.displayName)
//   7  = YouTube Super Chat           (author.displayName + donation)
//   8  = YouTube Super Sticker        (author.displayName + donation.stickerId)
//   11 = Facebook Personal Text       (author.name)
//   12 = Facebook Personal Sticker    (author.name + link)
//   13 = Facebook Public Page Text    (author.name)
//   14 = Facebook Public Page Sticker (author.name + link)
//   21 = LinkedIn Text                (author.name)
//   22 = Trovo Text                   (author.name)
//   23 = YouTube Member Milestone     (author.displayName + memberMilestone)
//   24 = X Text                       (author.displayName)
//   25 = Kick Text                    (author.username)
//   26 = Kick Subscription            (author.username, no text — drops as no-text)
//   28 = YouTube Membership           (author.displayName + membership)
//   29 = YouTube Membership Gifting   (author.displayName + giftMemberships)
//   32 = Rumble Text                  (author.displayName / author.name)
// Note: Restream's Chat API does NOT carry a TikTok text event today; the
// platform is exposed only via guessPlatform fallback for legacy / unknown ids.
function mapEventTypeId(id: unknown): Platform | undefined {
  switch (id) {
    case 1:
      return 'unknown'; // Discord — no dedicated Platform yet, surface as 'unknown' for now
    case 2:
    case 3:
      return 'unknown'; // DLive — same; not in our Platform union
    case 4:
      return 'twitch';
    case 5:
    case 7:
    case 8:
    case 23:
    case 28:
    case 29:
      return 'youtube'; // Text / Super Chat / Super Sticker / Member Milestone / Membership / Gifting
    case 11:
    case 12:
    case 13:
    case 14:
      return 'facebook';
    case 21:
      return 'unknown'; // LinkedIn — no dedicated Platform yet
    case 22:
      return 'trovo';
    case 24:
      return 'x';
    case 25:
    case 26:
      return 'kick';
    case 32:
      return 'rumble';
    default:
      return undefined;
  }
}

/**
 * Map Restream's `eventSourceId` (per https://developers.restream.io/chat/event-sources)
 * to our Platform union. Used by reply_created handling; the event normaliser
 * uses `eventTypeId` instead since events carry more granular ids.
 *
 * Note: `eventSourceId: 1` is the special "Restream" pseudo-source used when
 * a reply targets ALL connections (common reply). Returning `undefined` for
 * id=1 lets the caller fall back to guessing from `connectionIdentifiers`.
 */
function mapEventSourceId(id: unknown): Platform | undefined {
  switch (id) {
    case 2:
      return 'twitch';
    case 13:
      return 'youtube';
    case 20:
      return 'facebook';
    case 24:
      return 'unknown'; // DLive
    case 25:
      return 'unknown'; // Discord
    case 26:
      return 'kick';
    case 27:
      return 'trovo';
    case 28:
      return 'x'; // Twitter / X live
    case 29:
      return 'rumble';
    case 30:
      return 'unknown'; // LinkedIn
    default:
      return undefined;
  }
}

/**
 * Best-effort platform extraction from a connectionIdentifier list — each
 * id is shaped "<userId>-<platform>-<channelId>" (e.g.
 * "5849342-youtube-inCvU1sYMI0"). Returns the first one that maps cleanly
 * to a known Platform; falls back to 'unknown'.
 *
 * We only use this for `reply_created` common replies where we don't have
 * a single destination platform — the message went to every connected
 * channel and the badge has to pick one. Tagging it with the first
 * recognised platform is a pragmatic default; the renderer marks it as
 * `self: true` so the user can tell it's their own outgoing message
 * regardless of which badge colour wins.
 */
function guessPlatformFromConnectionIds(ids: unknown): Platform {
  if (!Array.isArray(ids)) return 'unknown';
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const parts = id.split('-');
    if (parts.length < 2) continue;
    const platform = parts[1].toLowerCase();
    if (platform === 'twitch') return 'twitch';
    if (platform === 'youtube') return 'youtube';
    if (platform === 'facebook') return 'facebook';
    if (platform === 'kick') return 'kick';
    if (platform === 'trovo') return 'trovo';
    if (platform === 'rumble') return 'rumble';
    if (platform === 'tiktok') return 'tiktok';
    if (platform === 'twitter' || platform === 'x') return 'x';
  }
  return 'unknown';
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
