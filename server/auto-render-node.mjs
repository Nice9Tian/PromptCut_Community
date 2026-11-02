/**
 * Desktop app automatically becomes a render node for shared projects (semantics
 * `docs/semantics/product/platforms.md` "Render nodes": "Desktop apps joining a shared project
 * automatically become render nodes for this project, eligible to claim tasks published by any
 * member of this project"): state machine on the prerender process side.
 *
 * When the prerender process of the installed app starts, it knows nothing about shared projects
 * (the shell and editor process only pass environment variables such as runtime paths). When a page
 * enters a shared project, it hands over the project's shared configuration via the editor process
 * (`POST /api/frames/render-node`, see `render-node-relay.mjs` on the editor process side):
 *   `{ url, projectId, assetBase?, contentId?, ticket? }`
 *   - `url`: Document service connected by the page (`ws(s)://…`); for cloud projects it is the
 *     hosted side, for LAN members it is the host, and when this machine acts as host it is
 *     `/docservice` on this machine;
 *   - `projectId`: id of the shared project (workspace in the document service);
 *   - `assetBase`: Asset service base URL used by the page right now (`…/api/asset`), or if
 *     omitted, selected by the prerender process from registered service addresses;
 *   - `contentId`: `id` of the project document in the page (the one used for layer table key
 *     `layers:<contentId>`; used to pick entries when catching up existing layers);
 *   - `ticket`: Render-role connection ticket signed by the page on its own connection
 *     (`auth.ticket { kind: 'conn', role: 'render', owner: { kind: 'user' } }`).
 * Based on this, this module gives the caller a "link" (`link`): `protocols()` hands over a
 * connection ticket whenever **establishing a new session**: uses the one in hand if still fresh,
 * otherwise requests one from the page via `requestTicket(projectId)` (the editor process forwards
 * it to the page via HMR, and the page signs and returns it). If unavailable (page is gone),
 * `protocols()` throws, and the session layer backs off and retries as usual; established sessions
 * are unaffected (resuming does not call `protocols()`), and reconnects on the next retry once the
 * page returns. Does not touch project passphrase or `K`. Tickets remain in memory only and never
 * enter logs.
 *
 * The caller (`vite-plugin-frames.ts`) injects `start(link)` and `stop(handle)`: create/tear down
 * push queues and local render nodes. Repeated handovers for the same project (same `url` +
 * `projectId`) only update the ticket and asset base URL without rebuilding; switching projects
 * tears down the old one before creating the new one; `unbind` tears down.
 *
 * Switch (for developers, on by default): `PROMPTCUT_AUTO_RENDER_NODE=0` disables automatically
 * becoming a render node and auto-pushing (for observer clients, C6.6 T9). When environment
 * variables have already configured this process as a node or pusher (`PROMPTCUT_SHARED_CONFIG`,
 * `PROMPTCUT_QUEUE_NODE=1`, `PROMPTCUT_PUSH=1`, `PROMPTCUT_NODE_PROFILE=host`), dynamic handovers
 * are rejected and managed by the environment variable setup instead (probes, standalone render
 * host); `PROMPTCUT_PUSH=0` is always rejected.
 */
import { ticketExpiry } from './auth/client.mjs';

export const AUTO_RENDER_NODE_ENV = 'PROMPTCUT_AUTO_RENDER_NODE';
/** Only reuse connection ticket in hand directly if at least this much time remains (connection tickets valid for 2 min, margin for handshake and clock skew) */
export const TICKET_MIN_LEFT_MS = 30_000;
/** When expiration cannot be read from the ticket, consider it expired this long after issuance */
export const TICKET_ASSUMED_TTL_MS = 90_000;

const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TICKET = 2048;

/**
 * Whether this process accepts dynamic handovers. Return null = accept; otherwise return the reason.
 * @param {Record<string, string | undefined>} env
 */
export function autoRenderNodeOffReason(env = process.env) {
  if (env[AUTO_RENDER_NODE_ENV] === '0') return 'disabled';
  if (env.PROMPTCUT_PUSH === '0') return 'push-disabled';
  if (env.PROMPTCUT_NODE_PROFILE === 'host') return 'host-profile';
  if (env.PROMPTCUT_SHARED_CONFIG || env.PROMPTCUT_QUEUE_NODE === '1' || env.PROMPTCUT_PUSH === '1') return 'env-configured';
  return null;
}

/** Normalize shared configuration from the page; throw on invalid input (error message excludes ticket) */
export function normalizeBinding(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Shared config must be an object');
  let url;
  try { url = new URL(String(input.url ?? '')); } catch { throw new Error('url is not a valid address'); }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('url must be ws:// or wss://');
  if (typeof input.projectId !== 'string' || !PROJECT_ID_RE.test(input.projectId)) throw new Error('projectId is invalid');
  let assetBase = null;
  if (input.assetBase !== undefined && input.assetBase !== null && input.assetBase !== '') {
    let a;
    try { a = new URL(String(input.assetBase)); } catch { throw new Error('assetBase is not a valid address'); }
    if (a.protocol !== 'http:' && a.protocol !== 'https:') throw new Error('assetBase must be http:// or https://');
    assetBase = String(input.assetBase).replace(/\/+$/, '');
  }
  const contentId = typeof input.contentId === 'string' && input.contentId && input.contentId.length <= 256 ? input.contentId : null;
  return { url: String(input.url), projectId: input.projectId, assetBase, contentId };
}

/** Whether the ticket string is valid (checks format only, does not verify signature) */
export const ticketOk = (t) => typeof t === 'string' && t.length > 0 && t.length <= MAX_TICKET && !/\s/.test(t);

/**
 * @param {object} deps
 * @param {(link: object) => Promise<any>} deps.start  Create push queue and local node, returning handle (passed to `stop`)
 * @param {(handle: any, reason: string) => Promise<void>} deps.stop  Tear down
 * @param {(projectId: string) => Promise<string>} deps.requestTicket  Request a render connection ticket from the page; throw if unavailable
 * @param {() => number} [deps.now]
 * @param {(event: string, fields?: object) => void} [deps.log]
 */
export function createAutoRenderNode({ start, stop, requestTicket, now = Date.now, log = () => {} }) {
  if (typeof start !== 'function' || typeof stop !== 'function' || typeof requestTicket !== 'function') throw new TypeError('createAutoRenderNode requires start, stop and requestTicket');
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging errors do not affect handover */ } };

  /** Current generation: { gen, binding, link, handle, starting, ticket: { value, exp } | null, inflight, state, lastError, … } */
  let current = null;
  let gen = 0;
  /** Teardown chain: bind / unbind sequenced so the old one is torn down before creating the new one */
  let chain = Promise.resolve();
  const counters = { binds: 0, same: 0, starts: 0, stops: 0, ticketRequests: 0, ticketFailures: 0, pageTickets: 0 };

  const freshTicket = (rec) => rec.ticket && rec.ticket.exp - now() > TICKET_MIN_LEFT_MS ? rec.ticket.value : null;
  const keepTicket = (rec, value) => {
    const exp = ticketExpiry(value) ?? now() + TICKET_ASSUMED_TTL_MS;
    rec.ticket = { value, exp };
  };

  /** `protocols()` for this generation: called on each new session (coalesced into one request if two connections request concurrently) */
  const protocolsOf = (rec) => async () => {
    if (rec.gen !== gen) throw new Error('This shared config has been revoked');
    let t = freshTicket(rec);
    if (!t) {
      rec.inflight ??= (async () => {
        counters.ticketRequests++;
        try {
          const got = await requestTicket(rec.binding.projectId);
          if (!ticketOk(got)) throw new Error('The ticket returned by the page is invalid');
          if (rec.gen === gen) keepTicket(rec, got);
          rec.waitingPage = false;
          return got;
        } catch (error) {
          counters.ticketFailures++;
          rec.waitingPage = true;
          rec.lastError = String(error?.message ?? error).slice(0, 200);
          if (rec.ticketFailures++ === 0 || rec.ticketFailures % 20 === 0) say('render-node.waiting-page', { projectId: rec.binding.projectId, failures: rec.ticketFailures, message: rec.lastError });
          throw error;
        } finally {
          rec.inflight = null;
        }
      })();
      t = await rec.inflight;
    }
    if (rec.gen !== gen) throw new Error('This shared config has been revoked');
    rec.ticketFailures = 0;
    return ['promptcut.v1', `promptcut.ticket.${t}`];
  };

  const linkOf = (rec) => ({
    mode: 'page',
    url: rec.binding.url,
    shared: true,
    projectId: rec.binding.projectId,
    /** Fetch on demand: also sees project document ids delivered late from the page (same project only swaps id, see `bind`); push and publish scope is determined by it (`push-scope.mjs`) */
    get contentId() { return rec.binding.contentId; },
    assetBase: () => rec.binding.assetBase,
    protocols: protocolsOf(rec),
    /** Whether this generation is still active (after teardown, an in-flight start stops based on this) */
    alive: () => rec.gen === gen && !rec.stopping,
  });

  async function teardown(rec, reason) {
    if (!rec) return;
    rec.stopping = true;
    let handle = rec.handle;
    if (!handle && rec.starting) {
      try { handle = await rec.starting; } catch { handle = null; }
    }
    rec.handle = null;
    if (handle) {
      counters.stops++;
      try { await stop(handle, reason); } catch (error) { say('render-node.stop-failed', { message: String(error?.message ?? error) }); }
    }
    say('render-node.stopped', { projectId: rec.binding.projectId, reason });
  }

  function bind(input, { ticket } = {}) {
    const binding = normalizeBinding(input);
    counters.binds++;
    const rec0 = current;
    if (rec0 && rec0.binding.url === binding.url && rec0.binding.projectId === binding.projectId && !rec0.stopping) {
      // Same project: only swap ticket, asset base URL, and project document id without rebuilding
      counters.same++;
      if (ticketOk(ticket)) { keepTicket(rec0, ticket); counters.pageTickets++; rec0.waitingPage = false; }
      const assetChanged = binding.assetBase !== rec0.binding.assetBase;
      rec0.binding = { ...rec0.binding, assetBase: binding.assetBase ?? rec0.binding.assetBase, contentId: binding.contentId ?? rec0.binding.contentId };
      if (assetChanged && binding.assetBase) say('render-node.asset-base', { projectId: binding.projectId, assetBase: binding.assetBase });
      return { ok: true, action: 'same', projectId: binding.projectId };
    }
    const prev = current;
    if (prev) prev.stopReason = 'rebind';
    const rec = { gen: ++gen, binding, handle: null, starting: null, ticket: null, inflight: null, waitingPage: false, ticketFailures: 0, lastError: null, stopping: false, at: now() };
    if (ticketOk(ticket)) { keepTicket(rec, ticket); counters.pageTickets++; }
    current = rec;
    const link = linkOf(rec);
    chain = chain.catch(() => {}).then(async () => {
      if (prev) await teardown(prev, 'rebind');
      if (rec.gen !== gen) return;
      counters.starts++;
      say('render-node.bind', { projectId: binding.projectId, url: binding.url, assetBase: binding.assetBase, contentId: binding.contentId, replaced: prev?.binding.projectId ?? null });
      rec.starting = Promise.resolve().then(() => start(link));
      try {
        rec.handle = await rec.starting;
      } catch (error) {
        rec.lastError = String(error?.message ?? error).slice(0, 200);
        say('render-node.start-failed', { projectId: binding.projectId, message: rec.lastError });
      } finally {
        rec.starting = null;
      }
      // Torn down during startup: finalize (teardown awaits starting; catches cases discovered after startup finishes)
      if (rec.gen !== gen && rec.handle) {
        const h = rec.handle;
        rec.handle = null;
        counters.stops++;
        try { await stop(h, rec.stopReason ?? 'superseded'); } catch { /* Torn down */ }
      }
    });
    return { ok: true, action: prev ? 'rebind' : 'started', projectId: binding.projectId };
  }

  /** Tear down; when `projectId` is given, only tear down if currently bound to it (other pages leaving other projects do not affect here) */
  function unbind({ projectId = null, reason = 'unbind' } = {}) {
    const rec = current;
    if (!rec) return Promise.resolve({ ok: true, action: 'none' });
    if (projectId !== null && projectId !== rec.binding.projectId) return Promise.resolve({ ok: true, action: 'other-project', projectId: rec.binding.projectId });
    current = null;
    gen++;
    rec.stopReason = reason;
    const done = chain.catch(() => {}).then(() => teardown(rec, reason));
    chain = done;
    return done.then(() => ({ ok: true, action: 'stopped', projectId: rec.binding.projectId }));
  }

  function status() {
    const rec = current;
    return {
      bound: !!rec,
      ...(rec ? {
        projectId: rec.binding.projectId, url: rec.binding.url, assetBase: rec.binding.assetBase, contentId: rec.binding.contentId,
        started: !!rec.handle, starting: !!rec.starting, waitingPage: rec.waitingPage, lastError: rec.lastError,
        ticketLeftMs: rec.ticket ? Math.max(0, rec.ticket.exp - now()) : 0, since: rec.at,
      } : {}),
      counters: { ...counters },
    };
  }

  /** Wait for queued create/teardown operations to finish (for testing and exit) */
  const settled = () => chain.catch(() => {});

  return { bind, unbind, status, settled };
}
