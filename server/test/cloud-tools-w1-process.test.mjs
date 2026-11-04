/**
 * Browser processes for Cloud Agent: how to identify "still alive" and "is it our browser"
 * (`server/web/hosted/session.mjs`).
 * Run: npm test -- server/test/cloud-tools-w1-process.test.mjs
 *
 * Does not launch browsers. Branches reachable only on Linux (reading /proc, process groups, lock
 * files) are verified across all platforms using an injected mock /proc directory and mock process
 * table.
 *
 *   W1-PROC-01  Zombies counted as exited: processes whose state in `/proc/<pid>/stat` is Z are
 *               queryable but not considered alive; process names with spaces and parentheses are
 *               also parsed correctly
 *   W1-PROC-02  Process groups: only zombies left in group = whole tree exited; one alive remains
 *               (a zygote not listed in process table) = not exited; group no longer exists =
 *               exited; Windows has no process groups, returns "unknown"
 *   W1-PROC-03  Identifying "is it our browser" only checks whether command line contains full
 *               `--user-data-dir=<this-directory>`; directory name being a prefix of another or a
 *               subdirectory does not count
 *   W1-PROC-04  Cleaning residue without false kills: pid in lock file is alive, but belongs to
 *               another process (render service browser, document service): do not kill, delete
 *               stale locks;
 *   W1-PROC-05  Browsers whose launching service process is still alive (rolling restart overlap
 *               period): startup cleanup leaves them untouched; only cleaned once old service
 *               process is gone; still cleaned when genuinely launching a new browser in this chat
 *               (Continued from W1-PROC-04 explanation below) pid in registry file occupied by
 *               browser of another chat: do not kill; confirmed to be browser for this directory:
 *               kill; on Windows, lock is held exclusively but owner cannot be identified: report
 *               faithfully as still occupied
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { procStat, pidLive, liveGroupMembers, browserGroupLive, processCommandLine, commandLineUsesProfile, browserHoldsProfile, reapOrphan } from '../web/hosted/session.mjs';

/** Creates a mock /proc: `{ pid: { comm, state, ppid, pgrp, cmdline? } }` */
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

test('W1-PROC-01 zombies count as exited', (t) => {
  const procRoot = fakeProc(t, {
    100: { comm: 'chrome-headless', state: 'S', pgrp: 100 },
    101: { comm: 'chrome) (evil S 1 1', state: 'Z', pgrp: 100 },   // Parentheses and spaces inside process name: read after the last )
    102: { comm: 'chrome', state: 'R', pgrp: 100 },
    103: { comm: 'chrome', state: 'X', pgrp: 100 },
  });
  assert.deepEqual(procStat(100, { procRoot }), { state: 'S', pgrp: 100 });
  assert.deepEqual(procStat(101, { procRoot }), { state: 'Z', pgrp: 100 });
  assert.equal(procStat(999, { procRoot }), null);
  const alive = () => true;                                       // "Queryable": zombies are also queryable
  assert.equal(pidLive(100, { platform: 'linux', procRoot, alive }), true);
  assert.equal(pidLive(101, { platform: 'linux', procRoot, alive }), false, 'Zombie: can be found, but does not count as alive');
  assert.equal(pidLive(103, { platform: 'linux', procRoot, alive }), false);
  assert.equal(pidLive(102, { platform: 'linux', procRoot, alive }), true);
  assert.equal(pidLive(100, { platform: 'linux', procRoot, alive: () => false }), false, 'Not found means gone');
  assert.equal(pidLive(999, { platform: 'linux', procRoot, alive }), true, 'Found but status unreadable: do not falsely claim it exited');
  assert.equal(pidLive(101, { platform: 'win32', procRoot, alive }), true, 'Windows has no zombies');
});

test('W1-PROC-02 process group: only zombies left counts as exited, a live process that the process table cannot list counts as not exited', (t) => {
  const zombiesOnly = fakeProc(t, {
    200: { state: 'Z', pgrp: 200 },                               // Main process: dead, not yet reaped
    201: { comm: 'chrome_zygote', state: 'Z', pgrp: 200 },
    300: { comm: 'node', state: 'S', pgrp: 300 },                 // Live processes in other groups: irrelevant
  });
  const zygoteAlive = fakeProc(t, {
    201: { comm: 'chrome_zygote', state: 'S', pgrp: 200 },         // Main process is gone, zygote is still alive
    202: { state: 'Z', pgrp: 200 },
  });
  const groupThere = () => true;
  const groupGone = () => false;
  assert.deepEqual(liveGroupMembers(200, { procRoot: zombiesOnly }), []);
  assert.deepEqual(liveGroupMembers(200, { procRoot: zygoteAlive }), [201]);
  assert.deepEqual(liveGroupMembers(300, { procRoot: zombiesOnly }), [300]);
  assert.equal(liveGroupMembers(200, { procRoot: path.join(zombiesOnly, 'no-such-dir') }), null);

  assert.equal(browserGroupLive(200, { platform: 'linux', procRoot: zombiesOnly, group: groupThere }), false, 'The group still exists (the system says so), but all are zombies: the whole tree has exited');
  assert.equal(browserGroupLive(200, { platform: 'linux', procRoot: zygoteAlive, group: groupThere }), true, 'zygote is still alive: not exited');
  assert.equal(browserGroupLive(200, { platform: 'linux', procRoot: zygoteAlive, group: groupGone }), false, 'The system says the group is gone: exited');
  assert.equal(browserGroupLive(200, { platform: 'darwin', procRoot: path.join(zombiesOnly, 'no-such-dir'), group: groupThere }), true, '/proc unreadable while the group still exists: do not falsely claim a clean exit');
  assert.equal(browserGroupLive(200, { platform: 'win32', procRoot: zombiesOnly, group: groupThere }), null, 'Windows has no process groups: unknown');
  assert.equal(browserGroupLive(0, { platform: 'linux', procRoot: zombiesOnly, group: groupThere }), null);
});

test('W1-PROC-03 recognizing "is this our browser" looks only at the complete --user-data-dir in the command line', async (t) => {
  const dir = '/srv/agent/web/p-1/c-1/profile';
  assert.equal(commandLineUsesProfile(`/opt/chrome-headless-shell --headless --user-data-dir=${dir} --remote-debugging-pipe`, dir, 'linux'), true);
  assert.equal(commandLineUsesProfile(`/opt/chrome --user-data-dir=${dir}`, dir, 'linux'), true, 'On the last argument');
  assert.equal(commandLineUsesProfile(`/opt/chrome --user-data-dir=${dir}-other --x`, dir, 'linux'), false, 'Someone else\'s directory starts with it');
  assert.equal(commandLineUsesProfile(`/opt/chrome --user-data-dir=${dir}/Default --x`, dir, 'linux'), false, 'Its subdirectory');
  assert.equal(commandLineUsesProfile(`/opt/chrome --user-data-dir=/srv/render/profile --note=${dir}`, dir, 'linux'), false, 'Merely happens to contain this string');
  assert.equal(commandLineUsesProfile(`/opt/chrome --x=--user-data-dir=${dir} --y`, dir, 'linux'), false, 'Embedded in another argument');
  assert.equal(commandLineUsesProfile('node /srv/doc/main.mjs', dir, 'linux'), false);
  assert.equal(commandLineUsesProfile(null, dir, 'linux'), false);
  assert.equal(commandLineUsesProfile('"C:\\x\\chrome.exe" "--user-data-dir=C:\\Data Dir\\web\\p\\c\\profile" --remote-debugging-pipe', 'c:\\data dir\\web\\p\\c\\profile', 'win32'), true, 'Windows: case-insensitive, with quotes');
  assert.equal(commandLineUsesProfile(`/opt/chrome --user-data-dir=${dir.toUpperCase()}`, dir, 'linux'), false, 'Linux is case-sensitive');

  // Read command line via mock /proc
  const procRoot = fakeProc(t, {
    500: { cmdline: ['/opt/chrome-headless-shell', '--headless', `--user-data-dir=${dir}`, '--remote-debugging-pipe'] },
    501: { cmdline: ['/opt/render/chrome', '--user-data-dir=/srv/render/profile'] },
    502: { comm: 'node', cmdline: ['node', '/srv/doc/main.mjs'] },
  });
  const commandLine = (pid) => processCommandLine(pid, { platform: 'linux', procRoot });
  const alive = () => true;
  assert.equal(await browserHoldsProfile(500, dir, { commandLine, alive, platform: 'linux' }), true);
  assert.equal(await browserHoldsProfile(501, dir, { commandLine, alive, platform: 'linux' }), false, 'The render service\'s own browser');
  assert.equal(await browserHoldsProfile(502, dir, { commandLine, alive, platform: 'linux' }), false, 'Document service');
  assert.equal(await browserHoldsProfile(999, dir, { commandLine, alive, platform: 'linux' }), false, 'Command line unreadable');
  assert.equal(await browserHoldsProfile(500, dir, { commandLine, alive: () => false, platform: 'linux' }), false, 'Process is gone');
  assert.equal(await browserHoldsProfile(0, dir, { commandLine, alive, platform: 'linux' }), false);
});

test('W1-PROC-04 cleaning up leftovers does not kill other processes by mistake', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-reap-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  /** A chat directory: with registry file and (mock) expired lock */
  const makeSession = (name, owner) => {
    const sessionDir = path.join(base, name);
    const profile = path.join(sessionDir, 'profile');
    fs.mkdirSync(profile, { recursive: true });
    for (const lockName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.writeFileSync(path.join(profile, lockName), 'stale');
    if (owner) fs.writeFileSync(path.join(sessionDir, 'owner.json'), JSON.stringify(owner));
    return { sessionDir, profile };
  };
  /** Mock process table: pid → command line; killed processes are recorded and removed from table */
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

  /* Pid written in lock is alive, but that is a render service browser (after browser was
     force-killed, lock remained on disk and pid was reassigned by system to another process) */
  {
    const { sessionDir, profile } = makeSession('reused-lock', { servicePid: 1, browserPid: 4242, pids: [4242, 4243] });
    const w = world({ 4242: '/opt/render/chrome --user-data-dir=/srv/render/profile', 4243: 'node /srv/doc/main.mjs' });
    const result = await reapOrphan(sessionDir, { timeoutMs: 500, deps: w.deps({ holder: () => ({ held: true, pid: 4242 }) }) });
    assert.deepEqual(result, { found: false, killed: [], stillHeld: false });
    assert.deepEqual(w.killed, [], 'The render service\'s browser was not killed');
    assert.deepEqual(w.trees, [], 'And it was not killed by process group either');
    assert.deepEqual(fs.readdirSync(profile), [], 'The stale lock was removed (otherwise a newly started browser would contact the "old instance" at that unrelated process ID)');
    assert.equal(fs.existsSync(path.join(sessionDir, 'owner.json')), false);
  }

  /* Pid in lock belongs to another, and pid in registry file also belongs to another process
     (browser for another chat whose directory name starts with this directory) */
  {
    const { sessionDir, profile } = makeSession('reused-owner', { servicePid: 1, browserPid: 5001, pids: [5001] });
    const w = world({ 5001: `/opt/chrome-headless-shell --user-data-dir=${profile}-2 --remote-debugging-pipe`, 5002: 'sshd: admin' });
    const result = await reapOrphan(sessionDir, { timeoutMs: 500, deps: w.deps({ holder: () => ({ held: true, pid: 5002 }) }) });
    assert.equal(result.found, false);
    assert.deepEqual(w.killed, []);
    assert.deepEqual(w.trees, []);
  }

  /* Confirmed to be browser for this directory (pid in lock matches): kill it, and only kill it */
  {
    const { sessionDir, profile } = makeSession('real-orphan', { servicePid: 1, browserPid: 6001, pids: [6001, 6002] });
    const w = world({ 6001: `/opt/chrome-headless-shell --headless --user-data-dir=${profile} --remote-debugging-pipe`, 6002: 'node /srv/doc/main.mjs' });
    const result = await reapOrphan(sessionDir, { timeoutMs: 2_000, deps: w.deps({ holder: () => ({ held: true, pid: 6001 }) }) });
    assert.deepEqual(result, { found: true, killed: [6001], stillHeld: false });
    assert.deepEqual(w.killed, [6001], 'Child process ID 6002 in the registry file (now the document service) was not killed directly');
    assert.deepEqual(w.trees, [6001]);
    assert.equal(fs.existsSync(path.join(sessionDir, 'owner.json')), false);
  }

  /* chrome-headless-shell does not acquire locks: only has pid in registry file; kill if
     command line matches */
  {
    const { sessionDir, profile } = makeSession('shell-orphan', { servicePid: 1, browserPid: 7001, pids: [7001] });
    const w = world({ 7001: `/opt/chrome-headless-shell --headless --user-data-dir=${profile}` });
    const result = await reapOrphan(sessionDir, { timeoutMs: 2_000, deps: w.deps({ holder: () => ({ held: false, pid: null }) }) });
    assert.deepEqual(result.killed, [7001]);
  }

  /* Unkillable ones (always present in the process table): report truthfully as still held;
   * keep the registration to clean up next time */
  {
    const { sessionDir, profile } = makeSession('stubborn', { servicePid: 1, browserPid: 8001, pids: [8001] });
    const table = { 8001: `/opt/chrome --user-data-dir=${profile}` };
    const result = await reapOrphan(sessionDir, { timeoutMs: 300, deps: { platform: 'linux', commandLine: async (pid) => table[pid] ?? null, alive: (pid) => pid in table, kill: () => {}, killTree: () => {}, holder: () => ({ held: true, pid: 8001 }) } });
    assert.deepEqual(result, { found: true, killed: [8001], stillHeld: true });
    assert.equal(fs.existsSync(path.join(sessionDir, 'owner.json')), true);
  }

  /* Windows: lock file is exclusively held by someone, and the registered id is an unrelated live
   * process: do not kill, report truthfully as "still held"; clear expired registrations when the lock
   * is not held */
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

test('W1-PROC-05 a browser whose launching service process is still alive: the startup sweep leaves it alone, and it is cleaned only when a new browser is really started in this chat', async (t) => {
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
  // Rolling restart overlap period: the old service process (77) is still alive and its browser is in
  // use: do not kill during new process startup cleanup
  const overlap = await run('overlap', 77, { respectLiveOwner: true });
  assert.deepEqual(overlap.killed, []);
  assert.equal(overlap.result.liveOwner, true);
  assert.equal(overlap.result.found, false);
  assert.equal(fs.existsSync(path.join(overlap.sessionDir, 'owner.json')), true, 'The registry entry stays');
  // The old service process is gone: it is a true leftover, kill during cleanup
  assert.deepEqual((await run('dead-owner', 78, { respectLiveOwner: true })).killed, [7101]);
  // The registered one is this process itself (won't happen during cleanup, just a precaution):
  // kill anyway
  assert.deepEqual((await run('self-owner', 4000, { respectLiveOwner: true })).killed, [7101]);
  // Starting a new browser in this chat (without flags): clean up even if the old process is alive:
  // two browsers cannot use the same directory, and document service now only recognizes the new process
  assert.deepEqual((await run('launch-time', 77, {})).killed, [7101]);
});
