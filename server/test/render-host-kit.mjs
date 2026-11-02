/**
 * For testing only; must not be referenced by production code.
 *
 * Shared utilities for M6b standalone render host contract tests (`docs/plan/render-host-contract.md`,
 * test cases RHC*). Written strictly to contract, ignoring implementation.
 *
 * # Assumed implementation interface (contract leaves it open, reconciled during lead session
 *   integration; if mismatched, only modify `loadHostModule` and `startHost` in this file)
 *
 *   server/render-host/index.mjs
 *
 *     parseHostConfig(raw, { device? }) → { entries, maxConcurrent }
 *       raw       Parsed JSON from configuration file: single object or array of objects
 *                 (Contract Section 2, following the shape of M6a Contract Section 11)
 *                 Each item { url, projectId, username, deviceId, deviceName, as: 'member',
 *                 password | key, role: 'render' }
 *                 maxConcurrent can also be provided (default 1, cap 4). This test assumes it is
 *                 specified in configuration entries: for a single object, specified on the
 *                 object; for an array, specified on any entry counts as the global value (test
 *                 only specifies it on one entry)
 *       device    Default device info (same as second argument of M6a `normalizeEntry`), optional
 *       entries   Normalized configuration for each entry (same field names as above), order same
 *                 as input
 *       invalid   Throws Error, `err.code` is 'bad-host-config' or 'bad-shared-config' (following
 *                 M6a); message contains no passphrase or K
 *
 *     loadHostConfig(file) → Same as parseHostConfig, reads file; if unreadable or not JSON,
 *     throws the same error above
 *
 *     createRenderHost(options) → host
 *       options.entries        entries from parseHostConfig
 *       options.maxConcurrent  Aggregate concurrency cap across all nodes
 *       options.codeVersion    Local frameCode (the only one in node.hello's codeVersions)
 *       options.envFingerprint Fingerprint detected locally
 *       options.executor       Contract D.1 executor { plan, render }, shared by all nodes
 *       options.sinkFor        ({ projectId, entry, endpoint }) → Contract D.1 sink
 *                              { has, put, resultFor? }; one per project. In production it is
 *                              "fetch ticket via auth.ticket, push to asset of service.endpoints";
 *                              test injects fake, does not test real push (tested by probe)
 *       options.tickMs         Node tick (optional; test gives 20, default implementation determines
 *                              itself)
 *       options.log            (event, fields) => void (optional)
 *     host.start()             Open connections, check in; may return a Promise
 *     host.stop()              Yield held claims, close connections; returns Promise (Contract
 *                              Section 2 "Exit")
 *     host.describe()          Shape of Contract Section 3 diagnostics:
 *                              { nodes: [{ projectId, connected, claimed, completed, dedup,
 *                                failed, lost }], codeVersion, envFingerprint, maxConcurrent }
 *
 *   Connections use M5a `createWsEndpoint` (defaults to global `WebSocket`), obtaining proof
 *   freshly before each connection via M6a `sharedProtocols(entry, { role: 'render' })`. Before
 *   starting the host, test replaces global `WebSocket` with a recording subclass
 *   (`recordWebSocket`) to observe `node.hello` emitted by the host, without requiring
 *   implementation to expose extra injection points.
 *
 * # Existing M6a / M5 interfaces used (truly existing, used as is)
 *
 *   fake-shared-env.mjs     startSharedService / createProject / join (hosted side, isLoopback
 *                           treats all as remote by default)
 *   public exports of render-queue and render-node, fake-loopback-transport, fake-render-queue-env
 *   Document service `service.describe().modules['render-queue']`: when shared space exists,
 *   includes `spaces: { <projectId>: queue describe }` (M6a Report Section 5 Item 18)
 */
import assert from 'node:assert/strict';
import { sleep, waitFor } from './fake-ws-kit.mjs';
import { startSharedService, createProject, deviceId as newDeviceId } from './fake-shared-env.mjs';
import { buildAuthProtocols } from '../auth/client.mjs';
import { wsClient } from './fake-ws-kit.mjs';

export { sleep, waitFor, startSharedService, createProject, newDeviceId, wsClient };

export const CODE_VERSION = 'cv-host-test-0001';
export const FINGERPRINT = 'fp-host-test-0001';
export const PROTOCOL = 'promptcut.v1';

// ------------------------------------------------------------------ Assumed implementation interface

/*
 * Integration reconciliation (2026-09-26, claude/m6-integ2): The actual interface is in
 * `server/render-node/host.mjs`; mismatches with the above assumptions are bridged by the
 * `adaptHostModule` glue below, keeping test cases and assertions intact:
 *   - parseHostConfig(raw, { device? })  Actually same name and shape, used directly;
 *   - loadHostConfig(file)               Actually loadHostConfig(env), reading
 *                                        env.PROMPTCUT_SHARED_CONFIG; glue puts the file path into
 *                                        the environment variable object and clears
 *                                        PROMPTCUT_HOST_MAX_CONCURRENT (only tests values from the
 *                                        file);
 *   - createRenderHost(options)          Actually does not open connections or timers itself:
 *                                        `connect(entry, index)` returns { endpoint, executor,
 *                                        sink }, caller calls `tick()` per tick, exit is
 *                                        `shutdown()` + `settled()` + caller closes connections,
 *                                        diagnostics is `nodes()`. Glue wires it together following
 *                                        the wiring in the prerender process (`startHostNode` in
 *                                        `vite-plugin-frames.ts`): one `createWsEndpoint` per entry
 *                                        (via `sharedProtocols(entry, { role: 'render' })`),
 *                                        executor shares the one provided by the test, sink
 *                                        `sinkFor({ projectId, entry, endpoint })`;
 *                                        start = host.start() + call host.tick() every tickMs;
 *                                        stop = host.shutdown() → wait for settled (up to 5 s) →
 *                                        close all connections;
 *                                        describe = { nodes: host.nodes(), codeVersion,
 *                                        envFingerprint, maxConcurrent } (each entry in nodes
 *                                        preserves extra fields provided by the implementation as
 *                                        is, sharing the same source as the HTTP diagnostic
 *                                        endpoint).
 */
async function adaptHostModule() {
  const real = await import('../render-node/host.mjs');
  const { createWsEndpoint } = await import('../render-node/ws-transport.mjs');
  const { sharedProtocols } = await import('../auth/shared-config.mjs');
  return {
    parseHostConfig: real.parseHostConfig,
    loadHostConfig: (file) => real.loadHostConfig({ ...process.env, PROMPTCUT_SHARED_CONFIG: file, PROMPTCUT_HOST_MAX_CONCURRENT: '' }),
    createRenderHost({ entries, maxConcurrent, codeVersion, envFingerprint, executor, sinkFor, tickMs = 250, log = () => {} }) {
      const endpoints = [];
      const host = real.createRenderHost({
        entries,
        maxConcurrent,
        codeVersion,
        envFingerprint,
        now: Date.now,
        nodeIdOf: (_entry, index) => `host:rhc/p${index}`,
        connect: (entry) => {
          // Also record connection layer events (ws.open / ws.error / ws.connect-failed / ws.retry) into logs
          // so you can see where it gets stuck when a test doesn't receive a check-in
          const endpoint = createWsEndpoint({ url: entry.url, protocols: sharedProtocols(entry, { role: 'render' }), log });
          endpoints.push(endpoint);
          return { endpoint, executor, sink: sinkFor({ projectId: entry.projectId, entry, endpoint }) };
        },
        onEvent: (event) => log(`node.${event?.type}`, event),
      });
      let timer = null;
      return {
        start() {
          host.start();
          timer = setInterval(() => host.tick(), tickMs);
        },
        async stop() {
          clearInterval(timer);
          host.shutdown('shutdown');
          await Promise.race([host.settled(), sleep(5000)]);
          for (const endpoint of endpoints) endpoint.close();
        },
        describe() {
          return { nodes: host.nodes(), codeVersion: host.codeVersion, envFingerprint, maxConcurrent: host.maxConcurrent };
        },
      };
    },
  };
}

let hostModPromise = null;
/** Load host module (via glue above); assert failure on missing module/export (fails only tests using it) */
export async function loadHostModule() {
  hostModPromise ??= adaptHostModule();
  let mod;
  try {
    mod = await hostModPromise;
  } catch (error) {
    hostModPromise = null;
    assert.fail(`Failed to load server/render-node/host.mjs (see the reconciliation notes in the header of render-host-kit.mjs): ${error?.message ?? error}`);
  }
  for (const name of ['parseHostConfig', 'loadHostConfig', 'createRenderHost']) {
    assert.equal(typeof mod[name], 'function', `The host module must have ${name}; actual: ${Object.keys(mod).join(', ')}`);
  }
  return mod;
}

/** Hypothetical syntax for maxConcurrent in config entries: set on the first item */
export function withMaxConcurrent(entries, maxConcurrent) {
  if (maxConcurrent === undefined) return entries;
  return entries.map((e, i) => (i === 0 ? { ...e, maxConcurrent } : e));
}

/**
 * Start a host (in-process), and stop when the test ends.
 * @param {import('node:test').TestContext} t
 * @param {{ entries: object[], maxConcurrent?: number, codeVersion?: string, envFingerprint?: string,
 *           executor: object, sinkFor?: Function, tickMs?: number }} o  entries are raw config entries
 *           (processed by parseHostConfig first)
 */
export async function startHost(t, { entries, maxConcurrent, codeVersion = CODE_VERSION, envFingerprint = FINGERPRINT, executor, sinkFor, tickMs = 20 }) {
  const { parseHostConfig, createRenderHost } = await loadHostModule();
  const parsed = parseHostConfig(withMaxConcurrent(entries, maxConcurrent));
  const logs = [];
  const host = createRenderHost({
    entries: parsed.entries,
    maxConcurrent: parsed.maxConcurrent,
    codeVersion,
    envFingerprint,
    executor,
    sinkFor: sinkFor ?? (() => createFakeSink()),
    tickMs,
    log: (event, fields) => logs.push({ event, ...fields }),
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await host.stop();
  };
  t.after(stop);
  await host.start();
  return { host, stop, logs, parsed };
}

// ------------------------------------------------------------------ Executor and artifact store (shape of contract D.1)

/**
 * Controllable executor: suspends on every incoming render, waiting for test release
 * (`releaseAll` / `releaseOne`), or completes on its own after `autoMs`.
 * Records maximum running concurrently, rendered task ids, and number of times plan was called.
 * Immediately rejects when abort signal arrives.
 */
export function createGateExecutor({ autoMs = null } = {}) {
  const waiting = [];
  const stats = { running: 0, maxRunning: 0, rendered: [], planCalls: 0, aborted: 0 };
  return {
    stats,
    waiting,
    async plan(task) {
      stats.planCalls += 1;
      throw Object.assign(new Error(`The host should not compute plan: ${task?.id}`), { retryable: false });
    },
    render(task, { signal }) {
      stats.running += 1;
      stats.maxRunning = Math.max(stats.maxRunning, stats.running);
      stats.rendered.push(task.id);
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (fn) => {
          if (done) return;
          done = true;
          stats.running -= 1;
          const i = waiting.indexOf(entry);
          if (i >= 0) waiting.splice(i, 1);
          fn();
        };
        const entry = { id: task.id, release: () => finish(() => resolve({ frames: task.range })) };
        waiting.push(entry);
        signal?.addEventListener('abort', () => { stats.aborted += 1; finish(() => reject(new Error('aborted'))); }, { once: true });
        if (autoMs !== null) setTimeout(entry.release, autoMs);
      });
    },
    releaseOne() { waiting[0]?.release(); },
    releaseAll() { for (const w of [...waiting]) w.release(); },
  };
}

/** Fake artifact store: `has` returns true by `dedupKeys`, `put` accepts everything */
export function createFakeSink({ dedupKeys = new Set() } = {}) {
  const puts = [];
  return {
    puts,
    async has(ref) { return dedupKeys.has(ref.resultKey); },
    async put(entry) { puts.push(entry.meta?.taskId ?? entry.resultKey); return { complete: true, result: {} }; },
    async resultFor() { return {}; },
  };
}

// ------------------------------------------------------------------ Document service for shared projects

/**
 * Start hosted side document service (all treated as remote sources), create several
 * open entry projects. Shut down when test ends
 */
export async function sharedService(t, { projects = 1 } = {}) {
  const s = await startSharedService({ mode: 'hosted' });
  t.after(() => s.close());
  const list = [];
  for (let i = 0; i < projects; i++) {
    const password = `project-pw-${i}`;
    const p = await createProject(s.base, { password });
    list.push({ ...p, password });
  }
  return { s, projects: list };
}

/** Host config entries (contract section 2 fields) */
export function hostEntry(s, project, { username = 'rig', deviceId = 'render-host-device-0001', deviceName = 'RenderHost', password = project.password } = {}) {
  return { url: s.url, projectId: project.projectId, username, deviceId, deviceName, as: 'member', password, role: 'render' };
}

let reqSeq = 0;
/** Send message with reqId, wait for response with matching reqId (or without reqId whose type is in types) */
export async function ask(c, message, types = null, ms = 3000) {
  const reqId = `rhc-${++reqSeq}`;
  c.send({ ...message, reqId });
  const list = types ? [].concat(types, 'error') : null;
  return c.next((m) => m?.reqId === reqId || (list !== null && m?.reqId === undefined && list.includes(m?.type)), ms);
}

/** Connect as a member (proof assembled by M6a's client.mjs) */
export async function member(s, project, { username, role = 'page', deviceId = newDeviceId(username) } = {}) {
  const protocols = await buildAuthProtocols({
    base: s.base, projectId: project.projectId, username, deviceId, deviceName: `${username}-pc`, as: 'member', password: project.password, role,
  });
  const c = wsClient(s.url, protocols);
  await c.opened;
  return c;
}

/** Publish a fine-grained task as a page member; returns task.published */
export async function publishAs(s, project, username, tasks) {
  const c = await member(s, project, { username });
  const w = await ask(c, { type: 'publisher.hello', publisherId: `pub-${username}-${project.projectId}` }, 'publisher.welcome');
  assert.equal(w.type, 'publisher.welcome', JSON.stringify(w));
  const r = await ask(c, { type: 'task.publish', tasks }, 'task.published');
  assert.equal(r.type, 'task.published', JSON.stringify(r));
  for (const item of r.results ?? []) assert.equal(item.error ?? null, null, `Publish failed: ${JSON.stringify(item)}`);
  return { conn: c, published: r };
}

/** Queue describe for a shared space in document service (M6a: `modules['render-queue'].spaces[projectId]`) */
export function queueOf(s, projectId) {
  const d = s.service.describe().modules?.['render-queue'];
  assert.ok(d && typeof d === 'object', `No render-queue module in the describe of the document service: ${JSON.stringify(Object.keys(s.service.describe().modules ?? {}))}`);
  const q = d.spaces?.[projectId];
  return q ?? { tasks: [], nodes: [], publishers: [] };
}

/** Number of tasks with state claimed across all shared spaces */
export function claimedCount(s, projectIds) {
  let n = 0;
  for (const pid of projectIds) n += queueOf(s, pid).tasks.filter((x) => x.state === 'claimed').length;
  return n;
}

/** Number of tasks for each state in a space */
export function statesOf(s, projectId) {
  const out = {};
  for (const x of queueOf(s, projectId).tasks) out[x.state] = (out[x.state] ?? 0) + 1;
  return out;
}

// ------------------------------------------------------------------ Fine-grained tasks

/** A valid snapshot fine-grained task (contract A.4); requires includes code version and fingerprint */
export function fineTask({ tag, from = 0, to = 29, projectId = 'demo', projectRev = 1, codeVersion = CODE_VERSION, envFingerprint = FINGERPRINT, weight = 'light' }) {
  const resultKey = `rk-${tag}`;
  return {
    id: `snapshot:${resultKey}:${from}-${to}`,
    kind: 'snapshot',
    tier: 'shared',
    resultKey,
    range: { unit: 'localFrame', from, to },
    source: { projectId, projectRev },
    input: {},
    weight: { class: weight, estMs: null, frames: to - from + 1 },
    requires: { codeVersion, envFingerprint },
    priority: 0,
  };
}

// ------------------------------------------------------------------ Record WebSocket messages sent by host

/** Extract proof JSON from subprotocol (`promptcut.auth.<b64url(JSON)>`); returns null if absent */
export function proofOf(protocols) {
  const list = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
  const item = list.find((p) => typeof p === 'string' && p.startsWith('promptcut.auth.'));
  if (!item) return null;
  try { return JSON.parse(Buffer.from(item.slice('promptcut.auth.'.length), 'base64url').toString('utf8')); } catch { return null; }
}

/**
 * Replace global WebSocket with a logging subclass, restore when test ends.
 * Record proof (project, role) for each connection and every outgoing JSON message.
 * @returns {{ sockets: Array<{ url, proof, sent: object[] }>, sentBy(role): Array<{ projectId, message }> }}
 */
export function recordWebSocket(t) {
  const Original = globalThis.WebSocket;
  const sockets = [];
  class Recording extends Original {
    constructor(url, protocols) {
      super(url, protocols);
      this.__rec = { url: String(url), proof: proofOf(protocols), sent: [] };
      sockets.push(this.__rec);
    }
    send(data) {
      try { this.__rec.sent.push(JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))); } catch { /* Not JSON */ }
      return super.send(data);
    }
  }
  globalThis.WebSocket = Recording;
  t.after(() => { globalThis.WebSocket = Original; });
  return {
    sockets,
    sentBy(role) {
      const out = [];
      for (const s of sockets) {
        if (s.proof?.r !== role) continue;
        for (const m of s.sent) out.push({ projectId: s.proof.p, message: m });
      }
      return out;
    },
  };
}
