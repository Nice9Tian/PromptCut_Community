/**
 * Capacity accounting for chunks written by the host render service (contract
 * `docs/plan/hosted-render-contract.md` section 6; HR21).
 *
 * The render service on cloud nodes writes prerender outputs to the `snap` and `px` namespaces
 * using asset tickets with `sv: 'render'` (`asset-service.ts` recognizes the service name in the
 * ticket). These chunks are accounted for separately; when the cap is reached, only writes from the
 * render service are blocked, while member writes are unaffected. Chunks written by members are not
 * tracked and are not managed here.
 *
 * - **Accounting unit**: chunk `{ ns, hash, size }` and its set of owning projects (if the same
 *   chunk with identical content is written by multiple projects, all those projects are
 *   recorded). New chunks are recorded upon successful finalization; if already stored prior to
 *   writing (written by members, or written by the render service for another project): writes by
 *   others are not recorded, while writes by itself only backfill project ownership; if a member
 *   writes the same chunk later (identical content, bytes not rewritten): removed from here, as it
 *   no longer "belongs solely to the render service".
 * - **Persistence**: `<hosted data directory>/assets/.service-usage/render.ndjson`, append-only
 *   write, replayed into an in-memory table at startup; compacted and rewritten at startup when line
 *   count significantly exceeds live entries. Lines:
 *   `{"op":"add","ns","hash","size","projectId","at"}`,
 *   `{"op":"drop-project","projectId","at"}`,
 *   `{"op":"drop-block","ns","hash","at"}`.
 * - **Cap**: `min(20 GiB, one-fourth of total disk capacity where hosted data directory resides)`,
 *   configurable via environment variable `PROMPTCUT_HOSTED_RENDER_CAP_BYTES` (see
 *   `serviceCapBytes`). "In-flight" new chunks (first piece arrived, not yet finalized) reserve
 *   quota in advance to prevent concurrent writes from bursting past the cap; reserved quota is
 *   released if not finalized within 2 hours.
 * - **Project deletion**: `dropProject(projectId)` removes entries under this project and returns
 *   chunks "no longer tracked by any project", which the caller (`hosted/combo.mjs`) deletes from
 *   the data layer.
 *
 * Not implemented: contract section 6 item 2 "evict by project idle longest without online users
 * when exceeding 90% of cap". Its prerequisite: when cleared chunks still have references in the
 * content store manifest, the online page must retry sending prerender requests treating them as
 * "missing output": does not hold today (report `docs/reports/AGENT-render-service-ops.md` section
 * "Capacity"), so eviction is omitted here.
 *
 * Only imports Node built-in modules and `px-evict.mjs` in the same directory (to get total disk
 * capacity).
 */
import fs from 'node:fs';
import path from 'node:path';
import { diskTotalOf } from './px-evict.mjs';

const GiB = 1024 ** 3;
export const SERVICE_USAGE_DEFAULTS = Object.freeze({
  capBytes: 20 * GiB,
  diskRatio: 0.25,
  reserveTtlMs: 2 * 60 * 60_000,
  /** Compact at startup when log lines exceed "live entries × this multiplier + compactSlack" */
  compactFactor: 3,
  compactSlack: 2000,
});
export const SERVICE_USAGE_FILE = 'render.ndjson';
export const SERVICE_USAGE_DIR = '.service-usage';
/** Environment variable: cap on render service outputs (bytes), for testing and troubleshooting */
export const SERVICE_CAP_ENV = 'PROMPTCUT_HOSTED_RENDER_CAP_BYTES';
const HASH = /^[0-9a-f]{64}$/;
const NAMESPACES = new Set(['snap', 'px']);

/**
 * Cap on render service outputs (bytes): environment variable takes precedence; otherwise
 * `min(20 GiB, total disk capacity × 1/4)`, falling back to 20 GiB if disk capacity is unavailable.
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
 * @param {string} p.dir  `<hosted data directory>/assets/.service-usage`
 * @param {number | (() => number)} p.capBytes
 * @param {string} [p.service]  Service name for accounting, defaults to `render`
 * @param {() => number} [p.now]
 * @param {(event: string, fields?: object) => void} [p.log]
 * @param {Partial<typeof SERVICE_USAGE_DEFAULTS>} [p.options]
 */
export function createServiceUsage({ dir, capBytes, service = 'render', now = Date.now, log = () => {}, options = {}, projectScoped = false }) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('createServiceUsage: dir must be a non-empty string');
  const o = { ...SERVICE_USAGE_DEFAULTS, ...options };
  const file = path.join(path.resolve(dir), projectScoped ? 'render-v2.ndjson' : SERVICE_USAGE_FILE);
  /** `ns/hash` → { ns, hash, size, projects: Map<projectId, at> } */
  const blocks = new Map();
  /** `ns/hash` → { size, at }: in-flight new chunks */
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
      // Directory is only created on first write: hosted side without render service will not have an
      // extra empty directory
      if (!dirMade) { fs.mkdirSync(path.dirname(file), { recursive: true }); dirMade = true; }
      fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
      lines += 1;
    } catch (err) {
      // Failure to persist must not block writes: update in-memory table as usual and log; missing these
      // entries on next startup only undercounts (will not over-delete)
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
      try { fs.rmSync(tmp, { force: true }); } catch { /* Write failed */ }
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
      try { rec = JSON.parse(t); } catch { continue; } // Partial line left from a crash
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
    /** Whether writes for this service name should be accounted for */
    accounts: (name) => name === service,
    /** Accounted bytes (in-flight `reservedBytes` tracked separately) */
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
    /** Number of accounted chunks */
    blockCount: () => blocks.size,
    has: (ns, hash, projectId) => blocks.has(blockKey(ns, String(hash).toLowerCase(), projectId)),
    projectsOf(ns, hash, projectId) {
      const b = blocks.get(blockKey(ns, String(hash).toLowerCase(), projectId));
      return b ? [...b.projects.keys()] : [];
    },
    /**
     * Bytes accounted under a given project (including chunks shared with other projects, each counted
     * in full)
     */
    bytesOfProject(projectId) {
      let n = 0;
      for (const b of blocks.values()) if (b.projects.has(projectId)) n += b.size;
      return n;
    },
    /**
     * Render service wants to write a new chunk (not yet stored): reserves `size` bytes of quota and
     * returns true if admitted; returns false if adding to accounted and in-flight bytes would exceed
     * cap. Does not re-reserve when the same chunk arrives a second time (chunks arriving slice by
     * slice).
     */
    reserve(ns, hash, size, projectId) {
      const k = blockKey(ns, String(hash).toLowerCase(), projectId);
      pruneReserved();
      if (reserved.has(k)) return true;
      if (api.usedBytes() + api.reservedBytes() + size > cap()) return false;
      reserved.set(k, { size, at: now() });
      return true;
    },
    /**
     * Render service wrote a chunk successfully (finalization succeeded): record it and release
     * in-flight quota. If the same chunk arrives again, only backfill project ownership
     */
    record({ ns, hash, size, projectId }) {
      const h = String(hash).toLowerCase();
      const k = blockKey(ns, h, projectId);
      reserved.delete(k);
      const rec = { op: 'add', ns, hash: h, size, projectId, at: now() };
      const before = blocks.get(k)?.projects.get(projectId);
      applyAdd(rec);
      if (before === undefined) append(rec);
    },
    /** Release in-flight quota (this write failed) */
    release(ns, hash, projectId) {
      reserved.delete(blockKey(ns, String(hash).toLowerCase(), projectId));
    },
    /**
     * Someone else (a member, or a write without a service tag) wrote the same chunk: it no longer
     * belongs solely to the render service, remove it from here
     */
    disown(ns, hash, projectId) {
      const h = String(hash).toLowerCase();
      if (!applyDropBlock(ns, h, projectId)) return false;
      append({ op: 'drop-block', ns, hash: h, ...(projectScoped ? { projectId } : {}), at: now() });
      return true;
    },
    /**
     * Delete project: remove entries under this project; returns chunks no longer tracked by any
     * project (caller deletes them from data layer)
     */
    dropProject(projectId) {
      const gone = applyDropProject(projectId);
      append({ op: 'drop-project', projectId, at: now() });
      return gone;
    },
    /** Status (for diagnostics) */
    status() {
      return { service, capBytes: cap(), usedBytes: api.usedBytes(), reservedBytes: api.reservedBytes(), blocks: blocks.size, writable };
    },
    /** Compact log now (for unit tests) */
    compact,
    lineCount: () => lines,
  };
  return api;
}
