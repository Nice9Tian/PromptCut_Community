/**
 * End-to-end probe for queue mode (contract `docs/plan/render-queue-contract.md` end of J.7, design
 * annex section 0 item 1).
 *
 * Same probe project, same machine: sequentially starts an editor process + prerender process on
 * each side, each with an empty frame store:
 *
 *   1. **Normal mode**: preload, wait for the background pass to finish (`status === 'ready'`);
 *   2. **Queue mode** (`PROMPTCUT_QUEUE_NODE=1`): wait for local node to check in (`queue.active`
 *      in diagnostics), preload, wait for the background pass to finish, `plan` to be split, and
 *      all fine-grained tasks to be `task.done` (or `task.failed`).
 *
 * Then compare snapshot files (`<frame>.html` under `controls-html/**` and `controls-local/**`)
 * and `index.json` in the frame stores on both sides one by one. In normal mode, the same frame
 * may be written three times sequentially (the anchor frame pass, `fillCardControls` /
 * `renderLocalSnapshots`, pass B), and the last write wins; in queue mode, non-anchor frames are
 * written only once by the executor. When differences exist between the two sides, **`ok` is still
 * true**, `identical: false`, and differences are listed frame by frame for the lead Agent to judge
 * whether they are caused by the triple writes of preload itself (contract J.7). Each frame is
 * additionally labeled `styleOrderOnly`: differing only in the declaration order within the `style`
 * attribute (measured to be the case between two normal mode passes as well, which is an inter-process
 * difference); `identicalIgnoringStyleOrder` indicates "whether they are identical after sorting declarations".
 *
 * **Document service**: Each pass starts an independent document service
 * (`server/docservice/main.mjs`, data directory is a newly created temp directory), passed to the
 * editor via `PROMPTCUT_DOCSERVICE_URL`. Do not use the one mounted in the editor: its content store
 * resides in `out/docservice` of the working copy, shared by both passes: preload in the second
 * pass will pull back whole segments pushed by the first pass according to the manifest (C6.4
 * cross-machine retrieval), and fine-grained tasks in the queue will also be deduplicated and
 * completed according to the manifest, making both sides "guaranteed identical" and rendering the
 * comparison meaningless. `--docservice-url <ws://…>` can use an existing external one instead
 * (shared between both passes, caller is responsible for ensuring it is empty).
 *
 * Track streams are disabled by default (`PROMPTCUT_STREAMS=0`): no stream tasks are published
 * (M6c X1 toggle, same behavior as M5b), and the probe asserts that the stream task count is 0.
 * `--streams` enables streams (`PROMPTCUT_STREAMS=1`, M6c X1): stream tasks complete via queue, asserting
 *   - Stream tasks were split out and all `done`, produced by the node's executor (not deduplication);
 *   - Each node receives `task.done` exactly once for each stream task (`queue.doneCounts` in diagnostics).
 *
 * **`--peer` (M6c X1)**: In the queue mode pass, starts a second editor (`--peer-port`, defaults to
 * queue port + 3; all three consecutive numbers must be free), with its own empty frame store, the
 * same document service, and also in queue mode; both editors preload the same project concurrently,
 * and the two nodes compete for the same fine-grained tasks. When `--streams` is enabled, wait until
 * stream stores on both sides are complete, then compare sha256 segment by segment (the segment
 * file and the init it uses): segments adopted by the other node via `task.done`'s
 * `applyResult` → `adoptSegments` must be byte-for-byte identical to the producer (`streamCompare` in output).
 *
 *   node scripts/probes/queue-mode-probe.mjs [--queue-port 5516] [--normal-port 5513] [--docservice-port 5519]
 *        [--docservice-url ws://…] [--streams] [--peer] [--peer-port N] [--only queue|normal] [--timeout-min 20] [--keep]
 *        [--lan] [--hold-min N]
 *
 * **LAN mode (`--lan`, for W4 cross-machine use)**:
 *   - The editor in the queue mode pass rebinds to `0.0.0.0`; the probe's own checks still go
 *     through `127.0.0.1`. The prerender process binds only to loopback as usual (spawned by the editor).
 *   - The editor's asset service automatically registers its LAN address per C5
 *     (`server/vite-plugin-media.ts`: requires `PROMPTCUT_DOCSERVICE_URL` to be set and bound to a
 *     non-loopback address). The probe extracts the registered address from
 *     `[asset-announce] asset-announce.announced` in the editor output and puts it into `announcedAsset`
 *     in the output (`null` if not registered, e.g. this machine has no private subnet IPv4).
 *   - **Credentials** (M6a, `docs/plan/auth-contract.md` section 11): Cluster token has retired from
 *     the data plane, leaving asset address registration as its only administrative purpose. When the
 *     probe starts its own document service (no `--docservice-url` provided), it deletes
 *     `PROMPTCUT_CLUSTER_TOKEN` from the editor's environment: the self-started instance binds to
 *     loopback, and the editor and prerender process connect to it with local identity. When
 *     `--docservice-url` is given to connect to a remote control plane, the prerender process must
 *     enter via a shared project: set `PROMPTCUT_SHARED_CONFIG` in the environment running the probe
 *     (passed as-is to the editor and prerender process); the token is retained as-is, used solely
 *     for asset registration. `--lan` does not change this rule.
 *   - When `--docservice-url` is omitted, the self-started document service still binds only to
 *     loopback and other machines cannot connect; cross-machine use requires `--docservice-url`.
 *     When `--docservice-url` is provided, it is no longer required that "all fine-grained tasks are
 *     completed by the local node" (other machines are also picking up jobs).
 *
 * **`--hold-min N`**: After the queue mode pass finishes and comparisons are done, do not shut down
 * processes immediately; hold for N more minutes so nodes on other machines can continue picking up
 * jobs and pulling. During this period, print a `[hold] {…}` line every 30 seconds (`tasks`, `done`,
 * ready layer count `readyLayers`). `nodes` in the output is taken from diagnostics at the end of the hold.
 *
 * Output also includes:
 *   - `nodes`: Node information in local diagnostics (`queue.local` in diagnostics): `nodeId`, list
 *     of task ids claimed / completed / deduplicated / failed by the local node, and `stats`;
 *   - `announcedAsset`: Registered asset service addresses on this machine (list);
 *   - `x5` (evidence for M6c X5, an extra `[x5] {…}` line printed during the queue mode pass): how
 *     long preload took to reach ready, how long after preload started before the first plan /
 *     fine-grained task was claimed, states of preload generations at that moment, number of claims
 *     read while waiting for ready; `fineClaimedBeforeReady` being true means "local node started
 *     claiming fine-grained tasks before preload was ready". Recorded only, not judged as failure.
 *
 * Ports: each editor occupies "port + 1" and "port + 2" as stage ports; all three consecutive numbers
 * must be free; one port for document service. `--keep` does not delete temporary frame stores on
 * either side (for debugging). The last line of output is a single JSON line:
 * `{ ok, tasks, done, identical, differentFrames: [...], fails }`, along with additional diagnostic fields; exit code is 1 when `ok` is false.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { anchorFrames } from '../../src/render/snapshotPick.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const QUEUE_PORT = Number(arg('--queue-port', 5516));
const NORMAL_PORT = Number(arg('--normal-port', 5513));
const DOC_PORT = Number(arg('--docservice-port', 5519));
const DOC_URL = arg('--docservice-url', null);
const STREAMS = args.includes('--streams');
/** M6c X1: `--peer` in queue mode starts a second queue node (second editor, its own empty frame store, same document service) */
const PEER = args.includes('--peer');
const PEER_PORT = Number(arg('--peer-port', QUEUE_PORT + 3));
const KEEP = args.includes('--keep');
const ONLY = arg('--only', null);
const TIMEOUT_MS = Number(arg('--timeout-min', 20)) * 60_000;
/** `--salt <s>`: written into params of each card (card content key includes params) so result keys are brand new and won't be deduplicated away by manifests existing elsewhere (for W4) */
const SALT = arg('--salt', null);
const LAN = args.includes('--lan');
const HOLD_MS = Math.max(0, Number(arg('--hold-min', 0)) || 0) * 60_000;
const EDITOR_HOST = LAN ? '0.0.0.0' : '127.0.0.1';

const fails = [];
const out = { root: ROOT, queuePort: QUEUE_PORT, normalPort: NORMAL_PORT, docservice: DOC_URL ?? `standalone:${DOC_PORT}`, streams: STREAMS, peer: PEER ? PEER_PORT : null,
  lan: LAN, editorHost: EDITOR_HOST, holdMin: HOLD_MS / 60_000 };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return cond; };

const FPS = 30;
const STAMP = Date.now().toString(36);
/**
 * 3 seconds = 90 frames: the two shared-tier cards are each split into two segments (0-59, 60-89);
 * the `unknown` card (local tier) starts at 1 second, and its mount frame (`mountFrameOf`, measured
 * at 29) cuts out an anchor frame between the other two cards. Fixed project id, so both passes
 * compute the same set of keys (frame store is empty).
 */
const PROJECT = {
  id: 'queue-mode-probe', name: 'Queue mode probe', width: 1920, height: 1080, fps: FPS, duration: 3,
  themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-1', name: 'tr-1', hidden: false, clips: [{ id: 'clip-stateful', kind: 'card', cardId: 'r6-stateful', start: 0, end: 3, params: {} }] },
    { id: 'tr-2', name: 'tr-2', hidden: false, clips: [{ id: 'clip-canvas', kind: 'card', cardId: 'r6-canvas', start: 0, end: 3, params: SALT ? { probeSalt: SALT } : {} }] },
    { id: 'tr-3', name: 'tr-3', hidden: false, clips: [{ id: 'clip-unknown', kind: 'card', cardId: 'r6-unknown', start: 1, end: 3, params: SALT ? { probeSalt: SALT } : {} }] },
  ],
};
const ANCHORS = anchorFrames(PROJECT.tracks.flatMap(t => t.clips), FPS).filter(n => n >= 0 && n < PROJECT.duration * FPS);
out.anchors = ANCHORS;

const json = async (url, init) => {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, body };
};
const postJson = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function until(label, fn, timeoutMs = 120000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`Timeout: ${label}`); return null; }
    await delay(everyMs);
  }
}

/** The working copy has no node_modules of its own (walks up to the one in main repo), so resolve vite's bin by module */
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
const exited = child => new Promise(resolve => { if (!child || child.exitCode !== null) return resolve(); child.once('exit', () => resolve()); setTimeout(resolve, 15000).unref?.(); });
const portFree = async port => {
  const net = await import('node:net');
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
};

/** The local node's portion in queue diagnostics (`queue.local`) */
const nodesOf = q => q ? {
  nodeId: q.local?.nodeId ?? q.nodeId ?? null,
  claimed: q.local?.claimed ?? null, completed: q.local?.completed ?? null, dedup: q.local?.dedup ?? null, failed: q.local?.failed ?? null,
  stats: q.stats ?? null,
} : null;

/**
 * Starts an editor (which spawns its own prerender process) and waits for prerender process to be
 * ready. `sink` receives editor output (scans line by line for asset registration). Returns
 * `{ label, port, exportDir, library, EDITOR, base, diagnostics }`; `base` is null if prerender
 * process failed to come up.
 */
async function startEditor(run, children, { label, port, exportDir, docUrl, queue, host, sink }) {
  await fs.mkdir(path.join(exportDir, 'data'), { recursive: true });
  const env = { ...process.env, PROMPTCUT_EXPORT_DIR: exportDir, PROMPTCUT_DATA_DIR: path.join(exportDir, 'data'), PROMPTCUT_DOCSERVICE_URL: docUrl };
  delete env.PROMPTCUT_QUEUE_NODE;
  if (!DOC_URL) delete env.PROMPTCUT_CLUSTER_TOKEN;
  if (queue) env.PROMPTCUT_QUEUE_NODE = '1';
  // M6c X1: `--streams` explicitly enables streams (PROMPTCUT_STREAMS=1); disabled when omitted, same as M5b
  env.PROMPTCUT_STREAMS = STREAMS ? '1' : '0';
  const editor = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', host],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  children.push(editor);
  editor.stdout.on('data', sink);
  editor.stderr.on('data', sink);
  const EDITOR = `http://127.0.0.1:${port}`;
  const inst = { label, port, exportDir, library: path.join(exportDir, 'frame-library'), EDITOR, base: null, diagnostics: async () => ({}) };
  await until(`[${label}] editor process up`, async () => (await fetch(EDITOR + '/api/prerender/info').then(r => r.ok, () => false)) || null, 120000);
  const base = await until(`[${label}] prerender process ready`, async () => {
    const info = await json(EDITOR + '/api/prerender/info');
    return info.body?.ready && info.body.url ? info.body.url : null;
  }, 180000);
  if (!base) return inst;
  inst.base = base;
  inst.diagnostics = async () => (await json(`${base}/api/frames/diagnostics`)).body ?? {};
  return inst;
}

/** Queue mode: wait for local node to check in (`queue.active` in diagnostics). Returns true / false */
async function waitActive(run, inst) {
  const active = await until(`[${inst.label}] local node checked in (queue.active in diagnostics)`, async () => (await inst.diagnostics()).queue?.active === true || null, 180000, 1000);
  const d = await inst.diagnostics();
  const start = d.queue ? { mode: d.queue.mode, url: d.queue.url, nodeId: d.queue.nodeId, envFingerprint: d.queue.envFingerprint } : null;
  if (inst.label === 'queue') run.queueStart = start;
  else (run.peer ??= {}).queueStart = start;
  return !!active;
}

/** Pushes project, preloads, and waits for the background pass to finish. Returns `{ session, key, ready }` */
async function preloadOn(run, inst, mode) {
  const SESSION = `qmp-${inst.label}-${STAMP}`;
  const pushed = await postJson(inst.EDITOR + '/api/data/project', { session: SESSION, localRev: 1, project: PROJECT });
  check(pushed.ok, `[${inst.label}] project pushed to the mirror`, pushed.body);
  await until(`[${inst.label}] prerender process holds this version of the project`, async () => (await json(`${inst.base}/api/data/project?session=${SESSION}&localRev=1`)).ok || null, 30000);
  const preload = await postJson(`${inst.base}/api/frames/preload`, { session: SESSION, localRev: 1 });
  check(preload.ok, `[${inst.label}] preload started`, preload.body);
  const key = preload.body?.key;
  // Evidence for M6c X5: how many times local node claimed before preload reached ready (claim count read from diagnostics on each poll)
  let claimedWhileNotReady = 0;
  const ready = await until(`[${inst.label}] background run finished`, async () => {
    // The page resends preload every 2s for keepalive; mirror that here (same revision returns immediately)
    const status = await postJson(`${inst.base}/api/frames/preload`, { session: SESSION, localRev: 1 });
    if (mode === 'queue' && status.body?.status !== 'ready') {
      const claimed = (await inst.diagnostics()).queue?.stats?.claimed;
      if (Number.isFinite(claimed)) claimedWhileNotReady = Math.max(claimedWhileNotReady, claimed);
    }
    return status.body?.status === 'ready' ? status.body : status.body?.status === 'error' ? status.body : null;
  }, TIMEOUT_MS, 2000);
  check(ready?.status === 'ready', `[${inst.label}] the background run ended with ready`, ready);
  return { session: SESSION, key, ready, claimedWhileNotReady };
}

/** Queue mode: plan split finished, all fine-grained tasks settled (viewed from this single node's diagnostics). Returns `{ plan, derived, states, q }` or null */
async function settledOn(inst) {
  return until(`[${inst.label}] plan split done, all fine-grained tasks settled`, async () => {
    const q = (await inst.diagnostics()).queue;
    const plan = q?.published?.[0]?.planId;
    const derived = plan ? q.plans?.[plan] : null;
    if (!Array.isArray(derived)) return null;
    const states = derived.map(id => q.tasks?.[id]?.state ?? 'pending');
    return states.every(s => s === 'done' || s === 'failed') ? { plan, derived, states, q } : null;
  }, TIMEOUT_MS, 2000);
}

/**
 * One pass: starts document service (standalone mode) and editor, preloads probe project, waits
 * for it to finish producing, and collects the frame store. When `hold` is true, processes are not
 * shut down; the returned run includes `release()` (shuts down processes) and `diagnostics()`,
 * allowing the caller to hold before shutting down. With `--peer` in queue mode, starts a second
 * editor (second queue node, its own empty frame store, connected to the same document service),
 * preloading the same project on both concurrently: the two nodes compete for the same fine-grained
 * tasks, each subscribed to the plan; `task.done` for fine-grained tasks is received by both, and
 * segments produced by the other side are pulled in via `applyResult`.
 */
async function runOnce(mode, { hold = false } = {}) {
  const port = mode === 'queue' ? QUEUE_PORT : NORMAL_PORT;
  const exportDir = path.join(os.tmpdir(), `pc-queue-probe-${mode}-${STAMP}`);
  const withPeer = mode === 'queue' && PEER;
  const run = { mode, port, exportDir, log: [] };
  const children = [];
  let kept = false;
  try {
    const ports = [port, port + 1, port + 2, ...(withPeer ? [PEER_PORT, PEER_PORT + 1, PEER_PORT + 2] : []), ...(DOC_URL ? [] : [DOC_PORT])];
    for (const p of ports) check(await portFree(p), `[${mode}] port ${p} is free`);
    if (fails.length) return run;
    await fs.mkdir(path.join(exportDir, 'data'), { recursive: true });
    let docUrl = DOC_URL;
    if (!docUrl) {
      const docData = path.join(exportDir, 'docservice');
      // Binds to loopback only: editor and prerender process connect to it with local identity without any credentials (header of main.mjs)
      const docEnv = { ...process.env, PROMPTCUT_DOCSERVICE_PORT: String(DOC_PORT), PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_DATA: docData };
      delete docEnv.PROMPTCUT_CLUSTER_TOKEN;
      const doc = spawn(process.execPath, [path.join(ROOT, 'server', 'docservice', 'main.mjs')], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: docEnv,
      });
      doc.stdout.resume(); doc.stderr.resume();
      children.push(doc);
      docUrl = `ws://127.0.0.1:${DOC_PORT}`;
      await until(`[${mode}] document service up`, async () => (await json(`http://127.0.0.1:${DOC_PORT}/healthz`)).body?.ok === true || null, 30000);
    }
    // Asset service registration (C5): the `[asset-announce] asset-announce.announced {json}` line in editor output
    run.announcedAsset = null;
    let lineTail = '';
    const scanAnnounce = text => {
      const lines = (lineTail + text).split('\n');
      lineTail = lines.pop() ?? '';
      for (const line of lines) {
        const m = /\[asset-announce\] asset-announce\.(announced|skip|error) (\{.*\})\s*$/.exec(line);
        if (!m) continue;
        let fields = null;
        try { fields = JSON.parse(m[2]); } catch { /* Ignore if not an entire line of JSON */ }
        if (m[1] === 'announced' && Array.isArray(fields?.urls)) run.announcedAsset = fields.urls;
        else (run.announceIssues ??= []).push({ event: m[1], ...(fields ?? {}) });
      }
    };
    const keep = c => { const text = c.toString(); scanAnnounce(text); run.log.push(text); if (run.log.length > 400) run.log.shift(); };
    const main = await startEditor(run, children, { label: mode, port, exportDir, docUrl, queue: mode === 'queue', host: mode === 'queue' ? EDITOR_HOST : '127.0.0.1', sink: keep });
    if (!main.base) return run;
    run.prerender = main.base;
    const diagnostics = main.diagnostics;
    let peer = null;
    if (withPeer) {
      const peerLog = [];
      peer = await startEditor(run, children, { label: 'peer', port: PEER_PORT, exportDir: `${exportDir}-peer`, docUrl, queue: true, host: '127.0.0.1',
        sink: c => { peerLog.push(c.toString()); if (peerLog.length > 400) peerLog.shift(); } });
      run.peer = { port: PEER_PORT, exportDir: peer.exportDir, prerender: peer.base };
      run.peerLog = peerLog;
      if (!peer.base) return run;
    }

    if (mode === 'queue') {
      // Only build the pipeline and start the local node on the first hit to /api/frames/*; wait for it
      // to connect to the document service and check in
      const actives = await Promise.all([main, ...(peer ? [peer] : [])].map(inst => waitActive(run, inst)));
      if (!actives.every(Boolean)) {
        run.queueLog = run.log.join('').split('\n').filter(line => line.includes('[queue-node]')).slice(-10);
        return run;
      }
    } else {
      const d = await diagnostics();
      check(d.queue === undefined, '[normal] no queue key in diagnostics while the switch is off', Object.keys(d));
    }

    const started = Date.now();
    // Both concurrently preload (each publishing the same plan as publisher, both subscribed; whichever becomes idle first claims first)
    const loads = await Promise.all([main, ...(peer ? [peer] : [])].map(inst => preloadOn(run, inst, mode)));
    run.entryKey = loads[0]?.key;
    if (peer) run.peer.entryKey = loads[1]?.key;
    if (peer) check(loads[0]?.key && loads[0].key === loads[1]?.key, '[peer] both machines compute the same entry.key', { main: loads[0]?.key, peer: loads[1]?.key });
    const claimedWhileNotReady = loads[0]?.claimedWhileNotReady ?? 0;
    run.preloadMs = Date.now() - started;
    if (mode === 'queue') {
      // Diagnostics queue.firstClaims (vite-plugin-frames.ts): timestamp of the first plan / fine-grained task claim and preload generation states at that moment
      const q = (await diagnostics()).queue ?? {};
      const brief = c => c ? { id: c.id, afterPreloadMs: c.at - started, preload: (c.preload ?? []).map(p => p.status) } : null;
      run.x5 = {
        readyAfterMs: run.preloadMs,
        firstPlanClaim: brief(q.firstClaims?.plan), firstFineClaim: brief(q.firstClaims?.fine),
        claimedWhileNotReady,
        fineClaimedBeforeReady: !!q.firstClaims?.fine && (q.firstClaims.fine.preload ?? []).some(p => !p.aborted && p.status !== 'ready'),
      };
      console.log(`[x5] ${JSON.stringify(run.x5)}`);
    }

    if (mode === 'queue') {
      const settled = await settledOn(main);
      if (settled) {
        const { q } = settled;
        run.plan = settled.plan;
        run.tasks = settled.derived.length;
        run.done = settled.states.filter(s => s === 'done').length;
        run.failedTasks = settled.derived.filter((id, i) => settled.states[i] === 'failed').map(id => ({ id, error: q.tasks[id]?.error ?? null }));
        run.queueStats = q.stats;
        run.queueEvents = q.events.filter(e => /failed|lost|discarded|mismatch|skip|offline|error/.test(e.event)).slice(-20);
        check(run.failedTasks.length === 0, '[queue] no fine-grained task failed', run.failedTasks);
        let peerQ = null;
        if (peer) {
          const peerSettled = await settledOn(peer);
          peerQ = peerSettled?.q ?? null;
          check(peerSettled?.plan === settled.plan, '[peer] both machines publish the same plan', { main: settled.plan, peer: peerSettled?.plan });
          check(JSON.stringify([...(peerSettled?.derived ?? [])].sort()) === JSON.stringify([...settled.derived].sort()), '[peer] both machines see the same fine-grained tasks',
            { main: settled.derived.length, peer: peerSettled?.derived?.length ?? null });
          run.peer.queueStats = peerQ?.stats ?? null;
          run.peer.queueEvents = (peerQ?.events ?? []).filter(e => /failed|lost|discarded|mismatch|skip|offline|error/.test(e.event)).slice(-20);
        }
        // On a single machine the local node should handle all (combined when --peer is present); not necessarily when connected to remote control plane (other machines also picking up jobs)
        const byNodes = q.stats.completed + q.stats.dedup + (peerQ ? peerQ.stats.completed + peerQ.stats.dedup : 0);
        if (!DOC_URL) check(byNodes >= run.done, '[queue] all fine-grained tasks are completed by nodes (completed + dedup)', { main: q.stats, peer: peerQ?.stats ?? null });
        // M6c X1: track stream tasks
        const streamIds = settled.derived.filter(id => id.startsWith('stream:'));
        run.streamTasks = streamIds.length;
        run.streamDone = streamIds.filter(id => q.tasks?.[id]?.state === 'done').length;
        const doneCounts = [['main', q], ...(peerQ ? [['peer', peerQ]] : [])].map(([who, qq]) => [who, Object.fromEntries(streamIds.map(id => [id, qq.doneCounts?.[id] ?? 0]))]);
        run.streamDoneCounts = Object.fromEntries(doneCounts);
        const local = qq => new Set([...(qq?.local?.completed ?? [])]);
        const dedup = qq => new Set([...(qq?.local?.dedup ?? [])]);
        run.streamBy = Object.fromEntries(streamIds.map(id => [id, local(q).has(id) ? 'main' : peerQ && local(peerQ).has(id) ? 'peer'
          : dedup(q).has(id) ? 'main-dedup' : peerQ && dedup(peerQ).has(id) ? 'peer-dedup' : 'other']));
        if (STREAMS) {
          check(run.streamTasks > 0, '[streams] stream tasks were split out', run.streamTasks);
          check(run.streamDone === run.streamTasks, '[streams] all stream tasks completed through the queue (done)', { tasks: run.streamTasks, done: run.streamDone });
          for (const [who, counts] of doneCounts) {
            const bad = Object.entries(counts).filter(([, n]) => n !== 1);
            check(bad.length === 0, `[streams] on ${who}, each stream task received task.done exactly once`, bad);
          }
          const rendered = Object.values(run.streamBy).filter(v => v === 'main' || v === 'peer').length;
          check(rendered === run.streamTasks, '[streams] stream tasks are all produced by node executors (not deduplicated)', run.streamBy);
        } else {
          check(run.streamTasks === 0, '[streams] no stream tasks are published while off (PROMPTCUT_STREAMS=0)', run.streamTasks);
        }
      }
      run.queueMs = Date.now() - started;
      await delay(3000);   // applyResult for task.done runs serially in the background; leave some time
      if (peer && STREAMS && run.streamTasks > 0) {
        // Segments adopted by the other node match the producer segment by segment: wait for stream stores on both sides to complete, then compare sha256 segment by segment
        const compare = await until('[streams] stream stores on both sides are complete', async () => {
          const c = await compareStreams(main.library, peer.library);
          return c.missing.length === 0 && c.segments > 0 ? c : null;
        }, 120000, 2000);
        run.streamCompare = compare ?? await compareStreams(main.library, peer.library);
        check(!!compare, '[streams] both sides have all segments', { missing: run.streamCompare.missing.slice(0, 10) });
        check(run.streamCompare.mismatched.length === 0, '[streams] segments fetched by the other node match the producer\'s sha256, segment by segment', run.streamCompare.mismatched.slice(0, 10));
      }
    }
    const d = await diagnostics();
    run.plans = (d.plans ?? []).map(p => ({ key: p.key, controls: p.controls.map(c => ({ clipId: c.clipId, tier: c.tier, snapshotKey: c.snapshotKey, picked: c.picked })) }));
    run.library = main.library;
    if (mode === 'queue') run.nodes = nodesOf(d.queue);
    if (peer) run.peer.nodes = nodesOf((await peer.diagnostics()).queue);
    if (hold) {
      kept = true;
      run.session = `qmp-${mode}-${STAMP}`;
      run.diagnostics = diagnostics;
      run.release = async () => {
        for (const child of children.reverse()) killTree(child);
        await Promise.all(children.map(exited));
      };
    }
    return run;
  } finally {
    if (!kept) {
      for (const child of children.reverse()) killTree(child);
      await Promise.all(children.map(exited));
    }
  }
}

/**
 * M6c X1: Reconciles stream stores across both frame stores segment by segment. Every segment listed
 * in `streams/<streamKey>/stream.json` (union of both sides) must exist on both sides, with matching
 * sha256 for the segment file and the init it uses. Returns `{ streams, segments, missing: [...], mismatched: [...], perStream }`.
 */
async function compareStreams(libA, libB) {
  const sha = buf => createHash('sha256').update(buf).digest('hex');
  const manifestIn = async (lib, key) => { try { return JSON.parse(await fs.readFile(path.join(lib, 'streams', key, 'stream.json'), 'utf8')); } catch { return null; } };
  const blobOf = async (lib, key, manifest, n) => {
    const seg = manifest?.segments?.[n];
    if (!seg) return null;
    try {
      const segBytes = await fs.readFile(path.join(lib, 'streams', key, seg.file));
      const initBytes = await fs.readFile(path.join(lib, 'streams', key, `init-${seg.init}.mp4`));
      return { seg: sha(segBytes), init: sha(initBytes), stride: seg.stride, adopted: seg.adopted === true, encoder: seg.encoder ?? manifest.inits?.[seg.init]?.encoder ?? null };
    } catch { return null; }
  };
  const keys = new Set();
  for (const lib of [libA, libB]) for (const item of await fs.readdir(path.join(lib, 'streams'), { withFileTypes: true }).catch(() => [])) {
    if (item.isDirectory() && /^[a-f0-9]{64}$/.test(item.name)) keys.add(item.name);
  }
  const out = { streams: 0, segments: 0, missing: [], mismatched: [], perStream: {} };
  for (const key of [...keys].sort()) {
    const a = await manifestIn(libA, key), b = await manifestIn(libB, key);
    const numbers = [...new Set([...Object.keys(a?.segments ?? {}), ...Object.keys(b?.segments ?? {})])].map(Number).sort((x, y) => x - y);
    if (!numbers.length) continue;
    out.streams++;
    const per = { segments: numbers.length, adoptedByMain: 0, adoptedByPeer: 0 };
    for (const n of numbers) {
      out.segments++;
      const x = await blobOf(libA, key, a, n), y = await blobOf(libB, key, b, n);
      if (!x || !y) { out.missing.push({ stream: key.slice(0, 12), segment: n, main: !!x, peer: !!y }); continue; }
      if (x.adopted) per.adoptedByMain++;
      if (y.adopted) per.adoptedByPeer++;
      if (x.seg !== y.seg || x.init !== y.init) out.mismatched.push({ stream: key.slice(0, 12), segment: n, main: x, peer: y });
    }
    out.perStream[key.slice(0, 12)] = per;
  }
  return out;
}

/** Holds `HOLD_MS`: prints one progress line every 30s, refreshing `run.nodes` each time */
async function holdOpen(run) {
  const deadline = Date.now() + HOLD_MS;
  const progress = async () => {
    let d = {};
    try { d = await run.diagnostics(); } catch { /* Print empty if process is gone */ }
    const q = d.queue;
    const derived = run.plan ? q?.plans?.[run.plan] : null;
    const states = Array.isArray(derived) ? derived.map(id => q.tasks?.[id]?.state ?? 'pending') : [];
    const layers = (Array.isArray(d.ready) ? d.ready : []).filter(r => r.session === run.session).reduce((n, r) => n + (r.layers ?? 0), 0);
    const line = { tasks: states.length, done: states.filter(s => s === 'done').length, readyLayers: layers,
      localCompleted: q?.local?.completed?.length ?? null, connected: q?.connected ?? null, leftSec: Math.max(0, Math.round((deadline - Date.now()) / 1000)) };
    console.log(`[hold] ${JSON.stringify(line)}`);
    if (q) run.nodes = nodesOf(q);
  };
  await progress();
  while (Date.now() < deadline) {
    await delay(Math.min(30_000, Math.max(0, deadline - Date.now())));
    await progress();
  }
}

/** All snapshots in frame store: `<relativePath>` → bytes. `controls-html/<key>/…`, `controls-local/<entry.key>/<key>/…` */
async function snapshotTree(library) {
  const files = new Map();
  const walk = async (dir) => {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file);
      else if (/\.(html|json)$/.test(item.name)) files.set(path.relative(library, file).replaceAll('\\', '/'), await fs.readFile(file));
    }
  };
  await walk(path.join(library, 'controls-html'));
  await walk(path.join(library, 'controls-local'));
  return files;
}

/** Sort declarations in each `style="…"`: only used to check "whether only declaration order differs", the comparison itself still uses raw bytes */
const sortStyles = html => html.replace(/style="([^"]*)"/g, (_, s) => 'style="' + s.split(';').map(x => x.trim()).filter(Boolean).sort().join(';') + '"');

/** Key → clip and tier (reverse-looked up from card plan), for easy recognition in diff list */
function keyIndex(run) {
  const map = new Map();
  for (const plan of run?.plans ?? []) for (const c of plan.controls) if (c.snapshotKey) map.set(c.snapshotKey, { clipId: c.clipId, tier: c.tier });
  return map;
}

const runs = {};
try {
  if (ONLY !== 'queue') runs.normal = await runOnce('normal');
  if (ONLY !== 'normal' && !fails.some(f => f.includes('port'))) runs.queue = await runOnce('queue', { hold: HOLD_MS > 0 });
  out.tasks = runs.queue?.tasks ?? 0;
  out.done = runs.queue?.done ?? 0;
  out.streamTasks = runs.queue?.streamTasks ?? null;
  out.streamDone = runs.queue?.streamDone ?? null;
  out.streamCompare = runs.queue?.streamCompare ? { streams: runs.queue.streamCompare.streams, segments: runs.queue.streamCompare.segments,
    missing: runs.queue.streamCompare.missing.length, mismatched: runs.queue.streamCompare.mismatched.length, perStream: runs.queue.streamCompare.perStream } : null;
  out.identical = null;
  out.differentFrames = [];
  if (runs.normal?.library && runs.queue?.library) {
    const a = await snapshotTree(runs.normal.library);
    const b = await snapshotTree(runs.queue.library);
    const keys = keyIndex(runs.normal);
    const clipStart = Object.fromEntries(PROJECT.tracks.flatMap(t => t.clips).map(c => [c.id, Math.round(c.start * FPS)]));
    const describe = rel => {
      const parts = rel.split('/');
      const tier = parts[0] === 'controls-local' ? 'local' : 'shared';
      const key = tier === 'local' ? parts[2] : parts[1];
      const name = parts[parts.length - 1];
      const hit = keys.get(key);
      const frame = /^\d+\.html$/.test(name) ? Number(name.slice(0, -5)) : null;
      const global = hit && frame !== null ? frame + (clipStart[hit.clipId] ?? 0) : null;
      return { file: rel, tier, clipId: hit?.clipId ?? null, localFrame: frame, anchor: global !== null ? ANCHORS.includes(global) : null };
    };
    for (const rel of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      const x = a.get(rel), y = b.get(rel);
      if (x && y && x.equals(y)) continue;
      // Mark separately those that differ only in declaration order in style attributes (measured between two normal mode passes as well; see report)
      const styleOrderOnly = !!(x && y && rel.endsWith('.html') && sortStyles(x.toString('utf8')) === sortStyles(y.toString('utf8')));
      out.differentFrames.push({ ...describe(rel), reason: !x ? 'only-in-queue' : !y ? 'only-in-normal' : 'bytes', styleOrderOnly, normalBytes: x?.length ?? null, queueBytes: y?.length ?? null });
    }
    out.identicalIgnoringStyleOrder = out.differentFrames.every(d => d.styleOrderOnly);
    out.compared = { normalFiles: a.size, queueFiles: b.size, htmlFiles: [...a.keys()].filter(k => k.endsWith('.html')).length };
    out.identical = out.differentFrames.length === 0;
    check(out.compared.htmlFiles > 0, 'Normal mode\'s frame store has snapshots', out.compared);
    check(out.tasks > 0, 'Queue mode split out fine-grained tasks', out.tasks);
    check(out.done === out.tasks, 'All fine-grained tasks in queue mode are done', { tasks: out.tasks, done: out.done });
    const summary = {};
    for (const d of out.differentFrames) {
      const k = `${d.clipId ?? '?'}/${d.tier}/${d.reason}${d.styleOrderOnly ? '(style-order)' : ''}/${d.anchor ? 'anchor' : 'non-anchor'}`;
      summary[k] = (summary[k] ?? 0) + 1;
    }
    out.differenceSummary = summary;
  } else if (!ONLY) check(false, 'Both runs need a frame store to compare', Object.keys(runs));
  if (runs.queue?.release) await holdOpen(runs.queue);
} catch (error) {
  fails.push(`Probe itself failed: ${error?.stack || error}`);
} finally {
  if (runs.queue?.release) await runs.queue.release().catch(() => {});
  out.runs = Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { ...r, log: undefined, peerLog: undefined, library: undefined, release: undefined, diagnostics: undefined }]));
  out.nodes = runs.queue?.nodes ?? null;
  out.announcedAsset = runs.queue?.announcedAsset ?? null;
  out.x5 = runs.queue?.x5 ?? null;
  if (!KEEP) for (const run of Object.values(runs)) for (const dir of [run?.exportDir, run?.peer?.exportDir]) if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}

const result = { ok: fails.length === 0, tasks: out.tasks ?? 0, done: out.done ?? 0, identical: out.identical ?? null,
  differentFrames: out.differentFrames ?? [], fails, ...out };
console.log(JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, tasks: result.tasks, done: result.done, identical: result.identical,
  differentFrames: result.differentFrames.length, identicalIgnoringStyleOrder: out.identicalIgnoringStyleOrder ?? null, differenceSummary: out.differenceSummary ?? null,
  streamTasks: out.streamTasks, streamDone: out.streamDone, streamCompare: out.streamCompare, x5: out.x5 ?? null, fails }));
process.exit(result.ok ? 0 : 1);
