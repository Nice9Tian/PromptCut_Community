/**
 * Prerenders a looping video for the aurora in the login page left rail using the **accent color
 * of each skin**.
 *
 *   node scripts/login-art/render-all.mjs [--only studio,clay] [--frames-per-loop]
 *
 * Why one per skin: once prerendered into video, the left rail can no longer change with
 * `--ui-accent` like a real-time shader. In testing, a 512-wide version at CRF 32 is only ~520 KB,
 * and the page only loads the one for the current skin, so rendering all six is inexpensive,
 * losing nothing of "changing with the theme color" (on 2026-10-24 the user said "can produce two
 * versions", addressing this cost; six is a superset of it, while two could only cover one cool
 * and one warm).
 *
 * For each one: create a project containing only `pc-login-art` → run `scripts/export-e2e.mjs` for
 * a real export → compress to mp4 using ffmpeg. Artifacts land in `src/start/art/`, and vite
 * bundles them as assets (hashed, no cache concerns).
 *
 * Why the loop connects: in the card, `uLoop = (t / loopSeconds)` takes the fractional part and
 * returns to the start after a full cycle, so frame 0 and frame N calculate to be byte-for-byte
 * identical (`scripts/login-art/seam-check.md` recorded that test).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ART = path.join(ROOT, 'src/start/art');
const argv = process.argv.slice(2);
const only = (() => { const i = argv.indexOf('--only'); return i < 0 ? null : new Set(argv[i + 1].split(',')); })();

/** Canvas and encoding: the aurora is a soft gradient, 512 width is plenty; CRF 32 measured ~520 KB / 48 seconds */
const W = 880, H = 1080, OUT_W = 512, CRF = 32, FPS = 24, LOOP_SECONDS = 48;

/** Reads the dark accent color for each skin from src/skins/palettes.ts, not copied by hand */
function palettes() {
  const s = fs.readFileSync(path.join(ROOT, 'src/skins/palettes.ts'), 'utf8').replace(/\r\n/g, '\n');
  const out = [];
  for (const m of s.matchAll(/id:\s*"([^"]+)",\s*\n\s*name:\s*"([^"]+)",\s*\n\s*en:\s*"([^"]+)"/g)) {
    const [, id, name] = m;
    const tail = s.slice(m.index + m[0].length, m.index + m[0].length + 1200);
    const accent = /dark:\s*\{[^}]*?accent:\s*"([^"]+)"/s.exec(tail);
    // Background color takes surfaces[0] (L0 canvas, i.e. --bg-canvas): this is what underlays
    // the login page left rail
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

fs.mkdirSync(ART, { recursive: true });
const FF = ffmpeg();
const made = [];

for (const p of palettes()) {
  if (only && !only.has(p.id)) continue;
  const projPath = path.join(ROOT, `scripts/login-art/project-${p.id}.json`);
  fs.writeFileSync(projPath, JSON.stringify({
    version: 1, id: `login-art-${p.id}`, name: `Login page left rail aurora · ${p.name}`,
    width: W, height: H, fps: FPS, duration: LOOP_SECONDS,
    themeId: 'midnight', media: [],
    tracks: [{ id: 't-art', name: 'Track 1', clips: [{
      id: 'c-art', cardId: 'pc-login-art', start: 0, end: LOOP_SECONDS,
      params: { cool: p.accent, warm: '#e2731f', bg: p.bg, loopSeconds: LOOP_SECONDS },
    }] }],
    cuts: [{ id: 'cut-1', name: 'Cut 1' }], activeCutId: 'cut-1',
  }, null, 1) + '\n', 'utf8');

  console.log(`\n── ${p.name} (${p.id}) accent color ${p.accent}, background color ${p.bg} ──`);
  const t0 = Date.now();
  const log = execFileSync(process.execPath, [
    'scripts/export-e2e.mjs', '--project', projPath, '--id', `art-${p.id}`, '--video',
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  const mp4 = /final video:(.+preview\.mp4)/.exec(log)?.[1]?.trim();
  if (!mp4 || !fs.existsSync(mp4)) throw new Error(`${p.id}: did not get preview.mp4\n${log.slice(-600)}`);

  const dest = path.join(ART, `login-art-${p.id}.mp4`);
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-i', mp4, '-an',
    '-vf', `scale=${OUT_W}:-2`, '-c:v', 'libx264', '-crf', String(CRF), '-preset', 'slow',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dest], { stdio: 'inherit', windowsHide: true });
  const bytes = fs.statSync(dest).size;
  made.push({ id: p.id, name: p.name, accent: p.accent, bytes });
  console.log(`   → ${path.relative(ROOT, dest)}  ${(bytes / 1024).toFixed(0)} KB  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

console.log('\n── All done ──');
for (const m of made) console.log(`  ${m.name.padEnd(4)} ${m.id.padEnd(10)} ${m.accent}  ${(m.bytes / 1024).toFixed(0)} KB`);
console.log(`  Total ${(made.reduce((s, m) => s + m.bytes, 0) / 1024 / 1024).toFixed(1)} MB (the page loads only the one for the current skin)`);
