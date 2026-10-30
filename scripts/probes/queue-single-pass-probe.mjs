/**
 * 队列细任务「一段一趟顺推」与原来「每 4 帧一批、每批换页从挂载帧回放」产出的快照是否等价
 * (`server/frame-pipeline.mjs` 的 `queueSinglePass`;`docs/archive/agent-reports/AGENT-uc-latency.md`)。
 *
 *   先起开发服务器(它另占 +1、+2 两个舞台端口):npx vite --port 5740 --strictPort --host 127.0.0.1
 *   node scripts/probes/queue-single-pass-probe.mjs --origin http://127.0.0.1:5740 [--out <目录>] [--cards a,b,c] [--seconds 4]
 *
 * 做法:本进程起两个 `FramePipeline`(各自一个临时帧库),同一个项目(每张卡一条轨道、从 0 秒起、缺省参数)。
 * 两边都走队列执行器那条路 —— `planForQueue` 取计划,每张共享档卡按 60 帧一段调 `renderCardSnapshotRange`;
 * A 边关掉顺推(`queueSinglePassOff = true`,即原来的逐批),B 边照新行为。之后逐帧比:
 *   - HTML 快照逐字节相同几帧;不同的再去掉 `will-change`(Motion 动画进行中才挂的提示,M7 探针 P2 记过)比一次;
 *   - 仍不同的帧,两边 HTML 按预渲染重放的挂法(`captureSnapshot`,同一个预渲染间)各截一张,比像素(解码后逐像素)。
 *   - 像素也不同的帧,再以这张卡的顺序活渲为准(单独一条轨道、从第 0 帧逐帧推、逐帧截整幅图,同导出的推法),看两边谁与它一致。
 * 判据:每张卡每帧「字节相同」或「只差 will-change」或「像素相同」,或者像素不同但顺推没有退步(没有「逐批与活渲一致、顺推不一致」的帧);
 * 另报两边各段的用时。(第一次跑:`mu-word-rotate` 逐批从第 32 帧起就与活渲不一致 —— 逐批每批从头回放时不截图,
 * Motion 的 JS 帧循环推不动,AnimatePresence 换词的相位落后;顺推第一段与活渲逐像素相同,第二段开头几帧同样落后、之后对上。)
 *
 * 输出:过程写 stderr;stdout 最后一行一行 JSON `{ ok, fails, cards: { <cardId>: {…} }, timing }`。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const ORIGIN = String(arg('--origin', 'http://127.0.0.1:5740')).replace(/\/+$/, '');
const OUT = path.resolve(arg('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-probe-'))));
const SECONDS = Number(arg('--seconds', 4));
const FPS = 30;
const SPAN = 60;
const DEFAULT_CARDS = ['mu-animated-shiny-text', 'punch-pill', 'mu-number-ticker', 'probe-slow-stepped', 'mu-typing', 'mu-word-rotate', 'mu-blur-fade',
  'mu-circular-progress', 'type-shift', 'probe-countdown', 'probe-typewriter', 'probe', 'probe-motion-js', 'r6-stateful', 'caption-track', 'chapter-bar', 'entity-chips',
  'focus-card', 'lottie', 'pin-board', 'quote-lockup', 'step-timeline', 'term-card', 'ui-callout', 'versus-card', 'blur-text', 'odometer', 'rank-bars', 'ring-metric',
  'growth-curve', 'checklist', 'stat-proof', 'probe-css', 'particles'];
const CARDS = String(arg('--cards', DEFAULT_CARDS.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
const log = (...a) => process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const stripWillChange = (h) => h.replace(/will-change:[^;"]*;?/g, '');

const PROJECT = {
  id: 'qsp-probe', name: '顺推对照', width: 1920, height: 1080, fps: FPS, duration: SECONDS,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: CARDS.map((cardId, i) => ({ id: `tr-${i}`, name: cardId, hidden: false, clips: [{ id: `clip-${cardId}`, kind: 'card', cardId, start: 0, end: SECONDS, params: {} }] })),
};

async function runSide(name, singlePassOff) {
  const root = path.join(OUT, `${name}-lib`);
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(root, { recursive: true });
  const { FramePipeline } = await import('../../server/frame-pipeline.mjs');
  const pipeline = new FramePipeline({ root, origin: () => ORIGIN, interactive: false, dataRoot: root });
  pipeline.queueSinglePassOff = singlePassOff;
  const side = { name, cards: {}, ms: 0 };
  const t0 = Date.now();
  try {
    const { entry, context } = await pipeline.planForQueue(PROJECT);
    pipeline.addBackfill(entry, context.cardPlan.map((c) => c.clipId));
    for (const control of context.cardPlan) {
      const tier = control.tier;
      const cardId = control.cardId ?? control.clipId.replace(/^clip-/, '');
      if (tier !== 'shared') { side.cards[cardId] = { skipped: `tier ${tier}` }; continue; }
      const segs = [];
      for (let from = 0; from < control.count; from += SPAN) {
        const range = { from, to: Math.min(control.count - 1, from + SPAN - 1) };
        const timing = {};
        const s0 = Date.now();
        await pipeline.renderCardSnapshotRange(entry, control, range, { timing });
        segs.push({ range: `${range.from}-${range.to}`, ms: Date.now() - s0, singlePass: timing.singlePass === true, batches: timing.batches ?? null, resetMs: timing.resetMs ?? null, bakeMs: timing.bakeMs ?? null });
      }
      const dir = pipeline.snapshots().dir({ tier: 'shared', key: control.snapshotKey });
      const dst = path.join(OUT, name, cardId);
      await fsp.rm(dst, { recursive: true, force: true });
      await fsp.mkdir(dst, { recursive: true });
      for (const n of await fsp.readdir(dir)) if (/^\d+\.html$/.test(n)) await fsp.copyFile(path.join(dir, n), path.join(dst, n));
      side.cards[cardId] = { count: control.count, segs, capabilities: control.capabilities ?? null };
      log(`${name} ${cardId}: ${segs.map((s) => `${s.range} ${s.ms} ms${s.singlePass ? ' 顺推' : ''}`).join(', ')}`);
    }
  } finally {
    side.ms = Date.now() - t0;
    await pipeline.close().catch(() => {});
  }
  return side;
}

function decode(buf) { const p = PNG.sync.read(buf); return p; }

/** 这张卡单独一条轨道、从第 0 帧顺序推到末帧、逐帧截活渲整幅图(同导出的推法);回 帧号 → PNG */
async function sequentialLive(bakery, cardId, count) {
  const { bakeFrames } = await import('../../server/bakery/bake.mjs');
  const one = { ...PROJECT, tracks: [{ id: 'tr-0', name: cardId, hidden: false, clips: [{ id: `clip-${cardId}`, kind: 'card', cardId, start: 0, end: SECONDS, params: {} }] }] };
  const empty = { ...PROJECT, tracks: [], media: [] };
  await bakery.reset(one, `${ORIGIN}/?export=1&timeline=${encodeURIComponent(`data:application/json,${encodeURIComponent(JSON.stringify(empty))}`)}`);
  await bakery.page.setViewport({ width: PROJECT.width, height: PROJECT.height, deviceScaleFactor: 1 });
  const frames = new Map();
  await bakeFrames(bakery, { out: path.join(OUT, 'live-tmp'), frames: `0-${count - 1}`, fullFrame: true, writeFrames: false, quiet: true,
    onFrame: async (n, png) => { frames.set(n, png); } });
  // 之后的快照重放要回到空页上
  await bakery.reset(empty, `${ORIGIN}/?export=1&timeline=${encodeURIComponent(`data:application/json,${encodeURIComponent(JSON.stringify(empty))}`)}`);
  await bakery.page.setViewport({ width: PROJECT.width, height: PROJECT.height, deviceScaleFactor: 1 });
  await bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  return frames;
}
function pixelDiff(a, b) {
  const A = decode(a), B = decode(b);
  if (A.width !== B.width || A.height !== B.height) return { size: [A.width, A.height, B.width, B.height] };
  let differ = 0, maxd = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    let m = 0;
    for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(A.data[i + k] - B.data[i + k]));
    if (m) differ++;
    if (m > maxd) maxd = m;
  }
  return { differ, maxd };
}

const fails = [];
const notes = [];
const out = { ok: false, origin: ORIGIN, out: OUT, cards: {}, timing: {} };
try {
  const a = await runSide('batch4', true);
  const b = await runSide('single', false);
  out.timing = { batch4Ms: a.ms, singleMs: b.ms };
  const { openBakery } = await import('../../server/bakery/chrome.mjs');
  const { captureSnapshot } = await import('../../server/bakery/capture-snapshot.mjs');
  const empty = { ...PROJECT, tracks: [], media: [] };
  const bakery = await openBakery({ url: `${ORIGIN}/?export=1&timeline=${encodeURIComponent(`data:application/json,${encodeURIComponent(JSON.stringify(empty))}`)}` });
  await bakery.page.setViewport({ width: PROJECT.width, height: PROJECT.height, deviceScaleFactor: 1 });
  await bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  try {
    for (const cardId of CARDS) {
      const ca = a.cards[cardId], cb = b.cards[cardId];
      if (!ca || !cb || ca.skipped || cb.skipped) { out.cards[cardId] = { skipped: ca?.skipped ?? cb?.skipped ?? 'missing' }; continue; }
      const row = { count: ca.count, bytesSame: 0, sameIgnoringWillChange: 0, pixelSame: 0, pixelDiffer: 0, differFrames: [], missing: 0, firstDiff: null,
        batch4: ca.segs.map((s) => s.ms), single: cb.segs.map((s) => s.ms), singlePass: cb.segs.every((s) => s.singlePass) };
      for (let n = 0; n < ca.count; n++) {
        const fa = path.join(OUT, 'batch4', cardId, `${n}.html`), fb = path.join(OUT, 'single', cardId, `${n}.html`);
        if (!fs.existsSync(fa) || !fs.existsSync(fb)) { row.missing++; continue; }
        const ha = fs.readFileSync(fa, 'utf8'), hb = fs.readFileSync(fb, 'utf8');
        if (sha(ha) === sha(hb)) { row.bytesSame++; continue; }
        if (stripWillChange(ha) === stripWillChange(hb)) { row.sameIgnoringWillChange++; continue; }
        const pa = await captureSnapshot(bakery, ha), pb = await captureSnapshot(bakery, hb);
        const d = pa.equals(pb) ? { differ: 0, maxd: 0 } : pixelDiff(pa, pb);
        if (!d.size && d.differ === 0) { row.pixelSame++; continue; }
        row.pixelDiffer++;
        row.differFrames.push(n);
        if (!row.firstDiff) {
          row.firstDiff = { frame: n, ...d };
          fs.mkdirSync(path.join(OUT, 'diff'), { recursive: true });
          fs.writeFileSync(path.join(OUT, 'diff', `${cardId}-${n}-batch4.png`), pa);
          fs.writeFileSync(path.join(OUT, 'diff', `${cardId}-${n}-single.png`), pb);
        }
      }
      out.cards[cardId] = row;
      if (row.missing) fails.push(`${cardId}:缺帧 ${row.missing}`);
      if (row.pixelDiffer) {
        // 两边不同:以这张卡的顺序活渲(从第 0 帧起逐帧推、逐帧截图,同导出)为准,看哪边与它一致。
        // 顺推不许在逐批对得上的帧上对不上(那才是退步);逐批本来就对不上、顺推对上了的,是顺推更准
        const truth = await sequentialLive(bakery, cardId, ca.count);
        const judge = { batch4Match: 0, singleMatch: 0, regressions: [] };
        for (const n of row.differFrames) {
          const la = await captureSnapshot(bakery, fs.readFileSync(path.join(OUT, 'batch4', cardId, `${n}.html`), 'utf8'));
          const lb = await captureSnapshot(bakery, fs.readFileSync(path.join(OUT, 'single', cardId, `${n}.html`), 'utf8'));
          const okA = pixelDiff(truth.get(n), la).differ === 0, okB = pixelDiff(truth.get(n), lb).differ === 0;
          if (okA) judge.batch4Match++;
          if (okB) judge.singleMatch++;
          if (okA && !okB) judge.regressions.push(n);
        }
        row.versusLive = judge;
        // 逐批自己在这些帧里大半都与活渲对不上(预渲染间里本来就不确定的卡,如按 setInterval 走的 E4b 探针卡 `probe-typewriter`):
        // 拿它当参照没有意义,只记不判
        judge.referenceUnstable = judge.batch4Match * 2 < row.differFrames.length;
        if (judge.referenceUnstable) notes.push(`${cardId}:逐批在不同的 ${row.differFrames.length} 帧里只有 ${judge.batch4Match} 帧与活渲一致:逐批当不了参照(要么逐批本身就错,如 mu-word-rotate;要么这张卡在预渲染间里本来就不确定,如按 setInterval 走的探针卡),只记不判`);
        else if (judge.regressions.length) fails.push(`${cardId}:顺推在逐批与活渲一致的帧上对不上 ${judge.regressions.length} 帧(${judge.regressions.slice(0, 8).join(',')})`);
      }
      if (!row.singlePass && !(ca.capabilities?.canvasHeavy)) fails.push(`${cardId}:新行为没有走顺推`);
      log(`${cardId.padEnd(24)} 字节同 ${row.bytesSame} 只差will-change ${row.sameIgnoringWillChange} 像素同 ${row.pixelSame} 像素不同 ${row.pixelDiffer} 缺 ${row.missing}${row.versusLive ? `(不同的帧里与顺序活渲一致:逐批 ${row.versusLive.batch4Match}、顺推 ${row.versusLive.singleMatch}、顺推退步 ${row.versusLive.regressions.length})` : ''}  batch4 ${row.batch4.join('/')} ms  顺推 ${row.single.join('/')} ms`);
    }
  } finally {
    await bakery.close().catch(() => {});
  }
} catch (e) {
  fails.push(`探针异常:${String(e?.stack ?? e).slice(0, 1200)}`);
}
out.fails = fails;
out.notes = notes;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
