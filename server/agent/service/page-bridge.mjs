/**
 * Reverse channel for "initiator's own page" in account mode (package W2 of plan
 * `docs/plan/cloud-agent-tools-implementation.md`).
 *
 * Cloud Agent has no UI. When it needs to move the user's playhead (`user_interface_seek`,
 * `user_interface_play`, `user_interface_pause`) or hand off a web page to the user themselves
 * (`user_interface_web_handoff`), it uses this channel to have "the person who sent this message,
 * on the page used when sending the message" execute on its behalf, and return the result. The
 * older version (non-account mode) was in `pageCall` of `create-agent-service.mjs`, where page ID
 * was self-reported in the request body; here both ends are bound to things confirmed by the
 * document service:
 *
 *   - **Both initiator and initiating page are retrieved from the document service's current run
 *     grant**: `runGrant.accountId` and `runGrant.selectionSnapshot.pageId` returned by
 *     `runClient.checkAccess` (page ID recorded by the document service when sending the message
 *     only after verifying "this page is currently connected and belongs to this login session").
 *     The two arguments `initiatorAccountId` and `pageId` of `requestPage` are merely the caller's
 *     **assertions**; if they do not match the grant, it is rejected and cannot be used to pick a
 *     page; neither tool arguments nor request bodies submitted by the page can specify a page.
 *   - **"Currently online" requires two conditions to hold simultaneously**: in the document
 *     service's presence table, this page is currently connected (`presence`, i.e. the all-member
 *     selection query), and this page has an event stream to the Agent service attached to this
 *     chat (`attach`, identity verified at the HTTP layer with a delegation ticket). Other pages of
 *     the same account (different pageId) or pages of other members (different account) do not
 *     count.
 *   - **Requests are written only to that single stream**, with a nonce that appears only on that
 *     stream; not recorded in event logs, not retransmitted.
 *   - **Fully re-verified upon submission**: the submitter is the initiator and can still read this
 *     chat, chat ACL revision has not changed, pageId matches the nonce, the grant for this round
 *     is still current with no fence revision change, not expired, and the request is still
 *     pending. If anything does not match, it is rejected; waiting tools are closed out as
 *     "initiator offline", and content submitted by the page is not accepted as the result.
 *     Duplicate submissions of the same result are idempotent.
 *   - **Request state is persisted to disk** (SQLite): requests still pending after restart are
 *     marked `interrupted`, making them queryable later and explainable upon submission, rather
 *     than vanishing with in-memory tables.
 *
 * This file registers no routes, emits no events, and validates no tickets: event stream `attach`
 * and submission `acceptResult` are wired to `server/agent-service/http.mjs` by the host (final
 * wiring package). Does not reference `src/`.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initiatorOffline } from './cloud-tools.mjs';
import { modelToolName, pageToolName } from '../../tools/ui-names.mjs';

/**
 * **Internal operation names** (`tool` in requests) executed by the initiating page via this
 * channel. Does not include `get_selection`: in account mode it uses the document service's
 * all-member selection query, and does not read a single page.
 * Model-side tool names carry `user_interface_` prefix since 2026-10-21
 * (`server/tools/ui-names.mjs`); older names are kept here: 0.7.18 pages only recognize these few
 */
export const PAGE_BRIDGE_TOOLS = Object.freeze(['seek', 'play', 'pause', 'web_handoff']);
/** Three page control tools (handled by this file's tool provider; model-side names); provider for `user_interface_web_handoff` is in `hosted-handoff.mjs` */
export const PAGE_CONTROL_TOOL_NAMES = Object.freeze(['user_interface_seek', 'user_interface_play', 'user_interface_pause']);
/** Version number of events and submission request bodies (older channel did not have this field) */
export const PAGE_REQUEST_VERSION = 2;

export const PAGE_BRIDGE_DEFAULTS = Object.freeze({
  /** Maximum time to wait for the page after request is sent (number carries over `pageMs` from the older channel) */
  pageMs: 15_000,
  /** When document service says the page is present but its event stream to Agent service is not yet attached (just sent message, reconnecting), maximum wait time (carries over `pageAttachMs`) */
  attachMs: 3_000,
  /** Caller-supplied timeout never exceeds this duration no matter how long */
  maxPageMs: 60_000,
  /** Upper limit on content submitted by the page */
  maxResultBytes: 64 * 1024,
  /** How long completed request records are retained */
  retainMs: 7 * 24 * 3600_000,
  /** Length cap for `web_handoff` description text and URL */
  maxReasonChars: 200,
  maxUrlChars: 2048,
});

/** Request state. Everything other than `pending` is a terminal state */
export const PAGE_REQUEST_STATES = Object.freeze(['pending', 'answered', 'offline', 'expired', 'cancelled', 'interrupted', 'rejected']);

export class PageBridgeError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'PageBridgeError';
    this.code = code;
    this.status = status;
  }
}
const fail = (code, status = 400) => { throw new PageBridgeError(code, status); };

const CONTEXT_KEYS = Object.freeze(['projectId', 'conversationId', 'runId', 'runGrantId', 'instanceId', 'instanceGeneration', 'senderAccountId', 'messageId']);
const REFERENCE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Page ID: the one in document service presence table (same rule as `server/docservice/modules/selection.mjs`) */
export const BRIDGE_PAGE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** Request id: shape recognized by the page side (`src/ai/cloud/pageRequests.ts`) */
export const BRIDGE_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function canonicalContext(value) {
  if (!plain(value) || Object.keys(value).length !== CONTEXT_KEYS.length || !CONTEXT_KEYS.every((key) => Object.hasOwn(value, key))) fail('tool-context-untrusted', 403);
  const out = {};
  for (const key of CONTEXT_KEYS) {
    if (key === 'instanceGeneration') { if (!Number.isSafeInteger(value[key]) || value[key] < 1) fail('tool-context-invalid', 403); } else if (typeof value[key] !== 'string' || !REFERENCE.test(value[key])) fail('tool-context-invalid', 403);
    out[key] = value[key];
  }
  return Object.freeze(out);
}

/**
 * Validate arguments by the same rules as on this machine; extra fields are always rejected (not
 * dropped): arguments supplied by model must not include page ID, account, or project.
 * The copy sent back to the page.
 */
export function checkedPageArgs(tool, args, limits = PAGE_BRIDGE_DEFAULTS) {
  if (!PAGE_BRIDGE_TOOLS.includes(tool)) fail('page-tool-unknown', 404);
  const a = args === undefined || args === null ? {} : args;
  if (!plain(a)) fail('bad-args');
  const allowed = tool === 'seek' ? ['t'] : tool === 'web_handoff' ? ['reason', 'hide', 'url'] : [];
  if (Object.keys(a).some((key) => !allowed.includes(key))) fail('bad-args');
  if (tool === 'seek') {
    if (typeof a.t !== 'number' || !Number.isFinite(a.t) || a.t < 0) fail('bad-args');
    return { t: a.t };
  }
  if (tool !== 'web_handoff') return {};
  const out = {};
  if (a.reason !== undefined) {
    if (typeof a.reason !== 'string' || a.reason.length > limits.maxReasonChars) fail('bad-args');
    if (a.reason) out.reason = a.reason;
  }
  if (a.hide !== undefined) {
    if (typeof a.hide !== 'boolean') fail('bad-args');
    if (a.hide) out.hide = true;
  }
  if (a.url !== undefined) {
    if (typeof a.url !== 'string' || a.url.length > limits.maxUrlChars) fail('bad-args');
    let parsed;
    try { parsed = new URL(a.url); } catch { fail('bad-args'); }
    // Only submit public web addresses; do not submit addresses containing account passphrases
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('bad-args');
    out.url = parsed.href;
  }
  return out;
}

/**
 * Requests added to this channel by other tool packages (used by C1 proxying local media collection
 * downloads): `{ toolName: { args(args given by host) => args sent to page,
 * answer?(answer submitted by page) => retained answer } }`.
 * Add only, no modifications: names must not conflict with `PAGE_BRIDGE_TOOLS`; initiator and
 * initiating page binding, re-verification upon submission, disk persistence, and idempotency all
 * follow this file's original mechanism.
 * Throws its own error when `args` violates rules; when `answer` throws or does not return an
 * answer, this attempt is treated as rejected (tool receives "initiator offline", page receives
 * 422), and the copy submitted by the page is not persisted to disk.
 */
function checkedExtraTools(value) {
  const out = new Map();
  if (value === null || value === undefined) return out;
  if (!plain(value)) fail('page-bridge-configuration', 503);
  for (const [name, spec] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(name) || PAGE_BRIDGE_TOOLS.includes(name) || typeof spec?.args !== 'function' ||
        (spec.answer !== undefined && spec.answer !== null && typeof spec.answer !== 'function')) fail('page-bridge-configuration', 503);
    out.set(name, { args: spec.args, answer: spec.answer ?? null });
  }
  return out;
}

function sameText(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function openLedger(databasePath, now, retainMs) {
  if (typeof databasePath !== 'string' || databasePath.trim() === '' || databasePath === ':memory:') fail('page-bridge-configuration', 503);
  const file = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(file);
  const db = new DatabaseSync(file);
  if (!existed && process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch { db.close(); fail('page-bridge-configuration', 503); } }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS page_requests (
    request_key TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    instance_generation INTEGER NOT NULL,
    initiator_account_id TEXT NOT NULL,
    page_id TEXT,
    tool TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    nonce_digest TEXT,
    fence_revision INTEGER,
    acl_revision INTEGER,
    state TEXT NOT NULL CHECK (state IN ('pending','answered','offline','expired','cancelled','interrupted','rejected')),
    reason TEXT,
    answer_digest TEXT,
    answer TEXT,
    created_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS page_requests_run ON page_requests (project_id, conversation_id, run_id);');
  const at = Number(now());
  // Still pending from the previous process: its waiter is no longer present, and results arriving later should not be accepted
  db.prepare("UPDATE page_requests SET state='interrupted', reason='agent-restart', updated_at=? WHERE state='pending'").run(at);
  db.prepare("DELETE FROM page_requests WHERE state <> 'pending' AND updated_at < ?").run(at - retainMs);
  return db;
}

/**
 * Where authoritative information for this round comes from: by default fetches the current grant
 * from document service, and retrieves sender and page ID at message time from it. Any mismatch
 * is rejected.
 * Designed as a separate interface because in the production topology of account mode, "the
 * process running this round" (one worker process per task, with grant registered under its name)
 * and "the process attached to the page event stream" (main service) may not be the same: when the
 * reverse channel is in the main service, the host only needs to substitute `runAuthority` (asking
 * the worker process holding this round's registration for the same data), while the rest of this
 * file remains unchanged. Return shape is fixed:
 * `{ accountId, pageId, fenceRevision, grantState }`; throws `PageBridgeError` (403) if grant is
 * absent, throws 503 if upstream is unreachable.
 */
export function createRunPageAuthority({ resources, runClient } = {}) {
  if (typeof resources?.authorize !== 'function' || typeof runClient?.checkAccess !== 'function') fail('page-bridge-configuration', 503);
  async function current(context) {
    let auth;
    try { auth = await resources.authorize(context, 'read'); } catch (error) {
      if (error?.code === 'run-authority-unavailable') fail('run-authority-unavailable', 503);
      fail(error?.code === 'tool-context-untrusted' || error?.code === 'tool-context-invalid' ? error.code : 'run-access-denied', 403);
    }
    if (auth?.allowed !== true || !Number.isSafeInteger(auth.fenceRevision) || !['active', 'retained'].includes(auth.grantState)) fail('run-access-denied', 403);
    let raw;
    try { raw = await runClient.checkAccess({ projectId: context.projectId, runGrantId: context.runGrantId, action: 'read' }); } catch (error) {
      if ([400, 401, 403, 404].includes(error?.status)) fail('run-access-denied', 403);
      fail('run-authority-unavailable', 503);
    }
    const grant = raw?.runGrant;
    if (raw?.allowed !== true || !grant || grant.projectId !== context.projectId || grant.conversationId !== context.conversationId ||
        grant.runId !== context.runId || grant.runGrantId !== context.runGrantId || grant.messageId !== context.messageId ||
        grant.accountId !== context.senderAccountId || grant.initiatorAccountId !== grant.accountId ||
        grant.instanceId !== context.instanceId || grant.instanceGeneration !== context.instanceGeneration ||
        grant.fenceRevision !== auth.fenceRevision || grant.state !== auth.grantState) fail('run-access-denied', 403);
    const snapshot = grant.selectionSnapshot;
    let pageId = null;
    if (snapshot !== null && snapshot !== undefined) {
      if (!plain(snapshot) || snapshot.source !== 'sent-snapshot' || snapshot.projectId !== context.projectId ||
          snapshot.accountId !== context.senderAccountId || typeof snapshot.pageId !== 'string' || !BRIDGE_PAGE_ID_RE.test(snapshot.pageId) ||
          (snapshot.messageId !== undefined && snapshot.messageId !== context.messageId)) fail('run-page-binding-invalid', 403);
      pageId = snapshot.pageId;
    }
    return Object.freeze({ accountId: grant.accountId, pageId, fenceRevision: auth.fenceRevision, grantState: auth.grantState });
  }

  return Object.freeze({
    current,
    signalFor(context) { try { return resources.signalFor?.(context) ?? null; } catch { return null; } },
  });
}

/**
 * @param {object} o
 * @param {string} o.databasePath SQLite file for request records (in private data directory)
 * @param {{ current(context: object): Promise<{accountId: string, pageId: string|null, fenceRevision: number, grantState: string}>, signalFor?(context: object): AbortSignal|null }} [o.runAuthority]
 *   Authoritative information for this round; if omitted, uses `createRunPageAuthority({ resources, runClient })`
 *   (when this process holds grant registration for this round)
 * @param {{ authorize(context: object, action: 'read'|'write'): Promise<{allowed: true, fenceRevision: number, grantState: string}>, signalFor?(context: object): AbortSignal }} [o.resources]
 *   Run resource registry of F0 (`run-resources.mjs`): re-verifies current grant and instance
 *   registration with document service every time
 * @param {{ checkAccess(input: {projectId: string, runGrantId: string, action: string}): Promise<object> }} [o.runClient]
 *   Run grant API of document service; used here only to retrieve sender and page ID at message
 *   time from grant
 * @param {(context: object) => Promise<{members: Array<{accountId: string, isInitiator: boolean, pages: Array<{pageId: string, live: boolean}>}>}>} o.presence
 *   Document service presence table (response to all-member selection query `selection.query`);
 *   treated as offline if unavailable
 * @param {(identity: object, conversationId: string) => Promise<{allowed: boolean, aclRevision: number}>} o.checkSubmitter
 *   Whether the submitter can currently read this chat (same check used by HTTP layer for event
 *   stream); treated as rejected if unavailable
 */
export function createPageBridge({ databasePath, resources, runClient, runAuthority = null, presence, checkSubmitter, limits: limitOverrides = {}, now = Date.now, log = () => {}, randomNonce = () => randomBytes(18).toString('base64url'), extraTools = null } = {}) {
  if (typeof presence !== 'function' || typeof checkSubmitter !== 'function' || typeof now !== 'function') fail('page-bridge-configuration', 503);
  const extra = checkedExtraTools(extraTools);
  const authority = runAuthority ?? createRunPageAuthority({ resources, runClient });
  if (typeof authority?.current !== 'function') fail('page-bridge-configuration', 503);
  /** Refetched every time; if returned shape is incorrect, treated as absent grant in all cases */
  async function current(context) {
    const value = await authority.current(context);
    if (!value || typeof value.accountId !== 'string' || !REFERENCE.test(value.accountId) || value.accountId !== context.senderAccountId ||
        (value.pageId !== null && (typeof value.pageId !== 'string' || !BRIDGE_PAGE_ID_RE.test(value.pageId))) ||
        !Number.isSafeInteger(value.fenceRevision) || !['active', 'retained'].includes(value.grantState)) fail('run-access-denied', 403);
    return Object.freeze({ accountId: value.accountId, pageId: value.pageId, fenceRevision: value.fenceRevision, grantState: value.grantState });
  }
  const limits = Object.freeze({ ...PAGE_BRIDGE_DEFAULTS, ...limitOverrides });
  const db = openLedger(databasePath, now, limits.retainMs);
  const say = (event, fields) => { try { log(event, fields); } catch { /* Logging concerns */ } };

  /** request_key -> currently active request (from ingress to terminal state) */
  const inflight = new Map();
  /** request_key -> already sent to page, awaiting submission */
  const waiting = new Map();
  /** `${projectId}\n${conversationId}` -> Set<listener> */
  const streams = new Map();
  /** Waiting for a page to attach an event stream */
  const attachWaiters = new Set();
  let closed = false;

  const keyOf = (projectId, conversationId, requestId) => sha256(`${projectId}\n${conversationId}\n${requestId}`);
  const convKey = (projectId, conversationId) => `${projectId}\n${conversationId}`;
  const rowOf = (key) => db.prepare('SELECT * FROM page_requests WHERE request_key=?').get(key) ?? null;
  const publicRow = (row) => ({
    requestId: row.request_id, projectId: row.project_id, conversationId: row.conversation_id, runId: row.run_id,
    tool: row.tool, state: row.state, reason: row.reason ?? null, createdAt: row.created_at, deadlineAt: row.deadline_at, updatedAt: row.updated_at,
  });
  const offline = (why, state = 'offline') => Object.freeze({ delivered: false, offline: true, why, state });
  function outcomeOfRow(row) {
    if (row.state === 'answered') {
      let answer = null;
      try { answer = JSON.parse(row.answer); } catch { /* Corrupted records are treated as not submitted */ }
      if (answer && typeof answer.ok === 'boolean') return Object.freeze({ delivered: true, answer });
      return offline('answer-unreadable', 'rejected');
    }
    return offline(row.reason ?? row.state, row.state);
  }

  async function pageLive(context, binding) {
    let state;
    try { state = await presence(context); } catch { return null; }
    if (!state || !Array.isArray(state.members)) return null;
    return state.members.some((member) => member?.accountId === binding.accountId && member.isInitiator === true && Array.isArray(member.pages) &&
      member.pages.some((page) => page?.pageId === binding.pageId && page.live === true));
  }

  function listenerFor(projectId, conversationId, accountId, pageId) {
    for (const listener of streams.get(convKey(projectId, conversationId)) ?? []) {
      if (!listener.gone && listener.accountId === accountId && listener.pageId === pageId) return listener;
    }
    return null;
  }

  function waitForAttach(projectId, conversationId, accountId, pageId, ms, signal) {
    const found = listenerFor(projectId, conversationId, accountId, pageId);
    if (found || ms <= 0) return Promise.resolve(found);
    return new Promise((resolve) => {
      const entry = { projectId, conversationId, accountId, pageId, done: null };
      const finish = (listener) => { clearTimeout(timer); attachWaiters.delete(entry); signal?.removeEventListener('abort', onAbort); resolve(listener); };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), ms);
      timer.unref?.();
      entry.done = finish;
      attachWaiters.add(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function settle(waiter, state, reason, outcome, extra = {}) {
    if (waiter.settled) return false;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    waiter.signals.forEach(([signal, handler]) => signal.removeEventListener('abort', handler));
    waiting.delete(waiter.key);
    waiter.listener?.waiters.delete(waiter);
    try {
      db.prepare("UPDATE page_requests SET state=?, reason=?, answer_digest=?, answer=?, updated_at=? WHERE request_key=? AND state='pending'")
        .run(state, reason ?? null, extra.answerDigest ?? null, extra.answer ?? null, Number(now()), waiter.key);
    } catch { /* After database closes: waiters are closed out as usual */ }
    waiter.resolve(outcome);
    return true;
  }

  function record(context, binding, input, key, state, reason, more = {}) {
    const at = Number(now());
    db.prepare(`INSERT INTO page_requests (request_key, request_id, project_id, conversation_id, run_id, grant_id, message_id, instance_id,
      instance_generation, initiator_account_id, page_id, tool, input_digest, nonce_digest, fence_revision, acl_revision, state, reason,
      created_at, deadline_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      key, input.requestId, context.projectId, context.conversationId, context.runId, context.runGrantId, context.messageId, context.instanceId,
      context.instanceGeneration, binding.accountId, binding.pageId, input.tool, input.digest, more.nonceDigest ?? null, binding.fenceRevision,
      more.aclRevision ?? null, state, reason ?? null, at, input.deadline, at);
  }

  async function issue(context, input, key) {
    const binding = await current(context);
    // Initiator and page ID given by caller are merely assertions: mismatch with document service grant means someone is trying to cherry-pick pages
    if (input.initiatorAccountId !== binding.accountId || input.pageId !== binding.pageId) fail('page-binding-mismatch', 403);
    const refuse = (why) => { record(context, binding, input, key, 'offline', why); say('agent.page.offline', { tool: input.tool, why }); return offline(why); };
    if (binding.pageId === null) return refuse('no-page');
    // After initiator is kicked or logs out, this round can keep running as a "read shared task", but "their page" no longer exists
    if (binding.grantState !== 'active') return refuse('initiator-revoked');
    const live = await pageLive(context, binding);
    // Treated as offline if presence table cannot be fetched (document service did not reply), no guessing
    if (live !== true) return refuse(live === null ? 'presence-unavailable' : 'page-not-live');
    const remaining = () => input.deadline - Number(now());
    let listener = listenerFor(context.projectId, context.conversationId, binding.accountId, binding.pageId);
    if (!listener) {
      listener = await waitForAttach(context.projectId, context.conversationId, binding.accountId, binding.pageId, Math.min(limits.attachMs, remaining()), input.signal);
      if (closed) fail('page-bridge-closed', 503);
      if (!listener) return refuse('page-not-attached');
      // Grant may have changed while waiting; re-verify once more before sending
      const again = await current(context);
      if (again.accountId !== binding.accountId || again.pageId !== binding.pageId || again.fenceRevision !== binding.fenceRevision || again.grantState !== 'active') return refuse('run-changed');
      if (listener.gone) return refuse('page-disconnected');
    }
    if (input.signal?.aborted) return refuse('run-cancelled');
    if (remaining() <= 0) { record(context, binding, input, key, 'expired', 'deadline'); return offline('deadline', 'expired'); }

    const nonce = randomNonce();
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) fail('page-bridge-configuration', 503);
    record(context, binding, input, key, 'pending', null, { nonceDigest: sha256(nonce), aclRevision: listener.aclRevision });
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    const waiter = { key, context, binding, listener, resolve, settled: false, timer: null, signals: [], deadline: input.deadline };
    waiting.set(key, waiter);
    listener.waiters.add(waiter);
    waiter.timer = setTimeout(() => { settle(waiter, 'expired', 'deadline', offline('deadline', 'expired')); say('agent.page.offline', { tool: input.tool, why: 'deadline' }); }, Math.max(1, remaining()));
    waiter.timer.unref?.();
    const watch = (signal) => {
      if (!signal || typeof signal.addEventListener !== 'function') return;
      const handler = () => settle(waiter, 'cancelled', 'run-cancelled', offline('run-cancelled', 'cancelled'));
      waiter.signals.push([signal, handler]);
      signal.addEventListener('abort', handler, { once: true });
      if (signal.aborted) handler();
    };
    watch(input.signal);
    try { watch(authority.signalFor?.(context)); } catch { /* No resources registered for this round: no signals to listen to */ }
    if (!waiter.settled) {
      say('agent.page.request', { projectId: context.projectId, runId: context.runId, tool: input.tool });
      try {
        listener.send({ type: 'page.request', v: PAGE_REQUEST_VERSION, id: input.requestId, nonce, runId: context.runId, pageId: binding.pageId,
          tool: input.tool, args: input.args, timeoutMs: Math.max(1, remaining()) });
      } catch { settle(waiter, 'offline', 'page-disconnected', offline('page-disconnected')); }
    }
    return promise;
  }

  /**
   * Have the initiating page execute once. Returns
   * `{ delivered: true, answer: { ok, result?, error? } }` (page submitted; check `answer.ok` for
   * success) or `{ delivered: false, offline: true, why, state }` (initiator offline, timed out,
   * cancelled, or result rejected).
   * Throws `PageBridgeError` when grant no longer exists, assertion mismatches, or arguments violate
   * rules.
   * Repeated calls with the same `requestId` return the same result and do not execute twice on
   * page; same ID with different content returns `idempotency-conflict`.
   */
  function requestPage(request) {
    if (closed) return Promise.reject(new PageBridgeError('page-bridge-closed', 503));
    try {
      if (!plain(request) || Object.keys(request).some((k) => !['run', 'initiatorAccountId', 'pageId', 'tool', 'args', 'requestId', 'deadline', 'signal'].includes(k))) fail('bad-request');
      const context = canonicalContext(request.run);
      if (typeof request.tool !== 'string') fail('page-tool-unknown', 404);
      const args = extra.has(request.tool) ? extra.get(request.tool).args(request.args) : checkedPageArgs(request.tool, request.args, limits);
      if (!plain(args)) fail('bad-args');
      if (typeof request.requestId !== 'string' || !BRIDGE_REQUEST_ID_RE.test(request.requestId)) fail('bad-request-id');
      if (typeof request.initiatorAccountId !== 'string' || !REFERENCE.test(request.initiatorAccountId)) fail('page-binding-mismatch', 403);
      if (request.pageId !== null && (typeof request.pageId !== 'string' || !BRIDGE_PAGE_ID_RE.test(request.pageId))) fail('page-binding-mismatch', 403);
      const at = Number(now());
      const wanted = request.deadline === undefined ? at + limits.pageMs : request.deadline;
      if (typeof wanted !== 'number' || !Number.isFinite(wanted)) fail('bad-deadline');
      const deadline = Math.min(Math.trunc(wanted), at + limits.maxPageMs);
      const key = keyOf(context.projectId, context.conversationId, request.requestId);
      const digest = sha256(JSON.stringify([...CONTEXT_KEYS.map((k) => context[k]), request.tool, args]));
      const live = inflight.get(key);
      if (live) { if (live.digest !== digest) fail('idempotency-conflict', 409); return live.promise; }
      const prior = rowOf(key);
      if (prior) { if (prior.input_digest !== digest) fail('idempotency-conflict', 409); return Promise.resolve(outcomeOfRow(prior)); }
      const input = { tool: request.tool, args, requestId: request.requestId, deadline, digest, signal: request.signal ?? null,
        initiatorAccountId: request.initiatorAccountId, pageId: request.pageId };
      const promise = issue(context, input, key).finally(() => inflight.delete(key));
      inflight.set(key, { digest, promise });
      return promise;
    } catch (error) { return Promise.reject(error); }
  }

  /** Initiator and initiating page for this round (retrieved from current grant in document service). Tool provider uses it to call `requestPage` */
  async function initiator(contextValue) {
    const binding = await current(canonicalContext(contextValue));
    return { initiatorAccountId: binding.accountId, pageId: binding.pageId, grantState: binding.grantState };
  }

  /**
   * Attaches a page's event stream to a chat. `identity` must be the account identity verified with a
   * delegation ticket at the HTTP layer; `pageId` is the presence page ID self-reported by the page
   * (self-reporting is safe: requests are only sent to streams matching both the page ID in document
   * service grant and the account). Returns null for unqualified page IDs (view-only).
   * `aclRevision` is the permission revision of this chat when attached (obtained by HTTP layer when
   * reading chat).
   * @returns {{ detach(): void, update(next: { aclRevision: number }): void } | null}
   */
  function attach({ identity, conversationId, pageId, aclRevision, send } = {}) {
    if (closed) fail('page-bridge-closed', 503);
    if (typeof identity?.accountId !== 'string' || !REFERENCE.test(identity.accountId) || typeof identity.projectId !== 'string' || !REFERENCE.test(identity.projectId) ||
        typeof conversationId !== 'string' || !REFERENCE.test(conversationId) || typeof send !== 'function') fail('bad-request');
    if (typeof pageId !== 'string' || !BRIDGE_PAGE_ID_RE.test(pageId) || !Number.isSafeInteger(aclRevision)) return null;
    const key = convKey(identity.projectId, conversationId);
    let set = streams.get(key);
    if (!set) { set = new Set(); streams.set(key, set); }
    const listener = { accountId: identity.accountId, projectId: identity.projectId, conversationId, pageId, aclRevision, send, gone: false, waiters: new Set() };
    const drop = (old, why) => {
      if (old.gone) return;
      old.gone = true;
      set.delete(old);
      for (const waiter of [...old.waiters]) { settle(waiter, 'offline', why, offline(why)); say('agent.page.offline', { tool: 'page', why }); }
      if (!set.size && streams.get(key) === set) streams.delete(key);
    };
    // Same page reconnecting: the older stream is no longer useful; unsubmitted requests sent over it are closed out as disconnected
    for (const old of [...set]) if (old.accountId === listener.accountId && old.pageId === listener.pageId) drop(old, 'page-disconnected');
    set.add(listener);
    if (streams.get(key) !== set) streams.set(key, set);
    for (const entry of [...attachWaiters]) {
      if (entry.projectId === identity.projectId && entry.conversationId === conversationId && entry.accountId === listener.accountId && entry.pageId === pageId) entry.done(listener);
    }
    return Object.freeze({
      detach() { drop(listener, 'page-disconnected'); },
      update(next) { if (!listener.gone && Number.isSafeInteger(next?.aclRevision)) listener.aclRevision = next.aclRevision; },
    });
  }

  const gone = () => new PageBridgeError('page-request-gone', 410);

  /**
   * The page submits the result of a request. `identity` is the account identity verified with a
   * delegation ticket at the HTTP layer (not from request body).
   * Returns `{ ok: true }` on success (duplicate submission of the same result returns
   * `{ ok: true, duplicate: true }`).
   * Not the initiating page of this request (mismatch in account, page ID, or nonce), or request does
   * not exist at all: same 410 `page-request-gone`, without disclosing which, and does not affect the
   * pending request.
   * Is the initiating page but can no longer be accepted: 410 `page-request-<state>` (expired,
   * cancelled, restart-interrupted, rejected).
   */
  async function acceptResult({ identity, conversationId, body } = {}) {
    if (closed) fail('page-bridge-closed', 503);
    if (typeof identity?.accountId !== 'string' || typeof identity.projectId !== 'string' || typeof conversationId !== 'string' || !REFERENCE.test(conversationId)) fail('bad-request');
    if (!plain(body) || Object.keys(body).some((k) => !['v', 'id', 'nonce', 'pageId', 'runId', 'ok', 'result', 'error', 'code'].includes(k)) ||
        body.v !== PAGE_REQUEST_VERSION || typeof body.ok !== 'boolean' ||
        (body.error !== undefined && typeof body.error !== 'string') || (body.code !== undefined && typeof body.code !== 'string')) fail('bad-request');
    if (typeof body.id !== 'string' || !BRIDGE_REQUEST_ID_RE.test(body.id) || typeof body.nonce !== 'string' || !NONCE_RE.test(body.nonce) ||
        typeof body.pageId !== 'string' || !BRIDGE_PAGE_ID_RE.test(body.pageId)) throw gone();
    const key = keyOf(identity.projectId, conversationId, body.id);
    const row = rowOf(key);
    if (!row || !row.nonce_digest || row.project_id !== identity.projectId || row.conversation_id !== conversationId ||
        row.initiator_account_id !== identity.accountId || row.page_id !== body.pageId ||
        (body.runId !== undefined && body.runId !== row.run_id) || !sameText(row.nonce_digest, sha256(body.nonce))) throw gone();

    let answer = { ok: body.ok, ...(body.result !== undefined ? { result: body.result } : {}),
      ...(body.error !== undefined ? { error: body.error.slice(0, 300) } : {}), ...(body.code !== undefined ? { code: body.code.slice(0, 64) } : {}) };
    // Extension tools define their own shape for page submissions: only recognized fields are kept before persisting to disk; entire submission is rejected if shape is incorrect (handled below as rejection)
    let invalid = false;
    const shape = extra.get(row.tool)?.answer;
    if (shape) {
      try { answer = shape(answer); if (!plain(answer) || typeof answer.ok !== 'boolean') invalid = true; } catch { invalid = true; }
      if (invalid) answer = { ok: false, code: 'result-invalid' };
    }
    let text;
    try { text = JSON.stringify(answer); } catch { fail('bad-request'); }
    const answerDigest = sha256(text);
    const terminal = (found) => {
      if (found.state === 'answered') {
        // Duplicate submission of the same result (page submitted again after missing 200): idempotent, has no further effect
        if (found.answer_digest === answerDigest) return { ok: true, duplicate: true };
        fail('page-result-conflict', 409);
      }
      fail(`page-request-${found.state}`, 410);
    };
    if (row.state !== 'pending') return terminal(row);
    const waiter = waiting.get(key);
    if (!waiter || waiter.settled) { const latest = rowOf(key); if (latest && latest.state !== 'pending') return terminal(latest); fail('page-request-interrupted', 410); }
    const reject = (reason, code = `page-request-${reason}`) => {
      settle(waiter, 'rejected', reason, offline(reason, 'rejected'));
      say('agent.page.rejected', { tool: row.tool, why: reason });
      const latest = rowOf(key);
      if (latest?.state === 'answered') return terminal(latest);
      fail(latest && latest.state !== 'rejected' ? `page-request-${latest.state}` : code, 410);
    };
    if (invalid) {
      settle(waiter, 'rejected', 'result-invalid', offline('result-invalid', 'rejected'));
      say('agent.page.rejected', { tool: row.tool, why: 'result-invalid' });
      fail('page-result-invalid', 422);
    }
    if (Buffer.byteLength(text, 'utf8') > limits.maxResultBytes) {
      settle(waiter, 'rejected', 'result-too-large', offline('result-too-large', 'rejected'));
      fail('page-result-too-large', 413);
    }
    if (Number(now()) > row.deadline_at) { settle(waiter, 'expired', 'deadline', offline('deadline', 'expired')); fail('page-request-expired', 410); }

    // Can the submitter still read this chat at this moment (cannot read after being kicked or the
    // chat was made private by someone else); also reject if the chat's permission version changed
    let access = null;
    try { access = await checkSubmitter(identity, conversationId); } catch { access = null; }
    if (access?.allowed !== true || !Number.isSafeInteger(access.aclRevision)) return reject('submitter-denied');
    if (access.aclRevision !== row.acl_revision) {
      // The chat changed permissions after the request was sent (shared to private, etc.): do not
      // accept this time; subsequent requests on this stream count against the new version
      if (waiter.listener && !waiter.listener.gone) waiter.listener.aclRevision = access.aclRevision;
      return reject('conversation-changed');
    }
    // Authorization for this round: must still be current, still valid for the initiator themself,
    // fence version hasn't changed, and page id hasn't changed
    let binding = null;
    try { binding = await current(waiter.context); } catch { binding = null; }
    if (!binding) return reject('run-revoked');
    if (binding.grantState !== 'active') return reject('initiator-revoked');
    if (binding.fenceRevision !== row.fence_revision) return reject('fence-changed');
    if (binding.accountId !== row.initiator_account_id || binding.pageId !== row.page_id) return reject('page-binding-changed');
    // During verification, it may have timed out, been canceled, that stream disconnected, or another
    // return arrived first
    if (waiter.settled) { const latest = rowOf(key); if (latest) return terminal(latest); throw gone(); }
    if (Number(now()) > row.deadline_at) { settle(waiter, 'expired', 'deadline', offline('deadline', 'expired')); fail('page-request-expired', 410); }
    settle(waiter, 'answered', null, Object.freeze({ delivered: true, answer }), { answerDigest, answer: text });
    return { ok: true };
  }

  /**
   * When this round ends or is halted (finished, stopped, canceled, errored): clean up all waiting
   * ones, reject returns that arrive later. Called by the host in finalize and control channels.
   */
  function cancelRun(scope, reason = 'run-ended') {
    let count = 0;
    for (const waiter of [...waiting.values()]) {
      if (waiter.context.projectId !== scope?.projectId || waiter.context.conversationId !== scope?.conversationId) continue;
      if (scope.runId !== undefined && waiter.context.runId !== scope.runId) continue;
      if (settle(waiter, 'cancelled', reason, offline(reason, 'cancelled'))) count += 1;
    }
    for (const entry of [...attachWaiters]) {
      if (entry.projectId === scope?.projectId && entry.conversationId === scope?.conversationId) entry.done(null);
    }
    return count;
  }

  /**
   * Current status of a request (queried even after restart). Check read permissions against
   * current authorization, only returning for this project and this chat.
   */
  async function status(contextValue, requestId) {
    const context = canonicalContext(contextValue);
    if (typeof requestId !== 'string' || !BRIDGE_REQUEST_ID_RE.test(requestId)) fail('bad-request-id');
    await current(context);
    const row = rowOf(keyOf(context.projectId, context.conversationId, requestId));
    if (!row) fail('page-request-not-found', 404);
    return publicRow(row);
  }

  function close(reason = 'close') {
    if (closed) return { streamsClosed: true, workPending: 0 };
    closed = true;
    for (const waiter of [...waiting.values()]) settle(waiter, 'cancelled', 'host-close', offline('host-close', 'cancelled'));
    for (const entry of [...attachWaiters]) entry.done(null);
    for (const set of streams.values()) for (const listener of set) listener.gone = true;
    streams.clear();
    try { db.close(); } catch { /* Already closed */ }
    say('agent.page.closed', { reason });
    return { streamsClosed: true, workPending: waiting.size };
  }

  return Object.freeze({
    requestPage, initiator, attach, acceptResult, cancelRun, status, close, limits, extraTools: Object.freeze([...extra.keys()]),
    describe: () => ({ waiting: waiting.size, streams: [...streams.values()].reduce((sum, set) => sum + set.size, 0), closed }),
  });
}

/**
 * Provider for the three tools `user_interface_seek`, `user_interface_play`, and
 * `user_interface_pause` (same shape as other tool packages: `handles` /
 * `call(name, args, context)` / `close(reason)`).
 * Replies to the model match the old channel: return the page result; if the initiator is
 * offline, return `initiatorOffline` from `cloud-tools.mjs`.
 * The fourth argument to `call` can take `{ requestId, signal }`: when host retries the same tool
 * call, give the same request id so the page does not execute twice.
 * `onPlayhead(context, t)`: after `seek` succeeds, notify host to update the playhead remembered
 * for this chat to the new one (used by tools that switch cuts).
 */
export function createPageControlTools({ bridge, onPlayhead = null, now = Date.now, newRequestId = () => randomBytes(16).toString('base64url') } = {}) {
  if (typeof bridge?.requestPage !== 'function' || typeof bridge?.initiator !== 'function') fail('page-bridge-configuration', 503);
  const handles = new Set(PAGE_CONTROL_TOOL_NAMES);
  async function call(nameIn, args, context, options = {}) {
    // Model-side names (accepts both old and new); sent to the page is the old internal operation name
    const name = modelToolName(nameIn);
    if (!handles.has(name)) fail('page-tool-unknown', 404);
    const wire = pageToolName(name);
    let send;
    try { send = checkedPageArgs(wire, args, bridge.limits); } catch (error) {
      if (error?.code !== 'bad-args') throw error;
      return { ok: false, error: wire === 'seek' ? `${name} needs t (seconds, a number not less than 0).` : `${name} does not accept parameters.` };
    }
    const who = await bridge.initiator(context);
    const out = await bridge.requestPage({ run: context, initiatorAccountId: who.initiatorAccountId, pageId: who.pageId, tool: wire, args: send,
      requestId: options.requestId ?? newRequestId(), deadline: Number(now()) + bridge.limits.pageMs, ...(options.signal ? { signal: options.signal } : {}) });
    if (!out.delivered) return initiatorOffline(name);
    const answer = out.answer;
    if (answer.ok !== true) return { ok: false, error: String(answer.error || `${name} did not succeed on the initiator's page`) };
    if (wire === 'seek' && typeof onPlayhead === 'function') { try { await onPlayhead(context, send.t); } catch { /* Host responsibility */ } }
    return answer.result && typeof answer.result === 'object' && !Array.isArray(answer.result) ? answer.result : { ok: true };
  }
  return Object.freeze({ handles, call, async close() { return { childrenClosed: true, streamsClosed: true, workPending: 0 }; } });
}
