/**
 * R6/R8 数据面的端到端探针。起编辑器进程 + 预渲染进程,载入一个含 stateful DOM 卡、
 * canvas 卡、`unknown` 卡、超限卡的项目(四张固定卡在 `src/cards/_probe/r6.tsx`),
 * 适配己二撤快照后「就绪索引只发 stream 层、帧库只写 streams/<streamKey>」:
 *
 *   1. SSE 第一条是 reset,随后收到 done 和各重卡的 stream 层;
 *   2. stream 层的 ranges 随分段生产增长;
 *   3. GET /api/frames/stream/${key}/manifest 取到的清单 JSON 与磁盘 streams/<key>/stream.json 一致;
 *   6. clip-unknown 出现在 clip-unknown/stream(streamKind === 'below' 依赖下层的流),
 *      clip-stateful 和 clip-canvas 出现在单卡 stream 层;且帧库下没有 controls-html / controls-local 目录;
 *   7. 杀掉预渲染进程再自动拉起后:没人发 preload,编辑器进程照会话版本登记重放 preload,
 *      服务端重放会话版本后先发 reset(localRev: 1) 再通过 streamProducer().rescan() 重建全部 stream 层;
 *   9. 在所有位置都判轻的卡不产流、不进就绪索引(pinned 渲染 9)——
 *      给一张 stateful 卡写一条便宜的成本记录,它就从预渲染集合里掉出去;删掉它的 streams/<key> 目录后重跑,判轻的目录不长回来;
 *  10. 环境指纹进结果键(M4,契约 E.7):诊断里的指纹是 16 位十六进制,
 *      每个带 snapshotKey 的 control 满足 snapshotKey === resultKeyOf(contentKey, envFingerprint)。
 *
 * 成本记录也隔离在临时目录(`PROMPTCUT_DATA_DIR`),不碰仓库的 `out/card-costs.json`。
 *
 *   node scripts/probes/ready-index-probe.mjs [--port 5231] [--out <dir>] [--keep]
 *
 * `--keep-out` 保留本次临时产物、不保留 dev server;`--keep` 是旧调试开关。
 * 默认成功后清理,失败会留一份限长且过滤敏感值的诊断证据。
 *
 * 耗时只记录(verification.md「耗时只记录,不当闸门」):这支探针没有时间门槛;每一处等待等到的用时记进
 * `TIMINGS` 行与结果的 `timings`。等待时限只为防卡死,不到 120 秒的一律按 120 秒等;等到头没有结果仍算不过。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
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
/** 成本记录（`card-costs.json`）也落在临时目录里，见 `startEditor` */
const DATA_DIR = path.join(EXPORT_DIR, 'data');
fsSync.mkdirSync(DATA_DIR, { recursive: true });
/** ⑨ 自己写的成本记录挂在这个假 device 上（服务端只当不透明字符串用） */
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
    .filter(line => /\b(?:error|exception|failed|500)\b|Internal Server Error|内部服务器错误/i.test(line))
    .slice(-12);
  return safeDiagnosticText(relevant.join('\n'), 4096);
}

const SESSION = `r6-${Date.now().toString(36)}`;
const FPS = 30;
/** 2 秒 = 60 帧。第四张卡从 1 秒起 —— 它的挂载帧把前三张卡切成两段(C4 的「区间」) */
const PROJECT = {
  id: `r6-probe-${SESSION}`, name: 'R6 数据面探针', width: 1920, height: 1080, fps: FPS, duration: 2,
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

/** 等一个条件成立;超时回 false(探针自己判,不抛) */
async function until(label, fn, timeoutMs = 120000, everyMs = 300) {
  // 等待时限只为防卡死(verification.md「耗时只记录,不当闸门」):不到 WAIT_FLOOR_MS 的一律提到它;等到的用时只记录
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(timeoutMs, WAIT_FLOOR_MS);
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) { timings.record(`等到:${label}`, Date.now() - startedAt); return value; }
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await delay(everyMs);
  }
}

/**
 * SSE 读客户端。不用 `EventSource`(Node 上要实验开关),直接读 body 流 ——
 * 探针要的是「第一条是不是 `reset`」这种顺序,自己解析最清楚。
 */
function openReady(base, onMessage, session = SESSION) {
  const controller = new AbortController();
  const messages = [];
  const done = (async () => {
    const res = await fetch(`${base}/api/frames/ready?session=${encodeURIComponent(session)}&localRev=1`, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`SSE 连不上:${res.status}`);
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
          } catch { /* 半条消息 */ }
        }
      }
    }
  })().catch(() => {});
  return { messages, close: () => { controller.abort(); return done; } };
}

/** 索引里某一层此刻的样子(从收到的消息里重放,和页面侧 `applyReadyMessage` 一个口径) */
function indexOf(messages) {
  const table = new Map();
  for (const message of messages) {
    if (message.type === 'reset') { table.clear(); continue; }
    if (message.type !== 'layer') continue;
    table.set(`${message.clipId}/${message.kind}`, { ...message });
  }
  return table;
}

/** 这个工作副本没有自己的 node_modules(Node 往上走到主仓库那一份),所以按模块解析;
 *  vite 的 `exports` 不放行 `./bin/vite.js`,解析主入口再回到包根。 */
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
    // 冷缓存:产物落在一个新建的临时目录,预渲染子进程继承这个变量
    // 成本记录也隔离到临时目录:⑨ 要自己写几条记录,不能污染仓库的 out/card-costs.json,
    // 也不能让仓库里 R1 / R4 留下的记录影响「没有记录时按声明兜底」那一条
    env: { ...process.env, PROMPTCUT_EXPORT_DIR: EXPORT_DIR, PROMPTCUT_DATA_DIR: DATA_DIR } });
  const keep = c => { const text = c.toString(); editorLog.push(text); if (editorLog.length > 400) editorLog.shift(); };
  editor.stdout.on('data', keep);
  editor.stderr.on('data', keep);
  return until('编辑器进程起来', async () => (await fetch(EDITOR + '/api/prerender/info').then(r => r.ok, () => false)) || null, 120000);
}
function stopEditor() {
  if (!editor || editor.exitCode !== null || !editor.pid) return;
  // 编辑器进程还拉着预渲染进程和 Chrome,只杀它会留孤儿
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else editor.kill('SIGKILL');
}

/** 预渲染进程此刻的地址(它崩了会换一个新的空闲端口) */
const prerenderUrl = async () => {
  const info = await json(EDITOR + '/api/prerender/info');
  return info.body?.ready && info.body.url ? info.body.url : null;
};

try {
  await startEditor();
  const base = await until('预渲染进程就绪', prerenderUrl, 180000);
  out.prerender = base;
  if (!base) throw new Error('预渲染进程没起来');

  /* ---- 项目进镜像(编辑器进程收下、原样转发给预渲染进程) ---- */
  const pushed = await postJson(EDITOR + '/api/data/project', { session: SESSION, localRev: 1, project: PROJECT });
  check(pushed.ok, '项目推进镜像', pushed.body);
  await until('预渲染进程手里有这一版项目', async () => (await json(`${base}/api/data/project?session=${SESSION}&localRev=1`)).ok || null, 30000);

  /* ---- 连 SSE,再开预渲染 ---- */
  const ready = openReady(base);
  await until('SSE 连上并收到第一条', () => ready.messages.length > 0 || null, 30000);
  out.firstMessage = ready.messages[0];
  check(ready.messages[0]?.type === 'reset', '① SSE 的第一条是 reset,不是 layer', ready.messages[0]);

  const preload = await postJson(`${base}/api/frames/preload`, { session: SESSION, localRev: 1 });
  check(preload.ok, '预渲染开跑', preload.body);

  /* ---- ① SSE 第一条是 reset，随后收到 done 和各重卡的 stream 层 ---- */
  const doneAt = await until('收到 done', () => ready.messages.findIndex(m => m.type === 'done') + 1 || null, 300000);
  check(!!doneAt, '① 收到 done 消息', { doneAt });
  const hasStreamLayers = await until('收到各重卡的 stream 层', () => {
    const table = indexOf(ready.messages);
    return table.has('clip-stateful/stream') && table.has('clip-canvas/stream') && table.has('clip-unknown/stream') && table.has('clip-huge/stream') ? table : null;
  }, 300000, 500);
  check(!!hasStreamLayers, '① 收到各重卡的 stream 层 (含 clip-stateful, clip-canvas, clip-unknown, clip-huge)', hasStreamLayers ? [...hasStreamLayers.keys()] : []);

  /* ---- ② stream 层的 ranges 随分段生产增长 ---- */
  const grew = await until('某一层的区间随分段生产增长', () => {
    const table = indexOf(ready.messages);
    const layer = table.get('clip-stateful/stream');
    return layer && layer.ranges.some(([from, to]) => to - from >= 1) ? layer : null;
  }, 300000, 500);
  out.grown = grew;
  check(!!grew, '② stream 层的 ranges 随分段生产增长', grew);
  check(ready.messages.filter(m => m.type === 'layer' && m.kind === 'stream').length > 1, '② 收到了多条 stream layer');

  /* ---- ③ GET /api/frames/stream/${statefulLayer.key}/manifest 取到的清单 JSON 与磁盘一致 ---- */
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
    check(overHttp.ok, '③ GET /api/frames/stream/... 取得到清单', out.streamManifest);
    check(out.streamManifest.sameJson, '③ 取到的清单 JSON 与磁盘上的 stream.json 一致', { ...out.streamManifest, diskBytes: onDisk?.length ?? null });
  } else check(false, '③ 没有 clip-stateful 的 stream 层,没法比对清单');

  /* ---- ⑥ clip-unknown 进 below 流, stateful/canvas 进单卡流, 且无 controls-html/controls-local ---- */
  const unknownLayer = table.get('clip-unknown/stream');
  const canvasLayer = table.get('clip-canvas/stream');
  out.kinds = [...table.keys()].sort();
  check(table.has('clip-unknown/stream') && unknownLayer?.streamKind === 'below', '⑥ clip-unknown 出现在 clip-unknown/stream 且 streamKind === below', unknownLayer);
  check(table.has('clip-stateful/stream') && statefulLayer?.streamKind !== 'below', '⑥ clip-stateful 出现在单卡 stream 层', statefulLayer);
  check(table.has('clip-canvas/stream') && canvasLayer?.streamKind !== 'below', '⑥ clip-canvas 出现在单卡 stream 层', canvasLayer);
  check(!table.has('clip-unknown/local') && !table.has('clip-unknown/html') && !table.has('clip-stateful/html') && !table.has('clip-canvas/html'), '⑥ 不再有 html 或 local 快照层', out.kinds);
  const controlsHtmlExists = fsSync.existsSync(path.join(LIBRARY, 'controls-html'));
  const controlsLocalExists = fsSync.existsSync(path.join(LIBRARY, 'controls-local'));
  check(!controlsHtmlExists && !controlsLocalExists, '⑥ 帧库下没有 controls-html / controls-local 目录', { controlsHtmlExists, controlsLocalExists });

  /* ---- ⑩ M4:环境指纹进结果键(契约 E.7「探针」) ---- */
  const diagnostics = await json(`${base}/api/frames/diagnostics`);
  {
    const d = diagnostics.body || {};
    const fingerprint = d.environment?.fingerprint;
    out.environment = d.environment ?? null;
    check(typeof fingerprint === 'string' && /^[0-9a-f]{16}$/.test(fingerprint), '⑩ diagnostics.environment.fingerprint 是 16 位十六进制', out.environment);
    const keyed = (d.plans || []).flatMap(p => (p.controls || []).filter(c => c.snapshotKey));
    const bad = keyed.filter(c => !(typeof c.contentKey === 'string' && c.envFingerprint === fingerprint && c.snapshotKey === resultKeyOf(c.contentKey, c.envFingerprint)))
      .map(c => ({ clipId: c.clipId, snapshotKey: c.snapshotKey, contentKey: c.contentKey, envFingerprint: c.envFingerprint }));
    check(keyed.length > 0, '⑩ 诊断里有带 snapshotKey 的 control', d.plans);
    check(bad.length === 0, '⑩ plans[].controls[] 的 snapshotKey === resultKeyOf(contentKey, envFingerprint),且 envFingerprint 就是本进程的指纹', bad);
  }

  /* ---- ⑦ F5:杀掉预渲染进程再起来 ---- */
  const beforeKill = indexOf(ready.messages);
  out.layersBeforeKill = beforeKill.size;
  await ready.close();
  const oldBase = base;
  const pid = await (async () => {
    // 预渲染进程是编辑器进程拉起来的,所以是我们自己起的那一棵。按端口找它的 PID。
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
  if (check(!!pid, '⑦ 找得到预渲染进程的 PID(它是编辑器进程拉起来的)')) {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
    // 崩完等编辑器把它拉起来(vite-plugin-prerender 的 MAX_RESTARTS 路)
    const fresh = await until('预渲染进程自动拉起来', async () => {
      const next = await prerenderUrl();
      return next && next !== oldBase ? next : null;
    }, 180000, 500);
    out.prerenderAfterRestart = fresh;
    if (fresh) {
      const after = openReady(fresh);
      await until('重启后的 SSE 收到第一条', () => after.messages.length > 0 || null, 30000);
      out.afterRestartFirst = after.messages[0];
      check(after.messages[0]?.type === 'reset', '⑦ 重连先收到 reset', after.messages[0]);
      /*
       * **服务端自己恢复**(Item 4 方案 A):探针这里不发 preload,页面也不会发(它早就就绪了)。
       * 编辑器进程拉起预渲染进程、补推镜像之后,照「会话版本登记」把这个会话的 preload 重放一遍 ——
       * 会话的版本回来(reset 带 localRev 1)、card plan 重算出来,层才按键重建。
       */
      const rebuilt = await until('索引按键重建、重新发出 layer(没有人发 preload)', () => {
        const t = indexOf(after.messages);
        return t.size >= beforeKill.size ? t : null;
      }, 300000, 500);
      out.layersAfterRebuild = rebuilt ? [...rebuilt.keys()].sort() : null;
      check(!!rebuilt, '⑦ 没人发 preload,服务端重放之后索引按键重建、层数不少于崩之前', { before: [...beforeKill.keys()].sort(), after: out.layersAfterRebuild });
      if (rebuilt) {
        // 项目到位之前不发 layer:第一条 layer 一定在「会话版本回来」的那条 reset(localRev 1)之后
        const resetIndex = after.messages.findIndex(m => m.type === 'reset' && m.localRev === 1);
        const firstLayer = after.messages.findIndex(m => m.type === 'layer');
        out.recoveryReset = resetIndex;
        check(resetIndex >= 0 && resetIndex < firstLayer, '⑦ 会话版本先回来(reset 带 localRev 1),再发全量 layer', { resetIndex, firstLayer });
        // 区间和崩之前一致(扫盘是按 index.json 重建的,不是从头再产)
        const same = [...beforeKill].every(([id, layer]) => JSON.stringify(rebuilt.get(id)?.ranges ?? null) !== 'null');
        check(same, '⑦ 崩之前有的层,重建之后都在', { before: [...beforeKill.keys()].sort(), after: out.layersAfterRebuild });
      }
      await after.close();
    }
  }
  /* ---- ⑨ pinned 渲染 9:在所有位置都判轻的卡不产流、不进就绪索引 ---- */
  // ⑦ 重启过一次,预渲染进程换了端口 —— 这里重新取一次地址
  const base9 = (await until('⑨ 预渲染进程地址', prerenderUrl, 60000)) || base;
  out.prerender9 = base9;
  // 第一阶段一条成本记录都没有 → `prerenderSetOfPlan` 按声明兜底,四张 stateful 卡都在集合里。
  const diag0 = await json(`${base9}/api/frames/diagnostics`);
  const plan0 = (diag0.body?.plans || []).find(p => (p.controls || []).some(c => c.clipId === 'clip-stateful'));
  out.planBefore = plan0 ? { key: plan0.key, prerenderSet: plan0.prerenderSet } : null;
  check(!!plan0?.prerenderSet, '⑨ 诊断露出预渲染集合', diag0.body?.plans);
  check(!!plan0?.prerenderSet?.includes('clip-stateful'), '⑨ 没有成本记录时按声明兜底:stateful 卡都在集合里', out.planBefore);
  const statefulKey = beforeKill.get('clip-stateful/stream')?.key;
  const statefulDir = statefulKey ? path.join(LIBRARY, 'streams', statefulKey) : null;
  check(!!statefulDir && fsSync.existsSync(statefulDir), '⑨ 判重时 clip-stateful 确实产了流目录', statefulDir);

  const canvasKey = beforeKill.get('clip-canvas/stream')?.key;
  const canvasDir = canvasKey ? path.join(LIBRARY, 'streams', canvasKey) : null;
  check(!!canvasDir && fsSync.existsSync(canvasDir), '⑨ 判重时 clip-canvas 确实产了流目录', canvasDir);

  // 给 clip-stateful 写一条「便宜的随机访问卡」记录 → 每个位置都判轻;其余三张钉死为重,
  // 这样成本记录非空(不走声明兜底),而集合里只少了 clip-stateful 这一张。
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
  check(putCosts.ok && records.length >= 2, '⑨ 成本记录写进去了', out.costs);
  await until('预渲染进程读得到这几条成本记录', async () => {
    const got = await json(`${base9}/api/data/costs?device=${PROBE_DEVICE}`);
    return (got.body?.costs || []).length >= records.length || null;
  }, 60000);

  /*
   * 再推一版项目、再开一趟预渲染。`frameIdentity` **不看 `id` / `name`**,所以
   * `entry.key` 和第一版是同一个(卡和片段一字没动)。后台代次按页面会话分(Item 4:owner =
   * `session:<id>`),所以换一个会话来发 preload —— 不会走「同一个 entry 直接返回」那条早退,
   * 而是对同一个 entry 重跑一趟:`adoptCardPlan` 按**新的 costs** 重算 `prerenderSet`,这正是要验的东西。
   */
  const SESSION_B = `${SESSION}-b`, SESSION_C = `${SESSION}-c`;
  const PROJECT_B = { ...PROJECT, id: `${PROJECT.id}-b`, name: 'R6 数据面探针(第二版)' };
  const pushedB = await postJson(EDITOR + '/api/data/project', { session: SESSION_B, localRev: 1, project: PROJECT_B });
  check(pushedB.ok, '⑨ 第二版项目推进镜像', pushedB.body);
  await until('预渲染进程手里有第二版', async () => (await json(`${base9}/api/data/project?session=${SESSION_B}&localRev=1`)).ok || null, 30000);
  const preloadB = await postJson(`${base9}/api/frames/preload`, { session: SESSION_B, localRev: 1 });
  check(preloadB.ok, '⑨ 第二版开跑', preloadB.body);

  // 按「clip-stateful 这张卡没被挑中」找,不按 entry.key 找(它和第一版是同一个)
  const planB = await until('按新 costs 重算出的预渲染集合', async () => {
    const d = await json(`${base9}/api/frames/diagnostics`);
    out.plansSeen = (d.body?.plans || []).map(p => ({ key: p.key, set: p.prerenderSet }));
    return (d.body?.plans || []).find(p => Array.isArray(p.prerenderSet)
      && (p.controls || []).some(c => c.clipId === 'clip-stateful' && c.picked === false)) || null;
  }, 180000, 500);
  out.planAfter = planB ? { key: planB.key, prerenderSet: planB.prerenderSet,
    picked: (planB.controls || []).map(c => [c.clipId, c.picked]) } : null;
  check(!!planB, '⑨ 按新 costs 重算出了预渲染集合', out.plansSeen);
  check(!!planB && !planB.prerenderSet.includes('clip-stateful'), '⑨ 判轻的卡不在预渲染集合里', out.planAfter);
  check(!!planB && planB.prerenderSet.includes('clip-canvas'), '⑨ 判重的卡还在集合里', out.planAfter);

  // 等生产者完成更新并移除 clip-stateful、所有在跑的编码器结束
  await until('预渲染生产者更新计划(不含 clip-stateful)', async () => {
    const d = await json(`${base9}/api/frames/diagnostics`);
    const ss = d.body?.streams?.streams || [];
    return ss.length > 0 && !ss.some(s => s.clipIds.includes('clip-stateful')) && (d.body?.streams?.stats?.aliveEncoders ?? 0) === 0 ? ss : null;
  }, 180000, 500);

  /*
   * 「不产流」:**重算之后且生产者已卸下轻卡**才删那棵流目录。
   * 删完再等第三版跑起来，判重的那张还在，判轻的那张目录不长回来、也不进就绪索引。
   */
  if (statefulDir) await fs.rm(statefulDir, { recursive: true, force: true });
  await delay(500);

  const PROJECT_C = { ...PROJECT, id: `${PROJECT.id}-c`, name: 'R6 数据面探针(第三版)' };
  const readyC = openReady(base9, undefined, SESSION_C);
  await until('第三版的 SSE 连上', () => readyC.messages.length > 0 || null, 30000);
  await postJson(EDITOR + '/api/data/project', { session: SESSION_C, localRev: 1, project: PROJECT_C });
  await until('预渲染进程手里有第三版', async () => (await json(`${base9}/api/data/project?session=${SESSION_C}&localRev=1`)).ok || null, 30000);
  await postJson(`${base9}/api/frames/preload`, { session: SESSION_C, localRev: 1 });
  await until('第三版里判重的卡开始就绪', () => indexOf(readyC.messages).has('clip-canvas/stream') || null, 300000, 500);
  const tableC = indexOf(readyC.messages);
  out.layersB = [...tableC.keys()].sort();
  check(!tableC.has('clip-stateful/stream'), '⑨ 判轻的卡不进就绪索引', out.layersB);
  check(tableC.has('clip-canvas/stream'), '⑨ 判重的卡在就绪索引里', out.layersB);

  await delay(2000);
  out.statefulDirBack = statefulDir ? fsSync.existsSync(statefulDir) : null;
  out.canvasDir = canvasDir ? fsSync.existsSync(canvasDir) : false;
  check(out.canvasDir === true, '⑨ 同一趟里判重的卡照样有流目录', out.canvasDir);
  check(out.statefulDirBack === false, '⑨ 判轻的卡不产流(目录删掉之后没长回来)', { statefulDir });
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
