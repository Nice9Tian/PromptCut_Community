/**
 * Session diagnostics and session log throttling for node endpoints
 * (`docs/archive/agent-reports/AGENT-host-diag.md`; contract
 * `docs/plan/http-transport-contract.md` sections 8 and 9).
 *
 * Connections from queue nodes (local nodes in the desktop prerender process, standalone render
 * hosts) to the document service are `createDocEndpoint` sessions (`session-link.mjs`). Chaos
 * testing (network disconnects, server restarts, proxy packet loss, session resumes after transport
 * interruptions) needs to determine from diagnostics "how many resumes, how many drops, whether
 * the session was rebuilt", so:
 *   - `sessionCountersOf(endpoint)`: extracts session counters from `stats()` for the `session`
 *     field of each node in `/api/frames/queue`;
 *   - `createLogThrottle()`: session event log throttling that only outputs the first few entries
 *     for the same event within a window and counts the rest, including `suppressed` with the next
 *     emitted entry (during network outages, every backoff logs `session.connect-failed` /
 *     `session.retry`, which must not spam the screen);
 *   - `SESSION_FORWARD_EVENTS`: session events that enter the log.
 *
 * Provides only counters, close codes, and close reasons; does not provide session IDs, query
 * strings in URLs, or any credentials (logs in `session-link.mjs` already omit these).
 */

/** Session events entering prerender process logs (and forwarded by the editor process) */
export const SESSION_FORWARD_EVENTS = Object.freeze(new Set([
  'session.open',
  'session.close',
  'session.detach',
  'session.resume',
  'session.lost',
  'session.expired',
  'session.connect-failed',
  'session.resume-failed',
  'session.backpressure',
  'session.bad-seq',
  'session.bad-ack',
]));

const num = (v) => (Number.isFinite(v) ? v : 0);

/**
 * Endpoint session counters (`createDocEndpoint().stats()`; items missing from legacy endpoints
 * are set to 0 / null).
 *   opens: established sessions (including rebuilds), resumes: resumes, detaches: detaches,
 *   renews: rebuilds (re-established after previous session ended),
 *   lost: resume rejected (session no longer exists on server),
 *   expired: client-determined retention expired, connectFails: failed to establish new session,
 *   closes: session ended, dropped: discarded outbound messages, lastClose `{ code, reason, at }`,
 *   lastDetach `{ code, at }`.
 * Returns null if `stats()` is missing.
 */
export function sessionCountersOf(endpoint) {
  const st = typeof endpoint?.stats === 'function' ? endpoint.stats() : null;
  if (!st) return null;
  const lastClose = st.lastClose && typeof st.lastClose === 'object'
    ? { code: num(st.lastClose.code), reason: String(st.lastClose.reason ?? '').slice(0, 120), at: num(st.lastClose.at) || null }
    : null;
  const lastDetach = st.lastDetach && typeof st.lastDetach === 'object'
    ? { code: num(st.lastDetach.code), at: num(st.lastDetach.at) || null }
    : null;
  return {
    opens: num(st.opens),
    resumes: num(st.resumes),
    detaches: num(st.detaches),
    renews: num(st.renews),
    lost: num(st.lost),
    expired: num(st.expired),
    connectFails: num(st.connectFails),
    closes: num(st.closes),
    dropped: num(st.dropped),
    detached: st.detached === true,
    lastClose,
    lastDetach,
  };
}

/**
 * Session section in node diagnostics: `transport` (null when detached), `resumes`, `legacy`
 * (present since HT-a, read by probes), plus `session` (counters above).
 */
export function sessionDiagOf(endpoint) {
  const st = typeof endpoint?.stats === 'function' ? endpoint.stats() : null;
  if (!st) return {};
  return { transport: st.transport ?? null, resumes: num(st.resumes), legacy: st.legacy === true, session: sessionCountersOf(endpoint) };
}

/**
 * Log throttle: each key allows at most `burst` entries within `windowMs`. `take(key)` returns
 * `null` (do not log this entry) or `{ suppressed }` (log, where `suppressed` is the number of
 * entries suppressed for this key since the last logged entry). Windows are counted independently
 * per key starting from the first entry.
 */
export function createLogThrottle({ burst = 5, windowMs = 60_000, now = Date.now } = {}) {
  const keys = new Map();
  return {
    take(key) {
      const t = now();
      let k = keys.get(key);
      if (!k || t - k.start >= windowMs) {
        const suppressed = k ? k.suppressed : 0;
        k = { start: t, count: 0, suppressed: 0 };
        keys.set(key, k);
        k.count = 1;
        return { suppressed };
      }
      if (k.count < burst) {
        k.count++;
        const suppressed = k.suppressed;
        k.suppressed = 0;
        return { suppressed };
      }
      k.suppressed++;
      return null;
    },
    /** Number of entries currently suppressed for each key and not yet emitted with the next entry */
    pending() {
      const out = {};
      for (const [key, k] of keys) if (k.suppressed > 0) out[key] = k.suppressed;
      return out;
    },
  };
}

/**
 * Session logger for `createDocEndpoint({ log })`: only logs events in `SESSION_FORWARD_EVENTS`,
 * throttled per event, written to `write(event, fields)` (includes `extra` field; includes
 * `suppressed` if previously suppressed).
 */
export function sessionLogger(write, { extra = {}, throttle = createLogThrottle(), events = SESSION_FORWARD_EVENTS } = {}) {
  return (event, fields = {}) => {
    if (!events.has(event)) return;
    const got = throttle.take(event);
    if (!got) return;
    write(event, { ...extra, ...fields, ...(got.suppressed > 0 ? { suppressed: got.suppressed } : {}) });
  };
}

/**
 * Session event lines in prerender process output: `[queue-node] docservice.session.<event> {…}`
 * or `[artifact-push] docservice.session.<event> {…}`
 */
export const SESSION_LINE_RE = /^\[(?:queue-node|artifact-push)\] docservice\.(session\.[a-z-]+)\b/;

/**
 * Per-task finalization lines in prerender process output
 * (`docs/archive/agent-reports/AGENT-stall-phases.md`):
 * `[queue-node] node.task-<lost|failed|superseded|discarded|completed|dedup> {…}`,
 * `[queue-node] sink.incomplete {…}` when the artifact store did not receive everything
 * (`taskEventLog` in `vite-plugin-frames.ts`, `put` in `artifact-transfer.mjs`),
 * as well as `sink.has-miss` (why deduplication was skipped) / `sink.has-pushed` /
 * `sink.has-push-failed` in the artifact store deduplication step, and `manifest.get-failed` /
 * `manifest.put-failed` on read/write errors for content store manifests (`has` and `writeManifest`
 * in `artifact-transfer.mjs`; `docs/archive/agent-reports/AGENT-xnode-dedup.md`).
 * Also includes segment render timing for queue fine-grained tasks `executor.render-timing`
 * (`prerender-executor.mjs`; `docs/archive/agent-reports/AGENT-uc-latency.md`).
 * These lines only contain task id, reason, phase, and milliseconds; they do not contain
 * session IDs or credentials.
 */
export const TASK_LINE_RE = /^\[queue-node\] (node\.task-(?:lost|failed|superseded|discarded|completed|dedup)|sink\.(?:incomplete|has-miss|has-pushed|has-push-failed)|manifest\.(?:get|put)-failed|executor\.render-timing)\b/;

/**
 * Start/stop lines for auto render nodes (`docs/archive/agent-reports/AGENT-desktop-auto-node.md`):
 * `[queue-node] render-node.<event> {…}` (handoff, start/stop, catch-up push, waiting for page),
 * reasons why the node did not start `[queue-node] queue.skip {…}`, and push queue creation / skip
 * / asset service selection `[artifact-push] push.(started|skip|asset-base) {…}`. Users on the
 * installed version can only provide editor process logs; "whether this desktop became a render
 * node and which asset service it pushed to" must be visible there. Lines only contain document
 * service / asset service addresses and project ids, without tickets.
 */
export const AUTO_NODE_LINE_RE = /^\[(?:queue-node\] (render-node\.[a-z-]+|queue\.skip)|artifact-push\] (push\.(?:started|skip|asset-base|asset-ready|scope|out-of-scope|rescope)))\b/;

/**
 * Forwards session event lines in subprocess output line by line (used by the editor process to
 * receive stdout / stderr from the prerender process). Chunks may split in the middle of a line,
 * leaving incomplete tails for the next chunk; individual lines exceeding `maxLine` characters are
 * truncated. The source (prerender process) already throttles per event; an extra fallback layer is
 * applied here: at most `burst` lines per window for each event type, and suppressed counts are
 * emitted with the next line (` (suppressed N)` at the end of the line).
 * Per-task finalization lines (`TASK_LINE_RE`) go through a separate `taskThrottle` (60 lines per
 * minute for each type): dozens of tasks in a single round should not be suppressed by the session
 * event quota.
 * Returns `(chunk) => void`.
 */
export function createSessionLineForwarder(write, {
  throttle = createLogThrottle({ burst: 10, windowMs: 60_000 }), maxLine = 2000, re = SESSION_LINE_RE,
  taskRe = TASK_LINE_RE, taskThrottle = createLogThrottle({ burst: 60, windowMs: 60_000 }), autoRe = AUTO_NODE_LINE_RE,
} = {}) {
  let tail = '';
  return (chunk) => {
    const text = tail + String(chunk);
    const lines = text.split(/\r?\n/);
    tail = lines.pop() ?? '';
    if (tail.length > maxLine * 4) tail = '';
    for (const raw of lines) {
      const m = re.exec(raw);
      const t = m ? null : (taskRe ? taskRe.exec(raw) : null);
      const a = m || t || !autoRe ? null : autoRe.exec(raw);
      if (!m && !t && !a) continue;
      const got = m ? throttle.take(m[1]) : t ? taskThrottle.take(t[1]) : taskThrottle.take(a[1] ?? a[2]);
      if (!got) continue;
      const line = raw.length > maxLine ? `${raw.slice(0, maxLine)}…` : raw;
      write(got.suppressed > 0 ? `${line} (suppressed ${got.suppressed})` : line);
    }
  };
}

/**
 * Session status line for standalone render hosts (`cloud/scripts/render-host.mjs`): extracts the
 * session portion of each node from the `/api/frames/queue` result.
 * Returns `{ key, status }`: `status` is the content of the `[render-host] session {…}` line
 * (`nodes: [{ projectId, nodeId, connected, transport, session }]`), and `key` consists only of
 * counters and the last close code: it changes only when counters change, so the host logs a line
 * only when there is a change.
 */
export function sessionStatusOf(summary) {
  const nodes = Array.isArray(summary?.nodes) ? summary.nodes : [];
  const status = {
    nodes: nodes.map((n) => ({
      projectId: n?.projectId ?? null,
      nodeId: n?.nodeId ?? null,
      connected: n?.connected === true,
      transport: n?.transport ?? null,
      session: n?.session ?? null,
    })),
  };
  const key = JSON.stringify(status.nodes.map((n) => {
    const s = n.session;
    return s ? [n.projectId, s.opens, s.resumes, s.detaches, s.renews, s.lost, s.expired, s.connectFails, s.closes, s.dropped, s.detached, s.lastClose?.code ?? null]
      : [n.projectId, null];
  }));
  return { key, status };
}
