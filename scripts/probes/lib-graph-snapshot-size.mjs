/**
 * Measure full-screen snapshot size for media effect cards (chunk N, Section 7 "A Risk of Media
 * Effect Card Tasks" in `docs/plan/online-card-exec-contract.md`).
 * A media effect card's visual is a canvas; in snapshots it is replaced by `rasterizeCanvas` with
 * `<img src="data:image/png;base64,…">` (`src/render/snapshot/rasterizeCanvas.ts`).
 * Here, render several typical contents in real Chrome (1920×1080, stage default aspect ratio),
 * take `toDataURL('image/png')`, and measure bytes as formatted in snapshots:
 *   - Solid background with a few solid rectangles and text (lower bound);
 *   - Vector-style visuals (gradients + color blocks + circles): the "composite, color grade, shape
 *     overlay" category of media effect cards;
 *   - Gradient plus large-area detail (simulating filters applied over flatter media);
 *   - Photographic visuals (multi-layer noise overlay, simulating video frames): appearance when
 *     media effect cards receive a video input source.
 * Compare against M7 limits: DOM card 300 KB, canvas bitmap 1 MB (`DOM_SNAPSHOT_LIMIT` /
 * `CANVAS_SNAPSHOT_LIMIT` in `server/snapshot-store.mjs`).
 *
 *   node scripts/probes/lib-graph-snapshot-size.mjs [--width 1920] [--height 1080]
 * Outputs a single JSON line.
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { DOM_SNAPSHOT_LIMIT, CANVAS_SNAPSHOT_LIMIT } from '../../server/snapshot-store.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? Number(argv[argv.indexOf(n) + 1]) : d);
const W = arg('--width', 1920);
const H = arg('--height', 1080);

const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars'] });
try {
  const page = await browser.newPage();
  const sizes = await page.evaluate(async (W, H) => {
    const make = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const measure = (c) => {
      const url = c.toDataURL('image/png');
      // Size of <img> in snapshots: data URL itself plus short tag and style snippet (a few hundred bytes)
      return { dataUrlBytes: url.length, snapshotBytes: url.length + 400 };
    };
    const out = {};
    {
      // Lower bound: solid background + several solid rectangles and text (no gradients, no antialiased
      // large-area transitions)
      const c = make(); const g = c.getContext('2d');
      g.fillStyle = '#101820'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#ffcc33'; g.fillRect(W * 0.1, H * 0.7, W * 0.3, H * 0.15);
      g.fillStyle = '#ffffff'; g.fillRect(W * 0.55, H * 0.2, W * 0.3, H * 0.4);
      g.font = '96px sans-serif'; g.fillText('PromptCut', W * 0.1, H * 0.3);
      out.flat = measure(c);
    }
    {
      const c = make(); const g = c.getContext('2d');
      const lg = g.createLinearGradient(0, 0, W, H); lg.addColorStop(0, '#0b1020'); lg.addColorStop(1, '#6c2bd9');
      g.fillStyle = lg; g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.arc(W * 0.5, H * 0.5, H * 0.3, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffcc33'; g.fillRect(W * 0.1, H * 0.7, W * 0.3, H * 0.15);
      out.vector = measure(c);
    }
    {
      const c = make(); const g = c.getContext('2d');
      for (let y = 0; y < H; y += 8) { const lg = g.createLinearGradient(0, y, W, y); lg.addColorStop(0, `hsl(${(y / H) * 360},60%,40%)`); lg.addColorStop(1, `hsl(${(y / H) * 360 + 90},70%,55%)`); g.fillStyle = lg; g.fillRect(0, y, W, 8); }
      for (let i = 0; i < 400; i++) { g.fillStyle = `hsla(${rnd() * 360},70%,60%,0.35)`; g.beginPath(); g.arc(rnd() * W, rnd() * H, 20 + rnd() * 120, 0, Math.PI * 2); g.fill(); }
      out.gradientDetail = measure(c);
    }
    {
      // Photographic look: multi-layer low-frequency noise (bilinear upscaling) overlay + one layer of fine grain
      const c = make(); const g = c.getContext('2d');
      const img = g.createImageData(W, H);
      const layers = [[8, 0.5], [32, 0.25], [128, 0.12], [512, 0.06]].map(([n, amp]) => {
        const gw = Math.ceil(W / n) + 2, gh = Math.ceil(H / n) + 2; const grid = new Float32Array(gw * gh * 3);
        for (let i = 0; i < grid.length; i++) grid[i] = rnd();
        return { n, amp, gw, gh, grid };
      });
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let r = 0, gg = 0, b = 0;
        for (const L of layers) {
          const fx = x / L.n, fy = y / L.n; const x0 = fx | 0, y0 = fy | 0; const tx = fx - x0, ty = fy - y0;
          for (let ch = 0; ch < 3; ch++) {
            const a = L.grid[(y0 * L.gw + x0) * 3 + ch], b2 = L.grid[(y0 * L.gw + x0 + 1) * 3 + ch], c2 = L.grid[((y0 + 1) * L.gw + x0) * 3 + ch], d = L.grid[((y0 + 1) * L.gw + x0 + 1) * 3 + ch];
            const v = (a * (1 - tx) + b2 * tx) * (1 - ty) + (c2 * (1 - tx) + d * tx) * ty;
            if (ch === 0) r += v * L.amp; else if (ch === 1) gg += v * L.amp; else b += v * L.amp;
          }
        }
        const grain = (rnd() - 0.5) * 0.04;
        const i = (y * W + x) * 4;
        img.data[i] = Math.max(0, Math.min(255, (r + grain) * 255 * 1.1));
        img.data[i + 1] = Math.max(0, Math.min(255, (gg + grain) * 255 * 1.1));
        img.data[i + 2] = Math.max(0, Math.min(255, (b + grain) * 255 * 1.1));
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      out.photoLike = measure(c);
    }
    return out;
  }, W, H);
  const kb = (n) => Math.round(n / 1024);
  const rows = Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, { snapshotKB: kb(v.snapshotBytes), overDom300KB: v.snapshotBytes > DOM_SNAPSHOT_LIMIT, overCanvas1MB: v.snapshotBytes > CANVAS_SNAPSHOT_LIMIT }]));
  console.log(JSON.stringify({ width: W, height: H, limits: { domKB: kb(DOM_SNAPSHOT_LIMIT), canvasKB: kb(CANVAS_SNAPSHOT_LIMIT) }, sizes: rows }));
} finally {
  await browser.close();
}
