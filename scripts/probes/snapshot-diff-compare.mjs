/**
 * 差异样式内联的画面正确性验收（底稿 A2(8) 验收 (ii) 后半句）：
 * **差异样式内联前后的 `captureSnapshot` 位图逐像素比对**。
 *
 *   node scripts/probes/snapshot-diff-compare.mjs [--origin <dev server>]
 *        [--cards lottie-bodymovin,growth-curve,odometer,scene-3d] [--frames 12,45]
 *        [--out out/snapshot-diff] [--dump-html]
 *
 * # 怎么做到「前后」
 *
 * 不开第二棵树、不起第二台服务器 —— **同一个页面、同一个时刻**出两份 HTML：
 *   - 「后」= 现在的 `window.__pcCreateSnapshot()`（`src/render/createSnapshot.ts` +
 *     `snapshot/inlineStyles.ts` 的差异内联）；
 *   - 「前」= 下面 `installLegacyPass` 里复刻的 b5c65dc 版算法（逐元素把 `getComputedStyle`
 *     整份内联）。复刻版只少一样：`data-pc-painted-box`（A2(4) 的实体框）——
 *     它是给消费方换算用的**元数据**，不参与栅格化，漏了不影响这一次比对的像素。
 *
 * 两份 HTML 各走一次 `captureSnapshot`（和导出、`see_frames`、`rasterPrefix` 同一条栅格化路），
 * 逐通道比。判据：**逐字节相同**；不同就报最大通道差和不同像素数
 * （口径参考 `scripts/replay-frames.mjs:19-21` 记的重放残差：重放与重放之间是确定的，
 *  所以这里两份都走重放路，应当逐字节相同；有差就是差异内联真的改了画面）。
 *
 * # 为什么不能「跑两趟再比」
 *
 * 实测不可比 —— 同一页第二趟里 `growth-curve` 的 `opacity` 停在 0、`stroke-dasharray` 停在
 * `0px,1px`（动画根本没推），第一趟是 0.4 / `0.033px,1px`。那是
 * `docs/guides/compare-pitfalls.md` 第一条「预热错帧」，不是差异内联造成的。套一层就绕开了整件事。
 *
 * 顺序也要紧：**旧算法先跑** —— 新的 `inlineDOMStyles` 量基线时会往场景根临时挂一个探针容器
 * （量完就摘），旧算法在那之前读完，两边看到的是同一棵干净的树。
 *
 * 需要一台 dev server（不带 `--origin` 就看 `PC_STAGE_TEST_URL`，再没有就打 `.claude/launch.json` 的 `dev-test`）：`FramePipeline` 的 bakery 打的是它的导出页。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { captureSnapshot } from '../../server/bakery/capture-snapshot.mjs';
import { devOrigin } from './probe-connect.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback; };

const origin = devOrigin(argv);
const cards = (flag('--cards') || 'lottie-bodymovin,growth-curve,odometer,scene-3d').split(',').map((s) => s.trim()).filter(Boolean);
const frames = (flag('--frames') || '12,45').split(',').map(Number).filter(Number.isFinite);
const outDir = path.resolve(flag('--out', 'out/snapshot-diff'));
const fps = 30;
const lenSec = 4;

/**
 * 在 `window.__pcCreateSnapshot` 外面套一层:**同一次调用、同一个时刻**先用 b5c65dc 的算法
 * 生成一份(记进 `window.__pcLegacySnapshots`),再原样调现在这份返回给 `bakeFrames`。
 */
async function installLegacyPass(page, wantFrames, framesPerSec) {
  await page.evaluate(({ wanted, fps }) => {
    const current = window.__pcCreateSnapshot;
    const keep = new Set(wanted);
    window.__pcLegacySnapshots = [];
    const legacy = () => {
      const root = document.querySelector('[data-pc-scene]');
      if (!root) return { html: '', lossy: 0, controls: [] };
      const clone = root.cloneNode(true);
      const orig = [root, ...root.querySelectorAll('*')];
      const copy = [clone, ...clone.querySelectorAll('*')];
      let lossy = 0;
      for (let i = 0; i < orig.length; i++) {
        const from = orig[i], to = copy[i];
        const cs = getComputedStyle(from);
        let s = '';
        for (let k = 0; k < cs.length; k++) { const q = cs.item(k); s += q + ':' + cs.getPropertyValue(q) + ';'; }
        s += 'animation:none !important;transition:none !important;';
        to.setAttribute('style', s);
        if (from.dataset && from.dataset.pcMediaSrc) {
          to.removeAttribute('src');
          if (from.tagName === 'VIDEO') to.setAttribute('preload', 'none');
          to.style.visibility = 'hidden';
        }
        if (from.tagName === 'CANVAS') {
          let src = null;
          try { src = from.toDataURL('image/png'); } catch { src = null; }
          if (src && src.length > 22) {
            const img = document.createElement('img');
            img.setAttribute('style', s);
            img.setAttribute('width', String(from.width));
            img.setAttribute('height', String(from.height));
            img.src = src;
            to.replaceWith(img);
          } else lossy++;
        }
      }
      let html = clone.outerHTML;
      const ids = new Set([...root.querySelectorAll('[id]')].map((e) => e.id).concat(root.id ? [root.id] : []));
      const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const id of ids) {
        const e = esc(id);
        html = html
          .replace(new RegExp(`(\\sid=")${e}(")`, 'g'), `$1${id}__r$2`)
          .replace(new RegExp(`(url\\((?:&quot;|["'])?[^)"'&]*#)${e}((?:&quot;|["'])?\\))`, 'g'), `$1${id}__r$2`)
          .replace(new RegExp(`((?:xlink:)?href="#)${e}(")`, 'g'), `$1${id}__r$2`);
      }
      const controls = [...clone.querySelectorAll('[data-pc-clip][data-pc-local-frame]:not([data-pc-media])')].map((el) => {
        const inner = el.cloneNode(true);
        inner.querySelectorAll('[data-pc-proxy-plane]').forEach((plane) => plane.remove());
        return { id: el.getAttribute('data-pc-clip') || '', frame: Number(el.getAttribute('data-pc-local-frame')), html: inner.innerHTML };
      });
      return { html, lossy, controls };
    };
    window.__pcCreateSnapshot = () => {
      // 只留要比的那几帧:odometer 一帧的旧快照 2.2 MB,34 帧全攒下来再一次性
      // 序列化回 Node 会把 Runtime.callFunctionOn 拖到超时(实测)。
      const frame = Math.round((window.__pcExportMs / 1000) * fps);
      if (keep.has(frame)) {
        const old = legacy();
        window.__pcLegacySnapshots.push({ ms: window.__pcExportMs, html: old.html, controlHtml: old.controls[0] ? old.controls[0].html : '' });
      }
      return current();
    };
  }, { wanted: wantFrames, fps: framesPerSec });
}

const projectOf = (cardId) => ({
  id: 'snapshot-diff', name: 'snapshot-diff', width: 1280, height: 720, fps, duration: lenSec,
  themeId: 'midnight', media: [],
  tracks: [{ id: 't0', clips: [{ id: 'c0', cardId, start: 0, end: lenSec, params: {} }] }],
});

async function snapshotsOf(bakery, frameList, root) {
  const got = new Map();
  await bakeFrames(bakery, { out: root, frames: `${Math.min(...frameList)}-${Math.max(...frameList)}`,
    snapshotOnly: true, onSnapshot: (n, html, controls) => got.set(n, { html, controls }) });
  return got;
}

function comparePng(a, b) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return { equal: false, size: `${pa.width}x${pa.height} vs ${pb.width}x${pb.height}` };
  let maxDelta = 0, pixels = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(pa.data[i + c] - pb.data[i + c]));
    if (d) { pixels++; maxDelta = Math.max(maxDelta, d); }
  }
  return { equal: pixels === 0, pixels, maxDelta, total: pa.width * pa.height };
}

const kb = (s) => +(Buffer.byteLength(s || '', 'utf8') / 1024).toFixed(1);

await fs.mkdir(outDir, { recursive: true });
const rows = [];
let bad = 0;
for (const cardId of cards) {
  const project = projectOf(cardId);
  const root = path.join(outDir, cardId);
  const service = new FramePipeline({ root, origin: () => origin });
  let bakery;
  try {
    bakery = await service.bakery(project);
    await installLegacyPass(bakery.page, frames, fps);
    const after = await snapshotsOf(bakery, frames, root);       // 现在的 createSnapshot
    // 同一趟里旧算法留下的那一份,按 __pcExportMs 折回帧号
    const legacyList = await bakery.page.evaluate(() => window.__pcLegacySnapshots);
    const before = new Map();
    for (const item of legacyList) before.set(Math.round((item.ms / 1000) * fps), { html: item.html, controls: [{ html: item.controlHtml }] });

    for (const n of frames) {
      const a = before.get(n), b = after.get(n);
      if (!a || !b) { rows.push({ cardId, frame: n, note: `没拿到快照(旧 ${before.has(n)} / 新 ${after.has(n)})` }); bad++; continue; }
      const pngBefore = await captureSnapshot(bakery, a.html);
      const pngAfter = await captureSnapshot(bakery, b.html);
      await fs.writeFile(path.join(outDir, `${cardId}-${n}-before.png`), pngBefore);
      await fs.writeFile(path.join(outDir, `${cardId}-${n}-after.png`), pngAfter);
      if (argv.includes('--dump-html')) {
        await fs.writeFile(path.join(outDir, `${cardId}-${n}-before.html`), a.html, 'utf8');
        await fs.writeFile(path.join(outDir, `${cardId}-${n}-after.html`), b.html, 'utf8');
      }
      const cmp = comparePng(pngBefore, pngAfter);
      const row = { cardId, frame: n, ...cmp,
        sceneBeforeKB: kb(a.html), sceneAfterKB: kb(b.html),
        controlBeforeKB: kb(a.controls?.[0]?.html), controlAfterKB: kb(b.controls?.[0]?.html) };
      rows.push(row);
      if (!cmp.equal) bad++;
      console.log(`${cardId} f${n}: ${cmp.equal ? '逐字节相同' : `不同 ${cmp.pixels}/${cmp.total} 像素,最大通道差 ${cmp.maxDelta}`}`
        + `  场景 ${row.sceneBeforeKB} → ${row.sceneAfterKB} KB,control ${row.controlBeforeKB} → ${row.controlAfterKB} KB`);
    }
  } catch (err) {
    console.error(`${cardId}: ${err && err.stack || err}`);
    rows.push({ cardId, error: String(err && err.message || err) });
    bad++;
  } finally {
    await bakery?.close();
    await service.close();
  }
}

await fs.writeFile(path.join(outDir, 'snapshot-diff-compare.json'), JSON.stringify({ origin, cards, frames, rows }, null, 2), 'utf8');
console.log(`\n结果写到 ${path.join(outDir, 'snapshot-diff-compare.json')}`);
console.log(bad ? `\n有 ${bad} 项不通过。` : '\n全部逐字节相同。');
process.exit(bad ? 1 : 0);
