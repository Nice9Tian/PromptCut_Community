/**
 * 导出端到端:自己起一台 dev server,把一份项目 JSON 从导出页完整导一遍,收工时连服务一起关掉。
 *
 *   node scripts/export-e2e.mjs --project <project.json> [--frames a-b] [--determinism] [--media-lib [目录]]
 *
 * | 参数 | 说明 |
 * |---|---|
 * | `--project <文件>` | 必填。Timeline 或 Project 形状的 JSON(顶层有 `tracks`)。`.proc` 要先取出它的 `project` 字段 |
 * | `--id <id>` | 导出 id,默认 `e2e`。页面地址是 `/@export/<id>/project.json` |
 * | `--frames a-b` | 只导这一段,同时交给确定性检查 |
 * | `--video` | 合成 `overlay.mov` / `preview.mp4`。默认 `--no-video` |
 * | `--determinism` | 同时(并行)跑 `verify-determinism.mjs`:同一段导两遍逐像素比。两边都过才退出 0 |
 * | `--media-lib [目录]` | 在导出目录里建 `media` 镜像:素材逐个硬链接进来(素材目录只读),默认取 `%USERPROFILE%\Videos\PromptCut\media`。项目里 `/@media/<文件>` 的素材从这里取。要和 `--work` 在同一个盘 |
 * | `--work <目录>` | 导出目录(`PROMPTCUT_EXPORT_DIR`),默认 `%TEMP%\promptcut-e2e\export-<时间>` |
 * | `--port N` | 指定编辑器端口,N、N+1、N+2 都得空;默认随机挑 |
 * | `-- …` | 之后的参数原样交给 `export-frames.mjs`,如 `-- --workers 1 --media ffmpeg` |
 *
 * 目录:
 *
 *   <work>/vite.log                      dev server 的输出
 *   <work>/export-<id>/project.json      页面读的项目;`--out` 就是这个目录,帧在 frames/,音频在 audio/
 *   <work>/export-<id>/export.log        export-frames 的输出
 *   <work>/determinism/out/verify-a|b    确定性检查的两趟(它按工作目录定输出位置)
 *   <work>/media                         `--media-lib` 时的硬链接镜像(真目录,留着;删它不动素材本身)
 *
 * 为什么这样搭:
 *
 * - 导出目录设成临时目录,测试产物不落进用户的导出目录;导出子进程也拿同一个
 *   `PROMPTCUT_EXPORT_DIR`,ffmpeg 那条路按它找素材。
 * - `--out` 必须就是 `export-<id>`:Chrome 混音页从 `/@export/<id>/audio/` 取裁好的音频。
 * - 端口三个连号都要空着:每台 dev server 另占 +1、+2 当舞台端口。5190~5192 是用户常驻的那台。
 * - media 用硬链接镜像,不用 junction:导出目录里的 media 就是编辑器的本地内容库,编辑器会往里写
 *   (按需拉取的素材、导入、Agent 预渲染的 bake 图、索引 `index.json`),经 junction 就全写进了用户的素材目录。
 *   镜像是真目录,新写的文件只落在镜像里;素材文件是硬链接,`index.json` 与点开头的元数据是复制的。
 *   旧版本留下的 junction(被强杀没来得及拆的)下次运行时按标记清掉。脚本从不删导出目录。
 * - 本脚本不继承外部的 `PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`(`scripts/lib/no-user-dirs.mjs`),
 *   `--work` 指到用户的 `Videos\PromptCut` 下面直接报错。
 *
 * 坑:
 *
 * - 导出期间别改 `server/*.ts`、`vite.config.ts`、`scripts/export-*.mjs`(别的会话改也算):
 *   dev server 会重启,页面等不到就绪,导出中途失败。脚本看到重启会打 ⚠。
 * - 比对第一趟差几十帧多半是字体预热,丢掉冷启动那一趟;更多见 docs/guides/compare-pitfalls.md。
 */
import './lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO, startDevServer, killTree, mirrorMediaLibrary, sweepStaleJunctions, stamp } from './lib/dev-server.mjs';
import { assertNoUserExportDir } from './lib/user-dirs.mjs';

const DEFAULT_ROOT = path.join(os.tmpdir(), 'promptcut-e2e');
const DEFAULT_MEDIA = path.join(os.homedir(), 'Videos', 'PromptCut', 'media');

const log = (msg) => console.log(`[export-e2e] ${msg}`);

function parseArgs(argv) {
  const dash = argv.indexOf('--');
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const passthrough = dash === -1 ? [] : argv.slice(dash + 1);
  const o = { id: 'e2e', passthrough };
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    const next = () => {
      if (i + 1 >= own.length) throw new Error(`${a} 后面要跟一个值`);
      return own[++i];
    };
    if (a === '--project') o.project = next();
    else if (a === '--id') o.id = next();
    else if (a === '--frames') o.frames = next();
    else if (a === '--video') o.video = true;
    else if (a === '--determinism') o.determinism = true;
    else if (a === '--media-lib') o.mediaLib = own[i + 1] && !own[i + 1].startsWith('--') ? own[++i] : DEFAULT_MEDIA;
    else if (a === '--work') o.work = next();
    else if (a === '--port') o.port = Number(next());
    else throw new Error(`不认识的参数 ${a}(要交给 export-frames 的参数放在 -- 后面)`);
  }
  if (!o.project) throw new Error('要给 --project <project.json>');
  if (!/^[A-Za-z0-9_-]+$/.test(o.id)) throw new Error('--id 只能用字母、数字、_ 和 -');
  if (o.port !== undefined && !(Number.isInteger(o.port) && o.port > 0 && o.port < 65534)) throw new Error('--port 要是一个端口号');
  return o;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`${e.message}\n用法见 scripts/export-e2e.mjs 文件头`);
  process.exit(2);
}

const work = path.resolve(opts.work || path.join(DEFAULT_ROOT, `export-${stamp()}`));
const outDir = path.join(work, `export-${opts.id}`);
const mediaMirror = path.join(work, 'media');

/* ---------------- 收工:子进程 → dev server ---------------- */

const children = new Set();
let server = null;
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  // 先停用着素材的进程,再拆它们脚下的链接
  for (const c of children) if (c.exitCode === null) killTree(c.pid);
  if (server) { server.stop(); log('已关 dev server'); }
}

process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => { log(`收到 ${sig},收工`); cleanup(); process.exit(130); });
}
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });

/* ---------------- 子进程:输出加前缀转到控制台,原样落一份日志 ---------------- */

function run(label, args, { cwd, env, logFile }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    const file = fs.createWriteStream(logFile, { flags: 'a' });
    for (const stream of [child.stdout, child.stderr]) {
      let rest = '';
      stream.on('data', (chunk) => {
        file.write(chunk);
        const lines = (rest + chunk.toString()).split(/\r?\n/);
        rest = lines.pop();
        for (const line of lines) console.log(`[${label}] ${line}`);
      });
      stream.on('end', () => { if (rest) console.log(`[${label}] ${rest}`); });
    }
    child.on('exit', (code) => { children.delete(child); file.end(); resolve(code ?? 1); });
  });
}

const countFrames = (dir) => {
  try { return fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).length; } catch { return 0; }
};

async function main() {
  const project = JSON.parse(fs.readFileSync(opts.project, 'utf8'));
  if (!Array.isArray(project?.tracks)) {
    const hint = Array.isArray(project?.project?.tracks) ? '看起来是 .proc,把它的 project 字段另存成一份 JSON 再给' : '顶层没有 tracks 数组';
    throw new Error(`${opts.project} 不是 Timeline / Project 形状:${hint}`);
  }
  const libraryRefs = JSON.stringify(project).match(/"\/@media\//g)?.length || 0;
  if (libraryRefs && !opts.mediaLib) log(`⚠ 项目引用了 ${libraryRefs} 处 /@media/ 素材,没带 --media-lib,这些素材取不到`);

  // 默认根目录,加上自定的 --work 所在的那一层(同一个 --work 反复用时,上次的链接就在这里)
  for (const root of new Set([DEFAULT_ROOT, path.dirname(work)])) {
    for (const link of sweepStaleJunctions(root)) log(`清掉上次被强杀留下的 junction:${link}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'project.json'), JSON.stringify(project));
  log(`导出目录 ${work}`);

  if (opts.mediaLib) {
    const n = mirrorMediaLibrary(opts.mediaLib, mediaMirror);
    log(`media ← ${path.resolve(opts.mediaLib)}(硬链接 ${n.linked} 个、复制 ${n.copied} 个元数据${n.skipped ? `、跳过 ${n.skipped} 个链接` : ''};素材目录只读)`);
  }

  const env = { PROMPTCUT_EXPORT_DIR: work };
  assertNoUserExportDir(env, 'export-e2e 的导出目录');
  const started = Date.now();
  server = await startDevServer({ env, logFile: path.join(work, 'vite.log'), port: opts.port, log });
  log(`dev server 就绪 ${server.origin}(舞台 ${server.stagePorts.join(' / ')},${((Date.now() - started) / 1000).toFixed(1)}s)`);

  const url = `${server.origin}/?export=1&timeline=/@export/${opts.id}/project.json`;
  const frames = opts.frames ? ['--frames', opts.frames] : [];
  const exportArgs = [path.join(REPO, 'scripts', 'export-frames.mjs'), '--url', url, '--out', outDir, ...frames,
    ...(opts.video ? [] : ['--no-video']), ...opts.passthrough];
  log(`导出:node scripts/export-frames.mjs ${exportArgs.slice(1).join(' ')}`);

  const jobs = [run('export', exportArgs, { cwd: REPO, env, logFile: path.join(outDir, 'export.log') })];
  if (opts.determinism) {
    const detDir = path.join(work, 'determinism');
    fs.mkdirSync(detDir, { recursive: true });
    log('确定性:node scripts/verify-determinism.mjs(并行,输出在 determinism/out/)');
    jobs.push(run('determinism', [path.join(REPO, 'scripts', 'verify-determinism.mjs'), '--url', url, ...frames],
      { cwd: detDir, env, logFile: path.join(detDir, 'determinism.log') }));
  }
  const [exportCode, detCode] = await Promise.all(jobs);

  const restarts = server.restarts();
  log('—— 结果 ——');
  log(`导出:${exportCode === 0 ? '完成' : `失败(退出码 ${exportCode})`},${countFrames(path.join(outDir, 'frames'))} 帧 → ${path.join(outDir, 'frames')}`);
  if (opts.video && exportCode === 0) log(`成片:${path.join(outDir, 'preview.mp4')}`);
  if (opts.determinism) log(`确定性:${detCode === 0 ? '两趟逐像素相同' : `没过(退出码 ${detCode}),明细见上面 [determinism] 的输出`}`);
  if (restarts) log(`⚠ 期间 dev server 重启过 ${restarts} 次,结果可能不可信`);
  return exportCode === 0 && (!opts.determinism || detCode === 0) ? 0 : 1;
}

main()
  // 别处已把 exitCode 置 1 的,不能被「导出成功」的 0 盖掉
  .then((code) => { cleanup(); process.exit(process.exitCode || code); })
  .catch((e) => { console.error(`[export-e2e] ✖ ${e.message}`); cleanup(); process.exit(1); });
