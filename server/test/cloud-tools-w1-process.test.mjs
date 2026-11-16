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
 *   W1-PROC-06  The browser's temporary directory off Windows is short enough for Chrome's
 *               singleton socket whatever the session directory is; a system temporary directory
 *               that is itself too long falls back to `/tmp`; Windows keeps `.tmp` under the
 *               session directory
 *   W1-PROC-07  Deleting a browser temporary directory: only a `pcb-XXXXXX` directory directly
 *               under a candidate directory; cleaning up a leftover deletes the one recorded in
 *               the registry file, and leaves it alone while the launching service is alive
 *   W1-PROC-08  A browser that aborts while starting: the reason it printed is in the log, the
 *               temporary directory it was given is deleted (this one starts a process: a shell
 *               script standing in for the browser, so it is skipped on Windows)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  procStat, pidLive, liveGroupMembers, browserGroupLive, processCommandLine, commandLineUsesProfile, browserHoldsProfile, reapOrphan,
  socketPathLimit, singletonSocketPathLength, browserTempBases, createBrowserTempDir, removeBrowserTempDir, launchStderrSummary,
  launchHostedSession, HostedSessionError,
} from '../web/hosted/session.mjs';
import { createEgressGate } from '../agent/service/egress.mjs';
import { HOSTED_BROWSER_DEFAULTS } from '../agent/service/hosted-browser.mjs';

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

/** What Chrome appends to its temporary directory for the singleton socket */
const SOCKET_TAIL = '/org.chromium.Chromium.XXXXXX/SingletonSocket';
const POSIX_ONLY = process.platform === 'win32' ? 'creates directories under /tmp, which Windows does not have' : false;

test('W1-PROC-06 the socket path limit and which directory the temporary directory goes in', () => {
  assert.equal(socketPathLimit('linux'), 107);
  assert.equal(socketPathLimit('darwin'), 103);
  assert.equal(singletonSocketPathLength('/tmp'), '/tmp/pcb-XXXXXX'.length + SOCKET_TAIL.length);
  assert.ok(singletonSocketPathLength('/tmp') <= socketPathLimit('darwin'), '/tmp fits on every platform');
  // macOS's own temporary directory leaves no room, which is why /tmp is the second candidate
  assert.ok(singletonSocketPathLength('/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T') > socketPathLimit('darwin'));
  // The candidate list is only ever built off Windows, and it resolves the system directory the
  // way the running platform does ('/tmp' is 'D:\\tmp' to Windows), so it is checked there only
  if (process.platform !== 'win32') {
    assert.deepEqual(browserTempBases({ tmpdir: () => '/tmp' }), ['/tmp']);
    assert.deepEqual(browserTempBases({ tmpdir: () => '/var/tmp/' }), ['/var/tmp', '/tmp']);
  }
});

test('W1-PROC-06 Windows keeps .tmp under the session directory', (t) => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-tmp-'));
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const temp = createBrowserTempDir(sessionDir, { platform: 'win32' });
  assert.deepEqual(temp, { dir: path.join(sessionDir, '.tmp'), own: false });
  assert.equal(fs.statSync(temp.dir).isDirectory(), true);
});

test('W1-PROC-06 off Windows the temporary directory is short whatever the session directory is', { skip: POSIX_ONLY }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-tmp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The shape of a real one: <dataDir>/web/<project>/<chat>
  const sessionDir = path.join(root, 'agent', 'web', 'sp_example-8ed356bb7d2b', 'conversation_example-ecef2ab1a126');
  fs.mkdirSync(sessionDir, { recursive: true });
  assert.ok((path.join(sessionDir, '.tmp') + SOCKET_TAIL).length > socketPathLimit('linux'), 'the old location is past the limit');

  const temp = createBrowserTempDir(sessionDir, { platform: 'linux', tmpdir: () => root });
  t.after(() => fs.rmSync(temp.dir, { recursive: true, force: true }));
  assert.equal(temp.own, true);
  assert.equal(path.dirname(temp.dir), root);
  assert.match(path.basename(temp.dir), /^pcb-[A-Za-z0-9]{6}$/);
  assert.ok((temp.dir + SOCKET_TAIL).length <= socketPathLimit('linux'));
  assert.equal(fs.statSync(temp.dir).mode & 0o777, 0o700, 'private to the service user');
  assert.equal(fs.existsSync(path.join(sessionDir, '.tmp')), false, 'nothing is created in the session directory');

  // The service's own TMPDIR is long: fall back to /tmp instead of failing
  const long = path.join(root, 'x'.repeat(60));
  fs.mkdirSync(long);
  const fallback = createBrowserTempDir(sessionDir, { platform: 'linux', tmpdir: () => long });
  t.after(() => fs.rmSync(fallback.dir, { recursive: true, force: true }));
  assert.equal(path.dirname(fallback.dir), '/tmp');

  // The preferred one cannot be written (does not exist): the next candidate is used
  const missing = createBrowserTempDir(sessionDir, { platform: 'linux', tmpdir: () => path.join(root, 'gone') });
  t.after(() => fs.rmSync(missing.dir, { recursive: true, force: true }));
  assert.equal(path.dirname(missing.dir), '/tmp');
});

test('W1-PROC-07 deleting a temporary directory only touches a pcb-XXXXXX directory directly under a candidate directory', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-tmp-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const deps = { tmpdir: () => root };
  const make = (...parts) => { const dir = path.join(root, ...parts); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'f'), 'x'); return dir; };

  const good = make('pcb-Ab12Cd');
  assert.equal(removeBrowserTempDir(good, deps), true);
  assert.equal(fs.existsSync(good), false);
  assert.equal(removeBrowserTempDir(good, deps), true, 'already gone counts as gone');

  for (const [why, dir] of [
    ['another name', make('other-Ab12Cd')],
    ['a longer name with the same prefix', make('pcb-Ab12Cd-profile')],
    ['one level down', make('nested', 'pcb-Ab12Cd')],
    ['the candidate directory itself', root],
  ]) {
    assert.equal(removeBrowserTempDir(dir, deps), false, why);
    assert.equal(fs.existsSync(dir), true, why);
  }
  assert.equal(removeBrowserTempDir('pcb-Ab12Cd', deps), false, 'a relative path');
  assert.equal(removeBrowserTempDir([root, 'nested', '..', 'pcb-Zz99Zz'].join(path.sep), deps), false, 'a path that is not normalised');
  assert.equal(removeBrowserTempDir(null, deps), false);

  // A file with the right name, and a directory owned by someone else: left alone
  const file = path.join(root, 'pcb-File00');
  fs.writeFileSync(file, 'x');
  assert.equal(removeBrowserTempDir(file, deps), false);
  const foreign = make('pcb-Other0');
  assert.equal(removeBrowserTempDir(foreign, { ...deps, getuid: () => fs.statSync(foreign).uid + 1 }), false);
  assert.equal(fs.existsSync(foreign), true);

  if (process.platform !== 'win32') {
    // A link with the right name pointing at a real directory: neither is deleted
    const target = make('target');
    const link = path.join(root, 'pcb-Link00');
    fs.symlinkSync(target, link);
    assert.equal(removeBrowserTempDir(link, deps), false);
    assert.equal(fs.existsSync(path.join(target, 'f')), true);
  }
});

test('W1-PROC-07 cleaning up a leftover deletes its recorded temporary directory, but not while the launching service is alive', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-tmp-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const run = async (name, { browserAlive, options = {} }) => {
    const sessionDir = path.join(base, name);
    const profile = path.join(sessionDir, 'profile');
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'owner.json'), JSON.stringify({ servicePid: 77, browserPid: 7101, pids: [7101], tmpDir: `/tmp/pcb-${name}` }));
    const table = { 77: 'node /srv/agent/main.mjs' };
    if (browserAlive) table[7101] = `/opt/chrome --headless=new --user-data-dir=${profile}`;
    const removed = [];
    const result = await reapOrphan(sessionDir, { timeoutMs: 1_000, ...options, deps: {
      platform: 'linux', selfPid: 4000, holder: () => ({ held: false, pid: null }), commandLine: async (pid) => table[pid] ?? null,
      alive: (pid) => pid in table, kill: (pid) => { delete table[pid]; }, killTree: () => {}, removeTemp: (dir) => { removed.push(dir); return true; },
    } });
    return { result, removed, registered: fs.existsSync(path.join(sessionDir, 'owner.json')) };
  };
  // The browser exited on its own after the service died (the usual case): only the directory is left
  const exited = await run('exited', { browserAlive: false });
  assert.deepEqual(exited.removed, ['/tmp/pcb-exited']);
  assert.equal(exited.registered, false);
  // The browser is still there: killed, then its directory deleted
  const killed = await run('killed', { browserAlive: true });
  assert.deepEqual(killed.result.killed, [7101]);
  assert.deepEqual(killed.removed, ['/tmp/pcb-killed']);
  // Rolling restart: the old service is still using that browser, so its directory stays too
  const overlap = await run('overlap', { browserAlive: true, options: { respectLiveOwner: true } });
  assert.equal(overlap.result.liveOwner, true);
  assert.deepEqual(overlap.removed, []);
  assert.equal(overlap.registered, true);
});

test('W1-PROC-08 what is kept of standard error when the browser fails to start', () => {
  const sandbox = '[438988:438988:1117/061523.123456:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If you are running on Ubuntu 23.10+ ...';
  assert.equal(
    launchStderrSummary(`\n[1:1:1117/061523.000001:ERROR:dbus/bus.cc:408] Failed to connect to the bus\n${sandbox}\n`),
    '[FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If you are running on Ubuntu 23.10+ ...',
    'FATAL lines win, and the pid / time prefix is dropped',
  );
  assert.equal(launchStderrSummary('a\nb\r\nc\nd\n'), 'b | c | d', 'no FATAL line: the last three');
  assert.equal(launchStderrSummary(''), '');
  assert.equal(launchStderrSummary(undefined), '');
  assert.equal(launchStderrSummary(`[FATAL:x.cc:1] ${'y'.repeat(2_000)}`).length, 600);
});

test('W1-PROC-08 a browser that aborts while starting: its reason is logged and its temporary directory deleted', { skip: POSIX_ONLY }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-tmp-'));
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = root; // The service's temporary directory: where the browser's own one is created
  t.after(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
    fs.rmSync(root, { recursive: true, force: true });
  });
  // Stands in for Chrome aborting the way it does when the socket path is too long: says why on
  // standard error (with the temporary directory it was given), then exits before the pipe answers
  const fake = path.join(root, 'fake-chrome');
  fs.writeFileSync(fake, '#!/bin/sh\necho "[1:1:1117/000000.000000:ERROR:noise.cc:1] unrelated" >&2\necho "[1:1:1117/000000.000001:FATAL:chrome/browser/process_singleton_posix.cc:313] Socket path too long: $TMPDIR/org.chromium.Chromium.aVTYfZ/SingletonSocket." >&2\nexit 1\n', { mode: 0o755 });
  const sessionDir = path.join(root, 'agent', 'web', 'sp_example-8ed356bb7d2b', 'conversation_example-ecef2ab1a126');
  const logs = [];
  await assert.rejects(
    launchHostedSession({
      sessionDir, executablePath: fake, gate: createEgressGate({ testAllow: [] }), limits: { ...HOSTED_BROWSER_DEFAULTS, launchMs: 10_000, closeMs: 2_000 },
      puppeteer: { defaultArgs: async () => [], connect: () => new Promise(() => {}) },
      log: (event, fields) => logs.push({ event, ...fields }),
    }),
    (err) => err instanceof HostedSessionError && err.code === 'launch-failed',
  );
  const failed = logs.filter((l) => l.event === 'agent.web.launch-failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].stderr, /^\[FATAL:chrome\/browser\/process_singleton_posix\.cc:313\] Socket path too long: /);
  assert.doesNotMatch(failed[0].stderr, /unrelated/);
  // The directory the browser was told to use: short, under the service's temporary directory, and gone now
  const given = /too long: (\S+)\/org\.chromium/.exec(failed[0].stderr)?.[1];
  assert.equal(path.dirname(given), root);
  assert.match(path.basename(given), /^pcb-[A-Za-z0-9]{6}$/);
  assert.equal(fs.existsSync(given), false);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith('pcb-')), []);
  assert.equal(fs.existsSync(path.join(sessionDir, '.tmp')), false);
});
