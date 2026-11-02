/**
 * End-to-end probe for render queue: connects to document service via real WebSocket, runs
 * a round of dummy tasks as publisher, render node, or both. Can run half on each of two
 * machines (one with --role publisher, the other with --role node).
 * Basis: `docs/plan/render-queue-contract.md` G.8.
 *
 * Run:
 *   node scripts/probes/render-queue-e2e.mjs --url <ws://...> --role publisher|node|both
 *     [--tasks 50] [--project <id>] [--node-id <id>] [--task-ms 200] [--max-concurrent 2]
 *     [--exit-after-claim] [--announce <http-url>] [--watch-endpoints] [--timeout-ms 120000] [--transport auto|ws]
 *
 * Credentials (M6a, `docs/plan/auth-contract.md` sections 5 and 11; cluster token has been retired
 * from data plane, this probe no longer reads it):
 * - PROMPTCUT_SHARED_CONFIG environment variable is set (shared project config JSON): takes first
 *   entry, enters with project proof, node connection uses `render` role, publisher connection uses
 *   `page` role; fetches challenge anew before each (re)connection. All tasks are in this shared
 *   project's namespace;
 * - Not set: unauthenticated, uses local identity (`local` namespace) when connecting to local
 *   loopback, connecting to other machines gets 401.
 * `--announce` is admin interface (service address registration): local identity can register,
 * shared project members will be rejected (forbidden).
 * Passphrase, derived keys, and proofs in config are never printed.
 *
 * - node role: createLocalNode + createDocEndpoint (session, HT-a); executor sleeps for --task-ms,
 *   output store uses in-memory version (reuses mock files from server/test/: probe is not
 *   production code). At the same time queue.watch: observes time t1 when another claimed a task
 *   (task.taken), time t2 when claiming the same task itself, takeovers records t2 - t1 (both
 *   timestamps use local clock).
 *   --exit-after-claim: exits immediately after first successful claim, exit code 3 (tests
 *   "clean disconnect").
 *   --announce: registers this address as this node after connecting (service.announce, kind
 *   is render-node).
 *   --watch-endpoints: subscribes to all service addresses, outputs endpoints at the end.
 *   When running node role alone, runs continuously until --timeout-ms or Ctrl+C, then outputs results.
 * - publisher role: publisher.hello, publishes --tasks dummy fine-grained tasks (kind snapshot, tier
 *   shared, random result key, with run id), counts task.done (records completion on first appearance
 *   of each id, duplicates thereafter); when seeing epoch change or upon reconnecting, republishes
 *   unfinished tasks (publish is idempotent). Completes when all are done; fails if not finished by
 *   --timeout-ms.
 * - both: runs both in the same process (two connections).
 *
 * Output: last line JSON
 *   { ok, role, url, epochs, published, completed, duplicateDone, claims, claimsById,
 *     doneLatencyMs: { p50, p95 }, takeovers: [{ id, ms }], endpoints?, sessions, fails }
 *   `sessions`: transport actually used by each connection, resume count, whether connected to old
 *   server without session layer (session id omitted).
 *
 * Transport (contract `docs/plan/http-transport-contract.md` section 4.3 rule 6): connection is
 * a session (`createDocEndpoint`).
 * `--transport` is a developer override flag; if omitted, reads environment variable
 * `PROMPTCUT_TRANSPORT`, defaulting to auto (auto in HT-a means WebSocket);
 * `ws` uses WebSocket only; `http` is not enabled in HT-a (exit code 2). `--url` accepts ws(s)://
 * or http(s)://.
 * Exit codes: 0 all passed; 1 assertion failure; 2 connection failure (or invalid arguments);
 * 3 expected exit for --exit-after-claim.
 */
import { randomBytes } from 'node:crypto';

const USAGE = `Usage: node scripts/probes/render-queue-e2e.mjs --url <ws://…> --role publisher|node|both
  [--tasks 50] [--project <id>] [--node-id <id>] [--task-ms 200] [--max-concurrent 2]
  [--exit-after-claim] [--announce <http-url>] [--watch-endpoints] [--timeout-ms 120000] [--transport auto|ws]
Credentials are read from the shared project config that the environment variable PROMPTCUT_SHARED_CONFIG points to; if it is not set, the local identity is used (it can only connect to the local loopback).`;

function usage(msg) {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

const FLAGS = new Set(['--exit-after-claim', '--watch-endpoints']);
const VALUED = new Set(['--url', '--role', '--tasks', '--project', '--node-id', '--task-ms', '--max-concurrent', '--announce', '--timeout-ms', '--transport']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) { out[a.slice(2)] = true; continue; }
    if (VALUED.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) usage(`${a} is missing a value`);
      out[a.slice(2)] = v;
      continue;
    }
    if (a === '--token') usage('The cluster token is no longer used for the data plane; shared project credentials are read from the environment variable PROMPTCUT_SHARED_CONFIG');
    usage(`Unknown argument: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.url || !args.role) usage(process.argv.length > 2 ? 'Missing --url or --role' : undefined);
if (!['publisher', 'node', 'both'].includes(args.role)) usage(`--role must be publisher, node, or both, got ${args.role}`);
const intArg = (name, dflt, min = 0) => {
  if (args[name] === undefined) return dflt;
  const n = Number(args[name]);
  if (!Number.isInteger(n) || n < min) usage(`--${name} must be an integer not less than ${min}`);
  return n;
};
const url = args.url;
if (!/^(wss?|https?):\/\//.test(url)) usage('--url must be ws(s):// or http(s)://');
const role = args.role;
const taskCount = intArg('tasks', 50, 1);
const taskMs = intArg('task-ms', 200, 0);
const maxConcurrent = intArg('max-concurrent', 2, 1);
const timeoutMs = intArg('timeout-ms', 120_000, 1);
const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const projectId = args.project ?? `probe-${runId}`;
const nodeId = args['node-id'] ?? `probe-node-${process.pid}`;
let sharedEntry = null;
let sharedProtocols = null;
if (process.env.PROMPTCUT_SHARED_CONFIG) {
  try {
    const mod = await import(new URL('../../server/auth/shared-config.mjs', import.meta.url));
    [sharedEntry] = mod.loadSharedConfig();
    sharedProtocols = mod.sharedProtocols;
  } catch (error) {
    usage(String(error?.message ?? error));
  }
}
if (args.announce !== undefined) {
  try { new URL(args.announce); } catch { usage('--announce must be an http(s):// address'); }
}

// Dynamically import module under test and mock files on demand:
// print usage only when arguments are invalid, without crashing due to missing modules
const here = new URL('.', import.meta.url);
const [{ createDocEndpoint, transportOf }, { watchServiceEndpoints }, { createLocalNode }, { createArtifactSink }, { createSleepExecutor, snapshotTaskInput }] = await Promise.all([
  import(new URL('../../server/render-node/session-link.mjs', here)),
  import(new URL('../../server/render-node/endpoint.mjs', here)),
  import(new URL('../../server/render-node/local-node.mjs', here)),
  import(new URL('../../server/test/fake-artifact-sink.mjs', here)),
  import(new URL('../../server/test/fake-ws-kit.mjs', here)),
]);

let transportOption = {};
if (args.transport !== undefined) {
  try { transportOption = { transport: transportOf(args.transport, undefined) }; } catch (error) { usage(`--transport ${args.transport}: ${error?.message ?? error}`); }
}

const log = (event, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
const result = {
  ok: false, role, url, epochs: [], published: 0, completed: 0, duplicateDone: 0,
  claims: 0, claimsById: {}, doneLatencyMs: { p50: null, p95: null }, takeovers: [], fails: [],
};
if (args['watch-endpoints']) result.endpoints = [];
const latencies = [];
const endpoints = [];
const timers = [];
let finished = false;

function noteEpoch(message) {
  if (typeof message?.epoch === 'string' && result.epochs.at(-1) !== message.epoch && !result.epochs.includes(message.epoch)) {
    result.epochs.push(message.epoch);
    return true;
  }
  return false;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function finish(code) {
  if (finished) return;
  finished = true;
  for (const t of timers) clearInterval(t);
  const sorted = [...latencies].sort((a, b) => a - b);
  result.doneLatencyMs = { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
  if (code === undefined) code = result.fails.length === 0 ? 0 : 1;
  result.ok = code === 0;
  process.exitCode = code;
  result.sessions = endpoints.map((ep) => {
    const s = ep.stats();
    return { mode: s.mode ?? null, transport: s.transport ?? null, resumes: s.resumes ?? 0, fallbacks: s.fallbacks ?? 0, legacy: s.legacy === true, opens: s.opens ?? 0 };
  });
  // Wait for active connections to close cleanly (at most CLOSE_WAIT_MS) before exiting:
  // calling process.exit before close handshake completes causes libuv on Windows to assert
  // UV_HANDLE_CLOSING and crash (consistently reproduces against remotes)
  closeEndpoints().then(() => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(code));
  });
}

const CLOSE_WAIT_MS = 3_000;
/** Close all connections; wait for active ones until onClose, at most CLOSE_WAIT_MS. */
function closeEndpoints() {
  const waits = [];
  for (const ep of endpoints) {
    if (ep.connected) waits.push(new Promise((resolve) => ep.onClose(resolve)));
    try { ep.close(); } catch { /* Closed */ }
  }
  if (waits.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, CLOSE_WAIT_MS);
    Promise.all(waits).then(() => { clearTimeout(t); resolve(); });
  });
}

function openEndpoint(label) {
  // Shared project: node connection is render, publisher connection is page
  // (node.hello only allows render connections)
  const protocols = sharedEntry ? sharedProtocols(sharedEntry, { role: label === 'node' ? 'render' : 'page' }) : undefined;
  const ep = createDocEndpoint({ url, ...(protocols ? { protocols } : {}), ...transportOption, log: (event, fields) => log(`${label}.${event}`, fields) });
  endpoints.push(ep);
  ep.onOpen(() => log(`${label}.open`, { opens: ep.stats().opens }));
  ep.onClose((info) => log(`${label}.close`, info));
  return ep;
}

// ---------------------------------------------------------------- Publisher

function runPublisher() {
  const ep = openEndpoint('publisher');
  const publisherId = `probe-pub-${runId}`;
  const tasks = Array.from({ length: taskCount }, (_, i) => snapshotTaskInput({
    resultKey: `probe-${runId}-${i}`, from: 0, to: 29, projectId, weight: 'light',
  }));
  const firstPublishAt = new Map();
  const doneAt = new Map();
  let seq = 0;

  function publishPending(why) {
    const pending = tasks.filter((t) => !doneAt.has(t.id));
    if (pending.length === 0) return;
    const at = Date.now();
    for (const t of pending) if (!firstPublishAt.has(t.id)) firstPublishAt.set(t.id, at);
    result.published = firstPublishAt.size;
    ep.send({ type: 'task.publish', reqId: `pub-${++seq}`, tasks: pending });
    log('publisher.publish', { why, count: pending.length });
  }

  ep.onOpen(() => {
    ep.send({ type: 'publisher.hello', reqId: `hello-${seq}`, publisherId });
    publishPending('open');
  });
  let lastEpoch = null;
  ep.onMessage((m) => {
    noteEpoch(m);
    if (typeof m.epoch === 'string' && m.epoch !== lastEpoch) {
      const changed = lastEpoch !== null;
      lastEpoch = m.epoch;
      if (changed) {
        log('publisher.epoch-changed', { epoch: m.epoch });
        publishPending('epoch');
      }
    }
    if (m.type === 'task.published') {
      for (const r of m.results ?? []) if (r.error) result.fails.push(`publish ${r.id}: ${r.error}`);
    } else if (m.type === 'task.done') {
      if (!firstPublishAt.has(m.id)) return; // Not from this round
      if (doneAt.has(m.id)) { result.duplicateDone += 1; return; }
      doneAt.set(m.id, Date.now());
      result.completed = doneAt.size;
      latencies.push(Date.now() - firstPublishAt.get(m.id));
      if (doneAt.size === tasks.length) {
        log('publisher.all-done', { completed: doneAt.size });
        // Wait a moment before finalizing, to catch late duplicate completions
        setTimeout(() => finish(), 300);
      }
    } else if (m.type === 'task.failed') {
      result.fails.push(`task.failed ${m.id}: ${m.error}`);
    } else if (m.type === 'error') {
      result.fails.push(`error ${m.reason}: ${m.detail ?? ''}`);
    }
  });
  return ep;
}

// ---------------------------------------------------------------- Render node

function runNode() {
  const ep = openEndpoint('node');
  const takenAt = new Map();
  const node = createLocalNode({
    nodeId,
    node: { profile: 'host', envFingerprint: 'probe-env', codeVersions: [], capabilities: {} },
    endpoint: ep,
    now: Date.now,
    maxConcurrent,
    executor: createSleepExecutor({ taskMs }),
    sink: createArtifactSink(),
    onEvent: (e) => {
      if (e.type === 'failed') result.fails.push(`node failed ${e.id}: ${e.error}`);
      if (e.type === 'lost' || e.type === 'failed' || e.type === 'completed' || e.type === 'dedup') log(`node.${e.type}`, { id: e.id, reason: e.reason });
    },
  });
  ep.onOpen(() => {
    node.start(node.session.held().map(({ id, token: tk }) => ({ id, token: tk })));
    if (args.announce) ep.send({ type: 'service.announce', announcerId: nodeId, kind: 'render-node', urls: [args.announce] });
  });
  ep.onMessage((m) => {
    noteEpoch(m);
    if (m.type === 'task.taken') {
      takenAt.set(m.id, Date.now());
    } else if (m.type === 'task.claimed') {
      const at = Date.now();
      result.claims += 1;
      result.claimsById[m.id] = (result.claimsById[m.id] ?? 0) + 1;
      if (takenAt.has(m.id)) {
        result.takeovers.push({ id: m.id, ms: at - takenAt.get(m.id) });
        takenAt.delete(m.id);
      }
      if (args['exit-after-claim']) {
        log('node.exit-after-claim', { id: m.id });
        finish(3);
      }
    } else if (m.type === 'error' && m.reason !== 'not-registered') {
      result.fails.push(`error ${m.reason}: ${m.detail ?? ''}`);
    }
  });
  if (args['watch-endpoints']) watchServiceEndpoints(ep, 'all', (list) => { result.endpoints = list; });
  timers.push(setInterval(() => { try { node.tick(); } catch (err) { log('node.tick-error', { message: String(err?.message ?? err) }); } }, 50));
  return ep;
}

// ---------------------------------------------------------------- Main flow

log('start', { role, url, runId, projectId, nodeId, tasks: taskCount, credential: sharedEntry ? 'shared-project' : 'none' });
const eps = [];
if (role === 'publisher' || role === 'both') eps.push(runPublisher());
if (role === 'node' || role === 'both') eps.push(runNode());

const connectDeadline = Math.min(timeoutMs, 15_000);
const connectCheck = setTimeout(() => {
  if (eps.some((ep) => ep.stats().opens === 0)) {
    result.fails.push(`Could not connect to ${url} within ${connectDeadline} ms`);
    finish(2);
  }
}, connectDeadline);
connectCheck.unref?.();

setTimeout(() => {
  if (role !== 'node') result.fails.push(`Not all tasks completed within ${timeoutMs} ms (completed ${result.completed}/${taskCount})`);
  finish();
}, timeoutMs).unref?.();
timers.push(setInterval(() => {}, 1 << 30)); // Keep process alive until finish

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (role !== 'node') result.fails.push(`Interrupted by ${sig} (completed ${result.completed}/${taskCount})`);
    finish();
  });
}
