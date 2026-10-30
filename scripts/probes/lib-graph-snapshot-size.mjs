/**
 * 量素材效果卡整屏快照的体积(块 N,`docs/plan/online-card-exec-contract.md` 第 7 节「素材效果卡任务的一个风险」)。
 * 素材效果卡的画面是一块画布;快照里它被 `rasterizeCanvas` 换成 `<img src="data:image/png;base64,…">`(`src/render/snapshot/rasterizeCanvas.ts`)。
 * 这里在真 Chrome 里画几种典型内容(1920×1080,舞台缺省画幅),取 `toDataURL('image/png')`,按快照里的写法量字节:
 *   - 纯色底加几块纯色矩形与文字(下界);
 *   - 矢量感画面(渐变 + 色块 + 圆):素材效果卡里「合成、调色、叠图形」那一类;
 *   - 渐变加大面积细节(模拟滤镜加在较平的素材上);
 *   - 照片感画面(多层噪声叠加,模拟视频帧):素材效果卡接视频输入源时的样子。
 * 与 M7 的上限比:DOM 卡 300 KB、画布位图 1 MB(`server/snapshot-store.mjs` 的 `DOM_SNAPSHOT_LIMIT` / `CANVAS_SNAPSHOT_LIMIT`)。
 *
 *   node scripts/probes/lib-graph-snapshot-size.mjs [--width 1920] [--height 1080]
 * 输出一行 JSON。
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
      // 快照里 <img> 的大小:data 地址本身加一小段标签与样式(几百字节)
      return { dataUrlBytes: url.length, snapshotBytes: url.length + 400 };
    };
    const out = {};
    {
      // 下界:纯色底 + 几块纯色矩形与文字(没有渐变、没有抗锯齿的大面积过渡)
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
      // 照片感:多层低频噪声(双线性放大)叠加 + 一层细颗粒
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
