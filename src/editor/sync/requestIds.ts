/** No reply received (network down, timeout, peer did not answer): the error thrown by the page's account requests then has `status` 0 (`AccountFailure(0, 'network')` in `client.ts`) */
const noReply = (error: unknown) => (error as { status?: unknown } | null)?.status === 0;

/**
 * A small ledger for "when the same action gets no reply and is clicked again, reuse the original request
 * ID" (the server recognizes the same action by request ID, so it does not record one more entry or
 * spend one more request attempt).
 *
 * Request IDs are looked up by action key (for example `approve-join:<request ID>`,
 * `send:<project ID>`):
 *   - No reply received (network error, `status` 0): keep it, the next click is a retry with the same
 *     request ID.
 *   - In every other case drop it, and the next click counts as a new action: success; the server
 *     replied with an explicit error (already handled, attempts used up...); any other error (the
 *     request was not sent, or the reply did not match the protocol).
 *
 * Where this one copy is shared: "Approve" and "Reject" in the member popover and member panel (desktop
 * `AccountMembersPanel.tsx`, mobile app `src/mobile/sheets.tsx`), "Send request" on the start page
 * (`useAccountProjects.ts`), "Send request" in the reopen-file prompt
 * (`src/editor/sync/recoveryAssociation.ts`).
 * Tests exercise this one copy directly (JRC-3 in `joinRequest.test.mjs`, RJR-2 in
 * `reopenJoinRequest.test.mjs`), without writing a separate one inside the tests.
 */
export function createRequestIds(newId: () => string = () => crypto.randomUUID()) {
  const ids = new Map<string, string>();
  return {
    /** The request ID kept for this action (the one that got no reply and is waiting for a retry); undefined if there is none */
    pending(key: string): string | undefined { return ids.get(key); },
    /** Runs with the request ID this action should use: starts a new one if there is none; the rules above decide whether to drop it or keep it */
    async run<T>(key: string, operation: (requestId: string) => Promise<T>): Promise<T> {
      let requestId = ids.get(key);
      if (!requestId) { requestId = newId(); ids.set(key, requestId); }
      try {
        const value = await operation(requestId);
        if (ids.get(key) === requestId) ids.delete(key);
        return value;
      } catch (error) {
        if (!noReply(error) && ids.get(key) === requestId) ids.delete(key);
        throw error;
      }
    },
    /** Drops one (all of them if no key is given), for example after changing the project link or logging out */
    forget(key?: string) { if (key === undefined) ids.clear(); else ids.delete(key); },
  };
}
export type RequestIds = ReturnType<typeof createRequestIds>;
