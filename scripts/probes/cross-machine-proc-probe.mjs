/**
 * 跨机器直接打开 `.proc`(不是 `.procp`)的探针(`docs/plan/TODO.md`「跨机器打开项目时的素材路径」):
 *
 *   1. **实例 A**(自己的临时数据目录):建项目 —— 一条导入的视频(带哈希)、一条经入库接口进来的音频(带哈希,440 Hz),
 *      都在时间轴上;存成 `.proc` 文本。两条素材的 `path` 都指向 A 的内容库目录。
 *   2. **实例 B**(数据目录为空,但内容库里已经有这两份字节:开跑前经 B 的上传接口把 A 的字节原样放进去 —— 相当于
 *      「另一台机器的内容库里已经有这些哈希」):直接打开这个 `.proc`。素材按哈希还原、不标「(缺失)」;
 *      A 的路径在 B 上按路径读取不到(`/api/media/file?path=…` 回非 2xx,说明改前按路径读必失败);
 *      导出成片:有画面(视频帧不是一片纯色)、有音轨且 440 Hz 那段不是静音。
 *   3. **实例 C**(数据目录为空、内容库里也没有这些字节):打开同一个 `.proc`,打开后的后台检查把两条素材标「(缺失)」
 *      (名字加标记、写「确认缺失」的记录;地址与哈希留着)。
 *   4. **实例 C,缺失的老视频导出时照原位置出占位**(0.7.18 起;此前是跳过这一段,`docs/archive/agent-reports/AGENT-maint-4.md` 第 3 项):新建项目,
 *      放一条 C 里导入的视频(0～3 s)、一条 C 里入库的 660 Hz 音频(0.5～2.5 s),再放一条**老形态只有 `path`** 的视频(A 的文件路径、
 *      没有哈希,1～2 s);等后台检查把它标「(缺失)」并写记录。从顶栏「导出视频」导出(没有另存为的 API,留在产物目录):导出完成、
 *      不报解码失败、没有片段被跳过;成片 1.5 s 处是「找不到素材」的占位,前后是正常画面;音频 2 s 以后那段是 660 Hz;
 *      导出用的 project.json 里引用它的片段还在。
 *
 *   node scripts/probes/cross-machine-proc-probe.mjs [--port-a 6070] [--port-b 6075] [--port-c 6080] [--out <临时目录>] [--keep]
 *
 * 端口:每台编辑器另占「端口 +1」「端口 +2」当舞台端口,三个连号都要空着(预渲染进程由编辑器自己挑空闲端口)。
 * 数据目录、导出目录、项目目录一律在 `--out` 下(缺省系统临时目录里新建一个),不碰用户的 `Videos\PromptCut`。
 * 输出最后一行是一行 JSON:`{ ok, ..., fails }`,退出码 0 = 全过。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startDevServer } from '../lib/dev-server.mjs';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT_A = Number(arg('--port-a', 6070));
const PORT_B = Number(arg('--port-b', 6075));
const PORT_C = Number(arg('--port-c', 6080));
const RUN = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-cross-proc-${RUN}`)));
const KEEP = args.includes('--keep');

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return !!cond; };
const log = (...a) => console.error('[cross-proc]', ...a);
/**
 * 等这个实例的预渲染进程就绪(`/api/prerender/info` 回 ready)。导出要它;实例刚起时它可能还在启动,
 * 页面那一侧头一次只等 10 秒(`src/render/prerender.ts`),这台机器忙的时候不够。等的时限只为防卡死。
 */
async function waitPrerender(port, label) {
  const t0 = Date.now();
  for (;;) {
    const info = await fetch(`http://127.0.0.1:${port}/api/prerender/info`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (info?.ready && typeof info.url === 'string') { log(`${label}:预渲染进程就绪,等了 ${Date.now() - t0} ms`); return; }
    if (Date.now() - t0 > 180000) throw new Error(`${label}:预渲染进程 180 秒没就绪`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const HASH = /^[0-9a-f]{64}$/;
const MISSING = '(缺失) ';

const ffmpeg = await findFfmpeg();
const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));
function run(cmd, a) {
  const r = spawnSync(cmd, a, { encoding: 'buffer', windowsHide: true, maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 退出码 ${r.status}:${String(r.stderr).slice(-600)}`);
  return r.stdout;
}

/** 一段音频的 RMS(dBFS)与过零率换算的频率(Hz) */
function audioStats(file, start, dur) {
  const pcm = run(ffmpeg, ['-v', 'error', '-ss', String(start), '-t', String(dur), '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-']);
  const n = Math.floor(pcm.length / 2);
  let sq = 0, crossings = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sq += v * v;
    if (i > 0 && ((prev < 0 && v >= 0) || (prev >= 0 && v < 0))) crossings++;
    prev = v;
  }
  const rms = n ? Math.sqrt(sq / n) : 0;
  return { samples: n, rmsDb: rms ? +(20 * Math.log10(rms)).toFixed(1) : -Infinity, hz: n ? Math.round(crossings / 2 / (n / 48000)) : 0 };
}

/** 某一时刻的画面缩成 64×36 灰度:平均亮度与标准差(testsrc2 是彩条加动的图形,标准差很大;没画面是一片纯色) */
function frameStats(file, at) {
  const raw = run(ffmpeg, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-']);
  const n = raw.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += raw[i];
  const mean = n ? sum / n : 0;
  let v = 0;
  for (let i = 0; i < n; i++) v += (raw[i] - mean) ** 2;
  return { pixels: n, mean: +mean.toFixed(1), std: n ? +Math.sqrt(v / n).toFixed(1) : 0 };
}

const dirsOf = (name) => {
  const base = path.join(OUT, name);
  return { base, exportDir: path.join(base, 'out'), dataDir: path.join(base, 'data'), projectsDir: path.join(base, 'projects') };
};
const envOf = (d) => ({ PROMPTCUT_EXPORT_DIR: d.exportDir, PROMPTCUT_DATA_DIR: d.dataDir, PROMPTCUT_PROJECTS_DIR: d.projectsDir, PROMPTCUT_NO_PORT_FILE: '1' });
const isEmptyDir = async (d) => (await fs.readdir(d)).length === 0;

async function openEditor(browser, origin, events) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('dialog', async (d) => { events.push({ type: d.type(), message: d.message() }); await d.accept().catch(() => {}); });
  page.on('pageerror', (e) => events.push({ type: 'pageerror', message: String(e?.message || e) }));
  await page.goto(origin + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => !!(await import('/src/editor/stageBridge.ts')).frontStage(), { timeout: 180000, polling: 500 });
  return page;
}

/** 在页面里直接打开 .proc 文本(和顶栏「打开」同一条 loadProc),回素材表 */
async function openProc(page, text) {
  return page.evaluate(async (t) => {
    const { actions, getState } = await import('/src/store/project.ts');
    const { loadProc } = await import('/src/editor/io/proc.ts');
    actions.loadProject(loadProc(t), 'cross-machine.proc');
    return getState().project.media.map((m) => ({ id: m.id, kind: m.kind, name: m.name, hash: m.hash ?? null, url: m.url, path: m.path ?? null, record: m.missingMaterial?.reason ?? null }));
  }, text);
}

const mediaOf = (page) => page.evaluate(async () => {
  const { getState } = await import('/src/store/project.ts');
  return getState().project.media.map((m) => ({ id: m.id, kind: m.kind, name: m.name, hash: m.hash ?? null, url: m.url, path: m.path ?? null, record: m.missingMaterial?.reason ?? null }));
});

const out = { ok: false, run: RUN, out: OUT, ports: { a: PORT_A, b: PORT_B, c: PORT_C } };
const servers = [];
let browser = null;
try {
  await fs.mkdir(OUT, { recursive: true });
  const A = dirsOf('A');
  const B = dirsOf('B');
  const C = dirsOf('C');
  for (const d of [A, B, C]) for (const k of ['exportDir', 'dataDir', 'projectsDir']) await fs.mkdir(d[k], { recursive: true });

  // ── 素材:现场生成,元数据里写本次的随机串,哈希每次都不一样 ──
  const src = path.join(OUT, 'src');
  await fs.mkdir(src, { recursive: true });
  const video = path.join(src, `clip-${RUN}.mp4`);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-metadata', `comment=${RUN}`, video]);
  const voice = path.join(src, `voice-${RUN}.mp3`);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', `comment=${RUN}`, voice]);

  browser = await puppeteer.launch({ headless: true, protocolTimeout: 900000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });

  // ── 实例 A:建项目、存成 .proc ──
  log(`起实例 A(${PORT_A})`);
  const srvA = await startDevServer({ port: PORT_A, env: envOf(A), logFile: path.join(OUT, 'vite-A.log'), log });
  servers.push(srvA);
  const eventsA = [];
  const pageA = await openEditor(browser, srvA.origin, eventsA);
  const setup = await pageA.evaluate(async (o) => {
    const b64ToFile = (b64, name, type) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new File([arr], name, { type });
    };
    const { actions, getState } = await import('/src/store/project.ts');
    const io = await import('/src/editor/io/index.ts');
    const { uploadMediaFile } = await import('/src/editor/io/mediaUpload.ts');
    const { serializeProc } = await import('/src/editor/io/proc.ts');
    actions.newProject('cross-machine-' + o.run);
    await io.importVideoFiles([b64ToFile(o.video, o.videoName, 'video/mp4')]);
    for (let i = 0; i < 150 && getState().project.media.some((m) => m.pending || !m.url); i++) await new Promise((r) => setTimeout(r, 200));
    const up = await uploadMediaFile(b64ToFile(o.voice, o.voiceName, 'audio/mpeg'));
    if (!up) throw new Error('入库接口没收下音频');
    const mVoice = actions.addMedia({ kind: 'audio', name: o.voiceName, url: up.url, hash: up.hash, ext: up.ext, size: up.bytes, path: up.path, duration: 2 });
    const track = actions.addTrack('配音');
    if (!actions.addMediaClip(mVoice.id, 0.5, { trackId: track.id, duration: 2 })) throw new Error('音频放不上时间轴');
    const text = serializeProc();
    const saved = JSON.parse(text);
    return { text, media: (saved.project || saved).media.map((m) => ({ id: m.id, kind: m.kind, name: m.name, hash: m.hash ?? null, url: m.url, path: m.path ?? null })), clips: getState().project.tracks.reduce((n, t) => n + t.clips.length, 0) };
  }, {
    run: RUN,
    video: (await fs.readFile(video)).toString('base64'), videoName: path.basename(video),
    voice: (await fs.readFile(voice)).toString('base64'), voiceName: path.basename(voice),
  });
  const procFile = path.join(OUT, `cross-${RUN}.proc`);
  await fs.writeFile(procFile, setup.text);
  out.a = { media: setup.media, clips: setup.clips, proc: procFile };
  check(setup.media.length === 2, 'A:素材表两条', setup.media);
  check(setup.clips >= 2, 'A:视频与音频都在时间轴上', setup.clips);
  for (const m of setup.media) {
    check(HASH.test(String(m.hash)), `A:${m.kind} 带哈希`, m);
    check(m.path && path.resolve(m.path).startsWith(path.resolve(A.base)), `A:${m.kind} 的 path 指向 A 的目录`, m);
  }
  check(!eventsA.some((e) => e.type === 'pageerror'), 'A:页面没有报错', eventsA);

  // ── 实例 B:数据目录空,但内容库里已经有这两份字节 ──
  check(await isEmptyDir(B.exportDir) && await isEmptyDir(B.dataDir), 'B:开跑前数据目录与导出目录是空的');
  log(`起实例 B(${PORT_B})`);
  const srvB = await startDevServer({ port: PORT_B, env: envOf(B), logFile: path.join(OUT, 'vite-B.log'), log });
  servers.push(srvB);
  // A 的字节原样取出来,经 B 的上传接口(不带 tiers,不重封装)放进 B 的内容库:哈希不变
  const seeded = [];
  for (const m of setup.media) {
    const bytes = Buffer.from(await (await fetch(`${srvA.origin}/@media/${m.hash}`)).arrayBuffer());
    const r = await fetch(`${srvB.origin}/api/media/upload/${encodeURIComponent(m.name)}`, { method: 'POST', body: bytes });
    const j = r.ok ? await r.json() : null;
    seeded.push({ name: m.name, bytes: bytes.length, hash: j?.hash ?? null, want: m.hash });
  }
  out.b = { seeded };
  for (const s of seeded) check(s.hash === s.want, `B:内容库里放进了 ${s.name} 的同一份字节(哈希一致)`, s);
  const localB = await (await fetch(`${srvB.origin}/api/media/local?hashes=${setup.media.map((m) => m.hash).join(',')}`)).json();
  check(setup.media.every((m) => localB.hashes?.includes(m.hash)), 'B:/api/media/local 报两份都在', localB);
  // 改前的导出按 path 读:A 的路径在 B 上读不到
  const byPath = [];
  for (const m of setup.media) byPath.push({ kind: m.kind, status: (await fetch(`${srvB.origin}/api/media/file?path=${encodeURIComponent(m.path)}`)).status });
  out.b.byPath = byPath;
  check(byPath.every((x) => x.status >= 400), 'B:A 的路径在 B 上按路径读不到(改前导出按 path 读必失败)', byPath);

  const eventsB = [];
  const pageB = await openEditor(browser, srvB.origin, eventsB);
  const openedB = await openProc(pageB, setup.text);
  out.b.opened = openedB;
  for (const m of openedB) {
    check(HASH.test(String(m.hash)) && m.url === `/@media/${m.hash}`, `B:${m.kind} 按哈希还原`, m);
    check(m.path && path.resolve(m.path).startsWith(path.resolve(A.base)), `B:${m.kind} 的 path 还是 A 的(导出若按 path 读就会读错)`, m);
  }
  // 等打开后的后台检查(1.5 s 后)做完:内容库里有的不标
  await new Promise((r) => setTimeout(r, 4000));
  const afterB = await mediaOf(pageB);
  out.b.afterCheck = afterB;
  check(afterB.every((m) => !String(m.name).startsWith(MISSING) && m.url === `/@media/${m.hash}`), 'B:内容库里有的素材不标「(缺失)」', afterB);

  log('B:导出');
  await waitPrerender(PORT_B, 'B');
  const exp = await pageB.evaluate(async () => {
    const io = await import('/src/editor/io/index.ts');
    const r = await io.exportVideo();
    return { outDir: r.outDir, id: r.id };
  });
  const mp4 = path.join(exp.outDir, 'preview.mp4');
  const kept = path.join(OUT, `B-export-${RUN}.mp4`);
  await fs.copyFile(mp4, kept);
  const projectJson = JSON.parse(await fs.readFile(path.join(exp.outDir, 'project.json'), 'utf8'));
  const exportUrls = (projectJson.media || []).map((m) => ({ kind: m.kind, url: m.url }));
  const streams = JSON.parse(String(run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration', '-of', 'json', kept]))).streams;
  const frames = [0.5, 1.5, 2.5].map((t) => ({ t, ...frameStats(kept, t) }));
  const seg = audioStats(kept, 0.7, 1.5);
  const silentHead = audioStats(kept, 0.0, 0.4);
  out.b.export = { file: kept, exportUrls, streams, frames, seg, silentHead };
  for (const m of setup.media) check(exportUrls.some((x) => x.url === `/@media/${m.hash}`), `B 导出:导出页拿到的 ${m.kind} 地址是按哈希的`, exportUrls);
  check(streams.some((s) => s.codec_type === 'video'), 'B 导出:有视频流', streams);
  check(frames.every((f) => f.std > 20), 'B 导出:三个时刻的画面都不是一片纯色(视频层画出来了)', frames);
  check(streams.some((s) => s.codec_type === 'audio'), 'B 导出:有音轨', streams);
  check(seg.rmsDb > -40, 'B 导出:音频那一段(0.7～2.2 s)不是静音', seg);
  check(Math.abs(seg.hz - 440) <= 30, 'B 导出:那一段是 440 Hz(确实是那条音频)', seg);
  check(!eventsB.some((e) => e.type === 'pageerror'), 'B:页面没有报错', eventsB);

  // ── 实例 C:数据目录空、内容库里也没有 ──
  check(await isEmptyDir(C.exportDir) && await isEmptyDir(C.dataDir), 'C:开跑前数据目录与导出目录是空的');
  log(`起实例 C(${PORT_C})`);
  const srvC = await startDevServer({ port: PORT_C, env: envOf(C), logFile: path.join(OUT, 'vite-C.log'), log });
  servers.push(srvC);
  const eventsC = [];
  const pageC = await openEditor(browser, srvC.origin, eventsC);
  const openedC = await openProc(pageC, setup.text);
  let afterC = openedC;
  for (let i = 0; i < 60 && !afterC.every((m) => String(m.name).startsWith(MISSING)); i++) {
    await new Promise((r) => setTimeout(r, 250));
    afterC = await mediaOf(pageC);
  }
  out.c = { opened: openedC, afterCheck: afterC };
  for (const m of afterC) {
    check(String(m.name).startsWith(MISSING), `C:${m.kind} 标「(缺失)」`, m);
    check(m.url === `/@media/${m.hash}` && m.record === 'confirmed-missing', `C:${m.kind} 地址留着、写了「确认缺失」的记录(预览与导出出占位)`, m);
    check(HASH.test(String(m.hash)), `C:${m.kind} 哈希留着`, m);
  }
  check(!eventsC.some((e) => e.type === 'pageerror'), 'C:页面没有报错', eventsC);

  // ── 实例 C:缺失的老视频导出时跳过这一段,其余画面与音轨正常,完成对话框里列出它 ──
  const video2 = path.join(src, `clip2-${RUN}.mp4`);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-metadata', `comment=d-${RUN}`, video2]);
  const voice2 = path.join(src, `voice2-${RUN}.mp3`);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100', '-t', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', `comment=d-${RUN}`, voice2]);
  const oldVideo = setup.media.find((m) => m.kind === 'video');
  const oldName = `old-${path.basename(video)}`;
  const setupD = await pageC.evaluate(async (o) => {
    const b64ToFile = (b64, name, type) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new File([arr], name, { type });
    };
    const { actions, getState } = await import('/src/store/project.ts');
    const io = await import('/src/editor/io/index.ts');
    const { uploadMediaFile } = await import('/src/editor/io/mediaUpload.ts');
    actions.newProject('cross-missing-' + o.run);
    actions.seek(0);
    await io.importVideoFiles([b64ToFile(o.video, o.videoName, 'video/mp4')]);
    for (let i = 0; i < 150 && getState().project.media.some((m) => m.pending || !m.url); i++) await new Promise((r) => setTimeout(r, 200));
    const up = await uploadMediaFile(b64ToFile(o.voice, o.voiceName, 'audio/mpeg'));
    if (!up) throw new Error('入库接口没收下音频');
    const mVoice = actions.addMedia({ kind: 'audio', name: o.voiceName, url: up.url, hash: up.hash, ext: up.ext, size: up.bytes, path: up.path, duration: 2 });
    const ta = actions.addTrack('配音');
    if (!actions.addMediaClip(mVoice.id, 0.5, { trackId: ta.id, duration: 2 })) throw new Error('音频放不上时间轴');
    // 老形态:只有 path(另一台机器 A 的文件)、没有哈希,地址是打开老项目时还原出来的按路径地址
    const mOld = actions.addMedia({ kind: 'video', name: o.oldName, url: '/api/media/file?path=' + encodeURIComponent(o.oldPath), path: o.oldPath, duration: 3, width: 640, height: 360 });
    // 放在最上面一条序列:它的占位要盖在底下那条视频上才看得见(放在最底下时被上面的视频挡住,和素材在的时候一样)
    const tv = actions.addTrack('老视频', { index: 0 });
    if (!actions.addMediaClip(mOld.id, 1, { trackId: tv.id, duration: 1 })) throw new Error('老视频放不上时间轴');
    const p = getState().project;
    return { oldId: mOld.id, tracks: p.tracks.map((t) => ({ id: t.id, clips: t.clips.map((c) => ({ id: c.id, mediaId: c.mediaId ?? null, start: c.start, end: c.end })) })), duration: p.duration };
  }, {
    run: RUN,
    video: (await fs.readFile(video2)).toString('base64'), videoName: path.basename(video2),
    voice: (await fs.readFile(voice2)).toString('base64'), voiceName: path.basename(voice2),
    oldName, oldPath: oldVideo.path,
  });
  out.d = { setup: setupD };
  let oldD = null;
  for (let i = 0; i < 80; i++) {
    oldD = (await mediaOf(pageC)).find((m) => m.id === setupD.oldId);
    if (oldD && String(oldD.name).startsWith(MISSING) && oldD.record === 'confirmed-missing') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  out.d.old = oldD;
  check(oldD && String(oldD.name).startsWith(MISSING) && oldD.record === 'confirmed-missing' && oldD.url && !oldD.hash, 'D:只有路径的老视频标「(缺失)」、写了「确认缺失」的记录、地址留着、没有哈希', oldD);
  log('C:缺失老视频的项目从顶栏导出');
  await waitPrerender(PORT_C, 'C');
  const exportsBefore = new Set(await fs.readdir(C.exportDir));
  /*
   * 刚起的实例第一次导出,预渲染进程或导出页可能还没就绪(已知的老问题,属于暂时性故障):
   * 只有报的是「没就绪」才重试,退避 10、20 秒,最多三次;每次的报错都记下来。别的失败不重试。
   */
  const attempts = [];
  let dialog, note;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await pageC.evaluate(() => {
      window.showSaveFilePicker = undefined; // 没有另存为:成片留在产物目录(顶栏的兜底路)
      window.dispatchEvent(new CustomEvent('pc-titlebar-command', { detail: 'export-video' }));
    });
    dialog = await pageC.waitForFunction(() => {
      const t = document.querySelector('.pc-export-dialog .pc-export-title')?.textContent?.trim();
      return t === '导出完成' || t === '导出失败' || t === '已取消导出' ? t : null;
    }, { timeout: 900000, polling: 1000 }).then((h) => h.jsonValue()).catch((e) => `等不到结果:${e.message}`);
    note = await pageC.evaluate(() => ({
      skipped: document.querySelector('[data-pc="export-skipped"]')?.textContent ?? null,
      err: document.querySelector('.pc-export-dialog .pc-export-err')?.textContent ?? null,
    }));
    attempts.push({ attempt, dialog, err: note.err });
    if (dialog !== '导出失败' || !/没就绪/.test(note.err || '') || attempt === 3) break;
    log(`C:导出第 ${attempt} 次报没就绪,${attempt * 10} 秒后重试`, note.err?.slice(0, 80));
    await pageC.evaluate(() => document.querySelector('.pc-export-dialog .pc-export-primary')?.click());
    await new Promise((r) => setTimeout(r, attempt * 10000));
  }
  out.d = { ...out.d, exportAttempts: attempts };
  const shot = path.join(OUT, `D-export-dialog-${RUN}.png`);
  await pageC.screenshot({ path: shot }).catch(() => {});
  out.d.dialog = { title: dialog, ...note, shot };
  check(dialog === '导出完成', 'D:导出完成(不因缺失的老视频解码失败)', { dialog, err: note.err });
  check(!note.skipped, 'D:没有素材被跳过(缺失的老视频照原位置出占位)', note);
  const newDirs = (await fs.readdir(C.exportDir)).filter((d) => d.startsWith('export-') && !exportsBefore.has(d));
  const expDir = newDirs.length ? path.join(C.exportDir, newDirs.sort().pop()) : null;
  if (check(expDir, 'D:产物目录里有这次导出', newDirs)) {
    const keptD = path.join(OUT, `D-export-${RUN}.mp4`);
    await fs.copyFile(path.join(expDir, 'preview.mp4'), keptD);
    const pj = JSON.parse(await fs.readFile(path.join(expDir, 'project.json'), 'utf8'));
    const clipsOfOld = (pj.tracks || []).flatMap((t) => t.clips || []).filter((c) => c.mediaId === setupD.oldId);
    const oldInJson = (pj.media || []).find((m) => m.id === setupD.oldId);
    const streamsD = JSON.parse(String(run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration', '-of', 'json', keptD]))).streams;
    const framesD = [0.5, 1.5, 2.5].map((t) => ({ t, ...frameStats(keptD, t) }));
    const segD = audioStats(keptD, 2.05, 0.4); // 1～2 s 那段叠着「找不到素材」的人声,量它后面那一截
    out.d.export = { file: keptD, streams: streamsD, frames: framesD, seg: segD, clipsOfOld: clipsOfOld.length, oldUrl: oldInJson?.url ?? null };
    check(clipsOfOld.length === 1, 'D:导出用的 project.json 里引用缺失老视频的片段还在(位置和编排保留)', clipsOfOld);
    check(oldInJson && oldInJson.missingMaterial?.reason === 'confirmed-missing' && oldInJson.url === oldD.url, 'D:导出用的 project.json 里缺失老视频带着记录、地址没被改写', oldInJson);
    check(streamsD.some((x) => x.codec_type === 'video'), 'D:有视频流', streamsD);
    check(framesD[0].std > 20 && framesD[2].std > 20, 'D:0.5 s 与 2.5 s 是正常画面', framesD);
    check(framesD[1].mean > 25 && framesD[1].mean < 80 && framesD[1].std > 2 && framesD[1].std < 60, 'D:1.5 s 处是「找不到素材」的占位(深色底加白字)', framesD[1]);
    check(streamsD.some((x) => x.codec_type === 'audio'), 'D:有音轨', streamsD);
    check(segD.rmsDb > -40 && Math.abs(segD.hz - 660) <= 40, 'D:音频那段不是静音、是 660 Hz', segD);
  }
  check(!eventsC.some((e) => e.type === 'pageerror'), 'D:页面没有报错', eventsC);
} catch (e) {
  fails.push('探针异常:' + (e?.stack || e));
} finally {
  await browser?.close().catch(() => {});
  for (const s of servers) s.stop();
  if (!KEEP && fails.length === 0) await fs.rm(OUT, { recursive: true, force: true }).catch(() => {});
}
out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
