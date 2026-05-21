import type { ChatConnection } from '../shared/types';

/**
 * Coalesce / debounce window for "transient" per-channel status flips
 * (v0.1.46). Empirically, when RC++ first establishes its WS at startup
 * Restream's server cycles each platform connection through
 * `connected → connecting → connected` (sometimes twice) within ~1 second
 * — each cycle issues a fresh `connectionUuid`, so the server is genuinely
 * re-subscribing per platform during the initial boot storm. The renderer
 * faithfully painted every transition, so the channels-panel dropdown
 * looked like it was spazzing between green and yellow pills for the
 * first ~10s after launch before settling.
 *
 * Repro from `raw-frames.jsonl` 2026-05-21 13:40:53–13:41:04:
 *   t=0.0   youtube  → connected
 *   t=1.4   youtube  → connecting   (server re-sub)
 *   t=1.9   youtube  → connected
 *   t=9.2   youtube  → connecting   (server re-sub again)
 *   t=9.7   youtube  → connected    (final, stable)
 *
 * Fix: when a connection transitions FROM `connected` TO `connecting`
 * we hold the previous `connected` value visible for up to
 * `TRANSIENT_CONNECTING_HOLD_MS`. If the connection returns to
 * `connected` within that window we never paint the dip at all
 * (the user sees a steady "connected" through the server's flap). If
 * it's still `connecting` (or `error`) after the window elapses, we
 * flush the dip to the UI honestly.
 *
 * Other transitions (`connecting → connected`, anything → `error`,
 * `error → *`, new connections appearing, closed connections
 * disappearing) paint immediately — those are real signal, not flap.
 */
export const TRANSIENT_CONNECTING_HOLD_MS = 750;

/**
 * One in-flight "this connection has dipped to connecting; we're
 * holding the prior connected view in case it bounces back" record.
 * Tracked per `connectionIdentifier`. We snapshot the previous
 * `ChatConnection` so we can keep painting it during the hold window.
 */
export interface PendingDip {
  /** The connection as it was BEFORE the dip — what we keep painting. */
  prior: ChatConnection;
  /** The new (dipped) connection we're currently suppressing. */
  next: ChatConnection;
  /** ms epoch when the dip started — used to expire after the hold. */
  startedAt: number;
}

export type PendingDipsMap = Map<string, PendingDip>;

/**
 * Result of `reconcileStableConnections`:
 *
 * - `view`: the connections array the UI should actually render now
 *   (post-coalesce). Same shape as the upstream connections list — same
 *   sort order is preserved by leaving upstream sort to the caller.
 * - `pendingDips`: the new pending-dip map after this reconcile pass.
 *   Caller MUST persist this back (e.g. into a ref) so the next call
 *   knows which dips are still in-flight.
 * - `wakeAtMs`: the soonest ms-epoch timestamp at which the caller
 *   should re-run reconcile to honour a pending-dip expiry. `null`
 *   means there are no pending dips — no timer needed. Caller can use
 *   this to schedule a single `setTimeout(now - wakeAtMs)`.
 */
export interface StableConnectionsResult {
  view: ChatConnection[];
  pendingDips: PendingDipsMap;
  wakeAtMs: number | null;
}

/**
 * Pure reducer: given the freshest upstream `ChatConnection[]` and the
 * map of pending-dip suppressions carried over from the previous call,
 * compute (a) the connections list the UI should render, and (b) the
 * updated pending-dip map to carry into the next call.
 *
 * Determinism: this function takes `now` as an explicit argument so
 * tests can fast-forward without relying on real timers, and so a
 * single render pass observes a consistent timestamp for all entries.
 *
 * Algorithm per connection:
 *
 *   1. If we have a pending dip for this connectionIdentifier:
 *      a. If `now >= startedAt + HOLD_MS` → dip expired, flush the
 *         dipped value to the view and drop the entry.
 *      b. Else if the upstream is now back to `connected` → dip was
 *         transient, paint the dipped-but-now-recovered value as the
 *         steady connected, drop the entry (no flicker shown).
 *      c. Else if upstream changed but is still `connecting` /
 *         `error` → keep the dip record (re-snapshot `next` to the
 *         freshest upstream) but keep painting `prior`.
 *      d. Else (upstream unchanged from `next`) → keep painting
 *         `prior`.
 *
 *   2. No pending dip yet, and we have a `prev` array carrying the
 *      most-recent painted view:
 *      a. If prev had this id as `connected` AND upstream is now
 *         `connecting` → open a new pending dip; paint `prev`'s
 *         connected. (Don't suppress dips to `error`; errors are real
 *         signal.)
 *
 *   3. Otherwise → paint upstream directly.
 *
 * The `prev` parameter is the LAST VIEW the caller painted (not the
 * last upstream). This matters because if the caller already
 * suppressed a previous dip, `prev` carries the prior `connected`
 * shape — the same shape we want to keep painting through the new
 * dip — so successive dips during the same boot storm don't pop the
 * suppression.
 */
export function reconcileStableConnections(
  upstream: ChatConnection[],
  prev: ChatConnection[],
  pending: PendingDipsMap,
  now: number,
  holdMs: number = TRANSIENT_CONNECTING_HOLD_MS,
): StableConnectionsResult {
  const upstreamById = new Map<string, ChatConnection>();
  for (const c of upstream) upstreamById.set(c.connectionIdentifier, c);
  const prevById = new Map<string, ChatConnection>();
  for (const c of prev) prevById.set(c.connectionIdentifier, c);

  const nextPending: PendingDipsMap = new Map();
  const view: ChatConnection[] = [];
  let wakeAtMs: number | null = null;

  for (const c of upstream) {
    const id = c.connectionIdentifier;
    const dip = pending.get(id);
    const prior = prevById.get(id);

    if (dip) {
      const elapsed = now - dip.startedAt;
      if (elapsed >= holdMs) {
        // Dip held long enough — flush the latest upstream truthfully.
        view.push(c);
        continue;
      }
      if (c.status === 'connected') {
        // Bounced back within the hold window — suppress entirely.
        // Paint the freshest connected (which is `c` itself), drop dip.
        view.push(c);
        continue;
      }
      // Still in dipped (connecting/error) state — keep suppressing.
      // Refresh `next` to the freshest upstream so the eventual flush
      // shows current data, not a stale snapshot.
      nextPending.set(id, { prior: dip.prior, next: c, startedAt: dip.startedAt });
      view.push(dip.prior);
      const wake = dip.startedAt + holdMs;
      if (wakeAtMs === null || wake < wakeAtMs) wakeAtMs = wake;
      continue;
    }

    if (prior && prior.status === 'connected' && c.status === 'connecting') {
      // Brand-new dip — open a suppression and paint the prior.
      nextPending.set(id, { prior, next: c, startedAt: now });
      view.push(prior);
      const wake = now + holdMs;
      if (wakeAtMs === null || wake < wakeAtMs) wakeAtMs = wake;
      continue;
    }

    // No pending dip + not opening a new one → paint upstream as-is.
    view.push(c);
  }

  // Connections that were in `pending` but no longer appear upstream
  // (e.g. the channel got connection_closed) drop out naturally — we
  // don't carry their suppression forward and they're not in `view`.
  // This is the same behavior as the un-coalesced path.

  return { view, pendingDips: nextPending, wakeAtMs };
}
