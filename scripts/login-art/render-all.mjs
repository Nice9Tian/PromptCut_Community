/**
 * 把登录页左栏那段极光，按**每一套皮肤的强调色**各预渲染一个循环视频。
 *
 *   node scripts/login-art/render-all.mjs [--only studio,clay] [--frames-per-loop]
 *
 * 为什么一套皮肤一个：预渲染成视频之后，左栏就不能像实时着色器那样跟着 `--ui-accent` 变了。
 * 实测一个版本 512 宽、CRF 32 只有 ~520 KB，而页面只加载当前皮肤那一个，所以六套全渲也不贵，
 * 「跟着主题色变」这件事一点不损失（用户 2026-10-24 说「可以出两个版本」，是针对这个代价说的；
 * 六个是它的超集，两个只能覆盖一冷一暖）。
 *
 * 每一个都：写一份只放 `pc-login-art` 这张卡的项目 → 走 `scripts/export-e2e.mjs` 真导出 →
 * 用 ffmpeg 压成 mp4。产物落在 `src/start/art/`，vite 会把它们当资源打包（带哈希，缓存不用操心）。
 *
 * 循环为什么接得上：卡片里 `uLoop = (t / loopSeconds)` 的小数部分，走满一圈回到起点，
 * 所以第 0 帧和第 N 帧算出来逐字节相同（`scripts/login-art/seam-check.md` 记了那次实测）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ART = path.join(ROOT, 'src/start/art');
const argv = process.argv.slice(2);
const only = (() => { const i = argv.indexOf('--only'); return i < 0 ? null : new Set(argv[i + 1].split(',')); })();

/** 画布与编码：极光是一片软渐变，512 宽足够；CRF 32 实测 ~520 KB / 48 秒 */
const W = 880, H = 1080, OUT_W = 512, CRF = 32, FPS = 24, LOOP_SECONDS = 48;

/** 从 src/skins/palettes.ts 把每套皮肤的深色强调色读出来，不手抄 */
function palettes() {
  const s = fs.readFileSync(path.join(ROOT, 'src/skins/palettes.ts'), 'utf8').replace(/\r\n/g, '\n');
  const out = [];
  for (const m of s.matchAll(/id:\s*"([^"]+)",\s*\n\s*name:\s*"([^"]+)",\s*\n\s*en:\s*"([^"]+)"/g)) {
    const [, id, name] = m;
    const tail = s.slice(m.index + m[0].length, m.index + m[0].length + 1200);
    const accent = /dark:\s*\{[^}]*?accent:\s*"([^"]+)"/s.exec(tail);
    // 底色取 surfaces[0]（L0 画布，也就是 --bg-canvas）——登录页左栏垫的就是它
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

fs.mkdirSync(ART, { recursive: true });
const FF = ffmpeg();
const made = [];

for (const p of palettes()) {
  if (only && !only.has(p.id)) continue;
  const projPath = path.join(ROOT, `scripts/login-art/project-${p.id}.json`);
  fs.writeFileSync(projPath, JSON.stringify({
    version: 1, id: `login-art-${p.id}`, name: `登录页左栏极光 · ${p.name}`,
    width: W, height: H, fps: FPS, duration: LOOP_SECONDS,
    themeId: 'midnight', media: [],
    tracks: [{ id: 't-art', name: '序列 1', clips: [{
      id: 'c-art', cardId: 'pc-login-art', start: 0, end: LOOP_SECONDS,
      params: { cool: p.accent, warm: '#e2731f', bg: p.bg, loopSeconds: LOOP_SECONDS },
    }] }],
    cuts: [{ id: 'cut-1', name: '剪辑1' }], activeCutId: 'cut-1',
  }, null, 1) + '\n', 'utf8');

  console.log(`\n── ${p.name}（${p.id}）强调色 ${p.accent}，底色 ${p.bg} ──`);
  const t0 = Date.now();
  const log = execFileSync(process.execPath, [
    'scripts/export-e2e.mjs', '--project', projPath, '--id', `art-${p.id}`, '--video',
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  const mp4 = /成片:(.+preview\.mp4)/.exec(log)?.[1]?.trim();
  if (!mp4 || !fs.existsSync(mp4)) throw new Error(`${p.id}: 没拿到 preview.mp4\n${log.slice(-600)}`);

  const dest = path.join(ART, `login-art-${p.id}.mp4`);
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-i', mp4, '-an',
    '-vf', `scale=${OUT_W}:-2`, '-c:v', 'libx264', '-crf', String(CRF), '-preset', 'slow',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dest], { stdio: 'inherit', windowsHide: true });
  const bytes = fs.statSync(dest).size;
  made.push({ id: p.id, name: p.name, accent: p.accent, bytes });
  console.log(`   → ${path.relative(ROOT, dest)}  ${(bytes / 1024).toFixed(0)} KB  （${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
}

console.log('\n── 全部做完 ──');
for (const m of made) console.log(`  ${m.name.padEnd(4)} ${m.id.padEnd(10)} ${m.accent}  ${(m.bytes / 1024).toFixed(0)} KB`);
console.log(`  合计 ${(made.reduce((s, m) => s + m.bytes, 0) / 1024 / 1024).toFixed(1)} MB（页面只加载当前皮肤那一个）`);
