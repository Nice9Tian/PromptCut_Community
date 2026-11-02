/**
 * 探针:Lottie 改成 remotion 式以后,在**真的管线**里验一遍——可见舞台(播放、暂停、拖动)、导出、预渲染产流。
 * 出处:`docs/plan/render-refactor-task.md`「癸」的验收,和「接的时候要做的」第 1 条(「预览和导出一致」要在真的导出管线里验)。
 *
 *   node scripts/probes/lottie-pipeline-probe.mjs [--port 27610] [--out <目录>] [--only stage,export,streams] [--json <文件>]
 *
 * 自己起一台隔离的编辑器(`preview-stop-lib.mjs` 的 `startIsolatedEditor`:数据目录、产物目录都在临时目录,不写公共的 port.json;
 * `--port` 另占 +1、+2 当舞台端口),Chrome 无头。项目是在编辑台里用 store 的 actions 建的,四张 Lottie 片段首尾相接:
 *   自带的 `lottie-navidad`(带嵌套蒙版)、`lottie-happy2016`(属性值留旧数的那一个);
 *   通用 `lottie` 卡放两份手写的测试素材(`scripts/probes/fixtures/lottie-seed/` 下带随机表达式的、带随机顺序文字的)。
 *
 * 验什么:
 *   export   真的导出(`exportUnified`,导出页):全长导三遍——单路顺着导、分 4 路导(remotion 式的卡允许从片段中间切开,
 *            后几路是直接跳进片段中间开始的)、只导抽的几帧(随机访问)。三遍同一帧的 PNG 逐像素相同。
 *            另用导出页(`FramePipeline.bakery` + `bakeFrames`,和导出同一条取帧的路)逐帧记下每张卡「看得见的 SVG 文本」的散列,给 stage 对。
 *   stage    可见舞台:暂停着在时间轴上点(往前、往回、跨片段),每次等它回到精确活渲,读这张卡看得见的 SVG 文本——
 *            要和导出页同一帧的相同(预览和导出一致);同一帧往前到和往回到的相同。再播放一段、暂停,停下的那一帧同样要和导出页相同;
 *            播放途中抽样,落在整帧上的样本也要相同。
 *   streams  预渲染:卡片计划里 Lottie 的 `frameMode` 是 direct、快照档(`snapshotTier`)是 none;钉成重卡以后每张各有一条单卡流,
 *            就绪索引里这几张卡只有 `stream` 层、没有快照层;流的 `replay` 是 false,产完以及把中间几段作废重产以后 `replayedFrames` 恒为 0;
 *            同一个分段「不回放直接产」和「从挂载帧回放着产」逐帧 PNG 逐像素相同。
 *
 * 判定:上面各条都成立;不成立进 `fails`,退出码 1。耗时只记录。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的导出目录 / 数据目录,也不写公共的 port.json
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { PNG } from 'pngjs';
import { flagArg } from './probe-connect.mjs';
import { openEditorPage, sleep, startIsolatedEditor, waitFor } from './preview-stop-lib.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { exportUnified } from '../../server/bakery/export-unified.mjs';
import { bakeFrames, bakeStream } from '../../server/bakery/bake.mjs';
import { SEGMENT_FRAMES } from '../../server/frame-stream.mjs';
import { snapshotTier } from '../../server/snapshot-tier.mjs';

const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '27610', args));
if (!Number.isInteger(PORT) || PORT < 20000) throw new Error('--port must be a port of 20000 or above');
const RUN = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), `pc-lottie-pipeline-${RUN}`);
const OUT = path.resolve(flagArg('out', null, args) || path.join('out', 'lottie-pipeline-probe'));
const JSON_OUT = flagArg('json', null, args);
const ONLY = (flagArg('only', null, args) || 'export,stage,streams').split(',').map((s) => s.trim()).filter(Boolean);
const FPS = 30;
const FIX = '/scripts/probes/fixtures/lottie-seed';
const CLIPS = [
  { name: 'navidad', cardId: 'lottie-navidad', start: 0, seconds: 5, params: {} },
  { name: 'happy2016', cardId: 'lottie-happy2016', start: 5, seconds: 3.4, params: {} },
  { name: 'random-expr', cardId: 'lottie', start: 8.4, seconds: 2, params: { json: '', src: `${FIX}/expr-layers.json` } },
  { name: 'random-text', cardId: 'lottie', start: 10.4, seconds: 2, params: { json: '', src: `${FIX}/text-random.json` } },
];
const DURATION = 12.4;

const fails = [];
const say = (line) => console.log(line);
const check = (cond, label, extra) => { if (!cond) { const msg = label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 500)); fails.push(msg); say(`FAIL ${msg}`); } return !!cond; };
const out = { port: PORT, out: OUT, only: ONLY };

/** 页面里用的:一张卡「看得见的 SVG 文本」的散列(口径同 lottie-seed-probe.mjs),同步算,和读舞台时刻放在同一次调用里 */
const GRAB_SRC = String.raw`(() => {
  if (window.__pcLottieGrab) return true;
  const normalize = (s) => { const ids = new Map(); return s.replace(/__lottie_element_\d+/g, (m) => { if (!ids.has(m)) ids.set(m, 'E' + ids.size); return ids.get(m); }); };
  const visible = (svg) => {
    const copy = svg.cloneNode(true);
    const walk = (el) => {
      if (el.style && el.style.display === 'none') { while (el.firstChild) el.removeChild(el.firstChild); for (const a of [...el.attributes]) if (a.name !== 'id' && a.name !== 'style') el.removeAttributeNode(a); return; }
      const attrs = [...el.attributes].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      for (const a of attrs) el.removeAttributeNode(a);
      for (const a of attrs) el.setAttributeNode(a);
      for (const child of [...el.children]) walk(child);
    };
    walk(copy);
    const refsOf = (el, into) => { for (const node of [el, ...el.querySelectorAll('*')]) for (const a of node.attributes) { for (const m of a.value.matchAll(/url\(["']?#([^)"']+)["']?\)/g)) into.add(m[1]); if (a.localName === 'href' && a.value.startsWith('#')) into.add(a.value.slice(1)); } };
    const byId = new Map(); for (const el of copy.querySelectorAll('[id]')) byId.set(el.getAttribute('id'), el);
    const used = new Set(); const pending = new Set();
    for (const child of copy.children) if (child.localName !== 'defs') refsOf(child, pending);
    while (pending.size) { const id = pending.values().next().value; pending.delete(id); if (used.has(id)) continue; used.add(id); const el = byId.get(id); if (el) { const more = new Set(); refsOf(el, more); for (const x of more) if (!used.has(x)) pending.add(x); } }
    for (const defs of copy.querySelectorAll('defs')) for (const res of [...defs.children]) { const ids = [res, ...res.querySelectorAll('[id]')].map((el) => el.getAttribute('id')).filter(Boolean); if (!ids.some((id) => used.has(id))) res.remove(); }
    return normalize(new XMLSerializer().serializeToString(copy));
  };
  const hash = (s) => { let a = 0x811c9dc5, b = 0x1b873593; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x85ebca6b) + 0x7f4a7c15 | 0; } return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0') + ':' + s.length; };
  /** 每张挂着 Lottie 的片段:{ 片段 id: 散列 };没挂或没有 SVG 的不列 */
  window.__pcLottieGrab = (ids) => {
    const res = {};
    for (const wrap of document.querySelectorAll('[data-pc-clip]:not([data-pc-media])')) {
      const id = wrap.getAttribute('data-pc-clip');
      if (ids && !ids.includes(id)) continue;
      const svg = [...wrap.querySelectorAll('svg')].find((el) => !el.closest('[data-pc-snapshot-plane],[data-pc-placeholder-slot],[data-pc-proxy-plane]'));
      if (svg) res[id] = hash(visible(svg));
    }
    return res;
  };
  return true;
})()`;

function diffPixels(a, b) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return -1;
  let n = 0;
  for (let i = 0; i < pa.data.length; i += 4) if (pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] || pa.data[i + 2] !== pb.data[i + 2] || pa.data[i + 3] !== pb.data[i + 3]) n++;
  return n;
}
const inkPixels = (png) => { const p = PNG.sync.read(png); let n = 0; for (let i = 3; i < p.data.length; i += 4) if (p.data[i] > 0) n++; return n; };
const frameFile = (dir, f) => path.join(dir, 'frames', `${String(f).padStart(6, '0')}.png`);

let editor = null, browser = null, pipeline = null;
const started = Date.now();
try {
  await fs.mkdir(OUT, { recursive: true });
  await fs.mkdir(WORK, { recursive: true });
  editor = await startIsolatedEditor({ port: PORT, work: WORK });
  const origin = editor.origin.replace(/\/+$/, '');
  out.origin = origin;
  // 测试素材由这台编辑器当普通文件发出去(舞台、导出页都取得到);取不到下面全都白测
  for (const name of ['expr-layers.json', 'text-random.json']) {
    const ok = await fetch(`${origin}${FIX}/${name}`).then(async (r) => r.ok && !!(await r.json()).layers, () => false);
    if (!ok) throw new Error(`The editor did not serve ${FIX}/${name} as JSON`);
  }

  // ── 在编辑台里建项目 ──
  const ed = await openEditorPage(origin);
  browser = ed.browser;
  const { page, store, frontFrame, parentDiag, pageErrors } = ed;
  const clipIds = await store(`actions.newProject(args[0]);
    const ids = [];
    for (const c of args[1]) {
      const trackId = ids.length ? actions.addTrack('t' + ids.length).id : undefined;
      const clip = actions.addCardClip(c.cardId, c.start, { duration: c.seconds, params: c.params, ...(trackId ? { trackId } : {}) });
      if (clip) ids.push(clip.id);
    }
    actions.select([]); actions.pause(); actions.seek(0);
    return ids;`, `lottie-pipeline-${RUN}`, CLIPS);
  if (!clipIds || clipIds.length !== CLIPS.length) throw new Error(`Project was not created: ${JSON.stringify(clipIds)}`);
  CLIPS.forEach((c, i) => { c.id = clipIds[i]; });
  const stored = await store('return JSON.parse(JSON.stringify(getState().project));');
  // 导出、预渲染用的就是编辑台里这一份(片段 id 相同),只把时长钉成四段的总长
  const project = { ...stored, fps: FPS, duration: DURATION };
  const placed = project.tracks.flatMap((t) => t.clips).map((c) => ({ id: c.id, cardId: c.cardId, start: c.start, end: c.end }));
  out.project = { id: project.id, width: project.width, height: project.height, fps: project.fps, duration: project.duration, storedDuration: stored.duration, clips: placed };
  check(project.width === 1920 && project.height === 1080 && (stored.fps ?? 30) === FPS, 'The project is 1920×1080 at 30 fps', out.project);
  check(CLIPS.every((c) => placed.some((p) => p.id === c.id && Math.abs(p.start - c.start) < 1e-6 && Math.abs(p.end - c.start - c.seconds) < 1e-6)), 'The four clips are placed at the planned positions', placed);
  const TOTAL = Math.floor(DURATION * FPS);
  const clipAt = (f) => CLIPS.find((c) => f / FPS >= c.start - 1e-9 && f / FPS < c.start + c.seconds - 1e-9) ?? null;
  const exportUrl = `${origin}/?export=1&timeline=${encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(project)))}`;

  // ── 导出页逐帧的 SVG 文本散列(和导出同一条取帧的路),给 stage 对;export 那一项也先要它 ──
  const domByFrame = [];
  if (ONLY.includes('export') || ONLY.includes('stage')) {
    const service = new FramePipeline({ root: path.join(WORK, 'dom-lib'), origin: () => origin, dataRoot: WORK });
    let bakery = null;
    try {
      bakery = await service.bakery(project);
      await bakeFrames(bakery, { out: path.join(WORK, 'dom-frames'), frames: `0-${TOTAL - 1}`, writeFrames: false, quiet: true,
        onFrame: async (f) => { await bakery.page.evaluate(GRAB_SRC); domByFrame[f] = await bakery.page.evaluate(() => window.__pcLottieGrab(null)); } });
    } finally { await bakery?.close().catch(() => {}); await service.close().catch(() => {}); }
    const missing = []; for (let f = 0; f < TOTAL; f++) { const c = clipAt(f); if (c && !domByFrame[f]?.[c.id]) missing.push(f); }
    out.exportDom = { frames: domByFrame.filter(Boolean).length, missing: missing.length, distinct: Object.fromEntries(CLIPS.map((c) => [c.name, new Set(domByFrame.map((d) => d?.[c.id]).filter(Boolean)).size])) };
    check(missing.length === 0, 'Every frame of the export page read the SVG of the card on stage', missing.slice(0, 20));
    for (const c of CLIPS) check(out.exportDom.distinct[c.name] > 20, `${c.name}: the export page's per-frame picture does change`, out.exportDom.distinct[c.name]);
    say(`Export page frame by frame: ${out.exportDom.frames} frames, ${missing.length} missing; distinct pictures per card ${JSON.stringify(out.exportDom.distinct)}`);
  }

  // ── export:真的导出,三遍 ──
  if (ONLY.includes('export')) {
    const logs = [];
    const realLog = console.log;
    const run = async (name, opts) => {
      const dir = path.join(OUT, name);
      await fs.rm(dir, { recursive: true, force: true });
      const t0 = Date.now();
      console.log = (...a) => { const line = a.join(' '); if (/sharded export/.test(line)) logs.push(`${name}: ${line}`); };
      try { await exportUnified(project, { url: exportUrl, out: dir, noVideo: true, ...opts }); } finally { console.log = realLog; }
      return { dir, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
    };
    const one = await run('export-1', { workers: 1 });
    const four = await run('export-4', { workers: 4 });
    const picks = [0, 1, 37, 62, 75, 96, 149, 150, 151, 199, 240, 251, 252, 263, 289, 311, 312, 330, 345, 371].filter((f) => f < TOTAL);
    const some = await run('export-picks', { targetFrames: picks });
    const shardLine = logs.find((l) => l.startsWith('export-4')) ?? '';
    const cuts = [...shardLine.matchAll(/(\d+)-(\d+)/g)].map((m) => Number(m[1])).filter((f) => f > 0);
    const insideClip = cuts.filter((f) => { const c = clipAt(f); return c && Math.round(c.start * FPS) !== f; });
    const cmp = (a, b, frames) => { const bad = []; let ink = 0; for (const f of frames) { const pa = fsSync.readFileSync(frameFile(a, f)), pb = fsSync.readFileSync(frameFile(b, f)); if (!pa.equals(pb)) { const d = diffPixels(pa, pb); if (d !== 0) bad.push({ f, pixels: d }); } if (f % 37 === 0) ink += inkPixels(pa) > 0 ? 1 : 0; } return { bad, ink }; };
    const all = Array.from({ length: TOTAL }, (_, i) => i);
    const a = cmp(one.dir, four.dir, all), b = cmp(one.dir, some.dir, picks);
    out.export = { seconds: { one: one.seconds, four: four.seconds, picks: some.seconds }, shards: shardLine, cuts, cutsInsideClip: insideClip, oneVsFour: { frames: TOTAL, differ: a.bad }, oneVsPicks: { frames: picks.length, differ: b.bad } };
    check(cuts.length >= 1, 'The 4-lane export did split', shardLine);
    check(insideClip.length >= 1, 'At least one split lands in the middle of a Lottie clip (that lane jumps straight in)', { cuts, clips: placed });
    check(a.ink > 0, 'The exported frame is not empty');
    check(a.bad.length === 0, `Single-lane sequential export vs 4-lane export: all ${TOTAL} frames are pixel-identical`, a.bad.slice(0, 12));
    check(b.bad.length === 0, `Single-lane sequential export vs export of only the ${picks.length} sampled frames: pixel-identical`, b.bad.slice(0, 12));
    say(`Export: single-lane ${one.seconds} s, 4-lane ${four.seconds} s, ${picks.length} sampled frames ${some.seconds} s; ${shardLine}; splits inside clips: ${insideClip.join(', ') || 'none'}; ${a.bad.length} frames differ between single-lane and 4-lane, ${b.bad.length} frames differ between single-lane and sampled frames`);
  }

  // ── stage:可见舞台 ──
  if (ONLY.includes('stage')) {
    const ids = CLIPS.map((c) => c.id);
    /** 可见舞台此刻:时刻、各卡的状态、各卡 SVG 的散列(同一次调用里读) */
    const readStage = async () => {
      const f = await frontFrame();
      if (!f) return null;
      await f.evaluate(GRAB_SRC).catch(() => {});
      return f.evaluate((ids2) => {
        const d = window.__pcStageDiag?.();
        if (!d || !window.__pcLottieGrab) return null;
        const busy = ids2.filter((id) => d.settling.includes(id) || d.suppressed.includes(id) || d.awaiting.includes(id) || d.snapshots.includes(id));
        const cls = ids2.map((id) => document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]:not([data-pc-media])`)?.className ?? '').filter((c) => /pc-(settling|suppressed|awaiting|snapshot)/.test(c));
        return { role: d.role, t: d.t, busy, cls, catchUps: d.catchUps.length, hashes: window.__pcLottieGrab(ids2) };
      }, ids).catch(() => null);
    };
    /** 暂停着点到第 frame 帧,等它回到精确活渲、读两次相同 */
    const arrive = async (frame) => {
      const sec = frame / FPS;
      await store('actions.pause(); actions.seek(args[0]);', sec);
      let last = null;
      const got = await waitFor(async () => {
        const pd = await parentDiag();
        if (!pd || pd.swapInFlight) return null;
        const s = await readStage();
        if (!s || s.role !== 'front' || Math.abs(s.t - sec) > 1e-6 || s.busy.length || s.cls.length || s.catchUps) { last = null; return null; }
        const c = clipAt(frame);
        if (c && !s.hashes[c.id]) { last = null; return null; }
        const key = JSON.stringify(s.hashes);
        if (last !== key) { last = key; return null; }
        return s;
      }, 30000, 150);
      return got;
    };
    // 等页面把四张卡测完(成本记录落定),免得测量趟在中途重挂舞台
    await sleep(3000);
    const rows = [];
    const visit = async (frame, how) => {
      const s = await arrive(frame);
      const c = clipAt(frame);
      const want = c ? domByFrame[frame]?.[c.id] : null;
      const got = s && c ? s.hashes[c.id] : null;
      rows.push({ frame, clip: c?.name, how, same: !!got && got === want });
      check(!!s, `Stage: ${how} to frame ${frame}, returned to exact live render within 30 s`);
      if (s) check(got === want, `Stage: ${how} to frame ${frame} (${c?.name}), the picture is identical to this frame of the export page`, { got, want });
      return got;
    };
    const byFrame = new Map();
    const remember = (f, h, how) => { if (!h) return; if (byFrame.has(f)) check(byFrame.get(f) === h, `Stage: frame ${f}, the result reached by ${how} is identical to the previous one`); else byFrame.set(f, h); };
    // 往前:每张片段里取几帧(navidad 取到顺着推时浏览器不重画蒙版的那一段:工程第 61～97 帧)
    const forward = [0, 1, 20, 37, 62, 63, 75, 96, 120, 149, 150, 151, 199, 240, 251, 252, 263, 289, 311, 312, 330, 345, 371];
    for (const f of forward) remember(f, await visit(f, 'click forward'), 'click forward');
    // 往回、跨片段乱跳
    const back = [345, 263, 75, 312, 62, 199, 20, 289, 96, 0, 371, 37, 240, 1];
    for (const f of back) remember(f, await visit(f, 'click backward or across clips'), 'click backward or across clips');
    // 一帧一帧挪(拖动):navidad 中间那一段往前挪 30 帧,再往回挪 10 帧
    for (let f = 60; f <= 90; f++) remember(f, await visit(f, 'step forward frame by frame'), 'step forward frame by frame');
    for (let f = 89; f >= 80; f--) remember(f, await visit(f, 'step backward frame by frame'), 'step backward frame by frame');
    // 播放:从四个位置各播一段,途中抽样,然后暂停
    const plays = [];
    for (const from of [45, 160, 255, 315]) {
      await arrive(from);
      await store('actions.play();');
      const samples = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) { const s = await readStage(); if (s) samples.push(s); await sleep(60); }
      await store('actions.pause();');
      await sleep(400);
      const pd = await store('return getState().currentTime ?? getState().time ?? null;');
      // 停下以后:读舞台此刻的时刻,它应当落在整帧上,画面和导出页那一帧相同
      let stop = null;
      await waitFor(async () => { const s = await readStage(); if (!s || s.role !== 'front' || s.busy.length || s.cls.length || s.catchUps) return null; if (stop && Math.abs(stop.t - s.t) < 1e-9 && JSON.stringify(stop.hashes) === JSON.stringify(s.hashes)) return s; stop = s; return null; }, 30000, 150);
      const onGrid = (t) => Math.abs(t * FPS - Math.round(t * FPS)) < 1e-4;
      let compared = 0, same = 0, offGrid = 0, noSvg = 0;
      for (const s of samples) {
        if (!onGrid(s.t)) { offGrid++; continue; }
        const f = Math.round(s.t * FPS), c = clipAt(f);
        if (!c) continue;
        if (!s.hashes[c.id] || s.busy.includes(c.id)) { noSvg++; continue; }
        compared++; if (s.hashes[c.id] === domByFrame[f]?.[c.id]) same++;
      }
      const stopFrame = stop ? Math.round(stop.t * FPS) : null, sc = stopFrame === null ? null : clipAt(stopFrame);
      const row = { from, samples: samples.length, advanced: samples.length ? +(samples[samples.length - 1].t - samples[0].t).toFixed(3) : 0, compared, same, offGrid, noSvg, stopT: stop?.t ?? null, stopFrame, storeTime: pd,
        stopSame: !!stop && !!sc && onGrid(stop.t) && stop.hashes[sc.id] === domByFrame[stopFrame]?.[sc.id] };
      plays.push(row);
      check(row.advanced > 0.5, `Stage: playing for 1.5 s from frame ${from}, the time did advance`, row);
      check(row.compared > 0 ? row.same === row.compared : true, `Stage: playing from frame ${from}, the samples taken on whole frames along the way match the export page`, row);
      check(row.stopSame, `Stage: after playing from frame ${from} and pausing, the picture at the stopped frame (frame ${stopFrame}) is identical to the export page`, row);
    }
    out.stage = { visited: rows.length, same: rows.filter((r) => r.same).length, plays, pageErrors: pageErrors.slice(0, 5) };
    check(pageErrors.length === 0, 'The editor page has no errors', pageErrors.slice(0, 3));
    say(`Stage: ${rows.length} clicks while paused (forward, backward, across clips, frame by frame), ${out.stage.same} identical to the same export page frame; ${plays.length} playback segments: ${plays.map((p) => `advanced ${p.advanced} s from frame ${p.from}, whole-frame samples along the way ${p.same}/${p.compared} identical (${p.offGrid} not on a whole frame), stopped at frame ${p.stopFrame}${p.stopSame ? 'same' : 'different'}`).join(';')}`);
  }
  await browser?.close().catch(() => {}); browser = null;

  // ── streams:预渲染产流 ──
  if (ONLY.includes('streams')) {
    const lib = path.join(WORK, 'stream-lib');
    pipeline = new FramePipeline({ root: lib, origin: () => origin, interactive: true, playhead: () => null, dataRoot: WORK });
    pipeline.streamPicked = () => true; // 钉成重卡:remotion 式的卡声明上是轻卡,不钉就不进预渲染
    const producer = pipeline.streamProducer();
    producer.attachRoute();
    const layers = [];
    pipeline.readyIndex.subscribe((m) => { if (m.type === 'layer') layers.push({ clipId: m.clipId, kind: m.kind }); });
    const dense = () => {
      const status = producer.status();
      if (!status.streams.length) return null;
      for (const s of status.streams) for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
      return !producer.workers.size && !producer.encoding.size ? status : null;
    };
    const t0 = Date.now();
    await pipeline.preload(project);
    const ready = await waitFor(() => (pipeline._streams?.streams.size >= CLIPS.length ? pipeline._streams : null), 180000, 500);
    if (!ready) throw new Error(`Producer did not start: ${pipeline._streams?.streams.size ?? 0} streams`);
    const first = await waitFor(dense, 900000, 1000);
    if (!first) throw new Error('The first production round did not finish');
    const produceSeconds = +((Date.now() - t0) / 1000).toFixed(1);
    const plan = [...pipeline.entries.values()].flatMap((e) => e.cardPlan ?? []);
    const rowOf = (status, clipId) => status.streams.find((s) => s.clipIds.length === 1 && s.clipIds[0] === clipId);
    const stateOf = (clipId) => [...producer.streams.values()].find((s) => s.spec.clipIds.length === 1 && s.spec.clipIds[0] === clipId);
    out.streams = { produceSeconds, encoder: first.encoder, cards: {}, compare: [] };
    for (const c of CLIPS) {
      const control = plan.find((x) => x.clipId === c.id);
      const row = rowOf(first, c.id);
      const kinds = [...new Set(layers.filter((l) => l.clipId === c.id).map((l) => l.kind))];
      const rec = { frameMode: control?.frameMode, tier: control?.tier, tierFromCapabilities: control ? snapshotTier(control.capabilities) : null, compositing: control?.capabilities?.compositing,
        stream: !!row, replay: row?.replay, replayedFrames: row?.replayedFrames, segments: row ? row.lastSegment - row.firstSegment + 1 : 0, layerKinds: kinds };
      out.streams.cards[c.name] = rec;
      check(rec.frameMode === 'direct', `${c.name}: the card plan is remotion-style (direct)`, rec.frameMode);
      check(rec.tier === 'none' && rec.tierFromCapabilities === 'none', `${c.name}: snapshot tier is none (no snapshots produced)`, rec);
      check(rec.stream, `${c.name}: once pinned as a heavy card there is one single-card stream`);
      check(rec.replay === false, `${c.name}: the stream does not replay from the mount frame (replay is false)`, rec.replay);
      check(rec.replayedFrames === 0, `${c.name}: replayedFrames is 0 after production finishes`, rec.replayedFrames);
      check(kinds.includes('stream') && kinds.every((k) => k === 'stream'), `${c.name}: the ready index has only a stream layer, no snapshot layer`, kinds);
    }
    // 库里有没有落下快照
    const snapshotDirs = ['controls-html', 'controls-local'].map((d) => { try { return fsSync.readdirSync(path.join(lib, d)).length; } catch { return 0; } });
    out.streams.snapshotDirs = { 'controls-html': snapshotDirs[0], 'controls-local': snapshotDirs[1] };
    check(snapshotDirs[0] === 0 && snapshotDirs[1] === 0, 'No snapshots were written next to the stream store', out.streams.snapshotDirs);
    // 中间几段作废再产
    const REGEN = [3, 1, 2];
    const before = Object.fromEntries(CLIPS.map((c) => { const r = rowOf(producer.status(), c.id); return [c.id, (r.resets?.sparse ?? 0) + (r.resets?.dense ?? 0)]; }));
    for (const c of CLIPS) { const state = stateOf(c.id); for (const n of REGEN) delete state.manifest.segments[state.spec.firstSegment + n]; }
    producer.kick();
    const second = await waitFor(() => { const s = dense(); return s && s.streams.every((x) => REGEN.every((n) => x.segments[x.firstSegment + n]?.stride === 1)) ? s : null; }, 900000, 1000);
    if (!second) throw new Error('The invalidated segment did not finish producing again');
    for (const c of CLIPS) {
      const r = rowOf(second, c.id);
      const resets = (r.resets?.sparse ?? 0) + (r.resets?.dense ?? 0) - before[c.id];
      out.streams.cards[c.name].afterRegen = { replayedFrames: r.replayedFrames, resets };
      check(r.replayedFrames === 0, `${c.name}: replayedFrames is still 0 after the middle three segments were invalidated and produced again (page reloaded ${resets} times)`, r.replayedFrames);
    }
    // 同一个分段:不回放直接产 对 从挂载帧回放着产,逐帧比 PNG
    const bakery = await pipeline.leaseStreamBakery();
    try {
      for (const c of CLIPS) {
        const state = stateOf(c.id);
        const { spec, manifest } = state;
        const rect = manifest.tight ?? manifest.bound;
        const clip = { x: rect.x + spec.offset.x, y: rect.y + spec.offset.y, w: rect.w, h: rect.h };
        const shoot = async (segment, replay) => {
          const fromFrame = segment * SEGMENT_FRAMES, toFrame = Math.min(fromFrame + SEGMENT_FRAMES - 1, spec.total - 1, spec.lastFrame);
          await bakery.reset(state.isolated, pipeline.emptyUrl(state.isolated), { deferCards: true });
          bakery.streamLease = null;
          const pngs = [];
          const stats = await bakeStream(bakery, { streamSignature: `${spec.streamKey}:${replay ? 'replay' : 'direct'}:${segment}`, fromFrame, toFrame, stride: 1, fps: spec.fps,
            ...(replay ? { mountFrame: spec.mountFrame } : { warm: 0 }), clip, hasMedia: false, onFrame: async (_f, png) => { pngs.push(png); } });
          bakery.streamLease = null;
          return { pngs, stats };
        };
        const span = spec.lastSegment - spec.firstSegment;
        const segments = [...new Set([spec.firstSegment + 1, spec.firstSegment + Math.floor(span / 2), spec.firstSegment + Math.floor(span * 0.6), spec.lastSegment - 1])].filter((n) => n > spec.firstSegment && n <= spec.lastSegment);
        for (const segment of segments) {
          const direct = await shoot(segment, false), replay = await shoot(segment, true);
          const diffs = direct.pngs.map((png, i) => (replay.pngs[i] ? diffPixels(png, replay.pngs[i]) : -1));
          const ink = replay.pngs.map(inkPixels);
          const rec = { clip: c.name, segment, frames: direct.pngs.length, replayedDirect: direct.stats.replayed, replayedReplay: replay.stats.replayed, diffPixelsMax: Math.max(...diffs), differFrames: diffs.filter((d) => d !== 0).length, inkMax: Math.max(...ink) };
          out.streams.compare.push(rec);
          check(direct.pngs.length === replay.pngs.length && direct.pngs.length > 0, `${c.name}#${segment}: both paths have the same frame count`, [direct.pngs.length, replay.pngs.length]);
          check(rec.replayedDirect === 0 && rec.replayedReplay > 0, `${c.name}#${segment}: one path did not replay and the other did`, rec);
          check(rec.inkMax > 0, `${c.name}#${segment}: the image is not empty`);
          check(rec.diffPixelsMax === 0, `${c.name}#${segment}: producing directly without replay and producing with replay from the mount frame are identical frame by frame, pixel by pixel`, diffs);
          if (segment === segments[Math.min(1, segments.length - 1)]) await fs.writeFile(path.join(OUT, `stream-${c.name}-seg${segment}-direct.png`), direct.pngs[Math.min(7, direct.pngs.length - 1)]);
        }
      }
    } finally { pipeline.returnStreamBakery(bakery); }
    const final = producer.status();
    check(CLIPS.every((c) => rowOf(final, c.id).replayedFrames === 0), 'Final check: replayedFrames is 0 on all four streams');
    say(`Stream production: ${final.streams.length} streams finished in ${produceSeconds} s; ${CLIPS.map((c) => { const r = out.streams.cards[c.name]; return `${c.name} ${r.frameMode}/${r.tier}/replay=${r.replay}/replayedFrames=${r.afterRegen?.replayedFrames}/layers=${r.layerKinds.join('+')}`; }).join(';')}; compared no-replay with replay frame by frame over ${out.streams.compare.length} segments, ${out.streams.compare.filter((r) => r.diffPixelsMax !== 0).length} segments differ`);
  }
} catch (error) {
  fails.push(`Probe itself failed: ${String(error?.stack || error).slice(0, 900)}`);
  say(`FAIL ${fails[fails.length - 1]}`);
} finally {
  try { await pipeline?.close(); } catch { /* ignore */ }
  try { await browser?.close(); } catch { /* ignore */ }
  try { await editor?.stop(); } catch { /* ignore */ }
  try { fsSync.rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* ignore */ }
}
out.seconds = +((Date.now() - started) / 1000).toFixed(1);
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ok: out.ok, fails, seconds: out.seconds }));
process.exit(out.ok ? 0 : 1);
