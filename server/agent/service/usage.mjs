/**
 * Usage records (contract Section 6.3 in `docs/plan/cloud-agent-contract.md`).
 *
 *   usage/<yyyy-mm>.jsonl   One row per model request, append-only, 0600 (0640 when `shared`,
 *                           see below). Contains no prompts, responses, tool arguments, or Keys
 *   usage/totals.json       Totals (checkpoints) for each project and member: written
 *                           periodically and on exit; rebuilt on startup using this plus
 *                           subsequent logs, or recomputed from logs from scratch if corrupted
 *
 * Row shape:
 *   {"t":milliseconds,"projectId":"…","userId":"…","username":"…","conversationId":"…","runId":"…",
 *    "vendor":"…","model":"…","input":N,"output":N,"cacheRead":N,"ok":true,"ms":N}
 *
 * Billable external calls (voiceover etc., using host configuration) are also logged with one row
 * each, with four additional fields, token count is 0, and does not consume quota:
 *   {…same as above…,"kind":"service","service":"voice","units":N,"unit":"chars"}
 * `vendor` is the provider, `model` is its model; `units` is the count for this run (voiceover
 * is by character count). Listed separately under `services` in summaries, not mixed into model
 * call counts.
 *
 * Quota is calculated by "input plus output tokens" (`cacheRead` is already included in `input`,
 * used only for hit rate). Windows are in UTC: cumulative, current month, current day.
 *
 * Permissions: default directory 0700, files 0600 (readable only by the user that wrote it).
 * In account mode, the task process writes while the main service (`GET /v1/usage`) reads;
 * both are two system users in the same group: specify `shared: true` on creation, directory 0750,
 * logs 0640 (group read-only), and existing directories and logs are also made group-readable.
 * Totals checkpoint (`totals.json`) is used only by the writer, remaining 0600.
 * When logs cannot be read, the `strict` tier of `queryUsage` throws `usage-unreadable` instead of
 * faking "no usage" with an empty result.
 * This file does not import `src/`.
 */
import fs from 'node:fs';
import path from 'node:path';

const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function emptyBucket() {
  return { total: { tokens: 0, calls: 0 }, month: { key: '', tokens: 0, calls: 0 }, day: { key: '', tokens: 0, calls: 0 } };
}

function add(bucket, t, tokens) {
  bucket.total.tokens += tokens;
  bucket.total.calls += 1;
  const m = monthOf(t);
  if (bucket.month.key !== m) bucket.month = { key: m, tokens: 0, calls: 0 };
  bucket.month.tokens += tokens;
  bucket.month.calls += 1;
  const d = dayOf(t);
  if (bucket.day.key !== d) bucket.day = { key: d, tokens: 0, calls: 0 };
  bucket.day.tokens += tokens;
  bucket.day.calls += 1;
}

/**
 * Format a log row into the specified fields (extras are dropped: body text etc. are not saved
 * to disk here).
 */
export function usageRow(row, now = Date.now()) {
  return {
    t: Number.isFinite(row?.t) ? row.t : now,
    projectId: String(row?.projectId ?? ''),
    userId: String(row?.userId ?? ''),
    username: String(row?.username ?? ''),
    conversationId: String(row?.conversationId ?? ''),
    runId: String(row?.runId ?? ''),
    vendor: String(row?.vendor ?? ''),
    model: String(row?.model ?? ''),
    input: num(row?.input),
    output: num(row?.output),
    cacheRead: num(row?.cacheRead),
    ok: row?.ok !== false,
    ms: num(row?.ms),
    ...(row?.kind === 'service' ? {
      kind: 'service',
      service: String(row?.service ?? '').slice(0, 32),
      units: num(row?.units),
      unit: String(row?.unit ?? '').slice(0, 16),
    } : {}),
  };
}

/** Whether this row is an external service call (not a model request) */
const isServiceRow = (r) => r?.kind === 'service';

const unreadable = (what, error) => Object.assign(new Error(`usage-unreadable: ${what}`), { code: 'usage-unreadable', cause: error, errno: typeof error?.code === 'string' ? error.code : 'error' });

/**
 * Read complete lines from a log file starting from `from` bytes; returns `{ rows, bytes }`
 * (`bytes` is the end of the last complete line read). `strict`: throws if the file exists
 * but cannot be read, rather than treating it as empty.
 */
function readRows(file, from = 0, { strict = false } = {}) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (error) {
    if (strict && error?.code !== 'ENOENT') throw unreadable('file', error);
    return { rows: [], bytes: 0 };
  }
  if (from > buf.length) from = 0;
  const end = buf.lastIndexOf(0x0a);
  if (end < from) return { rows: [], bytes: from };
  const rows = [];
  for (const line of buf.subarray(from, end).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* Skip bad lines */ }
  }
  return { rows, bytes: end + 1 };
}

/**
 * `strict`: throws if directory exists but cannot be listed. If directory does not exist yet
 * (no task process has ever started on this node), it is "genuinely no logs", returns empty.
 */
function listFiles(dir, { strict = false } = {}) {
  try { return fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort(); } catch (error) {
    if (strict && error?.code !== 'ENOENT') throw unreadable('directory', error);
    return [];
  }
}

/**
 * Summarize logs by condition (for `GET /v1/usage` and `admin.mjs usage`, reads files, does not read
 * in-memory totals).
 * @param {string} dir `usage/` directory
 * @param {{ projectId?: string | null, since?: number | null, strict?: boolean }} [q] `strict`:
 *   throws `usage-unreadable` when log directory or file exists but cannot be read (used when
 *   reader and writer are not the same user: unreadable does not mean no usage)
 * @returns {{ calls: number, tokens: number, projects: Record<string, { tokens: number, calls: number, input: number, output: number,
 *   members: Record<string, { username: string, tokens: number, calls: number }>, models: Record<string, { tokens: number, calls: number }> }>, rows: object[] }}
 */
export function queryUsage(dir, { projectId = null, since = null, strict = false } = {}) {
  const out = { calls: 0, tokens: 0, projects: {}, rows: [] };
  const sinceMonth = Number.isFinite(since) ? monthOf(since) : null;
  for (const name of listFiles(dir, { strict })) {
    if (sinceMonth && name.slice(0, 7) < sinceMonth) continue;
    for (const r of readRows(path.join(dir, name), 0, { strict }).rows) {
      if (projectId && r.projectId !== projectId) continue;
      if (Number.isFinite(since) && !(r.t >= since)) continue;
      const tokens = num(r.input) + num(r.output);
      const p = (out.projects[r.projectId] ??= { tokens: 0, calls: 0, input: 0, output: 0, members: {}, models: {} });
      if (isServiceRow(r)) {
        // External service calls are listed separately: accumulate counts and units by "service / provider",
        // and accumulate counts by member separately.
        const sk = `${r.service}/${r.vendor}`;
        const sv = ((p.services ??= {})[sk] ??= { calls: 0, units: 0, unit: r.unit ?? '', members: {} });
        sv.calls += 1; sv.units += num(r.units);
        const sm = (sv.members[r.userId] ??= { username: r.username ?? '', calls: 0, units: 0 });
        sm.calls += 1; sm.units += num(r.units);
        out.rows.push(r);
        continue;
      }
      p.tokens += tokens; p.calls += 1; p.input += num(r.input); p.output += num(r.output);
      const m = (p.members[r.userId] ??= { username: r.username ?? '', tokens: 0, calls: 0 });
      m.tokens += tokens; m.calls += 1;
      const mk = `${r.vendor}/${r.model}`;
      const mo = (p.models[mk] ??= { tokens: 0, calls: 0 });
      mo.tokens += tokens; mo.calls += 1;
      out.calls += 1; out.tokens += tokens;
      out.rows.push(r);
    }
  }
  return out;
}

/**
 * @param {object} o
 * @param {string | null} o.dir `usage/` directory; when null, records in memory only (tests)
 * @param {boolean} [o.shared] logs need to be read by another user in the same group (account
 *   mode: task process writes, main service reads). See "Permissions" at file header
 */
export function createUsageLog({ dir = null, now = () => Date.now(), flushMs = 30_000, log = () => {}, shared = false } = {}) {
  const dirMode = shared ? 0o750 : 0o700;
  const rowsMode = shared ? 0o640 : 0o600;
  /**
   * When `shared`, make existing directories and logs group-readable (previously created as
   * 0700 / 0600; newly created ones may also lack permissions when process umask is stricter
   * than expected).
   */
  const share = (target, bits) => {
    if (!shared) return;
    try { const mode = fs.statSync(target).mode & 0o7777; if ((mode & bits) !== bits) fs.chmodSync(target, mode | bits); }
    catch (err) { log('agent.usage.share-failed', { message: String(err?.message ?? err).slice(0, 120) }); }
  };
  /** projectId → { ...bucket, members: Map(userId → bucket) } */
  const projects = new Map();
  /** Log filename → byte count already folded into totals */
  const offsets = {};
  let dirty = false;
  const totalsFile = dir ? path.join(dir, 'totals.json') : null;

  function fold(r) {
    if (isServiceRow(r)) return; // External service calls do not consume token quota and are not included in these totals (read from logs during summarization).
    const tokens = num(r.input) + num(r.output);
    const t = Number.isFinite(r.t) ? r.t : now();
    let p = projects.get(r.projectId);
    if (!p) { p = { ...emptyBucket(), members: new Map() }; projects.set(r.projectId, p); }
    add(p, t, tokens);
    let m = p.members.get(r.userId);
    if (!m) { m = emptyBucket(); p.members.set(r.userId, m); }
    add(m, t, tokens);
  }

  function rebuild(fromScratch) {
    if (!dir) return;
    if (fromScratch) { projects.clear(); for (const k of Object.keys(offsets)) delete offsets[k]; }
    for (const name of listFiles(dir)) {
      const { rows, bytes } = readRows(path.join(dir, name), offsets[name] ?? 0);
      for (const r of rows) fold(r);
      offsets[name] = bytes;
      // Previous process was killed midway while writing a line: an unfinished partial line remains at
      // the end. Append a newline to separate it (that partial line cannot be parsed and will be skipped),
      // so subsequent lines are not affected.
      try {
        const size = fs.statSync(path.join(dir, name)).size;
        if (size > bytes) { fs.appendFileSync(path.join(dir, name), '\n'); offsets[name] = size + 1; }
      } catch { /* File was just moved away */ }
    }
  }

  function loadTotals() {
    if (!totalsFile) return;
    let ok = false;
    try {
      const saved = JSON.parse(fs.readFileSync(totalsFile, 'utf8'));
      if (saved?.v === 1 && saved.files && typeof saved.files === 'object' && saved.projects && typeof saved.projects === 'object') {
        for (const [name, bytes] of Object.entries(saved.files)) {
          let size = -1;
          try { size = fs.statSync(path.join(dir, name)).size; } catch { /* File is gone */ }
          if (!Number.isSafeInteger(bytes) || bytes > size) throw new Error('Checkpoint is newer than the log');
          offsets[name] = bytes;
        }
        for (const [id, p] of Object.entries(saved.projects)) {
          projects.set(id, { total: p.total, month: p.month, day: p.day, members: new Map(Object.entries(p.members ?? {})) });
        }
        ok = true;
      }
    } catch (err) {
      if (fs.existsSync(totalsFile)) log('agent.usage.totals-rebuild', { reason: String(err?.message ?? err).slice(0, 80) });
    }
    rebuild(!ok);
  }

  function flush() {
    if (!totalsFile || !dirty) return;
    dirty = false;
    try {
      const body = { v: 1, at: now(), files: { ...offsets }, projects: {} };
      for (const [id, p] of projects) body.projects[id] = { total: p.total, month: p.month, day: p.day, members: Object.fromEntries(p.members) };
      const tmp = `${totalsFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(body), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, totalsFile);
    } catch (err) {
      log('agent.usage.flush-failed', { message: String(err?.message ?? err).slice(0, 120) });
    }
  }

  if (dir) {
    fs.mkdirSync(dir, { recursive: true, mode: dirMode });
    share(dir, 0o050);
    for (const name of listFiles(dir)) share(path.join(dir, name), 0o040);
    loadTotals();
  }
  const timer = dir ? setInterval(flush, flushMs) : null;
  timer?.unref?.();

  const usedOf = (bucket, window, at) => {
    if (!bucket) return 0;
    if (window === 'month') return bucket.month.key === monthOf(at) ? bucket.month.tokens : 0;
    if (window === 'day') return bucket.day.key === dayOf(at) ? bucket.day.tokens : 0;
    return bucket.total.tokens;
  };

  return {
    dir,

    /** Record a model request: write to log first, then add to totals */
    append(rowIn) {
      const row = usageRow(rowIn, now());
      if (dir) {
        const name = `${monthOf(row.t)}.jsonl`;
        const text = `${JSON.stringify(row)}\n`;
        try {
          const fresh = shared && !fs.existsSync(path.join(dir, name));
          fs.appendFileSync(path.join(dir, name), text, { encoding: 'utf8', mode: rowsMode });
          if (fresh) share(path.join(dir, name), 0o040);
          offsets[name] = (offsets[name] ?? 0) + Buffer.byteLength(text);
        } catch (err) {
          log('agent.usage.append-failed', { message: String(err?.message ?? err).slice(0, 120) });
        }
      }
      fold(row);
      dirty = true;
      return row;
    },

    /** How many tokens this project has used in this window */
    used(projectId, window = 'total', at = now()) {
      return usedOf(projects.get(projectId), window, at);
    },

    /**
     * Totals and per-member usage for this project: read logs if available (includes usernames,
     * respects `since`); if none (recorded only in memory), read in-memory totals.
     */
    summary(projectId, since = null) {
      if (dir) {
        const q = queryUsage(dir, { projectId, since }).projects[projectId];
        return {
          project: { tokens: q?.tokens ?? 0, calls: q?.calls ?? 0 },
          members: Object.entries(q?.members ?? {}).map(([userId, m]) => ({ userId, username: m.username, tokens: m.tokens, calls: m.calls })),
          services: Object.entries(q?.services ?? {}).map(([key, s]) => ({
            service: key.split('/')[0], vendor: key.split('/').slice(1).join('/'), calls: s.calls, units: s.units, unit: s.unit,
            members: Object.entries(s.members).map(([userId, m]) => ({ userId, username: m.username, calls: m.calls, units: m.units })),
          })),
        };
      }
      const p = projects.get(projectId);
      return {
        project: { tokens: p?.total.tokens ?? 0, calls: p?.total.calls ?? 0 },
        members: p ? [...p.members].map(([userId, m]) => ({ userId, tokens: m.total.tokens, calls: m.total.calls })) : [],
      };
    },

    flush,

    close() {
      if (timer) clearInterval(timer);
      flush();
    },
  };
}
