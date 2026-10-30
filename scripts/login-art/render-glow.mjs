/**
 * 把**首页那层背景光**（`src/start/BrandGlow.tsx`）预渲染成循环视频。
 * 用户 2026-10-24 定：「三处都改成渲染器预渲染的循环视频：桌面登录页、手机版登录、官网首页。」
 * 桌面登录页那块极光由 `render-all.mjs` 产；这一支管另外两处 —— 它们画的是同一块光，只差画幅。
 *
 *   node scripts/login-art/render-glow.mjs              # 竖版六套皮肤 + 横版一个
 *   node scripts/login-art/render-glow.mjs --only wide  # 只渲横版
 *   node scripts/login-art/render-glow.mjs --only studio,wide
 *
 * **两种画幅，一张卡。** 这段着色器的两团光半径是固定 CSS 像素、构图以画面中心对齐
 * （见 `BrandGlow.tsx` 的 refW / refH），所以在什么尺寸上渲，出来的就是那个尺寸上的构图。
 * 卡片 `pc-brand-glow` 跟着项目画幅走，于是竖版、横版只差项目的 width / height。
 *
 * - **竖版**（`glow-<皮肤>.mp4`）：手机版登录的背景。一套皮肤一个，`GlowLoop` 按 `data-skin` 挑，
 *   预渲染唯一的代价（不再跟着 `--ui-accent` 变）就补回来了。画幅取 559×1290，
 *   正是这组参数当初调出来的基准视口。
 * - **横版**（`glow-wide.mp4`）：官网首页的背景。官网没有换肤，固定用「流光」那套
 *   （`--bg` #111016、`--glow-a` #00dbdb，和 `BrandGlow.tsx` 文件头抄的官网原文一致）。
 *
 * 循环为什么接得上：两团光的相位都是 `uLoop` 的**整数倍频**（4 和 3），
 * `uLoop` 从 0 走到 1 正好回到出发点，所以第一帧和最后一帧算出来一样。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** 竖版落在这里：`GlowLoop.tsx` 用 glob 收，vite 会把它们当资源打包 */
const ART = path.join(ROOT, 'src/start/art');
/*
 * 横版落在这里，**不能**和竖版放一起：`src/start/art/` 整个目录被那条 glob 收走，
 * 放进去的话官网才用的横版也会被打进在线产物，白白多 310 KB（页面一次都不会去取它）。
 * 这一份是给 VisuHive 仓库 `site/assets/home-glow.mp4` 的来源，留在仓库里好追溯怎么来的。
 */
const OUT = path.join(ROOT, 'scripts/login-art/out');
const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf('--only');
  return i < 0 ? null : new Set(argv[i + 1].split(','));
})();

/** 循环秒数要和 BrandGlow.tsx 的 LOOK.loopSeconds 一致，不手抄 */
const LOOP_SECONDS = (() => {
  const s = fs.readFileSync(path.join(ROOT, 'src/start/BrandGlow.tsx'), 'utf8');
  const m = /loopSeconds:\s*(\d+)/.exec(s);
  if (!m) throw new Error('BrandGlow.tsx 里没读到 loopSeconds');
  return Number(m[1]);
})();

const FPS = 24;
/** 暖的那团是用户挑定的橘色，和皮肤无关（同 BrandGlow.tsx 的 LOOK.colB） */
const WARM = '#FF7B00';

/*
 * 编码：这是一片极平滑的深色渐变，8 位 H.264 上最怕色带。着色器里本来就撒了抖动噪声打散台阶，
 * 所以 CRF 给得比登录页那块极光紧一档（28 对 32）—— 噪声一旦被量化掉，色带就回来了。
 * 竖版输出 540 宽（手机上够），横版 1280 宽（桌面首页铺满）。
 */
const CRF = 28;

/** 从 src/skins/palettes.ts 把每套皮肤的深色强调色与底色读出来，不手抄 */
function palettes() {
  const s = fs.readFileSync(path.join(ROOT, 'src/skins/palettes.ts'), 'utf8').replace(/\r\n/g, '\n');
  const out = [];
  for (const m of s.matchAll(/id:\s*"([^"]+)",\s*\n\s*name:\s*"([^"]+)",\s*\n\s*en:\s*"([^"]+)"/g)) {
    const [, id, name] = m;
    const tail = s.slice(m.index + m[0].length, m.index + m[0].length + 1200);
    const accent = /dark:\s*\{[^}]*?accent:\s*"([^"]+)"/s.exec(tail);
    const bg = /dark:\s*\{[^}]*?surfaces:\s*\[\s*"([^"]+)"/s.exec(tail);
    if (!accent) throw new Error(`${id} 没读到 dark.accent`);
    out.push({ id, name, accent: accent[1], bg: bg ? bg[1] : '#111016' });
  }
  if (out.length === 0) throw new Error('一套皮肤都没读到，palettes.ts 的写法可能变了');
  return out;
}

function ffmpeg() {
  const hits = fs.globSync
    ? fs.globSync('C:/Users/admin/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg*/ffmpeg-*/bin/ffmpeg.exe')
    : [];
  if (hits.length) return hits[0];
  return 'ffmpeg'; // 在 PATH 里就用 PATH 里的
}

/** 要渲的每一个：竖版一套皮肤一个，横版就一个（官网固定「流光」） */
function targets() {
  /*
   * 560×1290 而不是基准视口那个 559×1290：**libx264 要求宽高都是偶数**，
   * 559 会让导出在合成那一步直接挂（`width not divisible by 2 (559x1290)`，2026-10-24 撞到，
   * 六个一起白跑了一轮）。差这 1 px 对这片软渐变看不出来。下面还有一道当场拦截。
   */
  const list = palettes().map((p) => ({
    key: p.id,
    label: `${p.name}（竖版，手机登录）`,
    out: `glow-${p.id}.mp4`, dir: ART, where: 'src/start/art',
    w: 560, h: 1290, outW: 540,
    bg: p.bg, colA: p.accent, colB: WARM,
  }));
  const studio = palettes().find((p) => p.id === 'studio');
  list.push({
    key: 'wide',
    label: '横版（官网首页，固定「流光」）',
    out: 'glow-wide.mp4', dir: OUT, where: 'scripts/login-art/out',
    w: 1600, h: 900, outW: 1280,
    bg: studio.bg, colA: studio.accent, colB: WARM,
  });
  return list;
}

fs.mkdirSync(ART, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const FF = ffmpeg();
const made = [];

const plan = targets();
/*
 * 先把所有画幅查一遍再开工：libx264 的宽高必须是偶数，奇数要到**导出的最后一步**
 * 合成视频时才报错，那时一轮 672 帧已经白渲了（2026-10-24 六个一起栽在 559 上）。
 */
const odd = plan.filter((t) => t.w % 2 || t.h % 2 || t.outW % 2);
if (odd.length) {
  throw new Error(`画幅必须是偶数（libx264 的硬要求），这几个不是：`
    + odd.map((t) => `${t.key} ${t.w}×${t.h}→${t.outW}`).join('、'));
}

for (const t of plan) {
  if (only && !only.has(t.key)) continue;
  const projPath = path.join(ROOT, `scripts/login-art/glow-${t.key}.json`);
  fs.writeFileSync(projPath, JSON.stringify({
    version: 1, id: `glow-${t.key}`, name: `首页背景光 · ${t.label}`,
    width: t.w, height: t.h, fps: FPS, duration: LOOP_SECONDS,
    themeId: 'midnight', media: [],
    tracks: [{ id: 't-glow', name: '序列 1', clips: [{
      id: 'c-glow', cardId: 'pc-brand-glow', start: 0, end: LOOP_SECONDS,
      params: { bg: t.bg, colA: t.colA, colB: t.colB, loopSeconds: LOOP_SECONDS },
    }] }],
    cuts: [{ id: 'cut-1', name: '剪辑1' }], activeCutId: 'cut-1',
  }, null, 1) + '\n', 'utf8');

  console.log(`\n── ${t.label} ${t.w}×${t.h}，光 ${t.colA}，底 ${t.bg} ──`);
  const t0 = Date.now();
  const log = execFileSync(process.execPath, [
    'scripts/export-e2e.mjs', '--project', projPath, '--id', `glow-${t.key}`, '--video',
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  const mp4 = /成片:(.+preview\.mp4)/.exec(log)?.[1]?.trim();
  if (!mp4 || !fs.existsSync(mp4)) throw new Error(`${t.key}: 没拿到 preview.mp4\n${log.slice(-600)}`);

  const dest = path.join(t.dir, t.out);
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-i', mp4, '-an',
    '-vf', `scale=${t.outW}:-2`, '-c:v', 'libx264', '-crf', String(CRF), '-preset', 'slow',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dest], { stdio: 'inherit', windowsHide: true });
  const bytes = fs.statSync(dest).size;
  made.push({ ...t, bytes });
  console.log(`   → ${t.where}/${t.out}  ${(bytes / 1024).toFixed(0)} KB  （${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
}

console.log('\n── 全部做完 ──');
for (const m of made) console.log(`  ${m.out.padEnd(22)} ${m.colA}  ${(m.bytes / 1024).toFixed(0)} KB`);
console.log(`  合计 ${(made.reduce((s, m) => s + m.bytes, 0) / 1024 / 1024).toFixed(1)} MB`);
console.log('  （手机登录只加载当前皮肤那一个；横版那个在 scripts/login-art/out/，拷进 VisuHive 仓库给官网首页用，不进在线产物）');
