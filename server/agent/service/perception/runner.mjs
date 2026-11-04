/**
 * Common implementation for Cloud Agent service spawning child processes (Python, ffmpeg): spawn
 * as a killable tree, kill the entire tree, wait until actual exit + close, and register into the
 * run resources registry; also Python isolated mode command line.
 *
 * Used by: `workspace.mjs`'s `spawn()` (entry for all restricted child processes),
 * `perception/stt.mjs`, `perception/subject.mjs`, `perception/track.mjs`, `hosted-collect.mjs`;
 * used by `hosted-audio.mjs` via `workspace.spawn()`.
 *
 * Process tree:
 *   - Linux / macOS: Child process is spawned as leader of a new process group (`detached: true`);
 *     killing kills by group (`kill(-pid)`): ffmpeg and pip spawned by Python are in this group
 *     and die together. If the leader exits first while processes remain in the group
 *     (grandchildren holding pipes without exiting), still kill by group; when the leader exits,
 *     sweep the group once more to leave no orphans. No signals sent after both `exit` and `close`
 *     arrive (PID may have been reused by another process).
 *   - Windows: No process groups; uses `taskkill /F /T /PID` (kills entire tree by parent-child
 *     relationship). It only finds the entire tree while the root process is still alive;
 *     grandchildren left after the root process exits first cannot be recovered by PID on Windows
 *     (production nodes are Linux, not affected by this).
 *
 * Python isolated mode: `-I` ignores PYTHON* environment variables, and excludes current directory
 * and user site from module search paths. The child's working directory is the chat workspace,
 * containing files brought in by members and the model, which must not enter search paths. Package
 * and third-party library directories come only from deployment configuration, inserted at the
 * front of search paths via short bootstrap code. Under `-I`, PYTHONPATH, PYTHONUTF8,
 * PYTHONIOENCODING, PYTHONUNBUFFERED, and PYTHONDONTWRITEBYTECODE do not take effect; replaced with
 * `-X utf8 -u -B`.
 *
 * This file uses only the Node standard library and references no other files in the repository:
 * `cloud/scripts/probes/cloud-tools-spawn-linux-demo.mjs` can run by copying just this file to a node.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';

/** Child process → status of its tree. Only those spawned with `spawnTree` are in it */
const TREES = new WeakMap();

/** Kill entire tree by parent-child relationship on Windows. Use system directory one, not via PATH */
function runTaskkill(pid) {
  const exe = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  return nodeSpawn(exe, ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
}

/**
 * Spawn a child process as root of a tree: no popup window, not via shell; on non-Windows it is
 * the leader of a new process group.
 * The returned `child.kill()` is replaced with killing the entire tree (`killTree`), so any code
 * holding it (including legacy code that only calls `child.kill()`) kills the entire tree.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ cwd?: string, env?: Record<string, string>, stdio?: any }} [options]
 * @param {{ spawnImpl?: typeof nodeSpawn, platform?: string, processKill?: (pid: number, signal?: string | number) => void, taskkill?: (pid: number) => import('node:events').EventEmitter }} [deps]
 *   `spawnImpl` is for tests to replace; `platform`, `processKill`, `taskkill` are only for unit
 *   tests (taking another platform's branch on one platform)
 */
export function spawnTree(command, args = [], options = {}, { spawnImpl = nodeSpawn, platform = process.platform, processKill = process.kill.bind(process), taskkill = runTaskkill } = {}) {
  const grouped = platform !== 'win32';
  const child = spawnImpl(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    detached: grouped,
  });
  const state = {
    pid: child.pid, grouped, processKill, taskkill,
    rawKill: typeof child.kill === 'function' ? child.kill.bind(child) : () => false,
    exited: false, closed: false, failed: false, killing: false,
  };
  TREES.set(child, state);
  child.once('exit', () => {
    state.exited = true;
    // Group leader exited: clean up remaining processes in the group (spawned grandchildren it didn't
    // wait on). If the group is already empty (ESRCH), ignore it
    if (state.grouped && state.pid) { try { state.processKill(-state.pid, 'SIGKILL'); } catch { /* No more processes in the group */ } }
  });
  child.once('close', () => { state.closed = true; });
  child.once('error', () => { if (!child.pid) state.failed = true; });
  child.kill = (signal) => killTree(child, signal);
  return child;
}

/** Whether the root of this tree has already `exit` and `close` (or never started at all) */
export function treeSettled(child) {
  const state = TREES.get(child);
  if (!state) return child?.exitCode !== null && child?.exitCode !== undefined;
  return state.failed || (state.exited && state.closed);
}

/**
 * Kill the entire process tree. Child processes not spawned by `spawnTree` fall back to their own
 * `kill`.
 * Non-Windows: send signal to entire process group (default SIGKILL). Windows: `taskkill /F /T`,
 * ignores signals.
 * @returns {boolean} Whether sent (synchronous return value like `child.kill()`; check
 *   `whenClosed` for whether it actually exited)
 */
export function killTree(child, signal = 'SIGKILL') {
  if (!child) return false;
  const state = TREES.get(child);
  if (!state) { try { return child.kill(signal) !== false; } catch { return false; } }
  const raw = () => { try { return state.rawKill('SIGKILL') !== false; } catch { return false; } };
  if (state.failed || (state.exited && state.closed)) return false;
  if (!state.pid) return raw();
  if (state.grouped) {
    try { state.processKill(-state.pid, signal ?? 'SIGKILL'); return true; }
    catch { return state.exited ? false : raw(); }
  }
  // Windows: if the root process has already exited, there is no tree to find
  if (state.exited) return false;
  if (state.killing) return true;
  state.killing = true;
  const done = () => { state.killing = false; };
  try {
    const killer = state.taskkill(state.pid);
    killer.once('error', () => { done(); if (!state.exited) raw(); });
    // Non-zero exit code: kill failed (or process is already gone); fall back to killing root only
    // if it is still alive
    killer.once('exit', (code) => { done(); if (code !== 0 && !state.exited) raw(); });
    return true;
  } catch { done(); return raw(); }
}

/**
 * Wait until a child process is truly cleaned up: both `exit` and `close` have arrived (standard
 * streams also closed), or it never started at all (only `error`).
 * @returns {Promise<{ code: number | null, signal: string | null, spawnError: Error | null }>}
 */
export function whenClosed(child) {
  return new Promise((resolve) => {
    let exited = child.exitCode !== null || child.signalCode !== null;
    let closed = false;
    let spawnError = null;
    let code = child.exitCode ?? null;
    let signal = child.signalCode ?? null;
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve({ code, signal, spawnError }); } };
    if (TREES.get(child)?.closed && exited) return finish();
    child.once('exit', (c, s) => { exited = true; code = c; signal = s; if (closed) finish(); });
    child.once('close', (c, s) => { closed = true; code = c ?? code; signal = s ?? signal; exited = true; finish(); });
    child.once('error', (error) => {
      spawnError ??= error;
      // Never started: Node only emits error (some versions then emit close), never emits exit
      if (!child.pid) setImmediate(finish);
    });
  });
}

/**
 * Shell for run resources registry (`run-resources.mjs`, kind `child`): `kill()` kills the entire
 * tree; counts as closed only when both `exit` and `close` have arrived; also synthesizes both
 * events if it failed to start, preventing the registry from waiting indefinitely.
 */
export function treeResource(child) {
  const handle = new EventEmitter();
  let exited = false;
  let closed = false;
  const fireExit = () => { if (!exited) { exited = true; handle.emit('exit'); } };
  const fireClose = () => { fireExit(); if (!closed) { closed = true; handle.emit('close'); } };
  child.once('exit', fireExit);
  child.once('close', fireClose);
  child.once('error', () => { if (!child.pid) setImmediate(fireClose); });
  handle.kill = () => killTree(child);
  return handle;
}

/**
 * Supervise a started child process until its entire tree is cleaned up.
 *
 *   - If `resources` and `context` are provided: register into run resources registry: when this
 *     round is stopped, made private, Agent shut down, or service shut down, registry kills
 *     entire tree; if registration is rejected (no permissions for this round), kill it, wait for
 *     cleanup, then rethrow the registry error;
 *   - `timeoutMs`: kill the entire tree on timeout; `timedOut` is true in result;
 *   - `signal`: external cancellation signal; kill the entire tree once fired;
 *   - `onStdout` / `onStderr`: output callbacks. Even if not provided, pipes are drained (otherwise
 *     `close` never arrives).
 *
 * Processes that never started (no PID) are not registered: no process to kill, `done` carries
 * `spawnError`.
 *
 * @param {import('node:child_process').ChildProcess} child Spawned by `spawnTree` (or `workspace.spawn()`)
 * @param {object} [o]
 * @returns {Promise<{ child: object, pid: number | undefined, kill(): boolean, signal: AbortSignal | null,
 *   done: Promise<{ code: number | null, signal: string | null, timedOut: boolean, aborted: boolean, spawnError: Error | null }> }>} 
 *   `done` resolves only after child `exit` + `close` and registry also sees it closed; never rejects
 */
export async function superviseChild(child, { resources = null, context = null, timeoutMs = 0, signal = null, onStdout = null, onStderr = null } = {}) {
  const closed = whenClosed(child);
  if (child.stdout) { if (onStdout) child.stdout.on('data', onStdout); else child.stdout.resume(); }
  if (child.stderr) { if (onStderr) child.stderr.on('data', onStderr); else child.stderr.resume(); }
  const kill = () => killTree(child);
  let timedOut = false;
  let externalAbort = false;

  if (child.pid === undefined) {
    const end = await closed;
    return { child, pid: undefined, kill, signal: null, done: Promise.resolve({ code: end.code, signal: end.signal, timedOut: false, aborted: false, spawnError: end.spawnError ?? new Error('spawn-failed') }) };
  }

  let registration = null;
  if (resources) {
    try {
      registration = await resources.register(context, { kind: 'child', resource: treeResource(child) });
    } catch (error) {
      // On registration failure, the registry already killed and waited for it; double-check here as
      // insurance
      kill();
      await closed;
      throw error;
    }
  }

  let timer = null;
  if (Number(timeoutMs) > 0) {
    timer = setTimeout(() => { timedOut = true; kill(); }, Number(timeoutMs));
    timer.unref?.();
  }
  const onAbort = () => { externalAbort = true; kill(); };
  if (signal) {
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  }
  if (registration?.signal.aborted) kill();

  const done = (async () => {
    const end = await closed;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (registration) await registration.closed;
    return {
      code: end.code, signal: end.signal, timedOut,
      aborted: externalAbort || registration?.signal.aborted === true,
      spawnError: end.spawnError,
    };
  })();
  return { child, pid: child.pid, kill, signal: registration?.signal ?? signal ?? null, done };
}

/**
 * Whether alive processes remain in the process group (meaningful only on non-Windows): used as
 * proof for the host that "the entire tree has exited".
 * Windows has no process groups; returns null (unknown), without falsely claiming a clean exit.
 */
export function groupAlive(pid, { platform = process.platform, processKill = process.kill.bind(process) } = {}) {
  if (platform === 'win32' || !pid) return null;
  try { processKill(-pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/* ---------------------------------------------------------------- Python isolated mode */

/**
 * Interpreter flags for isolated mode: `-I` isolates; `-X utf8` replaces PYTHONUTF8 /
 * PYTHONIOENCODING; `-u` replaces PYTHONUNBUFFERED; `-B` replaces PYTHONDONTWRITEBYTECODE
 */
export const PYTHON_ISOLATED_FLAGS = Object.freeze(['-I', '-X', 'utf8', '-u', '-B']);

/**
 * Bootstrap code: takes "dir count, directories, module name" from CLI, prepends directories to
 * search path, then runs module as `__main__` (equivalent to `-m`).
 * Uses `-c` rather than `-m`: under `-I`, PYTHONPATH does not take effect; deployment-configured
 * package directories can only be passed in this way.
 */
export const PYTHON_BOOTSTRAP = "import sys, runpy; n = int(sys.argv.pop(1)); roots = [sys.argv.pop(1) for _ in range(n)]; mod = sys.argv.pop(1); sys.path[:0] = roots; runpy.run_module(mod, run_name='__main__', alter_sys=True)";

/**
 * Full argument string after `python`: run package in isolated mode (equivalent to
 * `python -m <module> <args…>`, but current directory does not enter search paths).
 * @param {string} moduleName Package name (hardcoded in code, not from model)
 * @param {{ roots?: Array<string | null | undefined>, args?: string[] }} [o] `roots` are package
 *   and third-party library directories from deployment config (front of search path, in given order)
 */
export function isolatedPythonArgs(moduleName, { roots = [], args = [] } = {}) {
  if (typeof moduleName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(moduleName)) throw new Error('isolatedPythonArgs: invalid module name');
  const dirs = roots.filter((r) => typeof r === 'string' && r !== '');
  return dirs.length
    ? [...PYTHON_ISOLATED_FLAGS, '-c', PYTHON_BOOTSTRAP, String(dirs.length), ...dirs, moduleName, ...args]
    : [...PYTHON_ISOLATED_FLAGS, '-m', moduleName, ...args];
}

/** Split path-separated directory strings like `a;b` (Windows) or `a:b`; filter arrays as-is */
export function splitRoots(value, delimiter = path.delimiter) {
  if (Array.isArray(value)) return value.filter((r) => typeof r === 'string' && r !== '');
  return typeof value === 'string' ? value.split(delimiter).filter(Boolean) : [];
}
