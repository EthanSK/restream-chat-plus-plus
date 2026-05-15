import type { ChatMessage, Platform } from '../shared/types';

/**
 * Normalize a raw Restream WebSocket event into a ChatMessage, or return
 * undefined if the event isn't a chat-message event.
 *
 * Restream emits events as { action: "event", payload: { eventTypeId, eventPayload } }.
 * For chat messages eventTypeId is typically 24 (Twitch), 4 (YouTube), 8 (Facebook), etc.
 * The eventPayload shape varies per source; we map the common ones below.
 */
export function normalizeRestreamEvent(raw: unknown): ChatMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, any>;

  // The Restream Chat WS protocol sends "event"-action envelopes.
  if (r.action && r.action !== 'event') return undefined;

  const payload =
    r.payload?.eventPayload ?? r.eventPayload ?? r.payload ?? r;
  const eventTypeId = r.payload?.eventTypeId ?? r.eventTypeId;

  if (!payload || typeof payload !== 'object') return undefined;

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
  if (!text || typeof text !== 'string') return undefined;
  const ts = payload.timestamp ?? payload.createdAt ?? Date.now();
  const id =
    payload.id ??
    payload.messageId ??
    payload.eventIdentifier ??
    `${platform}-${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const color =
    payload.author?.color ?? payload.color ?? undefined;
  return {
    id: String(id),
    platform,
    username: String(username),
    text: String(text),
    ts: typeof ts === 'string' ? Date.parse(ts) || Date.now() : Number(ts) || Date.now(),
    color,
    raw,
  };
}

// Restream documents numeric eventTypeIds per platform; this list covers the
// publicly-shared ones. Unknown ids fall through to platform inference.
function mapEventTypeId(id: unknown): Platform | undefined {
  switch (id) {
    case 4:
      return 'youtube';
    case 8:
      return 'facebook';
    case 13:
      return 'trovo';
    case 22:
      return 'rumble';
    case 24:
      return 'twitch';
    case 25:
      return 'kick';
    case 28:
      return 'tiktok';
    case 30:
      return 'x';
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
