/**
 * Export end-to-end: starts its own dev server, exports a project JSON completely from the export
 * page, and shuts down the service upon completion.
 *
 *   node scripts/export-e2e.mjs --project <project.json> [--frames a-b] [--determinism] [--media-lib [dir]]
 *
 * | Parameter | Description |
 * |---|---|
 * | `--project <file>` | Required. Timeline- or Project-shaped JSON (has `tracks` at top level). For `.proc`, extract its `project` field first |
 * | `--id <id>` | Export id, defaults to `e2e`. Page URL is `/@export/<id>/project.json` |
 * | `--frames a-b` | Only export this range, also fed to determinism check |
 * | `--video` | Synthesizes `overlay.mov` / `preview.mp4`. Defaults to `--no-video` |
 * | `--determinism` | Concurrently (in parallel) runs `verify-determinism.mjs`: exports same range twice for pixel comparison. Exits 0 only if both pass |
 * | `--media-lib [dir]` | Creates `media` mirror in export dir: assets hardlinked one by one (media dir read-only), defaults to `%USERPROFILE%\Videos\PromptCut\media`. Assets for `/@media/<file>` are resolved from here. Must be on same drive as `--work` |
 * | `--work <dir>` | Export directory (`PROMPTCUT_EXPORT_DIR`), defaults to `%TEMP%\promptcut-e2e\export-<time>` |
 * | `--port N` | Specifies editor port; N, N+1, N+2 must all be free; defaults to picking randomly |
 * | `-- …` | Subsequent args passed as-is to `export-frames.mjs`, e.g. `-- --workers 1 --media ffmpeg` |
 *
 * Layout:
 *
 *   <work>/vite.log                      dev server output
 *   <work>/export-<id>/project.json      project read by page; `--out` is this dir, frames in frames/, audio in audio/
 *   <work>/export-<id>/export.log        export-frames output
 *   <work>/determinism/out/verify-a|b    two passes of determinism check (determines output by cwd)
 *   <work>/media                         hardlink mirror for `--media-lib` (real dir, kept; deleting leaves assets intact)
 *
 * Why it is set up this way:
 *
 * - Export directory is set to a temp dir so test artifacts do not land in user's export directory;
 *   export subprocesses receive the same `PROMPTCUT_EXPORT_DIR`, used by ffmpeg path to find assets.
 * - `--out` must be `export-<id>`: Chrome mix page fetches trimmed audio from `/@export/<id>/audio/`.
 * - All three consecutive ports must be free: each dev server uses +1 and +2 as stage ports.
 *   5190-5192 is the resident instance used by the user.
 * - media uses a hardlink mirror, not a junction: media in the export directory is the editor's
 *   local content store, and the editor writes into it (on-demand fetched assets, imports, bake
 *   images prerendered by Agent, index `index.json`); through a junction, everything would be
 *   written into the user's media directory. Real directory mirror ensures new files land only in
 *   the mirror; asset files are hardlinked, while `index.json` and dot-prefixed metadata are copied.
 *   Junctions left by older versions (force-killed before cleanup) are purged by marker on next run.
 *   The script never deletes export directories.
 * - This script does not inherit external `PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`
 *   (`scripts/lib/no-user-dirs.mjs`); pointing `--work` under user's `Videos\PromptCut` throws an error.
 *
 * Pitfalls:
 *
 * - Do not edit `server/*.ts`, `vite.config.ts`, or `scripts/export-*.mjs` during export (changes by
 *   other sessions also count): dev server will restart, page fails to wait for ready, and export
 *   fails midway. The script logs ⚠ upon detecting a restart.
 * - A discrepancy of dozens of frames in the first pass is mostly font warmup; discard that cold-start
 *   pass; see docs/guides/compare-pitfalls.md for more details.
 */
import './lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
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
      if (i + 1 >= own.length) throw new Error(`${a} must be followed by a value`);
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
    else throw new Error(`Unknown argument ${a} (arguments meant for export-frames go after --)`);
  }
  if (!o.project) throw new Error('--project <project.json> is required');
  if (!/^[A-Za-z0-9_-]+$/.test(o.id)) throw new Error('--id may only contain letters, digits, _ and -');
  if (o.port !== undefined && !(Number.isInteger(o.port) && o.port > 0 && o.port < 65534)) throw new Error('--port must be a port number');
  return o;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`${e.message}\nUsage: see the header of scripts/export-e2e.mjs`);
  process.exit(2);
}

const work = path.resolve(opts.work || path.join(DEFAULT_ROOT, `export-${stamp()}`));
const outDir = path.join(work, `export-${opts.id}`);
const mediaMirror = path.join(work, 'media');

/* ---------------- Teardown: child processes → dev server ---------------- */

const children = new Set();
let server = null;
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  // First stop processes using the assets, then dismantle the links beneath them
  for (const c of children) if (c.exitCode === null) killTree(c.pid);
  if (server) { server.stop(); log('dev server stopped'); }
}

process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => { log(`Received ${sig}, wrapping up`); cleanup(); process.exit(130); });
}
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });

/* ---------------- Child process: prefix output to console, write raw copy to log ---------------- */

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
    const hint = Array.isArray(project?.project?.tracks) ? 'Looks like a .proc; save its project field as a separate JSON and pass that instead' : 'no tracks array at the top level';
    throw new Error(`${opts.project} is not a Timeline / Project shape: ${hint}`);
  }
  const libraryRefs = JSON.stringify(project).match(/"\/@media\//g)?.length || 0;
  if (libraryRefs && !opts.mediaLib) log(`⚠ the project references ${libraryRefs} /@media/ assets but --media-lib was not given, so these assets can't be fetched`);

  // Default root directory, plus the level where custom --work resides (when reusing the same
  // --work, links from the previous run are here)
  for (const root of new Set([DEFAULT_ROOT, path.dirname(work)])) {
    for (const link of sweepStaleJunctions(root)) log(`Removed junctions left behind by the last forced kill: ${link}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'project.json'), JSON.stringify(project));
  log(`Export directory ${work}`);

  if (opts.mediaLib) {
    const n = mirrorMediaLibrary(opts.mediaLib, mediaMirror);
    log(`media ← ${path.resolve(opts.mediaLib)} (${n.linked} hard-linked, ${n.copied} metadata copied${n.skipped ? `, ${n.skipped} links skipped` : ''}; asset directory read-only)`);
  }

  const env = { PROMPTCUT_EXPORT_DIR: work };
  assertNoUserExportDir(env, 'export directory of export-e2e');
  const started = Date.now();
  server = await startDevServer({ env, logFile: path.join(work, 'vite.log'), port: opts.port, log });
  log(`dev server ready ${server.origin} (stages ${server.stagePorts.join(' / ')}, ${((Date.now() - started) / 1000).toFixed(1)}s)`);

  const url = `${server.origin}/?export=1&timeline=/@export/${opts.id}/project.json`;
  const frames = opts.frames ? ['--frames', opts.frames] : [];
  const exportArgs = [path.join(REPO, 'scripts', 'export-frames.mjs'), '--url', url, '--out', outDir, ...frames,
    ...(opts.video ? [] : ['--no-video']), ...opts.passthrough];
  log(`Export: node scripts/export-frames.mjs ${exportArgs.slice(1).join(' ')}`);

  const jobs = [run('export', exportArgs, { cwd: REPO, env, logFile: path.join(outDir, 'export.log') })];
  if (opts.determinism) {
    const detDir = path.join(work, 'determinism');
    fs.mkdirSync(detDir, { recursive: true });
    log('Determinism: node scripts/verify-determinism.mjs (parallel, output in determinism/out/)');
    jobs.push(run('determinism', [path.join(REPO, 'scripts', 'verify-determinism.mjs'), '--url', url, ...frames],
      { cwd: detDir, env, logFile: path.join(detDir, 'determinism.log') }));
  }
  const [exportCode, detCode] = await Promise.all(jobs);

  const restarts = server.restarts();
  log('-- Result --');
  log(`Export: ${exportCode === 0 ? 'done' : `failed (exit code ${exportCode})`}, ${countFrames(path.join(outDir, 'frames'))} frames → ${path.join(outDir, 'frames')}`);
  if (opts.video && exportCode === 0) log(`Final video: ${path.join(outDir, 'preview.mp4')}`);
  if (opts.determinism) log(`Determinism: ${detCode === 0 ? 'two passes pixel-identical' : `failed (exit code ${detCode}), see the [determinism] output above for details`}`);
  if (restarts) log(`⚠ dev server restarted ${restarts} times during the run, results may be unreliable`);
  return exportCode === 0 && (!opts.determinism || detCode === 0) ? 0 : 1;
}

main()
  // If exitCode was set to 1 elsewhere, do not overwrite it with 0 from "export succeeded"
  .then((code) => { cleanup(); process.exit(process.exitCode || code); })
  .catch((e) => { console.error(`[export-e2e] ✖ ${e.message}`); cleanup(); process.exit(1); });
