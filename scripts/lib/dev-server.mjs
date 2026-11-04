/**
 * Two things shared by test scripts, not run standalone:
 *
 *   1. Start its **own** dev server on a range of free ports, tearing it down together with child
 *      processes when finished (used by `scripts/export-e2e.mjs` and `scripts/review-loop-run.mjs`);
 *   2. media asset catalog: hard link mirror (`mirrorMediaLibrary`, used by `export-e2e.mjs`);
 *      the legacy junction is only used for cleaning up links left behind after being force-killed
 *      last time (functions that create links or only unlink are kept for gatekeeper tests).
 *
 * Neither this module nor the dev server it starts inherits external `PROMPTCUT_EXPORT_DIR` /
 * `PROMPTCUT_DATA_DIR` (`no-user-dirs.mjs`); it throws directly if a caller explicitly passes a
 * directory pointing to the user's `Videos\PromptCut`.
 *
 * Ports: each dev server takes "port + 1" and "port + 2" as stage ports; all three consecutive ports
 * must be free; if occupied, the page falls back to same-origin single stage, which is not the normal
 * form to test. 5190-5192 is the resident instance for the user, do not touch.
 */
import './no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import fs from 'node:fs';
import { assertNoUserExportDir } from './user-dirs.mjs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Resident dev server for the user (`npm run dev`) and its two stage ports */
const RESERVED = new Set([5190, 5191, 5192]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A worktree has no node_modules of its own (dependencies resolve upward to the main repo);
 * vite's exports does not allow bin, so resolve the main entry and navigate back to package root
 */
export function viteBin() {
  const local = path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

export function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** Editor port and its two stage ports */
export const portTriple = (port) => [port, port + 1, port + 2];

export async function tripleFree(port) {
  for (const p of portTriple(port)) if (!(await portFree(p))) return false;
  return true;
}

/**
 * Pick an editor port where all three consecutive numbers are free. Pick randomly above 20000:
 * both Node's fetch and Chrome reject a "bad port" blocklist (the highest is 10080), which is
 * bypassed by design (by picking above 20000).
 */
export async function pickPort(tries = 50) {
  for (let i = 0; i < tries; i++) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    if (await tripleFree(port)) return port;
  }
  throw new Error('Could not find three consecutive free ports');
}

export async function waitHttp(url, pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (pred(data)) return data;
      }
    } catch {}
    await sleep(400);
  }
  throw new Error(`${label} timed out (${Math.round(timeoutMs / 1000)}s)`);
}

/**
 * Kill together with child processes (vite also has prerender processes and Chrome attached).
 * Executes synchronously, usable in exit hooks as well
 */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

/**
 * Start a dev server.
 *
 * @param {object} o
 * @param {Record<string,string>} [o.env]  Additional environment variables (export directory, data directory, etc.)
 * @param {boolean} [o.online]             Start as the **online browser mode** instance
 *   (equivalent to `VITE_PC_ONLINE=1`):
 *   The page takes the online branch (`ONLINE` in `src/online/mode.ts`, `OnlineStartPage` in `StartPage.tsx`).
 *   Provided as a flag rather than letting callers write the env var themselves: the name is only
 *   recognized in one place, so typos won't silently start the desktop app instance.
 *   Variables of the same name explicitly set in `env` still override it.
 * @param {string} o.logFile               vite output is written here
 * @param {number} [o.port]                Specify editor port; randomly picked if omitted;
 *   retries with another range if stage ports fail to start completely
 * @param {(msg: string) => void} [o.log]
 * @returns {Promise<{ port: number, origin: string, stagePorts: number[], pid: number, restarts: () => number, exited: () => boolean, stop: () => void }>}
 */
export async function startDevServer({ env = {}, online = false, logFile, port, log = () => {} }) {
  const startEnv = online ? { VITE_PC_ONLINE: '1', ...env } : env;
  if (port) {
    const clash = portTriple(port).filter((p) => RESERVED.has(p));
    if (clash.length) throw new Error(`Port ${clash.join(', ')} belongs to the user's long-running dev server, pick another`);
  }
  const attempts = port ? 1 : 3;
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    const p = port || (await pickPort());
    if (port && !(await tripleFree(p))) throw new Error(`Ports ${portTriple(p).join(' / ')} are not all free`);
    try {
      return await startOnce(p, startEnv, logFile, log);
    } catch (e) {
      lastError = e;
      log(`Port ${p} failed to start: ${e.message}`);
    }
  }
  throw lastError;
}

async function startOnce(port, env, logFile, log) {
  assertNoUserExportDir(env, 'dev server');
  const origin = `http://127.0.0.1:${port}`;
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const child = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: REPO,
    env: { ...process.env, BROWSER: 'none', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let exited = false;
  let restarts = 0;
  const onData = (chunk) => {
    logStream.write(chunk);
    // If server/*.ts or vite.config.ts is modified during measurement, vite restarts entirely:
    // the page disconnects, and chats in progress are cut off
    const text = chunk.toString();
    const n = (text.match(/server restarted/gi) || []).length;
    if (n) { restarts += n; log(`⚠ dev server restarted (${restarts} times in total): most likely someone changed server/ or vite.config.ts`); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', () => { exited = true; logStream.end(); });

  const stop = () => {
    if (!exited) killTree(child.pid);
  };
  try {
    await Promise.race([
      waitHttp(`${origin}/api/mcp/status`, (d) => d && typeof d.port === 'number', 120000, 'waiting for dev server to start'),
      new Promise((_, reject) => child.once('exit', (code) => reject(new Error(`vite exited early (code ${code}), see ${logFile}`)))),
    ]);
    const stage = await fetch(`${origin}/api/stage/ports`).then((r) => r.json());
    const stagePorts = Array.isArray(stage?.ports) ? stage.ports : [];
    if (stagePorts.length < (stage?.count ?? 2)) {
      throw new Error(`Only ${stagePorts.length} stage ports came up (${portTriple(port).slice(1).join(' / ')} has some in use), the page will fall back to a single same-origin stage`);
    }
    return { port, origin, stagePorts, pid: child.pid, restarts: () => restarts, exited: () => exited, stop };
  } catch (e) {
    stop();
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * media junction
 *
 * media in the export directory points to the user's asset catalog. The danger lies in "delete":
 * deleting recursively along the junction deletes the user's assets themselves. Here only two
 * actions are provided: creating links and unlinking only, and before unlinking, verify that it
 * is indeed the link we created; after unlinking, verify that it is truly gone and the target
 * still exists. If verification fails, throw directly; the caller must not delete anything else.
 * ------------------------------------------------------------------ */

const MARKER = '.media-junction.json';

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Create a junction at link pointing to target, and write a marker in the same directory
 * (recording link, target, and pid for cleanup after a force kill)
 */
export function createJunction(link, target) {
  const abs = path.resolve(target);
  const st = lstatOrNull(abs);
  if (!st || !st.isDirectory()) throw new Error(`Asset directory does not exist: ${abs}`);
  if (lstatOrNull(link)) throw new Error(`${link} already exists, not creating a junction over it`);
  fs.symlinkSync(abs, link, 'junction');
  fs.writeFileSync(path.join(path.dirname(link), MARKER), JSON.stringify({ link: path.resolve(link), target: abs, pid: process.pid, createdAt: new Date().toISOString() }, null, 2));
}

/**
 * Only unlinks, does not touch the target.
 *
 * fs.unlinkSync on a junction deletes the link itself; for a real directory, libuv rejects directly
 * (EPERM), so this step is non-recursive by design. It is the same as
 * [System.IO.Directory]::Delete(<junction>) in PowerShell.
 *
 * @param {string} link
 * @param {string} [expectTarget] If provided, verify the link indeed points to it; do not unlink otherwise
 * @returns {boolean} Returns true if unlinked; false if it did not exist in the first place
 */
export function removeJunction(link, expectTarget) {
  const st = lstatOrNull(link);
  if (!st) return false;
  if (!st.isSymbolicLink()) throw new Error(`${link} is not a link, leaving it alone`);
  const target = fs.readlinkSync(link);
  if (expectTarget && !samePath(target, expectTarget)) throw new Error(`${link} points to ${target}, not ${expectTarget}, leaving it alone`);
  fs.unlinkSync(link);
  if (lstatOrNull(link)) throw new Error(`${link} still exists after teardown`);
  if (!lstatOrNull(target)) throw new Error(`Target ${target} is gone after removing the link`);
  return true;
}

/** Unlink according to the marker; delete the marker only after unlinking succeeds */
export function removeMarkedJunction(dir) {
  const marker = path.join(dir, MARKER);
  let info;
  try { info = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { return false; }
  const removed = removeJunction(info.link, info.target);
  fs.rmSync(marker, { force: true });
  return removed;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Clean up links that were not unlinked in time when force-killed last time (Task Manager end task,
 * taskkill /F). Only inspects markers in the directory one level below root; leaves it untouched
 * if the process that created it is still alive.
 * @returns {string[]} Unlinked paths
 */
export function sweepStaleJunctions(root) {
  const removed = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return removed; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const marker = path.join(dir, MARKER);
    let info;
    try { info = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { continue; }
    if (info.pid && info.pid !== process.pid && alive(info.pid)) continue;
    if (removeMarkedJunction(dir)) removed.push(info.link);
  }
  return removed;
}

/* ------------------------------------------------------------------ *
 * media hard link mirror
 *
 * Another problem with junction lies in "writes": media in the export directory is the editor's
 * local content store (`<PROMPTCUT_EXPORT_DIR>/media`); on-demand fetches, imports, baked images
 * from Agent prerenders, and index `index.json` all write files into it, which through junction
 * were all written into the user's asset catalog (default `%USERPROFILE%\Videos\PromptCut\media`).
 * The mirror is changed to a real directory: asset files are hard-linked one by one (takes no extra
 * space, reads the exact same bytes), while `index.json` and dot-prefixed metadata files are copied.
 * Files newly written by the editor afterwards only land in the mirror; deleting the mirror only
 * removes links without touching the assets themselves (deleting one hard link does not affect
 * the other).
 *
 * Limitation: hard links require both sides to be on the same drive; if not on the same drive, throw
 * directly so the caller moves export directory to the drive hosting assets, without falling back
 * to junction. Assets are named by content hash and written once without in-place modification,
 * so the shared bytes won't be mutated by the mirror side.
 * ------------------------------------------------------------------ */

/** Files copied rather than hard-linked: metadata that will be modified in place by the editor */
const COPY_NOT_LINK = (name) => name === 'index.json' || name.startsWith('.');

/**
 * Create a real directory at dest, hard-linking files from src one by one (recursing into
 * subdirectories), and copying metadata files. Links in src (junctions, symbolic links) are
 * skipped without following.
 * @param {string} src  Asset catalog (read-only)
 * @param {string} dest Mirror directory, must not already exist
 * @returns {{ linked: number, copied: number, skipped: number }}
 */
export function mirrorMediaLibrary(src, dest) {
  const from = path.resolve(src);
  const st = lstatOrNull(from);
  if (!st || !st.isDirectory()) throw new Error(`Asset directory does not exist: ${from}`);
  if (lstatOrNull(dest)) throw new Error(`${dest} already exists, not creating a mirror over it`);
  const counts = { linked: 0, copied: 0, skipped: 0 };
  const walk = (a, b) => {
    fs.mkdirSync(b, { recursive: true });
    for (const e of fs.readdirSync(a, { withFileTypes: true })) {
      const s = path.join(a, e.name);
      const d = path.join(b, e.name);
      if (e.isSymbolicLink()) { counts.skipped++; continue; }
      if (e.isDirectory()) { walk(s, d); continue; }
      if (!e.isFile()) { counts.skipped++; continue; }
      if (COPY_NOT_LINK(e.name)) { fs.copyFileSync(s, d); counts.copied++; continue; }
      try {
        fs.linkSync(s, d);
        counts.linked++;
      } catch (err) {
        if (err.code === 'EXDEV') throw new Error(`Hard links require the export directory and asset directory to be on the same drive: ${from} → ${dest}. Use --work to point the export directory at the drive holding the assets`);
        throw err;
      }
    }
  };
  walk(from, dest);
  return counts;
}

/** 2026-09-23T15:30:12 → 20260923-153012, used for default directory names */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
