/**
 * 打包保存 `.procp` 的往返探针(`docs/plan/TODO.md`「已做步骤的遗留」里的用户真机缺陷:打包保存把没有哈希的素材悄悄跳过,
 * 老项目里的配音没进包)。验收第 3 条:
 *
 *   1. **实例 A**(自己的临时数据目录):建项目 —— 一条视频(导入接口进来、带哈希)、一条**老形态只有 `path`** 的音频
 *      (文件放在 A 的素材目录里,项目里没有哈希,和 0.7.0 / 0.7.1 生成的配音同一个样子;经「存盘 → 再打开」走一遍
 *      真的打开路径,地址被还原成 `/api/media/file?path=…`)、一条**经入库接口进来**的音频。两条音频前后排在一条轨上。
 *      从顶栏「项目 → 打包保存…」打包(`showSaveFilePicker` 换成探针的假落点,收下写进去的字节):包里应有三份素材、
 *      包内 `project.proc` 三条都带哈希、没有「缺素材」的提示框。
 *   2. **实例 B**(数据目录全空):打开这个包 → 素材表没有「(缺失)」、每条素材都有哈希且 `/@media/<hash>` 取得到;
 *      导出成片,两段配音所在的时间段音轨都不是静音,且频率分别对得上 440 Hz / 880 Hz(确实是那两条配音)。
 *   3. 可选 `--user-procp <文件>`:在 B 里打开用户发来的老包(老版本打的,只有视频、缺配音),确认照常打开、不崩;
 *      再从顶栏打包一次,提示框里列出那些本机找不到文件的素材名字(不再静默)。只读用户的包,不改它。
 *
 *   node scripts/probes/procp-roundtrip-probe.mjs [--port-a 6050] [--port-b 6060] [--out <临时目录>] [--user-procp <.procp>] [--keep]
 *
 * 端口:每台编辑器另占「端口 +1」「端口 +2」当舞台端口,三个连号都要空着。数据目录、导出目录、项目目录一律在 `--out` 下
 * (缺省系统临时目录里新建一个),不碰用户的 `Videos\PromptCut`。输出最后一行是一行 JSON:`{ ok, ..., fails }`,退出码 0 = 全过。
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
const PORT_A = Number(arg('--port-a', 6050));
const PORT_B = Number(arg('--port-b', 6060));
const RUN = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-procp-roundtrip-${RUN}`)));
const USER_PROCP = arg('--user-procp', null);
const KEEP = args.includes('--keep');

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return !!cond; };
const log = (...a) => console.error('[procp-roundtrip]', ...a);
const HASH = /^[0-9a-f]{64}$/;

const ffmpeg = await findFfmpeg();
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

const dirsOf = (name) => {
  const base = path.join(OUT, name);
  return { base, exportDir: path.join(base, 'out'), dataDir: path.join(base, 'data'), projectsDir: path.join(base, 'projects') };
};
const envOf = (d) => ({ PROMPTCUT_EXPORT_DIR: d.exportDir, PROMPTCUT_DATA_DIR: d.dataDir, PROMPTCUT_PROJECTS_DIR: d.projectsDir, PROMPTCUT_NO_PORT_FILE: '1' });

async function openEditor(browser, origin, dialogs) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('dialog', async (d) => { dialogs.push({ type: d.type(), message: d.message() }); await d.accept().catch(() => {}); });
  page.on('pageerror', (e) => dialogs.push({ type: 'pageerror', message: String(e?.message || e) }));
  // 「另存为」换成探针的假落点:写进去的字节收在 window.__pcPacked(Blob),不弹系统对话框
  await page.evaluateOnNewDocument(() => {
    window.showSaveFilePicker = async () => {
      const chunks = [];
      return {
        name: 'probe.procp',
        async createWritable() {
          return {
            async write(b) { chunks.push(b instanceof Blob ? b : new Blob([b])); },
            async close() { window.__pcPacked = new Blob(chunks); },
          };
        },
      };
    };
  });
  await page.goto(origin + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => !!(await import('/src/editor/stageBridge.ts')).frontStage(), { timeout: 180000, polling: 500 });
  return page;
}

/** 顶栏「项目 → 打包保存…」,等假落点收到字节;`transfer` 时把包的字节取回 Node(大包不取,只在页面里看) */
async function packViaTopBar(page, { transfer = true, timeoutMs = 180000 } = {}) {
  await page.evaluate(() => { window.__pcPacked = null; });
  await page.click('.pc-proj-btn');
  await page.waitForSelector('[data-pc="menu-pack"]', { visible: true, timeout: 10000 });
  await page.click('[data-pc="menu-pack"]');
  await page.waitForFunction(() => window.__pcPacked instanceof Blob, { timeout: timeoutMs, polling: 300 });
  // 缺素材的提示框在写完之后弹:留一点时间让它出来
  await new Promise((r) => setTimeout(r, 800));
  if (!transfer) return null;
  return Buffer.from(await page.evaluate(async () => {
    const buf = new Uint8Array(await window.__pcPacked.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }), 'base64');
}

/** 读假落点收下的那个包:条目名 + 包内编排(用编辑器自己的 readZip,在页面里跑) */
async function inspectPack(page) {
  return page.evaluate(async () => {
    const { readZip, inflate } = await import('/src/editor/io/procp.ts');
    const entries = await readZip(window.__pcPacked);
    const proc = JSON.parse(await (await inflate(entries[0])).text());
    const p = proc.project || proc;
    return { size: window.__pcPacked.size, names: entries.map((e) => e.name), media: (p.media || []).map((m) => ({ id: m.id, kind: m.kind, name: m.name, hash: m.hash ?? null, url: m.url, path: m.path ?? null })) };
  });
}

const out = { ok: false, run: RUN, out: OUT, ports: { a: PORT_A, b: PORT_B } };
const servers = [];
let browser = null;
try {
  await fs.mkdir(OUT, { recursive: true });
  const A = dirsOf('A');
  const B = dirsOf('B');
  for (const d of [A, B]) for (const k of ['exportDir', 'dataDir', 'projectsDir']) await fs.mkdir(d[k], { recursive: true });

  // ── 素材:现场生成,元数据里写本次的随机串,哈希每次都不一样 ──
  const src = path.join(OUT, 'src');
  await fs.mkdir(src, { recursive: true });
  const video = path.join(src, `clip-${RUN}.mp4`);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-metadata', `comment=${RUN}`, video]);
  const voiceNew = path.join(src, `voice-new-${RUN}.mp3`);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100', '-t', '1.5', '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', `comment=new-${RUN}`, voiceNew]);
  // 老形态的配音:直接落在 A 的素材目录里(和 0.7.0 / 0.7.1 生成的配音一样),文件名带中文
  const mediaDirA = path.join(A.exportDir, 'media');
  await fs.mkdir(mediaDirA, { recursive: true });
  const voiceOld = path.join(mediaDirA, `voice-20260929-061646-决赛回放开场-${RUN}.mp3`);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1.5', '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', `comment=old-${RUN}`, voiceOld]);

  // ── 实例 A:建项目、打包 ──
  log(`起实例 A(${PORT_A})`);
  const srvA = await startDevServer({ port: PORT_A, env: envOf(A), logFile: path.join(OUT, 'vite-A.log'), log });
  servers.push(srvA);
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 900000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
  const dialogsA = [];
  const pageA = await openEditor(browser, srvA.origin, dialogsA);
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
    const { serializeProc, loadProc } = await import('/src/editor/io/proc.ts');
    actions.newProject('procp-roundtrip-' + o.run);
    await io.importVideoFiles([b64ToFile(o.video, o.videoName, 'video/mp4')]);
    for (let i = 0; i < 150 && getState().project.media.some((m) => m.pending || !m.url); i++) await new Promise((r) => setTimeout(r, 200));
    // 经入库接口进来的音频(0.7.7 之后生成的配音就是这样:带哈希)
    const up = await uploadMediaFile(b64ToFile(o.voiceNew, o.voiceNewName, 'audio/mpeg'));
    if (!up) throw new Error('入库接口没收下新配音');
    const mNew = actions.addMedia({ kind: 'audio', name: o.voiceNewName, url: up.url, hash: up.hash, ext: up.ext, size: up.bytes, path: up.path, duration: 1.5 });
    // 老形态:只有 path,没有哈希
    const mOld = actions.addMedia({ kind: 'audio', name: o.voiceOldName, url: o.voiceOldName, path: o.voiceOldPath, duration: 1.5 });
    const track = actions.addTrack('配音');
    const c1 = actions.addMediaClip(mOld.id, 0, { trackId: track.id, duration: 1.5 });
    const c2 = actions.addMediaClip(mNew.id, 1.5, { trackId: track.id, duration: 1.5 });
    if (!c1 || !c2) throw new Error('配音放不上时间轴');
    // 存盘 → 再打开:老素材走真的打开路径(restoreMediaUrls),地址还原成 /api/media/file?path=…
    const text = serializeProc();
    const saved = JSON.parse(text);
    const savedOld = (saved.project || saved).media.find((m) => m.id === mOld.id);
    actions.loadProject(loadProc(text), 'procp-roundtrip.proc');
    const reopened = getState().project.media.map((m) => ({ id: m.id, kind: m.kind, name: m.name, hash: m.hash ?? null, url: m.url, path: m.path ?? null }));
    return { ids: { old: mOld.id, new: mNew.id }, savedOld: { hash: savedOld?.hash ?? null, path: savedOld?.path ?? null }, reopened };
  }, {
    run: RUN,
    video: (await fs.readFile(video)).toString('base64'), videoName: path.basename(video),
    voiceNew: (await fs.readFile(voiceNew)).toString('base64'), voiceNewName: path.basename(voiceNew),
    voiceOldName: path.basename(voiceOld), voiceOldPath: voiceOld,
  });
  out.setup = setup;
  const oldAtOpen = setup.reopened.find((m) => m.id === setup.ids.old);
  check(setup.savedOld.hash === null && setup.savedOld.path === voiceOld, 'A:存盘里的老配音只有 path、没有哈希', setup.savedOld);
  check(oldAtOpen && oldAtOpen.url.startsWith('/api/media/file?path='), 'A:再打开后老配音的地址是 /api/media/file?path=…', oldAtOpen);
  check(setup.reopened.length === 3, 'A:素材表三条', setup.reopened);

  // 打包前那一刻老配音有没有哈希(打开项目后后台补入库可能已经先补上了,两种都算正常;打包那一步的补入库由单测钉)
  out.oldHashBeforePack = await pageA.evaluate(async (id) => {
    const { getState } = await import('/src/store/project.ts');
    return getState().project.media.find((m) => m.id === id)?.hash ?? null;
  }, setup.ids.old);

  const packBytes = await packViaTopBar(pageA);
  const packFile = path.join(OUT, `roundtrip-${RUN}.procp`);
  await fs.writeFile(packFile, packBytes);
  const inspA = await inspectPack(pageA);
  out.pack = { bytes: packBytes.length, names: inspA.names, media: inspA.media };
  check(inspA.names[0] === 'project.proc', '包:第一个条目是 project.proc', inspA.names);
  check(inspA.names.filter((n) => n.startsWith('media/')).length === 3, '包:三份素材都在包里', inspA.names);
  check(inspA.media.length === 3 && inspA.media.every((m) => HASH.test(String(m.hash))), '包内 project.proc:三条素材都带哈希', inspA.media);
  for (const m of inspA.media) check(inspA.names.some((n) => n.startsWith(`media/${m.hash}`)), `包:${m.name} 的字节在包里`, inspA.names);
  const alertsA = dialogsA.filter((d) => d.type === 'alert');
  check(alertsA.length === 0, 'A:打包没有弹「缺素材」提示', alertsA);
  check(!dialogsA.some((d) => d.type === 'pageerror'), 'A:页面没有报错', dialogsA.filter((d) => d.type === 'pageerror'));
  out.dialogsA = dialogsA;

  // ── 实例 B:空数据目录,打开包、查素材、导出 ──
  const emptyB = (await fs.readdir(B.exportDir)).length === 0 && (await fs.readdir(B.dataDir)).length === 0;
  check(emptyB, 'B:开跑前数据目录与导出目录是空的');
  log(`起实例 B(${PORT_B})`);
  const srvB = await startDevServer({ port: PORT_B, env: envOf(B), logFile: path.join(OUT, 'vite-B.log'), log });
  servers.push(srvB);
  const dialogsB = [];
  const pageB = await openEditor(browser, srvB.origin, dialogsB);
  const opened = await pageB.evaluate(async (b64) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const { actions, getState } = await import('/src/store/project.ts');
    const { loadProcpFile } = await import('/src/editor/io/procp.ts');
    actions.loadProject(await loadProcpFile(new File([arr], 'roundtrip.procp')), 'roundtrip.proc');
    const media = getState().project.media;
    const fetched = [];
    for (const m of media) {
      const r = HASHOK(m.hash) ? await fetch(`/@media/${m.hash}`) : null;
      fetched.push({ name: m.name, hash: m.hash ?? null, url: m.url, status: r ? r.status : null, bytes: r && r.ok ? (await r.arrayBuffer()).byteLength : 0 });
    }
    function HASHOK(h) { return /^[0-9a-f]{64}$/.test(String(h || '')); }
    return { fetched };
  }, packBytes.toString('base64'));
  out.opened = opened;
  check(opened.fetched.length === 3, 'B:素材表三条', opened.fetched);
  check(!opened.fetched.some((m) => String(m.name).startsWith('(缺失)')), 'B:素材表没有「(缺失)」', opened.fetched);
  for (const m of opened.fetched) {
    check(HASH.test(String(m.hash)) && m.url === `/@media/${m.hash}`, `B:${m.name} 按哈希还原`, m);
    check(m.status === 200 && m.bytes > 0, `B:${m.name} 的 /@media/<hash> 取得到`, m);
  }

  log('B:导出');
  const exp = await pageB.evaluate(async () => {
    const io = await import('/src/editor/io/index.ts');
    const r = await io.exportVideo();
    return { outDir: r.outDir, id: r.id };
  });
  const mp4 = path.join(exp.outDir, 'preview.mp4');
  const kept = path.join(OUT, `B-export-${RUN}.mp4`);
  await fs.copyFile(mp4, kept);
  const streams = JSON.parse(String(run(ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe')), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration', '-of', 'json', kept]))).streams;
  const segOld = audioStats(kept, 0.2, 1.1);
  const segNew = audioStats(kept, 1.7, 1.1);
  out.export = { file: kept, streams, segOld, segNew };
  check(streams.some((s) => s.codec_type === 'audio'), 'B 导出:有音轨', streams);
  check(segOld.rmsDb > -40, 'B 导出:老配音那一段(0.2～1.3 s)不是静音', segOld);
  check(segNew.rmsDb > -40, 'B 导出:新配音那一段(1.7～2.8 s)不是静音', segNew);
  check(Math.abs(segOld.hz - 440) <= 30, 'B 导出:老配音那一段是 440 Hz(确实是老配音)', segOld);
  check(Math.abs(segNew.hz - 880) <= 50, 'B 导出:新配音那一段是 880 Hz(确实是新配音)', segNew);
  check(!dialogsB.some((d) => d.type === 'pageerror'), 'B:页面没有报错', dialogsB.filter((d) => d.type === 'pageerror'));

  // ── 可选:用户发来的老包 ──
  if (USER_PROCP) {
    // 包可能有几百 MB:不经 evaluate 传字节,复制一份进 B 的素材目录(自己的临时目录),页面按文件名取。用户的原件只读
    const servedName = `user-${RUN}.procp`;
    await fs.mkdir(path.join(B.exportDir, 'media'), { recursive: true });
    await fs.copyFile(USER_PROCP, path.join(B.exportDir, 'media', servedName));
    const dialogsU = [];
    const pageU = await openEditor(browser, srvB.origin, dialogsU);
    const u = await pageU.evaluate(async (name) => {
      const blob = await (await fetch(`/@media/${encodeURIComponent(name)}`)).blob();
      const { actions, getState } = await import('/src/store/project.ts');
      const { loadProcpFile } = await import('/src/editor/io/procp.ts');
      actions.loadProject(await loadProcpFile(new File([blob], 'user.procp')), 'user.proc');
      return getState().project.media.map((m) => ({ kind: m.kind, name: m.name, hash: m.hash ?? null, url: m.url }));
    }, servedName);
    const unhashed = u.filter((m) => !HASH.test(String(m.hash)));
    out.userProcp = { file: USER_PROCP, media: u.length, hashed: u.length - unhashed.length, unhashed: unhashed.map((m) => ({ name: m.name, url: m.url })) };
    check(u.length > 0, '用户老包:照常打开,素材表不空', u);
    await packViaTopBar(pageU, { transfer: false, timeoutMs: 600000 });
    const inspU = await inspectPack(pageU);
    const alerts = dialogsU.filter((d) => d.type === 'alert');
    out.userProcp.repack = { bytes: inspU.size, names: inspU.names, alerts: alerts.map((a) => a.message) };
    out.userProcp.pageErrors = dialogsU.filter((d) => d.type === 'pageerror');
    check(!out.userProcp.pageErrors.length, '用户老包:页面没有报错', out.userProcp.pageErrors);
    if (unhashed.length) {
      check(alerts.length === 1, '用户老包:再打包时弹一次提示框', alerts);
      const msg = alerts[0]?.message || '';
      const shown = unhashed.filter((m) => msg.includes(String(m.name).replace(/^\(缺失\) /, '')));
      check(shown.length === Math.min(unhashed.length, 12), '用户老包:提示框列出了本机找不到文件的素材名字', { msg, unhashed: unhashed.map((m) => m.name) });
    }
    check(inspU.names.filter((n) => n.startsWith('media/')).length === u.length - unhashed.length, '用户老包:带哈希的素材照样进包', inspU.names);
  }
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
