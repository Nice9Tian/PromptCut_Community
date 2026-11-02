/**
 * Renew read-only ticket for frame-by-frame export (C10 contract Section 12, Section 18 Item 5).
 *
 * Frame-by-frame export on online pages (c10a contract Section 11.1) may take longer than the
 * read-only ticket lifetime (15 minutes). Renew **in advance** during export based on the limit,
 * without interruptions or errors:
 *
 *   - `start()` fetches the first ticket (returns Promise); `ticket()` synchronously returns the
 *     current ticket (read when export page loads assets on each frame); `stop()` cleans up;
 *   - Renew each ticket when one-third of its lifetime remains (same timing as the page's
 *     `assetTicketSource`);
 *   - If renewal fails, do not replace the old one (keep using it if not expired), retry before
 *     expiration: every `RENEW_RETRY_MS`, and no later than `RENEW_MARGIN_MS` before expiration;
 *   - Ticket fetching reuses the page's existing `assetTicketSource`
 *     (`src/editor/media/assetTiers.ts`), injected by caller via `fetchTicket`.
 *
 * Uses global `setTimeout` (unit tests advance time using `mock.timers`).
 */

export interface TicketInfo { ticket: string; exp: number }

/** Renew when this ratio of lifetime remains */
export const RENEW_AT_REMAINING = 1 / 3;
/** How long to wait before retrying after renewal failure */
export const RENEW_RETRY_MS = 5_000;
/** Retry at the latest this long before expiration */
export const RENEW_MARGIN_MS = 1_000;

export interface TicketRenewer {
  start(): Promise<string | null>;
  ticket(): string | null;
  stop(): void;
  /** Probe view: renewal count, failure count, and when the current ticket expires */
  stats(): { renewals: number; failures: number; exp: number | null };
}

export function createTicketRenewer({ fetchTicket, now = Date.now }: { fetchTicket: () => Promise<TicketInfo | null>; now?: () => number }): TicketRenewer {
  let cur: TicketInfo | null = null;
  let issuedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let renewals = 0;
  let failures = 0;

  const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const at = (ms: number, fn: () => void) => {
    clear();
    if (stopped) return;
    timer = setTimeout(() => { timer = null; fn(); }, Math.max(0, ms));
  };

  /** Next renewal time: when one-third of lifetime remains */
  const scheduleRenew = () => {
    if (!cur) return;
    const life = Math.max(0, cur.exp - issuedAt);
    const renewAt = cur.exp - life * RENEW_AT_REMAINING;
    at(renewAt - now(), () => { void renew(); });
  };

  /** Renewal failed: retry before expiration (no later than RENEW_MARGIN_MS before expiration) */
  const scheduleRetry = () => {
    const left = cur ? cur.exp - now() : 0;
    const wait = cur && left > RENEW_MARGIN_MS ? Math.min(RENEW_RETRY_MS, left - RENEW_MARGIN_MS) : RENEW_RETRY_MS;
    at(wait, () => { void renew(); });
  };

  const accept = (t: TicketInfo | null): boolean => {
    if (!t || typeof t.ticket !== "string" || !t.ticket || !Number.isFinite(t.exp)) return false;
    // Retrieved ticket is still the same one (source still using cache): not renewed, retry later
    if (cur && t.ticket === cur.ticket && t.exp <= cur.exp) return false;
    cur = { ticket: t.ticket, exp: t.exp };
    issuedAt = now();
    return true;
  };

  const renew = async () => {
    if (stopped) return;
    let t: TicketInfo | null = null;
    try { t = await fetchTicket(); } catch { t = null; }
    if (stopped) return;
    if (accept(t)) { renewals++; scheduleRenew(); }
    else { failures++; scheduleRetry(); }
  };

  return {
    async start() {
      stopped = false;
      let t: TicketInfo | null = null;
      try { t = await fetchTicket(); } catch { t = null; }
      if (stopped) return null;
      if (accept(t)) scheduleRenew();
      else { failures++; scheduleRetry(); }
      return cur?.ticket ?? null;
    },
    ticket: () => cur?.ticket ?? null,
    stop() { stopped = true; clear(); },
    stats: () => ({ renewals, failures, exp: cur?.exp ?? null }),
  };
}

/** Replace read-only ticket (`?t=` / `&t=`) in asset URL with this one; keep unchanged if no ticket */
export function withTicket(url: string, ticket: string | null): string {
  if (!ticket || !url) return url;
  const m = /([?&])t=[^&#]*/.exec(url);
  if (!m) return url;
  return url.slice(0, m.index) + `${m[1]}t=${encodeURIComponent(ticket)}` + url.slice(m.index + m[0].length);
}
