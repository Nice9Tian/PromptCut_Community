/**
 * Shared project connection probe (SP, contract `docs/plan/shared-project-contract.md`
 * section 6, section 7 SP1 / SP7).
 * Prints a single JSON line on the last result line; exit code 1 when `ok` is false, exit code 2
 * on connection failure or invalid arguments. Uses only Node built-in modules and server-side
 * modules in the repository.
 *
 * creator / member for `--mode internet`, `--role migrate-check`, and `--role coord` are in this
 * file; all logic for `--mode lan` is in `shared-project-lan.mjs` (this file only dispatches; see
 * that file header for usage). Creation in Internet mode uses `createSharedProject({ where: 'hosted' })`
 * in `server/auth/route.mjs`. Coordination endpoint is `probe-coord.mjs`, matching the shape of
 * cross-machine mode in `render-host-probe.mjs` (the same endpoint can be used by both probes at
 * the same time).
 *
 * ## --mode internet --role creator --hosted <url>
 *
 *   node scripts/probes/shared-project-probe.mjs --mode internet --role creator --hosted http://127.0.0.1:8790
 *        (--coord-port 8799 [--coord-host 127.0.0.1] | --coord <url>) [--name <project-name>] [--tasks 6] [--task-ms 600]
 *        [--creator-delay-ms 1000] [--media-kb 256] [--timeout-ms 180000]
 *
 *   1. Create an open-entry shared project on the hosted side (`POST shared/create`,
 *      passphrase randomly generated);
 *   2. Connect to document service as creator (`as: 'creator'`, `role: 'render'`, node profile `pc`):
 *      get asset service address from `service.endpoints`, obtain asset ticket via `auth.ticket`;
 *      upload a project snapshot (`project.announce` + `project.snapshot.put`), a content store entry,
 *      and an asset (`media`, chunked upload with ticket);
 *   3. Write member config to coordination endpoint (`member-config`), wait for member to report
 *      "ready" (`member-ready`);
 *   4. As the local PC node (the node itself is the publisher), publish `--tasks` fine-grained tasks
 *      (same mock fine-grained tasks as `render-queue-e2e.mjs`: kind snapshot, tier shared;
 *      real plan splitting requires the editor, not run here); local node delays claiming by
 *      `--creator-delay-ms` to ensure member claims first; outputs (one small file per segment)
 *      are written to `px` with ticket; wait for all `task.done`;
 *   5. Write `creator-done`, wait for member results (`member-result`), and output together.
 *
 * ## --mode internet --role member --hosted <url> --coord <url>
 *
 *   node scripts/probes/shared-project-probe.mjs --mode internet --role member --hosted http://127.0.0.1:8790 --coord http://127.0.0.1:8799
 *        [--expect-tasks 1] [--task-ms 600] [--max-concurrent 2] [--timeout-ms 180000] [--assert-no-lan <PC-LAN-address>]
 *
 *   `--assert-no-lan` (M8 "remote connection", `m8-plan.md` section 2.3): from obtaining config to
 *   finalize, run `netstat -an` read-only every 2 s to count TCP connections from this machine to
 *   that address: record a baseline at start (TIME_WAIT left by previous run, etc.), then count any
 *   newly appeared connection regardless of state, requiring 0 throughout; run a 3 s LAN discovery
 *   before finalize (requiring 0 items). The two items are evaluated separately, output in result
 *   line as `noLan`. Does not modify firewall, proxy, or routes (constraint "do not touch host
 *   machine network"), common utility `scripts/probes/m8/no-lan.mjs`.
 *
 *   Do not set cluster token (fails if set), enter only with project credentials provided by
 *   coordination endpoint (`role: 'render'`, node profile `host`): get asset service address from
 *   `service.endpoints`; read project snapshot (retrieve chunk by chunk, verify digest), content
 *   store entries, and read asset with ticket (once with Bearer and once with query string read-only
 *   ticket, Range); read once without ticket (recorded as `loopbackTrusted` when loopback is
 *   treated as internal, not evaluated); claim and complete at least `--expect-tasks` tasks
 *   (outputs written to `px` with rw ticket). `--expect-tasks 0` only tests entry and read
 *   (for spot checks after migration). `--hosted` overrides document service address in member
 *   config (connecting to new address after migration).
 *
 * ## --role coord --port <n> [--host 127.0.0.1]
 *
 *   Start coordination endpoint standalone (creator points here using `--coord <url>`).
 *   See `probe-coord.mjs` for shape: `PUT /kv/<key>` (JSON), `GET /kv/<key>?wait=<ms>`
 *   (wait if absent, 404 on timeout). The coordination endpoint in `render-host-probe.mjs`
 *   cross-machine mode also responds to these two routes, so its endpoint can also be used directly
 *   (`--coord http://<creator IP>:5409`). Keys: `member-config`, `member-ready`, `creator-done`,
 *   `member-result` (Internet mode); `lan-member`, `lan-member-result` (LAN mode). Member config
 *   contains project passphrase (disposable project created by probe), so the coordination
 *   endpoint should only bind to trusted network segments.
 *
 * ## --role migrate-check --from <url> --to <url>
 *
 *   node scripts/probes/shared-project-probe.mjs --role migrate-check --from http://127.0.0.1:8790 --to http://127.0.0.1:8794
 *        [--from-asset <url>] [--to-asset <url>] [--sample 100]
 *
 *   `--from` / `--to` are the document service http addresses of the two hosted setups (contract
 *   section 11 ruling; ws also accepted). When asset service address is omitted, it is retrieved
 *   from their respective `service.endpoints` (also verifying that the new instance has registered
 *   its address with document service). Project count is listed via admin interface
 *   (`GET /admin/inventory`, `/admin/blob/<ns>/<hash>`) with cluster token (admin purposes):
 *   first read environment variable `PROMPTCUT_CLUSTER_TOKEN`, if absent read
 *   `<data-dir>/secrets/cluster-token` (data directory taken from `--data-dir`, otherwise
 *   environment variable `PROMPTCUT_DATA_DIR`); if neither is present, it can only run on server
 *   local loopback. Output `admin` is `token` or `loopback`, `tokenFrom` is `env` / `file` / null.
 *   Check item by item (`hosting-migration.md` steps 6 and 7): `/healthz` on both sides; shared
 *   project count and each project's name and mode; `projectRev`, project snapshot count, and
 *   content store entry count for each project in each namespace; hash set and byte count of the
 *   three namespaces; then sample up to `--sample` items by hash from the new instance (default 100,
 *   or all if fewer; `all` for all), retrieve via admin interface, recompute sha256, match rate
 *   must be 100%. `projectRev` counts are additionally categorized as "equal / zeroed / lagging / ahead"
 *   (output `revs`). All must pass for `ok: true`.
 *
 *   `--from-inventory <inventory-file>` replaces `--from` (M8, `m8-plan.md` section 2.5 steps 6 and 7):
 *   old instance has stopped writes and is offline, old side reads the file written by
 *   `--role inventory`; comparison method is the same as above. Can also provide:
 *   - `--seed <seed-file>` (written by `m8-migrate-probe.mjs --step seed`, containing passphrases for
 *     probe-created projects): enter each seed project on the new instance as creator, verify that
 *     `projectRev` and digest match the inventory, keys and hashes match for both manifest types
 *     (`snapshot-manifest` / `render-manifest`, including layer table `layers:<project-id>`), and
 *     each chunk referenced by manifests is retrieved via **data plane** (asset address registered by
 *     new instance, with read-only ticket) and recomputed sha256 matches;
 *   - `--scan-dir <new-instance-data-dir>`: when inventory contains `readyLayers` (`--scan-dir` was
 *     provided during inventory), compare ready layers key-by-key across namespaces;
 *   - `--to-asset <url>`: admin interface uses this origin instead (loopback port forwarded via SSH
 *     on Alibaba Cloud; token is not exposed to public network).
 *
 * ## --role inventory --hosted <url> --out <inventory-file>
 *
 *   node scripts/probes/shared-project-probe.mjs --role inventory --hosted http://127.0.0.1:8790 --out inv.json
 *        [--asset <url>] [--seed <seed-file>] [--scan-dir <data-dir>] [--data-dir <dir>]
 *
 *   Inventory before migration (`hosting-migration.md` step 6 "recorded before stopping writes"):
 *   both `/healthz`, asset addresses registered in `service.endpoints`, raw admin inventory
 *   `GET /admin/inventory` (shared projects, `projectRev`, snapshot counts, content store entry counts
 *   for each project in each namespace, hash manifests and byte counts for the three namespaces).
 *   When `--seed` is provided: seed project `projectRev`, digest, keys and hashes for both manifest
 *   types, and verify all chunks referenced by manifests by retrieving them via data plane (source
 *   must already be valid). When `--scan-dir` is provided: read-only scan of ready layers across
 *   namespaces in the data directory (hash of the last entry for each key in both manifest types),
 *   which can cover projects that probes cannot enter (such as projects created by the editor);
 *   providing only `--scan-dir` without `--hosted` is also allowed (scanning on server after stopping
 *   writes). Tokens and passphrases are not written to inventory file; file is not written if there
 *   are failures.
 *
 * ## Transport (creator, member)
 *
 *   Connection to document service is a session (`createDocEndpoint` in
 *   `server/render-node/session-link.mjs`, HT-a). `--transport auto|ws` is a developer override
 *   argument: defaults to auto (reads environment variable `PROMPTCUT_TRANSPORT` first, then defaults
 *   to auto; auto in HT-a means WebSocket), `ws` only uses WebSocket, and `http` is not enabled in
 *   HT-a (exit code 2). Member config has no transport field. Output `session` records actual
 *   transport used, resume count, and whether connecting to an older server without a session layer.
 *
 * Credentials (passphrase, K, ticket) are not printed to output.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startCoordServer, coordClient } from './probe-coord.mjs';
import { startNoLanWatch } from './m8/no-lan.mjs';

const USAGE = `Usage:
  node scripts/probes/shared-project-probe.mjs --mode internet --role creator --hosted <url> (--coord-port <n> | --coord <url>) [--tasks 6] [--transport auto|ws]
  node scripts/probes/shared-project-probe.mjs --mode internet --role member --hosted <url> --coord <url> [--expect-tasks 1] [--transport auto|ws] [--assert-no-lan <PC LAN address>]
  node scripts/probes/shared-project-probe.mjs --role coord --port <n> [--host 127.0.0.1]
  node scripts/probes/shared-project-probe.mjs --role inventory --hosted <url> [--asset <url>] [--seed <seed file>] [--scan-dir <data directory>] --out <inventory file> [--data-dir <directory>]
  node scripts/probes/shared-project-probe.mjs --role migrate-check (--from <url> | --from-inventory <inventory file>) --to <url> [--to-asset <url>] [--seed <seed file>] [--scan-dir <new data directory>] [--data-dir <directory>] [--sample 100|all]
  node scripts/probes/shared-project-probe.mjs --mode lan --role creator|member ... (see shared-project-lan.mjs)`;

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const intArg = (name, fallback, min = 0) => {
  const raw = arg(name, undefined);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) usage(`${name} must be an integer not less than ${min}`);
  return n;
};
function usage(msg) {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

const ROLE = arg('--role', null);
const MODE = arg('--mode', null);
const TIMEOUT_MS = intArg('--timeout-ms', 180_000, 1000);
const started = Date.now();
const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

const here = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(`../../${rel}`, here));

const log = (event, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const fails = [];
const check = (cond, label, extra) => {
  if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 400)}`));
  return !!cond;
};

/* ------------------------------------------------------------------ Shared helpers */

/** Document service address → { http, ws } (`http://h:p` ↔ `ws://h:p`, path preserved) */
function docUrls(url) {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '');
  if (u.protocol === 'ws:' || u.protocol === 'http:') return { http: `http://${u.host}${path}`, ws: `ws://${u.host}${path}` };
  if (u.protocol === 'wss:' || u.protocol === 'https:') return { http: `https://${u.host}${path}`, ws: `wss://${u.host}${path}` };
  throw new Error(`Unrecognized address: ${url}`);
}

async function getJson(url, { headers = {}, timeoutMs = 15_000 } = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

/** Requests / responses on a WebSocket endpoint: paired by reqId; if `until` is provided, collect until it returns true */
function rpcOn(ep) {
  const waiting = new Map();
  let seq = 0;
  ep.onMessage((m) => {
    const w = m?.reqId !== undefined ? waiting.get(m.reqId) : undefined;
    if (!w) return;
    w.got.push(m);
    if (m.type === 'error' || !w.until || w.until(m)) {
      waiting.delete(m.reqId);
      clearTimeout(w.timer);
      w.resolve(w.until ? w.got : m);
    }
  });
  return (message, { until, timeoutMs = 20_000 } = {}) => new Promise((resolve, reject) => {
    const reqId = `sp-${++seq}-${randomBytes(3).toString('hex')}`;
    const timer = setTimeout(() => {
      waiting.delete(reqId);
      reject(new Error(`Timed out waiting for the reply to ${message.type}`));
    }, timeoutMs);
    waiting.set(reqId, { resolve, until, got: [], timer });
    if (!ep.send({ ...message, reqId })) {
      waiting.delete(reqId);
      clearTimeout(timer);
      reject(new Error(`${message.type} was not sent (connection is gone)`));
    }
  });
}

/**
 * `--transport` (developer override, contract `docs/plan/http-transport-contract.md` section 4.3
 * item 6): if omitted, not passed, and `createDocEndpoint` reads `PROMPTCUT_TRANSPORT`, defaulting
 * to auto; if provided, follow it (`ws` uses only WebSocket; `http` is not enabled in HT-a, exiting
 * with code 2 for invalid argument).
 */
function transportOption(transportOf) {
  const raw = arg('--transport', undefined);
  if (raw === undefined) return {};
  try {
    return { transport: transportOf(raw, undefined) };
  } catch (err) {
    usage(`--transport ${raw}: ${err?.message ?? err}`);
    return {};
  }
}

/** Session diagnostics in output: actual transport used, resume count, whether connecting to an older server without session layer (excluding session id) */
function sessionOf(ep) {
  if (!ep || typeof ep.stats !== 'function') return null;
  const s = ep.stats();
  return { mode: s.mode ?? null, transport: s.transport ?? null, resumes: s.resumes ?? 0, fallbacks: s.fallbacks ?? 0, legacy: s.legacy === true, opens: s.opens ?? 0 };
}

function waitOpen(ep, ms = 15_000) {
  return new Promise((resolve) => {
    if (ep.connected) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    ep.onOpen(() => { clearTimeout(t); resolve(true); });
  });
}

/** Get first asset service address from `service.endpoints` */
function waitAssetUrl(ep, watchServiceEndpoints, ms = 10_000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { stop(); resolve(null); }, ms);
    const stop = watchServiceEndpoints(ep, ['asset'], (list) => {
      const url = list.find((e) => e.kind === 'asset' && Array.isArray(e.urls) && e.urls.length)?.urls[0];
      if (url) { clearTimeout(t); stop(); resolve(url); }
    });
  });
}

/** Close connection, wait up to 3 s for onClose (on Windows, exiting before close handshake completes crashes, same as render-queue-e2e) */
async function closeAll(eps) {
  const waits = [];
  for (const ep of eps) {
    if (ep.connected) waits.push(new Promise((resolve) => ep.onClose(resolve)));
    try { ep.close(); } catch { /* Closed */ }
  }
  await Promise.race([Promise.all(waits), new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
}

/**
 * Print result line, set exit code, then let the process exit naturally (without calling
 * process.exit): connections and coordination port are closed, and the only remaining items
 * are idle keep-alive connections from fetch, which close on their own when timed out. On
 * Windows, calling process.exit while handles are still closing causes libuv to crash on an
 * assertion (exit code 0xC0000409 = 3221226505, same as comments in render-queue-e2e.mjs).
 * Force exit only if something is still hanging after 10 s.
 */
function finish(result, code) {
  result.fails = fails;
  result.ms = Date.now() - started;
  if (code === undefined) code = fails.length === 0 ? 0 : 1;
  result.ok = code === 0;
  process.exitCode = code;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  setTimeout(() => process.exit(code), 10_000).unref();
}

/* ------------------------------------------------------------------ Render node helpers */

/** Mock fine-grained task (same shape as used by `render-queue-e2e.mjs`, contract A.4) */
function fineTask({ resultKey, from, to, projectId, projectRev }) {
  return {
    id: `snapshot:${resultKey}:${from}-${to}`,
    kind: 'snapshot',
    tier: 'shared',
    resultKey,
    range: { unit: 'localFrame', from, to },
    source: { projectId, projectRev },
    input: {},
    weight: { class: 'light', estMs: null, frames: to - from + 1 },
    requires: {},
    priority: 0,
  };
}

/** Executor that sleeps for taskMs */
function sleepExecutor(taskMs) {
  return {
    plan: async () => { throw Object.assign(new Error('The probe does not compute plans'), { retryable: false }); },
    render(task, { signal }) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ frames: task.range.to - task.range.from + 1 }), taskMs);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      });
    },
  };
}

/** One small artifact per segment: content is determined by result key and range (content-addressed; pushing the same segment again yields the same hash) */
const artifactBytes = (resultKey, range) => Buffer.from(`promptcut-sp-probe-artifact\n${resultKey}\n${range.from}-${range.to}\n`, 'utf8');

/** Artifact store: push into the `px` namespace of asset service with ticket */
function assetSink(client, counters) {
  return {
    async has({ resultKey, range }) {
      return client.has('px', sha256(artifactBytes(resultKey, range)));
    },
    async put({ resultKey, range }) {
      const bytes = artifactBytes(resultKey, range);
      const r = await client.put('px', bytes, {});
      counters.artifactsWritten += 1;
      return { complete: true, result: { px: [r.hash ?? sha256(bytes)] } };
    },
  };
}

/* ================================================================== creator */

async function runCreator() {
  const hosted = arg('--hosted', null);
  if (!hosted) usage('Missing --hosted');
  const coordPort = arg('--coord-port', null);
  const coordArg = arg('--coord', null);
  if (!coordPort && !coordArg) usage('Needs --coord-port (start a coordinator in this process) or --coord (an existing coordinator)');
  const taskCount = intArg('--tasks', 6, 1);
  const taskMs = intArg('--task-ms', 600, 0);
  const creatorDelayMs = intArg('--creator-delay-ms', 1000, 0);
  const mediaKb = intArg('--media-kb', 256, 1);
  const name = arg('--name', `sp-probe-${runId}`);
  const urls = docUrls(hosted);
  const deadline = started + TIMEOUT_MS;

  const [{ createSharedProject }, { buildAuthProtocols }, { createDocEndpoint, transportOf }, { watchServiceEndpoints }, { createLocalNode }, { createTicketSource }, { createAssetClient }] = await Promise.all([
    mod('server/auth/route.mjs'), mod('server/auth/client.mjs'), mod('server/render-node/session-link.mjs'), mod('server/render-node/endpoint.mjs'),
    mod('server/render-node/local-node.mjs'), mod('server/auth/ticket-source.mjs'), mod('server/asset-store/client.mjs'),
  ]);

  const result = {
    ok: false, mode: 'internet', role: 'creator', hosted: urls.http, runId, name, projectId: null, assetUrl: null,
    snapshot: null, content: null, media: null,
    tasks: { published: 0, completed: 0, duplicateDone: 0, byCreatorNode: 0 }, artifactsWritten: 0, member: null, coord: null,
  };
  const eps = [];
  let coordServer = null;
  const done = async (code) => {
    result.session = sessionOf(eps[0]);
    await closeAll(eps);
    await coordServer?.close();
    finish(result, code);
  };

  // Coordination port
  let coordUrl = coordArg;
  if (coordPort) {
    const host = arg('--coord-host', '127.0.0.1');
    try {
      coordServer = await startCoordServer({ port: Number(coordPort), host });
    } catch (err) {
      fails.push(`Failed to start the coordinator: ${err?.code ?? err?.message}`);
      return done(2);
    }
    coordUrl = coordServer.url;
  }
  result.coord = coordUrl;
  const coord = coordClient(coordUrl);

  // 1. Create project
  const creator = { username: 'creator', password: randomBytes(12).toString('base64url') };
  const projectPassword = randomBytes(12).toString('base64url');
  let created;
  try {
    created = await createSharedProject({ where: 'hosted', hostedUrl: urls.http, name, mode: 'free', creator, password: projectPassword });
  } catch (err) {
    fails.push(`Failed to create the project: ${err?.status ?? ''} ${err?.reason ?? err?.message}`);
    return done(err?.status ? 1 : 2);
  }
  result.projectId = created.projectId;
  log('creator.created', { projectId: created.projectId, name });

  // 2. Connect as creator
  const deviceId = `probe-creator-${randomBytes(6).toString('hex')}`;
  let key = null;
  const protocols = () => buildAuthProtocols({
    base: urls.http, projectId: created.projectId, username: creator.username, deviceId, deviceName: 'sp-probe-creator', as: 'creator',
    ...(key ? { key } : { password: creator.password }), role: 'render', onKey: (k) => { key = k; },
  });
  const ep = createDocEndpoint({ url: urls.ws, protocols, ...transportOption(transportOf), log: (event, fields) => log(`creator.${event}`, fields) });
  eps.push(ep);
  const rpc = rpcOn(ep);
  if (!check(await waitOpen(ep), 'Creator connected to the document service')) return done(2);

  const assetUrl = await waitAssetUrl(ep, watchServiceEndpoints);
  result.assetUrl = assetUrl;
  if (!check(assetUrl, 'Got the asset service address from service.endpoints')) return done();
  const ticket = createTicketSource(ep, { access: 'rw' });
  const client = createAssetClient({ base: assetUrl, ticket });

  // Project snapshot
  const localProjectId = 'sp-probe-project';
  const snapshotText = JSON.stringify({ id: localProjectId, name, runId, tracks: [], fps: 30, duration: 3, note: 'shared-project-probe' });
  const digest = sha256(snapshotText);
  try {
    const ann = await rpc({ type: 'project.announce', projectId: localProjectId, digest });
    check(ann.type === 'project.announced', 'project.announce', ann);
    const projectRev = ann.projectRev;
    const put = await rpc({ type: 'project.snapshot.put', projectId: localProjectId, projectRev, digest, index: 0, count: 1, data: snapshotText });
    check(put.type === 'project.snapshot.stored' && put.complete === true, 'Project snapshot stored', put);
    result.snapshot = { projectId: localProjectId, projectRev, digest, bytes: Buffer.byteLength(snapshotText) };
  } catch (err) {
    fails.push(`Project snapshot: ${err.message}`);
  }
  // Content store entries
  const contentKey = `sp-probe/${runId}`;
  const contentBody = { runId, note: 'shared-project-probe', at: Date.now() };
  try {
    const st = await rpc({ type: 'content.put', kind: 'snapshot-manifest', key: contentKey, body: contentBody });
    check(st.type === 'content.stored', 'content.put', st);
    result.content = { kind: 'snapshot-manifest', key: contentKey, hash: st.hash ?? null };
  } catch (err) {
    fails.push(`Content store: ${err.message}`);
  }
  // Assets
  const media = randomBytes(mediaKb * 1024);
  try {
    const r = await client.put('media', media, { ext: 'bin' });
    const hash = sha256(media);
    check((r.hash ?? hash) === hash, 'The hash returned by the asset upload matches', r);
    result.media = { hash, bytes: media.length };
  } catch (err) {
    fails.push(`Asset upload: ${err.message}`);
  }
  if (fails.length) return done();

  // 3. Hand member configuration over to coordination port
  const memberConfig = {
    url: urls.ws, projectId: created.projectId, username: `member-${randomBytes(3).toString('hex')}`, password: projectPassword,
    as: 'member', role: 'render', deviceId: `probe-member-${randomBytes(6).toString('hex')}`, deviceName: 'sp-probe-member',
  };
  await coord.put('member-config', {
    config: memberConfig,
    expect: { snapshot: result.snapshot, content: { kind: 'snapshot-manifest', key: contentKey, bodyHash: sha256(JSON.stringify(contentBody)) }, media: result.media },
    runId,
  });
  log('creator.member-config', { coord: coordUrl });
  const ready = await coord.take('member-ready', deadline);
  if (!check(ready, 'Waited until the member reported member-ready')) return done();

  // 4. Local PC node: publish fine-grained tasks, claim them itself a bit later
  const counters = { artifactsWritten: 0 };
  const nodeId = `sp-probe-pc-${runId}`;
  const claimAt = { at: Infinity };
  const node = createLocalNode({
    nodeId,
    node: { profile: 'pc', envFingerprint: 'sp-probe-env', codeVersions: [], capabilities: {} },
    endpoint: ep,
    now: Date.now,
    maxConcurrent: 1,
    isIdle: () => Date.now() >= claimAt.at,
    executor: sleepExecutor(taskMs),
    sink: assetSink(client, counters),
    onEvent: (e) => {
      if (e.type === 'completed' || e.type === 'dedup') result.tasks.byCreatorNode += 1;
      if (e.type === 'failed') fails.push(`Creator node ${e.id} failed: ${e.error}`);
    },
  });
  const tasks = Array.from({ length: taskCount }, (_, i) => fineTask({
    resultKey: `${localProjectId}@${result.snapshot.projectRev}`, from: i * 30, to: i * 30 + 29, projectId: localProjectId, projectRev: result.snapshot.projectRev,
  }));
  const ids = new Set(tasks.map((t) => t.id));
  const doneIds = new Set();
  const allDone = new Promise((resolve) => {
    ep.onMessage((m) => {
      if (m?.type === 'task.done' && ids.has(m.id)) {
        if (doneIds.has(m.id)) result.tasks.duplicateDone += 1;
        doneIds.add(m.id);
        result.tasks.completed = doneIds.size;
        if (doneIds.size === ids.size) resolve(true);
      } else if (m?.type === 'task.failed' && ids.has(m.id)) {
        fails.push(`task.failed ${m.id}: ${m.error}`);
      }
    });
  });
  node.start();
  const timer = setInterval(() => { try { node.tick(); } catch (err) { log('creator.tick-error', { message: String(err?.message ?? err) }); } }, 50);
  const pub = await rpc({ type: 'task.publish', tasks }).catch((err) => ({ type: 'error', detail: err.message }));
  check(pub.type === 'task.published' && (pub.results ?? []).every((r) => !r.error), 'task.publish', pub);
  result.tasks.published = tasks.length;
  claimAt.at = Date.now() + creatorDelayMs;
  const finished = await Promise.race([allDone, sleep(Math.max(1, deadline - Date.now())).then(() => false)]);
  clearInterval(timer);
  node.stop();
  check(finished, `All task.done received (${doneIds.size}/${tasks.length})`);
  check(result.tasks.duplicateDone === 0, 'No duplicate task.done', result.tasks.duplicateDone);
  result.artifactsWritten = counters.artifactsWritten;

  // 5. Finalize: notify the member, wait for its result
  await coord.put('creator-done', { completed: doneIds.size, published: tasks.length });
  const memberResult = await coord.take('member-result', Math.min(deadline, Date.now() + 60_000));
  result.member = memberResult;
  check(memberResult?.ok === true, 'Member result ok', memberResult?.fails);
  return done();
}

/* ================================================================== member */

async function runMember() {
  const coordUrl = arg('--coord', null);
  if (!coordUrl) usage('Missing --coord');
  const expectTasks = intArg('--expect-tasks', 1, 0);
  const taskMs = intArg('--task-ms', 600, 0);
  const maxConcurrent = intArg('--max-concurrent', 2, 1);
  const deadline = started + TIMEOUT_MS;
  const coord = coordClient(coordUrl);

  const [{ normalizeEntry, sharedProtocols }, { createDocEndpoint, transportOf }, { watchServiceEndpoints }, { createLocalNode }, { createTicketSource }, { createAssetClient }] = await Promise.all([
    mod('server/auth/shared-config.mjs'), mod('server/render-node/session-link.mjs'), mod('server/render-node/endpoint.mjs'),
    mod('server/render-node/local-node.mjs'), mod('server/auth/ticket-source.mjs'), mod('server/asset-store/client.mjs'),
  ]);

  const result = {
    ok: false, mode: 'internet', role: 'member', hosted: null, projectId: null, clusterToken: process.env.PROMPTCUT_CLUSTER_TOKEN ? 'set' : 'unset',
    enter: null, assetUrl: null, snapshot: null, content: null, media: null, ticket: null,
    claims: 0, taskDone: 0, artifactsWritten: 0, expectTasks,
  };
  const eps = [];
  const done = async (code) => {
    result.session = sessionOf(eps[0]);
    await closeAll(eps);
    if (expectTasks > 0) {
      try { await coord.put('member-result', { ...result, fails, ok: fails.length === 0 }); } catch { /* Coordinator port closed */ }
    }
    finish(result, code);
  };
  check(result.clusterToken === 'unset', 'Member sets no cluster token (PROMPTCUT_CLUSTER_TOKEN should be empty)');
  // --assert-no-lan <PC LAN address> (m8-plan Section 2.3 "Off-site connection"): throughout, read-only
  // count TCP connections from this machine to this address beyond baseline (regardless of state);
  // perform a 3 s LAN discovery before finalization
  const noLanIp = arg('--assert-no-lan', null);
  const noLan = noLanIp ? startNoLanWatch(noLanIp, { log }) : null;

  const handoff = await coord.take('member-config', deadline);
  if (!check(handoff?.config, 'Got the member config from the coordinator')) return done(2);
  const raw = { ...handoff.config };
  const hostedArg = arg('--hosted', null);
  if (hostedArg) raw.url = docUrls(hostedArg).ws;
  const entry = normalizeEntry(raw);
  result.hosted = docUrls(entry.url).http;
  result.projectId = entry.projectId;
  const expect = handoff.expect;

  // Entry: with project credentials only
  const enterStart = Date.now();
  const ep = createDocEndpoint({ url: entry.url, protocols: sharedProtocols(entry, { role: 'render' }), ...transportOption(transportOf), log: (event, fields) => log(`member.${event}`, fields) });
  eps.push(ep);
  const rpc = rpcOn(ep);
  const opened = await waitOpen(ep);
  result.enter = { ok: opened, ms: Date.now() - enterStart };
  if (!check(opened, 'Member entered with the project credentials')) return done(2);

  const assetUrl = await waitAssetUrl(ep, watchServiceEndpoints);
  result.assetUrl = assetUrl;
  if (!check(assetUrl, 'Got the asset service address from service.endpoints')) return done();

  // Project snapshot
  try {
    const got = await rpc({ type: 'project.snapshot.get', projectId: expect.snapshot.projectId, projectRev: expect.snapshot.projectRev }, {
      until: (m) => m.type === 'project.snapshot.end' || m.missing === true,
    });
    const parts = got.filter((m) => m.type === 'project.snapshot.part' && typeof m.data === 'string').sort((a, b) => a.index - b.index);
    const text = parts.map((m) => m.data).join('');
    const ok = !got.some((m) => m.missing) && sha256(text) === expect.snapshot.digest;
    check(ok, 'Project snapshot retrieved and digest matches', { parts: parts.length });
    result.snapshot = { ok, projectRev: expect.snapshot.projectRev, parts: parts.length, bytes: Buffer.byteLength(text) };
  } catch (err) {
    fails.push(`Project snapshot: ${err.message}`);
  }
  // Content store
  try {
    const item = await rpc({ type: 'content.get', kind: expect.content.kind, key: expect.content.key });
    const ok = item.type === 'content.item' && !item.missing && sha256(JSON.stringify(item.body)) === expect.content.bodyHash;
    check(ok, 'Content store item retrieved and content matches', item.type);
    result.content = { ok };
  } catch (err) {
    fails.push(`Content store: ${err.message}`);
  }

  // Tickets
  const rwTicket = createTicketSource(ep, { access: 'rw' });
  const rTicket = createTicketSource(ep, { access: 'r' });
  const [rw, r] = [await rwTicket(), await rTicket()];
  result.ticket = { rw: !!rw, r: !!r };
  check(rw && r, 'Got both rw and r asset tickets via auth.ticket');
  const client = createAssetClient({ base: assetUrl, ticket: rwTicket });
  const mediaUrl = `${assetUrl.replace(/\/+$/, '')}/media/${expect.media.hash}`;
  result.media = {};
  try {
    const bytes = await client.get('media', expect.media.hash);
    result.media.bearer = !!bytes && bytes.length === expect.media.bytes && sha256(bytes) === expect.media.hash;
    check(result.media.bearer, 'Reading an asset with a Bearer ticket, whole-file sha256 matches');
  } catch (err) {
    fails.push(`Bearer asset read: ${err.message}`);
  }
  try {
    const res = await fetch(`${mediaUrl}?t=${encodeURIComponent(r ?? '')}`, { headers: { Range: 'bytes=0-99' }, signal: AbortSignal.timeout(15_000) });
    const body = Buffer.from(await res.arrayBuffer());
    result.media.query = res.status === 206 && body.length === 100 && res.headers.get('cache-control') === 'no-store';
    check(result.media.query, 'Reading an asset with a read-only query-string ticket and Range returns 206, no-store', { status: res.status, len: body.length });
  } catch (err) {
    fails.push(`Query-string asset read: ${err.message}`);
  }
  try {
    const res = await fetch(mediaUrl, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
    result.media.noTicket = res.status;
    // When running locally and loopback is treated as trusted, can read even without a ticket;
    // skip checking this item (tickets are required only for non-loopback sources, auth-contract Section 8)
    result.media.loopbackTrusted = res.status === 200;
    if (res.status !== 200) check(res.status === 401, 'Reading an asset without a ticket returns 401', res.status);
  } catch (err) {
    fails.push(`Asset read without a ticket: ${err.message}`);
  }

  if (expectTasks === 0) return done();

  // Claim and complete task
  const counters = { artifactsWritten: 0 };
  const node = createLocalNode({
    nodeId: `sp-probe-member-${runId}`,
    node: { profile: 'host', envFingerprint: 'sp-probe-env', codeVersions: [], capabilities: {} },
    endpoint: ep,
    now: Date.now,
    maxConcurrent,
    executor: sleepExecutor(taskMs),
    sink: assetSink(client, counters),
    onEvent: (e) => {
      if (e.type === 'completed' || e.type === 'dedup') result.taskDone += 1;
      if (e.type === 'failed') fails.push(`Member node ${e.id} failed: ${e.error}`);
    },
  });
  ep.onMessage((m) => { if (m?.type === 'task.claimed') result.claims += 1; });
  node.start();
  const timer = setInterval(() => { try { node.tick(); } catch (err) { log('member.tick-error', { message: String(err?.message ?? err) }); } }, 50);
  await coord.put('member-ready', { at: Date.now() });
  const creatorDone = await coord.take('creator-done', deadline);
  clearInterval(timer);
  await node.settled().catch(() => {});
  node.stop();
  check(creatorDone, 'Waited until the creator reported creator-done');
  result.artifactsWritten = counters.artifactsWritten;
  check(result.taskDone >= expectTasks, `Completed at least ${expectTasks} tasks (actual ${result.taskDone})`);
  if (noLan) {
    result.noLan = await noLan.stop();
    check(result.noLan.tcpOk, `No new TCP connections to ${noLanIp} at any point (beyond the baseline, regardless of state; baseline ${result.noLan.baseline?.length ?? 0} entries, ${result.noLan.samples} samples, at most ${result.noLan.maxTcp} entries)`);
    check(result.noLan.discoveryOk, `LAN discovery finds 0 entries in 3 s (actual ${result.noLan.discovery?.hosts ?? result.noLan.discovery?.error})`);
  }
  return done();
}

/* ================================================================== inventory / migrate-check */

/**
 * Cluster token for management use (contract Section 11 ruling): environment variable
 * `PROMPTCUT_CLUSTER_TOKEN` → `<data-dir>/secrets/cluster-token` (`--data-dir` or environment
 * variable `PROMPTCUT_DATA_DIR`). The token itself is not printed to output.
 */
function adminToken() {
  const env = (process.env.PROMPTCUT_CLUSTER_TOKEN || '').trim();
  if (env) return { token: env, from: 'env' };
  const dir = arg('--data-dir', null) || process.env.PROMPTCUT_DATA_DIR || null;
  if (dir) {
    try {
      const t = fs.readFileSync(path.join(path.resolve(dir), 'secrets', 'cluster-token'), 'utf8').trim();
      if (t) return { token: t, from: 'file' };
    } catch { /* No such file */ }
  }
  return { token: null, from: null };
}

/** Format marker of the inventory file (written by `--role inventory`, read by `--from-inventory`) */
const INVENTORY_KIND = 'promptcut-hosted-inventory';
/** Two kinds of "ready layers" in content store: segment manifests (snapshot / stream) and layer table (`layers:<project id>`, also under `snapshot-manifest`) */
const READY_KINDS = Object.freeze(['snapshot-manifest', 'render-manifest']);
const HEX64 = /^[0-9a-f]{64}$/;
/** Fields in manifest body that are not chunk hashes (result key, content key, fingerprint may also be 64-character hex) */
const NOT_BLOB_FIELDS = new Set(['resultKey', 'key', 'contentKey', 'snapshotKey', 'envFingerprint', 'dirKey', 'entryKey', 'digest']);

/** Chunk hashes referenced by manifest body (64-character hex strings in snapshot frames / small, PNG cache, stream segments / inits), deduplicated and sorted */
function blobHashesOf(body) {
  const out = new Set();
  const walk = (v, field) => {
    if (NOT_BLOB_FIELDS.has(field)) return;
    if (typeof v === 'string') { if (HEX64.test(v)) out.add(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, null); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(body, null);
  return [...out].sort();
}

/** `--sample`: `all` means all; otherwise an integer not less than 1, defaults to 100 */
function sampleArg() {
  const raw = arg('--sample', undefined);
  if (raw === undefined) return 100;
  if (raw === 'all') return Infinity;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) usage('--sample must be all or an integer not less than 1');
  return n;
}

/**
 * An online hosted bundle: two `/healthz`, asset service address registered in
 * `service.endpoints`, admin inventory. When `assetArg` (`--asset` / `--to-asset` / `--from-asset`)
 * is provided, use its origin to call admin endpoints (loopback port forwarded via SSH on
 * Alibaba Cloud); registered address is still retrieved from document service (handshake with
 * token as admin identity; record null if unavailable).
 */
async function liveSide(label, url, { assetArg, token, headers, eps, createWsEndpoint, watchServiceEndpoints }) {
  const u = docUrls(url);
  const side = { label, doc: u.http, ws: u.ws, registeredAsset: null, adminOrigin: null, healthz: { docservice: 0, asset: 0 }, inv: null };
  let doc;
  try { doc = await getJson(`${u.http}/healthz`); } catch { doc = { status: 0 }; }
  side.healthz.docservice = doc.status;
  check(doc.status === 200 && doc.body?.ok, `${label}: document service /healthz`, doc.status);
  const ep = createWsEndpoint({ url: u.ws, ...(token ? { token } : {}), log: () => {} });
  eps.push(ep);
  if (await waitOpen(ep, 10_000)) side.registeredAsset = await waitAssetUrl(ep, watchServiceEndpoints);
  const adminBase = assetArg || side.registeredAsset;
  if (!check(adminBase, `${label}: got the asset service address (registered in service.endpoints, or --asset was given)`)) return side;
  side.adminOrigin = new URL(adminBase).origin;
  let asset;
  try { asset = await getJson(`${side.adminOrigin}/healthz`); } catch { asset = { status: 0 }; }
  side.healthz.asset = asset.status;
  check(asset.status === 200 && asset.body?.ok, `${label}: asset service /healthz`, asset.status);
  let inv;
  try { inv = await getJson(`${side.adminOrigin}/admin/inventory`, { headers, timeoutMs: 60_000 }); } catch (err) { inv = { status: 0, error: err.message }; }
  if (check(inv.status === 200 && inv.body?.ok, `${label}: GET /admin/inventory`, inv.status)) side.inv = inv.body;
  return side;
}

/**
 * Read "ready layers" across spaces in data directory (`--scan-dir`, read-only): under
 * `docservice/` and `docservice/tenants/<id>/`, two kinds in `content/*.ndjson`:
 * `snapshot-manifest` / `render-manifest`; for each key take the `hash` of the last entry
 * (last-write-wins, same as content store replay). Returns
 * `{ spaces: { <space>: { <kind>: { <key>: <hash> } } }, count }`.
 */
function scanReadyLayers(dataDir) {
  const root = path.join(path.resolve(dataDir), 'docservice');
  const dirs = [['local', root]];
  let tenants = [];
  try { tenants = fs.readdirSync(path.join(root, 'tenants'), { withFileTypes: true }); } catch { /* No tenants */ }
  for (const ent of tenants) if (ent.isDirectory()) dirs.push([ent.name, path.join(root, 'tenants', ent.name)]);
  const spaces = {};
  let count = 0;
  for (const [name, dir] of dirs.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const kinds = {};
    let files = [];
    try { files = fs.readdirSync(path.join(dir, 'content')).filter((f) => f.endsWith('.ndjson')); } catch { /* This space has no content store */ }
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(dir, 'content', f), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!READY_KINDS.includes(rec?.kind) || typeof rec.key !== 'string' || typeof rec.hash !== 'string') continue;
        (kinds[rec.kind] ??= {})[rec.key] = rec.hash;
      }
    }
    const sorted = {};
    for (const k of Object.keys(kinds).sort()) {
      sorted[k] = Object.fromEntries(Object.keys(kinds[k]).sort().map((key) => [key, kinds[k][key]]));
      count += Object.keys(kinds[k]).length;
    }
    if (Object.keys(sorted).length) spaces[name] = sorted;
  }
  return { spaces, count };
}

/** Read seed file (written by `m8-migrate-probe.mjs --step seed`, contains passphrases for probe self-created projects; do not print) */
function readSeed(file) {
  const seed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (seed?.kind !== 'promptcut-m8-seed' || !Array.isArray(seed.projects)) throw new Error(`${file} is not a seed file`);
  return seed;
}

/**
 * Enter each project in seed as creator (render role, do not modify project), recording:
 * current `projectRev` and summary (`project.open`), keys and hashes of two kinds of manifests in
 * content store (`content.list`), and chunk hashes referenced by each segment manifest. When
 * `verifyBlobs` is true, also retrieve each chunk one by one via data plane (asset service
 * address taken from this instance's `service.endpoints`, with ticket) and recalculate sha256.
 */
async function seededLayers(docUrl, seed, { verifyBlobs = false, eps, labelPrefix }) {
  const [{ buildAuthProtocols }, { createDocEndpoint }, { watchServiceEndpoints }, { createTicketSource }, { createAssetClient }] = await Promise.all([
    mod('server/auth/client.mjs'), mod('server/render-node/session-link.mjs'), mod('server/render-node/endpoint.mjs'),
    mod('server/auth/ticket-source.mjs'), mod('server/asset-store/client.mjs'),
  ]);
  const urls = docUrls(docUrl);
  const out = [];
  for (const p of seed.projects) {
    const label = `${labelPrefix}: seed project ${p.name}`;
    const row = { projectId: p.projectId, name: p.name, projectRev: null, digest: null, layers: {}, truncated: false, blobs: 0, assetUrl: null, verified: null };
    out.push(row);
    let key = null;
    const protocols = () => buildAuthProtocols({
      base: urls.http, projectId: p.projectId, username: p.creator.username, deviceId: p.deviceId, deviceName: 'm8-migrate-inventory', as: 'creator',
      ...(key ? { key } : { password: p.creator.password }), role: 'render', onKey: (k) => { key = k; },
    });
    const ep = createDocEndpoint({ url: urls.ws, protocols, log: () => {} });
    eps.push(ep);
    const rpc = rpcOn(ep);
    if (!check(await waitOpen(ep), `${label}: entered with the creator passphrase`)) continue;
    try {
      const st = await rpc({ type: 'project.open', projectId: p.projectId }, { until: (m) => m.type === 'project.state' || m.type === 'project.state.end' });
      const head = st.find((m) => m.type === 'project.state');
      row.projectRev = head?.projectRev ?? head?.rev ?? null;
      row.digest = head?.digest ?? null;
      await rpc({ type: 'project.close', projectId: p.projectId }).catch(() => {});
    } catch (err) {
      fails.push(`${label}: project.open ${err.message}`);
    }
    const all = new Map();
    for (const kind of READY_KINDS) {
      try {
        const listing = await rpc({ type: 'content.list', kind });
        if (listing.truncated) row.truncated = true;
        row.layers[kind] = Object.fromEntries((listing.items ?? []).map((it) => [it.key, it.hash]));
      } catch (err) {
        fails.push(`${label}: content.list ${kind} ${err.message}`);
      }
      for (const k of Object.keys(row.layers[kind] ?? {})) {
        try {
          const item = await rpc({ type: 'content.get', kind, key: k });
          for (const h of blobHashesOf(item.body)) all.set(h, k);
        } catch (err) {
          fails.push(`${label}: content.get ${kind} ${k} ${err.message}`);
        }
      }
    }
    check(!row.truncated, `${label}: manifest was not truncated (no more than 1000 entries)`);
    row.blobs = all.size;
    if (!verifyBlobs) continue;
    const assetUrl = await waitAssetUrl(ep, watchServiceEndpoints);
    row.assetUrl = assetUrl;
    if (!check(assetUrl, `${label}: got the asset service address from service.endpoints`)) continue;
    const client = createAssetClient({ base: assetUrl, ticket: createTicketSource(ep, { access: 'r' }) });
    let ok = 0;
    const bad = [];
    for (const h of all.keys()) {
      let got = null;
      for (const ns of ['snap', 'px', 'media']) {
        try {
          got = await client.get(ns, h);
        } catch (err) {
          got = null;
          bad.push({ ns, hash: h, error: err.code ?? err.message });
        }
        if (got) break;
      }
      if (got && sha256(got) === h) ok += 1;
      else if (!got && !bad.some((b) => b.hash === h)) bad.push({ hash: h, missing: true });
    }
    row.verified = { total: all.size, ok, ratio: all.size ? ok / all.size : 1, bad: bad.slice(0, 5) };
    check(ok === all.size, `${label}: all chunks referenced by the manifest were retrieved over the data plane with tickets, sha256 matches (${ok}/${all.size})`, row.verified.bad);
  }
  return out;
}

async function runInventory() {
  const hosted = arg('--hosted', null);
  const outFile = arg('--out', null);
  const scanDir = arg('--scan-dir', null);
  const seedFile = arg('--seed', null);
  if (!outFile) usage('inventory needs --out <file>');
  if (!hosted && !scanDir) usage('inventory needs --hosted <document service address> (online inventory) or --scan-dir <data directory> (read-only scan of the ready layers), or both');
  const { token, from: tokenFrom } = adminToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const [{ createWsEndpoint }, { watchServiceEndpoints }] = await Promise.all([
    mod('server/render-node/ws-transport.mjs'), mod('server/render-node/endpoint.mjs'),
  ]);
  const result = { ok: false, role: 'inventory', out: path.resolve(outFile), admin: token ? 'token' : 'loopback', tokenFrom, source: null, summary: null };
  const eps = [];
  const done = async (code) => { await closeAll(eps); finish(result, code); };
  const file = { v: 1, kind: INVENTORY_KIND, takenAt: new Date().toISOString(), source: null, healthz: null, inventory: null, seeded: null, readyLayers: null };

  if (hosted) {
    const side = await liveSide('Source', hosted, { assetArg: arg('--asset', null), token, headers, eps, createWsEndpoint, watchServiceEndpoints });
    file.source = { doc: side.doc, adminOrigin: side.adminOrigin, registeredAsset: side.registeredAsset, via: 'http' };
    file.healthz = side.healthz;
    file.inventory = side.inv;
    result.source = file.source;
    if (side.inv && seedFile) {
      let seed;
      try { seed = readSeed(seedFile); } catch (err) { fails.push(`Reading seed file: ${err.message}`); }
      if (seed) file.seeded = await seededLayers(hosted, seed, { verifyBlobs: true, eps, labelPrefix: 'Source' });
    }
  }
  if (scanDir) file.readyLayers = { dataDir: path.resolve(scanDir), ...scanReadyLayers(scanDir) };

  const inv = file.inventory;
  result.summary = {
    sharedProjects: inv?.sharedProjects?.length ?? null,
    spaces: inv ? Object.keys(inv.spaces ?? {}).length : null,
    projects: inv ? Object.values(inv.spaces ?? {}).reduce((n, s) => n + Object.keys(s.projects ?? {}).length, 0) : null,
    assets: inv ? Object.fromEntries(Object.entries(inv.assets ?? {}).map(([ns, a]) => [ns, { count: a.count, bytes: a.bytes }])) : null,
    seeded: file.seeded?.map((s) => ({ projectId: s.projectId, projectRev: s.projectRev, layers: Object.values(s.layers).reduce((n, m) => n + Object.keys(m).length, 0), blobs: s.blobs, verified: s.verified?.ratio ?? null })) ?? null,
    readyLayers: file.readyLayers?.count ?? null,
  };
  if (fails.length === 0) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(path.resolve(outFile), `${JSON.stringify(file, null, 1)}\n`);
  } else {
    result.out = null;
  }
  return done();
}

/**
 * Compare two inventories item by item (`hosting-migration.md` steps 6 and 7): shared projects,
 * each space's `projectRev` / snapshot count / content store entry count, and hash sets and byte
 * counts of three namespaces. Returns `{ projects, revs, all }`, where `all` is all `[ns, hash]`
 * on the new instance (for spot-checking).
 */
function compareInventories(a, b, result) {
  const shared = (inv) => JSON.stringify((inv.sharedProjects ?? []).map((p) => [p.projectId, p.name, p.mode]));
  result.sharedProjects = { from: a.sharedProjects?.length ?? null, to: b.sharedProjects?.length ?? null, equal: shared(a) === shared(b) };
  check(result.sharedProjects.equal, 'Shared projects (id, name, mode) match', result.sharedProjects);
  const spaceNames = [...new Set([...Object.keys(a.spaces ?? {}), ...Object.keys(b.spaces ?? {})])].sort();
  const revMismatch = [];
  const revs = { projects: 0, equal: 0, zeroed: 0, behind: 0, ahead: 0 };
  let contentItems = 0;
  let snapshots = 0;
  for (const s of spaceNames) {
    const x = a.spaces?.[s];
    const y = b.spaces?.[s];
    if (!x || !y) { revMismatch.push({ space: s, missing: !x ? 'from' : 'to' }); continue; }
    for (const pid of new Set([...Object.keys(x.projects), ...Object.keys(y.projects)])) {
      revs.projects += 1;
      const rf = x.projects[pid];
      const rt = y.projects[pid];
      if (rf === rt) { revs.equal += 1; continue; }
      if ((rt ?? 0) === 0 && (rf ?? 0) > 0) revs.zeroed += 1;
      else if ((rt ?? 0) < (rf ?? 0)) revs.behind += 1;
      else revs.ahead += 1;
      revMismatch.push({ space: s, projectId: pid, from: rf ?? null, to: rt ?? null });
    }
    if (x.snapshots !== y.snapshots) revMismatch.push({ space: s, snapshots: [x.snapshots, y.snapshots] });
    if (JSON.stringify(x.content) !== JSON.stringify(y.content)) revMismatch.push({ space: s, content: [x.content, y.content] });
    snapshots += x.snapshots;
    contentItems += Object.values(x.content).reduce((n, v) => n + v, 0);
  }
  result.spaces = { count: spaceNames.length, projects: revs.projects, snapshots, contentItems, mismatches: revMismatch };
  result.revs = revs;
  check(revs.zeroed === 0, 'projectRev was not reset to zero', revs);
  check(revMismatch.length === 0, 'projectRev, snapshot count, and content store item count match in each namespace', revMismatch.slice(0, 5));
  const all = [];
  for (const ns of ['media', 'snap', 'px']) {
    const x = a.assets?.[ns] ?? { count: -1, bytes: -1, hashes: [] };
    const y = b.assets?.[ns] ?? { count: -1, bytes: -1, hashes: [] };
    const equal = x.count === y.count && x.bytes === y.bytes && JSON.stringify(x.hashes) === JSON.stringify(y.hashes);
    result.assets[ns] = { from: x.count, to: y.count, bytes: [x.bytes, y.bytes], equal };
    check(equal, `${ns}: hash set and byte count match`, result.assets[ns]);
    for (const h of y.hashes) all.push([ns, h]);
  }
  return { projects: revs.projects, all };
}

/** Retrieve from new instance by hash (admin API) and recalculate sha256; uniformly sample up to `sample` items (`Infinity` = all) */
async function sampleBlobs(origin, headers, all, sample) {
  const step = all.length <= sample ? 1 : all.length / sample;
  const picked = [];
  for (let i = 0; picked.length < Math.min(sample, all.length); i += 1) picked.push(all[Math.floor(i * step)]);
  let ok = 0;
  let bytes = 0;
  const bad = [];
  for (const [ns, h] of picked) {
    try {
      const res = await fetch(`${origin}/admin/blob/${ns}/${h}`, { headers, signal: AbortSignal.timeout(120_000) });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status === 200 && sha256(buf) === h) { ok += 1; bytes += buf.length; } else bad.push({ ns, hash: h, status: res.status });
    } catch (err) {
      bad.push({ ns, hash: h, error: err.message });
    }
  }
  return { total: all.length, checked: picked.length, ok, bytes, ratio: picked.length ? ok / picked.length : 1, bad: bad.slice(0, 10) };
}

async function runMigrateCheck() {
  const from = arg('--from', null);
  const inventoryFile = arg('--from-inventory', null);
  const to = arg('--to', null);
  if (!to || (!from && !inventoryFile)) usage('migrate-check needs --to, plus --from (both sides online at the same time) or --from-inventory (the inventory file from before the migration)');
  if (from && inventoryFile) usage('Give only one of --from and --from-inventory');
  const sample = sampleArg();
  const { token, from: tokenFrom } = adminToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const [{ createWsEndpoint }, { watchServiceEndpoints }] = await Promise.all([
    mod('server/render-node/ws-transport.mjs'), mod('server/render-node/endpoint.mjs'),
  ]);
  const result = {
    ok: false, role: 'migrate-check', from: null, to: null, fromInventory: inventoryFile ? path.resolve(inventoryFile) : null, inventoryTakenAt: null,
    admin: token ? 'token' : 'loopback', tokenFrom, healthz: {}, assetUrls: {}, sharedProjects: null, spaces: null, revs: null, assets: {}, sample: null,
    registeredAssetTo: null, seeded: null, readyLayers: null,
  };
  const eps = [];
  const done = async (code) => { await closeAll(eps); finish(result, code); };
  const ctx = { token, headers, eps, createWsEndpoint, watchServiceEndpoints };

  // Old side: online, or read inventory file
  let a = null;
  let file = null;
  if (inventoryFile) {
    try {
      file = JSON.parse(fs.readFileSync(path.resolve(inventoryFile), 'utf8'));
    } catch (err) {
      fails.push(`Reading inventory file: ${err.message}`);
      return done(2);
    }
    if (!check(file?.kind === INVENTORY_KIND && file.inventory?.ok, 'Inventory file has the right format and includes the online inventory')) return done(2);
    a = file.inventory;
    result.from = file.source?.doc ?? null;
    result.inventoryTakenAt = file.takenAt ?? null;
    result.healthz.from = file.healthz ?? null;
    result.assetUrls.from = a.assetPublicUrl ?? file.source?.registeredAsset ?? null;
  } else {
    const side = await liveSide('from', from, { assetArg: arg('--from-asset', null), ...ctx });
    result.from = side.doc;
    result.healthz.from = side.healthz;
    result.assetUrls.from = side.inv?.assetPublicUrl ?? side.registeredAsset;
    a = side.inv;
  }
  const toSide = await liveSide('to', to, { assetArg: arg('--to-asset', null), ...ctx });
  result.to = toSide.doc;
  result.healthz.to = toSide.healthz;
  result.assetUrls.to = toSide.inv?.assetPublicUrl ?? toSide.registeredAsset;
  result.registeredAssetTo = toSide.registeredAsset;
  if (!a || !toSide.inv) return done();
  check(result.assetUrls.from !== result.assetUrls.to, 'The new instance registered its own asset service address (different from the old one)', result.assetUrls);
  if (toSide.registeredAsset) check(toSide.registeredAsset === toSide.inv.assetPublicUrl, 'The asset address in the new instance\'s service.endpoints is the public address it is configured with', result.assetUrls);

  const { projects, all } = compareInventories(a, toSide.inv, result);
  result.sample = await sampleBlobs(toSide.adminOrigin, headers, all, sample);
  check(result.sample.bad.length === 0 && result.sample.ok === result.sample.checked, `Everything fetched by hash matches (${result.sample.ok}/${result.sample.checked})`, result.sample);
  check(all.length > 0 || projects > 0, 'There is data to compare (empty vs. empty does not count as a pass)');

  // Seed projects: enter new instance; manifest keys, hashes, and projectRev match inventory;
  // chunks referenced by manifests are all retrieved via data plane
  const seedFile = arg('--seed', null);
  if (seedFile) {
    let seed = null;
    try { seed = readSeed(seedFile); } catch (err) { fails.push(`Reading seed file: ${err.message}`); }
    if (seed) {
      const now = await seededLayers(to, seed, { verifyBlobs: true, eps, labelPrefix: 'New instance' });
      const before = new Map((file?.seeded ?? []).map((s) => [s.projectId, s]));
      result.seeded = now.map((s) => {
        const b = before.get(s.projectId) ?? null;
        const row = { projectId: s.projectId, projectRev: [b?.projectRev ?? null, s.projectRev], layers: Object.values(s.layers).reduce((n, m) => n + Object.keys(m).length, 0), blobs: s.blobs, verified: s.verified };
        if (b) {
          check(b.projectRev === s.projectRev, `Seed project ${s.name}: projectRev matches the inventory (continuous, not reset to zero)`, row.projectRev);
          check(b.digest === s.digest, `Seed project ${s.name}: project digest matches the inventory`);
          check(JSON.stringify(b.layers) === JSON.stringify(s.layers), `Seed project ${s.name}: ready layers (manifest keys and hashes) match the inventory`);
        } else if (file) {
          fails.push(`Seed project ${s.name}: not in the inventory file (--seed was not given when taking the inventory)`);
        }
        return row;
      });
    }
  }
  // Ready layers scanned from data directory: compare key by key when present in inventory
  // and --scan-dir (data directory of new instance) is provided this time
  const scanDir = arg('--scan-dir', null);
  if (scanDir) {
    const now = scanReadyLayers(scanDir);
    const was = file?.readyLayers ?? null;
    result.readyLayers = { to: now.count, from: was?.count ?? null, equal: was ? JSON.stringify(was.spaces) === JSON.stringify(now.spaces) : null };
    if (was) check(result.readyLayers.equal, 'Ready layers in the data directory (keys and hashes of both kinds of manifests) match the inventory', result.readyLayers);
  }
  return done();
}

/* ================================================================== coord */

async function runCoord() {
  const port = intArg('--port', 0, 0);
  const host = arg('--host', '127.0.0.1');
  const coord = await startCoordServer({ port, host });
  log('coord.listen', { url: `http://${host}:${coord.port}`, host: os.hostname() });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { void coord.close().then(() => { process.exitCode = 0; }); });
}

/* ------------------------------------------------------------------ Main flow */

if (ROLE === 'migrate-check') await runMigrateCheck();
else if (ROLE === 'inventory') await runInventory();
else if (ROLE === 'coord') await runCoord();
else if (MODE === 'internet' && ROLE === 'creator') await runCreator();
else if (MODE === 'internet' && ROLE === 'member') await runMember();
else if (MODE === 'lan') await (await import('./shared-project-lan.mjs')).runLan(ROLE, argv);
else usage(argv.length ? 'Invalid arguments' : undefined);
