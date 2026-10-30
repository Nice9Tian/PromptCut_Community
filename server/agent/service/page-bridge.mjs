/**
 * 账号模式下「发起人自己的页面」的反向通道(计划 `docs/plan/cloud-agent-tools-implementation.md` 的 W2 包)。
 *
 * 云端 Agent 没有界面。它要动用户的播放头(`user_interface_seek`、`user_interface_play`、`user_interface_pause`)或把网页交给本人(`user_interface_web_handoff`)时,
 * 经这里让「发这条消息的那个人、发消息时用的那张页面」替它执行,再把结果交回来。旧的一版(非账号模式)在
 * `create-agent-service.mjs` 的 `pageCall` 里,页面号是请求体自报的;这里把两头都绑到文档服务确认过的东西上:
 *
 *   - **发起人、发起页都从文档服务的当前运行授权里取**:`runClient.checkAccess` 回的 `runGrant.accountId` 与
 *     `runGrant.selectionSnapshot.pageId`(发消息时文档服务核过「这张页面此刻连着、属于这次登录」才记下的页面号)。
 *     `requestPage` 的 `initiatorAccountId`、`pageId` 两个参数只是调用方的**断言**,与授权对不上就拒绝,不能用来挑页面;
 *     工具参数、页面交回的请求体都指定不了页面。
 *   - **「现在确实在线」要两样同时成立**:文档服务的在场表里这张页面此刻连着(`presence`,即全员选区那条查询),
 *     并且这张页面有一条到 Agent 服务的事件流挂在这个对话上(`attach`,身份是 HTTP 层核过委托票据的账号)。
 *     同一个账号的别的页面(页面号不同)、别的成员的页面(账号不同)都不算。
 *   - **请求只写给那一条流**,带一个只出现在那条流上的一次性随机数;不进事件记录、不补发。
 *   - **交回时全部重核**:交的人是发起人且此刻仍读得到这个对话、对话的权限版本没变、页面号与一次性随机数对得上、
 *     这一轮的授权仍是当前的且没换过栅栏版本、没过时限、请求还在等。任何一样不对都拒收,等待的工具按「发起方不在线」收掉,
 *     不把页面交来的内容当结果。同一份结果重复交回是幂等的。
 *   - **请求的状态落盘**(SQLite):重启后还在等的标成 `interrupted`,之后查得到、交回时也说得清,不会凭内存里的表消失。
 *
 * 本文件不挂路由、不发事件、不认票据:事件流的 `attach`、交回的 `acceptResult` 由宿主(最后的接线包)接到
 * `server/agent-service/http.mjs`。不引用 `src/`。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initiatorOffline } from './cloud-tools.mjs';
import { modelToolName, pageToolName } from '../../tools/ui-names.mjs';

/**
 * 经这条通道让发起页执行的**内部操作名**(请求里的 `tool`)。没有 `get_selection`:账号模式下它走文档服务的全员选区查询,不读单张页面。
 * 模型侧的工具名 2026-10-21 起带 `user_interface_` 前缀(`server/tools/ui-names.mjs`),这里保持旧名:0.7.18 的页面只认这几个
 */
export const PAGE_BRIDGE_TOOLS = Object.freeze(['seek', 'play', 'pause', 'web_handoff']);
/** 页面控制三件(本文件的工具提供方处理;模型侧的名字);`user_interface_web_handoff` 的提供方在 `hosted-handoff.mjs` */
export const PAGE_CONTROL_TOOL_NAMES = Object.freeze(['user_interface_seek', 'user_interface_play', 'user_interface_pause']);
/** 事件与交回请求体的版本号(旧通道没有这个字段) */
export const PAGE_REQUEST_VERSION = 2;

export const PAGE_BRIDGE_DEFAULTS = Object.freeze({
  /** 请求发出后最多等页面多久(数字沿用旧通道的 `pageMs`) */
  pageMs: 15_000,
  /** 文档服务说页面在、但它到 Agent 服务的事件流还没挂上(刚发完消息、正在重连)时,最多等它多久(沿用 `pageAttachMs`) */
  attachMs: 3_000,
  /** 调用方给的时限再长也不超过这么久 */
  maxPageMs: 60_000,
  /** 页面交回的内容上限 */
  maxResultBytes: 64 * 1024,
  /** 已经结束的请求记录留多久 */
  retainMs: 7 * 24 * 3600_000,
  /** `web_handoff` 的说明文字、地址的长度上限 */
  maxReasonChars: 200,
  maxUrlChars: 2048,
});

/** 请求的状态。`pending` 之外都是终态 */
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
/** 页面号:文档服务在场表里的那个(`server/docservice/modules/selection.mjs` 的同一条规矩) */
export const BRIDGE_PAGE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** 请求号:页面那一侧(`src/ai/cloud/pageRequests.ts`)认的形状 */
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
 * 按本机同样的规矩查参数,多带的字段一律拒绝(不是丢掉):模型给的参数里不该有页面号、账号、项目。
 * 回发给页面的那一份。
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
    // 只交公开的网页地址;地址里带账号口令的不交
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('bad-args');
    out.url = parsed.href;
  }
  return out;
}

/**
 * 别的工具包加在这条通道上的请求(C1 的本机采集代下用):`{ 工具名: { args(宿主给的参数) => 发给页面的参数, answer?(页面交回的答案) => 留下的答案 } }`。
 * 只加不改:名字不能与 `PAGE_BRIDGE_TOOLS` 重;发起人与发起页的绑定、交回时的重核、落盘、幂等都是本文件原来那一套。
 * `args` 不合规矩时自己抛错;`answer` 抛错或回的不是答案时这一次按拒收办(工具得到「发起方不在线」,页面得到 422),
 * 页面交来的那一份不落盘。
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
  // 上一个进程还在等的:它的等待者已经不在了,之后到的结果也不该再被收下
  db.prepare("UPDATE page_requests SET state='interrupted', reason='agent-restart', updated_at=? WHERE state='pending'").run(at);
  db.prepare("DELETE FROM page_requests WHERE state <> 'pending' AND updated_at < ?").run(at - retainMs);
  return db;
}

/**
 * 这一轮的权威信息从哪来:缺省向文档服务取当前授权,并从里面取发送者与发消息时的页面号。任何对不上都拒绝。
 * 单独做成一个口子,是因为账号模式的生产形态里「跑这一轮的进程」(一条任务一个工作进程,授权登记在它名下)与
 * 「接着页面事件流的进程」(主服务)可以不是同一个:反向通道放在主服务里时,宿主换一个 `runAuthority`
 * (向持有这一轮登记的工作进程问同样的东西)即可,本文件其余部分不变。回的形状固定:
 * `{ accountId, pageId, fenceRevision, grantState }`;授权不在抛 `PageBridgeError`(403),上游不可达抛 503。
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
 * @param {string} o.databasePath 请求记录的 SQLite 文件(私有数据目录里)
 * @param {{ current(context: object): Promise<{accountId: string, pageId: string|null, fenceRevision: number, grantState: string}>, signalFor?(context: object): AbortSignal|null }} [o.runAuthority]
 *   这一轮的权威信息;不给就用 `createRunPageAuthority({ resources, runClient })`(本进程持有这一轮的授权登记时)
 * @param {{ authorize(context: object, action: 'read'|'write'): Promise<{allowed: true, fenceRevision: number, grantState: string}>, signalFor?(context: object): AbortSignal }} [o.resources]
 *   F0 的运行资源登记器(`run-resources.mjs`):每次都向文档服务重核当前授权与实例登记
 * @param {{ checkAccess(input: {projectId: string, runGrantId: string, action: string}): Promise<object> }} [o.runClient]
 *   文档服务的运行授权接口;这里只用它取授权里的发送者与发消息时的页面号
 * @param {(context: object) => Promise<{members: Array<{accountId: string, isInitiator: boolean, pages: Array<{pageId: string, live: boolean}>}>}>} o.presence
 *   文档服务的在场表(全员选区查询 `selection.query` 的回答);取不到按不在线办
 * @param {(identity: object, conversationId: string) => Promise<{allowed: boolean, aclRevision: number}>} o.checkSubmitter
 *   交回的人此刻读不读得到这个对话(HTTP 层对事件流用的同一个核对);取不到按拒收办
 */
export function createPageBridge({ databasePath, resources, runClient, runAuthority = null, presence, checkSubmitter, limits: limitOverrides = {}, now = Date.now, log = () => {}, randomNonce = () => randomBytes(18).toString('base64url'), extraTools = null } = {}) {
  if (typeof presence !== 'function' || typeof checkSubmitter !== 'function' || typeof now !== 'function') fail('page-bridge-configuration', 503);
  const extra = checkedExtraTools(extraTools);
  const authority = runAuthority ?? createRunPageAuthority({ resources, runClient });
  if (typeof authority?.current !== 'function') fail('page-bridge-configuration', 503);
  /** 每次都重取;回的东西形状不对一律当作授权不在 */
  async function current(context) {
    const value = await authority.current(context);
    if (!value || typeof value.accountId !== 'string' || !REFERENCE.test(value.accountId) || value.accountId !== context.senderAccountId ||
        (value.pageId !== null && (typeof value.pageId !== 'string' || !BRIDGE_PAGE_ID_RE.test(value.pageId))) ||
        !Number.isSafeInteger(value.fenceRevision) || !['active', 'retained'].includes(value.grantState)) fail('run-access-denied', 403);
    return Object.freeze({ accountId: value.accountId, pageId: value.pageId, fenceRevision: value.fenceRevision, grantState: value.grantState });
  }
  const limits = Object.freeze({ ...PAGE_BRIDGE_DEFAULTS, ...limitOverrides });
  const db = openLedger(databasePath, now, limits.retainMs);
  const say = (event, fields) => { try { log(event, fields); } catch { /* 日志的事 */ } };

  /** request_key -> 正在办的这一次(从进来到有终态) */
  const inflight = new Map();
  /** request_key -> 已经发给页面、在等交回的 */
  const waiting = new Map();
  /** `${projectId}\n${conversationId}` -> Set<listener> */
  const streams = new Map();
  /** 等某张页面挂上事件流的 */
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
      try { answer = JSON.parse(row.answer); } catch { /* 记录坏了按没交回办 */ }
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
    } catch { /* 关库之后:等待者照常收掉 */ }
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
    // 调用方给的发起人与页面号只是断言:与文档服务的授权对不上就是有人想挑页面
    if (input.initiatorAccountId !== binding.accountId || input.pageId !== binding.pageId) fail('page-binding-mismatch', 403);
    const refuse = (why) => { record(context, binding, input, key, 'offline', why); say('agent.page.offline', { tool: input.tool, why }); return offline(why); };
    if (binding.pageId === null) return refuse('no-page');
    // 发起人被踢出或退出登录后,这一轮可以按「已读共有任务」保留着跑,但已经没有「他的页面」了
    if (binding.grantState !== 'active') return refuse('initiator-revoked');
    const live = await pageLive(context, binding);
    // 在场表取不到(文档服务没答)也按不在线办,不猜
    if (live !== true) return refuse(live === null ? 'presence-unavailable' : 'page-not-live');
    const remaining = () => input.deadline - Number(now());
    let listener = listenerFor(context.projectId, context.conversationId, binding.accountId, binding.pageId);
    if (!listener) {
      listener = await waitForAttach(context.projectId, context.conversationId, binding.accountId, binding.pageId, Math.min(limits.attachMs, remaining()), input.signal);
      if (closed) fail('page-bridge-closed', 503);
      if (!listener) return refuse('page-not-attached');
      // 等的这一会儿里授权可能变了,发之前再核一遍
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
    try { watch(authority.signalFor?.(context)); } catch { /* 这一轮没有登记过资源:没有可听的信号 */ }
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
   * 让发起页执行一次。回 `{ delivered: true, answer: { ok, result?, error? } }`(页面交回了,做没做成看 `answer.ok`)
   * 或 `{ delivered: false, offline: true, why, state }`(发起方不在线、超时、被取消、结果被拒收)。
   * 授权已经不在、断言对不上、参数不合规矩时抛 `PageBridgeError`。
   * 同一个 `requestId` 重复调用回同一个结果,不会让页面执行两次;同号不同内容回 `idempotency-conflict`。
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

  /** 这一轮的发起人与发起页(从文档服务的当前授权里取)。工具提供方拿它去调 `requestPage` */
  async function initiator(contextValue) {
    const binding = await current(canonicalContext(contextValue));
    return { initiatorAccountId: binding.accountId, pageId: binding.pageId, grantState: binding.grantState };
  }

  /**
   * 一张页面的事件流挂到一个对话上。`identity` 必须是 HTTP 层核过委托票据的账号身份;`pageId` 是页面自报的在场页面号
   * (自报不要紧:请求只发给与文档服务授权里那个页面号相同、且账号相同的流)。不合格的页面号回 null(只是看)。
   * `aclRevision` 是挂上时这个对话的权限版本(HTTP 层读对话时拿到的)。
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
    // 同一张页面重连:旧的那条流已经没用了,发在它上面还没交回的按断开收掉
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
   * 页面交回一次请求的结果。`identity` 是 HTTP 层核过委托票据的账号身份(不是请求体里的)。
   * 成功回 `{ ok: true }`(重复交回同一份回 `{ ok: true, duplicate: true }`)。
   * 不是这次请求的发起页(账号、页面号、一次性随机数任何一样不对)、或根本没有这个请求:同一个 410 `page-request-gone`,不说是哪样,也不影响在等的那一次。
   * 是发起页但已经收不下了:410 `page-request-<状态>`(过期、被取消、重启中断、被拒)。
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
    // 扩展工具自己规定页面交回的形状:只留它认的字段再落盘;形状不对的整份不收(下面按拒收办)
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
        // 同一份结果重复交回(页面没收到 200 又交了一次):幂等,不再有任何效果
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

    // 交的人此刻还读得到这个对话吗(被踢出、对话被别人转成私有之后读不到);对话的权限版本变了也拒收
    let access = null;
    try { access = await checkSubmitter(identity, conversationId); } catch { access = null; }
    if (access?.allowed !== true || !Number.isSafeInteger(access.aclRevision)) return reject('submitter-denied');
    if (access.aclRevision !== row.acl_revision) {
      // 对话在请求发出之后换过权限(共有转私有等):这一次不收;这条流之后的请求按新的版本算
      if (waiter.listener && !waiter.listener.gone) waiter.listener.aclRevision = access.aclRevision;
      return reject('conversation-changed');
    }
    // 这一轮的授权:必须仍是当前的、仍是发起人本人有效的、栅栏版本没换过、页面号没变
    let binding = null;
    try { binding = await current(waiter.context); } catch { binding = null; }
    if (!binding) return reject('run-revoked');
    if (binding.grantState !== 'active') return reject('initiator-revoked');
    if (binding.fenceRevision !== row.fence_revision) return reject('fence-changed');
    if (binding.accountId !== row.initiator_account_id || binding.pageId !== row.page_id) return reject('page-binding-changed');
    // 核对期间可能已经超时、被取消、那条流断了、或另一次交回先到了
    if (waiter.settled) { const latest = rowOf(key); if (latest) return terminal(latest); throw gone(); }
    if (Number(now()) > row.deadline_at) { settle(waiter, 'expired', 'deadline', offline('deadline', 'expired')); fail('page-request-expired', 410); }
    settle(waiter, 'answered', null, Object.freeze({ delivered: true, answer }), { answerDigest, answer: text });
    return { ok: true };
  }

  /** 这一轮结束或被叫停(说完、被停、被撤销、出错):在等的全部收掉,之后交回的拒收。宿主在收尾与控制通道里调 */
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

  /** 一次请求现在的状态(重启后也查得到)。按当前授权核对读权限,只回本项目本对话的 */
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
    try { db.close(); } catch { /* 已经关了 */ }
    say('agent.page.closed', { reason });
    return { streamsClosed: true, workPending: waiting.size };
  }

  return Object.freeze({
    requestPage, initiator, attach, acceptResult, cancelRun, status, close, limits, extraTools: Object.freeze([...extra.keys()]),
    describe: () => ({ waiting: waiting.size, streams: [...streams.values()].reduce((sum, set) => sum + set.size, 0), closed }),
  });
}

/**
 * `user_interface_seek`、`user_interface_play`、`user_interface_pause` 三个工具的提供方(形状同别的工具包:`handles` / `call(name, args, context)` / `close(reason)`)。
 * 给模型的回答与旧通道同一份话:做成回页面的结果,发起方不在线回 `cloud-tools.mjs` 的 `initiatorOffline`。
 * `call` 的第四个参数可带 `{ requestId, signal }`:宿主重试同一次工具调用时给同一个请求号,页面不会执行两次。
 * `onPlayhead(context, t)`:`seek` 做成后通知宿主把这个对话记着的播放头改成新的(切剪辑的工具用它)。
 */
export function createPageControlTools({ bridge, onPlayhead = null, now = Date.now, newRequestId = () => randomBytes(16).toString('base64url') } = {}) {
  if (typeof bridge?.requestPage !== 'function' || typeof bridge?.initiator !== 'function') fail('page-bridge-configuration', 503);
  const handles = new Set(PAGE_CONTROL_TOOL_NAMES);
  async function call(nameIn, args, context, options = {}) {
    // 模型侧的名字(新旧都认);发给页面的是旧的内部操作名
    const name = modelToolName(nameIn);
    if (!handles.has(name)) fail('page-tool-unknown', 404);
    const wire = pageToolName(name);
    let send;
    try { send = checkedPageArgs(wire, args, bridge.limits); } catch (error) {
      if (error?.code !== 'bad-args') throw error;
      return { ok: false, error: wire === 'seek' ? `${name} 要给 t(秒,不小于 0 的数)。` : `${name} 不接受参数。` };
    }
    const who = await bridge.initiator(context);
    const out = await bridge.requestPage({ run: context, initiatorAccountId: who.initiatorAccountId, pageId: who.pageId, tool: wire, args: send,
      requestId: options.requestId ?? newRequestId(), deadline: Number(now()) + bridge.limits.pageMs, ...(options.signal ? { signal: options.signal } : {}) });
    if (!out.delivered) return initiatorOffline(name);
    const answer = out.answer;
    if (answer.ok !== true) return { ok: false, error: String(answer.error || `${name} 在发起人的页面上没有做成`) };
    if (wire === 'seek' && typeof onPlayhead === 'function') { try { await onPlayhead(context, send.t); } catch { /* 宿主的事 */ } }
    return answer.result && typeof answer.result === 'object' && !Array.isArray(answer.result) ? answer.result : { ok: true };
  }
  return Object.freeze({ handles, call, async close() { return { childrenClosed: true, streamsClosed: true, workPending: 0 }; } });
}
