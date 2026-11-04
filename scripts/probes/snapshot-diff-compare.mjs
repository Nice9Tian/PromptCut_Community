/**
 * Visual correctness acceptance check for differential style inlining (draft A2(8) acceptance
 * check (ii) second half):
 * **Pixel-by-pixel bitmap comparison of `captureSnapshot` before and after differential style
 * inlining**.
 *
 *   node scripts/probes/snapshot-diff-compare.mjs [--origin <dev server>]
 *        [--cards lottie-bodymovin,growth-curve,odometer,scene-3d] [--frames 12,45]
 *        [--out out/snapshot-diff] [--dump-html]
 *
 * # How "before and after" is achieved
 *
 * No second tree, no second server: produce two copies of HTML from **the same page at the exact
 * same moment**:
 *   - "After" = current `window.__pcCreateSnapshot()` (`src/render/createSnapshot.ts` +
 *     differential inlining from `snapshot/inlineStyles.ts`);
 *   - "Before" = the b5c65dc algorithm cloned in `installLegacyPass` below (inlines the full
 *     `getComputedStyle` element by element). The clone is missing only one thing:
 *     `data-pc-painted-box` (entity box from A2(4)): it is **metadata** used by consumers for
 *     coordinate conversion and does not participate in rasterization; omitting it does not affect
 *     pixels in this comparison.
 *
 * Both HTML copies go through `captureSnapshot` once (the same rasterization path as export,
 * `see_frames`, and `rasterPrefix`), compared per channel. Criterion: **byte-for-byte identical**;
 * report max channel difference and differing pixel count on mismatch (criteria reference the
 * replay residuals recorded in `scripts/replay-frames.mjs:19-21`: replays are deterministic across
 * runs, so both copies taking the replay path should be byte-for-byte identical; any difference
 * means differential inlining actually altered the visual output).
 *
 * # Why "run two passes then compare" does not work
 *
 * In practice they are not comparable: in the second pass on the same page, `growth-curve`'s
 * `opacity` stays at 0 and `stroke-dasharray` stays at `0px,1px` (the animation did not advance at
 * all), whereas the first pass was 0.4 / `0.033px,1px`. That is item 1 "warmup frame mismatch" in
 * `docs/guides/compare-pitfalls.md`, not caused by differential inlining. Wrapping a layer bypasses
 * the whole issue.
 *
 * Order also matters: **the legacy algorithm runs first**: when the new `inlineDOMStyles` measures
 * the baseline, it temporarily attaches a probe container to the scene root (detached after
 * measuring); reading with the legacy algorithm before that ensures both see the same clean tree.
 *
 * Requires a dev server (checks `PC_STAGE_TEST_URL` if `--origin` is omitted, and if still missing,
 * hits `dev-test` in `.claude/launch.json`): `FramePipeline`'s bakery hits its export page.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
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
 * Wrap around `window.__pcCreateSnapshot`: in the **same call and at the exact same moment**, first
 * generate one copy using the b5c65dc algorithm (stored into `window.__pcLegacySnapshots`), then
 * call the current implementation as-is and return it to `bakeFrames`.
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
      // Keep only the frames to compare: a legacy snapshot for one odometer frame is 2.2 MB; hoarding all
      // 34 frames to serialize back to Node at once times out Runtime.callFunctionOn (verified).
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
    const after = await snapshotsOf(bakery, frames, root);       // Current createSnapshot
    // The copy left by the legacy algorithm in the same pass, converted back to a frame number by __pcExportMs
    const legacyList = await bakery.page.evaluate(() => window.__pcLegacySnapshots);
    const before = new Map();
    for (const item of legacyList) before.set(Math.round((item.ms / 1000) * fps), { html: item.html, controls: [{ html: item.controlHtml }] });

    for (const n of frames) {
      const a = before.get(n), b = after.get(n);
      if (!a || !b) { rows.push({ cardId, frame: n, note: `No snapshot obtained (old ${before.has(n)} / new ${after.has(n)})` }); bad++; continue; }
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
      console.log(`${cardId} f${n}: ${cmp.equal ? 'byte-for-byte identical' : `${cmp.pixels}/${cmp.total} pixels differ, max channel difference ${cmp.maxDelta}`}`
        + `  scene ${row.sceneBeforeKB} → ${row.sceneAfterKB} KB, control ${row.controlBeforeKB} → ${row.controlAfterKB} KB`);
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
console.log(`\nResult written to ${path.join(outDir, 'snapshot-diff-compare.json')}`);
console.log(bad ? `\n${bad} items failed.` : '\nAll byte-identical.');
process.exit(bad ? 1 : 0);
