/*
 * 全长导出逐字节相同 —— 基线对账探针(C1「挂载算式统一」/ H7 的验收工具)
 *
 * 干两件事:
 *   1. run     —— 在指定的仓库树里跑一趟**全长** PNG 导出(不出视频),产物是 <out>/frames/%06d.png;
 *   2. compare —— 把两个 frames 目录逐帧比 sha256,报第一处不同、并对不同的帧数像素差。
 *
 * 为什么 run 要带 --tree:基线跑的必须是 **HEAD 那棵树自己的** scripts/export-frames.mjs(引擎在 server/bakery/)(引擎在 server/bakery/)
 * (这次重构改的就是它),拿工作树的脚本去渲基线就不是 apples-to-apples 了。
 * 所以 run 只负责 `node scripts/export-frames.mjs …`,cwd 指到哪棵树就用哪棵树的代码。
 * cwd 还决定素材目录:server/bakery/media.mjs 的 mediaRootDir() = <cwd>/out/media
 * (PROMPTCUT_EXPORT_DIR 没设时),/@media/<文件名> 两边都得有那份文件。
 *
 * ───────────── 这一轮实际跑的命令(照抄即可复现) ─────────────
 *
 * 前置:
 *   # 1) HEAD 的工作树(不动主树的 git 状态)
 *   git worktree add <scratch>/pc-head 0ba58cb
 *   cmd /c mklink /J <scratch>\pc-head\node_modules C:\Users\admin\Documents\PromptCut\node_modules
 *   # 2) 素材(ffmpeg testsrc2),两棵树的 out/media 各放一份,按文件名取
 *   ffmpeg -f lavfi -i "testsrc2=s=320x180:r=30:d=8" -c:v libx264 -pix_fmt yuv420p -g 30 -y pc-baseline-fixture.mp4
 *   cp pc-baseline-fixture.mp4 <主树>/out/media/ ; cp pc-baseline-fixture.mp4 <scratch>/pc-head/out/media/
 *   # 3) 两台 dev server(避开用户的 5190 / 5197;TEMP 指到 scratch,别覆盖全局 port.json)
 *   cd <scratch>/pc-head && TEMP=<scratch>/tmp-head TMP=<scratch>/tmp-head npx vite --port 5215 --strictPort --host 127.0.0.1
 *   cd <主树>          && TEMP=<scratch>/tmp-work TMP=<scratch>/tmp-work npx vite --port 5216 --strictPort --host 127.0.0.1
 *   curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5215/@media/pc-baseline-fixture.mp4   # 两边都要 200
 *
 * 基线(HEAD 那棵树的脚本 + 5215):
 *   node scripts/probes/export-baseline-compare.mjs run \
 *     --tree <scratch>/pc-head --origin http://127.0.0.1:5215 \
 *     --project <scratch>/export-fixture/project.json --out <scratch>/export-fixture/baseline
 *
 * 候选(工作树的脚本 + 5216):
 *   node scripts/probes/export-baseline-compare.mjs run \
 *     --origin http://127.0.0.1:5216 \
 *     --project <scratch>/export-fixture/project.json --out <scratch>/export-fixture/candidate
 *
 * 比对(不同即退出码 1):
 *   node scripts/probes/export-baseline-compare.mjs \
 *     --baseline <scratch>/export-fixture/baseline/frames \
 *     --candidate <scratch>/export-fixture/candidate/frames
 *
 * run 之后接着比,一条命令也行:run 里同时给 --baseline。
 *
 * ───────────── 对账口径(docs/guides/compare-pitfalls.md)─────────────
 * - 验收口径是**逐字节**(sha256):PNG 的字节相同 ⟹ 像素相同。像素差只在不同的帧上再算一次,
 *   用来区分「抗锯齿末位差几个像素」和「真的画错了」——两者都算不通过,但结论不一样。
 * - 两边必须同 fps、同分片数、同一条动画路径。这里一律 --workers 1:分片计划(shardPlan)
 *   本身也在重构范围内,分片数不同会把「分片边界重挂载」的差异混进来。
 * - --no-video:验收比的是帧,不是编码产物;ffmpeg / prores 不进对账。
 * - Chrome 参数(--disable-gpu、--font-render-hinting=none、软件光栅化…)都在 server/bakery/chrome.mjs
 *   的 CHROME_ARGS 里,两棵树各自用自己的那份——这正是要比的东西之一,不要在这里覆盖。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function parseArgs(argv) {
  const opts = { mode: null, tree: REPO_ROOT, fps: 30, workers: '1', frames: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'run' || a === 'compare') opts.mode = a;
    else if (a === '--tree') opts.tree = path.resolve(argv[++i]);
    else if (a === '--origin') opts.origin = argv[++i];
    else if (a === '--project') opts.project = path.resolve(argv[++i]);
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--baseline') opts.baseline = path.resolve(argv[++i]);
    else if (a === '--candidate') opts.candidate = path.resolve(argv[++i]);
    else if (a === '--fps') opts.fps = Number(argv[++i]);
    else if (a === '--workers') opts.workers = argv[++i];
    else if (a === '--frames') opts.frames = argv[++i];
    else if (a === '--max-diff-frames') opts.maxDiffFrames = Number(argv[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
    else rest.push(a);
  }
  if (rest.length) throw new Error('看不懂的参数:' + rest.join(' '));
  if (!opts.mode) opts.mode = opts.origin ? 'run' : 'compare';
  return opts;
}

/** 导出页地址:项目用 data: URL 带进去,和 scripts/verify-*.mjs 一个写法 */
export function exportUrlOf(origin, project) {
  const timeline = 'data:application/json,' + encodeURIComponent(JSON.stringify(project));
  return `${origin.replace(/\/$/, '')}/?export=1&timeline=${encodeURIComponent(timeline)}`;
}

/** 跑一趟全长 PNG 导出。cwd = 哪棵树,就用哪棵树的 scripts/export-frames.mjs 和 out/media */
export async function runExport({ tree, origin, project, out, fps, workers, frames }) {
  const proj = JSON.parse(await fsp.readFile(project, 'utf8'));
  const url = exportUrlOf(origin, proj);
  const args = ['scripts/export-frames.mjs', '--url', url, '--out', out,
    '--fps', String(fps || proj.fps || 30), '--workers', String(workers ?? 1), '--no-video'];
  if (frames) args.push('--frames', frames);
  await fsp.rm(path.join(out, 'frames'), { recursive: true, force: true });
  await fsp.mkdir(out, { recursive: true });
  console.log(`[run] cwd=${tree}`);
  console.log(`[run] node ${args[0]} --url "<${origin}/?export=1&timeline=data:…(${url.length} 字符)>" ${args.slice(3).join(' ')}`);
  const t0 = process.hrtime.bigint();
  const code = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: tree, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    p.on('error', reject);
    p.on('close', resolve);
  });
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const dir = path.join(out, 'frames');
  const n = fs.existsSync(dir) ? (await fsp.readdir(dir)).filter((f) => f.endsWith('.png')).length : 0;
  console.log(`[run] 退出码 ${code},${n} 帧,${secs.toFixed(1)} s → ${dir}`);
  if (code !== 0) throw new Error(`export-frames 退出码 ${code}`);
  return { framesDir: dir, count: n, seconds: secs };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 给的是 <out> 还是 <out>/frames 都认 */
function framesDirOf(dir) {
  if (!fs.existsSync(dir)) throw new Error('目录不存在:' + dir);
  const hasPng = fs.readdirSync(dir).some((f) => /\.(png|jpe?g|webp)$/i.test(f));
  if (!hasPng && fs.existsSync(path.join(dir, 'frames'))) return path.join(dir, 'frames');
  return dir;
}

async function listFrames(dir) {
  const names = (await fsp.readdir(dir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
  if (!names.length) throw new Error('目录里没有帧:' + dir);
  return names;
}

/** 两张 PNG 的像素差。返回不同像素数、最大通道差、以及第一处不同的坐标 */
async function pixelDiff(fileA, fileB) {
  const { PNG } = await import('pngjs');
  let a, b;
  try { a = PNG.sync.read(await fsp.readFile(fileA)); b = PNG.sync.read(await fsp.readFile(fileB)); }
  catch (e) { return { error: 'PNG 读不出来:' + e.message }; }
  if (a.width !== b.width || a.height !== b.height) {
    return { error: `尺寸不同 ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  }
  let diffPixels = 0, maxChannel = 0, first = null;
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a.data[i + k] - b.data[i + k]));
    if (d) {
      diffPixels++;
      if (d > maxChannel) maxChannel = d;
      if (!first) { const p = i >> 2; first = { x: p % a.width, y: Math.floor(p / a.width) }; }
    }
  }
  return { width: a.width, height: a.height, total: a.width * a.height, diffPixels, maxChannel, first };
}

export async function compare(baselineDir, candidateDir, { maxDiffFrames = 5 } = {}) {
  baselineDir = framesDirOf(baselineDir);
  candidateDir = framesDirOf(candidateDir);
  const A = await listFrames(baselineDir);
  const B = await listFrames(candidateDir);
  console.log(`基线   ${baselineDir}  ${A.length} 帧`);
  console.log(`候选   ${candidateDir}  ${B.length} 帧`);
  const onlyA = A.filter((f) => !B.includes(f));
  const onlyB = B.filter((f) => !A.includes(f));
  if (onlyA.length) console.log(`只在基线里的帧(${onlyA.length}):${onlyA.slice(0, 10).join(', ')}`);
  if (onlyB.length) console.log(`只在候选里的帧(${onlyB.length}):${onlyB.slice(0, 10).join(', ')}`);
  const shared = A.filter((f) => B.includes(f));
  const diffs = [];
  let identical = 0;
  for (const name of shared) {
    const fa = path.join(baselineDir, name), fb = path.join(candidateDir, name);
    const [ba, bb] = await Promise.all([fsp.readFile(fa), fsp.readFile(fb)]);
    if (ba.length === bb.length && ba.equals(bb)) { identical++; continue; }
    diffs.push({ name, shaA: sha256(ba), shaB: sha256(bb), bytesA: ba.length, bytesB: bb.length });
  }
  console.log(`\n逐字节:相同 ${identical}/${shared.length}${diffs.length ? `,不同 ${diffs.length}` : ''}`);
  if (diffs.length) {
    console.log(`第一处不同:${diffs[0].name}`);
    for (const d of diffs.slice(0, maxDiffFrames)) {
      const px = await pixelDiff(path.join(baselineDir, d.name), path.join(candidateDir, d.name));
      const head = `  ${d.name}  ${d.bytesA}B/${d.bytesB}B  sha ${d.shaA.slice(0, 12)}…/${d.shaB.slice(0, 12)}…`;
      if (px.error) console.log(head + '  像素差:' + px.error);
      else console.log(head + `  像素差 ${px.diffPixels}/${px.total}` +
        `(${(px.diffPixels / px.total * 100).toFixed(4)}%)最大通道差 ${px.maxChannel}` +
        (px.first ? ` 首处 (${px.first.x},${px.first.y})` : ''));
    }
    if (diffs.length > maxDiffFrames) console.log(`  …另有 ${diffs.length - maxDiffFrames} 帧不同:${diffs.slice(maxDiffFrames, maxDiffFrames + 20).map((d) => d.name).join(', ')}`);
  }
  const ok = diffs.length === 0 && !onlyA.length && !onlyB.length && A.length === B.length;
  console.log(ok ? '\n✅ 全长导出逐字节相同' : '\n❌ 不通过');
  return { ok, total: shared.length, identical, diffs };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(import.meta.filename, 'utf8').split('*/')[0]);
    process.exit(0);
  }
  try {
    let candidateDir = opts.candidate;
    if (opts.mode === 'run') {
      if (!opts.origin || !opts.project || !opts.out) throw new Error('run 需要 --origin --project --out');
      const r = await runExport(opts);
      candidateDir = r.framesDir;
    }
    if (opts.baseline) {
      if (!candidateDir) throw new Error('compare 需要 --candidate(或先 run)');
      const r = await compare(opts.baseline, candidateDir, { maxDiffFrames: opts.maxDiffFrames });
      process.exit(r.ok ? 0 : 1);
    }
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}
