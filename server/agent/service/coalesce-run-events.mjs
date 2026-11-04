/**
 * Coalesces consecutive text / thinking deltas in a run response into a single entry before
 * handing it over to the event writer.
 *
 * The model emits text in small chunks via streaming (measured average of 8 characters per chunk),
 * and previously each chunk was an event: under account mode, every event required a signed
 * request and ledger transaction across "task process → main service → document service". A
 * 40,000-character response produces over 5,000 events, while the document service can only
 * consume 1-2 per second; the page takes over an hour to finish viewing, and the document service
 * main thread remains fully occupied (measured 2026-10-17). Coalescing over a time interval or
 * emitting once every 4,000 characters requires only a few hundred events.
 *
 * The window was originally 250 ms, which still required writing 121-162 events for long responses
 * (measured 2026-10-22); relaxed to 1 second (user decision, 2026-10-22) ("relax the coalesce
 * window to 1 second along the way"), yielding about 44-54 events for the same response; text
 * on the page arrives at most 1 second later, showing no perceptible difference. The 4,000-character
 * threshold is not adjusted along with it [ruling:stream-cut 2026-10-22]: measured peak is ~190
 * token/s, which accumulates well under 4,000 characters in 1 second and is never reached in normal
 * streams; it only ensures an individual event does not get too large when the gateway emits a large
 * burst at once.
 *
 * Rules:
 * - Only coalesce adjacent deltas of the same type (`text` or `thinking`) whose fields are
 *   identical except for `delta`; when another event arrives, flush coalesced deltas first,
 *   preserving order;
 * - Flush coalesced deltas before `flush` / `beforeCall` / `receiptOf` (before model or tool calls,
 *   and before teardown, preceding text must have all been delivered);
 * - Returns `undefined` when coalescing those segments into one (callers only use the returned event
 *   id for terminal events).
 */
const MERGEABLE = new Set(['text', 'thinking']);

export const COALESCE_WINDOW_MS = 1000;
export const COALESCE_MAX_CHARS = 4000;

const extraOf = event => JSON.stringify(Object.keys(event).filter(k => k !== 'delta').sort().map(k => [k, event[k]]));

export function coalesceRunEvents(writer, { windowMs = COALESCE_WINDOW_MS, maxChars = COALESCE_MAX_CHARS,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = null, pendingExtra = null, timer = null;
  const drain = () => {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (!pending) return;
    const event = pending; pending = null; pendingExtra = null;
    writer.emit(event);
  };
  return {
    ...writer,
    emit(event) {
      const mergeable = event && MERGEABLE.has(event.type) && typeof event.delta === 'string';
      if (!mergeable) { drain(); return writer.emit(event); }
      const extra = extraOf(event);
      if (pending && pendingExtra === extra) pending = { ...pending, delta: pending.delta + event.delta };
      else { drain(); pending = { ...event }; pendingExtra = extra; }
      if (pending.delta.length >= maxChars) { drain(); return undefined; }
      if (timer === null) { timer = setTimer(drain, windowMs); timer?.unref?.(); }
      return undefined;
    },
    async flush() { drain(); return writer.flush(); },
    async beforeCall() { drain(); return writer.beforeCall(); },
    async receiptOf(eventId) { drain(); return writer.receiptOf(eventId); },
  };
}
