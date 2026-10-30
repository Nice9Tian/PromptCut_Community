/**
 * 探针:当场算一帧 Lottie 要多久,以及按成本测量现成的口径判不判重。
 * 出处:`docs/plan/render-refactor-task.md`「癸」的「当场算一帧 Lottie 要多久没有量过。量出来,写进 `render-standard.md` 的 Lottie 一节」。
 *
 *   node scripts/probes/lottie-cost-probe.mjs [--port 27260] [--only stage,export] [--sizes 960x540,1920x1080]
 *        [--cards demo,adrock,bodymovin,gatin,happy2016,navidad] [--json <文件>] [--no-baseline]
 *
 * 量的是真的舞台,不是单独挂一份播放库:起一台隔离的编辑器(`preview-stop-lib.mjs`),在编辑台里用 store 的 actions 建只有一张卡的项目
 * (`demo` 是通用 Lottie 卡缺省参数里的演示动画,其余五个是自带素材的封装卡;另有一份「空 Lottie」,通用卡放一段没有任何图层的动画,
 * 量出来的是舞台自己一拍的底,拿来对照,看卡本身多花多少),片段长度取素材本身的长度,帧率 30。每个素材 × 每个分辨率各量:
 *
 *   stage    桌面开发服务器的预览(可见舞台,双舞台那一台)。在可见舞台页里调产品自己的 `setTime`(`window.__pcStage`,
 *            舞台 RPC 的同一个函数,拖动时间轴、播放时父页调的就是它),全长逐帧:
 *              顺着推   第 0、1、2……帧连着拨(往前小于 0.5 秒,走舞台的「连续」那一支)
 *              直接跳   全长的帧号按固定种子洗牌,一帧一帧乱序拨(走「跳转」那一支)
 *            每一帧记两个数:`sync` = 调 `setTime` 到它返回(React 提交完、Lottie 跳完帧、DOM 已是这一帧);
 *            `paint` = 再等下一次 rAF 和随后一个宏任务(浏览器把这一帧画完;下限是无头浏览器出帧的节拍,看和「空 Lottie」的差)。
 *   export   导出页(`FramePipeline.bakery` + `bakeFrames` / `createStepper`,和真的导出同一条取帧的路),三项:
 *              整帧   `bakeFrames` 全长顺着导,每帧完成时刻的间隔 = 导出一帧(含推一拍、截图,不写盘)
 *              拨时   `createStepper` 的一步(下发时间、排空、推一拍、钉动画、等素材),不截图;顺着推、直接跳各一遍
 *              页内   `window.__pcSetT` 在页面里同步跑的耗时(React 提交 + Lottie 跳帧,不含与 Node 来回、不含出帧);顺着推、直接跳各一遍
 *   cost     成本测量现成的口径:编辑器自己(`src/editor/probeRunner.ts` 的 `probeCardOnce`)在后台舞台上给每张卡测一趟——direct 的卡
 *            在 16 个固定随机抽的帧上各 `setTime(t, { probe: true })` 取 `stepMs`,第 90 百分位当这张卡的 `stepMs`;判重式 `stepMs × COST_SCALE > 0.7 × 一拍`。
 *            这里读它写下的成本记录,和分派表在中间一个位置上的轻重(`__pcStagePipelineAt`),不另写一份测量。
 *
 * 数字的统计:中位数、第 90 百分位、最大(毫秒)。耗时只记录,不判过不过;只有量不到数、页面报错、成本记录没落定才进 `fails`(退出码 1)。
 * 输出:过程写 stderr;最后一行 stdout 是 JSON `{ ok, fails, rows }`。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,也不写公共的 port.json
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { flagArg } from './probe-connect.mjs';
import { costRecordOf, openEditorPage, sleep, startIsolatedEditor, waitFor } from './preview-stop-lib.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { bakeFrames, createStepper } from '../../server/bakery/bake.mjs';

const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '27260', args));
if (!Number.isInteger(PORT) || PORT < 20000) throw new Error('--port 要用 20000 以上的端口');
const ONLY = (flagArg('only', null, args) || 'stage,export').split(',').map((s) => s.trim()).filter(Boolean);
const SIZES = (flagArg('sizes', null, args) || '960x540,1920x1080').split(',').map((s) => { const [w, h] = s.split('x').map(Number); return { w, h }; });
const JSON_OUT = flagArg('json', null, args);
const NO_BASELINE = args.includes('--no-baseline');
const RUN = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), `pc-lottie-cost-${RUN}`);
const FPS = 30;
const EMPTY_JSON = JSON.stringify({ v: '5.7.4', fr: 30, ip: 0, op: 60, w: 1920, h: 1080, nm: 'empty', ddd: 0, assets: [], layers: [] });
const ALL_CARDS = [
  { name: 'demo', cardId: 'lottie', seconds: 2, params: {} },
  { name: 'adrock', cardId: 'lottie-adrock', seconds: 13.07, params: {} },
  { name: 'bodymovin', cardId: 'lottie-bodymovin', seconds: 3.43, params: {} },
  { name: 'gatin', cardId: 'lottie-gatin', seconds: 3.2, params: {} },
  { name: 'happy2016', cardId: 'lottie-happy2016', seconds: 3.3, params: {} },
  { name: 'navidad', cardId: 'lottie-navidad', seconds: 5, params: {} },
];
const WANT = (flagArg('cards', null, args) || ALL_CARDS.map((c) => c.name).join(',')).split(',').map((s) => s.trim());
const CARDS = [
  ...(NO_BASELINE ? [] : [{ name: 'empty', cardId: 'lottie', seconds: 2, params: { json: EMPTY_JSON } }]),
  ...ALL_CARDS.filter((c) => WANT.includes(c.name)),
];

const fails = [];
const say = (line) => console.error(line);
const check = (cond, label, extra) => { if (!cond) { const msg = label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400)); fails.push(msg); say(`FAIL ${msg}`); } return !!cond; };

const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null;
const stats = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const r = (x) => (x === null ? null : +x.toFixed(2));
  return { n: v.length, med: r(quantile(v, 0.5)), p90: r(quantile(v, 0.9)), max: r(v.length ? v[v.length - 1] : null) };
};
/** 固定种子洗牌(mulberry32),同一台机器上复跑抽到同一个顺序 */
function shuffled(n, seed) {
  const a = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * 可见舞台页里跑的:按给定的帧号次序一帧一帧拨,每帧记 sync / paint。
 * 舞台页把时钟、计时器、rAF 都换成了可钉的虚拟版本(`src/kernel/clock.ts`),所以这里用它留下的真版本:
 * `__pcRealNow`、`__pcRealRaf`、`__pcRealSetTimeout`。
 */
const STAGE_PASS = String.raw`(async (order, fps) => {
  const now = window.__pcRealNow ?? (() => performance.now());
  const raf = window.__pcRealRaf ?? ((cb) => requestAnimationFrame(cb));
  const later = window.__pcRealSetTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const sync = [], paint = [];
  for (const f of order) {
    const a = now();
    await window.__pcStage.setTime(f / fps);
    const b = now();
    await new Promise((r) => raf(() => r()));
    await new Promise((r) => later(() => r(), 0));
    const c = now();
    sync.push(b - a); paint.push(c - a);
  }
  return { sync, paint };
})`;

const rows = [];
let editor = null, browser = null;
const started = Date.now();
try {
  await fs.mkdir(WORK, { recursive: true });
  editor = await startIsolatedEditor({ port: PORT, work: WORK });
  const origin = editor.origin.replace(/\/+$/, '');
  say(`编辑器 ${origin};案例 ${CARDS.map((c) => c.name).join(',')};分辨率 ${SIZES.map((s) => `${s.w}x${s.h}`).join(',')};项目 ${ONLY.join(',')}`);
  const ed = await openEditorPage(origin);
  browser = ed.browser;
  const { page, store, frontFrame, parentDiag, pageErrors } = ed;

  for (const size of SIZES) {
    for (const card of CARDS) {
      const tag = `${card.name}@${size.w}x${size.h}`;
      const total = Math.floor(card.seconds * FPS);
      const row = { card: card.name, cardId: card.cardId, size: `${size.w}x${size.h}`, frames: total };
      rows.push(row);
      say(`── ${tag}(${total} 帧)`);
      const clipId = await store(`actions.newProject(args[0]);
        actions.setProjectMeta({ width: args[1].w, height: args[1].h });
        const clip = actions.addCardClip(args[2].cardId, 0, { duration: args[2].seconds, params: args[2].params });
        actions.select([]); actions.pause(); actions.seek(0);
        return clip ? clip.id : null;`, `lottie-cost-${RUN}-${tag}`, size, card);
      if (!check(!!clipId, `${tag}:片段没建成`)) continue;
      const stored = await store('return JSON.parse(JSON.stringify(getState().project));');
      check(stored.width === size.w && stored.height === size.h, `${tag}:项目分辨率没设成 ${size.w}x${size.h}`, [stored.width, stored.height]);

      // 等成本记录落定(编辑器自己的测量趟),再等前台舞台回到这张卡的精确活渲
      const cost = await waitFor(async () => {
        const rec = await costRecordOf(page, clipId);
        return rec && typeof rec.stepMs === 'number' ? rec : null;
      }, 120000, 500);
      await sleep(1500);
      row.cost = cost ? { stepMs: cost.stepMs, stepMaxMs: cost.stepMaxMs, kind: cost.kind, capped: !!cost.capped, samples: cost.samples ?? null, device: cost.device } : null;
      check(!!cost, `${tag}:120 秒内没有成本记录`);
      const budget = (1000 / FPS) * 0.7;
      row.budgetMs = +budget.toFixed(2);

      if (ONLY.includes('stage')) {
        const f = await waitFor(async () => {
          const pd = await parentDiag();
          if (!pd || pd.swapInFlight) return null;
          const fr = await frontFrame();
          if (!fr) return null;
          const ok = await fr.evaluate(() => !!window.__pcStage && !!window.__pcStageDiag && window.__pcStageDiag().role === 'front').catch(() => false);
          return ok ? fr : null;
        }, 60000, 300);
        if (!check(!!f, `${tag}:前台舞台没就绪`)) continue;
        row.pipeline = await f.evaluate((id, sec) => (typeof window.__pcStagePipelineAt === 'function' ? window.__pcStagePipelineAt(id, sec) : null), clipId, card.seconds / 2).catch(() => null);
        const warm = Array.from({ length: Math.min(30, total) }, (_, i) => i);
        await f.evaluate(`${STAGE_PASS}(${JSON.stringify(warm)}, ${FPS})`);
        const seq = await f.evaluate(`${STAGE_PASS}(${JSON.stringify(Array.from({ length: total }, (_, i) => i))}, ${FPS})`);
        await f.evaluate((fps) => window.__pcStage.setTime(0), FPS);
        const jump = await f.evaluate(`${STAGE_PASS}(${JSON.stringify(shuffled(total, 20261014))}, ${FPS})`);
        row.stage = { seq: { sync: stats(seq.sync), paint: stats(seq.paint) }, jump: { sync: stats(jump.sync), paint: stats(jump.paint) } };
        check(row.stage.seq.sync.n === total && row.stage.jump.sync.n === total, `${tag}:舞台没量满 ${total} 帧`, [row.stage.seq.sync.n, row.stage.jump.sync.n]);
        say(`  舞台 顺推 sync ${JSON.stringify(row.stage.seq.sync)} paint ${JSON.stringify(row.stage.seq.paint)}`);
        say(`  舞台 跳  sync ${JSON.stringify(row.stage.jump.sync)} paint ${JSON.stringify(row.stage.jump.paint)}`);
      }

      if (ONLY.includes('export')) {
        const project = { ...stored, fps: FPS, duration: card.seconds };
        const service = new FramePipeline({ root: path.join(WORK, `lib-${card.name}-${size.w}`), origin: () => origin, dataRoot: WORK });
        let bakery = null;
        try {
          bakery = await service.bakery(project);
          const stamps = [];
          await bakeFrames(bakery, { out: path.join(WORK, `frames-${card.name}-${size.w}`), frames: `0-${total - 1}`, writeFrames: false, quiet: true,
            onFrame: async (i) => { stamps[i] = performance.now(); } });
          const full = []; for (let i = 1; i < stamps.length; i++) full.push(stamps[i] - stamps[i - 1]);
          const step = createStepper(bakery, { fps: FPS });
          const timed = async (order) => { const out = []; for (const i of order) { const a = performance.now(); await step(i, false); out.push(performance.now() - a); } return out; };
          // 导出页把 performance.now 钉成了导出毫秒(kernel/exportClock.ts);performance.mark 的时间戳走原生时钟,拿它量真耗时
          const inPage = (order) => bakery.page.evaluate((o, fps) => { const real = () => performance.mark('m').startTime; const out = []; for (const f of o) { const a = real(); window.__pcSetT(f / fps, f / fps); out.push(real() - a); } performance.clearMarks(); return out; }, order, FPS);
          const seqOrder = Array.from({ length: total }, (_, i) => i);
          const jumpOrder = shuffled(total, 20261014);
          const stepSeq = await timed(seqOrder);
          const stepJump = await timed(jumpOrder);
          const pageSeq = await inPage(seqOrder);
          const pageJump = await inPage(jumpOrder);
          row.export = { full: stats(full), stepSeq: stats(stepSeq), stepJump: stats(stepJump), pageSeq: stats(pageSeq), pageJump: stats(pageJump) };
          check(row.export.full.n === total - 1, `${tag}:导出没量满`, row.export.full.n);
          say(`  导出 整帧 ${JSON.stringify(row.export.full)} 拨时 顺 ${JSON.stringify(row.export.stepSeq)} 跳 ${JSON.stringify(row.export.stepJump)}`);
          say(`  导出 页内 顺 ${JSON.stringify(row.export.pageSeq)} 跳 ${JSON.stringify(row.export.pageJump)}`);
        } finally { await bakery?.close().catch(() => {}); await service.close().catch(() => {}); }
      }
      say(`  成本记录 ${JSON.stringify(row.cost)};分派表此刻 ${row.pipeline}`);
    }
  }
  check(pageErrors.length === 0, '编辑台页面没有报错', pageErrors.slice(0, 3));
} catch (e) {
  fails.push(`脚本出错:${String(e?.stack || e).slice(0, 600)}`);
  say(`ERROR ${e?.stack || e}`);
} finally {
  await browser?.close().catch(() => {});
  try { await editor?.stop?.(); } catch { /* 收摊 */ }
}
const summary = { ok: fails.length === 0, fails, seconds: +((Date.now() - started) / 1000).toFixed(1), machine: { cpu: os.cpus()[0]?.model, logical: os.cpus().length, node: process.version }, rows };
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
process.exit(summary.ok ? 0 : 1);
