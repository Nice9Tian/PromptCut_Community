/**
 * 云端 Agent 的浏览器进程:怎么认「还活着」、怎么认「是不是我们的浏览器」(`server/web/hosted/session.mjs`)。
 * 跑:npm test -- server/test/cloud-tools-w1-process.test.mjs
 *
 * 不起浏览器。Linux 上才走得到的分支(读 /proc、进程组、锁文件)用注入的假 /proc 目录与假进程表在任何平台上验。
 *
 *   W1-PROC-01  僵尸按已退算:`/proc/<进程号>/stat` 的状态是 Z 的进程查得到但不算活着;进程名里带空格和括号也读得对
 *   W1-PROC-02  进程组:组里只剩僵尸 = 整棵树退了;还有一个活的(进程表里列不出来的 zygote)= 没退;组已经不在 = 退了;
 *               Windows 没有进程组,回「不知道」
 *   W1-PROC-03  认「是不是我们的浏览器」只看命令行里有没有完整的 `--user-data-dir=<这份目录>`;目录名是别人的前缀、子目录都不算
 *   W1-PROC-04  清残留不误杀:锁文件里的进程号活着、但那是别的进程(渲染服务的浏览器、文档服务)——不杀,过期的锁删掉;
 *   W1-PROC-05  起它的服务进程还活着的浏览器(滚动重启的重叠期):启动清扫不动;旧服务进程不在了才清;真要在这个对话起新浏览器时照清
 *               (下面接 W1-PROC-04 的说明)登记文件里的进程号被别的对话的浏览器占了——不杀;确实是这份目录的浏览器——杀;Windows 上锁被独占却认不出是谁——照实报还占着
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { procStat, pidLive, liveGroupMembers, browserGroupLive, processCommandLine, commandLineUsesProfile, browserHoldsProfile, reapOrphan } from '../web/hosted/session.mjs';

/** 造一个假的 /proc:`{ 进程号: { comm, state, ppid, pgrp, cmdline? } }` */
export function fakeProc(t, table) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-proc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [pid, p] of Object.entries(table)) {
    fs.mkdirSync(path.join(root, pid));
    fs.writeFileSync(path.join(root, pid, 'stat'), `${pid} (${p.comm ?? 'chrome'}) ${p.state ?? 'S'} ${p.ppid ?? 1} ${p.pgrp ?? pid} ${p.pgrp ?? pid} 0 -1 4194560 0 0 0 0\n`);
    if (p.cmdline) fs.writeFileSync(path.join(root, pid, 'cmdline'), `${p.cmdline.join('\0')}\0`);
  }
  for (const name of ['self', 'meminfo']) fs.writeFileSync(path.join(root, name), 'x');
  return root;
}

test('W1-PROC-01 僵尸按已退算', (t) => {
  const procRoot = fakeProc(t, {
    100: { comm: 'chrome-headless', state: 'S', pgrp: 100 },
    101: { comm: 'chrome) (evil S 1 1', state: 'Z', pgrp: 100 },   // 进程名里塞了括号和空格:从最后一个 ) 往后读
    102: { comm: 'chrome', state: 'R', pgrp: 100 },
    103: { comm: 'chrome', state: 'X', pgrp: 100 },
  });
  assert.deepEqual(procStat(100, { procRoot }), { state: 'S', pgrp: 100 });
  assert.deepEqual(procStat(101, { procRoot }), { state: 'Z', pgrp: 100 });
  assert.equal(procStat(999, { procRoot }), null);
  const alive = () => true;                                       // 「查得到」:僵尸也查得到
  assert.equal(pidLive(100, { platform: 'linux', procRoot, alive }), true);
  assert.equal(pidLive(101, { platform: 'linux', procRoot, alive }), false, '僵尸:查得到,但不算活着');
  assert.equal(pidLive(103, { platform: 'linux', procRoot, alive }), false);
  assert.equal(pidLive(102, { platform: 'linux', procRoot, alive }), true);
  assert.equal(pidLive(100, { platform: 'linux', procRoot, alive: () => false }), false, '查不到就是没了');
  assert.equal(pidLive(999, { platform: 'linux', procRoot, alive }), true, '查得到但读不了状态:不假称它退了');
  assert.equal(pidLive(101, { platform: 'win32', procRoot, alive }), true, 'Windows 没有僵尸这回事');
});

test('W1-PROC-02 进程组:只剩僵尸算退了,还有进程表里列不出来的活进程算没退', (t) => {
  const zombiesOnly = fakeProc(t, {
    200: { state: 'Z', pgrp: 200 },                               // 主进程:已死,还没被收走
    201: { comm: 'chrome_zygote', state: 'Z', pgrp: 200 },
    300: { comm: 'node', state: 'S', pgrp: 300 },                 // 别的组的活进程:不相干
  });
  const zygoteAlive = fakeProc(t, {
    201: { comm: 'chrome_zygote', state: 'S', pgrp: 200 },         // 主进程没了,zygote 还活着
    202: { state: 'Z', pgrp: 200 },
  });
  const groupThere = () => true;
  const groupGone = () => false;
  assert.deepEqual(liveGroupMembers(200, { procRoot: zombiesOnly }), []);
  assert.deepEqual(liveGroupMembers(200, { procRoot: zygoteAlive }), [201]);
  assert.deepEqual(liveGroupMembers(300, { procRoot: zombiesOnly }), [300]);
  assert.equal(liveGroupMembers(200, { procRoot: path.join(zombiesOnly, 'no-such-dir') }), null);

  assert.equal(browserGroupLive(200, { platform: 'linux', procRoot: zombiesOnly, group: groupThere }), false, '组还在(系统这么说),但全是僵尸:整棵树退了');
  assert.equal(browserGroupLive(200, { platform: 'linux', procRoot: zygoteAlive, group: groupThere }), true, 'zygote 还活着:没退');
  assert.equal(browserGroupLive(200, { platform: 'linux', procRoot: zygoteAlive, group: groupGone }), false, '系统说组已经不在:退了');
  assert.equal(browserGroupLive(200, { platform: 'darwin', procRoot: path.join(zombiesOnly, 'no-such-dir'), group: groupThere }), true, '读不了 /proc 而组还在:不假称退干净');
  assert.equal(browserGroupLive(200, { platform: 'win32', procRoot: zombiesOnly, group: groupThere }), null, 'Windows 没有进程组:不知道');
  assert.equal(browserGroupLive(0, { platform: 'linux', procRoot: zombiesOnly, group: groupThere }), null);
});

test('W1-PROC-03 认「是不是我们的浏览器」只看命令行里完整的 --user-data-dir', async (t) => {
  const dir = '/srv/agent/web/p-1/c-1/profile';
  assert.equal(commandLineUsesProfile(`/opt/chrome-headless-shell --headless --user-data-dir=${dir} --remote-debugging-pipe`, dir, 'linux'), true);
  assert.equal(commandLineUsesProfile(`/opt/chrome --user-data-dir=${dir}`, dir, 'linux'), true, '在最后一个参数上');
  assert.equal(commandLineUsesProfile(`/opt/chrome --user-data-dir=${dir}-other --x`, dir, 'linux'), false, '别人的目录以它开头');
  assert.equal(commandLineUsesProfile(`/opt/chrome --user-data-dir=${dir}/Default --x`, dir, 'linux'), false, '它的子目录');
  assert.equal(commandLineUsesProfile(`/opt/chrome --user-data-dir=/srv/render/profile --note=${dir}`, dir, 'linux'), false, '只是碰巧含着这串字');
  assert.equal(commandLineUsesProfile(`/opt/chrome --x=--user-data-dir=${dir} --y`, dir, 'linux'), false, '嵌在别的参数里');
  assert.equal(commandLineUsesProfile('node /srv/doc/main.mjs', dir, 'linux'), false);
  assert.equal(commandLineUsesProfile(null, dir, 'linux'), false);
  assert.equal(commandLineUsesProfile('"C:\\x\\chrome.exe" "--user-data-dir=C:\\Data Dir\\web\\p\\c\\profile" --remote-debugging-pipe', 'c:\\data dir\\web\\p\\c\\profile', 'win32'), true, 'Windows:不分大小写,带引号');
  assert.equal(commandLineUsesProfile(`/opt/chrome --user-data-dir=${dir.toUpperCase()}`, dir, 'linux'), false, 'Linux 分大小写');

  // 经假的 /proc 读命令行
  const procRoot = fakeProc(t, {
    500: { cmdline: ['/opt/chrome-headless-shell', '--headless', `--user-data-dir=${dir}`, '--remote-debugging-pipe'] },
    501: { cmdline: ['/opt/render/chrome', '--user-data-dir=/srv/render/profile'] },
    502: { comm: 'node', cmdline: ['node', '/srv/doc/main.mjs'] },
  });
  const commandLine = (pid) => processCommandLine(pid, { platform: 'linux', procRoot });
  const alive = () => true;
  assert.equal(await browserHoldsProfile(500, dir, { commandLine, alive, platform: 'linux' }), true);
  assert.equal(await browserHoldsProfile(501, dir, { commandLine, alive, platform: 'linux' }), false, '渲染服务自己的浏览器');
  assert.equal(await browserHoldsProfile(502, dir, { commandLine, alive, platform: 'linux' }), false, '文档服务');
  assert.equal(await browserHoldsProfile(999, dir, { commandLine, alive, platform: 'linux' }), false, '读不到命令行');
  assert.equal(await browserHoldsProfile(500, dir, { commandLine, alive: () => false, platform: 'linux' }), false, '进程不在');
  assert.equal(await browserHoldsProfile(0, dir, { commandLine, alive, platform: 'linux' }), false);
});

test('W1-PROC-04 清残留不误杀别的进程', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-reap-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  /** 一个对话目录:带登记文件与(假的)过期锁 */
  const makeSession = (name, owner) => {
    const sessionDir = path.join(base, name);
    const profile = path.join(sessionDir, 'profile');
    fs.mkdirSync(profile, { recursive: true });
    for (const lockName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.writeFileSync(path.join(profile, lockName), 'stale');
    if (owner) fs.writeFileSync(path.join(sessionDir, 'owner.json'), JSON.stringify(owner));
    return { sessionDir, profile };
  };
  /** 假进程表:进程号 → 命令行;被杀的记下来并从表里去掉 */
  const world = (table) => {
    const killed = [];
    const trees = [];
    return {
      killed, trees,
      deps: (extra) => ({
        platform: 'linux',
        commandLine: async (pid) => table[pid] ?? null,
        alive: (pid) => pid in table,
        kill: (pid) => { killed.push(pid); delete table[pid]; },
        killTree: (pid) => { trees.push(pid); },
        ...extra,
      }),
    };
  };

  /* 锁里写的进程号活着,但那是渲染服务的浏览器(浏览器被强杀后锁留在盘上,号被系统分给了别人) */
  {
    const { sessionDir, profile } = makeSession('reused-lock', { servicePid: 1, browserPid: 4242, pids: [4242, 4243] });
    const w = world({ 4242: '/opt/render/chrome --user-data-dir=/srv/render/profile', 4243: 'node /srv/doc/main.mjs' });
    const result = await reapOrphan(sessionDir, { timeoutMs: 500, deps: w.deps({ holder: () => ({ held: true, pid: 4242 }) }) });
    assert.deepEqual(result, { found: false, killed: [], stillHeld: false });
    assert.deepEqual(w.killed, [], '渲染服务的浏览器没有被杀');
    assert.deepEqual(w.trees, [], '也没有按进程组去杀');
    assert.deepEqual(fs.readdirSync(profile), [], '过期的锁删掉了(不然新起的浏览器会对着那个不相干的进程号去联系「旧实例」)');
    assert.equal(fs.existsSync(path.join(sessionDir, 'owner.json')), false);
  }

  /* 锁里的号是别人,登记文件里的号也是别人(别的对话的浏览器,目录名以这份目录开头) */
  {
    const { sessionDir, profile } = makeSession('reused-owner', { servicePid: 1, browserPid: 5001, pids: [5001] });
    const w = world({ 5001: `/opt/chrome-headless-shell --user-data-dir=${profile}-2 --remote-debugging-pipe`, 5002: 'sshd: admin' });
    const result = await reapOrphan(sessionDir, { timeoutMs: 500, deps: w.deps({ holder: () => ({ held: true, pid: 5002 }) }) });
    assert.equal(result.found, false);
    assert.deepEqual(w.killed, []);
    assert.deepEqual(w.trees, []);
  }

  /* 确实是这份目录的浏览器(锁里的号对):杀它,只杀它 */
  {
    const { sessionDir, profile } = makeSession('real-orphan', { servicePid: 1, browserPid: 6001, pids: [6001, 6002] });
    const w = world({ 6001: `/opt/chrome-headless-shell --headless --user-data-dir=${profile} --remote-debugging-pipe`, 6002: 'node /srv/doc/main.mjs' });
    const result = await reapOrphan(sessionDir, { timeoutMs: 2_000, deps: w.deps({ holder: () => ({ held: true, pid: 6001 }) }) });
    assert.deepEqual(result, { found: true, killed: [6001], stillHeld: false });
    assert.deepEqual(w.killed, [6001], '登记文件里的子进程号 6002(现在是文档服务)没有被直接杀');
    assert.deepEqual(w.trees, [6001]);
    assert.equal(fs.existsSync(path.join(sessionDir, 'owner.json')), false);
  }

  /* chrome-headless-shell 不拿锁:只有登记文件里的号,命令行对得上就杀 */
  {
    const { sessionDir, profile } = makeSession('shell-orphan', { servicePid: 1, browserPid: 7001, pids: [7001] });
    const w = world({ 7001: `/opt/chrome-headless-shell --headless --user-data-dir=${profile}` });
    const result = await reapOrphan(sessionDir, { timeoutMs: 2_000, deps: w.deps({ holder: () => ({ held: false, pid: null }) }) });
    assert.deepEqual(result.killed, [7001]);
  }

  /* 杀不掉的(进程表里一直在):照实报还占着,登记留着下次再清 */
  {
    const { sessionDir, profile } = makeSession('stubborn', { servicePid: 1, browserPid: 8001, pids: [8001] });
    const table = { 8001: `/opt/chrome --user-data-dir=${profile}` };
    const result = await reapOrphan(sessionDir, { timeoutMs: 300, deps: { platform: 'linux', commandLine: async (pid) => table[pid] ?? null, alive: (pid) => pid in table, kill: () => {}, killTree: () => {}, holder: () => ({ held: true, pid: 8001 }) } });
    assert.deepEqual(result, { found: true, killed: [8001], stillHeld: true });
    assert.equal(fs.existsSync(path.join(sessionDir, 'owner.json')), true);
  }

  /* Windows:锁文件被谁独占着,登记的号是个不相干的活进程——不杀,照实报「还被占着」;锁没被占时把过期登记清掉 */
  {
    const { sessionDir } = makeSession('win-unknown-holder', { servicePid: 1, browserPid: 9001, pids: [9001] });
    const w = world({ 9001: '"C:\\Program Files\\nodejs\\node.exe" server.mjs' });
    const held = await reapOrphan(sessionDir, { timeoutMs: 300, deps: w.deps({ platform: 'win32', holder: () => ({ held: true, pid: null }) }) });
    assert.deepEqual(held, { found: true, killed: [], stillHeld: true });
    assert.deepEqual(w.killed, []);
    const free = await reapOrphan(sessionDir, { timeoutMs: 300, deps: w.deps({ platform: 'win32', holder: () => ({ held: false, pid: null }) }) });
    assert.deepEqual(free, { found: false, killed: [], stillHeld: false });
    assert.deepEqual(w.killed, []);
    assert.equal(fs.existsSync(path.join(sessionDir, 'owner.json')), false);
  }
});

test('W1-PROC-05 起它的服务进程还活着的浏览器:启动清扫不动,真要在这个对话里起新浏览器时才清', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-owner-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const make = (name, servicePid) => {
    const sessionDir = path.join(base, name);
    const profile = path.join(sessionDir, 'profile');
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'owner.json'), JSON.stringify({ servicePid, browserPid: 7101, pids: [7101] }));
    return { sessionDir, profile };
  };
  const run = async (name, servicePid, options) => {
    const { sessionDir, profile } = make(name, servicePid);
    const table = { 7101: `/opt/chrome-headless-shell --headless --user-data-dir=${profile}`, 77: 'node /srv/agent/main.mjs' };
    const killed = [];
    const result = await reapOrphan(sessionDir, { timeoutMs: 1_000, ...options, deps: {
      platform: 'linux', selfPid: 4000, holder: () => ({ held: false, pid: null }), commandLine: async (pid) => table[pid] ?? null,
      alive: (pid) => pid in table, kill: (pid) => { killed.push(pid); delete table[pid]; }, killTree: () => {},
    } });
    return { result, killed, sessionDir };
  };
  // 滚动重启的重叠期:旧服务进程(77)还活着,它的浏览器在用——新进程的启动清扫不杀
  const overlap = await run('overlap', 77, { respectLiveOwner: true });
  assert.deepEqual(overlap.killed, []);
  assert.equal(overlap.result.liveOwner, true);
  assert.equal(overlap.result.found, false);
  assert.equal(fs.existsSync(path.join(overlap.sessionDir, 'owner.json')), true, '登记留着');
  // 旧服务进程已经不在:是真的残留,清扫时杀
  assert.deepEqual((await run('dead-owner', 78, { respectLiveOwner: true })).killed, [7101]);
  // 登记的就是本进程自己(不会发生在清扫时,防一手):照杀
  assert.deepEqual((await run('self-owner', 4000, { respectLiveOwner: true })).killed, [7101]);
  // 要在这个对话里起新浏览器(不带开关):旧进程活着也清——同一份目录不能两个浏览器用,文档服务这时已经只认新进程
  assert.deepEqual((await run('launch-time', 77, {})).killed, [7101]);
});
