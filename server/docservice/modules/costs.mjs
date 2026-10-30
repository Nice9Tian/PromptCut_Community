/**
 * 成本记录模块（语义 `docs/semantics/mechanism/document-service.md`「成本记录」、`mechanism/rendering.md`「界限搜索与成本记录」；
 * 契约 `docs/plan/c10-contract.md` 第 3 节，分支 `claude/c10-cost`）。
 *
 * 桌面版与所有在线浏览器测完一张卡，把它的活渲单帧耗时写进这里（2026-10-07 用户定）；只有一个舞台的在线页面打开项目时读本项目的
 * 全部记录，按耗时给卡排序、做界限搜索（`src/render/boundarySearch.mjs`）。只放耗时，不放字节。
 *
 * # 键与值
 *
 * - 键：`(identityKey, envFingerprint)`。`identityKey` 是卡片身份（`src/render/cardCostKey.mjs` 的 `cardCostKey`：
 *   参数、源码版本、帧率、审阅表、片段长度），本来就不含测量机器；`envFingerprint` 是测量环境的指纹，
 *   与预渲染结果键同一套（`server/render-node/fingerprint.mjs`：操作系统、GPU 基础类别、Chrome 主版本）。
 * - 值：`stepMs`（活渲单帧耗时，进入判重的那个数）、`samples`（采样帧数）、`measuredAt`（测量时刻，毫秒）、
 *   `mode`（构建模式 `'dev'` / `'build'`）。
 * - **同一个键只留最新一条**：按 `measuredAt` 比，新来的不比已有的旧才替换（同一时刻后到的赢）。这样桌面版在接上
 *   共享项目时补传的旧记录不会盖掉别人刚测的新记录。
 *
 * # 协议（请求都可带 `reqId`，回包原样带回）
 *
 *   cost.put  { projectId, records: [{ identityKey, stepMs, samples, measuredAt, mode }], environment? | envFingerprint? }
 *     → cost.stored { projectId, envFingerprint, count, added, updated, ignored }
 *     环境二选一：`environment` 是页面报的原始值 `{ platform, userAgent, renderer, vendor }`（`src/editor/pageEnvironment.mjs`），
 *     由这里用 `describeEnvironment` 算指纹 —— 页面只报原始值、不自己算，归一规则只有一处；
 *     `envFingerprint` 是已经算好的 16 位小写十六进制（Node 一侧的调用方用）。`ignored` 是比已有记录旧、没替换的条数。
 *
 *   cost.list { projectId, environment? }
 *     → cost.listing { projectId, records: [{ identityKey, envFingerprint, stepMs, samples, measuredAt, mode }], truncated, envFingerprint? }
 *     回本项目的全部记录（按 identityKey、envFingerprint 排好序）。带了 `environment` 时顺带回它的指纹：
 *     界限搜索用它给本机的测量结果做键（「卡片身份 + 本机环境指纹」），不必在页面里另算一遍。
 *
 *   出错：`error { reason }`，`reason` 是 `bad-message`（形状不对，整条不落）、`forbidden`（不是这个项目的成员）、
 *   `too-large`（一次写太多，或这个项目的记录已满）、`unsupported`（不认识的类型）。
 *
 * # 权限与隔离
 *
 * 和内容库一样按项目空间各起一份（`spaces.mjs`、`shared-service.mjs` 的 `bundleForSpace`），空间之间互不相通。
 * 在共享项目的空间里只认本项目：`projectId` 必须等于空间名（就是连接凭证里的项目），别的一律 `forbidden`——
 * 成员才能读写本项目的记录。`local` 空间只有本机身份进得来，按 `projectId` 分开存、不另设限制。
 *
 * # 存储
 *
 * 每个项目一条追加日志 `costs/<projectId>`（与内容库同一份空间存储），第一次用到时回放，之后只在内存里维护。
 * 每条日志记录都带 `projectId`，回放时按它过滤（Windows 文件名不分大小写，见 `store/index.mjs`）。
 */
import { createMemoryStore } from '../store/index.mjs';
import { describeEnvironment } from '../../render-node/fingerprint.mjs';
import { LOCAL_SPACE } from '../spaces.mjs';

export const COSTS_MODULE = 'costs';

/** 三级数字（`mechanism/document-service.md`「成本记录」） */
export const COSTS_LIMITS = Object.freeze({
  /** 一次 `cost.put` 最多几条 */
  MAX_PUT: 500,
  /** 一个项目最多存几条（卡数 × 环境数；到了上限只许替换已有的键） */
  MAX_RECORDS: 20_000,
  /** `cost.list` 一次回几条；超了带 `truncated: true`，按测量时刻从新到旧留 */
  MAX_LIST: 5_000,
  /** 单帧耗时的合理上限（毫秒）；超了当坏形状 */
  MAX_STEP_MS: 600_000,
  /** 采样帧数的上限 */
  MAX_SAMPLES: 1_000_000,
});

const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const IDENTITY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const FINGERPRINT_RE = /^[0-9a-f]{16}$/;
const MODES = new Set(['dev', 'build']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

class Refused extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}
const bad = (detail) => { throw new Refused('bad-message', detail); };

function checkProjectId(v) {
  if (typeof v !== 'string' || !PROJECT_ID_RE.test(v)) bad('projectId 不合法');
  return v;
}

/** 页面报的原始环境 → 指纹；形状不对抛 bad-message */
function fingerprintOfEnvironment(env) {
  if (!isObj(env)) bad('environment 必须是对象');
  for (const k of ['platform', 'userAgent', 'renderer', 'vendor']) {
    if (env[k] !== undefined && (typeof env[k] !== 'string' || env[k].length > 1024)) bad(`environment.${k} 必须是不超过 1024 个字符的字符串`);
  }
  return describeEnvironment({ platform: env.platform, renderer: env.renderer, vendor: env.vendor, chromeVersion: env.userAgent }).fingerprint;
}

/** 写入时的环境：`environment` 与 `envFingerprint` 恰好给一个 */
function envOfPut(msg) {
  const hasEnv = msg.environment !== undefined;
  const hasFp = msg.envFingerprint !== undefined;
  if (hasEnv === hasFp) bad('environment 与 envFingerprint 恰好给一个');
  if (hasFp) {
    if (typeof msg.envFingerprint !== 'string' || !FINGERPRINT_RE.test(msg.envFingerprint)) bad('envFingerprint 必须是 16 位小写十六进制');
    return msg.envFingerprint;
  }
  return fingerprintOfEnvironment(msg.environment);
}

/** 一条记录的形状；只留认得的字段 */
function checkRecord(r, i) {
  const at = `records[${i}]`;
  if (!isObj(r)) bad(`${at} 必须是对象`);
  if (typeof r.identityKey !== 'string' || !IDENTITY_RE.test(r.identityKey)) bad(`${at}.identityKey 不合法`);
  if (typeof r.stepMs !== 'number' || !Number.isFinite(r.stepMs) || r.stepMs < 0 || r.stepMs > COSTS_LIMITS.MAX_STEP_MS) bad(`${at}.stepMs 必须是 0～${COSTS_LIMITS.MAX_STEP_MS} 的数`);
  if (!Number.isSafeInteger(r.samples) || r.samples < 1 || r.samples > COSTS_LIMITS.MAX_SAMPLES) bad(`${at}.samples 必须是 1～${COSTS_LIMITS.MAX_SAMPLES} 的整数`);
  if (typeof r.measuredAt !== 'number' || !Number.isFinite(r.measuredAt) || r.measuredAt <= 0) bad(`${at}.measuredAt 必须是正数（毫秒时间戳）`);
  if (!MODES.has(r.mode)) bad(`${at}.mode 只能是 dev / build`);
  return { identityKey: r.identityKey, stepMs: r.stepMs, samples: r.samples, measuredAt: r.measuredAt, mode: r.mode };
}

const keyOf = (identityKey, envFingerprint) => `${identityKey}\u0000${envFingerprint}`;
const streamOf = (projectId) => `costs/${projectId}`;

/** 对外的一条记录（去掉写入者等内部字段） */
const publicOf = (r) => ({ identityKey: r.identityKey, envFingerprint: r.envFingerprint, stepMs: r.stepMs, samples: r.samples, measuredAt: r.measuredAt, mode: r.mode });

/**
 * @param {object} [options]
 * @param {string} [options.space] 这份实例属于哪个空间（`spaces.mjs` 的空间名）；缺省 `local`
 * @param {{ append(stream: string, record: object): void, read(stream: string): object[] }} [options.store] 缺省用内存存储
 * @param {() => number} [options.now] 服务端收到的时刻（只记进日志，不参与「最新」的比较）；缺省 `ctx.now()`
 * @param {object} [options.limits] 覆盖 `COSTS_LIMITS` 的几项（测试用）
 */
export function costsModule({ space = LOCAL_SPACE, store = createMemoryStore(), now, limits = {} } = {}) {
  const L = { ...COSTS_LIMITS, ...limits };
  /** projectId → Map<key, record>；第一次用到时从日志回放 */
  const projects = new Map();
  /** connId → principal */
  const principals = new Map();

  function tableOf(projectId) {
    let table = projects.get(projectId);
    if (table) return table;
    table = new Map();
    for (const rec of store.read(streamOf(projectId))) {
      if (!isObj(rec) || rec.projectId !== projectId || typeof rec.identityKey !== 'string' || typeof rec.envFingerprint !== 'string') continue;
      const key = keyOf(rec.identityKey, rec.envFingerprint);
      const prev = table.get(key);
      if (prev && prev.measuredAt > rec.measuredAt) continue;
      table.set(key, rec);
    }
    projects.set(projectId, table);
    return table;
  }

  /** 成员才能读写本项目的记录：共享项目的空间里 projectId 必须就是空间名 */
  function checkAccess(connId, projectId) {
    const principal = principals.get(connId);
    if (!principal || principal.scope === 'admin') throw new Refused('forbidden', '这条连接不能读写成本记录');
    if (space !== LOCAL_SPACE && projectId !== space) throw new Refused('forbidden', '只有这个项目的成员能读写它的成本记录');
  }

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  function put(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    checkAccess(connId, projectId);
    const envFingerprint = envOfPut(msg);
    if (!Array.isArray(msg.records) || msg.records.length < 1) bad('records 必须是非空数组');
    if (msg.records.length > L.MAX_PUT) throw new Refused('too-large', `一次最多写 ${L.MAX_PUT} 条`);
    // 先整批校验，有一条不对就整条不落
    const records = msg.records.map(checkRecord);
    const table = tableOf(projectId);
    let added = 0, updated = 0, ignored = 0;
    const at = typeof now === 'function' ? now() : ctx.now();
    const fresh = records.filter((r) => !table.has(keyOf(r.identityKey, envFingerprint)));
    if (table.size + new Set(fresh.map((r) => r.identityKey)).size > L.MAX_RECORDS) throw new Refused('too-large', `这个项目的成本记录已满（${L.MAX_RECORDS} 条）`);
    for (const r of records) {
      const key = keyOf(r.identityKey, envFingerprint);
      const prev = table.get(key);
      if (prev && prev.measuredAt > r.measuredAt) { ignored++; continue; }
      const rec = { projectId, ...r, envFingerprint, at };
      // 先落日志再改内存：落盘失败时状态不变，核心回 internal
      store.append(streamOf(projectId), rec);
      table.set(key, rec);
      if (prev) updated++; else added++;
    }
    reply(ctx, connId, { type: 'cost.stored', projectId, envFingerprint, count: table.size, added, updated, ignored }, reqId);
  }

  function list(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    checkAccess(connId, projectId);
    const envFingerprint = msg.environment === undefined ? undefined : fingerprintOfEnvironment(msg.environment);
    const all = [...tableOf(projectId).values()];
    let shown = all;
    const truncated = all.length > L.MAX_LIST;
    if (truncated) shown = [...all].sort((a, b) => b.measuredAt - a.measuredAt).slice(0, L.MAX_LIST);
    const records = shown.map(publicOf).sort((a, b) => byCodeUnit(a.identityKey, b.identityKey) || byCodeUnit(a.envFingerprint, b.envFingerprint));
    const out = { type: 'cost.listing', projectId, records, truncated };
    if (envFingerprint !== undefined) out.envFingerprint = envFingerprint;
    reply(ctx, connId, out, reqId);
  }

  const HANDLERS = { 'cost.put': put, 'cost.list': list };

  return {
    name: COSTS_MODULE,
    types: ['cost.'],

    connect(ctx, connId, principal) {
      principals.set(connId, { ...principal });
    },

    disconnect(ctx, connId) {
      principals.delete(connId);
    },

    handle(ctx, connId, msg) {
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: '成本记录模块不支持这种消息' }, reqId);
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (err instanceof Refused) return reply(ctx, connId, { type: 'error', reason: err.reason, detail: err.message }, reqId);
        throw err;
      }
    },

    describe() {
      let records = 0;
      for (const table of projects.values()) records += table.size;
      return { projects: projects.size, records };
    },
  };
}

export const createCostsModule = costsModule;
export default costsModule;
