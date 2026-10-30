/**
 * C6.6 两档素材与上传队列的现场探针(`docs/plan/c66-design.md` 第 2、3 节,验收 T1、T3)。
 *
 * 起两台真的编辑器(本检出、vite):
 *   - **R**:只当「远程素材服务」,端口 `--port-r`(缺省 5563);
 *   - **A**:导入方,端口 `--port-a`(缺省 5560),`PROMPTCUT_ASSET_URL` 指向 R 的素材服务 —— 上传队列的目标是 R。
 * 两台各用一个临时的 `PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`,不碰本检出的 out/ 和用户数据目录。
 *
 * 现场用 ffmpeg 生成三个素材(第 8 节「测试素材」):
 *   1. 1080p、带音轨、moov 在尾的 MP4(ffmpeg 写 MP4 的缺省,约 17 MB,3 片);
 *   2. ProRes 422 HQ 的 MOV(10 bit,无音轨);
 *   3. 640×360 的 H.264 MP4,刻意不加 `+faststart`(晚置 moov)。
 * 按页面导入的同一个请求(`POST /api/media/upload/<名字>?tiers=1`)依次导入 A,然后核对:
 *   - 重封装:三个都缺 faststart,都重封装了;新哈希 ≠ 源文件 sha256;库里的素材原尺寸 moov 在前、各流编码与源文件相同;
 *   - 素材小尺寸:A 的 `GET /api/media/tiers` 报 ready;素材小尺寸 ≤ 800×600、H.264、faststart;不放大;
 *   - 队列:A 的上传队列清空;日志里的顺序是「逐个素材、先小后大」(`upload.tier-start` / `tier-done` / `item-done`);
 *   - R 上六个哈希(三个素材 × 两档)的 `chunks` 各自 `complete: true`,取回的字节 sha256 对得上;
 *   - T4(C6.6 集成加):A 上开一个编辑器页面,导入、转码、上传期间每 120 ms 编辑一次,
 *     `PerformanceObserver('longtask')` 在这段窗口里记到的 > 50 ms 长任务为 0(原始条目在 `t4.longtasks`)。
 *
 *   node scripts/probes/tiers-probe.mjs [--port-a 5560] [--port-r 5563] [--timeout-min 6] [--keep]
 *                                       [--cpu-throttle <倍数>] [--trace <文件.json>]
 *
 * 只给剖析用的两个开关(缺省都不开,不改 T4 的判定):
 *   --cpu-throttle N  T4 对照窗口开始前用 CDP `Emulation.setCPUThrottlingRate` 把页面压慢 N 倍(在快机器上模拟慢机器);
 *   --trace 文件      从 T4 对照窗口开始到上传队列清空录一份 Chrome trace(含 V8 采样)写到该文件,
 *                     DevTools 的 Performance 面板能打开,`scripts/probes/longtask-stacks.mjs` 能汇总长任务里的调用栈。
 *
 * 端口:每台编辑器另占「端口 +1」「端口 +2」当舞台端口,三个连号都要空着(A 5560～5562,R 5563～5565);
 * 编辑器自己拉起的预渲染进程由系统给空端口(`vite-plugin-prerender.ts`)。结束时只结束本探针起的进程树。
 * 输出最后一行是一行 JSON:`{ ok, imports, queueOrder, remote, t4, fails }`。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT_A = Number(arg('--port-a', 5560));
const PORT_R = Number(arg('--port-r', 5563));
const TIMEOUT_MS = Number(arg('--timeout-min', 6)) * 60_000;
const KEEP = args.includes('--keep');
const CPU_THROTTLE = Number(arg('--cpu-throttle', 0));
const TRACE_FILE = arg('--trace', null);
const STAMP = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), `pc-tiers-probe-${STAMP}`);

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return cond; };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
async function until(label, fn, timeoutMs = 120_000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await delay(everyMs);
  }
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
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGKILL');
}
const portFree = async (port) => {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
};
const ff = (argv) => {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-v', 'error', ...argv], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 失败:${r.stderr}`);
};
const ffprobe = (file) => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true, encoding: 'utf8' }).stdout);

const children = [];
async function startEditor(label, port, extraEnv) {
  const exportDir = path.join(WORK, label);
  await fs.mkdir(path.join(exportDir, 'data'), { recursive: true });
  const env = { ...process.env, PROMPTCUT_EXPORT_DIR: exportDir, PROMPTCUT_DATA_DIR: path.join(exportDir, 'data'), PROMPTCUT_STREAMS: '0', ...extraEnv };
  for (const name of ['PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_SHARED_CONFIG', 'PROMPTCUT_PUSH', 'PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_HEADLESS']) delete env[name];
  if (!extraEnv.PROMPTCUT_ASSET_URL) delete env.PROMPTCUT_ASSET_URL;
  const editor = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  children.push(editor);
  const log = [];
  let partial = '';
  const keep = (c) => {
    const lines = (partial + c.toString()).split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) { log.push(line); if (log.length > 4000) log.shift(); }
  };
  editor.stdout.on('data', keep); editor.stderr.on('data', keep);
  const origin = `http://127.0.0.1:${port}`;
  await until(`[${label}] 编辑器起来`, async () => (await fetch(`${origin}/api/media/upload-queue`).then((r) => r.ok, () => false)) || null, 120_000);
  return { label, origin, exportDir, log };
}

const out = { ports: { a: PORT_A, r: PORT_R }, work: WORK };
let ok = false;
let browser = null;
try {
  for (const p of [PORT_A, PORT_A + 1, PORT_A + 2, PORT_R, PORT_R + 1, PORT_R + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  const { faststartState } = await import(pathToFileURL(path.join(ROOT, 'server', 'media-tiers.mjs')).href);

  // ---- 素材 ----
  const fx = path.join(WORK, 'fixtures');
  await fs.mkdir(fx, { recursive: true });
  const SOURCES = [
    { name: 'probe-1080p.mp4', file: path.join(fx, 'probe-1080p.mp4'), make: (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]) },
    { name: 'probe-prores.mov', file: path.join(fx, 'probe-prores.mov'), make: (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-an', f]) },
    { name: 'probe-late-moov.mp4', file: path.join(fx, 'probe-late-moov.mp4'), make: (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-an', f]) },
  ];
  for (const s of SOURCES) {
    s.make(s.file);
    s.sha = sha(await fs.readFile(s.file));
    s.faststart = await faststartState(s.file);
    s.codecs = ffprobe(s.file).streams.map((x) => `${x.codec_type}:${x.codec_name}`);
    check(s.faststart === 'needs', `${s.name} 应当缺 faststart`, s.faststart);
  }

  // ---- 两台编辑器 ----
  const R = await startEditor('r', PORT_R, {});
  const A = await startEditor('a', PORT_A, { PROMPTCUT_ASSET_URL: `http://127.0.0.1:${PORT_R}/api/asset` });
  if (!R || !A) throw new Error('编辑器没起来');
  const q0 = await (await fetch(`${A.origin}/api/media/upload-queue`)).json();
  check(q0.target?.base === `http://127.0.0.1:${PORT_R}/api/asset`, 'A 的上传目标是 R', q0.target);

  // ---- T4(设计稿第 6 节):后台导入、转码、上传期间页面继续编辑,主线程没有 > 50 ms 的长任务 ----
  // A 上开一个编辑器页面(?nosetup=1 不弹首启对话框),等打开项目的测量遮罩退下、再静置 5 s,
  // 之后挂 PerformanceObserver('longtask'),并每 120 ms 做一次编辑(拖播放头、挪片段、改参数、改标签)。
  // 窗口 = 第一个导入请求发出 → 上传队列清空;窗口里的长任务原样记进 out.t4。
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1440, height: 900 }, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 300)));
  await page.goto(`${A.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded' });
  await until('[a] 页面与舞台起来', () => page.evaluate(() => document.querySelectorAll('iframe').length >= 2), 300_000);
  // 测量遮罩在页面起来约 3 s 后才出现(docs/archive/agent-reports/AGENT-perf-t4.md「没做的与建议」第 3 条):只等「没有遮罩」
  // 会在它出现之前就放行,测量和后面的静置、对照窗口叠在一起。所以先等测量开始(遮罩出现,或 probeRunner 报 running),
  // 再等它结束(遮罩退下且不再 running)。项目里没有要测的卡时测量根本不开始:等满 GATE_APPEAR_MS 没见到就照常往下走。
  const gateState = () => page.evaluate(async () => {
    const gate = !!document.querySelector('[data-pc="probe-gate"]');
    let running = false;
    try { running = !!(await import('/src/editor/probeRunner.ts')).probeProgress().running; } catch { /* 取不到就只看遮罩 */ }
    return { gate, running };
  });
  const GATE_APPEAR_MS = 30_000;
  const gateSeen = await until('[a] 测量开始(遮罩出现)', async () => { const s = await gateState(); return s.gate || s.running ? s : null; }, GATE_APPEAR_MS, 100);
  if (gateSeen) {
    await until('[a] 测量结束、遮罩退下', async () => { const s = await gateState(); return !s.gate && !s.running; }, 300_000, 200);
    out.probeGate = 'shown-then-gone';
  } else {
    if (fails.at(-1) === '超时:[a] 测量开始(遮罩出现)') fails.pop(); // 没见到遮罩不算失败:这个项目没有要测的卡
    out.probeGate = 'never-shown';
  }
  // 页面打开时把上传目标交回缺省({ base: null } → PROMPTCUT_ASSET_URL):目标仍是 R
  await delay(5000);
  const q1 = await (await fetch(`${A.origin}/api/media/upload-queue`)).json();
  check(q1.target?.base === `http://127.0.0.1:${PORT_R}/api/asset`, '页面打开后 A 的上传目标仍是 R(null 回到缺省目标)', q1.target);
  if (CPU_THROTTLE > 1) {
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
    out.cpuThrottle = CPU_THROTTLE;
  }
  if (TRACE_FILE) {
    await page.tracing.start({ path: path.resolve(TRACE_FILE), categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'disabled-by-default-v8.cpu_profiler', 'blink.user_timing', 'toplevel'] });
  }
  await page.evaluate(() => {
    window.__pcLong = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__pcLong.push({ at: Math.round(performance.timeOrigin + e.startTime), ms: Math.round(e.duration), name: e.name,
          attr: (e.attribution ?? []).map((a) => a.containerSrc || a.containerType || a.name).join(',') });
      }
    }).observe({ type: 'longtask' });
    window.__pcEdits = 0;
    window.__pcEditErrors = 0;
    window.__pcEditing = true;
    void (async () => {
      const S = await import('/src/store/project.ts');
      for (let i = 0; window.__pcEditing; i++) {
        try {
          const clips = S.getState().project.tracks.flatMap((t) => t.clips);
          const c = clips[i % Math.max(1, clips.length)];
          const d = (i % 8) < 4 ? 0.1 : -0.1;
          const kind = ['seek', 'move', 'params', 'label'][i % 4];
          const t = performance.now();
          if (kind === 'seek') S.actions.seek((i * 0.37) % 18);
          else if (kind === 'move' && c) S.actions.moveClip(c.id, { start: c.start + d, end: c.end + d });
          else if (kind === 'params' && c?.cardId) S.actions.setClipParams(c.id, { text: `T4-${i}` });
          else if (c) S.actions.updateClip(c.id, { label: `T4 ${i}` });
          (window.__pcEditLog ??= []).push({ at: Math.round(performance.timeOrigin + t), kind, syncMs: Math.round(performance.now() - t) });
          performance.mark(`pc:edit:${kind}`);
          window.__pcEdits++;
        } catch { window.__pcEditErrors++; }
        await new Promise((r) => setTimeout(r, 120));
      }
    })();
  });
  // 对照窗口:同样的编辑、没有导入和上传,先跑 3 s —— 分得清长任务是编辑本身的还是后台上传带来的
  const baseStart = Date.now();
  await delay(3000);
  const t4Start = Date.now();
  await page.evaluate(() => performance.mark("pc:upload-window")).catch(() => {});

  // ---- 导入(与页面同一个请求) ----
  out.imports = [];
  for (const s of SOURCES) {
    const t0 = Date.now();
    const res = await fetch(`${A.origin}/api/media/upload/${encodeURIComponent(s.name)}?tiers=1`, { method: 'POST', body: await fs.readFile(s.file) });
    const body = await res.json();
    s.body = body;
    s.importMs = Date.now() - t0;
  }
  // ---- 素材小尺寸 ----
  const hashes = SOURCES.map((s) => s.body.hash);
  const tiers = await until('素材小尺寸全部生成', async () => {
    const j = await (await fetch(`${A.origin}/api/media/tiers?hashes=${hashes.join(',')}`)).json();
    return hashes.every((h) => j.items[h]?.state && j.items[h].state !== 'pending') ? j.items : null;
  }, TIMEOUT_MS);
  const dl = path.join(WORK, 'dl');
  await fs.mkdir(dl, { recursive: true });
  for (const s of SOURCES) {
    const b = s.body;
    const rec = tiers?.[b.hash] ?? {};
    const row = { name: s.name, src: s.sha.slice(0, 12), original: b.hash?.slice(0, 12), small: rec.small?.slice(0, 12) ?? null, remux: b.remux?.state, smallState: rec.state, importMs: s.importMs };
    check(b.ok === true && b.tiers?.original === b.hash, `${s.name} 回包有 tiers.original`, b);
    check(b.remux?.state === 'remuxed' && b.remux.from === s.sha && b.hash !== s.sha, `${s.name} 重封装、按输出哈希入库`, b.remux);
    // 素材原尺寸:从 A 取回,moov 在前,编码与源文件相同
    const origFile = path.join(dl, `${b.hash}.${b.ext}`);
    const origBytes = Buffer.from(await (await fetch(`${A.origin}/@media/${b.hash}`)).arrayBuffer());
    await fs.writeFile(origFile, origBytes);
    row.originalFaststart = await faststartState(origFile);
    row.originalCodecs = ffprobe(origFile).streams.map((x) => `${x.codec_type}:${x.codec_name}`);
    check(sha(origBytes) === b.hash, `${s.name} 素材原尺寸字节与哈希相符`);
    check(row.originalFaststart === 'faststart', `${s.name} 素材原尺寸 moov 在前`, row.originalFaststart);
    check(JSON.stringify(row.originalCodecs) === JSON.stringify(s.codecs), `${s.name} 素材原尺寸编码不变`, { src: s.codecs, got: row.originalCodecs });
    // 素材小尺寸
    check(rec.state === 'ready' && /^[0-9a-f]{64}$/.test(rec.small ?? ''), `${s.name} 素材小尺寸 ready`, rec);
    if (rec.small) {
      const smallFile = path.join(dl, `${rec.small}.mp4`);
      await fs.writeFile(smallFile, Buffer.from(await (await fetch(`${A.origin}/@media/${rec.small}`)).arrayBuffer()));
      const v = ffprobe(smallFile).streams.find((x) => x.codec_type === 'video');
      const srcV = ffprobe(s.file).streams.find((x) => x.codec_type === 'video');
      row.smallSize = `${v.width}x${v.height}`;
      row.smallCodec = v.codec_name;
      row.smallFaststart = await faststartState(smallFile);
      check(v.codec_name === 'h264', `${s.name} 素材小尺寸 H.264`, v.codec_name);
      check(v.width <= 800 && v.height <= 600 && v.width % 2 === 0 && v.height % 2 === 0, `${s.name} 素材小尺寸 ≤ 800×600 且偶数`, row.smallSize);
      check(v.width <= srcV.width && v.height <= srcV.height, `${s.name} 素材小尺寸不放大`, row.smallSize);
      check(row.smallFaststart === 'faststart', `${s.name} 素材小尺寸 faststart`, row.smallFaststart);
    }
    out.imports.push(row);
  }

  // ---- 上传队列:清空、顺序 ----
  await until('A 的上传队列清空', async () => {
    const j = await (await fetch(`${A.origin}/api/media/upload-queue`)).json();
    return j.queue && j.queue.items.length === 0 && !j.queue.working ? j : null;
  }, TIMEOUT_MS, 100);
  const t4End = Date.now();
  if (TRACE_FILE) { await page.tracing.stop(); out.trace = path.resolve(TRACE_FILE); }
  const t4 = await page.evaluate(() => { window.__pcEditing = false; return { long: window.__pcLong, edits: window.__pcEdits, editErrors: window.__pcEditErrors, log: window.__pcEditLog ?? [] }; });
  // 每个长任务前面最近的一次编辑是哪一种(编辑本身慢,还是和编辑无关)
  const withEdit = (e) => { const prev = t4.log.filter((x) => x.at <= e.at + 1).at(-1); return { ...e, afterEdit: prev ? { kind: prev.kind, dtMs: e.at - prev.at, syncMs: prev.syncMs } : null }; };
  const inWindow = t4.long.filter((e) => e.at + e.ms >= t4Start && e.at <= t4End).map(withEdit);
  const inBase = t4.long.filter((e) => e.at + e.ms >= baseStart && e.at < t4Start).map(withEdit);
  const editsIn = (a, b) => t4.log.filter((x) => x.at >= a && x.at <= b);
  const bySyncKind = (list) => Object.fromEntries(['seek', 'move', 'params', 'label'].map((k) => { const xs = list.filter((x) => x.kind === k).map((x) => x.syncMs); return [k, xs.length ? { n: xs.length, maxSyncMs: Math.max(...xs) } : null]; }));
  out.t4 = {
    windowMs: t4End - t4Start, edits: editsIn(t4Start, t4End).length, editErrors: t4.editErrors,
    longtasks: inWindow, longtasksOver50: inWindow.filter((e) => e.ms > 50).length,
    baseline: { windowMs: t4Start - baseStart, edits: editsIn(baseStart, t4Start).length, longtasks: inBase, longtasksOver50: inBase.filter((e) => e.ms > 50).length },
    editSync: bySyncKind(t4.log), pageErrors,
  };
  check(out.t4.edits >= Math.floor(out.t4.windowMs / 200), 'T4 窗口里一直在编辑', { edits: out.t4.edits, windowMs: out.t4.windowMs });
  check(out.t4.longtasksOver50 === 0, 'T4 后台上传期间页面主线程没有 > 50 ms 的长任务', inWindow);
  const short = (h) => {
    for (const s of SOURCES) {
      if (h === s.body.hash) return `${s.name}:original`;
      if (h === tiers?.[s.body.hash]?.small) return `${s.name}:small`;
    }
    return h.slice(0, 8);
  };
  const events = [];
  for (const line of A.log) {
    const m = /\[media-tiers\] (upload\.(?:tier-start|tier-done|item-done|retry)) (\{.*\})$/.exec(line);
    if (!m) continue;
    const f = JSON.parse(m[2]);
    events.push(m[1] === 'upload.item-done' ? `item-done ${short(f.id)}` : `${m[1].slice(7)} ${short(f.hash ?? f.id)}`);
  }
  out.queueOrder = events;
  const expected = SOURCES.flatMap((s) => [`tier-start ${s.name}:small`, `tier-done ${s.name}:small`, `tier-start ${s.name}:original`, `tier-done ${s.name}:original`, `item-done ${s.name}:original`]);
  check(JSON.stringify(events) === JSON.stringify(expected), '队列顺序:逐个素材、先小后大', events);

  // ---- R 上两档分别 complete ----
  out.remote = {};
  for (const s of SOURCES) {
    for (const [tier, h] of [['small', tiers?.[s.body.hash]?.small], ['original', s.body.hash]]) {
      if (!h) continue;
      const c = await (await fetch(`${R.origin}/api/asset/media/${h}/chunks`)).json();
      const bytes = Buffer.from(await (await fetch(`${R.origin}/api/asset/media/${h}`)).arrayBuffer());
      out.remote[`${s.name}:${tier}`] = { complete: c.complete, chunks: c.received.length, shaOk: sha(bytes) === h };
      check(c.complete === true && sha(bytes) === h, `R 上 ${s.name} ${tier} complete 且字节相符`, c);
    }
  }
  ok = fails.length === 0;
} catch (err) {
  fails.push(`异常:${err?.stack ?? err}`);
} finally {
  try { await browser?.close(); } catch { /* 已经关了 */ }
  for (const c of children) killTree(c);
  if (!KEEP) await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
}
console.log(JSON.stringify({ ok, ...out, fails }));
process.exit(ok ? 0 : 1);
