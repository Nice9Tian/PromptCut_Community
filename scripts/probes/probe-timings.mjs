/**
 * Shared timing records for probes (`docs/semantics/guide_files/verification.md` "Record durations
 * only, do not use as gates").
 *
 * Timing metrics (encoding time, load and tier-switch time, handshake time, round-trip latency,
 * etc.) are still measured and written to results, but do not determine pass/fail and do not affect
 * exit code. Probes change places that previously used time as pass condition to
 * `timings.record(name, value, { formerLimit })`, and call `timings.print()` before finishing:
 * standard output gets an extra line `TIMINGS {"probe":…,"timings":[…]}`, which acceptance runner
 * (`scripts/acceptance/`) collects into results.json and aggregates into
 * `docs/reports/release-timings.md` at release.
 *
 * Environment variable `PC_PROBE_TIMING_SCALE=<multiplier>`: multiplies each recorded number by
 * this factor (used only to prove time is no longer a gate: even set far beyond original gate, probe
 * still passes). Marked with `scaled` in record; such numbers do not enter release records.
 *
 * Starts no processes, touches no network; unit tests in `server/test/probe-timings.test.mjs`.
 */

export const TIMINGS_PREFIX = 'TIMINGS ';

/** Read PC_PROBE_TIMING_SCALE: recognized only if positive number, otherwise 1 */
export function timingScale(env = process.env) {
  const n = Number(env.PC_PROBE_TIMING_SCALE);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * @param {string} probe probe name
 * @param {{ scale?: number }} [opts] defaults to reading environment variable
 */
export function createTimings(probe, { scale = timingScale() } = {}) {
  const list = [];
  return {
    probe,
    list,
    /**
     * Record a duration metric, returning the recorded value (record null if measurement fails).
     * `formerLimit`: former gate (text, for documentation only); `unit` defaults to milliseconds.
     */
    record(name, value, { unit = 'ms', formerLimit = null, note = null } = {}) {
      const ok = typeof value === 'number' && Number.isFinite(value);
      const v = ok ? +(value * scale).toFixed(3) : null;
      list.push({ name, value: v, unit, ...(formerLimit ? { formerLimit } : {}), ...(note ? { note } : {}), ...(scale !== 1 ? { scaled: scale } : {}) });
      return v;
    },
    /** Merge in records brought back from elsewhere (child process result lines) */
    merge(items) { for (const t of items ?? []) if (t && typeof t.name === 'string') list.push(t); },
    line() { return TIMINGS_PREFIX + JSON.stringify({ probe, timings: list }); },
    print(log = console.log) { log(this.line()); },
  };
}

/** Extract all TIMINGS lines from output and flatten into [{ probe, name, value, unit, formerLimit?, note?, scaled? }] */
export function parseTimingLines(output) {
  const out = [];
  for (const raw of String(output).split(/\r?\n/)) {
    const l = raw.trim();
    if (!l.startsWith(TIMINGS_PREFIX)) continue;
    try {
      const v = JSON.parse(l.slice(TIMINGS_PREFIX.length));
      for (const t of v?.timings ?? []) if (t && typeof t.name === 'string') out.push({ probe: v.probe ?? null, ...t });
    } catch { /* Not a valid line, skip */ }
  }
  return out;
}
