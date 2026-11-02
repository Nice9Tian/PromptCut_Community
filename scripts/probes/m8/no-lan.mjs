/**
 * `--assert-no-lan <PC LAN address>` (`docs/plan/m8-plan.md` Section 2.3 "Remote hosted connection"):
 * proves that this end never traversed the LAN throughout.
 *
 * Read-only, modifies no settings (constraint "Leave host network untouched"):
 *   - **Baseline exclusion**: `startNoLanWatch` runs `netstat -an` once at the beginning, recording
 *     existing (local, foreign) pairs whose foreign address is this address (leftover `TIME_WAIT`,
 *     `CLOSE_WAIT`, etc. from previous runs are here), recorded only in `baseline` for troubleshooting
 *     and not counted;
 *   - Sampled every `everyMs` (default 2 s) thereafter, and sampled once more at `stop()`: TCP
 *     connections that appear with this address as foreign peer and are **not in the baseline**,
 *     **regardless of state** (`ESTABLISHED`, `TIME_WAIT`, `SYN_SENT`, `CLOSE_WAIT`...), are all
 *     counted, recording the maximum `maxTcp` and seen lines `seen` (at most 5 lines). Short-lived
 *     connections established and closed between two samples (e.g. a fast HTTP request), where only
 *     `TIME_WAIT` remains at the next sample, are still caught; counting only `ESTABLISHED` would
 *     miss them, which is exactly what "never traversed the LAN throughout" needs to catch;
 *   - At `stop()`, run a one-time LAN discovery once more (`discoverLan` in `server/lan/discovery.mjs`,
 *     default 3 s), recording the number of discovered hosts.
 * Only when both are 0 is it considered not using the LAN; split into `tcpOk` and `discoveryOk` for
 * callers to judge independently (when other programs on the LAN are broadcasting, a non-zero discovery
 * result does not mean this end connected to the LAN; keeping them separate clarifies this). Results
 * contain only counts and addresses, no credentials.
 * The pure functions for evaluation are `countNewTcpTo` and `judgeNoLanTcp` (unit test
 * `m8-no-lan.test.mjs`).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * A line of `netstat -an` → `{ proto, local, foreign, state }`; returns null if not a TCP line.
 * Column orders differ between Windows and Linux, so take the first two "address-like columns";
 * `state` takes the column after foreign (all uppercase letters and underscores), or null if none
 */
export function parseNetstatLine(line) {
  const cols = String(line).trim().split(/\s+/);
  if (!/^tcp/i.test(cols[0] ?? '')) return null;
  const addrs = cols.filter((c) => /[:.]\d+$/.test(c) && /\d/.test(c) && c !== cols[0]);
  if (addrs.length < 2) return null;
  const after = cols[cols.lastIndexOf(addrs[1]) + 1];
  const state = typeof after === 'string' && /^[A-Z][A-Z_0-9]*$/.test(after) ? after : null;
  return { proto: cols[0], local: addrs[0], foreign: addrs[1], state };
}

/** Whether the foreign address is this IPv4 (`a.b.c.d:port`, also recognizes IPv4-mapped `[::ffff:a.b.c.d]:port`) */
export function foreignIs(foreign, ip) {
  const f = String(foreign);
  return f.startsWith(`${ip}:`) || f.startsWith(`[::ffff:${ip}]:`);
}

/** Key for a connection's (local, foreign) pair */
export const pairKey = (l) => `${l.local}>${l.foreign}`;

/** Counts TCP lines in `netstat -an` output where foreign is `ip` (any state) */
export function countTcpTo(text, ip) {
  const lines = String(text).split(/\r?\n/).map(parseNetstatLine).filter(Boolean).filter((x) => foreignIs(x.foreign, ip));
  return { count: lines.length, lines };
}

/**
 * Baseline exclusion: TCP lines where foreign is `ip` and (local, foreign) is not in `baseline`,
 * counted regardless of state (`count` / `lines`); those in baseline go into `baselineLines`
 * (for troubleshooting only)
 * @param {string} text  Output of `netstat -an`
 * @param {string} ip
 * @param {Set<string>} baseline  `pairKey` set existing at startup
 */
export function countNewTcpTo(text, ip, baseline = new Set()) {
  const { lines: all } = countTcpTo(text, ip);
  const lines = all.filter((x) => !baseline.has(pairKey(x)));
  return { count: lines.length, lines, baselineLines: all.filter((x) => baseline.has(pairKey(x))) };
}

/** Evaluation logic: baseline was obtained, sampled at least once after baseline, and no connections outside baseline to this address were seen throughout (regardless of state) */
export function judgeNoLanTcp({ baselineOk = true, samples, maxTcp }) {
  return baselineOk === true && samples > 0 && maxTcp === 0;
}

function netstat() {
  const r = spawnSync('netstat', ['-an'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return { ok: r.status === 0 && typeof r.stdout === 'string', text: r.stdout ?? '', error: r.error ? String(r.error.message ?? r.error) : null };
}

/**
 * @param {string} ip  PC LAN address
 * @param {{ everyMs?: number, discoverMs?: number, log?: (event: string, fields: object) => void, netstat?: () => { ok: boolean, text: string }, discover?: boolean }} [o]
 *   `netstat` and `discover: false` are injected for unit tests only (unit tests do not perform real LAN discovery)
 */
export function startNoLanWatch(ip, { everyMs = 2000, discoverMs = 3000, log = () => {}, netstat: run = netstat, discover = true } = {}) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip ?? ''))) throw new TypeError(`--assert-no-lan needs an IPv4 address, got ${ip}`);
  const state = { ip, baselineOk: false, baseline: [], samples: 0, failedSamples: 0, maxTcp: 0, seen: [] };
  const baselineKeys = new Set();
  const describe = (l) => `${pairKey(l)}${l.state ? ` ${l.state}` : ''}`;
  const sample = () => {
    const n = run();
    if (!n.ok) { state.failedSamples += 1; return; }
    if (!state.baselineOk) {
      // The first retrieved netstat is the baseline: connections existing at that time are all prior to start
      for (const l of countTcpTo(n.text, ip).lines) {
        baselineKeys.add(pairKey(l));
        if (state.baseline.length < 20) state.baseline.push(describe(l));
      }
      state.baselineOk = true;
      return;
    }
    const { count, lines } = countNewTcpTo(n.text, ip, baselineKeys);
    state.samples += 1;
    if (count > state.maxTcp) state.maxTcp = count;
    for (const l of lines) {
      const key = describe(l);
      if (state.seen.length < 5 && !state.seen.includes(key)) state.seen.push(key);
    }
    if (count > 0) log('no-lan.tcp-seen', { ip, count });
  };
  sample();
  const timer = setInterval(sample, everyMs);
  timer.unref?.();
  return {
    /** Sample once immediately (used by unit tests; probe relies on timers) */
    sample,
    async stop() {
      clearInterval(timer);
      sample();
      let discovery;
      if (!discover) discovery = { hosts: null, skipped: true };
      else {
        try {
          const { discoverLan } = await import(pathToFileURL(path.join(ROOT, 'server/lan/discovery.mjs')).href);
          const d = await discoverLan({ timeoutMs: discoverMs });
          discovery = { hosts: d.hosts.length, interfaces: d.interfaces.length, sent: d.sent, errors: d.errors.length };
        } catch (error) {
          discovery = { hosts: null, error: String(error?.message ?? error) };
        }
      }
      return { ...state, discovery, tcpOk: judgeNoLanTcp(state), discoveryOk: discovery.hosts === 0 };
    },
  };
}
