/**
 * LAN mode for the shared project probe (contract `docs/plan/shared-project-contract.md`
 * section 6 `--mode lan`, section 7 SP4 / SP2).
 * Called by `shared-project-probe.mjs` via `runLan(role, argv)` when `--mode lan`; placed in a
 * separate file so that integration does not interfere with the Internet mode parts.
 *
 * ## --mode lan --role creator
 *
 *   node scripts/probes/shared-project-probe.mjs --mode lan --role creator [--port 5480] [--state <dir>] [--coord <url>]
 *        [--name <project-name>] [--tasks 3] [--hold-min 10] [--timeout-ms 180000] [--keep]
 *
 *   1. Start LAN host: worktree editor (vite, `--port`, without `--host`), environment variable
 *      `PROMPTCUT_LAN_HOST=1` makes it bind to `0.0.0.0`; wait for `/api/docservice/healthz`, then
 *      access shared endpoint from local LAN address to verify editor is reachable over LAN
 *      (`editorOnLan`);
 *   2. Create an open-entry LAN mode project from local loopback (`route.mjs`'s
 *      `createSharedProject({ where: 'lan' })`), and editor starts broadcasting: wait for
 *      `lan.start` in editor logs and run discovery once on itself (`selfDiscoverMs`);
 *   3. Connect to document service with local assertion (`promptcut.tenant.<projectId>`, loopback):
 *      upload an asset (loopback does not require a ticket), register a project revision, upload
 *      a snapshot (the snapshot contains asset hashes and task count), and publish `--tasks` mock
 *      fine-grained tasks as the publisher (same as `render-queue-e2e.mjs`);
 *   4. Write what member needs (project name, project passphrase, task count):
 *      `<state>/lan-member.json`; when `--coord` is provided, also `PUT /kv/lan-member`
 *      (coordination endpoint format matches `--role coord` in Internet mode);
 *   5. Wait for all `task.done` (`completed`, `duplicateDone`), then wait for member results
 *      (`<state>/lan-member-result.json` or coordination endpoint `lan-member-result`,
 *      up to `--hold-min` minutes);
 *   6. Delete project as a creator action (`shared.admin { op: 'delete' }`), run discovery once
 *      more to confirm it is no longer found (`goneAfterDelete`); do not delete when `--keep`;
 *   7. Shut down editor (only terminates the process tree it started), output a single JSON line.
 *
 * ## --mode lan --role member [--manual <url>]
 *
 *   node scripts/probes/shared-project-probe.mjs --mode lan --role member [--state <dir>] [--coord <url>]
 *        [--name <project-name> --password <passphrase>] [--manual <http://192.168.x.y:port>] [--hosted <url>] [--expect-tasks <n>] [--timeout-ms 120000]
 *
 *   1. Take project name and passphrase from arguments; if not provided, read
 *      `<state>/lan-member.json` (or coordination endpoint `lan-member`);
 *   2. Discovery: `findSharedProject({ name, hostedUrl: null, lan: { discover: discoverLan, manual } })`,
 *      recording discovery duration (`discovery.ms`) and timestamp when host was first seen
 *      (`discovery.firstSeenMs`). Do not query hosted side when `--hosted` is omitted
 *      (no connection to hosted side throughout, SP4);
 *   3. Admin interface is unreachable from LAN sources (SP2): handshakes without credentials or
 *      with cluster token format both return 401;
 *   4. Enter with project credentials (`page`): read project snapshot (verify digest), read asset
 *      without ticket returns 401, read asset with ticket returns 200 and matches sha256;
 *   5. Claim and complete tasks with `render` role (at least 1, defaults to task count published by creator);
 *   6. Write `<state>/lan-member-result.json` (and coordination endpoint `lan-member-result`),
 *      output a single JSON line.
 *
 * Running on the same machine: member connects to editor via local LAN address (not loopback);
 * server sees the source as a LAN address and follows the LAN member path.
 * Passphrase is only written to state directory and coordination endpoint (disposable project created
 * by probe) and is not printed to output.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { coordClient as kvClient } from './probe-coord.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = (rel) => import(new URL(`../../${rel}`, import.meta.url));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** Workflow aborted midway: reason is already recorded in fails, skip to finalize */
const STOP = Symbol('stop');

function makeArgs(argv) {
  const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const flag = (name) => argv.includes(name);
  const int = (name, fallback) => {
    const v = arg(name, undefined);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
    return n;
  };
  return { arg, flag, int };
}

/* ------------------------------------------------------------------ Common utilities */

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
};

/** Coordination endpoint client (`probe-coord.mjs`: `PUT /kv/<key>`, `GET /kv/<key>?wait=<ms>`, same as coordination endpoint in Internet mode and render-host-probe); returns null if no address provided */
const coordClient = (base) => (base ? kvClient(base) : null);

/** Wait for key in state file or coordination endpoint to appear */
async function waitShared({ state, coord, file, key, ms }) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (fsSync.existsSync(path.join(state, file))) {
      try { return await readJson(path.join(state, file)); } catch { /* Writing */ }
    }
    if (coord) {
      try {
        const v = await coord.get(key, Math.min(2000, Math.max(0, deadline - Date.now())));
        if (v) return v;
      } catch { /* Coordination endpoint is not up yet */ }
    } else {
      await delay(300);
    }
    if (Date.now() > deadline) return null;
  }
}

/** One WebSocket: wait for response by reqId, wait for messages matching condition */
function openWs(url, protocols) {
  const ws = new WebSocket(url, protocols);
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    const i = waiters.findIndex((w) => w.match(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('Connection failed')), { once: true });
  });
  opened.catch(() => {});
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }), { once: true }));
  const next = (match, ms = 15_000) => {
    const i = inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => {
        const k = waiters.indexOf(w);
        if (k >= 0) { waiters.splice(k, 1); reject(new Error('Timed out waiting for a message')); }
      }, ms).unref?.();
    });
  };
  let seq = 0;
  const request = (msg, ms) => {
    const reqId = `r${++seq}`;
    ws.send(JSON.stringify({ ...msg, reqId }));
    return next((m) => m.reqId === reqId, ms);
  };
  const close = async () => {
    if (ws.readyState === WebSocket.CLOSED) return;
    try { ws.close(1000, 'probe done'); } catch { /* Closed */ }
    await Promise.race([closed, delay(3000)]);
  };
  return { ws, opened, closed, next, request, inbox, close, send: (m) => ws.send(JSON.stringify(m)) };
}

/** Raw WebSocket handshake, only need status code */
function handshakeStatus(host, port, pathName, protocols) {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    let buf = '';
    const done = (v) => { try { sock.destroy(); } catch { /* Closed */ } resolve(v); };
    const t = setTimeout(() => done(null), 5000);
    sock.on('error', () => { clearTimeout(t); done(null); });
    sock.on('connect', () => {
      const lines = [`GET ${pathName} HTTP/1.1`, `Host: ${host}:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13'];
      if (protocols) lines.push(`Sec-WebSocket-Protocol: ${protocols.join(', ')}`);
      sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n');
      if (end > 0) { clearTimeout(t); done(Number(buf.slice(0, end).split(' ')[1])); }
    });
  });
}

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGKILL');
}
const exited = (child, ms = 20_000) => new Promise((resolve) => {
  if (!child || child.exitCode !== null) return resolve(child?.exitCode ?? null);
  const t = setTimeout(() => resolve(null), ms);
  t.unref?.();
  child.once('exit', (code) => { clearTimeout(t); resolve(code); });
});
const portFree = (port, host) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, host, () => s.close(() => resolve(true)));
});

/**
 * Print result line, set exit code, and let process exit naturally (same as `finish` in
 * `shared-project-probe.mjs`): on Windows, calling `process.exit` while handles are still closing
 * causes libuv to crash on assertion (0xC0000409). Force exit only if handles still pending after 10 s.
 */
function finish(result, code) {
  result.ok = code === 0;
  process.exitCode = code;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  setTimeout(() => process.exit(code), 10_000).unref();
}

/* ------------------------------------------------------------------ creator */

async function runCreator(argv) {
  const { arg, flag, int } = makeArgs(argv);
  const port = int('--port', 5480);
  const state = path.resolve(arg('--state', path.join(os.tmpdir(), 'pc-shared-project-lan')));
  const coord = coordClient(arg('--coord', null));
  const name = arg('--name', `lan-probe-${randomBytes(3).toString('hex')}`);
  const taskCount = Math.max(1, int('--tasks', 3));
  const holdMs = int('--hold-min', 10) * 60_000;
  const timeoutMs = int('--timeout-ms', 180_000);
  const keep = flag('--keep');
  const fails = [];
  const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 400)}`)); return cond; };
  const result = { ok: false, mode: 'lan', role: 'creator', port, name, projectId: null, lanAddress: null, editorOnLan: false, broadcasting: false,
    selfDiscoverMs: null, published: 0, completed: 0, duplicateDone: 0, member: null, goneAfterDelete: null, fails };

  const [{ selectInterfaces, discoverLan }, { createSharedProject }, { deriveKey, adminProof }, { createAssetClient }, { snapshotTaskInput }] = await Promise.all([
    mod('server/lan/discovery.mjs'), mod('server/auth/route.mjs'), mod('server/auth/client.mjs'), mod('server/asset-store/client.mjs'), mod('server/test/fake-ws-kit.mjs'),
  ]);

  await fs.rm(path.join(state, 'lan-member.json'), { force: true });
  await fs.rm(path.join(state, 'lan-member-result.json'), { force: true });
  await fs.mkdir(state, { recursive: true });
  const lanIface = selectInterfaces()[0];
  if (!check(lanIface, 'No usable LAN network interface on this machine')) return finish(result, 2);
  result.lanAddress = lanIface.address;
  for (const p of [port, port + 1, port + 2]) {
    check(await portFree(p, '127.0.0.1') && await portFree(p, '0.0.0.0'), `Port ${p} is free`);
  }
  if (fails.length) return finish(result, 2);

  // 1. Start LAN host
  const env = { ...process.env };
  for (const k of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_SHARED_CONFIG', 'PROMPTCUT_HEADLESS', 'PROMPTCUT_ROLE', 'PROMPTCUT_ASSET_URL', 'PROMPTCUT_HOSTED_URL']) delete env[k];
  const tmp = path.join(state, 'tmp');
  fsSync.mkdirSync(tmp, { recursive: true });
  fsSync.mkdirSync(path.join(state, 'data'), { recursive: true });
  Object.assign(env, { PROMPTCUT_LAN_HOST: '1', PROMPTCUT_DEVICE_NAME: 'lan-probe-host', PROMPTCUT_EXPORT_DIR: state, PROMPTCUT_DATA_DIR: path.join(state, 'data'),
    PROMPTCUT_STREAMS: '0', TEMP: tmp, TMP: tmp, TMPDIR: tmp });
  const child = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  const log = [];
  const keepLog = (c) => { for (const line of c.toString().split(/\r?\n/)) if (line) log.push(line); if (log.length > 2000) log.splice(0, log.length - 2000); };
  child.stdout.on('data', keepLog);
  child.stderr.on('data', keepLog);
  const editor = `http://127.0.0.1:${port}`;
  const lanBase = `http://${lanIface.address}:${port}`;
  let ws = null;
  try {
    const t0 = Date.now();
    for (;;) {
      const ok = await fetch(`${editor}/api/docservice/healthz`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
      if (ok) break;
      if (child.exitCode !== null) { check(false, 'Editor exited early', log.slice(-20)); throw STOP; }
      if (Date.now() - t0 > timeoutMs) { check(false, 'Editor did not start', log.slice(-20)); throw STOP; }
      await delay(500);
    }
    const lanProbe = await fetch(`${lanBase}/docservice/shared/lookup?name=__none__`, { signal: AbortSignal.timeout(5000) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })).catch((e) => ({ error: String(e?.message ?? e) }));
    result.editorOnLan = check(lanProbe.status === 404 && lanProbe.body?.error === 'no-project', 'Editor is reachable on the LAN address (bound to 0.0.0.0)', lanProbe);

    // 2. Create project (loopback), start broadcasting
    const creatorPw = randomBytes(12).toString('base64url');
    const projectPw = randomBytes(12).toString('base64url');
    const created = await createSharedProject({ where: 'lan', lanBase: `ws://127.0.0.1:${port}/docservice`, name, mode: 'free', creator: { username: 'lan-creator', password: creatorPw }, password: projectPw });
    result.projectId = created.projectId;
    const tStart = Date.now();
    for (;;) {
      if (log.some((l) => l.includes('lan.start'))) { result.broadcasting = true; break; }
      if (Date.now() - tStart > 10_000) break;
      await delay(100);
    }
    check(result.broadcasting, 'Editor log contains lan.start', log.filter((l) => l.includes('lan.')).slice(-5));
    const selfT0 = Date.now();
    const self = await discoverLan({ name });
    result.selfDiscoverMs = self.hosts.length ? Date.now() - selfT0 : null;
    result.selfFirstSeenMs = self.hosts[0]?.firstSeenMs ?? null;
    check(self.hosts.some((h) => h.projectId === created.projectId && h.docservice === `ws://${lanIface.address}:${port}/docservice`), 'It can discover its own broadcast', self);

    // 3. Asset, snapshot, tasks (local assertion, loopback)
    const media = randomBytes(256 * 1024);
    const assetHash = sha256(media);
    const put = await createAssetClient({ base: `${editor}/api/asset` }).put('media', media, { ext: 'bin' });
    check(put.hash === assetHash, 'Asset upload', put);
    ws = openWs(`ws://127.0.0.1:${port}/docservice`, ['promptcut.v1', `promptcut.tenant.${created.projectId}`, 'promptcut.role.page']);
    await ws.opened;
    const snapshot = JSON.stringify({ probe: 'shared-project-lan', projectId: created.projectId, name, assets: [assetHash], tasks: taskCount, at: Date.now() });
    const digest = sha256(snapshot);
    const ann = await ws.request({ type: 'project.announce', projectId: created.projectId, digest, session: 'lan-probe' });
    check(ann.type === 'project.announced', 'project.announce', ann);
    const stored = await ws.request({ type: 'project.snapshot.put', projectId: created.projectId, projectRev: ann.projectRev, digest, index: 0, count: 1, data: snapshot });
    check(stored.type === 'project.snapshot.stored' && stored.complete === true, 'Project snapshot', stored);
    const runId = randomBytes(3).toString('hex');
    const tasks = Array.from({ length: taskCount }, (_, i) => snapshotTaskInput({ resultKey: `lan-${runId}-${i}`, projectId: created.projectId, projectRev: ann.projectRev }));
    const ids = new Set(tasks.map((x) => x.id));
    const done = new Map();
    ws.ws.addEventListener('message', (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'task.done' && ids.has(m.id)) {
        if (done.has(m.id)) result.duplicateDone += 1;
        else done.set(m.id, Date.now());
        result.completed = done.size;
      }
    });
    const hello = await ws.request({ type: 'publisher.hello', publisherId: `lan-pub-${runId}` });
    check(hello.type === 'publisher.welcome', 'publisher.hello', hello);
    const pub = await ws.request({ type: 'task.publish', tasks });
    check(pub.type === 'task.published' && (pub.results ?? []).every((r) => !r.error), 'task.publish', pub);
    result.published = tasks.length;

    // 4. Hand off to member
    const info = { name, password: projectPw, tasks: taskCount, host: lanIface.address, port };
    await writeJson(path.join(state, 'lan-member.json'), info);
    if (coord) await coord.put('lan-member', info).catch((e) => check(false, 'Coordinator PUT lan-member', String(e?.message ?? e)));

    // 5. Wait for completion and member result
    const deadline = Date.now() + Math.max(timeoutMs, 0);
    while (done.size < tasks.length && Date.now() < deadline) await delay(200);
    await delay(300);
    check(done.size === tasks.length, `All task.done received (${done.size}/${tasks.length})`);
    check(result.duplicateDone === 0, 'No duplicate task.done');
    result.member = await waitShared({ state, coord, file: 'lan-member-result.json', key: 'lan-member-result', ms: holdMs });
    if (result.member) check(result.member.ok === true, 'Member result ok', result.member.fails);
    else check(false, `No member result within ${holdMs / 60_000} minutes`);

    // 6. Delete project: stop announcing this project
    if (!keep) {
      const ch = await ws.request({ type: 'shared.challenge' });
      if (check(ch.type === 'shared.challenge.ok', 'shared.challenge', ch)) {
        const key = await deriveKey(creatorPw, ch.salt, ch.kdf);
        const m = await adminProof({ key, projectId: created.projectId, username: 'lan-creator', op: 'delete', nonce: ch.nonce });
        const del = await ws.request({ type: 'shared.admin', op: 'delete', proof: { nonce: ch.nonce, m } });
        check(del.type === 'shared.admin.ok', 'shared.admin delete', del);
        await delay(300);
        const after = await discoverLan({ name });
        result.goneAfterDelete = after.hosts.length === 0;
        check(result.goneAfterDelete, 'Not discoverable after deletion', after.hosts);
        result.lanStopLogged = log.some((l) => l.includes('lan.stop'));
      }
    }
  } catch (err) {
    if (err !== STOP) check(false, 'Creator flow failed', String(err?.stack ?? err));
  } finally {
    await ws?.close();
    killTree(child);
    await exited(child);
    result.lanLog = log.filter((l) => /\blan\./.test(l)).slice(-10);
  }
  finish(result, fails.length ? 1 : 0);
}

/* ------------------------------------------------------------------ member */

async function runMember(argv) {
  const { arg, int } = makeArgs(argv);
  const state = path.resolve(arg('--state', path.join(os.tmpdir(), 'pc-shared-project-lan')));
  const coord = coordClient(arg('--coord', null));
  const timeoutMs = int('--timeout-ms', 120_000);
  const manual = argv.flatMap((a, i) => (a === '--manual' ? [argv[i + 1]] : [])).filter(Boolean);
  const hosted = arg('--hosted', null);
  const fails = [];
  const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 400)}`)); return cond; };
  const result = { ok: false, mode: 'lan', role: 'member', name: null, hosted: hosted ? 'asked' : 'skipped', discovery: null, candidate: null,
    adminFromLan: null, handshake: null, snapshot: null, asset: null, render: null, fails };

  let name = arg('--name', null);
  let password = arg('--password', null);
  let expect = int('--expect-tasks', null);
  if (!name || !password) {
    const info = await waitShared({ state, coord, file: 'lan-member.json', key: 'lan-member', ms: timeoutMs });
    if (!info) { check(false, 'Could not get the project name and passphrase (--name/--password, state, or coordinator)'); return finish(result, 2); }
    name ??= info.name;
    password ??= info.password;
    expect ??= info.tasks;
  }
  expect = Math.max(1, expect ?? 1);
  result.name = name;

  const [{ discoverLan }, { findSharedProject, pickRoute, wsBaseOf }, { buildAuthProtocols }, { createDocEndpoint }, { createLocalNode }, { createArtifactSink }, { createSleepExecutor }] = await Promise.all([
    mod('server/lan/discovery.mjs'), mod('server/auth/route.mjs'), mod('server/auth/client.mjs'), mod('server/render-node/session-link.mjs'),
    mod('server/render-node/local-node.mjs'), mod('server/test/fake-artifact-sink.mjs'), mod('server/test/fake-ws-kit.mjs'),
  ]);

  const deviceId = `lan-member-${randomBytes(6).toString('hex')}`;
  const deviceName = `lan-member-${os.hostname()}`.slice(0, 64);
  const eps = [];
  let ws = null;
  try {
    // 2. Discovery
    const t0 = Date.now();
    const found = await findSharedProject({ name, hostedUrl: hosted ?? null, lan: { discover: discoverLan, manual } });
    const discoveryMs = Date.now() - t0;
    const route = pickRoute(found);
    const cand = route.action === 'enter' ? route.candidate : route.action === 'choose' ? route.candidates.find((c) => c.where === 'lan') : null;
    result.discovery = { ms: discoveryMs, firstSeenMs: cand?.firstSeenMs ?? null, via: cand?.via ?? null, action: route.action, candidates: found.candidates.length, errors: found.errors };
    if (!check(cand && cand.where === 'lan', 'Found a LAN candidate', found)) throw STOP;
    check(discoveryMs <= 5000, `Discovery took ≤ 5 s (${discoveryMs} ms)`);
    result.candidate = { base: cand.base, projectId: cand.projectId, hostDeviceName: cand.hostDeviceName ?? null, asset: cand.asset ?? null };
    // Candidate base is in http format (contract section 11 ruling), use ws format to connect WebSocket
    const wsUrl = wsBaseOf(cand.base);
    const u = new URL(wsUrl);
    const assetBase = cand.asset ?? `http://${u.host}/api/asset`;

    // 3. Admin interface is unreachable from LAN sources
    const bare = await handshakeStatus(u.hostname, Number(u.port), u.pathname, null);
    const tokenish = await handshakeStatus(u.hostname, Number(u.port), u.pathname, ['promptcut.v1', `promptcut.token.${randomBytes(32).toString('base64url')}`]);
    result.adminFromLan = { bare, token: tokenish };
    check(bare === 401 && tokenish === 401, 'Admin endpoints from a LAN source return 401 (both without credentials and with a token)', result.adminFromLan);

    // 4. Enter, snapshot, asset
    const hs0 = Date.now();
    ws = openWs(wsUrl, await buildAuthProtocols({ base: cand.base, projectId: cand.projectId, username: 'lan-member', deviceId, deviceName, as: 'member', password, role: 'page' }));
    await ws.opened;
    result.handshake = { ok: true, ms: Date.now() - hs0 };
    const st = await ws.request({ type: 'project.open', projectId: cand.projectId });
    check(st.type === 'project.state' && st.projectRev >= 1, 'project.open', st);
    const text = [];
    ws.send({ type: 'project.snapshot.get', reqId: 'snap', projectId: cand.projectId, projectRev: st.projectRev });
    let digest = null;
    for (;;) {
      const m = await ws.next((x) => x.reqId === 'snap');
      if (m.type === 'project.snapshot.end') { digest = m.digest; break; }
      if (m.missing) break;
      text[m.index] = m.data;
    }
    const snapText = text.join('');
    const snap = (() => { try { return JSON.parse(snapText); } catch { return null; } })();
    result.snapshot = { projectRev: st.projectRev, bytes: Buffer.byteLength(snapText), digestOk: digest !== null && sha256(snapText) === digest };
    check(result.snapshot.digestOk && snap?.assets?.length === 1, 'Project snapshot retrieved, digest matches', result.snapshot);
    const hash = snap?.assets?.[0];
    const tk = await ws.request({ type: 'auth.ticket', kind: 'asset', access: 'r' });
    check(tk.type === 'auth.ticket.ok', 'auth.ticket', { type: tk.type, reason: tk.reason });
    const noTicket = await fetch(`${assetBase}/media/${hash}`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.status).catch(() => null);
    const withTicket = await fetch(`${assetBase}/media/${hash}`, { headers: { Authorization: `Bearer ${tk.ticket}` }, signal: AbortSignal.timeout(30_000) })
      .then(async (r) => ({ status: r.status, sha: sha256(Buffer.from(await r.arrayBuffer())) })).catch((e) => ({ status: null, error: String(e?.message ?? e) }));
    result.asset = { noTicket, withTicket: withTicket.status, sha256Ok: withTicket.sha === hash };
    check(noTicket === 401, 'Reading an asset without a ticket returns 401 (LAN source)', noTicket);
    check(withTicket.status === 200 && withTicket.sha === hash, 'Reading an asset with a ticket returns 200, sha256 matches', result.asset);
    if (Number.isInteger(snap?.tasks)) expect = Math.min(expect, snap.tasks) || expect;

    // 5. Claim and complete
    const counts = { claims: 0, completed: 0, dedup: 0, failed: 0 };
    // Node connection is a session (HT-a, `createDocEndpoint` in `session-link.mjs`):
    // resumes within retention period if transport disconnects; claims are not lost
    const ep = createDocEndpoint({
      url: wsUrl,
      protocols: () => buildAuthProtocols({ base: cand.base, projectId: cand.projectId, username: 'lan-member', deviceId, deviceName, as: 'member', password, role: 'render' }),
    });
    eps.push(ep);
    const node = createLocalNode({
      nodeId: `lan-member-node-${process.pid}`,
      node: { profile: 'host', envFingerprint: 'probe-env', codeVersions: [], capabilities: {} },
      endpoint: ep, now: Date.now, maxConcurrent: 2, executor: createSleepExecutor({ taskMs: 200 }), sink: createArtifactSink(),
      onEvent: (e) => {
        if (e.type === 'completed') counts.completed += 1;
        else if (e.type === 'dedup') counts.dedup += 1;
        else if (e.type === 'failed') counts.failed += 1;
      },
    });
    ep.onOpen(() => node.start(node.session.held().map(({ id, token }) => ({ id, token }))));
    ep.onMessage((m) => { if (m.type === 'task.claimed') counts.claims += 1; });
    const tick = setInterval(() => { try { node.tick(); } catch { /* Defer to next tick */ } }, 50);
    const deadline = Date.now() + timeoutMs;
    while (counts.completed + counts.dedup < expect && Date.now() < deadline) await delay(100);
    clearInterval(tick);
    result.render = { ...counts, expect };
    check(counts.completed + counts.dedup >= expect, `Completed ≥ ${expect} tasks in the render role`, counts);
  } catch (err) {
    if (err !== STOP) check(false, 'Member flow failed', String(err?.stack ?? err));
  } finally {
    await ws?.close();
    for (const ep of eps) {
      const closedP = ep.connected ? new Promise((r) => ep.onClose(r)) : Promise.resolve();
      try { ep.close(); } catch { /* Closed */ }
      await Promise.race([closedP, delay(3000)]);
    }
    result.ok = fails.length === 0;
    const out = { ...result };
    await writeJson(path.join(state, 'lan-member-result.json'), out).catch(() => {});
    if (coord) await coord.put('lan-member-result', out).catch(() => {});
  }
  finish(result, fails.length ? 1 : 0);
}

/**
 * @param {'creator' | 'member'} role
 * @param {string[]} argv
 */
export async function runLan(role, argv) {
  if (role === 'creator') return runCreator(argv);
  if (role === 'member') return runMember(argv);
  console.error('--mode lan only supports --role creator | member');
  process.exit(2);
}
