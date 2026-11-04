/**
 * When the WebSocket was not established while entering a shared project, decide which kind of
 * failure it is (`claude/join-error`).
 *
 * In a browser, a handshake rejected by the server with 401 looks the same as a wrong certificate, a
 * proxy blocking the upgrade, or an unreachable network: all are "dropped before opening, close code
 * 1006". It used to always be judged as auth, so the page said "wrong username or password" and sent
 * people who could not connect off to change their password. Now, when entry fails, we get a fresh
 * proof and ask `shared/verify` once [ruling] (the same authentication as the handshake):
 * - The server clearly says it does not recognize it (401) → auth (a kicked user is still reported as
 *   kicked);
 * - The server recognizes the proof → the account and password are fine, the connection simply was not
 *   established → unreachable;
 * - Rate-limited while getting a new proof or asking → rate-limited; project gone → no-project; no
 *   answer (network error, 5xx) → unreachable;
 * - The server has no such endpoint (404, an old service not yet upgraded) → judged auth / kicked as
 *   before, no worse than before.
 * A timeout (15 s without connecting or disconnecting) is unreachable as before; receiving 4004
 * before opening means the project is gone.
 *
 * Pure logic, knows nothing about the store or the UI; unit tests are in `enterFailure.test.mjs`.
 */
import type { CloseInfo } from "./link";

export type EnterFailure =
  | { error: "auth" | "kicked" | "unreachable" | "no-project" }
  | { error: "rate-limited"; retryAfter: number | null };

export interface EnterFailureDeps {
  /** Fetch a fresh proof (subprotocol list); on failure throw the shared endpoint's error (with status) */
  fresh: () => Promise<string[]>;
  /** Ask the server whether it accepts this proof: true if accepted, false on 401, anything else throws (with status; network errors have none) */
  verify: (protocols: string[]) => Promise<boolean>;
  /** This username was kicked from this project (recorded locally) */
  wasKicked: () => boolean;
}

function statusOf(e: unknown): { status: number | null; retryAfter: number | null } {
  const err = e as { status?: unknown; retryAfter?: unknown };
  return {
    status: typeof err?.status === "number" ? err.status : null,
    retryAfter: typeof err?.retryAfter === "number" && err.retryAfter > 0 ? err.retryAfter : null,
  };
}

/** The trusted challenge/discovery endpoint explicitly refused; do not treat it as an ordinary network drop and reconnect forever. */
export function classifyProtocolError(e: unknown): "auth" | "kicked" | "no-project" | null {
  const { status } = statusOf(e);
  const reason = (e as { reason?: unknown })?.reason;
  if (status === 404 || status === 410 || reason === "deleted" || reason === "no-project") return "no-project";
  if (status === 403 || reason === "banned" || reason === "kicked" || reason === "removed") return "kicked";
  if (status === 401 || reason === "auth" || reason === "unauthorized") return "auth";
  return null;
}

export async function classifyEnterFailure(outcome: CloseInfo, deps: EnterFailureDeps): Promise<EnterFailure> {
  const denied = (): EnterFailure => ({ error: deps.wasKicked() ? "kicked" : "auth" });
  if (outcome.reason === "timeout") return { error: "unreachable" };
  if (outcome.code === 4004) return { error: "no-project" };
  let protocols: string[];
  try {
    protocols = await deps.fresh();
  } catch (e) {
    const { status, retryAfter } = statusOf(e);
    if (status === 429) return { error: "rate-limited", retryAfter };
    const terminal = classifyProtocolError(e);
    if (terminal) return { error: terminal };
    return { error: "unreachable" };
  }
  try {
    return (await deps.verify(protocols)) ? { error: "unreachable" } : denied();
  } catch (e) {
    const { status, retryAfter } = statusOf(e);
    if (status === 429) return { error: "rate-limited", retryAfter };
    if (status === 404 || status === 405) return denied();
    return { error: "unreachable" };
  }
}
