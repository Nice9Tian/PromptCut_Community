/**
 * Desktop app session grouping in the AI panel (plan `docs/plan/agent-workflow-plan.md` A4; semantics
 * `user-workflow.md` "Agent connection type" "Progress visibility"): when the editor is opened, each
 * desktop app session is displayed individually, indicating the vendor and ongoing operation; progress
 * entries submitted by it via `report_progress` are displayed in the same manner as Agent progress
 * entries in the AI panel.
 *
 * Text output from desktop apps cannot be obtained by this software; only tool calls are recorded
 * here: who (session identity, vendor), what is running, what has run, and which progress reports
 * were submitted. The editor process (`server/vite-plugin-ai.ts`) calls `begin` / `end` before and
 * after each tool call in a desktop session, and pushes the entire snapshot to the page via SSE
 * (`agent.desktop`) on changes; the page fetches once via `GET /api/agent/desktop` upon connecting.
 *
 * Numbers [ruling]: each session retains the latest 20 calls and latest 30 progress reports; up to 16
 * sessions are tracked, discarding the least recently active when exceeded; sessions inactive for
 * 2 hours are no longer displayed. In-memory only, cleared when editor restarts (desktop sessions
 * reappear upon their next call).
 *
 * Does not depend on vite; tests call directly.
 */
import { validateProgressReport } from '../progress-report.mjs';

export const DESKTOP_ACTIVITY_LIMITS = Object.freeze({
  recentCalls: 20,
  reports: 30,
  sessions: 16,
  idleMs: 2 * 60 * 60 * 1000,
});

const REPORT_TOOL = 'report_progress';

/** One-line error in call results (rejection, failure) */
function errorText(out) {
  if (!out || typeof out !== 'object') return null;
  if (out.ok === false) return String(out.error || out.message || 'failed').slice(0, 300);
  return null;
}

/**
 * @param {{ now?: () => number, onChange?: () => void, limits?: Partial<typeof DESKTOP_ACTIVITY_LIMITS> }} [o]
 */
export function createDesktopActivity({ now = () => Date.now(), onChange = () => {}, limits: limitsIn = {} } = {}) {
  const L = { ...DESKTOP_ACTIVITY_LIMITS, ...limitsIn };
  /** Session key → record */
  const sessions = new Map();
  let seq = 0;

  function entry(key, info = {}) {
    let e = sessions.get(key);
    if (!e) {
      e = {
        id: key,
        vendor: null,
        label: null,
        client: null,
        firstSeen: now(),
        lastSeen: now(),
        calls: 0,
        /** Running calls: callSeq → { tool, since } */
        running: new Map(),
        recent: [],
        reports: [],
      };
    }
    if (typeof info.vendor === 'string' && info.vendor) e.vendor = info.vendor.slice(0, 64);
    if (typeof info.label === 'string' && info.label) e.label = info.label.slice(0, 64);
    if (info.client && typeof info.client === 'object') e.client = { name: String(info.client.name || '').slice(0, 64), version: String(info.client.version || '').slice(0, 32) };
    e.lastSeen = now();
    // Move to the end: Map order is the "most recently active" order, dropping from head when exceeded
    sessions.delete(key);
    sessions.set(key, e);
    while (sessions.size > L.sessions) sessions.delete(sessions.keys().next().value);
    return e;
  }

  return {
    /**
     * A call begins. Returns a handle to pass to `end`.
     * @param {string} key Session identity (`desk-…`)
     * @param {{ vendor?: string, label?: string, client?: object }} info
     * @param {string} tool
     * @param {unknown} args
     */
    begin(key, info, tool, args) {
      const e = entry(key, info);
      const id = ++seq;
      e.calls += 1;
      e.running.set(id, { tool: String(tool).slice(0, 64), since: now() });
      // Progress reports do not wait: counted as submitted once validated (reads call args like AI panel; rejected by server is not accepted here)
      if (tool === REPORT_TOOL) {
        const checked = validateProgressReport(args);
        if (checked.ok) {
          e.reports.push({ at: now(), report: checked.value });
          if (e.reports.length > L.reports) e.reports.splice(0, e.reports.length - L.reports);
        }
      }
      onChange();
      return { key, id };
    },

    /** A call ends. `out` is the tool result (`{ ok:false, error }` counts as failure), `err` is the thrown exception */
    end(handle, out, err) {
      const e = handle ? sessions.get(handle.key) : null;
      if (!e) return;
      const run = e.running.get(handle.id);
      e.running.delete(handle.id);
      e.lastSeen = now();
      const error = err ? String(err?.message || err).slice(0, 300) : errorText(out);
      e.recent.push({ tool: run?.tool ?? '?', ok: !error, ...(error ? { error } : {}), at: now(), ms: run ? now() - run.since : 0 });
      if (e.recent.length > L.recentCalls) e.recent.splice(0, e.recent.length - L.recentCalls);
      onChange();
    },

    /** Full snapshot for the page: most recently active first; omitted if inactive for too long */
    snapshot() {
      const t = now();
      return [...sessions.values()]
        .filter((e) => t - e.lastSeen <= L.idleMs || e.running.size > 0)
        .reverse()
        .map((e) => {
          const running = [...e.running.values()];
          const current = running.length ? running[running.length - 1] : null;
          return {
            id: e.id,
            vendor: e.vendor,
            label: e.label,
            client: e.client,
            firstSeen: e.firstSeen,
            lastSeen: e.lastSeen,
            calls: e.calls,
            current: current ? { tool: current.tool, since: current.since } : null,
            last: e.recent.length ? e.recent[e.recent.length - 1] : null,
            recent: e.recent.slice(),
            reports: e.reports.slice(),
          };
        });
    },

    has(key) {
      return sessions.has(key);
    },
  };
}
