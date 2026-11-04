/**
 * Prerenders the **home page background glow** (`src/start/BrandGlow.tsx`) into a looping video.
 * (user decision, 2026-10-24: "Change all three places to looping videos prerendered by the renderer:
 * desktop login page, mobile app login, official website home page.")
 * The aurora on the desktop login page is produced by `render-all.mjs`; this script handles the
 * other two places: they render the same glow, differing only in aspect ratio.
 *
 *   node scripts/login-art/render-glow.mjs              # Six skins in portrait + one landscape
 *   node scripts/login-art/render-glow.mjs --only wide  # Render landscape only
 *   node scripts/login-art/render-glow.mjs --only studio,wide
 *
 * **Two aspect ratios, one card.** The radii of the two glow spheres in this shader are fixed CSS
 * pixels, and composition is centered on the frame (see refW / refH in `BrandGlow.tsx`), so whatever
 * dimensions it is rendered at, the resulting composition matches those dimensions. Card
 * `pc-brand-glow` follows the project aspect ratio, so portrait and landscape differ only in the
 * project's width / height.
 *
 * - **Portrait** (`glow-<skin>.mp4`): background for mobile app login. One per skin, selected by
 *   `GlowLoop` via `data-skin`, making up for the only downside of prerendering (no longer changing
 *   with `--ui-accent`). Aspect ratio uses 559×1290, exactly the baseline viewport these parameters
 *   were originally tuned for.
 * - **Landscape** (`glow-wide.mp4`): background for the official website home page. The official
 *   website has no skin switching, using the fixed "Flow" skin (`--bg` #111016, `--glow-a` #00dbdb,
 *   matching the official site source text copied in the `BrandGlow.tsx` header).
 *
 * Why the loop connects: the phases of both glows are **integer harmonics** of `uLoop` (4 and 3);
 * `uLoop` goes from 0 to 1 and returns exactly to the starting point, so the first and last frames
 * calculate to be identical.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Portrait outputs land here: collected by glob in `GlowLoop.tsx`, and vite bundles them as assets */
const ART = path.join(ROOT, 'src/start/art');
/*
 * Landscape outputs land here and **must not** be placed with portrait: the entire `src/start/art/`
 * directory is matched by that glob, and putting it there would bundle the landscape version (used
 * only on the official website) into online build artifacts, adding 310 KB unnecessarily (the page
 * will never fetch it even once).
 * This copy is the source for `site/assets/home-glow.mp4` in the VisuHive repository, kept in the
 * repo to trace its origin.
 */
const OUT = path.join(ROOT, 'scripts/login-art/out');
const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf('--only');
  return i < 0 ? null : new Set(argv[i + 1].split(','));
})();

/** Loop duration in seconds must match LOOK.loopSeconds in BrandGlow.tsx, not copied by hand */
const LOOP_SECONDS = (() => {
  const s = fs.readFileSync(path.join(ROOT, 'src/start/BrandGlow.tsx'), 'utf8');
  const m = /loopSeconds:\s*(\d+)/.exec(s);
  if (!m) throw new Error('Could not read loopSeconds in BrandGlow.tsx');
  return Number(m[1]);
})();

const FPS = 24;
/** The warm glow is an orange chosen by the user, independent of skins (same as LOOK.colB in BrandGlow.tsx) */
const WARM = '#FF7B00';

/*
 * Encoding: this is an extremely smooth dark gradient, where 8-bit H.264 is most prone to banding.
 * Dither noise was already added in the shader to break up stepping, so CRF is set one tier tighter
 * than the login page aurora (28 vs. 32): once noise gets quantized away, banding returns.
 * Portrait outputs 540 width (sufficient on mobile), landscape outputs 1280 width (fills the desktop
 * home page).
 */
const CRF = 28;

/** Reads the dark accent color and background color for each skin from src/skins/palettes.ts, not copied by hand */
function palettes() {
  const s = fs.readFileSync(path.join(ROOT, 'src/skins/palettes.ts'), 'utf8').replace(/\r\n/g, '\n');
  const out = [];
  for (const m of s.matchAll(/id:\s*"([^"]+)",\s*\n\s*name:\s*"([^"]+)",\s*\n\s*en:\s*"([^"]+)"/g)) {
    const [, id, name] = m;
    const tail = s.slice(m.index + m[0].length, m.index + m[0].length + 1200);
    const accent = /dark:\s*\{[^}]*?accent:\s*"([^"]+)"/s.exec(tail);
    const bg = /dark:\s*\{[^}]*?surfaces:\s*\[\s*"([^"]+)"/s.exec(tail);
    if (!accent) throw new Error(`${id}: could not read dark.accent`);
    out.push({ id, name, accent: accent[1], bg: bg ? bg[1] : '#111016' });
  }
  if (out.length === 0) throw new Error('No skin could be read, the format of palettes.ts may have changed');
  return out;
}

function ffmpeg() {
  const hits = fs.globSync
    ? fs.globSync('C:/Users/admin/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg*/ffmpeg-*/bin/ffmpeg.exe')
    : [];
  if (hits.length) return hits[0];
  return 'ffmpeg'; // If it is in PATH, use the one from PATH
}

/** Each item to render: one per skin for portrait, only one for landscape (official website is fixed to "Flow") */
function targets() {
  /*
   * 560×1290 instead of 559×1290 from the baseline viewport: **libx264 requires both width and height
   * to be even numbers**; 559 causes export to crash outright at the video compositing step
   * (`width not divisible by 2 (559x1290)`, encountered on 2026-10-24, wasting a run across all six).
   * This 1 px difference is imperceptible on this soft gradient. There is another immediate
   * interception check below.
   */
  const list = palettes().map((p) => ({
    key: p.id,
    label: `${p.name} (portrait, mobile login)`,
    out: `glow-${p.id}.mp4`, dir: ART, where: 'src/start/art',
    w: 560, h: 1290, outW: 540,
    bg: p.bg, colA: p.accent, colB: WARM,
  }));
  const studio = palettes().find((p) => p.id === 'studio');
  list.push({
    key: 'wide',
    label: 'Landscape (website home page, fixed "Flowing light")',
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
 * Check all aspect ratios before starting: libx264 width and height must be even numbers; odd
 * numbers will only error at the **final step of export** when compositing the video, by which time
 * a round of 672 frames has already been rendered in vain (all six hit 559 together on 2026-10-24).
 */
const odd = plan.filter((t) => t.w % 2 || t.h % 2 || t.outW % 2);
if (odd.length) {
  throw new Error(`The aspect ratio must be even (a hard requirement of libx264), these are not:`
    + odd.map((t) => `${t.key} ${t.w}×${t.h}→${t.outW}`).join(', '));
}

for (const t of plan) {
  if (only && !only.has(t.key)) continue;
  const projPath = path.join(ROOT, `scripts/login-art/glow-${t.key}.json`);
  fs.writeFileSync(projPath, JSON.stringify({
    version: 1, id: `glow-${t.key}`, name: `Home page background glow · ${t.label}`,
    width: t.w, height: t.h, fps: FPS, duration: LOOP_SECONDS,
    themeId: 'midnight', media: [],
    tracks: [{ id: 't-glow', name: 'Track 1', clips: [{
      id: 'c-glow', cardId: 'pc-brand-glow', start: 0, end: LOOP_SECONDS,
      params: { bg: t.bg, colA: t.colA, colB: t.colB, loopSeconds: LOOP_SECONDS },
    }] }],
    cuts: [{ id: 'cut-1', name: 'Cut 1' }], activeCutId: 'cut-1',
  }, null, 1) + '\n', 'utf8');

  console.log(`\n── ${t.label} ${t.w}×${t.h}, glow ${t.colA}, background ${t.bg} ──`);
  const t0 = Date.now();
  const log = execFileSync(process.execPath, [
    'scripts/export-e2e.mjs', '--project', projPath, '--id', `glow-${t.key}`, '--video',
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  const mp4 = /final video:(.+preview\.mp4)/.exec(log)?.[1]?.trim();
  if (!mp4 || !fs.existsSync(mp4)) throw new Error(`${t.key}: did not get preview.mp4\n${log.slice(-600)}`);

  const dest = path.join(t.dir, t.out);
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-i', mp4, '-an',
    '-vf', `scale=${t.outW}:-2`, '-c:v', 'libx264', '-crf', String(CRF), '-preset', 'slow',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dest], { stdio: 'inherit', windowsHide: true });
  const bytes = fs.statSync(dest).size;
  made.push({ ...t, bytes });
  console.log(`   → ${t.where}/${t.out}  ${(bytes / 1024).toFixed(0)} KB  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

console.log('\n── All done ──');
for (const m of made) console.log(`  ${m.out.padEnd(22)} ${m.colA}  ${(m.bytes / 1024).toFixed(0)} KB`);
console.log(`  Total ${(made.reduce((s, m) => s + m.bytes, 0) / 1024 / 1024).toFixed(1)} MB`);
console.log('  (mobile login loads only the current skin; the landscape one is in scripts/login-art/out/, copy it into the VisuHive repo for the website home page, it does not go into the online build)');
