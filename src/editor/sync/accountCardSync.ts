import { tr } from "../../i18n/index.ts";
/**
 * How to answer when card source sync asks the page for a connection ticket in an account cloud
 * project (desktop app; `hooks.ticket` of `cardSync.ts`).
 *
 * The editor process has no login of its own: each time it creates a new session, it asks the page via
 * HMR for a ticket (a resume carries no ticket; the server re-verifies the identity in the session).
 * In old shared projects the page signs on its own connection (`auth.ticket`); on an account connection
 * that message is always rejected, so here it instead uses the page's login to fetch another session
 * from the account session API (`/hosted/shared/account/session`, a path the desktop shell's account
 * bridge already allows) and uses the connection ticket in it.
 * The ticket's role is still page, and its permission is this member's permission at this moment
 * (a ticket held by a read-only member cannot write to the content store); there is no new role, and
 * it does not claim an identity.
 * Along with the ticket it hands over its expiry time: the account connection is usable only until then
 * (the lifetime of the access token, see `server/account-card-link.mjs`), and the editor process swaps
 * the session early accordingly.
 *
 * Stop:
 * - This page is no longer in this project (switched project, logged out and changed account, connection
 *   judged invalid) → do not fetch a ticket, unbind;
 * - The session API returns 401 (login expired), 403 (kicked, not on the list), 404 (project gone)
 *   → unbind. After unbinding the editor process returns to the local space and does not retry.
 * - Other failures (network down, service temporarily unavailable) only throw, and the editor process
 *   asks again after backing off.
 *
 * This module does not import `cardSync.ts` (it has special rules in the card hot-update chain), so the
 * caller provides the unbinding.
 */
export interface AccountCardTicketOptions {
  /** Fetch a new project session with the login (`CloudAccountClient.session`) */
  session: (projectId: string) => Promise<{ connectionTicket: string; expiresAt: number }>;
  /** This page is still in this account project, and the login is still the account it entered with */
  isCurrent: () => boolean;
  /** Unbind card source sync (the editor process returns to the local space) */
  stop: () => void;
}

/** Login expired, no permission, project does not exist: retrying will not succeed */
export function isTerminalAccountFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403 || status === 404;
}

export function accountCardTicket(o: AccountCardTicketOptions): (projectId: string) => Promise<{ ticket: string; expiresAt: number }> {
  const gone = (): never => {
    o.stop();
    throw new Error(tr("This page is no longer in this cloud project"));
  };
  return async (projectId) => {
    if (!o.isCurrent()) gone();
    let ticket: { ticket: string; expiresAt: number };
    try {
      const session = await o.session(projectId);
      ticket = { ticket: session.connectionTicket, expiresAt: session.expiresAt };
    } catch (error) {
      if (isTerminalAccountFailure(error)) o.stop();
      throw error;
    }
    // The page may have left while the ticket was being fetched: do not hand the ticket over
    if (!o.isCurrent()) gone();
    return ticket;
  };
}
