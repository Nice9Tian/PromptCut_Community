/**
 * 托管方渲染服务写成的块的容量记账（契约 `docs/plan/hosted-render-contract.md` 第 6 节；HR21）。
 *
 * 云节点上的渲染服务凭带 `sv: 'render'` 的素材票据往 `snap`、`px` 两个命名空间写预渲染产物（`asset-service.ts` 认票据里的服务名）。
 * 这些块单独记账，上限到了只拦渲染服务的写入，成员的写入不受影响。成员写的块不记、不归这里管。
 *
 * - **记账单位**：块 `{ ns, hash, size }` 与它归属的项目集合（同一块被几个项目写到，内容相同，就记几个项目）。
 *   新块在收尾成功时记；写之前它已经入库（成员写的，或渲染服务为别的项目写的）：别人写的不记，自己写过的只补项目归属；
 *   之后成员写了同一个块（内容相同，字节没有再写）：从这里摘掉，它不再「只归渲染服务」。
 * - **持久化**：`<托管数据目录>/assets/.service-usage/render.ndjson`，追加写，启动时回放成内存表；行数明显多于存活条目时启动时压缩重写。
 *   行：`{"op":"add","ns","hash","size","projectId","at"}`、`{"op":"drop-project","projectId","at"}`、`{"op":"drop-block","ns","hash","at"}`。
 * - **上限**：`min(20 GiB, 托管数据目录所在盘总容量的四分之一)`，环境变量 `PROMPTCUT_HOSTED_RENDER_CAP_BYTES` 可改（见 `serviceCapBytes`）。
 *   「在途」的新块（第一片到了、还没收尾）先占住名额，免得并发写把上限冲穿；占着的名额 2 小时没收尾就放掉。
 * - **删项目**：`dropProject(projectId)` 去掉这个项目名下的条目，回「不再被任何项目记着」的块，由调用方（`hosted/combo.mjs`）从数据层删掉。
 *
 * 没有做的：契约第 6 节第 2 条「超过上限的九成时按最久没人在线的项目淘汰」。它的前提——清掉的块在内容库清单里还有引用时，在线页面
 * 必须按「没有产物」重新发预渲染重试——现在不成立（报告 `docs/reports/AGENT-render-service-ops.md`「容量」一节），所以这里没有淘汰。
 *
 * 只引 Node 内置模块与同目录的 `px-evict.mjs`（取磁盘总容量）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { diskTotalOf } from './px-evict.mjs';

const GiB = 1024 ** 3;
export const SERVICE_USAGE_DEFAULTS = Object.freeze({
  capBytes: 20 * GiB,
  diskRatio: 0.25,
  reserveTtlMs: 2 * 60 * 60_000,
  /** 日志行数超过「存活条目数 × 此倍数 + compactSlack」就在启动时压缩 */
  compactFactor: 3,
  compactSlack: 2000,
});
export const SERVICE_USAGE_FILE = 'render.ndjson';
export const SERVICE_USAGE_DIR = '.service-usage';
/** 环境变量：渲染服务产物的上限（字节），测试与排查用 */
export const SERVICE_CAP_ENV = 'PROMPTCUT_HOSTED_RENDER_CAP_BYTES';
const HASH = /^[0-9a-f]{64}$/;
const NAMESPACES = new Set(['snap', 'px']);

/**
 * 渲染服务产物的上限（字节）：环境变量优先；否则 `min(20 GiB, 盘总容量 × 1/4)`，盘容量取不到就是 20 GiB。
 * @param {{ env?: NodeJS.ProcessEnv, diskTotal?: number | null }} [o]
 */
export function serviceCapBytes({ env = process.env, diskTotal = null } = {}) {
  const raw = env?.[SERVICE_CAP_ENV];
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const d = SERVICE_USAGE_DEFAULTS;
  if (Number.isFinite(diskTotal) && diskTotal > 0) return Math.min(d.capBytes, Math.floor(diskTotal * d.diskRatio));
  return d.capBytes;
}

export { diskTotalOf };

const keyOf = (ns, hash) => `${ns}/${hash}`;

/**
 * @param {object} p
 * @param {string} p.dir  `<托管数据目录>/assets/.service-usage`
 * @param {number | (() => number)} p.capBytes
 * @param {string} [p.service]  记账的服务名，缺省 `render`
 * @param {() => number} [p.now]
 * @param {(event: string, fields?: object) => void} [p.log]
 * @param {Partial<typeof SERVICE_USAGE_DEFAULTS>} [p.options]
 */
export function createServiceUsage({ dir, capBytes, service = 'render', now = Date.now, log = () => {}, options = {}, projectScoped = false }) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('createServiceUsage：dir 必须是非空字符串');
  const o = { ...SERVICE_USAGE_DEFAULTS, ...options };
  const file = path.join(path.resolve(dir), projectScoped ? 'render-v2.ndjson' : SERVICE_USAGE_FILE);
  /** `ns/hash` → { ns, hash, size, projects: Map<projectId, at> } */
  const blocks = new Map();
  /** `ns/hash` → { size, at }：在途的新块 */
  const reserved = new Map();
  let lines = 0;
  let writable = true;
  let dirMade = false;
  const blockKey = (ns, hash, projectId) => {
    if (!projectScoped) return keyOf(ns, hash);
    if (typeof projectId !== 'string' || !projectId) throw new TypeError('projectId required for physical project usage');
    return `${JSON.stringify(projectId)}/${ns}/${hash}`;
  };

  const cap = () => (typeof capBytes === 'function' ? Number(capBytes()) : Number(capBytes));

  function applyAdd(rec) {
    if (!NAMESPACES.has(rec.ns) || !HASH.test(rec.hash) || !Number.isSafeInteger(rec.size) || rec.size < 0 || typeof rec.projectId !== 'string' || !rec.projectId) return;
    const k = blockKey(rec.ns, rec.hash, rec.projectId);
    let b = blocks.get(k);
    if (!b) blocks.set(k, (b = { ns: rec.ns, hash: rec.hash, size: rec.size, projects: new Map() }));
    b.projects.set(rec.projectId, Number(rec.at) || 0);
  }
  function applyDropProject(projectId) {
    const gone = [];
    for (const [k, b] of blocks) {
      if (!b.projects.delete(projectId)) continue;
      if (b.projects.size === 0) { blocks.delete(k); gone.push({ ns: b.ns, hash: b.hash, size: b.size, ...(projectScoped ? { projectId } : {}) }); }
    }
    return gone;
  }
  function applyDropBlock(ns, hash, projectId) {
    return blocks.delete(blockKey(ns, hash, projectId));
  }

  function append(rec) {
    if (!writable) return;
    try {
      // 目录第一次要写时才建：没有渲染服务的托管端不会多出一个空目录
      if (!dirMade) { fs.mkdirSync(path.dirname(file), { recursive: true }); dirMade = true; }
      fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
      lines += 1;
    } catch (err) {
      // 记不下来也不能挡住写入：内存表照常更新，打日志；下次启动时少了这几条，只会少记（不会多删）
      writable = false;
      log('service-usage.write-failed', { message: String(err?.message || err) });
    }
  }

  function snapshotLines() {
    const out = [];
    for (const b of blocks.values()) {
      for (const [projectId, at] of b.projects) out.push(JSON.stringify({ op: 'add', ns: b.ns, hash: b.hash, size: b.size, projectId, at }));
    }
    return out;
  }

  function compact() {
    const keep = snapshotLines();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, keep.length ? `${keep.join('\n')}\n` : '');
      fs.renameSync(tmp, file);
      lines = keep.length;
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 没写成 */ }
      log('service-usage.compact-failed', { message: String(err?.message || err) });
    }
  }

  function load() {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err?.code !== 'ENOENT') log('service-usage.read-failed', { message: String(err?.code || err) }); }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      lines += 1;
      let rec;
      try { rec = JSON.parse(t); } catch { continue; } // 崩溃留下的半行
      if (!rec || typeof rec !== 'object') continue;
      if (rec.op === 'add') applyAdd(rec);
      else if (rec.op === 'drop-project' && typeof rec.projectId === 'string') applyDropProject(rec.projectId);
      else if (rec.op === 'drop-block' && (!projectScoped || rec.projectId)) applyDropBlock(rec.ns, rec.hash, rec.projectId);
    }
    if (lines > blocks.size * o.compactFactor + o.compactSlack) compact();
  }

  function pruneReserved() {
    const t = now();
    for (const [k, r] of reserved) if (t - r.at >= o.reserveTtlMs) reserved.delete(k);
  }

  load();

  const api = {
    service,
    projectScoped,
    file,
    capBytes: cap,
    /** 这个服务名的写入要不要记账 */
    accounts: (name) => name === service,
    /** 已记账的字节数（含在途占用的 `reservedBytes` 另算） */
    usedBytes() {
      let n = 0;
      for (const b of blocks.values()) n += b.size;
      return n;
    },
    reservedBytes() {
      pruneReserved();
      let n = 0;
      for (const r of reserved.values()) n += r.size;
      return n;
    },
    /** 已记账的块数 */
    blockCount: () => blocks.size,
    has: (ns, hash, projectId) => blocks.has(blockKey(ns, String(hash).toLowerCase(), projectId)),
    projectsOf(ns, hash, projectId) {
      const b = blocks.get(blockKey(ns, String(hash).toLowerCase(), projectId));
      return b ? [...b.projects.keys()] : [];
    },
    /** 某项目名下记着多少字节（含与别的项目共有的块，各按全额计） */
    bytesOfProject(projectId) {
      let n = 0;
      for (const b of blocks.values()) if (b.projects.has(projectId)) n += b.size;
      return n;
    },
    /**
     * 渲染服务要写一个新块（还没入库）：放行就占住 `size` 字节的名额，回 true；加上已记账与在途的会超过上限回 false。
     * 同一个块第二次来（分片一片一片到）不重复占。
     */
    reserve(ns, hash, size, projectId) {
      const k = blockKey(ns, String(hash).toLowerCase(), projectId);
      pruneReserved();
      if (reserved.has(k)) return true;
      if (api.usedBytes() + api.reservedBytes() + size > cap()) return false;
      reserved.set(k, { size, at: now() });
      return true;
    },
    /** 渲染服务写成了一个块（收尾成功）：记一笔、放掉在途名额。同一个块再来只补项目归属 */
    record({ ns, hash, size, projectId }) {
      const h = String(hash).toLowerCase();
      const k = blockKey(ns, h, projectId);
      reserved.delete(k);
      const rec = { op: 'add', ns, hash: h, size, projectId, at: now() };
      const before = blocks.get(k)?.projects.get(projectId);
      applyAdd(rec);
      if (before === undefined) append(rec);
    },
    /** 在途的名额放掉（这次写失败了） */
    release(ns, hash, projectId) {
      reserved.delete(blockKey(ns, String(hash).toLowerCase(), projectId));
    },
    /** 别人（成员，或没有服务标记的写入）写了同一个块：它不再只归渲染服务，从这里摘掉 */
    disown(ns, hash, projectId) {
      const h = String(hash).toLowerCase();
      if (!applyDropBlock(ns, h, projectId)) return false;
      append({ op: 'drop-block', ns, hash: h, ...(projectScoped ? { projectId } : {}), at: now() });
      return true;
    },
    /** 删项目：去掉这个项目名下的条目；回不再被任何项目记着的块（调用方从数据层删掉） */
    dropProject(projectId) {
      const gone = applyDropProject(projectId);
      append({ op: 'drop-project', projectId, at: now() });
      return gone;
    },
    /** 状态（诊断用） */
    status() {
      return { service, capBytes: cap(), usedBytes: api.usedBytes(), reservedBytes: api.reservedBytes(), blocks: blocks.size, writable };
    },
    /** 现在就压缩日志（单测用） */
    compact,
    lineCount: () => lines,
  };
  return api;
}
