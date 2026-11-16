// Stopping a job's whole process tree on Linux and macOS (server/process-tree.mjs).
// Run: node --test server/test/process-tree.test.mjs
//
//   PT-1  Parent PID from /proc/<pid>/stat, including process names with spaces and parentheses
//   PT-2  The process table: from a /proc directory on Linux, from `ps` elsewhere
//   PT-3  Descendants: every level, nearest first, nothing from other trees, no endless loop
//   PT-4  killTreePosix signals the root first and then each descendant; refuses PID 1, this
//         process and non-PIDs; when the table cannot be read it signals the root alone
//   PT-5  Real processes: a shell that starts a shell that starts `sleep`. Killing only the root
//         leaves the other two running (the bug); killTreePosix stops all three (skipped on Windows)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parentPidFromStat, processTable, descendantsOf, killTreePosix } from '../process-tree.mjs';

test('PT-1 parent PID from /proc/<pid>/stat', () => {
  assert.equal(parentPidFromStat('4242 (python3) S 4100 4242 4100 0 -1 4194304 1 2 3'), 4100);
  assert.equal(parentPidFromStat('4243 (tmux: server (1) S 9 9) R 77 4243 4243 0'), 77, 'counted from the last parenthesis');
  assert.equal(parentPidFromStat('1 (systemd) S 0 1 1 0'), 0);
  assert.equal(parentPidFromStat('garbage'), null);
  assert.equal(parentPidFromStat('5 (x) S notanumber'), null);
  assert.equal(parentPidFromStat(undefined), null);
});

test('PT-2 the process table from /proc on Linux and from ps elsewhere', (t) => {
  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-proc-'));
  t.after(() => fs.rmSync(procRoot, { recursive: true, force: true }));
  const put = (pid, ppid, comm = 'x') => { fs.mkdirSync(path.join(procRoot, String(pid))); fs.writeFileSync(path.join(procRoot, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0\n`); };
  put(100, 1); put(101, 100, 'ffmpeg (merge)'); put(102, 101);
  fs.mkdirSync(path.join(procRoot, '103'));                       // Exited while listing: no stat
  fs.mkdirSync(path.join(procRoot, 'self'));
  fs.writeFileSync(path.join(procRoot, 'meminfo'), 'x');
  const linux = processTable({ platform: 'linux', procRoot }).sort((a, b) => a.pid - b.pid);
  assert.deepEqual(linux, [{ pid: 100, ppid: 1 }, { pid: 101, ppid: 100 }, { pid: 102, ppid: 101 }]);
  assert.deepEqual(processTable({ platform: 'linux', procRoot: path.join(procRoot, 'missing') }), []);

  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '    1     0\n  100     1\n  101   100\nnot a row\n\n' }; };
  assert.deepEqual(processTable({ platform: 'darwin', run }), [{ pid: 1, ppid: 0 }, { pid: 100, ppid: 1 }, { pid: 101, ppid: 100 }]);
  assert.deepEqual(calls, [['ps', '-A', '-o', 'pid=,ppid=']]);
  assert.deepEqual(processTable({ platform: 'darwin', run: () => { throw new Error('no ps'); } }), []);
});

test('PT-3 descendants: all levels, nearest first, other trees left out', () => {
  const table = [
    { pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 10 }, { pid: 13, ppid: 11 }, { pid: 14, ppid: 13 },
    { pid: 20, ppid: 1 }, { pid: 21, ppid: 20 },
  ];
  assert.deepEqual(descendantsOf(10, table), [11, 12, 13, 14]);
  assert.deepEqual(descendantsOf(13, table), [14]);
  assert.deepEqual(descendantsOf(14, table), []);
  assert.deepEqual(descendantsOf(999, table), []);
  // A table read while PIDs are being reused can contain a loop: each PID is still visited once
  assert.deepEqual(descendantsOf(30, [{ pid: 31, ppid: 30 }, { pid: 30, ppid: 31 }]), [31]);
});

test('PT-4 killTreePosix: root first, then descendants; never PID 1 or this process', () => {
  const table = () => [{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 20, ppid: 1 }];
  const sent = [];
  const kill = (pid, signal) => { sent.push([pid, signal]); };
  assert.deepEqual(killTreePosix(10, { table, kill, selfPid: 999 }), [10, 11, 12]);
  assert.deepEqual(sent, [[10, 'SIGKILL'], [11, 'SIGKILL'], [12, 'SIGKILL']]);

  sent.length = 0;
  assert.deepEqual(killTreePosix(10, { table, kill, selfPid: 999, signal: 'SIGTERM' }), [10, 11, 12]);
  assert.deepEqual(sent.map(([, signal]) => signal), ['SIGTERM', 'SIGTERM', 'SIGTERM']);

  // A process that has already exited is skipped, the rest still get the signal
  const gone = (pid) => { if (pid === 11) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
  assert.deepEqual(killTreePosix(10, { table, kill: gone, selfPid: 999 }), [10, 12]);

  sent.length = 0;
  for (const bad of [undefined, null, 0, 1, -5, 1.5, '10', 999]) assert.deepEqual(killTreePosix(bad, { table, kill, selfPid: 999 }), [], String(bad));
  assert.deepEqual(sent, [], 'nothing is signalled for PID 1, this process or a non-PID');
  // This process further down the tree is skipped too
  assert.deepEqual(killTreePosix(10, { table, kill, selfPid: 11 }), [10, 12]);

  // The table cannot be read: the root alone
  sent.length = 0;
  assert.deepEqual(killTreePosix(10, { table: () => { throw new Error('no /proc'); }, kill, selfPid: 999 }), [10]);
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; } };
/** Zombies still answer signal 0; on Linux read the state to tell them apart */
const running = (pid) => {
  if (!alive(pid)) return false;
  try { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 1).trim()[0] !== 'Z'; } catch { return true; }
};
async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  assert.fail(`timed out waiting for ${what}`);
}

/** sh (root) → sh (child) → sleep (grandchild); resolves once all three PIDs are known */
async function startTree(t) {
  const script = 'sh -c \'sleep 300 & echo "grandchild $!"; wait\' & echo "child $!"; wait';
  const root = spawn('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  root.stdout.on('data', (d) => { out += d; });
  const pidOf = (name) => Number(new RegExp(`^${name} (\\d+)$`, 'm').exec(out)?.[1]);
  await until(() => pidOf('child') && pidOf('grandchild'), 'the tree to start');
  const pids = { root: root.pid, child: pidOf('child'), grandchild: pidOf('grandchild') };
  t.after(() => { for (const pid of Object.values(pids)) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone */ } } });
  return { root, pids };
}

test('PT-5 real processes: killing the root alone leaves its descendants, killTreePosix stops all of them', { skip: process.platform === 'win32' && 'Windows stops trees with taskkill /T' }, async (t) => {
  // What the plugins did before: child.kill()
  const before = await startTree(t);
  before.root.kill('SIGKILL');
  await until(() => !running(before.pids.root), 'the root to exit');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(running(before.pids.child), true, 'the child outlives a kill of the root alone');
  assert.equal(running(before.pids.grandchild), true, 'so does the grandchild');

  // The fix
  const after = await startTree(t);
  const table = processTable();
  assert.deepEqual(descendantsOf(after.pids.root, table), [after.pids.child, after.pids.grandchild]);
  const signalled = killTreePosix(after.pids.root);
  assert.deepEqual(signalled, [after.pids.root, after.pids.child, after.pids.grandchild]);
  await until(() => !running(after.pids.root) && !running(after.pids.child) && !running(after.pids.grandchild), 'all three to exit');
});
