/**
 * 剪辑段里的有声动效卡:导出前自动生成声音递归进剪辑段,成片里听得到,并按剪辑段的音量、淡入淡出、静音处理
 * (剪辑段首版局限补齐第 3 项,`docs/archive/agent-reports/AGENT-cut-segment-followups.md`)。
 *
 *   node scripts/probes/cut-segment-card-sound-probe.mjs [--port 5373] [--out <目录>]
 *
 * 做法:本探针自己起一台本树的 dev server(端口 --port 与 +1、+2 要空着,不碰 5190～5192;导出、数据目录都在 --out 下),
 * 无头 Chrome(`--mute-audio`,不向扬声器出声)打开编辑台,摆这个项目(声音都没生成过):
 *   剪辑2(2 秒):内置有声卡 av-pulse 放在 0.5～1.1 秒(880 Hz 提示音,0.3 秒);
 *   剪辑3(2 秒):一个引用剪辑2 的剪辑段 0～2 秒(两层嵌套);
 *   剪辑1(激活,16 秒):
 *     S1 1～3 秒引用剪辑2,音量 1        → 提示音在 1.5 秒;
 *     S2 4～6 秒引用剪辑2,音量 0.5      → 4.5 秒,比 S1 低 6 dB;
 *     S3 7～9 秒引用剪辑2,静音          → 7.5 秒没有声音;
 *     S4 10～12 秒引用剪辑2,淡入 1 秒    → 10.5 秒,落在淡入中段(增益 0.5～0.8),比 S1 低;
 *     S5 13～15 秒引用剪辑3             → 13.5 秒,和 S1 一样响。
 * 两条导出路各走一遍,每一遍之前都把项目换回「声音都没生成过」:
 *   B 浏览器那一路(和 `exportVideoBrowser({ sounds: true })` 同样先生成声音,再按 `browserExport.encodeAudio` 的做法在 Chrome 里离线混音成 WAV;
 *     视频编码那一步不走:本机 dev server 上 exportVideoBrowser 连空项目都卡住不返回,开工前的提交上同样);
 *   D 桌面导出(`window.__pcIo.exportVideo()`:先生成声音,再交预渲染进程导出,ffmpeg 混音)。
 *
 * 断言(每条一行 PASS/FAIL,最后一行打一行 JSON,有失败退出码 1):
 *   N  导出前的清单只有一项:剪辑2 里那张有声卡(带 cutId;被引用 5 次、两层嵌套也只列一次);改动前导出直接报缺
 *   G  导出之后声音记在剪辑2 的原片段上(停放的剪辑),激活剪辑的序列不动;再列清单为空
 *   成片(ffmpeg astats 量各窗口 RMS dB):S1 有声(> -45 dB);S2 比 S1 低 6 dB(±1.5);S3 无声(< -60 dB);
 *     S4 比 S1 低 1～8 dB;S5 与 S1 差不到 1.5 dB;段与段之间无声(< -60 dB)
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startDevServer, REPO } from '../lib/dev-server.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 40 * 60_000).unref();
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 5373));
const OUT = path.resolve(arg('--out', path.join(REPO, 'out', 'cut-segment-card-sound')));
const dirs = { exportDir: path.join(OUT, 'export'), dataDir: path.join(OUT, 'data'), projectsDir: path.join(OUT, 'projects') };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const fails = [];
const check = (key, cond, note, extra) => {
  results[key] = { ok: !!cond, note, ...(extra !== undefined ? { extra } : {}) };
  if (!cond) fails.push(`${key}: ${note}`);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${key} ${note} ${extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ''}`);
};
/** 一个文件 [from, to) 秒的整体 RMS(dB);没有声音样本时 null,全零 -200 */
function rmsOf(file, from, to) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(from), '-t', String(to - from), '-i', file, '-vn', '-af', 'astats=metadata=0:reset=0', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  const m = /Overall[\s\S]*?RMS level dB:\s*(-?inf|-?[\d.]+)/.exec(r.stderr);
  return m ? (m[1].includes('inf') ? -200 : Number(m[1])) : null;
}
const quiet = (v) => v === null || v < -60;

function audit(tag, file) {
  const w = (at) => rmsOf(file, at + 0.02, at + 0.28);
  const lv = { S1: w(1.5), S2: w(4.5), S3: w(7.5), S4: w(10.5), S5: w(13.5) };
  const gaps = { g0: rmsOf(file, 0, 1.45), g1: rmsOf(file, 2.0, 4.45), g2: rmsOf(file, 5.0, 10.45), g3: rmsOf(file, 11.0, 13.45), g4: rmsOf(file, 14.0, 15.9) };
  check(`${tag}-S1`, lv.S1 !== null && lv.S1 > -45, `剪辑段 S1(音量 1)里听得到提示音:${lv.S1} dB`, lv);
  check(`${tag}-S2`, lv.S2 !== null && Math.abs(lv.S1 - lv.S2 - 6.02) < 1.5, `S2 音量 0.5:比 S1 低 ${(lv.S1 - lv.S2).toFixed(2)} dB(应约 6.02)`);
  check(`${tag}-S3`, quiet(lv.S3), `S3 静音:${lv.S3} dB`);
  check(`${tag}-S4`, lv.S4 !== null && lv.S1 - lv.S4 > 1 && lv.S1 - lv.S4 < 8, `S4 淡入中段:比 S1 低 ${(lv.S1 - lv.S4).toFixed(2)} dB`);
  check(`${tag}-S5`, lv.S5 !== null && Math.abs(lv.S1 - lv.S5) < 1.5, `S5 两层嵌套:与 S1 差 ${(lv.S1 - lv.S5).toFixed(2)} dB`);
  check(`${tag}-gaps`, Object.values(gaps).every(quiet), '段与段之间无声', gaps);
  return { levels: lv, gaps };
}

const server = await startDevServer({ port: PORT, logFile: path.join(OUT, 'vite.log'), log: (m) => console.log('[dev]', m),
  env: { PROMPTCUT_EXPORT_DIR: dirs.exportDir, PROMPTCUT_DATA_DIR: dirs.dataDir, PROMPTCUT_PROJECTS_DIR: dirs.projectsDir, PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_PUSH: '0' } });
const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--mute-audio', '--force-device-scale-factor=1'], protocolTimeout: 15 * 60_000 });
const report = {};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { void d.dismiss(); });
  await page.goto(`${server.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => !!window.__pcStore && !!window.__pcIo, { timeout: 120_000 });
  await sleep(5000);

  /* 摆项目,存一份「声音都没生成过」的原样,两条路各从它开始 */
  const setup = await page.evaluate(() => {
    const a = window.__pcStore.actions;
    a.newProject('剪辑段里的有声卡');
    a.setProjectMeta({ width: 480, height: 270, fps: 15 });
    const c2 = a.addCut('剪辑2', { switchTo: true });
    const card = a.addCardClip('av-pulse', 0.5, { duration: 0.6, params: { frequency: 880, gain: 0.3, duration: 0.3 } });
    a.setProjectMeta({ duration: 2 });
    const c3 = a.addCut('剪辑3', { switchTo: true });
    a.addCutSegment(c2.id, 0, { duration: 2 });
    a.setProjectMeta({ duration: 2 });
    const root = window.__pcStore.getState().project.cuts[0].id;
    a.switchCut(root);
    const s1 = a.addCutSegment(c2.id, 1, { duration: 2 });
    const s2 = a.addCutSegment(c2.id, 4, { duration: 2 });
    a.setClipVolume(s2.id, 0.5);
    const s3 = a.addCutSegment(c2.id, 7, { duration: 2 });
    a.setClipMuted(s3.id, true);
    const s4 = a.addCutSegment(c2.id, 10, { duration: 2 });
    a.updateClip(s4.id, { fadeIn: 1 });
    const s5 = a.addCutSegment(c3.id, 13, { duration: 2 });
    a.setProjectMeta({ duration: 16 });
    const p = window.__pcStore.getState().project;
    return { project: JSON.parse(JSON.stringify(p)), ids: { root, c2: c2.id, c3: c3.id, card: card.id, segs: [s1.id, s2.id, s3.id, s4.id, s5.id] } };
  });
  report.ids = setup.ids;
  const fresh = setup.project;

  for (const mode of ['browser', 'desktop']) {
    const tag = mode === 'browser' ? 'B' : 'D';
    await page.evaluate((p) => window.__pcStore.actions.loadProject(JSON.parse(JSON.stringify(p))), fresh);
    await sleep(500);
    const pre = await page.evaluate(async () => {
      const sound = await window.__pcIo.sound();
      const needs = await sound.listExportSoundNeeds(new AbortController().signal);
      const { assertProjectCardAudio } = await import('/src/audio/cardAudio.ts');
      let err = null;
      try { assertProjectCardAudio(window.__pcStore.getState().project); } catch (e) { err = String(e?.message ?? e); }
      return { needs: needs.map((n) => ({ clipId: n.clipId, cutId: n.cutId, kind: n.kind, reason: n.reason, label: n.label })), err };
    });
    check(`${tag}-N`, pre.needs.length === 1 && pre.needs[0].clipId === setup.ids.card && pre.needs[0].cutId === setup.ids.c2 && pre.needs[0].reason === 'ungenerated' && /尚未生成/.test(pre.err ?? ''),
      '导出前清单只有剪辑2 里那张有声卡(带 cutId),改动前的核对点名原片段', pre);
    const activeBefore = await page.evaluate(() => JSON.stringify(window.__pcStore.getState().project.tracks));

    const file = path.join(OUT, mode === 'browser' ? 'browser.wav' : 'desktop.mp4');
    if (mode === 'browser') {
      // 浏览器那一路:和 exportVideoBrowser({ sounds: true }) 同样先 prepareExportSounds,再按 browserExport.encodeAudio 的做法
      // (audioPlanOf → 按条切片 → renderMix,Chrome 离线混音带 gainCurve 包络)混成 WAV。不走视频编码那一步:
      // 本机 dev server 上 exportVideoBrowser 连不含剪辑段的空项目也卡住不返回,开工前的提交 a55d8199 上同样(见报告「没做成的」)
      const r = await page.evaluate(async () => {
        try {
          const { prepareExportSounds } = await import('/src/editor/io/exportSounds.ts');
          const { audioPlanOf } = await import('/src/kernel/audioPlan.mjs');
          const { renderMix, encodeWavFloat32 } = await import('/src/audio/renderMix.ts');
          const { assertProjectCardAudio } = await import('/src/audio/cardAudio.ts');
          const progress = [];
          await prepareExportSounds({ signal: new AbortController().signal, onProgress: (d, t) => progress.push([d, t]) });
          const p = window.__pcStore.getState().project;
          assertProjectCardAudio(p);
          const plan = audioPlanOf(p);
          const ctx = new OfflineAudioContext(2, 1, 48000);
          const decoded = new Map();
          const slices = new Map();
          const clips = [];
          for (const [i, e] of plan.entries()) {
            const m = p.media.find((x) => x.id === e.mediaId);
            if (!decoded.has(m.id)) decoded.set(m.id, await ctx.decodeAudioData(await (await fetch(m.url)).arrayBuffer()));
            const src = decoded.get(m.id), from = Math.round(e.offset * 48000), n = Math.max(1, Math.round(e.dur * 48000));
            const chans = [0, 1].map((c) => { const out = new Float32Array(n); const d = src.getChannelData(Math.min(c, src.numberOfChannels - 1)); out.set(d.subarray(from, Math.min(d.length, from + n))); return out; });
            slices.set(`s${i}`, encodeWavFloat32({ numberOfChannels: 2, length: n, sampleRate: 48000, getChannelData: (c) => chans[c] }));
            clips.push({ clipId: e.clipId, url: `s${i}`, start: e.start, dur: e.dur, volume: e.volume, fadeIn: e.fadeIn, fadeOut: e.fadeOut, fx: e.fx, ...(e.env ? { env: e.env } : null) });
          }
          const { buffer } = await renderMix({ sampleRate: 48000, duration: p.duration, clips }, async (u) => new Response(slices.get(String(u))));
          const bytes = new Uint8Array(encodeWavFloat32(buffer));
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return { base64: btoa(bin), entries: plan.length, envs: plan.filter((e) => e.env).length, progress: progress.slice(-1)[0] ?? null };
        } catch (e) { return { error: String(e?.message ?? e) }; }
      });
      check(`${tag}-export`, !r.error && r.base64 && r.entries === 4, '浏览器那一路:先生成声音,再 Chrome 离线混音(混音计划 4 条,S3 静音不进)', { error: r.error, entries: r.entries, envs: r.envs, progress: r.progress });
      if (r.base64) fs.writeFileSync(file.replace(/\.mp4$/, '.wav'), Buffer.from(r.base64, 'base64'));
    } else {
      const r = await page.evaluate(async () => {
        const progress = [];
        try {
          const out = await window.__pcIo.exportVideo({ onProgress: (d, t, stage) => progress.push([stage ?? 'render', d, t]) });
          return { ok: true, outDir: out.outDir, sound: progress.filter((x) => x[0] === 'sound').slice(-1)[0] ?? null };
        } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
      });
      check(`${tag}-export`, r.ok && fs.existsSync(path.join(r.outDir ?? '', 'preview.mp4')), '桌面导出成功(进度里有声音生成阶段)', r);
      if (r.ok) fs.copyFileSync(path.join(r.outDir, 'preview.mp4'), file);
    }
    const post = await page.evaluate(async (ids) => {
      const p = window.__pcStore.getState().project;
      const clip = p.cuts.find((c) => c.id === ids.c2)?.tracks?.flatMap((t) => t.clips).find((c) => c.id === ids.card);
      const sound = await window.__pcIo.sound();
      return { hasAudio: !!clip?.cardAudio, mediaId: clip?.cardAudio?.mediaId ?? null, active: JSON.stringify(p.tracks), needs: (await sound.listExportSoundNeeds(new AbortController().signal)).length };
    }, setup.ids);
    check(`${tag}-G`, post.hasAudio && post.active === activeBefore && post.needs === 0, '声音记在剪辑2 的原片段上,激活剪辑的序列不动,再列清单为空', { hasAudio: post.hasAudio, activeSame: post.active === activeBefore, needs: post.needs });
    if (fs.existsSync(file)) report[mode] = audit(tag, file);
  }
  check('E0', errors.length === 0, '页面零报错', errors);
} finally {
  await browser.close();
  server.stop();
}
console.log(JSON.stringify({ ok: fails.length === 0, results, report, fails }));
process.exit(fails.length ? 1 : 0);
