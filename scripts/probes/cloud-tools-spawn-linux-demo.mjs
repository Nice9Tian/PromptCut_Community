// 进程树按组杀的演示(给 Linux 节点用;Windows 上也能跑,走 taskkill 那一支)。
//
// 自带一切:只用 Node 标准库,加系统自带的 python3(没有就用 sh + sleep)。杀法不是抄的——直接 import 公共实现
// `server/agent/service/perception/runner.mjs`(它也只用 Node 标准库)。
//
// 在节点上跑(不用检出仓库):把下面两个文件拷到同一个临时目录,然后
//
//   scripts/probes/cloud-tools-spawn-linux-demo.mjs
//   server/agent/service/perception/runner.mjs
//
//   node cloud-tools-spawn-linux-demo.mjs
//
// 在仓库里跑:node scripts/probes/cloud-tools-spawn-linux-demo.mjs
//
// 每个用例:按公共实现起一个子进程,它再起一个孙进程;用一种办法杀;核对两个进程号都查不到了。
// 最后一行是 `[demo] 全部通过 n/n`(退出码 0)或 `[demo] 有失败`(退出码 1)。不留进程:收尾时把还活着的按进程号杀掉。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const here = new URL('./runner.mjs', import.meta.url);
const inRepo = new URL('../../server/agent/service/perception/runner.mjs', import.meta.url);
const runnerUrl = fs.existsSync(here) ? here : inRepo;
const { spawnTree, killTree, superviseChild, whenClosed, groupAlive, treeSettled, isolatedPythonArgs } = await import(runnerUrl.href);

const win = process.platform === 'win32';
const say = (...parts) => console.log('[demo]', ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 进程还在不在。僵尸(已经死了、只是还没被收尸)算不在,并单独记下来 */
function state(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error?.code !== 'EPERM') return 'gone'; }
  if (!win) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return 'zombie';
    } catch { /* 没有 /proc(macOS)或刚好退了 */ }
  }
  return 'alive';
}
const gone = (pid) => state(pid) !== 'alive';
async function waitGone(pids, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pids.every(gone)) return true; await sleep(50); }
  return pids.every(gone);
}
function pgidOf(pid) {
  if (win) return null;
  try {
    // /proc/<pid>/stat:最后一个 ')' 之后依次是 状态、父进程号、进程组号
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
    if (Number.isInteger(pgrp)) return pgrp;
  } catch { /* 没有 /proc(macOS):退回 ps */ }
  const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? Number(r.stdout.trim()) : null;
}

function findPython() {
  for (const cand of [process.env.PYTHON, 'python3', 'python'].filter(Boolean)) {
    const r = spawnSync(cand, ['-I', '-c', 'import sys;sys.stdout.write(sys.executable)'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}
const python = findPython();
if (!python && win) { say('这台 Windows 上没有 python,演示跑不了'); process.exit(2); }

/**
 * 「子进程再起孙进程」的命令行。孙进程缺省继承子进程的标准流(像 Python 起 ffmpeg);
 * `quiet` 时孙进程的标准流全指到空设备、子进程报完进程号就自己退出(留下一个不握管道的孙进程)。
 */
function treeCommand({ quiet = false } = {}) {
  if (python) {
    const io = quiet ? ', stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL' : '';
    const code = [
      'import json, os, subprocess, sys, time',
      `g = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(600)']${io})`,
      "print(json.dumps({'pid': os.getpid(), 'grandchild': g.pid}), flush=True)",
      quiet ? 'os._exit(0)' : 'time.sleep(600)',
    ].join('\n');
    return [python, ['-I', '-c', code]];
  }
  const redirect = quiet ? ' </dev/null >/dev/null 2>&1' : '';
  return ['/bin/sh', ['-c', `sleep 600${redirect} & echo "{\\"pid\\": $$, \\"grandchild\\": $!}"; ${quiet ? 'exit 0' : 'wait'}`]];
}

const started = new Set();
/** 起一棵树(可以换起法),等它报出两个进程号 */
async function startTree({ quiet = false, raw = false } = {}) {
  const [command, args] = treeCommand({ quiet });
  const child = raw
    ? spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })   // 对照:普通起法,不建进程组
    : spawnTree(command, args, {});
  let text = '';
  const pids = await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { text += d.toString('utf8'); if (text.includes('\n')) { try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
    child.once('error', reject);
    setTimeout(() => reject(new Error('子进程 10 秒没报出进程号')), 10_000).unref();
  });
  started.add(pids.pid); started.add(pids.grandchild);
  return { child, pids };
}

const describe = (pids) => `子进程 ${pids.pid}(进程组 ${pgidOf(pids.pid) ?? '—'})、孙进程 ${pids.grandchild}(进程组 ${pgidOf(pids.grandchild) ?? '—'})`;

let passed = 0;
let total = 0;
async function check(name, run) {
  total += 1;
  try {
    const note = await run();
    passed += 1;
    say(`通过  ${name}${note ? `  —— ${note}` : ''}`);
  } catch (error) {
    say(`失败  ${name}:${error?.message ?? error}`);
  }
}
async function expectGone(pids, what) {
  if (!(await waitGone([pids.pid, pids.grandchild]))) throw new Error(`${what}之后还活着:子进程 ${state(pids.pid)}、孙进程 ${state(pids.grandchild)}`);
  return `子进程 ${state(pids.pid)}、孙进程 ${state(pids.grandchild)}`;
}

say(`平台 ${process.platform} ${os.release()},node ${process.version},${python ? `python ${python}` : '没有 python3,用 sh + sleep'}`);
say(`公共实现:${runnerUrl.pathname}`);
say(`隔离模式的命令行开头:${isolatedPythonArgs('some_pkg', { roots: ['/deploy/pkgs'] }).slice(0, 6).join(' ')} …`);

if (!win) {
  await check('对照:普通起法 + child.kill() 只杀得掉子进程,孙进程留下', async () => {
    const { child, pids } = await startTree({ raw: true });
    const line = describe(pids);
    child.kill('SIGKILL');
    await waitGone([pids.pid]);
    await sleep(300);
    if (gone(pids.grandchild)) throw new Error('孙进程也没了,对照不成立');
    process.kill(pids.grandchild, 'SIGKILL');
    await waitGone([pids.grandchild]);
    return `${line};杀子进程后孙进程还在(已另按进程号收掉)`;
  });
}

await check('killTree:直接按树杀', async () => {
  const { child, pids } = await startTree();
  const line = describe(pids);
  if (!win && (pgidOf(pids.pid) !== pids.pid || pgidOf(pids.grandchild) !== pids.pid)) throw new Error(`子进程不是进程组的组长,或孙进程不在它的组里:${line}`);
  if (!win && groupAlive(pids.pid) !== true) throw new Error('组里应当有活着的进程');
  const closed = whenClosed(child);
  if (killTree(child) !== true) throw new Error('killTree 没发出去');
  await closed;
  const after = await expectGone(pids, 'killTree');
  if (!treeSettled(child)) throw new Error('exit 与 close 没都到');
  if (!win && groupAlive(pids.pid) !== false) throw new Error('进程组里还有进程');
  if (killTree(child) !== false) throw new Error('收干净之后不该再发信号');
  return `${line} → ${after}`;
});

await check('child.kill():拿到子进程的旧代码只会这样杀,杀的也是整棵树', async () => {
  const { child, pids } = await startTree();
  const closed = whenClosed(child);
  child.kill();
  await closed;
  return expectGone(pids, 'child.kill()');
});

await check('superviseChild:超时', async () => {
  const { child, pids } = await startTree();
  const run = await superviseChild(child, { timeoutMs: 800 });
  const end = await run.done;
  if (!end.timedOut) throw new Error('没有记成超时');
  return `${await expectGone(pids, '超时')};退出 code=${end.code} signal=${end.signal}`;
});

await check('superviseChild:登记器撤销(登记器调的是登记进去的那个 kill)', async () => {
  // 最小的登记器替身:记下登记进来的资源,撤销时调它的 kill(),等它的 exit 与 close
  const controller = new AbortController();
  let resource = null;
  const resources = {
    async register(_context, entry) {
      resource = entry.resource;
      const closed = new Promise((resolve) => { let e = false; let c = false; resource.once('exit', () => { e = true; if (c) resolve(); }); resource.once('close', () => { c = true; if (e) resolve(); }); });
      return { signal: controller.signal, closed };
    },
  };
  const { child, pids } = await startTree();
  const run = await superviseChild(child, { resources, context: {} });
  controller.abort('stop');
  resource.kill();
  const end = await run.done;
  if (!end.aborted) throw new Error('没有记成被撤销');
  return expectGone(pids, '撤销');
});

await check('superviseChild:外面给的取消信号', async () => {
  const abort = new AbortController();
  const { child, pids } = await startTree();
  const run = await superviseChild(child, { signal: abort.signal });
  abort.abort();
  const end = await run.done;
  if (!end.aborted) throw new Error('没有记成被取消');
  return expectGone(pids, '取消');
});

if (!win) {
  await check('子进程自己先退、留下不握管道的孙进程:退出时按组扫一次,不留孤儿', async () => {
    const { child, pids } = await startTree({ quiet: true });
    await whenClosed(child);
    return expectGone(pids, '子进程退出');
  });
} else {
  say('跳过  「子进程自己先退留下孙进程」:Windows 没有进程组,根进程退了之后按进程号找不回它的孙进程(生产节点是 Linux)');
}

// 收尾:不留进程
for (const pid of started) { if (state(pid) === 'alive') { try { process.kill(pid, 'SIGKILL'); say(`收尾:杀掉还活着的 ${pid}`); } catch { /* 刚好退了 */ } } }
if (passed === total) { say(`全部通过 ${passed}/${total}`); process.exit(0); }
say(`有失败:通过 ${passed}/${total}`);
process.exit(1);
