/**
 * Cloud Agent media collection delegates downloads for "sites requiring login" to the initiator's
 * own computer (package C1 of plan `docs/plan/cloud-agent-tools-implementation.md`).
 *
 * Site login state must remain solely on the user's own computer and is never sent to cloud nodes.
 * Therefore:
 *
 *   - `collect_download` defaults to anonymous cloud download (`hosted-collect.mjs`). When a link
 *     belongs to a site with login support and the initiator is currently online, it first queries
 *     their page via the reverse channel (`page-bridge.mjs`, W2 trusted return protocol): if the
 *     page is the desktop app and the local machine has valid login state for this site, their
 *     computer downloads using the local login state and uploads **directly** into this project's
 *     asset service upon completion;
 *   - The cloud only receives a receipt
 *     `{ requestId, jobId, assetRef: { projectId, hash, size }, result }`. The receipt is the response
 *     to a page request, so re-verification upon return (submitter is initiator, chat permission
 *     version unchanged, authorization for this run remains current, fence revision unchanged,
 *     page id matches nonce, not timed out) entirely follows the reverse channel's existing
 *     mechanisms; receipts arriving after the chat becomes private, is stopped, or the initiator
 *     is kicked are rejected there;
 *   - After receiving the receipt, this file performs three further checks before accepting it:
 *     checks write permission for the current run; verifies with the asset service that "these
 *     bytes indeed exist in this project's media library and the hash and size match" (F0
 *     `ProjectAssets.verifyRef`); checks write permission once more, then hands off to host to
 *     register into the project (host submits with expected revision);
 *   - When delegation fails (initiator offline, page is not desktop app, local machine has no login
 *     state, timeout, local download or upload fails, receipt verification fails), returns
 *     "delegation failed" and the reason; `hosted-collect.mjs` proceeds with anonymous cloud
 *     download and notes the reason and image quality difference in the job notes;
 *   - `user_interface_collect_login` (internal action name sent to page remains `collect_login`)
 *     and `collect_login_check` operate solely on the user's computer: asks initiator page via the
 *     same channel to open the local login window or check local login state, with the cloud only
 *     receiving back "whether opened" and "whether logged in".
 *
 * What the cloud never receives or stores: cookies, request headers, browser user data directory,
 * local paths, and site user identifiers. Answers returned by the page are first checked against an
 * allowlist (rejected entirely if any extra fields are present; `page-bridge.mjs` does not persist
 * to disk); delegation records contain only hash, size, status, and reason codes, and links only
 * store a digest.
 *
 * A download may take several minutes, while a single page request waits at most one minute: thus
 * three short requests are used: "start → poll periodically → cancel", each being an independent,
 * fully re-verified page request. Reconnection after mid-session disconnection (page id unchanged)
 * does not disrupt it; if disconnected past the grace period, it falls back to anonymous as offline.
 *
 * This file does not mount routes, touch tool tables, validate tickets, or import `src/`. Wiring
 * (passing `collectPageTools()` to `extraTools` of `createPageBridge`, passing `forRun(context)` to
 * `delegate` of `hosted-collect.mjs`) belongs to the final wiring package.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { siteNames, siteOfUrl } from '../../collect-cookies.mjs';
import { initiatorOffline } from './cloud-tools.mjs';

/**
 * Five request types added to reverse channel (page-side allowlist is `COLLECT_PAGE_REQUEST_TOOLS`
 * in `src/ai/cloud/collectBridge.ts`, reconciled in unit tests)
 */
export const COLLECT_PAGE_TOOLS = Object.freeze(['collect_delegate_start', 'collect_delegate_poll', 'collect_delegate_cancel', 'collect_login', 'collect_login_check']);

export const COLLECT_BRIDGE_DEFAULTS = Object.freeze({
  /** How often to poll local download progress */
  pollMs: 2_000,
  /** Maximum wait time for a delegation (same value as wall-clock limit for cloud anonymous downloads) */
  delegateMs: 15 * 60_000,
  /** How long to wait when initiator page disconnects midway; falls back to anonymous once expired */
  offlineGraceMs: 20_000,
  /** Maximum file count and total size in a single receipt (same limits as cloud anonymous downloads) */
  maxItems: 20,
  maxBytes: 512 * 1024 * 1024,
  /** How long to retain finished delegation records */
  retainMs: 7 * 24 * 3600_000,
  maxUrlChars: 2000,
});

/**
 * Delegation status. All states other than `asking`, `downloading`, `verifying`, and `registering`
 * are terminal states
 */
export const DELEGATION_STATES = Object.freeze(['asking', 'downloading', 'verifying', 'registering', 'done', 'fallback', 'rejected', 'cancelled', 'interrupted']);
const LIVE_STATES = Object.freeze(['asking', 'downloading', 'verifying', 'registering']);

export class CollectBridgeError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'CollectBridgeError';
    this.code = code;
    this.status = status;
  }
}
const fail = (code, status = 400) => { throw new CollectBridgeError(code, status); };

const HASH_RE = /^[0-9a-f]{64}$/;
const DELEGATION_ID_RE = /^cd-[0-9a-f]{24}$/;
const JOB_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const CODE_RE = /^[a-z][a-z0-9-]{0,39}$/;
const REF_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/**
 * Filename: accepts only a single name segment; rejects anything with path separators, drive
 * colons, or control characters (local paths are never sent to the cloud)
 */
const NAME_RE = /^[^\\/:\u0000-\u001f]{1,200}$/;
const QUALITIES = new Set([2160, 1440, 1080, 720, 480, 360]);
const PRESETS = new Set(['auto', 'bilibili', 'generic']);
const KINDS = new Set(['video', 'audio', 'image']);
const STAGES = new Set(['starting', 'video', 'audio', 'merge', 'transcode', 'ingest', 'upload', 'done']);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, required, optional = []) => plain(value) && required.every((k) => Object.hasOwn(value, k)) &&
  Object.keys(value).every((k) => required.includes(k) || optional.includes(k));
const codeOf = (value, fallback = 'failed') => (typeof value === 'string' && CODE_RE.test(value) ? value : fallback);
const bad = () => { throw new Error('bad-shape'); };

function checkedRef(value) {
  if (!exact(value, ['projectId', 'hash', 'size']) || typeof value.projectId !== 'string' || !REF_RE.test(value.projectId) ||
      typeof value.hash !== 'string' || !HASH_RE.test(value.hash) || !Number.isSafeInteger(value.size) || value.size < 1) bad();
  return { projectId: value.projectId, hash: value.hash, size: value.size };
}

/** Receipt returned by page: recognizes only these items; rejected entirely if any extra fields are included */
function checkedReceipt(value, limits) {
  if (!exact(value, ['requestId', 'jobId', 'assetRef', 'result']) || typeof value.requestId !== 'string' || !DELEGATION_ID_RE.test(value.requestId) ||
      typeof value.jobId !== 'string' || !JOB_ID_RE.test(value.jobId)) bad();
  const assetRef = checkedRef(value.assetRef);
  if (!exact(value.result, ['items'], ['cookiesUsed']) || !Array.isArray(value.result.items) || value.result.items.length < 1 ||
      value.result.items.length > limits.maxItems || (value.result.cookiesUsed !== undefined && typeof value.result.cookiesUsed !== 'boolean')) bad();
  let total = 0;
  const num = (v, max) => (v === undefined ? undefined : (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : bad()));
  const items = value.result.items.map((item) => {
    if (!exact(item, ['assetRef', 'name', 'kind'], ['title', 'duration', 'width', 'height', 'vcodec']) ||
        typeof item.name !== 'string' || !NAME_RE.test(item.name) || !KINDS.has(item.kind) ||
        (item.title !== undefined && (typeof item.title !== 'string' || item.title.length > 200)) ||
        (item.vcodec !== undefined && (typeof item.vcodec !== 'string' || !/^[A-Za-z0-9_.-]{1,32}$/.test(item.vcodec)))) bad();
    const ref = checkedRef(item.assetRef);
    total += ref.size;
    const duration = num(item.duration, 48 * 3600); const width = num(item.width, 65_536); const height = num(item.height, 65_536);
    return { assetRef: ref, name: item.name, kind: item.kind, ...(item.title !== undefined ? { title: item.title } : {}),
      ...(duration !== undefined ? { duration } : {}), ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}),
      ...(item.vcodec !== undefined ? { vcodec: item.vcodec } : {}) };
  });
  if (total > limits.maxBytes) bad();
  if (items[0].assetRef.projectId !== assetRef.projectId || items[0].assetRef.hash !== assetRef.hash || items[0].assetRef.size !== assetRef.size) bad();
  return { requestId: value.requestId, jobId: value.jobId, assetRef, result: { items, ...(value.result.cookiesUsed !== undefined ? { cookiesUsed: value.result.cookiesUsed } : {}) } };
}

/**
 * The portion passed to `createPageBridge({ extraTools })`: for each of five requests, "how to
 * validate parameters sent to page" and "which items of answer returned by page to keep".
 * When the page fails, only keep code (`code`); omit its message: it may contain local paths.
 */
export function collectPageTools(limitOverrides = {}) {
  const limits = { ...COLLECT_BRIDGE_DEFAULTS, ...limitOverrides };
  const argError = () => fail('bad-args');
  const failed = (answer) => ({ ok: false, code: codeOf(answer.code) });
  const site = (value) => (typeof value === 'string' && siteNamesSet().has(value) ? value : argError());
  const delegationId = (args) => (exact(args, ['delegationId']) && typeof args.delegationId === 'string' && DELEGATION_ID_RE.test(args.delegationId)
    ? { delegationId: args.delegationId } : argError());
  return Object.freeze({
    collect_delegate_start: {
      args(args) {
        if (!exact(args, ['delegationId', 'jobId', 'projectId', 'url', 'site', 'quality'], ['preset', 'audioOnly', 'allParts', 'keepCodec'])) argError();
        if (typeof args.delegationId !== 'string' || !DELEGATION_ID_RE.test(args.delegationId) || typeof args.jobId !== 'string' || !JOB_ID_RE.test(args.jobId) ||
            typeof args.projectId !== 'string' || !REF_RE.test(args.projectId) || typeof args.url !== 'string' || !args.url || args.url.length > limits.maxUrlChars ||
            typeof args.site !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(args.site) || !QUALITIES.has(args.quality) ||
            (args.preset !== undefined && !PRESETS.has(args.preset)) ||
            ['audioOnly', 'allParts', 'keepCodec'].some((k) => args[k] !== undefined && typeof args[k] !== 'boolean')) argError();
        return { delegationId: args.delegationId, jobId: args.jobId, projectId: args.projectId, url: args.url, site: args.site, quality: args.quality,
          ...(args.preset && args.preset !== 'auto' ? { preset: args.preset } : {}),
          ...(args.audioOnly ? { audioOnly: true } : {}), ...(args.allParts ? { allParts: true } : {}), ...(args.keepCodec ? { keepCodec: true } : {}) };
      },
      answer(answer) {
        if (answer.ok !== true) return failed(answer);
        const r = answer.result;
        if (exact(r, ['accepted']) && r.accepted === true) return { ok: true, result: { accepted: true } };
        if (exact(r, ['accepted', 'code']) && r.accepted === false) return { ok: true, result: { accepted: false, code: codeOf(r.code) } };
        return bad();
      },
    },
    collect_delegate_poll: {
      args: delegationId,
      answer(answer) {
        if (answer.ok !== true) return failed(answer);
        const r = answer.result;
        if (!plain(r) || typeof r.state !== 'string') bad();
        if (r.state === 'running') {
          if (!exact(r, ['state'], ['stage', 'percent']) || (r.stage !== undefined && !STAGES.has(r.stage)) ||
              (r.percent !== undefined && (typeof r.percent !== 'number' || !Number.isFinite(r.percent) || r.percent < 0 || r.percent > 100))) bad();
          return { ok: true, result: { state: 'running', ...(r.stage !== undefined ? { stage: r.stage } : {}), ...(r.percent !== undefined ? { percent: r.percent } : {}) } };
        }
        if (r.state === 'error') { if (!exact(r, ['state'], ['code'])) bad(); return { ok: true, result: { state: 'error', code: codeOf(r.code) } }; }
        if (r.state === 'unknown') { if (!exact(r, ['state'])) bad(); return { ok: true, result: { state: 'unknown' } }; }
        if (r.state === 'done') { if (!exact(r, ['state', 'receipt'])) bad(); return { ok: true, result: { state: 'done', receipt: checkedReceipt(r.receipt, limits) } }; }
        return bad();
      },
    },
    collect_delegate_cancel: {
      args: delegationId,
      answer: (answer) => (answer.ok === true ? { ok: true } : failed(answer)),
    },
    collect_login: {
      args(args) {
        if (!exact(args, ['site'], ['method', 'force']) || (args.method !== undefined && !['qr', 'browser'].includes(args.method)) ||
            (args.force !== undefined && typeof args.force !== 'boolean')) argError();
        return { site: site(args.site), method: args.method ?? 'qr', ...(args.force ? { force: true } : {}) };
      },
      answer(answer) {
        if (answer.ok !== true) return failed(answer);
        const r = answer.result;
        if (!exact(r, [], ['opened', 'alreadyLoggedIn']) || [r.opened, r.alreadyLoggedIn].some((v) => v !== undefined && typeof v !== 'boolean')) bad();
        return { ok: true, result: { opened: r.opened === true, alreadyLoggedIn: r.alreadyLoggedIn === true } };
      },
    },
    collect_login_check: {
      args(args) {
        if (!exact(args, ['site'], ['hide']) || (args.hide !== undefined && typeof args.hide !== 'boolean')) argError();
        return { site: site(args.site), ...(args.hide === false ? { hide: false } : {}) };
      },
      answer(answer) {
        if (answer.ok !== true) return failed(answer);
        const r = answer.result;
        if (!exact(r, ['loggedIn'], ['expired']) || typeof r.loggedIn !== 'boolean' || (r.expired !== undefined && typeof r.expired !== 'boolean')) bad();
        return { ok: true, result: { loggedIn: r.loggedIn, ...(r.expired ? { expired: true } : {}) } };
      },
    },
  });
}
const siteNamesSet = () => new Set(siteNames());

/**
 * Text presented to model (not UI text; syntax follows existing collection tools, see
 * `server/tools/collect.mjs` and `hosted-collect.mjs`).
 * Phrasing is a draft, centralized here and replaceable as a whole.
 */
export const COLLECT_BRIDGE_TEXT = Object.freeze({
  /** Sentence written into job notes when falling back to anonymous: reason + image quality difference */
  fallback: Object.freeze({
    'initiator-offline': 'This site offers higher quality after login, but the initiator is offline now, so the login state on their computer can\'t be used',
    'page-without-local-collect': 'This site offers higher quality after login, but the initiator is currently using the web version (no local collection or login state)',
    'not-logged-in': 'The initiator\'s computer has no login state for this site yet (if needed, run user_interface_collect_login first so they can log in on their own computer)',
    'local-not-ready': 'The collection tools on the initiator\'s computer are not ready (yt-dlp is not installed or ffmpeg is missing)',
    'local-busy': 'The initiator\'s computer is downloading another link for this chat',
    'local-download-failed': 'The initiator\'s computer failed to download this link using its login state',
    'upload-failed': 'The initiator\'s computer finished downloading, but could not upload the file to this project\'s media library',
    'timeout': 'The initiator\'s computer did not finish downloading and uploading in time',
    'receipt-invalid': 'The receipt returned by the initiator\'s computer is invalid and was not used',
    'asset-unverified': 'The asset service cannot find the file that the initiator\'s computer reported as uploaded, so it was not used',
    failed: 'Delegated download on the initiator\'s computer failed',
  }),
  fallbackTail: '; switched to a cloud download at logged-out quality, which may be lower than the logged-in quality.',
  delegated: 'This link was downloaded by the initiator\'s own computer using the login state on their machine, and the file was uploaded straight from their computer to this project\'s media library; the login information never left their computer.',
  revoked: 'This task was stopped, or no longer has permission to write media into this project; the file returned by the initiator\'s computer was not registered in the project.',
  registerFailed: 'The initiator\'s computer uploaded the file to the media library, but it could not be registered in the project',
  loginOpened: 'The login window has opened on the initiator\'s own computer. Login can only be completed by them on their own computer; the login state stays on their computer and the cloud cannot get it. **Stop now** and tell the user "The login window has opened on your computer. Scan the QR code or switch to account and password login, then tell me when you are done", **do not keep calling tools**; after the user replies, call collect_login_check.',
  loginAlready: 'The initiator\'s computer already has an unexpired login state for this site, so no login is needed. Later, when collect_download is called for a link on this site, their computer will download it with the login state (while they are online).',
  loginChecked: 'Already logged in on the initiator\'s computer. The login state stays on their computer only; later, when collect_download is called for a link on this site, their computer will download it with the login state (while they are online).',
  loginMissing: 'The initiator\'s computer has no login state yet. Ask them to finish logging in in the login window that opened on their computer, then check again; do not poll repeatedly, wait for the user to reply.',
  loginExpired: 'The login state on the initiator\'s computer has expired. Call user_interface_collect_login again so they can log in once more on their own computer.',
  webPage: (tool) => `${tool} can only be used on the initiator's own computer, and they are currently using the web version (no local login window). Tell the user to log in from PromptCut on their computer; the cloud will keep collecting at logged-out quality as usual.`,
  loginFailed: (tool) => `${tool} did not succeed on the initiator's computer. Tell the user to log in once themselves from PromptCut on their computer; the cloud will keep collecting at logged-out quality as usual.`,
});

function openLedger(databasePath, now, retainMs) {
  if (typeof databasePath !== 'string' || databasePath.trim() === '' || databasePath === ':memory:') fail('collect-bridge-configuration', 503);
  const file = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(file);
  const db = new DatabaseSync(file);
  if (!existed && process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch { db.close(); fail('collect-bridge-configuration', 503); } }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS collect_delegations (
    delegation_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    initiator_account_id TEXT NOT NULL,
    site TEXT NOT NULL,
    url_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('asking','downloading','verifying','registering','done','fallback','rejected','cancelled','interrupted')),
    reason TEXT,
    receipt_digest TEXT,
    refs TEXT NOT NULL DEFAULT '[]',
    media TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS collect_delegations_job ON collect_delegations (project_id, conversation_id, job_id);');
  const at = Number(now());
  // Still in progress by previous process: run waiting for it is gone; late receipts must not be registered
  db.prepare(`UPDATE collect_delegations SET state='interrupted', reason='agent-restart', updated_at=? WHERE state IN ('asking','downloading','verifying','registering')`).run(at);
  db.prepare(`DELETE FROM collect_delegations WHERE state NOT IN ('asking','downloading','verifying','registering') AND updated_at < ?`).run(at - retainMs);
  return db;
}

/**
 * @param {object} o
 * @param {object} o.bridge Reverse channel created by `createPageBridge({ …, extraTools: collectPageTools() })`
 * @param {string} o.databasePath SQLite file for delegation records (in private data directory)
 * @param {{ verifyRef(context: object, ref: {projectId: string, hash: string, size: number}): Promise<{assetRef: object}> }} o.assets
 *   F0 `createProjectAssets`: verifies with asset service whether these bytes exist in this
 *   project's media library
 * @param {(context: object, action: 'read'|'write') => Promise<{allowed: true, fenceRevision: number, grantState: string}>} o.authorize
 *   `authorize` of run resource registry: re-verifies current authorization for this run with
 *   document service each time
 * @param {(context: object, entry: object) => Promise<{mediaId: string, kind?: string, clipId?: string}>} o.register
 *   Registers bytes already in media library into project (host submits with expected revision;
 *   duplicate calls with same `entry.requestId` are not registered twice)
 * @param {(url: string) => string | null} [o.loginSiteOf] Which site with login support a link
 *   belongs to (defaults to `siteOfUrl` in `collect-cookies.mjs`)
 */
export function createCollectBridge({ bridge, databasePath, assets, authorize, register, loginSiteOf = siteOfUrl, limits: limitOverrides = {},
  now = Date.now, log = () => {}, newId = () => `cd-${randomBytes(12).toString('hex')}` } = {}) {
  if (typeof bridge?.requestPage !== 'function' || typeof bridge?.initiator !== 'function' || !Array.isArray(bridge.extraTools) ||
      COLLECT_PAGE_TOOLS.some((name) => !bridge.extraTools.includes(name)) || typeof assets?.verifyRef !== 'function' ||
      typeof authorize !== 'function' || typeof register !== 'function' || typeof loginSiteOf !== 'function') fail('collect-bridge-configuration', 503);
  const limits = Object.freeze({ ...COLLECT_BRIDGE_DEFAULTS, ...limitOverrides });
  const db = openLedger(databasePath, now, limits.retainMs);
  const say = (event, fields) => { try { log(event, fields); } catch { /* Logging concerns */ } };
  let closed = false;
  /** delegation_id -> the attempt currently being verified and registered (duplicate receipts share one result) */
  const settling = new Map();
  /** Delegations being waited on (cleaned up together on close) */
  const live = new Set();

  const rowOf = (id) => db.prepare('SELECT * FROM collect_delegations WHERE delegation_id=?').get(id) ?? null;
  const viewOf = (row) => ({ delegationId: row.delegation_id, jobId: row.job_id, projectId: row.project_id, conversationId: row.conversation_id, runId: row.run_id,
    site: row.site, state: row.state, reason: row.reason ?? null, refs: JSON.parse(row.refs), media: JSON.parse(row.media), createdAt: row.created_at, updatedAt: row.updated_at });
  function mark(id, state, reason = null, more = {}) {
    try {
      db.prepare(`UPDATE collect_delegations SET state=?, reason=?, receipt_digest=COALESCE(?, receipt_digest), refs=COALESCE(?, refs), media=COALESCE(?, media), updated_at=?
        WHERE delegation_id=? AND state IN ('asking','downloading','verifying','registering')`)
        .run(state, reason, more.receiptDigest ?? null, more.refs ? JSON.stringify(more.refs) : null, more.media ? JSON.stringify(more.media) : null, Number(now()), id);
    } catch { /* After closing database: caller finalizes as usual */ }
  }

  const pause = (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

  /**
   * Sends a request to initiator page. Throws (`PageBridgeError`, 403) when authorization for this
   * run is gone; initiator and initiator page are populated from document service authorization
   */
  async function ask(context, tool, args, requestId, signal) {
    const who = await bridge.initiator(context);
    return bridge.requestPage({ run: context, initiatorAccountId: who.initiatorAccountId, pageId: who.pageId, tool, args, requestId,
      deadline: Number(now()) + bridge.limits.pageMs, ...(signal ? { signal } : {}) });
  }
  const revoked = (error) => error?.status === 403 || ['run-access-denied', 'tool-context-untrusted', 'tool-context-invalid', 'run-page-binding-invalid'].includes(error?.code);
  const fallbackNote = (why) => `${COLLECT_BRIDGE_TEXT.fallback[why] ?? COLLECT_BRIDGE_TEXT.fallback.failed}${COLLECT_BRIDGE_TEXT.fallbackTail}`;
  const notDelegated = (why, note = fallbackNote(why)) => Object.freeze({ delegated: false, why, note });
  const stopped = (why, message) => Object.freeze({ delegated: false, stop: true, why, message });

  /**
   * Whether this run can still write to project at this moment (queries document service each time;
   * treated as cannot proceed if unreachable)
   */
  const canWrite = async (context) => {
    try { const auth = await authorize(context, 'write'); return auth?.allowed === true; } catch { return false; }
  };

  /**
   * Receives a receipt: check write permission → verify bytes with asset service → check write
   * permission again → register. Duplicate receipts return the same result and are not registered
   * twice; receipts arriving after a delegation has reached another conclusion (fell back, rejected,
   * canceled, interrupted by restart) are never registered.
   */
  function settleReceipt(context, id, receiptValue) {
    let receipt;
    try { receipt = checkedReceipt(receiptValue, limits); } catch { receipt = null; }
    const digest = receipt ? sha256(JSON.stringify(receipt)) : null;
    const running = settling.get(id);
    if (running) return running.digest === digest ? running.promise : Promise.resolve(notDelegated('receipt-invalid'));
    const promise = (async () => {
      const row = rowOf(id);
      if (!row || row.project_id !== context.projectId || row.conversation_id !== context.conversationId || row.run_id !== context.runId) return notDelegated('receipt-invalid');
      if (row.state === 'done') {
        if (digest && row.receipt_digest === digest) return Object.freeze({ delegated: true, duplicate: true, items: JSON.parse(row.media) });
        return notDelegated('receipt-invalid');
      }
      if (!LIVE_STATES.includes(row.state)) return stopped(row.reason ?? row.state, COLLECT_BRIDGE_TEXT.revoked);
      const refs = receipt ? receipt.result.items.map((item) => ({ hash: item.assetRef.hash, size: item.assetRef.size })) : [];
      // Request id, job id, and project in receipt must match this delegation: request ids from other
      // chats or hashes from other projects are rejected here
      if (!receipt || receipt.requestId !== id || receipt.jobId !== row.job_id ||
          receipt.result.items.some((item) => item.assetRef.projectId !== context.projectId)) {
        mark(id, 'rejected', 'receipt-invalid');
        say('agent.collect.delegate', { projectId: context.projectId, runId: context.runId, state: 'rejected', why: 'receipt-invalid' });
        return notDelegated('receipt-invalid');
      }
      mark(id, 'verifying', null, { refs });
      const writable = () => canWrite(context);
      // Can this run still write to project right now? (stopped, revoked after converting to private,
      // initiator kicked, or no write permission: do not register; bytes remain unreferenced in media
      // library)
      if (!(await writable())) {
        mark(id, 'rejected', 'run-revoked', { refs });
        say('agent.collect.delegate', { projectId: context.projectId, runId: context.runId, state: 'rejected', why: 'run-revoked' });
        return stopped('run-revoked', COLLECT_BRIDGE_TEXT.revoked);
      }
      const verified = [];
      for (const item of receipt.result.items) {
        let found = null;
        try { found = await assets.verifyRef(context, item.assetRef); } catch { found = null; }
        const ref = found?.assetRef;
        if (!ref || ref.projectId !== item.assetRef.projectId || ref.hash !== item.assetRef.hash || ref.size !== item.assetRef.size) {
          mark(id, 'rejected', 'asset-unverified', { refs });
          say('agent.collect.delegate', { projectId: context.projectId, runId: context.runId, state: 'rejected', why: 'asset-unverified' });
          return notDelegated('asset-unverified');
        }
        verified.push({ item, ref });
      }
      mark(id, 'registering', null, { refs });
      const media = [];
      for (const [index, { item, ref }] of verified.entries()) {
        if (!(await writable())) {
          mark(id, 'rejected', 'run-revoked', { refs, media });
          return stopped('run-revoked', COLLECT_BRIDGE_TEXT.revoked);
        }
        try {
          // Kind and extension are determined by verification result from asset service (page values are
          // only used when omitted)
          const kind = /^(video|audio|image)\//.exec(String(ref.contentType ?? ''))?.[1] ?? item.kind;
          const ext = typeof ref.ext === 'string' && /^[a-z0-9]{1,8}$/.test(ref.ext) ? ref.ext : (/\.([A-Za-z0-9]{1,8})$/.exec(item.name)?.[1] ?? '').toLowerCase();
          const out = await register(context, { requestId: `${id}:${index}`, sourceJobId: row.job_id, assetRef: item.assetRef, kind, ext, name: item.name,
            ...(item.title !== undefined ? { title: item.title } : {}), ...(item.duration !== undefined ? { duration: item.duration } : {}),
            ...(item.width !== undefined ? { width: item.width } : {}), ...(item.height !== undefined ? { height: item.height } : {}) });
          if (typeof out?.mediaId !== 'string' || !out.mediaId) throw new Error('register-result-invalid');
          media.push({ mediaId: out.mediaId, kind: out.kind ?? kind, ...(out.clipId ? { clipId: out.clipId } : {}), filename: item.name,
            ...(item.title !== undefined ? { title: item.title } : {}), ...(item.duration !== undefined ? { duration: item.duration } : {}),
            ...(item.width !== undefined ? { width: item.width } : {}), ...(item.height !== undefined ? { height: item.height } : {}),
            ...(item.vcodec !== undefined ? { vcodec: item.vcodec } : {}), bytes: item.assetRef.size });
        } catch (error) {
          const denied = error?.status === 403 || error?.status === 401 || error?.code === 'forbidden';
          mark(id, 'rejected', denied ? 'run-revoked' : 'register-failed', { refs, media });
          say('agent.collect.delegate', { projectId: context.projectId, runId: context.runId, state: 'rejected', why: denied ? 'run-revoked' : 'register-failed' });
          return stopped(denied ? 'run-revoked' : 'register-failed', denied ? COLLECT_BRIDGE_TEXT.revoked : `${COLLECT_BRIDGE_TEXT.registerFailed}.`);
        }
      }
      mark(id, 'done', null, { receiptDigest: digest, refs, media });
      say('agent.collect.delegate', { projectId: context.projectId, runId: context.runId, state: 'done', items: media.length });
      return Object.freeze({ delegated: true, items: media });
    })().finally(() => { if (settling.get(id)?.promise === promise) settling.delete(id); });
    settling.set(id, { digest, promise });
    return promise;
  }

  /**
   * Attempts to delegate a download to the initiator's computer. Returns `{ delegated: true, items }`
   * (verified and registered), `{ delegated: false, why, note }` (delegation failed: caller proceeds
   * with anonymous download in the cloud, `note` written into job notes; `note` being null means this
   * link did not need delegation in the first place), or
   * `{ delegated: false, stop: true, why, message }` (this run can no longer write, or registration
   * failed: do not proceed with anonymous download).
   * `job` is the entry in cloud jobs table (reads only its `id`, `url`, `quality`, `site`);
   * `onProgress({ state, stage?, percent? })` is optional.
   */
  async function delegateDownload(context, job, args = {}, { signal = null, onProgress = () => {} } = {}) {
    if (closed) fail('collect-bridge-closed', 503);
    let site = null;
    try { site = loginSiteOf(job.url); } catch { site = null; }
    // Not belonging to a site with login support: defaults to cloud anonymous download without
    // disturbing initiator page
    if (typeof site !== 'string' || !site) return notDelegated('no-login-site', null);
    let who;
    try { who = await bridge.initiator(context); } catch (error) { if (revoked(error)) return stopped('run-revoked', COLLECT_BRIDGE_TEXT.revoked); return notDelegated('initiator-offline'); }
    const id = newId();
    if (!DELEGATION_ID_RE.test(id) || typeof job?.id !== 'string' || !JOB_ID_RE.test(job.id)) fail('collect-bridge-configuration', 503);
    const at = Number(now());
    db.prepare(`INSERT INTO collect_delegations (delegation_id, job_id, project_id, conversation_id, run_id, grant_id, initiator_account_id, site, url_digest, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'asking', ?, ?)`).run(id, job.id, context.projectId, context.conversationId, context.runId, context.runGrantId,
      who.initiatorAccountId, site, sha256(String(job.url)), at, at);
    const entry = { id, abort: new AbortController() };
    live.add(entry);
    const onAbort = () => entry.abort.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) entry.abort.abort();
    const local = entry.abort.signal;
    let seq = 0;
    const progress = (value) => { try { onProgress(value); } catch { /* Caller concerns */ } };
    const end = (state, why, outcome) => {
      mark(id, state, why);
      say('agent.collect.delegate', { projectId: context.projectId, runId: context.runId, state, why });
      return outcome;
    };
    /** Stops local machine (best effort: ignored if page is absent; it cleans up itself upon timeout) */
    const cancelPage = async () => { try { await ask(context, 'collect_delegate_cancel', { delegationId: id }, `${id}-x`); } catch { /* This run is gone */ } };
    try {
      let out;
      try {
        out = await ask(context, 'collect_delegate_start', { delegationId: id, jobId: job.id, projectId: context.projectId, url: job.url, site, quality: job.quality,
          ...(typeof job.site === 'string' && job.site !== 'auto' ? { preset: job.site } : {}),
          ...(args.audioOnly === true ? { audioOnly: true } : {}), ...(args.allParts === true ? { allParts: true } : {}), ...(args.keepCodec === true ? { keepCodec: true } : {}) },
        `${id}-s`, local);
      } catch (error) {
        if (revoked(error)) return end('cancelled', 'run-revoked', stopped('run-revoked', COLLECT_BRIDGE_TEXT.revoked));
        return end('fallback', 'initiator-offline', notDelegated('initiator-offline'));
      }
      if (local.aborted) { await cancelPage(); return end('cancelled', 'run-cancelled', stopped('run-cancelled', 'Cancelled')); }
      if (!out.delivered) return end('fallback', 'initiator-offline', notDelegated('initiator-offline'));
      if (out.answer.ok !== true) {
        const why = out.answer.code === 'unsupported' ? 'page-without-local-collect' : 'failed';
        return end('fallback', why, notDelegated(why));
      }
      if (out.answer.result?.accepted !== true) {
        const code = out.answer.result?.code;
        const why = ['not-logged-in', 'local-not-ready', 'local-busy'].includes(code) ? code : code === 'unsupported' ? 'page-without-local-collect' : 'failed';
        return end('fallback', why, notDelegated(why));
      }
      mark(id, 'downloading');
      progress({ state: 'downloading', stage: 'starting', percent: 0 });
      const started = Number(now());
      let lastSeen = started;
      for (;;) {
        await pause(limits.pollMs, local);
        if (closed) return stopped('host-close', 'The Cloud Agent service is shutting down, so this download was interrupted.');
        if (local.aborted) { await cancelPage(); return end('cancelled', 'run-cancelled', stopped('run-cancelled', 'Cancelled')); }
        if (Number(now()) - started > limits.delegateMs) { await cancelPage(); return end('fallback', 'timeout', notDelegated('timeout')); }
        let poll;
        try { poll = await ask(context, 'collect_delegate_poll', { delegationId: id }, `${id}-p${seq++}`, local); } catch (error) {
          if (revoked(error)) return end('cancelled', 'run-revoked', stopped('run-revoked', COLLECT_BRIDGE_TEXT.revoked));
          poll = { delivered: false, offline: true, why: 'authority-unavailable', state: 'offline' };
        }
        if (!poll.delivered) {
          if (local.aborted || poll.state === 'cancelled') { if (local.aborted) await cancelPage(); return end('cancelled', 'run-cancelled', stopped('run-cancelled', 'Cancelled')); }
          // Rejected upon return (chat turned private, stopped, initiator kicked, authorization fence
          // changed, invalid response): this delegation ends here; late receipts are not registered
          if (poll.state === 'rejected') {
            await cancelPage();
            const why = poll.why === 'result-invalid' ? 'receipt-invalid' : `late-${codeOf(poll.why, 'rejected')}`.slice(0, 40);
            // This run itself can no longer write (stopped, revoked): do not fall back to anonymous download;
            // continue anonymous download only if still writable (e.g. owner turns own chat private)
            if (!(await canWrite(context))) return end('rejected', why, stopped('run-revoked', COLLECT_BRIDGE_TEXT.revoked));
            return end('rejected', why, notDelegated(poll.why === 'result-invalid' ? 'receipt-invalid' : 'failed'));
          }
          if (['initiator-revoked', 'no-page'].includes(poll.why)) return end('fallback', 'initiator-offline', notDelegated('initiator-offline'));
          // Page temporarily unreachable (reconnecting, document service temporarily unresponsive): keep
          // querying within grace period; treated as timed out if overall delegation deadline arrives first
          if (Number(now()) - started > limits.delegateMs) { await cancelPage(); return end('fallback', 'timeout', notDelegated('timeout')); }
          if (Number(now()) - lastSeen > limits.offlineGraceMs) return end('fallback', 'initiator-offline', notDelegated('initiator-offline'));
          continue;
        }
        lastSeen = Number(now());
        if (poll.answer.ok !== true) { await cancelPage(); return end('fallback', 'failed', notDelegated('failed')); }
        const r = poll.answer.result;
        if (r.state === 'running') { progress({ state: 'downloading', ...(r.stage ? { stage: r.stage } : {}), ...(typeof r.percent === 'number' ? { percent: r.percent } : {}) }); continue; }
        if (r.state === 'unknown') return end('fallback', 'failed', notDelegated('failed'));
        if (r.state === 'error') {
          const why = ['local-download-failed', 'upload-failed', 'timeout', 'not-logged-in', 'local-not-ready'].includes(r.code) ? r.code : 'failed';
          return end('fallback', why, notDelegated(why));
        }
        progress({ state: 'verifying', stage: 'ingest', percent: 99 });
        return await settleReceipt(context, id, r.receipt);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      live.delete(entry);
    }
  }

  const knownSite = (value) => (typeof value === 'string' && siteNamesSet().has(value) ? value : siteNames()[0]);

  /**
   * `collect_login`: asks initiator page to open local login window. The cloud only receives "whether
   * opened" and "whether already logged in"
   */
  async function login(context, args = {}, { signal = null, requestId = `cl-${randomBytes(12).toString('hex')}` } = {}) {
    if (closed) fail('collect-bridge-closed', 503);
    const site = knownSite(args?.site);
    let out;
    try { out = await ask(context, 'collect_login', { site, method: args?.method === 'browser' ? 'browser' : 'qr', ...(args?.force === true ? { force: true } : {}) }, requestId, signal); } catch (error) {
      if (!revoked(error) && error?.code === 'bad-args') throw error;
      return initiatorOffline('user_interface_collect_login');
    }
    if (!out.delivered) return initiatorOffline('user_interface_collect_login');
    if (out.answer.ok !== true) {
      return out.answer.code === 'unsupported'
        ? { ok: false, initiatorOnly: true, error: COLLECT_BRIDGE_TEXT.webPage('user_interface_collect_login') }
        : { ok: false, initiatorOnly: true, error: COLLECT_BRIDGE_TEXT.loginFailed('user_interface_collect_login') };
    }
    if (out.answer.result.alreadyLoggedIn) return { ok: true, site, alreadyLoggedIn: true, onInitiatorComputer: true, hint: COLLECT_BRIDGE_TEXT.loginAlready };
    return { ok: true, site, visible: true, onInitiatorComputer: true, hint: COLLECT_BRIDGE_TEXT.loginOpened };
  }

  /**
   * `collect_login_check`: checks login state on initiator's computer. The cloud only receives
   * "whether logged in" and "whether expired"
   */
  async function loginCheck(context, args = {}, { signal = null, requestId = `cl-${randomBytes(12).toString('hex')}` } = {}) {
    if (closed) fail('collect-bridge-closed', 503);
    const site = knownSite(args?.site);
    let out;
    try { out = await ask(context, 'collect_login_check', { site, ...(args?.hide === false ? { hide: false } : {}) }, requestId, signal); } catch { return initiatorOffline('collect_login_check'); }
    if (!out.delivered) return initiatorOffline('collect_login_check');
    if (out.answer.ok !== true) {
      return out.answer.code === 'unsupported'
        ? { ok: false, initiatorOnly: true, error: COLLECT_BRIDGE_TEXT.webPage('collect_login_check') }
        : { ok: false, initiatorOnly: true, error: COLLECT_BRIDGE_TEXT.loginFailed('collect_login_check') };
    }
    const r = out.answer.result;
    if (r.loggedIn) return { ok: true, site, loggedIn: true, onInitiatorComputer: true, hint: COLLECT_BRIDGE_TEXT.loginChecked };
    return { ok: true, site, loggedIn: false, ...(r.expired ? { expired: true } : {}), onInitiatorComputer: true, hint: r.expired ? COLLECT_BRIDGE_TEXT.loginExpired : COLLECT_BRIDGE_TEXT.loginMissing };
  }

  /**
   * Delegation record for a cloud job (findable even after restart); returns null if never delegated.
   * Only returns records for this project and this chat
   */
  function delegationOf(scope, jobId) {
    if (typeof scope?.projectId !== 'string' || typeof scope?.conversationId !== 'string' || typeof jobId !== 'string') return null;
    let row = null;
    try { row = db.prepare('SELECT * FROM collect_delegations WHERE project_id=? AND conversation_id=? AND job_id=? ORDER BY created_at DESC LIMIT 1').get(scope.projectId, scope.conversationId, jobId) ?? null; } catch { row = null; }
    return row ? viewOf(row) : null;
  }

  /**
   * When this run ends or is halted: clean up all pending delegations (called by host during teardown
   * and control channel, alongside `bridge.cancelRun`)
   */
  function cancelRun(scope) {
    let count = 0;
    for (const entry of [...live]) {
      const row = rowOf(entry.id);
      if (!row || row.project_id !== scope?.projectId || row.conversation_id !== scope?.conversationId) continue;
      if (scope.runId !== undefined && row.run_id !== scope.runId) continue;
      entry.abort.abort();
      count += 1;
    }
    return count;
  }

  /** The portion bound to a run, passed to `delegate` of `hosted-collect.mjs` */
  function forRun(context) {
    return Object.freeze({
      download: (job, args, options) => delegateDownload(context, job, args, options),
      login: (args, options) => login(context, args, options),
      loginCheck: (args, options) => loginCheck(context, args, options),
    });
  }

  async function close(reason = 'close') {
    if (closed) return { childrenClosed: true, streamsClosed: true, workPending: 0 };
    closed = true;
    for (const entry of [...live]) entry.abort.abort();
    await Promise.allSettled([...settling.values()].map((s) => s.promise));
    try { db.prepare(`UPDATE collect_delegations SET state='interrupted', reason='host-close', updated_at=? WHERE state IN ('asking','downloading','verifying','registering')`).run(Number(now())); } catch { /* Already closed */ }
    try { db.close(); } catch { /* Already closed */ }
    say('agent.collect.delegate.closed', { reason });
    return { childrenClosed: true, streamsClosed: true, workPending: live.size };
  }

  return Object.freeze({ forRun, delegateDownload, settleReceipt, login, loginCheck, delegationOf, cancelRun, close, limits,
    describe: () => ({ live: live.size, settling: settling.size, closed }) });
}
