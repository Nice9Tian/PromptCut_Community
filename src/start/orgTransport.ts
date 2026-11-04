/**
 * Adapts the account client (`getStartOrg` / `putStartOrg` in `src/account/client.ts`) into the
 * `OrgTransport` the sync engine needs (`orgSync.ts`).
 * It does one thing only: **if the server has no such route (old server), it is translated into
 * `OrgUnsupportedError`**, so the UI quietly falls back to recording only locally;
 * other errors (cannot connect, token expired, 5xx) are thrown as is, and the engine retries them as
 * "pending sync". A conflict (409) is already returned by the client as a result; it is passed to the
 * engine unchanged here.
 * Unit test: `orgTransport.test.mjs`.
 */
import { OrgUnsupportedError, type OrgTransport, type PutResult, type RemoteOrg } from "./orgSync.ts";
import type { OrgState } from "./vibeOrg.ts";
import { tr } from "../i18n/index.ts";

/** The two account client methods used here (structural type; fakes are used in unit tests) */
export interface StartOrgApi {
  getStartOrg(): Promise<{ version: number; org: unknown | null }>;
  putStartOrg(baseVersion: number, org: unknown): Promise<PutResult>;
}

/** Whether this failure means "the server has no such route": the route does not exist (404 / 405 / 501,
 * no-route), or this deployment has no storage configured (org-unavailable) */
export function isUnsupported(e: unknown): boolean {
  const x = e as { status?: unknown; code?: unknown } | null;
  if (!x || typeof x !== "object") return false;
  return x.status === 404 || x.status === 405 || x.status === 501 || x.code === "no-route" || x.code === "org-unavailable";
}

/** `api` is a function that gets the client: before login there is no client yet; when it returns null,
 * throw a plain error (the engine treats it as pending sync) */
export function accountOrgTransport(api: () => StartOrgApi | null): OrgTransport {
  const need = (): StartOrgApi => {
    const a = api();
    if (!a) throw new Error(tr("The account service isn't ready yet"));
    return a;
  };
  const wrap = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (e) {
      throw isUnsupported(e) ? new OrgUnsupportedError() : e;
    }
  };
  return {
    get: (): Promise<RemoteOrg> => wrap(() => need().getStartOrg()),
    put: (baseVersion: number, org: OrgState): Promise<PutResult> => wrap(() => need().putStartOrg(baseVersion, org)),
  };
}
