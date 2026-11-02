import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * "What state the machine is currently in" for troubleshooting.
 *
 * # Why the diagnostic report must include this section
 *
 * Previously, the chat diagnostics only had the chat itself. When a user reports "Agent can see assets
 * from other projects", the report showed what the model said and which tools it called, but not
 * **what justification it had for saying so**: was the media library empty at the time? Where was the
 * project stored? How many history records were lying in the backend session filing cabinet? None of
 * these were available, so neither possibility: "it is a product bug" or "it is an environment issue on
 * this machine": could be ruled out, leaving only guesswork.
 *
 * What is added here is that "original scene at the time".
 */

/** Maximum size limit for parsing a single session history file: only report size without opening if exceeded */
const PARSE_LIMIT = 8 * 1024 * 1024;
/** Maximum number of files to inspect in detail (newest to oldest): only count the rest */
const PARSE_COUNT = 20;

/** Default storage location for session history, must match the one in runners/api.mjs */
export function sessionStoreDir(tmp = os.tmpdir()) {
  return path.join(tmp, 'promptcut', 'harness-sessions');
}

/**
 * What is inside the backend session filing cabinet.
 *
 * Reports "how many records, how large, how recent, how many messages each", **without any chat content**:
 * judging "UI is empty while backend resumes old history" only requires counts, not reading those words.
 */
export function inspectSessionStore(dir = sessionStoreDir(), io = fs) {
  const out = { dir, exists: false, files: 0, totalBytes: 0, recent: [], note: '' };
  let names;
  try {
    names = io.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    out.note = 'Directory does not exist or cannot be read: no direct API session has been saved to disk on this machine yet';
    return out;
  }
  out.exists = true;
  out.files = names.length;

  const stated = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = io.statSync(full);
      out.totalBytes += st.size;
      stated.push({ name, full, bytes: st.size, modifiedAt: new Date(st.mtimeMs).toISOString(), mtimeMs: st.mtimeMs });
    } catch { /* Currently being written / already deleted, skip */ }
  }
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const f of stated.slice(0, PARSE_COUNT)) {
    const row = { sessionId: f.name.replace(/\.json$/, ''), bytes: f.bytes, modifiedAt: f.modifiedAt, messages: null, roles: null };
    if (f.bytes <= PARSE_LIMIT) {
      try {
        const arr = JSON.parse(io.readFileSync(f.full, 'utf8'));
        if (Array.isArray(arr)) {
          row.messages = arr.length;
          const tally = {};
          for (const m of arr) { const r = String(m?.role || '?'); tally[r] = (tally[r] || 0) + 1; }
          row.roles = tally;
        }
      } catch { row.messages = '(unreadable)'; }
    } else {
      row.messages = '(file too large, not opened)';
    }
    out.recent.push(row);
  }
  if (stated.length > PARSE_COUNT) out.note = `Only examined the latest ${PARSE_COUNT} in detail, ${stated.length} in total`;
  return out;
}

/** Current state of this Node process for the local service */
export function nodeStatus(proc = process, o = os) {
  const mem = proc.memoryUsage ? proc.memoryUsage() : {};
  const mb = (n) => (typeof n === 'number' ? Math.round(n / 1048576) : null);
  return {
    version: proc.version,
    v8: proc.versions?.v8,
    pid: proc.pid,
    // Whether the service was just restarted: this is the first thing to check for "fixed after restart" issues
    uptimeSeconds: Math.round(proc.uptime ? proc.uptime() : 0),
    startedAt: proc.uptime ? new Date(Date.now() - proc.uptime() * 1000).toISOString() : null,
    execPath: proc.execPath,
    cwd: typeof proc.cwd === 'function' ? proc.cwd() : null,
    memoryMB: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal), external: mb(mem.external) },
    tmpdir: o.tmpdir(),
    // When memory is nearly exhausted it behaves like "the model got dumber", which needs to be visible
    osMemoryMB: { total: mb(o.totalmem()), free: mb(o.freemem()) },
    cpus: o.cpus ? o.cpus().length : null,
    osRelease: o.release ? o.release() : null,
    // Packaged builds and running from source behave differently (paths, runtime location), clarify which one first
    packaged: !!proc.env?.PROMPTCUT_RUNTIME_ROOT || proc.env?.NODE_ENV === 'production',
  };
}
