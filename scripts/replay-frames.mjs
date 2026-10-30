/**
 * 从 HTML 采样缓存里重截帧 —— 任意顺序、任意子集。
 *
 * # 它是干什么的
 *
 * `scripts/export-frames.mjs --dom-cache` 在导出那一趟里,每截完一帧就把舞台生成一份 HTML 快照(全部计算样式内联、
 * 动画关掉、id 改名、画布换成同尺寸的图),存到 `<out>/dom/%06d.html.gz`。这个脚本拿这些快照重截:
 *
 *   - **不需要从第 0 帧顺推**:每一帧的状态就在快照里,想截第几帧就截第几帧;
 *   - **不需要页面时钟、settle、钉动画**:快照里没有任何还在走的钟(实测注入后等 500ms 再截,0/60 帧变化);
 *   - 所以可以乱序、可以只截一部分、可以多开几个进程各截一段。
 *
 * 用在「内容没变、只是要再截一遍」的场合:换输出格式、换合成层、预览要渐进铺开、分给多个进程并行。
 *
 * # 一定要知道的
 *
 * **重放截图和实时截图不是逐字节相同的**:重放时浏览器会按内联的计算样式重新排一遍版,
 * 边缘上有细小残差(实测 rank-bars 35/60 帧相同、最大通道差 71;mu-number-ticker 60/60 相同)。
 * 重放和重放之间是确定的(乱序 vs 倒序 0/60 不同)。所以**同一次交付只走一条路**,
 * 别把一部分实时截的帧和一部分重放的帧拼在一起 —— 接缝会跳。
 *
 * # 用法
 *
 *   node scripts/replay-frames.mjs --cache out/x/dom --out out/x-replay [--frames 0-99 | --frames 5,9,12] [--shuffle] [--url 导出页]
 *
 * 用的是和导出同一个渲染器、同一套启动参数(openBakery),字体和样式表都来自导出页。
 */
import './lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { captureSnapshot } from '../server/bakery/capture-snapshot.mjs';
import { openBakery } from '../server/bakery/index.mjs';

/** 解析 --frames:「a-b」或「a,b,c」;不给就是缓存里全部的帧 */
function pickFrames(spec, available) {
  if (!spec) return available;
  const have = new Set(available);
  if (/^\d+-\d+$/.test(spec)) {
    const [a, b] = spec.split('-').map(Number);
    return available.filter((n) => n >= a && n <= b);
  }
  return spec.split(',').map(Number).filter((n) => Number.isFinite(n) && have.has(n));
}

/**
 * 重截一批帧。返回 { frames, elapsed }。
 * `bakery` 可以由调用方传进来复用(常驻进程里用);不传就自己开一个、用完关掉。
 */
export async function replayFrames(opts) {
  const cacheDir = opts.cache;
  const manifest = JSON.parse(fs.readFileSync(path.join(cacheDir, 'manifest.json'), 'utf8'));
  const available = fs.readdirSync(cacheDir).filter((f) => /^\d{6}\.html\.gz$/.test(f)).map((f) => Number(f.slice(0, 6))).sort((a, b) => a - b);
  let frames = pickFrames(opts.frames, available);
  if (opts.shuffle) frames = [...frames].sort(() => Math.random() - 0.5);
  const outDir = path.join(opts.out || 'out/replay', 'frames');
  fs.mkdirSync(outDir, { recursive: true });

  const bakery = opts.bakery || await openBakery({ url: opts.url || manifest.exportUrl });
  const { page, client, beginFrame } = bakery;
  const t0 = Date.now();
  try {
    await page.setViewport({ width: manifest.width, height: manifest.height, deviceScaleFactor: 1 });
    await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const writes = [];
    for (const n of frames) {
      const html = zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, `${String(n).padStart(6, '0')}.html.gz`))).toString('utf8');
      const buf = await captureSnapshot(bakery, html);
      writes.push(fs.promises.writeFile(path.join(outDir, String(n).padStart(6, '0') + '.png'), buf));
    }
    await Promise.all(writes);
  } finally {
    if (!opts.bakery) await bakery.close();
  }
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`Replayed ${frames.length} frames in ${elapsed.toFixed(1)}s (${(elapsed * 1000 / Math.max(1, frames.length)).toFixed(1)} ms/帧).`);
  return { frames, elapsed };
}

const isMain = import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cache') opts.cache = args[++i];
    else if (args[i] === '--out') opts.out = args[++i];
    else if (args[i] === '--frames') opts.frames = args[++i];
    else if (args[i] === '--url') opts.url = args[++i];
    else if (args[i] === '--shuffle') opts.shuffle = true;
  }
  if (!opts.cache) { console.error('用法:node scripts/replay-frames.mjs --cache <out>/dom --out <目录> [--frames a-b] [--shuffle]'); process.exit(2); }
  replayFrames(opts).catch((e) => { console.error(e); process.exit(1); });
}
