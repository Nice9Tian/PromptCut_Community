/**
 * One **session** from the page to the document service, plus one DocSync on that session (c65-design.md
 * section 4, "Page side"; for sessions see `docs/plan/http-transport-contract.md` sections 3, 4 and 9).
 *
 * - Session: `createDocEndpoint` in `server/render-node/session-link.mjs`. This phase (HT-a) only uses
 *   WebSocket. An endpoint runs exactly one session (`renew: false`): when the transport drops (network
 *   switch, proxy cut, sleep), the session layer resumes it, and unacknowledged commits and requests are
 *   resent in order, invisible to this file and to DocSync. Only the end of the session (closed by the
 *   server, or not resumed within the retention window) counts as a disconnect.
 * - Disconnect and reconnect: the subprotocol is fetched fresh before every session is built (in the proof
 *   for a shared project the nonce can be used only once). After a disconnect the session is rebuilt with
 *   backoff (starting at 0.5 s, doubling, up to 5 s). When built, call `ds.connect()` (`project.open` again,
 *   resend unacknowledged commits); on disconnect, call `ds.disconnect()`.
 * - Dispatch: `project.*` goes to DocSync; a reply carrying `reqId` goes to the `request()` waiting for it;
 *   everything else (`shared.*`, `events.*`, `error`, etc.) goes to `onMessage`.
 * - Close codes 4003 (`kicked` / `removed`) and 4004 (`deleted`) are the result of creator actions (contract
 *   `auth-contract.md` section 7). No reconnect follows, and `onClosed` tells the UI to show a blocking
 *   dialog. If the session ended with one of these two codes while the transport was detached, the session
 *   layer restores the 4410 it got on resume to the original close code and reports it (`FINAL_CLOSE` in
 *   `session-link.mjs`, consistent with `FATAL_CLOSE` in this file), so the UI still shows the dialog.
 *
 * - Planned session swap (`renew()`, for account cloud projects): an account connection can only be used
 *   until the access token behind its ticket expires. Before expiry, the new session is built first with a
 *   new ticket and switched to the moment it is ready (`ds.handover()`: no offline record, unacknowledged
 *   commits are resent on the new session). A request on the old session that is not waiting for a reply
 *   is closed on the spot (the document service keeps state such as selection and presence per connection,
 *   and two connections coexisting for long would be treated as two pages); otherwise it is kept until the
 *   replies arrive, for at most `RENEW_RETIRE_MS`. The swap happens only while the old session still works.
 *   If the old session is already invalid or the transport is detached, no swap is done and the caller
 *   calls `expire()`: it is handled as a disconnect and goes through the reconnect above (that path
 *   carries the version check for offline batches). When the document service replies with an `error`
 *   saying "credential expired", it tells the caller through `onAuthExpired`.
 *
 * It knows nothing about the store or the UI: it works in both the browser and Node (tests), and WebSocket
 * can be injected.
 */
import { DocSync, type LocalBackup, type ServerMsg } from "../../store/docsync";
import type { Project } from "../../kernel/project";
// @ts-expect-error untyped .mjs (shared by browser and Node, uses only WebSocket and timers)
import { createDocEndpoint as createDocEndpointUntyped } from "../../../server/render-node/session-link.mjs";
import { tr } from "../../i18n/index.ts";

/** Any message sent by the document service */
export type AnyMsg = { type: string; reqId?: string | number; [k: string]: unknown };

export interface CloseInfo {
  code: number;
  reason: string;
  /** 4003 / 4004: no reconnect */
  fatal: boolean;
  /** This connection has never connected (for a shared project, a rejected handshake looks like this in the browser) */
  neverOpened: boolean;
}

type WsLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", cb: (ev: unknown) => void): void;
};
type WsCtor = new (url: string, protocols?: string | string[]) => WsLike;

/** Endpoint diagnostics (the part of `stats()` from `createDocEndpoint` that the page uses) */
export interface LinkStats {
  transport: "ws" | "http" | null;
  resumes: number;
  pendingBytes: number;
  legacy: boolean;
  detached: boolean;
  [k: string]: unknown;
}

/** The part of the `createDocEndpoint` return value that the page uses */
interface DocEndpoint {
  send(message: object): boolean;
  onMessage(handler: (message: AnyMsg) => void): void;
  onOpen(handler: () => void): void;
  onResume(handler: () => void): void;
  onClose(handler: (info: { code: number; reason: string }) => void): void;
  onConnectFail(handler: (info: { code: number; reason: string }) => void): void;
  close(): void;
  dropTransport(): boolean;
  readonly connected: boolean;
  readonly closed: boolean;
  stats(): LinkStats;
}
const createDocEndpoint = createDocEndpointUntyped as (options: {
  url: string;
  protocols: () => string[];
  resumeProtocols?: () => Promise<string[]> | string[];
  WebSocket?: WsCtor;
  transport: "ws";
  renew: false;
  backoff: { baseMs: number; factor: number; maxMs: number; jitter: number };
  maxPendingBytes: number;
}) => DocEndpoint;

/**
 * Limit on unacknowledged outbound data from the page. Contract section 3.4 gives 1 MiB; but the page's
 * chunked root-replacement upload (`project.upload`, up to 64 chunks × 128 Ki characters) sends several MiB
 * in one go and exceeds 1 MiB before the first acknowledgment comes back. The session then ends itself with
 * 1013, is rebuilt, resends, and exceeds the limit again. So the page relaxes it to 32 MiB (stated in the
 * report `docs/archive/agent-reports/AGENT-ht-client.md`, pending a contract decision).
 */
export const PAGE_MAX_PENDING_BYTES = 32 * 1024 * 1024;

export interface LinkOptions {
  docSync?: DocSync;
  initialize?: boolean;
  url: string;
  protocols: () => Promise<string[]> | string[];
  resumeProtocols?: () => Promise<string[]> | string[];
  projectId: string;
  session: string;
  initial: Project;
  saveBackup?: (b: LocalBackup) => void;
  onMessage?: (msg: AnyMsg) => void;
  /** Validate delegated tickets before a caller can use them through a relay. */
  onResponse?: (msg: AnyMsg) => Promise<void>;
  onOpen?: () => void;
  /** The transport dropped and was resumed within the retention window (the session did not end, no need to resubscribe) */
  onResume?: () => void;
  onClosed?: (info: CloseInfo) => void;
  /** The endpoint explicitly refused when the auth proof was fetched again; return true to terminate this connection and stop blind retries. */
  onProtocolError?: (error: unknown) => boolean;
  /**
   * The document service replied "credential expired" to a message on this connection (`error`, reason
   * `credential-revoked` / `authorization-expired`): the access token behind this connection has expired, and
   * anything sent afterwards is rejected. The caller uses this to swap the session (`renew()`), or `expire()`
   * if that fails.
   */
  onAuthExpired?: (reason: string) => void;
  /**
   * Whether this close code means "do not reconnect". Default: 4003 (kicked, removed) and 4004 (project
   * deleted). Account cloud projects pass `() => false`: there 4003 is also used for "permissions changed,
   * please re-enter" (the server closes the old connection when write access changes to read-only), and
   * whether to reconnect is decided by the ticket endpoint (kicked 403, login expired 401, project gone 404
   * → `onProtocolError` terminates), not by the close code.
   */
  isFatalClose?: (code: number, reason: string) => boolean;
  WebSocketImpl?: WsCtor;
  reconnect?: { minMs: number; maxMs: number };
}

export const FATAL_CLOSE = new Set([4003, 4004]);
/** The gate replied with one of these two reasons: the access token behind the connection has expired (or the login was revoked), and this connection can never write again */
export const AUTH_EXPIRED_REASONS = new Set(["credential-revoked", "authorization-expired"]);
/** Session swap: how long a new session may take to build before this swap counts as failed */
export const RENEW_OPEN_TIMEOUT_MS = 15_000;
/** Session swap: after the new session is built, the longest to wait for unacknowledged commits on the old session to settle (switching after they settle is cleanest; if they do not, switch anyway and resend the unacknowledged ones on the new session) */
export const RENEW_SETTLE_MS = 8_000;
/** Session swap: the longest to keep the old session when it still has requests waiting for replies */
export const RENEW_RETIRE_MS = 5_000;
/** The close code that `expire()` reports to `onClosed` (this side decided the connection is invalid; not sent by the document service) */
export const CLOSE_EXPIRED = 4401;

let reqSeq = 0;

export class SyncLink {
  readonly ds: DocSync;
  private readonly o: LinkOptions;
  private ep: DocEndpoint | null = null;
  private dialing = false;
  private open = false;
  private everOpened = false;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private delay: number;
  private waiting = new Map<string, { resolve: (m: AnyMsg) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** The old session that was swapped out: kept only to receive the replies to requests sent before the swap (`left`), closed once done, for at most `RENEW_RETIRE_MS` */
  private retiring: { ep: DocEndpoint; timer: ReturnType<typeof setTimeout>; left: Set<string> } | null = null;
  /**
   * The publisher reported on this connection (`publisher.hello`; the publisher registration for prerender
   * tasks follows the connection): after a session swap it is reported again as is on the new session. This
   * avoids the document service, once the old session closes, treating it as "publisher offline" and revoking
   * its subscriptions after the grace period (the publisher itself only re-registers when its next publish is
   * rejected).
   */
  private publisherHello: AnyMsg | null = null;
  private renewing: Promise<boolean> | null = null;

  constructor(o: LinkOptions) {
    this.o = o;
    this.delay = o.reconnect?.minMs ?? 500;
    this.ds = o.docSync ?? new DocSync(o.initial, {
      projectId: o.projectId,
      session: o.session,
      send: (msg) => this.send(msg as unknown as AnyMsg),
      saveBackup: o.saveBackup,
      initialize: o.initialize,
    });
  }

  /** The session exists (this also holds while the transport is detached and resuming: messages sent then are resent after the resume) */
  get connected(): boolean {
    return this.open;
  }

  get hasOpened(): boolean {
    return this.everOpened;
  }

  /** Diagnostics: the transport actually in use (null when detached), number of resumes, number of unacknowledged bytes, whether it faces an old server without a session layer */
  stats(): LinkStats | null {
    return this.ep?.stats() ?? null;
  }

  start() {
    if (this.stopped || this.ep || this.dialing) return;
    void this.dial();
  }

  /** End the session and do not reconnect; all pending requests fail */
  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ep = this.ep;
    this.ep = null;
    if (this.open) {
      this.open = false;
      this.ds.disconnect();
    }
    try {
      ep?.close();
    } catch {
      /* Already closed */
    }
    this.dropRetiring();
    this.failWaiting(tr("Connection closed"));
  }

  private dropRetiring() {
    const r = this.retiring;
    if (!r) return;
    this.retiring = null;
    clearTimeout(r.timer);
    try { r.ep.close(); } catch { /* Already closed */ }
  }

  /**
   * Planned session swap: fetch the subprotocol fresh (new ticket), build a new session, and switch to it the
   * moment it is ready. Returns true = swapped.
   * - Until the new session is built the old one is used as usual; if it cannot be built (handshake rejected,
   *   network down, not built within `RENEW_OPEN_TIMEOUT_MS`), returns false and the old session is untouched;
   * - An error thrown while fetching the subprotocol is rethrown to the caller as is (the caller tells login
   *   expiry from a temporary outage);
   * - Switch: `ds.handover()` (no offline record; unacknowledged commits are resent on the new session and the
   *   document service deduplicates by opId), then call `onOpen` as for a newly built session (the caller
   *   resubscribes); requests sent before the switch and still waiting for replies are finished by the old
   *   session (if there are none, the old session is closed on the spot).
   * Not done, and returns false, when there is no session (reconnecting after a disconnect) or the transport
   * is detached (resuming): the former path builds a session with a new ticket anyway; changes made while
   * detached must have their version checked under the offline rules, so the caller waits for the resume and
   * then swaps, or calls `expire()` after expiry.
   */
  renew(): Promise<boolean> {
    if (this.renewing) return this.renewing;
    if (this.stopped || !this.ep || !this.open || this.ep.stats().detached) return Promise.resolve(false);
    const task = this.renewOnce().finally(() => { if (this.renewing === task) this.renewing = null; });
    this.renewing = task;
    return task;
  }

  private async renewOnce(): Promise<boolean> {
    const old = this.ep;
    const protocols = await this.o.protocols();
    if (this.stopped || this.ep !== old || !old || !this.open) return false;
    let next: DocEndpoint;
    try { next = this.createEndpoint(protocols, () => next); } catch { return false; }
    // Watch the new session's liveness from the moment it is built: if the server closes it after it is built but before the switch (the few seconds waiting for commits on the old session to settle), do not switch to it
    let nextDead = false;
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), RENEW_OPEN_TIMEOUT_MS);
      const done = (ok: boolean) => { clearTimeout(timer); resolve(ok); };
      next.onOpen(() => done(true));
      next.onClose(() => { nextDead = true; done(false); });
      next.onConnectFail(() => { nextDead = true; done(false); });
    });
    const usable = () => !this.stopped && this.ep === old && this.open && !old.stats().detached && !nextDead && !next.closed;
    // Wait for unacknowledged commits on the old session to settle, then switch (at that moment neither side has commits in flight, so the switch needs no resend); switch anyway if they do not settle
    if (opened && usable()) await this.ds.whenSettled({ timeoutMs: RENEW_SETTLE_MS }).catch(() => undefined);
    if (!opened || !usable()) {
      try { next.close(); } catch { /* Already closed */ }
      return false;
    }
    // Switch. Old session: if requests are still waiting for replies, keep it until they finish; otherwise close it on the spot
    this.dropRetiring();
    const left = new Set(this.waiting.keys());
    if (left.size) this.retiring = { ep: old, left, timer: setTimeout(() => { if (this.retiring?.ep === old) this.dropRetiring(); }, RENEW_RETIRE_MS) };
    this.ep = next;
    this.attach(next);
    if (!left.size) { try { old.close(); } catch { /* Already closed */ } }
    if (this.publisherHello) { try { next.send(this.publisherHello); } catch { /* Cannot be sent: the publisher re-registers itself when its next publish is rejected */ } }
    this.ds.handover();
    this.o.onOpen?.();
    return true;
  }

  /**
   * This connection is invalid (the access token expired before a new session was swapped in): handle it as a
   * disconnect. DocSync goes offline (changes still enter the queue), then the session is rebuilt with a new
   * ticket using the usual disconnect backoff. `onClosed` receives `CLOSE_EXPIRED`.
   */
  expire(reason = "credential-expired") {
    const ep = this.ep;
    if (!ep || this.stopped) return;
    // Wrap up as a disconnect first (afterwards ignore all events of this endpoint), then close it
    this.gone(ep, CLOSE_EXPIRED, reason);
    try { ep.close(); } catch { /* Already closed */ }
  }

  /** Send one message; dropped if there is no session (DocSync resends its commits itself after reconnecting) */
  send(msg: AnyMsg): boolean {
    if (!this.ep || !this.open) return false;
    if (msg.type === "publisher.hello" && typeof msg.publisherId === "string") this.publisherHello = { type: "publisher.hello", publisherId: msg.publisherId };
    try {
      return this.ep.send(msg) !== false;
    } catch {
      return false;
    }
  }

  /** Send one request carrying a reqId and wait for the reply with the same reqId (an `error` also counts as a reply) */
  request(msg: AnyMsg, timeoutMs = 10_000): Promise<AnyMsg> {
    const reqId = `r${++reqSeq}`;
    return new Promise((resolve, reject) => {
      if (!this.open) return reject(new Error(tr("Not connected to the document service")));
      const timer = setTimeout(() => {
        this.waiting.delete(reqId);
        reject(new Error(tr("The document service did not respond")));
      }, timeoutMs);
      this.waiting.set(reqId, { resolve, reject, timer });
      if (!this.send({ ...msg, reqId })) {
        clearTimeout(timer);
        this.waiting.delete(reqId);
        reject(new Error(tr("Not connected to the document service")));
      }
    });
  }

  /**
   * For tests and demos: end the current session and do not rebuild it for `ms` (simulates a long network
   * outage: the session is gone and DocSync is offline; the acceptance check of the offline dialog uses it).
   * To cut only the transport while the session resumes, use `cutTransport()`.
   */
  private holdUntil = 0;
  dropFor(ms: number) {
    this.holdUntil = Date.now() + ms;
    const ep = this.ep;
    if (!ep) return;
    try {
      ep.close();
    } catch {
      /* Already closed */
    }
    // When the session is not yet built, close() does not report onClose: handle the disconnect here
    if (this.ep === ep) this.gone(ep, 1000, "drop");
  }

  /** For tests and demos: cut only the current transport (simulates a network switch or proxy cut); the session resumes within the retention window, and the page must neither lose changes nor replay them. Returns whether it was cut */
  cutTransport(): boolean {
    return this.ep?.dropTransport() ?? false;
  }

  private scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    const wait = Math.max(this.delay, this.holdUntil - Date.now());
    this.delay = Math.min(this.o.reconnect?.maxMs ?? 5000, this.delay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.dial();
    }, wait);
  }

  private failWaiting(message: string) {
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new Error(message));
    }
    this.waiting.clear();
  }

  /** The session ended, or this attempt was not built */
  private gone(ep: DocEndpoint, code: number, reason: string) {
    if (this.ep !== ep) return;
    this.ep = null;
    if (this.open) {
      this.open = false;
      this.ds.disconnect();
    }
    this.failWaiting(tr("Connection lost"));
    const fatal = this.o.isFatalClose ? this.o.isFatalClose(code, reason) : FATAL_CLOSE.has(code);
    this.o.onClosed?.({ code, reason, fatal, neverOpened: !this.everOpened });
    if (!fatal) this.scheduleRetry();
    else this.stopped = true;
  }

  private async dial() {
    if (this.stopped || this.ep || this.dialing) return;
    this.dialing = true;
    let protocols: string[];
    try {
      protocols = await this.o.protocols();
    } catch (error) {
      this.dialing = false;
      if (this.stopped) return;
      if (this.o.onProtocolError?.(error)) { this.stop(); return; }
      this.o.onClosed?.({ code: 0, reason: "protocols", fatal: false, neverOpened: !this.everOpened });
      this.scheduleRetry();
      return;
    }
    this.dialing = false;
    if (this.stopped) return;
    let ep: DocEndpoint;
    try {
      ep = this.createEndpoint(protocols, () => ep);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ep = ep;
    ep.onOpen(() => {
      if (this.ep !== ep || this.stopped) return;
      this.open = true;
      this.everOpened = true;
      this.delay = this.o.reconnect?.minMs ?? 500;
      this.ds.connect();
      this.o.onOpen?.();
    });
    this.attach(ep);
  }

  private createEndpoint(protocols: string[], self: () => DocEndpoint): DocEndpoint {
    return createDocEndpoint({
      url: this.o.url,
      protocols: () => protocols,
      resumeProtocols: this.o.resumeProtocols ? async () => {
        try { return await this.o.resumeProtocols!(); }
        catch (error) {
          if (!this.stopped && this.ep === self() && this.o.onProtocolError?.(error)) this.stop();
          throw error;
        }
      } : undefined,
      ...(this.o.WebSocketImpl ? { WebSocket: this.o.WebSocketImpl } : {}),
      transport: "ws",
      renew: false,
      // Backoff for resuming the same session; the backoff for building a new session is in this class's scheduleRetry
      backoff: { baseMs: this.o.reconnect?.minMs ?? 500, factor: 2, maxMs: this.o.reconnect?.maxMs ?? 5000, jitter: 0.2 },
      maxPendingBytes: PAGE_MAX_PENDING_BYTES,
    });
  }

  /** Events of the current session (other than being built): resume, message, end */
  private attach(ep: DocEndpoint) {
    ep.onResume(() => {
      if (this.ep !== ep) return;
      this.o.onResume?.();
    });
    ep.onMessage((msg) => {
      if (!msg || typeof msg.type !== "string") return;
      if (this.ep !== ep) {
        // The old session that was swapped out: accepts only replies to requests sent before the swap; closed when done
        const r = this.retiring;
        if (r?.ep === ep && msg.reqId !== undefined && !msg.type.startsWith("project.") && r.left.has(String(msg.reqId))) {
          r.left.delete(String(msg.reqId));
          if (this.waiting.has(String(msg.reqId))) this.dispatch(msg);
          if (!r.left.size) this.dropRetiring();
        }
        return;
      }
      if ((msg.type === "error" || msg.type === "project.op.rejected") && typeof msg.reason === "string" && AUTH_EXPIRED_REASONS.has(msg.reason)) {
        if (msg.type === "error") this.dispatch(msg);
        if (this.ep === ep && !this.stopped) this.o.onAuthExpired?.(msg.reason);
        return;
      }
      this.dispatch(msg);
    });
    ep.onClose((info) => this.gone(ep, info.code, info.reason));
    // Cannot be built (handshake rejected, network down, subprotocol unavailable): the browser cannot tell the first two apart, so report it to the caller as "never connected"
    ep.onConnectFail((info) => this.gone(ep, info.code === 0 ? 1006 : info.code, info.reason));
  }

  private dispatch(msg: AnyMsg) {
    if (msg.reqId !== undefined) {
      const w = this.waiting.get(String(msg.reqId));
      if (w) {
        this.waiting.delete(String(msg.reqId));
        clearTimeout(w.timer);
        if (this.o.onResponse) void this.o.onResponse(msg).then(() => w.resolve(msg), w.reject);
        else w.resolve(msg);
        // Replies to project.* must also go to DocSync (it sends without reqId, so normally this is not reached)
        if (!msg.type.startsWith("project.")) return;
      }
    }
    if (msg.type.startsWith("project.")) {
      this.ds.receive(msg as unknown as ServerMsg);
      return;
    }
    this.o.onMessage?.(msg);
  }
}
