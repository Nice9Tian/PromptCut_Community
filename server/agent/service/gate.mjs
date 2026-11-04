/**
 * Gate (contract `docs/plan/cloud-agent-contract.md` Section 6): the single quota and concurrency
 * check through which all chats and model calls pass.
 *
 * Two entry points, taken by all paths:
 *   admitRun({ projectId, userId })               Before a round starts; occupies a concurrency
 *                                                 slot when admitted, returned by `release` on end
 *   admitModelCall({ projectId, userId, model })  Before each request to the model
 *     → { ok: true } | { ok: false, code: 'disabled' | 'busy' | 'quota-exceeded', message }
 *   record({ … })                                  Records a row of usage after each model request
 *                                                 (`usage.mjs`)
 *
 * Evaluation order: switch (`disabled`) → node concurrency, project concurrency, member concurrency
 * (`busy`) → quota (`quota-exceeded`).
 *
 * **Meaning of always admitting right now**: when `limits.json` does not exist, or
 * `defaults.limitTokens` is null and `projects` is empty, the quota step admits any project.
 * The three node-level concurrency counts are resource limits protecting co-located services;
 * they have numbers and do not count as "quota".
 *
 * `limits.json`(`<data directory>/config/limits.json`):
 *   { "v": 1,
 *     "node": { "maxRuns": 6, "maxRunsPerProject": 3, "maxRunsPerMember": 2, "maxInstances": 24 },
 *     "defaults": { "limitTokens": null, "window": "total", "maxRuns": null },
 *     "projects": { "<projectId>": { "limitTokens": 2000000, "window": "month", "maxRuns": 2 } } }
 * Before passing through the gate each time, check file mtime and size, and reread if changed; if
 * format is invalid, keep the previous one and log it. Publishing limit changes only modifies this
 * file, without code changes or restarts.
 * This file does not reference `src/`.
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

/** Verifies and fills in `limits.json` contents; throws if invalid (explaining what is wrong) */
export function normalizeLimits(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Not an object');
  if (raw.v !== undefined && raw.v !== 1) throw new Error(`Unknown version v=${raw.v}`);
  const node = { ...NODE_LIMIT_DEFAULTS };
  if (raw.node !== undefined) {
    if (!raw.node || typeof raw.node !== 'object' || Array.isArray(raw.node)) throw new Error('node is not an object');
    for (const k of Object.keys(NODE_LIMIT_DEFAULTS)) {
      if (raw.node[k] === undefined) continue;
      if (!posInt(raw.node[k])) throw new Error(`node.${k} must be a positive integer`);
      node[k] = raw.node[k];
    }
  }
  const one = (v, at) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${at} is not an object`);
    if (!nullOr(v.limitTokens, (x) => Number.isSafeInteger(x) && x >= 0)) throw new Error(`${at}.limitTokens must be a non-negative integer or null`);
    if (v.window !== undefined && !QUOTA_WINDOWS.includes(v.window)) throw new Error(`${at}.window must be one of ${QUOTA_WINDOWS.join(' / ')}`);
    if (!nullOr(v.maxRuns, posInt)) throw new Error(`${at}.maxRuns must be a positive integer or null`);
    return { limitTokens: v.limitTokens ?? null, window: v.window ?? 'total', maxRuns: v.maxRuns ?? null };
  };
  const defaults = raw.defaults === undefined ? { limitTokens: null, window: 'total', maxRuns: null } : one(raw.defaults, 'defaults');
  const projects = {};
  if (raw.projects !== undefined) {
    if (!raw.projects || typeof raw.projects !== 'object' || Array.isArray(raw.projects)) throw new Error('projects is not an object');
    for (const [id, v] of Object.entries(raw.projects)) {
      if (!PROJECT_ID_RE.test(id)) throw new Error(`Invalid project ID in projects: ${id.slice(0, 40)}`);
      // Fields not specified in this project entry follow defaults
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

/** Reads the file (for management commands): returns the empty copy if missing; throws if invalid */
export function readLimitsFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err?.code === 'ENOENT') return { v: 1 }; throw err; }
  const raw = JSON.parse(text);
  normalizeLimits(raw);
  return raw;
}

/** Writes the file (temp file plus rename, 0600) */
export function writeLimitsFile(file, raw) {
  normalizeLimits(raw);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, ...raw }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * @param {object} o
 * @param {string | null} [o.limitsFile] If omitted, there is no quota configuration (always admitted, concurrency uses default numbers)
 * @param {ReturnType<import('./usage.mjs').createUsageLog>} o.usage
 * @param {(projectId: string) => boolean} [o.isEnabled] "Cloud Agent" toggle for this project (always on before block Yi connects to document service push)
 * @param {object} [o.node] Overrides node-level concurrency counts (for testing)
 */
export function createGate({ limitsFile = null, usage, isEnabled = () => true, node: nodeOverride = null, now = () => Date.now(), log = () => {} } = {}) {
  if (!usage || typeof usage.append !== 'function') throw new TypeError('createGate: usage is required');
  let limits = EMPTY_LIMITS;
  let stamp = '';
  /** Active round: whole node, by project, by member */
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
      // Malformed: keep the previous copy, do not crash, neither loosen nor tighten
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
    return { ok: false, code: 'quota-exceeded', message: `This project's Cloud Agent quota is used up (used ${used} / limit ${pl.limitTokens}). Contact the host.`, used, limit: pl.limitTokens };
  }

  function enabled(projectId) {
    let on = true;
    try { on = isEnabled(projectId) !== false; } catch { on = true; }
    return on ? { ok: true } : { ok: false, code: 'disabled', message: 'The project creator has turned off the Cloud Agent.' };
  }

  return {
    /** Before a round starts. Occupies a slot when admitted; `release` must be called once afterwards */
    admitRun({ projectId, userId }) {
      reload();
      const e = enabled(projectId);
      if (!e.ok) return e;
      const n = nodeLimits();
      const pl = projectLimits(projectId);
      const busy = { ok: false, code: 'busy', message: 'The Cloud Agent is busy. Please try again later.' };
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

    /** Returns the slot (when a round ends, regardless of how it ended) */
    release({ projectId, userId }) {
      if (running > 0) running -= 1;
      bump(byProject, projectId, -1);
      bump(byMember, memberKey(projectId, userId), -1);
    },

    /** Before each request to the model */
    admitModelCall({ projectId }) {
      reload();
      const e = enabled(projectId);
      if (!e.ok) return e;
      return quota(projectId);
    },

    /** Records the usage of a model request */
    record(row) {
      return usage.append(row);
    },

    /** Quota and used amount for this project (for `GET /v1/info`) */
    quotaOf(projectId) {
      reload();
      const pl = projectLimits(projectId);
      return { tokens: usage.used(projectId, pl.window, now()), limitTokens: pl.limitTokens, window: pl.window };
    },

    nodeLimits() {
      reload();
      return nodeLimits();
    },

    /** Diagnostics: currently occupied slots */
    describe() {
      return { running, projects: Object.fromEntries(byProject), members: byMember.size };
    },
  };
}
