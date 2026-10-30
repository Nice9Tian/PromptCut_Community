/**
 * 闸(契约 `docs/plan/cloud-agent-contract.md` 第 6 节):所有对话与模型调用都经过的那一处额度与并发检查。
 *
 * 两个入口,所有路径都走它:
 *   admitRun({ projectId, userId })               一轮开始前;放行时占一个并发名额,结束时由 `release` 还
 *   admitModelCall({ projectId, userId, model })  每次向模型发请求前
 *     → { ok: true } | { ok: false, code: 'disabled' | 'busy' | 'quota-exceeded', message }
 *   record({ … })                                  每次模型请求之后记一行用量(`usage.mjs`)
 *
 * 判定顺序:开关(`disabled`)→ 节点并发、项目并发、成员并发(`busy`)→ 额度(`quota-exceeded`)。
 *
 * **现在永远放行的含义**:`limits.json` 不存在、或 `defaults.limitTokens` 为 null 且 `projects` 为空时,额度那一步对任何项目
 * 都放行。节点级的三个并发数是保护同机服务的资源上限,有数字,不属于「额度」。
 *
 * `limits.json`(`<数据目录>/config/limits.json`):
 *   { "v": 1,
 *     "node": { "maxRuns": 6, "maxRunsPerProject": 3, "maxRunsPerMember": 2, "maxInstances": 24 },
 *     "defaults": { "limitTokens": null, "window": "total", "maxRuns": null },
 *     "projects": { "<projectId>": { "limitTokens": 2000000, "window": "month", "maxRuns": 2 } } }
 * 每次过闸前看文件的修改时间与大小,变了就重读;格式不对保留上一份并记日志。发上限只改这个文件,不改代码、不重启。
 * 本文件不引用 `src/`。
 */
import fs from 'node:fs';
import path from 'node:path';

export const NODE_LIMIT_DEFAULTS = Object.freeze({ maxRuns: 6, maxRunsPerProject: 3, maxRunsPerMember: 2, maxInstances: 24 });
export const QUOTA_WINDOWS = Object.freeze(['total', 'month', 'day']);
const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function limitsFileOf(dataDir) {
  return path.join(dataDir, 'config', 'limits.json');
}

const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const nullOr = (v, ok) => v === null || v === undefined || ok(v);

/** 核对并补齐一份 `limits.json` 的内容;不对就抛错(说明哪里不对) */
export function normalizeLimits(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('不是对象');
  if (raw.v !== undefined && raw.v !== 1) throw new Error(`不认识的版本 v=${raw.v}`);
  const node = { ...NODE_LIMIT_DEFAULTS };
  if (raw.node !== undefined) {
    if (!raw.node || typeof raw.node !== 'object' || Array.isArray(raw.node)) throw new Error('node 不是对象');
    for (const k of Object.keys(NODE_LIMIT_DEFAULTS)) {
      if (raw.node[k] === undefined) continue;
      if (!posInt(raw.node[k])) throw new Error(`node.${k} 要是正整数`);
      node[k] = raw.node[k];
    }
  }
  const one = (v, at) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${at} 不是对象`);
    if (!nullOr(v.limitTokens, (x) => Number.isSafeInteger(x) && x >= 0)) throw new Error(`${at}.limitTokens 要是非负整数或 null`);
    if (v.window !== undefined && !QUOTA_WINDOWS.includes(v.window)) throw new Error(`${at}.window 只能是 ${QUOTA_WINDOWS.join(' / ')}`);
    if (!nullOr(v.maxRuns, posInt)) throw new Error(`${at}.maxRuns 要是正整数或 null`);
    return { limitTokens: v.limitTokens ?? null, window: v.window ?? 'total', maxRuns: v.maxRuns ?? null };
  };
  const defaults = raw.defaults === undefined ? { limitTokens: null, window: 'total', maxRuns: null } : one(raw.defaults, 'defaults');
  const projects = {};
  if (raw.projects !== undefined) {
    if (!raw.projects || typeof raw.projects !== 'object' || Array.isArray(raw.projects)) throw new Error('projects 不是对象');
    for (const [id, v] of Object.entries(raw.projects)) {
      if (!PROJECT_ID_RE.test(id)) throw new Error(`projects 里的项目号不合法:${id.slice(0, 40)}`);
      // 项目这一行没写的字段跟着 defaults
      const p = one(v, `projects.${id}`);
      projects[id] = {
        limitTokens: v.limitTokens === undefined ? defaults.limitTokens : p.limitTokens,
        window: v.window === undefined ? defaults.window : p.window,
        maxRuns: v.maxRuns === undefined ? defaults.maxRuns : p.maxRuns,
      };
    }
  }
  return { v: 1, node, defaults, projects };
}

export const EMPTY_LIMITS = Object.freeze(normalizeLimits({}));

/** 读文件(给管理命令用):没有文件回空的那一份;格式不对抛错 */
export function readLimitsFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err?.code === 'ENOENT') return { v: 1 }; throw err; }
  const raw = JSON.parse(text);
  normalizeLimits(raw);
  return raw;
}

/** 写文件(临时文件加改名,0600) */
export function writeLimitsFile(file, raw) {
  normalizeLimits(raw);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, ...raw }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * @param {object} o
 * @param {string | null} [o.limitsFile] 不给就没有额度配置(永远放行,并发用缺省数字)
 * @param {ReturnType<import('./usage.mjs').createUsageLog>} o.usage
 * @param {(projectId: string) => boolean} [o.isEnabled] 这个项目的「云端 Agent」开关(乙块接上文档服务的推送之前恒为开)
 * @param {object} [o.node] 覆盖节点级并发数(测试)
 */
export function createGate({ limitsFile = null, usage, isEnabled = () => true, node: nodeOverride = null, now = () => Date.now(), log = () => {} } = {}) {
  if (!usage || typeof usage.append !== 'function') throw new TypeError('createGate: 要 usage');
  let limits = EMPTY_LIMITS;
  let stamp = '';
  /** 进行中的一轮:全节点、按项目、按成员 */
  let running = 0;
  const byProject = new Map();
  const byMember = new Map();

  function reload() {
    if (!limitsFile) return;
    let st;
    try { st = fs.statSync(limitsFile); } catch {
      if (stamp !== 'none') { stamp = 'none'; limits = EMPTY_LIMITS; }
      return;
    }
    const s = `${st.mtimeMs}:${st.size}`;
    if (s === stamp) return;
    stamp = s;
    try {
      limits = normalizeLimits(JSON.parse(fs.readFileSync(limitsFile, 'utf8')));
      log('agent.limits.loaded', { projects: Object.keys(limits.projects).length });
    } catch (err) {
      // 写坏了:保留上一份,不崩、不放开也不收紧
      log('agent.limits.invalid', { message: String(err?.message ?? err).slice(0, 160) });
    }
  }

  const nodeLimits = () => ({ ...limits.node, ...(nodeOverride ?? {}) });
  const projectLimits = (projectId) => limits.projects[projectId] ?? limits.defaults;
  const memberKey = (projectId, userId) => `${projectId}\n${userId}`;
  const bump = (map, key, d) => {
    const n = (map.get(key) ?? 0) + d;
    if (n > 0) map.set(key, n); else map.delete(key);
  };

  function quota(projectId) {
    const pl = projectLimits(projectId);
    if (pl.limitTokens === null) return { ok: true };
    const used = usage.used(projectId, pl.window, now());
    if (used < pl.limitTokens) return { ok: true };
    return { ok: false, code: 'quota-exceeded', message: `这个项目的云端 Agent 额度已用完(已用 ${used} / 上限 ${pl.limitTokens})。请联系托管方。`, used, limit: pl.limitTokens };
  }

  function enabled(projectId) {
    let on = true;
    try { on = isEnabled(projectId) !== false; } catch { on = true; }
    return on ? { ok: true } : { ok: false, code: 'disabled', message: '项目创建者已关闭云端 Agent。' };
  }

  return {
    /** 一轮开始前。放行时占名额;之后必须恰好调一次 `release` */
    admitRun({ projectId, userId }) {
      reload();
      const e = enabled(projectId);
      if (!e.ok) return e;
      const n = nodeLimits();
      const pl = projectLimits(projectId);
      const busy = { ok: false, code: 'busy', message: '云端 Agent 正忙,请稍后再试。' };
      if (running >= n.maxRuns) return busy;
      if ((byProject.get(projectId) ?? 0) >= Math.min(n.maxRunsPerProject, pl.maxRuns ?? Infinity)) return busy;
      if ((byMember.get(memberKey(projectId, userId)) ?? 0) >= n.maxRunsPerMember) return busy;
      const q = quota(projectId);
      if (!q.ok) return q;
      running += 1;
      bump(byProject, projectId, 1);
      bump(byMember, memberKey(projectId, userId), 1);
      return { ok: true };
    },

    /** 还名额(一轮结束,不论怎么结束的) */
    release({ projectId, userId }) {
      if (running > 0) running -= 1;
      bump(byProject, projectId, -1);
      bump(byMember, memberKey(projectId, userId), -1);
    },

    /** 每次向模型发请求前 */
    admitModelCall({ projectId }) {
      reload();
      const e = enabled(projectId);
      if (!e.ok) return e;
      return quota(projectId);
    },

    /** 记一次模型请求的用量 */
    record(row) {
      return usage.append(row);
    },

    /** 这个项目的额度与已用量(给 `GET /v1/info`) */
    quotaOf(projectId) {
      reload();
      const pl = projectLimits(projectId);
      return { tokens: usage.used(projectId, pl.window, now()), limitTokens: pl.limitTokens, window: pl.window };
    },

    nodeLimits() {
      reload();
      return nodeLimits();
    },

    /** 诊断:此刻占着的名额 */
    describe() {
      return { running, projects: Object.fromEntries(byProject), members: byMember.size };
    },
  };
}
