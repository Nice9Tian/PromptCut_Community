/**
 * End-to-end probe for R6/R8 data plane. Starts an editor process + prerender process, loads a project
 * containing a stateful DOM card, canvas card, `unknown` card, and over-limit card (four fixed cards
 * in `src/cards/_probe/r6.tsx`), adapting to Ji-2 snapshot removal where "ready index only sends stream
 * layer, frame store only writes streams/<streamKey>":
 *
 *   1. The first SSE message is reset, followed by done and stream layers for each heavy card;
 *   2. ranges in stream layer grow as segments are produced;
 *   3. Manifest JSON fetched via GET /api/frames/stream/${key}/manifest matches streams/<key>/stream.json on disk;
 *   6. clip-unknown appears in clip-unknown/stream (streamKind === 'below' below-dependent stream),
 *      clip-stateful and clip-canvas appear in single-card stream layer; and there are no
 *      controls-html / controls-local directories under frame store;
 *   7. After killing the prerender process and having it automatically restart: no one sends preload,
 *      the editor process replays preload per session revision registry, and the server replays the
 *      session revision, first sending reset (localRev: 1) and then rebuilding all stream layers via streamProducer().rescan();
 *   9. Cards classified as light in all positions do not produce streams and do not enter the ready
 *      index (pinned render 9): write a cheap cost record for a stateful card and it drops out of the
 *      prerender set; delete its streams/<key> directory and rerun, and the classified-as-light
 *      directory does not grow back;
 *  10. Environment fingerprint enters result key (M4, contract E.7): the fingerprint in diagnostics
 *      is 16-character hex, and every control with snapshotKey satisfies snapshotKey === resultKeyOf(contentKey, envFingerprint).
 *
 * Cost records are also isolated in a temporary directory (`PROMPTCUT_DATA_DIR`), without touching
 * the repo's `out/card-costs.json`.
 *
 *   node scripts/probes/ready-index-probe.mjs [--port 5231] [--out <dir>] [--keep]
 *
 * `--keep-out` preserves current temporary artifacts but not dev server; `--keep` is a legacy debug flag.
 * Cleans up by default on success; on failure, leaves length-limited and sensitive-value-filtered diagnostic evidence.
 *
 * Duration recorded only (verification.md "duration recorded only, not used as gate"): this probe has
 * no time gate; elapsed time for each wait is recorded into the `TIMINGS` line and `timings` in the
 * result. Wait timeouts exist only to prevent hanging; any timeout under 120s waits for 120s; timing
 * out with no result is still counted as failure.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createTimings } from './probe-timings.mjs';
import { resultKeyOf } from '../../server/render-node/fingerprint.mjs';
import { publicManifest } from '../../server/frame-stream.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 5231);
const KEEP = args.includes('--keep');
const KEEP_OUT = args.includes('--keep-out');
const EDITOR = `http://127.0.0.1:${PORT}`;
const EXPORT_DIR = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1]
  : path.join(os.tmpdir(), `pc-r6-probe-${Date.now().toString(36)}`));
const LIBRARY = path.join(EXPORT_DIR, 'frame-library');
/** Cost records (`card-costs.json`) also land in the temporary directory; see `startEditor` */
const DATA_DIR = path.join(EXPORT_DIR, 'data');
fsSync.mkdirSync(DATA_DIR, { recursive: true });
/** (9) Self-written cost record is attached to this fake device (server treats it only as an opaque string) */
const PROBE_DEVICE = 'r6-probe-device';

const fails = [];
const out = { port: PORT, exportDir: EXPORT_DIR };
const timings = createTimings('ready-index-probe');
const WAIT_FLOOR_MS = 120000;
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); return cond; };

function safeDiagnosticText(value, limit = 4096) {
  return String(value ?? '')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|recovery[_-]?token|password|secret|authorization|cookie|session|credential)(?:hash|token)?["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;<>}]+)/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*(?:PRIVATE KEY|SECRET)[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|SECRET)-----/gi, '[REDACTED KEY MATERIAL]')
    .slice(0, limit);
}

function serviceErrorExcerpt() {
  const relevant = editorLog.join('').split(/\r?\n/)
    .filter(line => /\b(?:error|exception|failed|500)\b|Internal Server Error|Internal server error/i.test(line))
    .slice(-12);
  return safeDiagnosticText(relevant.join('\n'), 4096);
}

const SESSION = `r6-${Date.now().toString(36)}`;
const FPS = 30;
/** 2 seconds = 60 frames. The fourth card starts at 1 second: its mount frame splits the first three cards into two segments (C4's "ranges"). */
const PROJECT = {
  id: `r6-probe-${SESSION}`, name: 'R6 data plane probe', width: 1920, height: 1080, fps: FPS, duration: 2,
  themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-1', name: 'tr-1', hidden: false, clips: [{ id: 'clip-stateful', kind: 'card', cardId: 'r6-stateful', start: 0, end: 2, params: {} }] },
    { id: 'tr-2', name: 'tr-2', hidden: false, clips: [{ id: 'clip-canvas', kind: 'card', cardId: 'r6-canvas', start: 0, end: 2, params: {} }] },
    { id: 'tr-3', name: 'tr-3', hidden: false, clips: [{ id: 'clip-unknown', kind: 'card', cardId: 'r6-unknown', start: 0, end: 2, params: {} }] },
    { id: 'tr-4', name: 'tr-4', hidden: false, clips: [{ id: 'clip-huge', kind: 'card', cardId: 'r6-huge', start: 1, end: 2, params: {} }] },
  ],
};

const json = async (url, init) => {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, body };
};
const postJson = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Wait for a condition to hold; return false on timeout (probe decides itself, does not throw). */
async function until(label, fn, timeoutMs = 120000, everyMs = 300) {
  // Wait timeout is only to prevent hangs (verification.md "duration is only recorded, not used as a gate"):
  // anything below WAIT_FLOOR_MS is bumped up to it; elapsed time waited is only recorded
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(timeoutMs, WAIT_FLOOR_MS);
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) { timings.record(`Waited for: ${label}`, Date.now() - startedAt); return value; }
    if (Date.now() > deadline) { fails.push(`Timeout: ${label}`); return null; }
    await delay(everyMs);
  }
}

/**
 * SSE read client. Do not use `EventSource` (requires experimental flag on Node), read body stream directly:
 * the probe needs ordering like "whether the first message is `reset`", parsing it directly is clearest.
 */
function openReady(base, onMessage, session = SESSION) {
  const controller = new AbortController();
  const messages = [];
  const done = (async () => {
    const res = await fetch(`${base}/api/frames/ready?session=${encodeURIComponent(session)}&localRev=1`, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`SSE connection failed: ${res.status}`);
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const message = JSON.parse(line.slice(5).trim());
            messages.push(message);
            onMessage?.(message);
          } catch { /* Partial message */ }
        }
      }
    }
  })().catch(() => {});
  return { messages, close: () => { controller.abort(); return done; } };
}

/** What a layer in the index looks like right now (replayed from received messages, same logic as `applyReadyMessage` on the page side). */
function indexOf(messages) {
  const table = new Map();
  for (const message of messages) {
    if (message.type === 'reset') { table.clear(); continue; }
    if (message.type !== 'layer') continue;
    table.set(`${message.clipId}/${message.kind}`, { ...message });
  }
  return table;
}

/** This working copy has no node_modules of its own (Node walks up to the main repo's copy), so resolve by module;
 *  vite's `exports` does not allow `./bin/vite.js`, resolve main entrypoint then back to package root. */
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

let editor = null;
const editorLog = [];
async function startEditor() {
  editor = spawn(process.execPath, [viteBin(),
    '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    // Cold cache: outputs land in a newly created temp directory, prerender child process inherits this variable
    // Cost records are also isolated to temp directory: (9) must write a few records itself, cannot pollute repo's
    // out/card-costs.json, nor let records left by R1 / R4 in repo affect "fallback to declaration when no records"
    env: { ...process.env, PROMPTCUT_EXPORT_DIR: EXPORT_DIR, PROMPTCUT_DATA_DIR: DATA_DIR } });
  const keep = c => { const text = c.toString(); editorLog.push(text); if (editorLog.length > 400) editorLog.shift(); };
  editor.stdout.on('data', keep);
  editor.stderr.on('data', keep);
  return until('editor process is up', async () => (await fetch(EDITOR + '/api/prerender/info').then(r => r.ok, () => false)) || null, 120000);
}
function stopEditor() {
  if (!editor || editor.exitCode !== null || !editor.pid) return;
  // The editor process also holds the prerender process and Chrome; killing only it will leave orphans
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else editor.kill('SIGKILL');
}

/** Address of the prerender process right now (it picks a new free port if it crashes). */
const prerenderUrl = async () => {
  const info = await json(EDITOR + '/api/prerender/info');
  return info.body?.ready && info.body.url ? info.body.url : null;
};

try {
  await startEditor();
  const base = await until('prerender process ready', prerenderUrl, 180000);
  out.prerender = base;
  if (!base) throw new Error('The prerender process did not start');

  /* ---- Project enters mirror (editor process receives it and forwards it as-is to prerender process) ---- */
  const pushed = await postJson(EDITOR + '/api/data/project', { session: SESSION, localRev: 1, project: PROJECT });
  check(pushed.ok, 'Project pushed to the mirror', pushed.body);
  await until('Prerender process holds this version of the project', async () => (await json(`${base}/api/data/project?session=${SESSION}&localRev=1`)).ok || null, 30000);

  /* ---- Connect SSE, then start prerender ---- */
  const ready = openReady(base);
  await until('SSE connected and first message received', () => ready.messages.length > 0 || null, 30000);
  out.firstMessage = ready.messages[0];
  check(ready.messages[0]?.type === 'reset', '① the first SSE message is reset, not layer', ready.messages[0]);

  const preload = await postJson(`${base}/api/frames/preload`, { session: SESSION, localRev: 1 });
  check(preload.ok, 'Prerender started', preload.body);

  /* ---- (1) First SSE message is reset, followed by done and stream layers for each heavy card ---- */
  const doneAt = await until('Received done', () => ready.messages.findIndex(m => m.type === 'done') + 1 || null, 300000);
  check(!!doneAt, '① received a done message', { doneAt });
  const hasStreamLayers = await until('Received the stream layers of each heavy card', () => {
    const table = indexOf(ready.messages);
    return table.has('clip-stateful/stream') && table.has('clip-canvas/stream') && table.has('clip-unknown/stream') && table.has('clip-huge/stream') ? table : null;
  }, 300000, 500);
  check(!!hasStreamLayers, '① received the stream layers of each heavy card (including clip-stateful, clip-canvas, clip-unknown, clip-huge)', hasStreamLayers ? [...hasStreamLayers.keys()] : []);

  /* ---- (2) stream layer ranges grow with segment production ---- */
  const grew = await until('A layer\'s ranges grow as segments are produced', () => {
    const table = indexOf(ready.messages);
    const layer = table.get('clip-stateful/stream');
    return layer && layer.ranges.some(([from, to]) => to - from >= 1) ? layer : null;
  }, 300000, 500);
  out.grown = grew;
  check(!!grew, '② the stream layer\'s ranges grow as segments are produced', grew);
  check(ready.messages.filter(m => m.type === 'layer' && m.kind === 'stream').length > 1, '② received multiple stream layers');

  /* ---- (3) Manifest JSON fetched via GET /api/frames/stream/${statefulLayer.key}/manifest matches disk ---- */
  const table = indexOf(ready.messages);
  const statefulLayer = table.get('clip-stateful/stream');
  if (statefulLayer) {
    const overHttp = await fetch(`${base}/api/frames/stream/${statefulLayer.key}/manifest`);
    const httpText = await overHttp.text();
    const file = path.join(LIBRARY, 'streams', statefulLayer.key, 'stream.json');
    const onDisk = await fs.readFile(file, 'utf8').catch(() => null);
    let parsedHttp = null, parsedDisk = null;
    try { parsedHttp = JSON.parse(httpText); } catch {}
    try { parsedDisk = JSON.parse(onDisk); } catch {}
    const expectedPublic = parsedDisk ? publicManifest(parsedDisk) : null;
    out.streamManifest = {
      status: overHttp.status, bytes: httpText.length, file,
      sameJson: parsedHttp !== null && expectedPublic !== null && JSON.stringify(parsedHttp) === JSON.stringify(expectedPublic),
      contentType: safeDiagnosticText(overHttp.headers.get('content-type') || '', 200),
      cacheControl: safeDiagnosticText(overHttp.headers.get('cache-control') || '', 200),
      ...(!overHttp.ok ? { errorBody: safeDiagnosticText(httpText), serviceErrors: serviceErrorExcerpt() } : {}),
    };
    check(overHttp.ok, '③ GET /api/frames/stream/... returns the manifest', out.streamManifest);
    check(out.streamManifest.sameJson, '③ the manifest JSON fetched matches stream.json on disk', { ...out.streamManifest, diskBytes: onDisk?.length ?? null });
  } else check(false, '③ no stream layer for clip-stateful, cannot compare the manifest');

  /* ---- (6) clip-unknown enters below stream, stateful/canvas enters single-card stream, no controls-html/controls-local ---- */
  const unknownLayer = table.get('clip-unknown/stream');
  const canvasLayer = table.get('clip-canvas/stream');
  out.kinds = [...table.keys()].sort();
  check(table.has('clip-unknown/stream') && unknownLayer?.streamKind === 'below', '⑥ clip-unknown appears in clip-unknown/stream and streamKind === below', unknownLayer);
  check(table.has('clip-stateful/stream') && statefulLayer?.streamKind !== 'below', '⑥ clip-stateful appears in a single-card stream layer', statefulLayer);
  check(table.has('clip-canvas/stream') && canvasLayer?.streamKind !== 'below', '⑥ clip-canvas appears in a single-card stream layer', canvasLayer);
  check(!table.has('clip-unknown/local') && !table.has('clip-unknown/html') && !table.has('clip-stateful/html') && !table.has('clip-canvas/html'), '⑥ no html or local snapshot layers remain', out.kinds);
  const controlsHtmlExists = fsSync.existsSync(path.join(LIBRARY, 'controls-html'));
  const controlsLocalExists = fsSync.existsSync(path.join(LIBRARY, 'controls-local'));
  check(!controlsHtmlExists && !controlsLocalExists, '⑥ no controls-html / controls-local directories under the frame store', { controlsHtmlExists, controlsLocalExists });

  /* ---- (10) M4: environment fingerprint enters result key (contract E.7 "Probes") ---- */
  const diagnostics = await json(`${base}/api/frames/diagnostics`);
  {
    const d = diagnostics.body || {};
    const fingerprint = d.environment?.fingerprint;
    out.environment = d.environment ?? null;
    check(typeof fingerprint === 'string' && /^[0-9a-f]{16}$/.test(fingerprint), '⑩ diagnostics.environment.fingerprint is 16 hex digits', out.environment);
    const keyed = (d.plans || []).flatMap(p => (p.controls || []).filter(c => c.snapshotKey));
    const bad = keyed.filter(c => !(typeof c.contentKey === 'string' && c.envFingerprint === fingerprint && c.snapshotKey === resultKeyOf(c.contentKey, c.envFingerprint)))
      .map(c => ({ clipId: c.clipId, snapshotKey: c.snapshotKey, contentKey: c.contentKey, envFingerprint: c.envFingerprint }));
    check(keyed.length > 0, '⑩ diagnostics contain a control with snapshotKey', d.plans);
    check(bad.length === 0, '⑩ snapshotKey of plans[].controls[] === resultKeyOf(contentKey, envFingerprint), and envFingerprint is this process\'s fingerprint', bad);
  }

  /* ---- (7) F5: kill prerender process and bring it back up ---- */
  const beforeKill = indexOf(ready.messages);
  out.layersBeforeKill = beforeKill.size;
  await ready.close();
  const oldBase = base;
  const pid = await (async () => {
    // Prerender process was spawned by editor process, so it is the tree we started. Find its PID by port.
    const port = new URL(oldBase).port;
    const { execSync } = await import('node:child_process');
    try {
      const text = execSync(process.platform === 'win32' ? `netstat -ano -p tcp` : `lsof -ti tcp:${port}`, { windowsHide: true, encoding: 'utf8' });
      if (process.platform !== 'win32') return Number(text.trim().split(/\s+/)[0]);
      const line = text.split(/\r?\n/).find(l => l.includes(`127.0.0.1:${port}`) && l.includes('LISTENING'));
      return line ? Number(line.trim().split(/\s+/).pop()) : null;
    } catch { return null; }
  })();
  out.prerenderPid = pid;
  if (check(!!pid, '⑦ the PID of the prerender process can be found (it was spawned by the editor process)')) {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
    // After crash, wait for editor to bring it back up (MAX_RESTARTS path in vite-plugin-prerender)
    const fresh = await until('Prerender process restarts automatically', async () => {
      const next = await prerenderUrl();
      return next && next !== oldBase ? next : null;
    }, 180000, 500);
    out.prerenderAfterRestart = fresh;
    if (fresh) {
      const after = openReady(fresh);
      await until('SSE after restart received the first message', () => after.messages.length > 0 || null, 30000);
      out.afterRestartFirst = after.messages[0];
      check(after.messages[0]?.type === 'reset', '⑦ reset is received first on reconnect', after.messages[0]);
      /*
       * **Server recovers on its own** (Item 4 Plan A): probe sends no preload here, nor will page
       * (ready long ago). After editor process brings up prerender process and re-pushes mirror,
       * it replays this session's preload per "session version registry": session version returns
       * (reset with localRev 1), card plan is recomputed, and layers are rebuilt by key.
       */
      const rebuilt = await until('Index rebuilt by key and layers re-emitted (nobody sent preload)', () => {
        const t = indexOf(after.messages);
        return t.size >= beforeKill.size ? t : null;
      }, 300000, 500);
      out.layersAfterRebuild = rebuilt ? [...rebuilt.keys()].sort() : null;
      check(!!rebuilt, '⑦ nobody sent preload; after the server replays, the index is rebuilt by key and the layer count is not lower than before the crash', { before: [...beforeKill.keys()].sort(), after: out.layersAfterRebuild });
      if (rebuilt) {
        // Do not send layer before project is in place:
        // the first layer must follow reset (localRev 1) when "session version returns"
        const resetIndex = after.messages.findIndex(m => m.type === 'reset' && m.localRev === 1);
        const firstLayer = after.messages.findIndex(m => m.type === 'layer');
        out.recoveryReset = resetIndex;
        check(resetIndex >= 0 && resetIndex < firstLayer, '⑦ the session version comes back first (reset carries localRev 1), then all layers are sent', { resetIndex, firstLayer });
        // Ranges match pre-crash state (disk scan rebuilds from index.json, not re-produced from scratch)
        const same = [...beforeKill].every(([id, layer]) => JSON.stringify(rebuilt.get(id)?.ranges ?? null) !== 'null');
        check(same, '⑦ every layer that existed before the crash is present after the rebuild', { before: [...beforeKill.keys()].sort(), after: out.layersAfterRebuild });
      }
      await after.close();
    }
  }
  /* ---- (9) pinned render 9: cards classified as light everywhere produce no stream and skip ready index ---- */
  // Restarted once in (7), prerender process changed port: fetch address again here
  const base9 = (await until('⑨ prerender process address', prerenderUrl, 60000)) || base;
  out.prerender9 = base9;
  // Phase 1 has no cost records at all → `prerenderSetOfPlan` falls back to declaration,
  // all four stateful cards are in the set.
  const diag0 = await json(`${base9}/api/frames/diagnostics`);
  const plan0 = (diag0.body?.plans || []).find(p => (p.controls || []).some(c => c.clipId === 'clip-stateful'));
  out.planBefore = plan0 ? { key: plan0.key, prerenderSet: plan0.prerenderSet } : null;
  check(!!plan0?.prerenderSet, '⑨ diagnostics expose the prerender set', diag0.body?.plans);
  check(!!plan0?.prerenderSet?.includes('clip-stateful'), '⑨ with no cost records, fall back to declarations: all stateful cards are in the set', out.planBefore);
  const statefulKey = beforeKill.get('clip-stateful/stream')?.key;
  const statefulDir = statefulKey ? path.join(LIBRARY, 'streams', statefulKey) : null;
  check(!!statefulDir && fsSync.existsSync(statefulDir), '⑨ when classified as heavy, clip-stateful did produce a stream directory', statefulDir);

  const canvasKey = beforeKill.get('clip-canvas/stream')?.key;
  const canvasDir = canvasKey ? path.join(LIBRARY, 'streams', canvasKey) : null;
  check(!!canvasDir && fsSync.existsSync(canvasDir), '⑨ when classified as heavy, clip-canvas did produce a stream directory', canvasDir);

  // Write a "cheap random-access card" record for clip-stateful → classified as light at every position;
  // other three pinned as heavy, so cost records are non-empty (no declaration fallback),
  // and the set only lacks clip-stateful.
  const records = [];
  for (const control of plan0?.controls || []) {
    if (!control.costKey) continue;
    records.push(control.clipId === 'clip-stateful'
      ? { identityKey: control.costKey, device: PROBE_DEVICE, mode: 'dev', kind: 'random',
          stepMs: 0.1, seekOk: true, seekMs: 0.1, catchUpMs: 0.1, capped: false, demoted: false, pinnedHeavy: false, measuredAt: Date.now() }
      : { identityKey: control.costKey, device: PROBE_DEVICE, mode: 'dev', kind: 'stateful',
          stepMs: 1, seekOk: false, seekMs: null, catchUpMs: 1, capped: true, demoted: false, pinnedHeavy: false, measuredAt: Date.now() });
  }
  const putCosts = await json(EDITOR + '/api/data/costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records }) });
  out.costs = { put: putCosts.body, count: records.length };
  check(putCosts.ok && records.length >= 2, '⑨ cost records were written', out.costs);
  await until('Prerender process can read these cost records', async () => {
    const got = await json(`${base9}/api/data/costs?device=${PROBE_DEVICE}`);
    return (got.body?.costs || []).length >= records.length || null;
  }, 60000);

  /*
   * Push another project version and start another prerender pass. `frameIdentity` **ignores `id` / `name`**,
   * so `entry.key` is the same as in the first version (cards and clips are completely untouched).
   * Background generation is partitioned by page session (Item 4: owner = `session:<id>`), so sending
   * preload from a different session avoids the early return of "same entry returns directly":
   * it re-runs a pass for the same entry: `adoptCardPlan` recalculates `prerenderSet` with **new costs**,
   * which is exactly what we want to verify.
   */
  const SESSION_B = `${SESSION}-b`, SESSION_C = `${SESSION}-c`;
  const PROJECT_B = { ...PROJECT, id: `${PROJECT.id}-b`, name: 'R6 data plane probe (second version)' };
  const pushedB = await postJson(EDITOR + '/api/data/project', { session: SESSION_B, localRev: 1, project: PROJECT_B });
  check(pushedB.ok, '⑨ second version of the project pushed to the mirror', pushedB.body);
  await until('Prerender process holds the second version', async () => (await json(`${base9}/api/data/project?session=${SESSION_B}&localRev=1`)).ok || null, 30000);
  const preloadB = await postJson(`${base9}/api/frames/preload`, { session: SESSION_B, localRev: 1 });
  check(preloadB.ok, '⑨ second version started', preloadB.body);

  // Look for "clip-stateful card was not picked", not by entry.key (it is identical to the first version)
  const planB = await until('Prerender set recomputed from the new costs', async () => {
    const d = await json(`${base9}/api/frames/diagnostics`);
    out.plansSeen = (d.body?.plans || []).map(p => ({ key: p.key, set: p.prerenderSet }));
    return (d.body?.plans || []).find(p => Array.isArray(p.prerenderSet)
      && (p.controls || []).some(c => c.clipId === 'clip-stateful' && c.picked === false)) || null;
  }, 180000, 500);
  out.planAfter = planB ? { key: planB.key, prerenderSet: planB.prerenderSet,
    picked: (planB.controls || []).map(c => [c.clipId, c.picked]) } : null;
  check(!!planB, '⑨ the prerender set was recomputed from the new costs', out.plansSeen);
  check(!!planB && !planB.prerenderSet.includes('clip-stateful'), '⑨ cards classified as light are not in the prerender set', out.planAfter);
  check(!!planB && planB.prerenderSet.includes('clip-canvas'), '⑨ cards classified as heavy are still in the set', out.planAfter);

  // Wait for producer to finish updating and remove clip-stateful, and all running encoders to exit
  await until('Prerender producer updates its plan (without clip-stateful)', async () => {
    const d = await json(`${base9}/api/frames/diagnostics`);
    const ss = d.body?.streams?.streams || [];
    return ss.length > 0 && !ss.some(s => s.clipIds.includes('clip-stateful')) && (d.body?.streams?.stats?.aliveEncoders ?? 0) === 0 ? ss : null;
  }, 180000, 500);

  /*
   * "No stream produced": delete that stream directory only **after recomputation and once producer
   * has unloaded light cards**. After deletion, wait for the third version to run: the card classified
   * as heavy remains, while directory for the card classified as light does not grow back and does
   * not enter ready index.
   */
  if (statefulDir) await fs.rm(statefulDir, { recursive: true, force: true });
  await delay(500);

  const PROJECT_C = { ...PROJECT, id: `${PROJECT.id}-c`, name: 'R6 data plane probe (third version)' };
  const readyC = openReady(base9, undefined, SESSION_C);
  await until('SSE of the third version connected', () => readyC.messages.length > 0 || null, 30000);
  await postJson(EDITOR + '/api/data/project', { session: SESSION_C, localRev: 1, project: PROJECT_C });
  await until('Prerender process holds the third version', async () => (await json(`${base9}/api/data/project?session=${SESSION_C}&localRev=1`)).ok || null, 30000);
  await postJson(`${base9}/api/frames/preload`, { session: SESSION_C, localRev: 1 });
  await until('Cards classified as heavy in the third version become ready', () => indexOf(readyC.messages).has('clip-canvas/stream') || null, 300000, 500);
  const tableC = indexOf(readyC.messages);
  out.layersB = [...tableC.keys()].sort();
  check(!tableC.has('clip-stateful/stream'), '⑨ cards classified as light do not enter the ready index', out.layersB);
  check(tableC.has('clip-canvas/stream'), '⑨ cards classified as heavy are in the ready index', out.layersB);

  await delay(2000);
  out.statefulDirBack = statefulDir ? fsSync.existsSync(statefulDir) : null;
  out.canvasDir = canvasDir ? fsSync.existsSync(canvasDir) : false;
  check(out.canvasDir === true, '⑨ in the same run, cards classified as heavy still have stream directories', out.canvasDir);
  check(out.statefulDirBack === false, '⑨ cards classified as light produce no stream (the directory did not grow back after it was deleted)', { statefulDir });
  await readyC.close();

} catch (error) {
  fails.push('exception: ' + (error?.stack || error));
} finally {
  stopEditor();
  if (fails.length) {
    const diagnosticFile = path.join(EXPORT_DIR, 'ready-index-diagnostic.json');
    try {
      await fs.writeFile(diagnosticFile, JSON.stringify({ probe: 'ready-index-probe', port: PORT, streamManifest: out.streamManifest ?? null }, null, 2), 'utf8');
      out.diagnosticFile = diagnosticFile;
    } catch (error) {
      out.diagnosticWriteError = safeDiagnosticText(error?.message || String(error), 1000);
    }
  }
  if (KEEP || KEEP_OUT || fails.length) out.kept = EXPORT_DIR;
  else { await delay(500); await fs.rm(EXPORT_DIR, { recursive: true, force: true }).catch(() => {}); }
}

out.fails = fails;
out.timings = timings.list;
timings.print();
console.log(JSON.stringify(out, null, 2));
process.exit(fails.length ? 1 : 0);
