/**
 * Lifetime of the page's document connection inside an account cloud project (used by `enterAccountProject` in
 * `syncManager.ts`; the online page and the desktop app take the same path).
 *
 * Every message on the account connection passes a gate. The gate asks the account service using the access token
 * behind the ticket that was used to open the connection. Once the access token expires (120 seconds; the ticket's
 * `expiresAt` is that moment), the connection stays open but every message gets "credential expired", and renewing
 * the token cannot save this connection (measured results are in the header of `server/account-card-link.mjs`).
 * So before expiry the page has to switch to a session built from a new ticket. This module only decides "when to
 * switch, and what to do if switching fails"; how to switch is in `renew()` in `link.ts`:
 *
 * - **Every ticket must last long enough**: when fetching a session, require the access token behind it to have at
 *   least `MIN_TICKET_LIFE_MS` left; if not, the client renews the token first (`minRemainingMs` of
 *   `client.session`).
 * - **Switch before expiry**: `tick()` (the caller invokes it every few seconds; it reads the wall clock) switches
 *   as soon as it finds less than `RENEW_MARGIN_MS` left before expiry. It reads the wall clock instead of setting
 *   one long timer so that, right after the computer wakes from sleep, the first call can notice "it expired long
 *   ago". Consecutive switches are at least `MIN_RENEW_GAP_MS` apart.
 * - **Switch fails**: if the account service is briefly unreachable, the next `tick()` tries again; if it still
 *   has not succeeded when the expiry moment arrives, the connection is broken: call `link.expire()` to handle it
 *   like a disconnect (the page goes offline, changes go into the offline queue, and it reconnects like an ordinary
 *   disconnect), so the page never shows online while writes cannot get through. The same applies when the ticket
 *   request hangs without a reply: once `busy` lasts longer than `BUSY_EXPIRE_MS` after expiry, call `expire()`
 *   without waiting for it. Login invalidation or being kicked (the session endpoint returns 401 / 403) goes to
 *   `onTerminal`, and the caller wraps up the way it already does.
 * - **Found already expired** (after waking from sleep; or the document service replied "credential expired",
 *   `authExpired()`): **do not switch, call `expire()` directly**. The document service did not accept changes made
 *   during the expired period, so they must re-enter under the offline rules: after reconnecting, the first
 *   message carries the expected version, and if someone else changed things in the meantime, stop and ask the user
 *   (semantics, `product/document-service.md`, "Conflicts": a temporary offline re-entry must not silently
 *   overwrite). The same applies when the transport has already detached (is resuming): `renew()` itself does not
 *   switch.
 * - **Permission changed** (`accessSeen`): when read-only becomes writable, switch to a new session so the new
 *   connection can write; if busy, record it and do one more round when done.
 *
 * **Inaccurate local clock**: the expiry moment is the document service's clock, and here it is compared against
 * the local clock. At the moment the ticket is obtained, compute how long it has "left": we asked for at least 60
 * seconds, and if the computed value falls short (`RENEW_MARGIN_MS` + `SKEW_SLACK_MS`), the local clock can only be
 * fast. The ticket's expiry moment is then untrustworthy, so count it as "`MIN_TICKET_LIFE_MS` from now", and do
 * not judge it expired by the local clock either (expiry is decided by the document service's "credential
 * expired"). When the local clock is 90-120 seconds fast, the effect is switching sessions about every 30 seconds
 * (not every 3 seconds). The place where the client renews its own access token (`ensureLogin` in `client.ts`)
 * still follows the local clock and will renew the token more often than normal. On the slow-clock side, the
 * ticket's real lifetime is shorter than computed, and the document service's "credential expired" reply covers it.
 */

/** Switch sessions when less than this much time is left before expiry */
export const RENEW_MARGIN_MS = 30_000;
/** When fetching a ticket, the access token behind it must have at least this much left (larger than `RENEW_MARGIN_MS`, so a new session is not already due for a switch right after it is built) */
export const MIN_TICKET_LIFE_MS = 60_000;
/** Minimum gap between two planned session switches (so an inaccurate clock or an abnormally short ticket lifetime does not cause back-to-back switches) */
export const MIN_RENEW_GAP_MS = 20_000;
/** If the remaining lifetime computed for the fetched ticket exceeds `RENEW_MARGIN_MS` by less than this: the local clock is untrustworthy */
export const SKEW_SLACK_MS = 10_000;
/** After expiry, if the session switch step (fetching a ticket, building a new session) has not returned for longer than this: stop waiting and treat the connection as void */
export const BUSY_EXPIRE_MS = 5_000;

export interface AccountLinkLifeOptions {
  /** Fetch a new project session, requiring the access token behind it to have at least `minRemainingMs` left (`CloudAccountClient.session`) */
  session: (o: { minRemainingMs: number }) => Promise<{ connectionTicket: string; expiresAt: number }>;
  /** The page's connection (the part used in `SyncLink`) */
  link: () => { readonly connected: boolean; renew(): Promise<boolean>; expire(reason?: string): void } | null;
  /** Login invalidated, kicked, not on the list: do not retry */
  onTerminal: (error: unknown) => void;
  now?: () => number;
  renewMarginMs?: number;
  minTicketLifeMs?: number;
  minRenewGapMs?: number;
}

export type TickResult = "idle" | "busy" | "renewed" | "retry" | "expired" | "terminal";

const isTerminal = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
};

export function createAccountLinkLife(o: AccountLinkLifeOptions) {
  const now = o.now ?? Date.now;
  const margin = o.renewMarginMs ?? RENEW_MARGIN_MS;
  const minLife = o.minTicketLifeMs ?? MIN_TICKET_LIFE_MS;
  const minGap = o.minRenewGapMs ?? MIN_RENEW_GAP_MS;
  /** The most recently fetched ticket: until when (local clock) and whether that moment is trustworthy; recorded as the current connection's when the connection is built (or switched) */
  let issued: { at: number; trusted: boolean } | null = null;
  let active: { at: number; trusted: boolean } | null = null;
  let busySince: number | null = null;
  let lastRenewAt = -Infinity;
  let renews = 0;
  let expires = 0;
  let knownAccess: string | null = null;
  /** Incremented on every permission change; `handledSeq` is the change already accounted for when the ticket was fetched. Unequal = one session switch still owed (it was busy when the change happened) */
  let accessSeq = 0;
  let handledSeq = 0;

  function expire(link: { expire(reason?: string): void }): "expired" {
    expires += 1;
    active = null;
    link.expire();
    return "expired";
  }

  /** Do one switch. Returns: switched / not switched (can retry) / terminal */
  async function swap(): Promise<"renewed" | "retry" | "terminal"> {
    const link = o.link();
    if (!link) return "retry";
    busySince = now();
    const seq = accessSeq;
    try {
      if (await link.renew()) { renews += 1; lastRenewAt = now(); handledSeq = seq; return "renewed"; }
      return "retry";
    } catch (error) {
      if (isTerminal(error)) { o.onTerminal(error); return "terminal"; }
      return "retry";
    } finally { busySince = null; }
  }

  return {
    /** `protocols` of `SyncLink`: fetch a ticket on demand for every session build (including session switches). If `first` is given, use it (the session already fetched when entering the project) */
    async ticket(first?: { connectionTicket: string; expiresAt: number } | null): Promise<string> {
      const s = first && first.expiresAt - now() >= minLife ? first : await o.session({ minRemainingMs: minLife });
      const life = s.expiresAt - now();
      // We need at least minLife; if the computed value does not even cover the "lead time for switching", the local clock is fast: the expiry moment is untrustworthy, so count minLife from now
      issued = life >= margin + SKEW_SLACK_MS ? { at: s.expiresAt, trusted: true } : { at: now() + minLife, trusted: false };
      return s.connectionTicket;
    },
    /** The session was built (newly or by switching): the current connection can use that ticket until it expires */
    opened(): void {
      active = issued;
    },
    /** The caller invokes this every few seconds. Per user decision, 2026-10-14: an already-built connection no longer expires by time and is not polled; invalidation is always notified actively by the account service. */
    async tick(): Promise<TickResult> {
      const link = o.link();
      if (busySince !== null) return "busy";
      // With no session (reconnecting after a disconnect), do nothing: the reconnect path builds its session from a new ticket anyway
      if (!link || !link.connected || active === null) return "idle";
      // Only a permission change (e.g. read-only to writable) requires a session switch
      if (accessSeq !== handledSeq && now() - lastRenewAt >= minGap) {
        return swap();
      }
      return "idle";
    },
    /** The document service replied "credential expired": this connection can no longer write. Do not switch (same reason as above), handle it as a disconnect */
    async authExpired(): Promise<TickResult> {
      const link = o.link();
      if (!link || !link.connected) return "idle";
      return expire(link);
    },
    /**
     * The caller reports every time it reads the permission (`r` / `rw`) from the session. A connection's permission
     * is the one on the ticket used to build it, and the document service checks against it when changing a project:
     * when the permission is raised (read-only to writable), the server does not close the old connection, which stays
     * read-only forever, so when a permission change is found, switch to a new session.
     * (When the permission is lowered, the server closes the old connection itself and the page reconnects like a
     * disconnect.) If busy, record it, and the next `tick()` makes up the switch.
     */
    async accessSeen(access: string): Promise<TickResult> {
      const before = knownAccess;
      knownAccess = access;
      if (before === null || before === access) return "idle";
      const link = o.link();
      if (!link || !link.connected) return "idle";
      accessSeq += 1;
      if (busySince !== null) return "busy";
      return swap();
    },
    /** Diagnostics */
    describe: () => ({ expiresAt: active?.at ?? null, trusted: active?.trusted ?? null, renews, expires, busy: busySince !== null }),
  };
}

export type AccountLinkLife = ReturnType<typeof createAccountLinkLife>;
