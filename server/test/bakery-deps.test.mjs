/*
 * Gatekeeper test for dependency directions.
 *
 * Before rendering engine was moved from `scripts/export-frames.mjs` into `server/bakery/`, `server/`
 * and `scripts/` imported each other (`server/frame-pipeline.mjs` → `scripts/export-frames.mjs` →
 * `server/export-compose.mjs`), and there was also a runtime cycle between `export-frames.mjs` ↔
 * `export-unified.mjs`. Both have been fixed; pin them down here:
 *
 *   1. `server/**` no longer imports `scripts/**` (`scripts/` → `server/` one-way allowed);
 *   2. Internal import graph of `server/bakery/**` is acyclic.
 *
 * Run: `node --test server/test/bakery-deps.test.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SERVER = path.join(ROOT, 'server');
const BAKERY = path.join(SERVER, 'bakery');

/**
 * The only exceptions are tests that test scripts/ themselves, not production code depending on
 * scripts/:
 *
 *   - `bake-protocol.test.mjs` tests the command-line validation script
 *     `scripts/verify-bake-protocol.mjs`;
 *   - `dev-server-junction.test.mjs` tests that media junction in `scripts/lib/dev-server.mjs` only
 *     unlinks (unlinking incorrectly deletes user media, so it must stay in the baseline);
 *   - `probe-coord-mail.test.mjs` tests HTTP mailbox between two Agents in
 *     `scripts/probes/probe-coord.mjs` (authentication and long polling);
 *   - `m8-kit.test.mjs` tests criteria, KV conventions, and proxy control commands for M8 probe
 *     shared utilities in `scripts/probes/m8/` (M8 acceptance criteria rely on them, must stay in
 *     the baseline).
 *   - `m7-judge.test.mjs` tests criteria for M7 acceptance probes D1-D2-D12 in
 *     `scripts/probes/m7-judge.mjs` (grouped by emitted key, mid-flight takeover is informational
 *     only).
 *   - `m8-scale.test.mjs` tests task table, node ledger, and K1 / K2 / I1 / I2 criteria in
 *     `cloud/scripts/probes/m8-scale-probe.mjs` (M8 scale retest criteria rely on them).
 *   - `m8-no-lan.test.mjs` tests netstat parsing and counting in `scripts/probes/m8/no-lan.mjs` (M8
 *     "remote connection" requirement of "no LAN connection throughout" relies on it).
 *   - `no-user-dirs.test.mjs` tests media mirroring in `scripts/lib/user-dirs.mjs` and
 *     `dev-server.mjs`, and scans that probes strip external `PROMPTCUT_EXPORT_DIR` /
 *     `PROMPTCUT_DATA_DIR` first (tests and probes do not write to user Videos\PromptCut, must stay
 *     in the baseline);
 *   - `global-setup.mjs` (global setup for `npm test`, not production code) uses
 *     `scripts/lib/user-dirs.mjs` to strip the same two variables, sharing evaluation logic with
 *     probes.
 *   - `port-file.test.mjs` tests `markNoPortFile` in `scripts/lib/user-dirs.mjs`, and scans that
 *     probes launching the editor include `PROMPTCUT_NO_PORT_FILE=1` (tests and probes do not
 *     overwrite shared %TEMP%\promptcut\port.json, must stay in the baseline);
 *   - `asset-lan-discover.test.mjs` tests `scripts/probes/asset-lan-discover.mjs` (`asset-lan-probe`
 *     finds asset service address for local projects via LAN discovery);
 *   - `m8-judges.test.mjs` tests evaluation logic for `cloud-untouched` and `real:tasks` in
 *     `cloud/scripts/probes/m8/lib.mjs`.
 *   - `maint-3-claim-gate-judge.test.mjs` tests `scripts/probes/claim-gate-judge.mjs` (claim gate
 *     end-to-end probe criteria: multiple claims, Agent tasks not queued behind prerender).
 *   - `reopen-installed-lib.test.mjs` tests `cloud/scripts/probes/reopen-installed-lib.mjs`
 *     (evaluation of whether a launch counts in real install acceptance probe, checking installed
 *     builds against manifests);
 *   - `reopen-installed-state.test.mjs` tests `cloud/scripts/probes/reopen-installed-state.mjs`
 *     (backup, diff, and restore of install state) and `cloud/scripts/probes/reopen-sealed.mjs`
 *     (passphrase handoff between probes transferring only public keys and ciphertext).
 *   - `test-suite-policy.test.mjs` tests abnormal test process rerun evaluation in
 *     `scripts/test-suite-policy.mjs` and `scripts/test-event-reporter.mjs`.
 *   - `probe-timings.test.mjs` tests `scripts/probes/probe-timings.mjs` (shared duration logging
 *     utility for probes: elapsed time is only recorded, not used as gate) and its consistency with
 *     acceptance runner parsing of TIMINGS lines.
 *
 * Any additional entry must be explicitly written here; inability to add it indicates dependency
 * direction is truly broken.
 */
const ALLOWED_SCRIPT_IMPORTERS = new Set(['server/test/four-stage-acceptance.test.mjs', 'server/test/four-stage-acceptance-v18.test.mjs', 'server/test/probe-timings.test.mjs', 'server/test/wait-writes-quiet.test.mjs', 'server/test/bake-protocol.test.mjs', 'server/test/dev-server-junction.test.mjs', 'server/test/probe-coord-mail.test.mjs', 'cloud/server/test/m8-kit.test.mjs', 'cloud/server/test/m8-scale.test.mjs', 'server/test/m7-judge.test.mjs', 'server/test/m8-no-lan.test.mjs', 'server/test/no-user-dirs.test.mjs', 'server/test/global-setup.mjs', 'server/test/port-file.test.mjs', 'server/test/asset-lan-discover.test.mjs', 'cloud/server/test/m8-judges.test.mjs', 'server/test/maint-3-claim-gate-judge.test.mjs', 'cloud/server/test/reopen-installed-lib.test.mjs', 'cloud/server/test/reopen-installed-state.test.mjs', 'server/test/test-suite-policy.test.mjs',
  // Added on 2026-10-26: this item originally failed on main (tests introduced in f66874c5 referenced
  // cloud/scripts/render-host.mjs, not in the list); without this fix, this gatekeeper test would
  // fail on main and any branch
  'cloud/server/test/render-host-sweep.test.mjs']);

const CODE = /\.(mjs|mts|ts|tsx)$/;

function walk(dir, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file, out);
    else if (CODE.test(item.name)) out.push(file);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).replaceAll('\\', '/');

/** All module specifiers in a file: static import / export ... from, and import("…") */
function specifiersOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = [];
  for (const m of text.matchAll(/(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/gs)) found.push(m[1]);
  for (const m of text.matchAll(/(?:^|[^\w$.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]);
  for (const m of text.matchAll(/(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g)) found.push(m[1]);
  return found;
}

test('server/** does not import modules under scripts/', () => {
  const offenders = [];
  for (const file of walk(SERVER)) {
    const name = rel(file);
    if (ALLOWED_SCRIPT_IMPORTERS.has(name)) continue;
    for (const spec of specifiersOf(file)) {
      if (!spec.startsWith('.')) continue;
      const target = rel(path.resolve(path.dirname(file), spec));
      if (target.startsWith('scripts/')) offenders.push(`${name} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], 'The dependency direction can only be scripts/ → server/, not the reverse');
});

test('The server files on the list that are allowed to import scripts/ still exist', () => {
  // Community edition (public repo) does not include closed-source cloud/, nor internal release
  // acceptance checks (scripts/acceptance/ and the four unit tests testing it, see section 3 of
  // docs/plan/community-boundary.md); those items are naturally absent there, not considered stale
  const INTERNAL_ACCEPTANCE = new Set(['server/test/four-stage-acceptance.test.mjs', 'server/test/four-stage-acceptance-v18.test.mjs', 'server/test/probe-timings.test.mjs', 'server/test/wait-writes-quiet.test.mjs']);
  const hasCloud = fs.existsSync(path.join(ROOT, 'cloud'));
  const hasAcceptance = fs.existsSync(path.join(ROOT, 'scripts', 'acceptance'));
  for (const name of ALLOWED_SCRIPT_IMPORTERS) {
    if ((!hasCloud && name.startsWith('cloud/')) || (!hasAcceptance && INTERNAL_ACCEPTANCE.has(name))) continue;
    assert.ok(fs.existsSync(path.join(ROOT, name)), `${name} no longer exists, please remove it from the list`);
  }
});

test('The import graph inside server/bakery/** has no cycles', () => {
  /** File → modules in the same directory (or subdirectory) that it imports */
  const graph = new Map();
  for (const file of walk(BAKERY)) {
    const edges = [];
    for (const spec of specifiersOf(file)) {
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (target.startsWith(BAKERY)) edges.push(rel(target));
    }
    graph.set(rel(file), edges);
  }
  assert.ok(graph.size > 0, 'server/bakery should contain modules');

  const state = new Map(); // Unvisited / 1 on stack / 2 completed
  const cycles = [];
  const visit = (node, stack) => {
    if (state.get(node) === 2) return;
    if (state.get(node) === 1) {
      cycles.push([...stack.slice(stack.indexOf(node)), node].join(' → '));
      return;
    }
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) || []) visit(next, stack);
    stack.pop();
    state.set(node, 2);
  };
  for (const node of graph.keys()) visit(node, []);
  assert.deepEqual(cycles, [], 'No runtime import cycles are allowed inside server/bakery');
});
