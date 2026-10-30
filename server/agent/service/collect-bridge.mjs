/**
 * 云端 Agent 的素材采集在「需要登录的站点」上委托发起人自己的电脑代为下载(计划 `docs/plan/cloud-agent-tools-implementation.md` 的 C1 包)。
 *
 * 站点的登录态只能留在用户自己的电脑上,不上云节点。所以:
 *
 *   - `collect_download` 缺省在云端匿名下载(`hosted-collect.mjs`)。链接属于有登录支持的站点、且发起人本人此刻在线时,
 *     先经反向通道(`page-bridge.mjs`,W2 的可信返回协议)问他的页面:页面是桌面版、本机有这个站点没过期的登录态,
 *     就由他的电脑用本机的登录态下载,下载完**直接**上传进这个项目的素材服务;
 *   - 云端只收一份回执 `{ requestId, jobId, assetRef: { projectId, hash, size }, result }`。回执是一次页面请求的答案,
 *     所以交回时的重核(交的人是发起人、对话权限版本没变、这一轮的授权仍是当前的、栅栏版本没换过、页面号与一次性随机数对得上、
 *     没过时限)全是反向通道原来那一套;对话转私有、被停止、发起人被踢出之后才到的回执在那里就被拒收;
 *   - 收到回执后本文件再做三件事才算数:按当前这一轮核一次写权限;向素材服务核「这份字节确实在这个项目的素材库里、
 *     哈希与大小对得上」(F0 的 `ProjectAssets.verifyRef`);再核一次写权限后交给宿主登记进项目(宿主带期望版本提交);
 *   - 委托不成(本人不在线、页面不是桌面版、本机没有登录态、超时、本机下载或上传失败、回执核不过)时回「没委托成」与原因,
 *     由 `hosted-collect.mjs` 接着在云端匿名下载,并在作业的说明里写明原因与画质差别;
 *   - `user_interface_collect_login`(发给页面的内部操作名仍是 `collect_login`)、`collect_login_check` 只在本人电脑上操作:经同一条通道让发起页打开本机的登录窗口、查本机的登录态,
 *     云端只拿回「开没开」「登没登」。
 *
 * 云端拿不到、也不存的:cookie、请求头、浏览器用户数据目录、本机路径、站点的用户标识。页面交回的答案先按白名单收一遍
 * (多带任何字段整份拒收,`page-bridge.mjs` 不落盘),委托记录里只有哈希、大小、状态与原因的代号,链接只存摘要。
 *
 * 一次下载可能要几分钟,而一次页面请求最多等一分钟:所以是「开始 → 隔一会儿问一次 → 取消」三种短请求,每一次都是独立的、
 * 完整重核过的页面请求。页面中途断开重连(页面号不变)不影响;超过宽限还连不上就按不在线退回匿名。
 *
 * 本文件不挂路由、不碰工具表、不认票据,不引用 `src/`。接线(把 `collectPageTools()` 交给 `createPageBridge` 的 `extraTools`、
 * 把 `forRun(context)` 交给 `hosted-collect.mjs` 的 `delegate`)归最后的接线包。
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { siteNames, siteOfUrl } from '../../collect-cookies.mjs';
import { initiatorOffline } from './cloud-tools.mjs';

/** 加在反向通道上的五种请求(页面一侧的白名单是 `src/ai/cloud/collectBridge.ts` 的 `COLLECT_PAGE_REQUEST_TOOLS`,单测对账) */
export const COLLECT_PAGE_TOOLS = Object.freeze(['collect_delegate_start', 'collect_delegate_poll', 'collect_delegate_cancel', 'collect_login', 'collect_login_check']);

export const COLLECT_BRIDGE_DEFAULTS = Object.freeze({
  /** 隔多久问一次本机下载的进度 */
  pollMs: 2_000,
  /** 一次委托最多等多久(与云端匿名下载的墙钟上限同一个数) */
  delegateMs: 15 * 60_000,
  /** 发起页中途连不上时最多等它多久,过了就退回匿名 */
  offlineGraceMs: 20_000,
  /** 一份回执最多带几个文件、合计多大(与云端匿名下载同一组数) */
  maxItems: 20,
  maxBytes: 512 * 1024 * 1024,
  /** 已经结束的委托记录留多久 */
  retainMs: 7 * 24 * 3600_000,
  maxUrlChars: 2000,
});

/** 委托的状态。`asking`、`downloading`、`verifying`、`registering` 之外都是终态 */
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
/** 文件名:只收一段名字,带路径分隔符、盘符冒号、控制字符的一律不收(本机路径不上云) */
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

/** 页面交回的回执:只认这几样,多带任何字段整份不收 */
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
 * 交给 `createPageBridge({ extraTools })` 的那一份:五种请求各自「发给页面的参数怎么查」「页面交回的答案留哪几样」。
 * 页面没做成时只留代号(`code`),它写的那句话不留——里面可能带本机的路径。
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
 * 给模型看的话(不是界面文字;句式沿用现有采集工具的,见 `server/tools/collect.mjs` 与 `hosted-collect.mjs`)。
 * 措辞是草稿,集中在这里,可整体替换。
 */
export const COLLECT_BRIDGE_TEXT = Object.freeze({
  /** 退回匿名时写进作业 notes 的那一句:原因 + 画质差别 */
  fallback: Object.freeze({
    'initiator-offline': '这个站点登录后才有更高的画质,但发起人现在不在线,用不了他电脑上的登录态',
    'page-without-local-collect': '这个站点登录后才有更高的画质,但发起人现在用的是网页版(没有本机的采集与登录态)',
    'not-logged-in': '发起人的电脑上还没有这个站点的登录态(需要的话先 user_interface_collect_login,让他在自己的电脑上登录)',
    'local-not-ready': '发起人电脑上的采集工具没有就绪(没有装 yt-dlp 或缺 ffmpeg)',
    'local-busy': '发起人的电脑正在替这个对话下载另一条链接',
    'local-download-failed': '发起人的电脑用登录态下载这条链接没有成功',
    'upload-failed': '发起人的电脑下载好了,但没能把文件传进这个项目的素材库',
    'timeout': '发起人的电脑没有在时限内下载并上传完',
    'receipt-invalid': '发起人的电脑交回的回执不合规矩,没有采用',
    'asset-unverified': '素材服务里核不到发起人电脑说已经传好的那份文件,没有采用',
    failed: '委托发起人的电脑下载没有成功',
  }),
  fallbackTail: ';已改为云端按未登录的画质下载,画质可能低于登录后的。',
  delegated: '这条链接由发起人自己的电脑用他本机的登录态下载,文件由他的电脑直接传进这个项目的素材库;登录信息没有离开他的电脑。',
  revoked: '这条任务已经被停止,或者不再有往这个项目里写素材的权限;发起人电脑交回的文件没有登记进项目。',
  registerFailed: '发起人的电脑已经把文件传进素材库,但没能登记进项目',
  loginOpened: '登录框已经在发起人自己的电脑上弹出来了。登录只能由他本人在自己的电脑上完成,登录态只留在他的电脑上,云端拿不到。**现在停下来**,用中文告诉用户「登录框已经在你的电脑上弹出来了,扫码或切到账号密码登录,登录完回我一句」,**不要继续调工具**;用户回话之后再调 collect_login_check。',
  loginAlready: '发起人的电脑上已经有这个站点没过期的登录态,不用再登录。之后 collect_download 这个站点的链接时,会由他的电脑带着登录态下载(他在线的时候)。',
  loginChecked: '发起人的电脑上已经登录。登录态只留在他的电脑上;之后 collect_download 这个站点的链接时,会由他的电脑带着登录态下载(他在线的时候)。',
  loginMissing: '发起人的电脑上还没有登录态。请他在自己电脑上弹出的登录框里完成登录后再查一次;不要连着轮询,等用户回话。',
  loginExpired: '发起人电脑上的登录态已经过期。请重新 user_interface_collect_login,让他在自己的电脑上再登录一次。',
  webPage: (tool) => `${tool} 只能在发起人自己的电脑上操作,而他现在用的是网页版(没有本机的登录窗口)。请告诉用户到电脑上的 PromptCut 里登录;云端照常按未登录的画质采集。`,
  loginFailed: (tool) => `${tool} 在发起人的电脑上没有做成。请告诉用户在电脑上的 PromptCut 里自己登录一次;云端照常按未登录的画质采集。`,
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
  // 上一个进程还在办的:等它的那一轮已经不在了,之后到的回执也不该再被登记
  db.prepare(`UPDATE collect_delegations SET state='interrupted', reason='agent-restart', updated_at=? WHERE state IN ('asking','downloading','verifying','registering')`).run(at);
  db.prepare(`DELETE FROM collect_delegations WHERE state NOT IN ('asking','downloading','verifying','registering') AND updated_at < ?`).run(at - retainMs);
  return db;
}

/**
 * @param {object} o
 * @param {object} o.bridge `createPageBridge({ …, extraTools: collectPageTools() })` 建出来的反向通道
 * @param {string} o.databasePath 委托记录的 SQLite 文件(私有数据目录里)
 * @param {{ verifyRef(context: object, ref: {projectId: string, hash: string, size: number}): Promise<{assetRef: object}> }} o.assets
 *   F0 的 `createProjectAssets`:向素材服务核这份字节在不在这个项目的素材库里
 * @param {(context: object, action: 'read'|'write') => Promise<{allowed: true, fenceRevision: number, grantState: string}>} o.authorize
 *   运行资源登记器的 `authorize`:每次都向文档服务重核这一轮的当前授权
 * @param {(context: object, entry: object) => Promise<{mediaId: string, kind?: string, clipId?: string}>} o.register
 *   把一份已经在素材库里的字节登记进项目(宿主带期望版本提交;同一个 `entry.requestId` 重复调用不登记两次)
 * @param {(url: string) => string | null} [o.loginSiteOf] 一条链接属于哪个有登录支持的站点(缺省 `collect-cookies.mjs` 的 `siteOfUrl`)
 */
export function createCollectBridge({ bridge, databasePath, assets, authorize, register, loginSiteOf = siteOfUrl, limits: limitOverrides = {},
  now = Date.now, log = () => {}, newId = () => `cd-${randomBytes(12).toString('hex')}` } = {}) {
  if (typeof bridge?.requestPage !== 'function' || typeof bridge?.initiator !== 'function' || !Array.isArray(bridge.extraTools) ||
      COLLECT_PAGE_TOOLS.some((name) => !bridge.extraTools.includes(name)) || typeof assets?.verifyRef !== 'function' ||
      typeof authorize !== 'function' || typeof register !== 'function' || typeof loginSiteOf !== 'function') fail('collect-bridge-configuration', 503);
  const limits = Object.freeze({ ...COLLECT_BRIDGE_DEFAULTS, ...limitOverrides });
  const db = openLedger(databasePath, now, limits.retainMs);
  const say = (event, fields) => { try { log(event, fields); } catch { /* 日志的事 */ } };
  let closed = false;
  /** delegation_id -> 正在核实与登记的那一次(同一份回执重复到达共用一个结果) */
  const settling = new Map();
  /** 正在等的委托(关闭时一起收掉) */
  const live = new Set();

  const rowOf = (id) => db.prepare('SELECT * FROM collect_delegations WHERE delegation_id=?').get(id) ?? null;
  const viewOf = (row) => ({ delegationId: row.delegation_id, jobId: row.job_id, projectId: row.project_id, conversationId: row.conversation_id, runId: row.run_id,
    site: row.site, state: row.state, reason: row.reason ?? null, refs: JSON.parse(row.refs), media: JSON.parse(row.media), createdAt: row.created_at, updatedAt: row.updated_at });
  function mark(id, state, reason = null, more = {}) {
    try {
      db.prepare(`UPDATE collect_delegations SET state=?, reason=?, receipt_digest=COALESCE(?, receipt_digest), refs=COALESCE(?, refs), media=COALESCE(?, media), updated_at=?
        WHERE delegation_id=? AND state IN ('asking','downloading','verifying','registering')`)
        .run(state, reason, more.receiptDigest ?? null, more.refs ? JSON.stringify(more.refs) : null, more.media ? JSON.stringify(more.media) : null, Number(now()), id);
    } catch { /* 关库之后:调用方照常收尾 */ }
  }

  const pause = (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

  /** 向发起页发一次请求。这一轮的授权已经不在时抛(`PageBridgeError`,403);发起人、发起页照文档服务的授权填 */
  async function ask(context, tool, args, requestId, signal) {
    const who = await bridge.initiator(context);
    return bridge.requestPage({ run: context, initiatorAccountId: who.initiatorAccountId, pageId: who.pageId, tool, args, requestId,
      deadline: Number(now()) + bridge.limits.pageMs, ...(signal ? { signal } : {}) });
  }
  const revoked = (error) => error?.status === 403 || ['run-access-denied', 'tool-context-untrusted', 'tool-context-invalid', 'run-page-binding-invalid'].includes(error?.code);
  const fallbackNote = (why) => `${COLLECT_BRIDGE_TEXT.fallback[why] ?? COLLECT_BRIDGE_TEXT.fallback.failed}${COLLECT_BRIDGE_TEXT.fallbackTail}`;
  const notDelegated = (why, note = fallbackNote(why)) => Object.freeze({ delegated: false, why, note });
  const stopped = (why, message) => Object.freeze({ delegated: false, stop: true, why, message });

  /** 这一轮此刻还能不能往项目里写(每次都问文档服务;问不到按不能办) */
  const canWrite = async (context) => {
    try { const auth = await authorize(context, 'write'); return auth?.allowed === true; } catch { return false; }
  };

  /**
   * 收一份回执:核写权限 → 向素材服务核字节 → 再核写权限 → 登记。同一份回执重复到达回同一个结果,不登记两次;
   * 已经有别的结论的委托(退回了、被拒了、被取消了、重启中断了)之后到的回执一律不登记。
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
      // 回执里的请求号、作业号、项目必须就是这一次委托的:别的对话的请求号、别的项目的哈希在这里就不收
      if (!receipt || receipt.requestId !== id || receipt.jobId !== row.job_id ||
          receipt.result.items.some((item) => item.assetRef.projectId !== context.projectId)) {
        mark(id, 'rejected', 'receipt-invalid');
        say('agent.collect.delegate', { projectId: context.projectId, runId: context.runId, state: 'rejected', why: 'receipt-invalid' });
        return notDelegated('receipt-invalid');
      }
      mark(id, 'verifying', null, { refs });
      const writable = () => canWrite(context);
      // 这一轮此刻还能往项目里写吗(被停止、转私有后被撤销、发起人被踢出或没有写权限:不登记;字节留在素材库里没有人引用)
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
          // 种类与扩展名以素材服务核回来的为准(页面说的只在它没给时用)
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
          return stopped(denied ? 'run-revoked' : 'register-failed', denied ? COLLECT_BRIDGE_TEXT.revoked : `${COLLECT_BRIDGE_TEXT.registerFailed}。`);
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
   * 试着把一次下载委托给发起人的电脑。回 `{ delegated: true, items }`(已经核实并登记)、
   * `{ delegated: false, why, note }`(没委托成:调用方接着在云端匿名下载,`note` 写进作业的说明;`note` 为 null 表示这条链接本来就不用委托)、
   * 或 `{ delegated: false, stop: true, why, message }`(这一轮已经不能写了,或登记没成:不要再匿名下载)。
   * `job` 是云端作业表里的那一条(只读它的 `id`、`url`、`quality`、`site`);`onProgress({ state, stage?, percent? })` 可选。
   */
  async function delegateDownload(context, job, args = {}, { signal = null, onProgress = () => {} } = {}) {
    if (closed) fail('collect-bridge-closed', 503);
    let site = null;
    try { site = loginSiteOf(job.url); } catch { site = null; }
    // 不属于有登录支持的站点:就是缺省的云端匿名下载,不打扰发起人的页面
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
    const progress = (value) => { try { onProgress(value); } catch { /* 调用方的事 */ } };
    const end = (state, why, outcome) => {
      mark(id, state, why);
      say('agent.collect.delegate', { projectId: context.projectId, runId: context.runId, state, why });
      return outcome;
    };
    /** 让本机停下(尽力而为:页面不在就算了,它那边到时限自己收) */
    const cancelPage = async () => { try { await ask(context, 'collect_delegate_cancel', { delegationId: id }, `${id}-x`); } catch { /* 这一轮已经不在了 */ } };
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
      if (local.aborted) { await cancelPage(); return end('cancelled', 'run-cancelled', stopped('run-cancelled', '已取消')); }
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
        if (closed) return stopped('host-close', '云端 Agent 服务正在关闭,这次下载中断了。');
        if (local.aborted) { await cancelPage(); return end('cancelled', 'run-cancelled', stopped('run-cancelled', '已取消')); }
        if (Number(now()) - started > limits.delegateMs) { await cancelPage(); return end('fallback', 'timeout', notDelegated('timeout')); }
        let poll;
        try { poll = await ask(context, 'collect_delegate_poll', { delegationId: id }, `${id}-p${seq++}`, local); } catch (error) {
          if (revoked(error)) return end('cancelled', 'run-revoked', stopped('run-revoked', COLLECT_BRIDGE_TEXT.revoked));
          poll = { delivered: false, offline: true, why: 'authority-unavailable', state: 'offline' };
        }
        if (!poll.delivered) {
          if (local.aborted || poll.state === 'cancelled') { if (local.aborted) await cancelPage(); return end('cancelled', 'run-cancelled', stopped('run-cancelled', '已取消')); }
          // 交回时被拒(对话转私有、被停止、发起人被踢出、授权换了栅栏、答案不合规矩):这一次委托到此为止,晚到的回执不登记
          if (poll.state === 'rejected') {
            await cancelPage();
            const why = poll.why === 'result-invalid' ? 'receipt-invalid' : `late-${codeOf(poll.why, 'rejected')}`.slice(0, 40);
            // 这一轮自己也不能写了(被停止、被撤销):不再退回去匿名下载;还能写(例如主人把自己的对话转私有)才接着匿名
            if (!(await canWrite(context))) return end('rejected', why, stopped('run-revoked', COLLECT_BRIDGE_TEXT.revoked));
            return end('rejected', why, notDelegated(poll.why === 'result-invalid' ? 'receipt-invalid' : 'failed'));
          }
          if (['initiator-revoked', 'no-page'].includes(poll.why)) return end('fallback', 'initiator-offline', notDelegated('initiator-offline'));
          // 页面一时连不上(断线重连、文档服务一时答不上):宽限内接着问;整次委托的时限先到就按超时办
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

  /** `collect_login`:让发起页打开本机的登录窗口。云端只拿回「开没开」「是不是已经登录」 */
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

  /** `collect_login_check`:查发起人电脑上的登录态。云端只拿回「登没登」「是不是过期了」 */
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

  /** 一个云端作业的委托记录(重启后也查得到);没有委托过回 null。只回本项目本对话的 */
  function delegationOf(scope, jobId) {
    if (typeof scope?.projectId !== 'string' || typeof scope?.conversationId !== 'string' || typeof jobId !== 'string') return null;
    let row = null;
    try { row = db.prepare('SELECT * FROM collect_delegations WHERE project_id=? AND conversation_id=? AND job_id=? ORDER BY created_at DESC LIMIT 1').get(scope.projectId, scope.conversationId, jobId) ?? null; } catch { row = null; }
    return row ? viewOf(row) : null;
  }

  /** 这一轮结束或被叫停:在等的委托全部收掉(宿主在收尾与控制通道里调,与 `bridge.cancelRun` 一起) */
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

  /** 绑到一轮上的那一份,交给 `hosted-collect.mjs` 的 `delegate` */
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
    try { db.prepare(`UPDATE collect_delegations SET state='interrupted', reason='host-close', updated_at=? WHERE state IN ('asking','downloading','verifying','registering')`).run(Number(now())); } catch { /* 已经关了 */ }
    try { db.close(); } catch { /* 已经关了 */ }
    say('agent.collect.delegate.closed', { reason });
    return { childrenClosed: true, streamsClosed: true, workPending: live.size };
  }

  return Object.freeze({ forRun, delegateDownload, settleReceipt, login, loginCheck, delegationOf, cancelRun, close, limits,
    describe: () => ({ live: live.size, settling: settling.size, closed }) });
}
