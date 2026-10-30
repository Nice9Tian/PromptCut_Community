/**
 * 云端 Agent 服务起子进程(Python、ffmpeg)的公共实现:起成一棵杀得掉的树、整棵杀、等到真的 exit + close、
 * 登记进运行资源登记器;以及 Python 的隔离模式命令行。
 *
 * 用它的有:`workspace.mjs` 的 `spawn()`(所有受限子进程的入口)、`perception/stt.mjs`、`perception/subject.mjs`、
 * `perception/track.mjs`、`hosted-collect.mjs`;`hosted-audio.mjs` 经 `workspace.spawn()` 用到。
 *
 * 进程树:
 *   - Linux / macOS:子进程起成一个新进程组的组长(`detached: true`),杀的时候按组杀(`kill(-pid)`)——
 *     Python 再起的 ffmpeg、pip 都在这个组里,一起死。组长自己先退了而组里还有进程(孙进程握着管道没退)时照样按组杀;
 *     组长退出时再按组扫一次,不留孤儿。`exit` 与 `close` 都到了之后不再发信号(进程号可能已被别的进程用掉)。
 *   - Windows:没有进程组,用 `taskkill /F /T /PID`(按父子关系杀整棵树)。它只在根进程还活着时找得到整棵树;
 *     根进程自己先退了留下的孙进程,Windows 上按进程号找不回来(生产节点是 Linux,不受这条影响)。
 *
 * Python 隔离模式:`-I` 不看 PYTHON* 环境变量、不把当前目录和用户 site 放进模块搜索路径。子进程的工作目录是对话工作区,
 * 里面是成员和模型弄进来的文件,不能让它排进搜索路径。包目录、第三方库目录只来自部署配置,经一小段引导代码插进搜索路径。
 * `-I` 之下 PYTHONPATH、PYTHONUTF8、PYTHONIOENCODING、PYTHONUNBUFFERED、PYTHONDONTWRITEBYTECODE 都不生效,换成 `-X utf8 -u -B`。
 *
 * 本文件只用 Node 标准库,不引用仓库里别的文件:`scripts/probes/cloud-tools-spawn-linux-demo.mjs` 单拷这一个文件到节点上就能跑。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';

/** 子进程 → 它这棵树的状态。只有 `spawnTree` 起的才在里面 */
const TREES = new WeakMap();

/** Windows 上按父子关系杀整棵树。用系统目录里的那一个,不经 PATH 找 */
function runTaskkill(pid) {
  const exe = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  return nodeSpawn(exe, ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
}

/**
 * 起一个子进程,当作一棵树的根:不弹窗口、不经 shell;非 Windows 上是新进程组的组长。
 * 回的 `child.kill()` 被换成杀整棵树(`killTree`),所以拿到它的任何代码(包括只会 `child.kill()` 的旧代码)杀的都是整棵树。
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ cwd?: string, env?: Record<string, string>, stdio?: any }} [options]
 * @param {{ spawnImpl?: typeof nodeSpawn, platform?: string, processKill?: (pid: number, signal?: string | number) => void, taskkill?: (pid: number) => import('node:events').EventEmitter }} [deps]
 *   `spawnImpl` 给测试换;`platform`、`processKill`、`taskkill` 只给单测(在一个平台上走另一个平台的分支)
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
    // 组长退了:组里还剩的(它起的、没等的孙进程)一并收掉。组已经空了就是 ESRCH,不管
    if (state.grouped && state.pid) { try { state.processKill(-state.pid, 'SIGKILL'); } catch { /* 组里没有进程了 */ } }
  });
  child.once('close', () => { state.closed = true; });
  child.once('error', () => { if (!child.pid) state.failed = true; });
  child.kill = (signal) => killTree(child, signal);
  return child;
}

/** 这棵树的根是否已经 `exit` 且 `close`(或者根本没起来) */
export function treeSettled(child) {
  const state = TREES.get(child);
  if (!state) return child?.exitCode !== null && child?.exitCode !== undefined;
  return state.failed || (state.exited && state.closed);
}

/**
 * 杀整棵进程树。不是 `spawnTree` 起的子进程退回它自己的 `kill`。
 * 非 Windows:给整个进程组发信号(缺省 SIGKILL)。Windows:`taskkill /F /T`,不认信号。
 * @returns {boolean} 发没发出去(和 `child.kill()` 一样是同步的回值;真退了没有看 `whenClosed`)
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
  // Windows:根进程已经退了就没有树可找了
  if (state.exited) return false;
  if (state.killing) return true;
  state.killing = true;
  const done = () => { state.killing = false; };
  try {
    const killer = state.taskkill(state.pid);
    killer.once('error', () => { done(); if (!state.exited) raw(); });
    // 退出码非 0:没杀成(或进程已经不在了);根还活着就退回只杀根
    killer.once('exit', (code) => { done(); if (code !== 0 && !state.exited) raw(); });
    return true;
  } catch { done(); return raw(); }
}

/**
 * 等一个子进程真的收干净:`exit` 与 `close` 都到了(标准流也关了),或者它根本没起来(只有 `error`)。
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
      // 起都没起来:Node 只发 error(有的版本再发 close),不发 exit
      if (!child.pid) setImmediate(finish);
    });
  });
}

/**
 * 给运行资源登记器(`run-resources.mjs`,kind `child`)用的外壳:`kill()` 杀整棵树;`exit` 与 `close` 都到了才算关;
 * 起不来的也补上这两个事件,免得登记器一直等。
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
 * 监管一个已经起来的子进程,直到它整棵树收干净。
 *
 *   - 给了 `resources` 与 `context`:登记进运行资源登记器——这一轮被停、转私有、Agent 关闭、服务关闭时登记器杀掉整棵树;
 *     登记被拒(这一轮已经没有权限)时杀掉、等它收干净,再把登记器的错误抛出去;
 *   - `timeoutMs`:到点杀整棵树,结果里 `timedOut` 为 true;
 *   - `signal`:外面给的取消信号,一响就杀整棵树;
 *   - `onStdout` / `onStderr`:输出的回调。不给也会把管道读空(不读的话 `close` 永远不到)。
 *
 * 起都没起来的(没有进程号)不登记:没有进程可杀,`done` 里带 `spawnError`。
 *
 * @param {import('node:child_process').ChildProcess} child `spawnTree`(或 `workspace.spawn()`)起的
 * @param {object} [o]
 * @returns {Promise<{ child: object, pid: number | undefined, kill(): boolean, signal: AbortSignal | null,
 *   done: Promise<{ code: number | null, signal: string | null, timedOut: boolean, aborted: boolean, spawnError: Error | null }> }>}
 *   `done` 在子进程 `exit` + `close`、且登记器也看到它关了之后才解决,不会拒绝
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
      // 登记失败时登记器已经杀过它并等过;这里再保险一次
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
 * 进程组里还有没有活着的进程(只在非 Windows 上有意义):给宿主做「整棵树都退了」的凭据用。
 * Windows 上没有进程组,回 null(不知道),不假称退干净了。
 */
export function groupAlive(pid, { platform = process.platform, processKill = process.kill.bind(process) } = {}) {
  if (platform === 'win32' || !pid) return null;
  try { processKill(-pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/* ---------------------------------------------------------------- Python 隔离模式 */

/** 隔离模式的解释器开关:`-I` 隔离;`-X utf8` 顶替 PYTHONUTF8 / PYTHONIOENCODING;`-u` 顶替 PYTHONUNBUFFERED;`-B` 顶替 PYTHONDONTWRITEBYTECODE */
export const PYTHON_ISOLATED_FLAGS = Object.freeze(['-I', '-X', 'utf8', '-u', '-B']);

/**
 * 引导代码:从命令行取「几个目录、各个目录、模块名」,把目录插到搜索路径最前,再把模块当 `__main__` 跑(等同 `-m`)。
 * 用 `-c` 而不是 `-m`:`-I` 之下 PYTHONPATH 不生效,部署配置的包目录只能这样递进去。
 */
export const PYTHON_BOOTSTRAP = "import sys, runpy; n = int(sys.argv.pop(1)); roots = [sys.argv.pop(1) for _ in range(n)]; mod = sys.argv.pop(1); sys.path[:0] = roots; runpy.run_module(mod, run_name='__main__', alter_sys=True)";

/**
 * `python` 之后的整串参数:隔离模式跑一个包(等同 `python -m <模块> <参数…>`,但当前目录不进搜索路径)。
 * @param {string} moduleName 包名(程序里写死的,不来自模型)
 * @param {{ roots?: Array<string | null | undefined>, args?: string[] }} [o] `roots` 是部署配置给的包目录、第三方库目录(排在搜索路径最前,按给的顺序)
 */
export function isolatedPythonArgs(moduleName, { roots = [], args = [] } = {}) {
  if (typeof moduleName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(moduleName)) throw new Error('isolatedPythonArgs: 模块名不合法');
  const dirs = roots.filter((r) => typeof r === 'string' && r !== '');
  return dirs.length
    ? [...PYTHON_ISOLATED_FLAGS, '-c', PYTHON_BOOTSTRAP, String(dirs.length), ...dirs, moduleName, ...args]
    : [...PYTHON_ISOLATED_FLAGS, '-m', moduleName, ...args];
}

/** 把 `a;b`(Windows)或 `a:b` 这种用路径分隔符连起来的目录串拆开;已经是数组的原样过滤 */
export function splitRoots(value, delimiter = path.delimiter) {
  if (Array.isArray(value)) return value.filter((r) => typeof r === 'string' && r !== '');
  return typeof value === 'string' ? value.split(delimiter).filter(Boolean) : [];
}
