/**
 * A browser session for a Cloud Agent: **one browser process, one user data directory, one egress
 * proxy per "project × chat"**
 * (package W1 of plan `docs/plan/cloud-agent-tools-implementation.md`; contract
 * `docs/plan/cloud-agent-contract.md` sections 9.5 and 9.6).
 *
 * Differences from the desktop app (`server/web/browser.mjs`) are all because it runs on someone
 * else's machine with no one attending it:
 *
 *   - **Headless mode only**, no windows opened; there is no such thing as "moving in front of
 *     the user" (web takeover is a separate package).
 *   - **Connect to the browser via pipe** (`--remote-debugging-pipe`), no debug port opened:
 *     web pages cannot connect to the debug port; when the Agent service process dies, the pipe
 *     breaks and the browser exits on its own, leaving no unattended browser behind, nor is there
 *     any "taking over an old browser after restart".
 *   - **Egress only through this session's own proxy** (`network.mjs`); all other paths are
 *     blocked in the launch arguments.
 *   - **Environment variables rebuilt against an allowlist** (`childEnv` in `workspace.mjs`):
 *     the browser process contains no configuration or credentials of the Agent service, and no
 *     system proxy variables.
 *   - **All downloads rejected**; newly opened tabs are merged back into the current page;
 *     dialogs popped up by pages are automatically closed (no one is there to click them, leaving
 *     them open would freeze the page).
 *   - **Browser process spawned by itself** (`spawnTree` in
 *     `server/agent/service/perception/runner.mjs`, the same setup as other cloud subprocesses):
 *     on non-Windows it is a process group, killed and verified by group; puppeteer only speaks
 *     the debugging protocol over the pipe and does not use its launcher.
 *   - **Shutdown requires evidence**: after killing the entire tree, wait for main process exit
 *     and pipe closure, verify recorded PIDs one by one, and on non-Windows verify that the
 *     process group is empty (zombies count as exited) before considering it closed.
 *
 * Page logic for the action layer (open, view, click, type, scroll, read) reuses the desktop app's
 * `server/web/session.mjs`, `view.mjs`, and `hit.mjs`; manifest versions and "whether an index
 * still points to the original element" reside in `view.mjs` and `hit.mjs` (in this directory).
 *
 * This file does not handle authorization: who can use it and whether this round is still valid
 * are verified before and after each call by `server/agent/service/hosted-browser.mjs`.
 * Does not import `src/`.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { VIEWPORT } from '../browser.mjs';
import { read as desktopRead } from '../session.mjs';
import { childEnv } from '../../agent/service/workspace.mjs';
import { spawnTree, killTree, whenClosed, groupAlive } from '../../agent/service/perception/runner.mjs';
import { startBrowserProxy, hostedNetworkArgs, filterExtraArgs, pageRequestAllowed, isWebUrl, admitWebTarget, egressRefusalText } from './network.mjs';
import { captureHostedView, parseUid, PAGE_DATA_NOTICE } from './view.mjs';
import { resolveAt, explainPick, locate, focusElement, focusState, clearElement, explainStale, explainSecret } from './hit.mjs';

/** Record which process spawned the browser using this user data directory (used to clean orphans) */
export const OWNER_FILE = 'owner.json';
/**
 * Which version of the manifest this chat is on. Numbering continues across browser processes:
 * after closing and reopening, service restarts, or clearing the directory due to "set to private",
 * the new browser's version number will not collide with the version number of the old manifest
 * held by the model (if they collided, old indices would click elements on the new page).
 * It contains only a single number, not user data.
 */
export const REV_FILE = 'rev';

function readRev(sessionDir) {
  try {
    const n = Number(fs.readFileSync(path.join(sessionDir, REV_FILE), 'utf8').trim());
    return Number.isSafeInteger(n) && n >= 0 && n < 900_000_000 ? n : 0;
  } catch { return 0; }
}

/** Clear a chat's browser data. `keepRev`: keep the manifest version count (a number), delete everything else */
export async function removeSessionData(sessionDir, { keepRev = false, timeoutMs = 8_000 } = {}) {
  if (!keepRev) return removeDirFully(sessionDir, { timeoutMs });
  // Delete everything in the directory except the version count: the browser's HOME is this
  // directory; on Linux, besides profile/, it also writes to .pki/, .cache/, and .config/.
  let names;
  try { names = fs.readdirSync(sessionDir); } catch { return true; }
  let ok = true;
  for (const name of names) {
    if (name === REV_FILE) continue;
    ok = await removeDirFully(path.join(sessionDir, name), { timeoutMs }) && ok;
  }
  return ok;
}

/**
 * The leading launch argument. Chrome for Testing on this machine applies experimental
 * configurations by default, which occasionally causes pages to load indefinitely (see notes
 * in `scripts/probes/probe-chrome.mjs` for evidence); it does not matter if official releases
 * and chrome-headless-shell do not recognize it.
 */
export const HOSTED_BROWSER_ARG_PREFIX = Object.freeze(['--disable-field-trial-config']);

export class HostedSessionError extends Error {
  /** @param {string} code */
  constructor(code, message) {
    super(message);
    this.name = 'HostedSessionError';
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/** Whether the PID is still findable. EPERM means "present, but cannot be touched", which also counts as present */
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

/** Kill the entire process tree: the browser has render, GPU, network, and other child processes; killing only the main process would leave them behind */
export function killProcessTree(pid, child = null) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      const killer = nodeSpawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => { try { child?.kill('SIGKILL'); } catch { /* Already exited */ } });
      // taskkill itself can be very slow (when the machine is busy, querying the process tree can take
      // several seconds): do not let it block this process from exiting.
      killer.unref();
    } catch { try { child?.kill('SIGKILL'); } catch { /* Already exited */ } }
    return;
  }
  // The browser is started as the leader of a new process group (detached); negative PID =
  // the entire group
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited */ } }
}

/**
 * Linux: status letter and process group ID in `/proc/<pid>/stat`; returns null if unreadable.
 * Process names can contain spaces and parentheses, so parse after the last `)`: status,
 * parent PID, process group ID.
 */
export function procStat(pid, { procRoot = '/proc' } = {}) {
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const pgrp = Number(rest[2]);
    return { state: rest[0] ?? '', pgrp: Number.isSafeInteger(pgrp) ? pgrp : null };
  } catch { return null; }
}

/**
 * Whether the process is still **alive**: findable, and not a zombie.
 * Zombies are records of processes that are already dead and merely have not been reaped by their
 * parent process (they consume no memory, run no code, and make no requests); they count as
 * exited. When the Agent service is PID 1 in a container without an init process, killed browser
 * child processes (zygote, render processes) linger as zombies under the Agent service and remain
 * findable indefinitely: looking only at "whether it can be found" would never finish shutting down.
 */
export function pidLive(pid, { platform = process.platform, procRoot = '/proc', alive = pidAlive } = {}) {
  if (!alive(pid)) return false;
  if (platform !== 'linux') return true;
  const stat = procStat(pid, { procRoot });
  return !(stat && (stat.state === 'Z' || stat.state === 'X'));
}

/**
 * Linux: PIDs still alive (not zombies) in a process group. The browser is the leader of the
 * process group; the zygote, render, GPU, and network processes it spawns are all in this group,
 * including those not listed in the browser's own process table, so on Linux, "the entire tree has
 * exited" checks whether this group is empty. Returns null if /proc cannot be read (unknown).
 */
export function liveGroupMembers(pgid, { procRoot = '/proc' } = {}) {
  let names;
  try { names = fs.readdirSync(procRoot); } catch { return null; }
  const live = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const stat = procStat(Number(name), { procRoot });
    if (stat && stat.pgrp === pgid && stat.state !== 'Z' && stat.state !== 'X') live.push(Number(name));
  }
  return live;
}

/**
 * Whether there are still alive processes in this browser process group. Windows has no process
 * groups, returning null (there it relies on verifying PIDs one by one).
 * First query the system "whether the group still exists" (`groupAlive` in `runner.mjs`: ESRCH when
 * no processes remain in the group); if it still exists, filter out zombies.
 */
export function browserGroupLive(pgid, { platform = process.platform, procRoot = '/proc', group = groupAlive } = {}) {
  if (platform === 'win32' || !pgid) return null;
  if (group(pgid, { platform }) === false) return false;
  const live = liveGroupMembers(pgid, { procRoot });
  // Cannot read /proc (macOS): treat as still alive if the group still exists, rather than falsely
  // claiming it has exited cleanly.
  return live === null ? true : live.length > 0;
}

/** Wait until a set of PIDs are no longer alive (zombies count as exited); returns those still alive */
export async function waitPidsGone(pids, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let left = [...new Set(pids)].filter((pid) => pidLive(pid));
  while (left.length && Date.now() < end) {
    await sleep(50);
    left = left.filter((pid) => pidLive(pid));
  }
  return left;
}

/**
 * Transport layer speaking the debugging protocol with the browser over pipes (passed to
 * `puppeteer.connect({ transport })`): messages are JSON, terminated with NUL.
 * The browser is spawned directly by this file (`spawnTree`) without puppeteer's launcher,
 * so this short snippet is also written directly here.
 */
class PipeTransport {
  /** @param {import('node:stream').Writable} write Browser fd 3 (reads commands from here) @param {import('node:stream').Readable} read fd 4 (writes here) */
  constructor(write, read) {
    this.onmessage = null;
    this.onclose = null;
    this.closed = false;
    this.write = write;
    this.read = read;
    let pending = [];
    this.onData = (buffer) => {
      if (this.closed) return;
      pending.push(buffer);
      if (buffer.indexOf(0) === -1) return;
      const all = Buffer.concat(pending);
      let start = 0;
      for (let end = all.indexOf(0); end !== -1; end = all.indexOf(0, start)) {
        const message = all.toString('utf8', start, end);
        setImmediate(() => { if (!this.closed) this.onmessage?.call(null, message); });
        start = end + 1;
      }
      pending = start >= all.length ? [] : [all.subarray(start)];
    };
    this.onEnd = () => { this.onclose?.call(null); };
    read.on('data', this.onData);
    read.once('close', this.onEnd);
    read.on('error', () => {});
    write.on('error', () => {});
  }

  send(message) {
    if (this.closed || this.write.destroyed) return;
    try { this.write.write(message); this.write.write('\0'); } catch { /* The browser is already gone */ }
  }

  close() {
    this.closed = true;
    this.read.removeListener('data', this.onData);
  }
}

/**
 * Lock for this user data directory. **Only a clue, not proof**:
 * Windows: Full Chrome exclusively opens `lockfile` in the directory; `held` means "cannot open
 * it right now" (a process indeed holds it, but who is unknown);
 * Linux / macOS: `SingletonLock` in the directory is a symlink pointing to "hostname-pid",
 * `pid` is the number written inside, and `held` merely means "a process currently exists with
 * that PID": after the browser is forcefully killed, the link remains, and the PID may already
 * belong to another process. Whether someone is our browser is determined by `browserHoldsProfile`
 * checking the command line.
 * chrome-headless-shell acquires neither lock.
 * @returns {{ held: boolean, pid: number | null }}
 */
export function profileHolder(userDataDir) {
  if (process.platform === 'win32') {
    const lock = path.join(userDataDir, 'lockfile');
    let fd;
    try { fd = fs.openSync(lock, 'r+'); } catch (err) {
      return { held: err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES', pid: null };
    }
    try { fs.closeSync(fd); } catch { /* Already closed */ }
    return { held: false, pid: null };
  }
  try {
    const target = fs.readlinkSync(path.join(userDataDir, 'SingletonLock'));
    const pid = Number(/-(\d+)$/.exec(target)?.[1]);
    return { held: pidAlive(pid), pid: Number.isSafeInteger(pid) ? pid : null };
  } catch { return { held: false, pid: null }; }
}

/** A process's command line (null if not found). Linux reads /proc without child processes; Windows and macOS query the system, used only for cleaning leftovers */
export async function processCommandLine(pid, { timeoutMs = 15_000, platform = process.platform, procRoot = '/proc' } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (platform === 'linux') {
    try { return fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8').replace(/\0/g, ' ').trim() || null; } catch { return null; }
  }
  const [command, args] = platform === 'win32'
    ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`]]
    : ['ps', ['-o', 'command=', '-p', String(pid)]];
  return new Promise((resolve) => {
    let text = '';
    let child;
    try { child = nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Already exited */ } }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', () => { clearTimeout(timer); resolve(text.trim() || null); });
  });
}

/**
 * Windows: PIDs of all descendant processes of a process (returns empty if not found). Queries
 * the system only once when starting the browser.
 * The browser has several child processes not listed in its own process table (SystemInfo): crash
 * reporter helper processes, and the console host of chrome-headless-shell.
 * After the main process is terminated directly, testing shows such helper processes survive for
 * another few to ten-plus seconds and hold onto the pipe connected to this process: without
 * terminating them individually, "the entire tree has exited" will never be reached.
 */
export async function childPidsOf(pid, { timeoutMs = 8_000 } = {}) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return [];
  return new Promise((resolve) => {
    let text = '';
    let child;
    try {
      child = nodeSpawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId; $q = @(${pid}); while ($q.Count) { $c = @($all | Where-Object { $q -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId }); $c; $q = $c }`],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch { resolve([]); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Already exited */ } }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.once('error', () => { clearTimeout(timer); resolve([]); });
    child.once('close', () => {
      clearTimeout(timer);
      resolve(text.split(/\s+/).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0));
    });
  });
}

/** Whether a command line is "a browser launched with this user data directory": must have the complete `--user-data-dir=<this-dir>` argument, not just accidentally containing the string */
export function commandLineUsesProfile(line, userDataDir, platform = process.platform) {
  if (typeof line !== 'string' || !line || !userDataDir) return false;
  const fold = (text) => (platform === 'win32' ? text.toLowerCase() : text);
  const hay = fold(line);
  const needle = fold(`--user-data-dir=${userDataDir}`);
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    const before = at === 0 ? ' ' : hay[at - 1];
    const after = hay[at + needle.length] ?? ' ';
    if ((before === ' ' || before === '"') && (after === ' ' || after === '"')) return true;
  }
  return false;
}

/**
 * Whether this process is a browser currently using this user data directory. **Recognizes only
 * its own command line**: must contain `--user-data-dir=<this-dir>` to count.
 *
 * PIDs in lock files and registry files are merely "candidates" and cannot serve as proof: after
 * the browser is forcefully killed, the lock remains on disk, and that PID will later be assigned
 * by the system to other processes (the node has the render service's own browser, document
 * service, etc.); killing based solely on "the PID is still alive" would kill them by mistake.
 */
export async function browserHoldsProfile(pid, userDataDir, { commandLine = processCommandLine, alive = pidLive, platform = process.platform } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) return false;
  return commandLineUsesProfile(await commandLine(pid), userDataDir, platform);
}

/** Non-Windows: singleton lock in the user data directory (a symlink plus two accompanying files). They remain on disk after the browser is force-killed */
const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

/**
 * Clean up browsers left behind by the previous Agent service process (normally there are none:
 * once the pipe breaks, the browser exits on its own; this is a fallback).
 * Candidate PIDs come from lock files (non-Windows) and registry files; **kill only the one whose
 * command line genuinely includes this directory** (`browserHoldsProfile`).
 * If none of the candidates match: on non-Windows, delete stale locks (otherwise a newly spawned
 * browser will attempt to "contact the old instance" using the unrelated PID in the lock);
 * on Windows, if the lockfile is indeed exclusively held by someone who cannot be identified,
 * report truthfully that it is "still held".
 *
 * @param {string} sessionDir
 * @param {{ timeoutMs?: number, respectLiveOwner?: boolean, deps?: object }} [o] `respectLiveOwner`:
 *   Do not touch if the service process that spawned it is still alive (for startup cleanup);
 *   `deps` for unit tests only: `holder`, `commandLine`, `alive`, `kill`, `killTree`, `platform`, `selfPid`
 * @returns {Promise<{ found: boolean, killed: number[], stillHeld: boolean }>}
 */
export async function reapOrphan(sessionDir, { timeoutMs = 8_000, respectLiveOwner = false, deps = {} } = {}) {
  const {
    holder = profileHolder, commandLine = processCommandLine, alive = pidLive, platform = process.platform,
    kill = (pid) => process.kill(pid, 'SIGKILL'), killTree: killTreeOf = killProcessTree, selfPid = process.pid,
  } = deps;
  const userDataDir = path.join(sessionDir, 'profile');
  const forget = () => { try { fs.rmSync(path.join(sessionDir, OWNER_FILE), { force: true }); } catch { /* Safe to ignore if deletion fails */ } };
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(path.join(sessionDir, OWNER_FILE), 'utf8')); } catch { /* Not registered */ }
  const lock = holder(userDataDir);
  const candidates = [...new Set([lock.pid, owner?.browserPid].filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  let browserPid = null;
  for (const pid of candidates) {
    if (await browserHoldsProfile(pid, userDataDir, { commandLine, alive, platform })) { browserPid = pid; break; }
  }
  if (!browserPid) {
    if (platform === 'win32') {
      // The lockfile is exclusively held by someone who cannot be identified: cannot kill it, report
      // truthfully that it is "still held".
      if (lock.held) return { found: true, killed: [], stillHeld: true };
    } else {
      for (const name of SINGLETON_FILES) { try { fs.rmSync(path.join(userDataDir, name), { force: true }); } catch { /* Cannot delete: starting the browser will report it */ } }
    }
    forget();
    return { found: false, killed: [], stillHeld: false };
  }
  // The Agent service process that spawned it is still alive (during rolling restart, the old and
  // new service processes overlap briefly and share the data directory): this browser is not a
  // leftover, but is being used by the old process.
  // Leave it alone during startup cleanup (`respectLiveOwner`); when the old process exits and the
  // pipe breaks, it will exit on its own. If the PID in the registry was already taken by another
  // process, here we only under-kill, never mis-kill,
  // and when the time truly comes to start a new browser in this chat (without this flag), it will
  // still be cleaned up: by then, the document service will only recognize the new process.
  if (respectLiveOwner && Number.isSafeInteger(owner?.servicePid) && owner.servicePid > 0 && owner.servicePid !== selfPid && alive(owner.servicePid)) {
    return { found: false, killed: [], stillHeld: false, liveOwner: true };
  }
  // Directly terminate the main process (takes effect immediately), then kill again by tree
  // (Windows) or by group (others).
  // Child PIDs in the registry are not directly killed: they might have exited long ago and their
  // PIDs reassigned by the system to other processes; once the main process is gone, the browser's
  // child processes will exit on their own.
  try { kill(browserPid); } catch { /* Already exited */ }
  killTreeOf(browserPid);
  const end = Date.now() + timeoutMs;
  const held = () => alive(browserPid) || (platform === 'win32' && holder(userDataDir).held);
  let stillHeld = held();
  while (stillHeld && Date.now() < end) { await sleep(100); stillHeld = held(); }
  if (!stillHeld) {
    if (platform !== 'win32') for (const name of SINGLETON_FILES) { try { fs.rmSync(path.join(userDataDir, name), { force: true }); } catch { /* Left for browser startup to handle */ } }
    forget();
  }
  return { found: true, killed: [browserPid], stillHeld };
}

/** Delete the directory until it is truly gone (on Windows, file handles are released a moment after the process exits) */
export async function removeDirFully(dir, { timeoutMs = 8_000 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch { /* See results below */ }
    if (!fs.existsSync(dir)) return true;
    if (Date.now() > end) return false;
    await sleep(150);
  }
}

function dirBytes(dir) {
  let bytes = 0;
  const walk = (d) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { bytes += fs.statSync(p).size; } catch { /* Just deleted */ } }
    }
  };
  walk(dir);
  return bytes;
}

function withDeadline(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new HostedSessionError('timeout', `${what} did not finish within ${Math.round(ms / 1000)} seconds`)), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/* c8 ignore start - Executed inside page */
function keepInOneTab() {
  // There is only one page in the cloud: new windows and new tabs are always merged back into
  // the current page (with a server-side fallback: extra pages are closed directly)
  try {
    window.open = (url) => { try { if (url) location.assign(String(url)); } catch { /* Ignore invalid addresses */ } return null; };
  } catch { /* The page locked window (cannot override open): rely on server-side fallback */ }
  document.addEventListener('click', (event) => {
    const a = event.target && event.target.closest ? event.target.closest('a[target],area[target]') : null;
    if (a && a.target && a.target !== '_self') a.target = '_self';
  }, true);
  document.addEventListener('submit', (event) => {
    const f = event.target;
    if (f && f.target && f.target !== '_self') f.target = '_self';
  }, true);
}
/* c8 ignore stop */

/**
 * Start a session. Throws `HostedSessionError` (`browser-missing` / `profile-busy` / `launch-failed`) on failure.
 *
 * @param {object} o
 * @param {string} o.sessionDir Browser directory for this "project × chat" (provided by the host,
 *   not from tool parameters); user data directory is `profile/` under it
 * @param {string} o.executablePath Browser executable (configured by deployer)
 * @param {'new' | 'shell'} [o.headless] Which headless flavor; determined by filename by default
 *   (chrome-headless-shell → `shell`)
 * @param {object} o.gate Egress gate (returned by `createEgressGate`)
 * @param {object} o.limits Limits after merging `HOSTED_BROWSER_DEFAULTS`
 * @param {string[]} [o.argPrefix] Leading launch arguments (default `HOSTED_BROWSER_ARG_PREFIX`)
 * @param {string[]} [o.extraArgs] Extra launch arguments appended by deployer (sandbox, etc.;
 *   filters out modifying proxy or opening debug ports)
 * @param {object} [o.puppeteer] Replaceable for testing (must have `defaultArgs` and `connect`)
 * @param {typeof spawnTree} [o.spawnBrowser] Function to spawn browser process, replaceable for testing
 * @param {(event: string, fields?: object) => void} [o.log]
 */
export async function launchHostedSession({ sessionDir, executablePath, headless, gate, limits, argPrefix = HOSTED_BROWSER_ARG_PREFIX, extraArgs = [], puppeteer, spawnBrowser = spawnTree, log = () => {}, now = () => Date.now() }) {
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failure does not affect operation */ } };
  if (typeof executablePath !== 'string' || !executablePath) throw new HostedSessionError('browser-missing', 'No browser is configured on this node');
  try { if (!fs.statSync(executablePath).isFile()) throw new Error('not a file'); } catch { throw new HostedSessionError('browser-missing', 'No browser is configured on this node'); }
  const userDataDir = path.join(sessionDir, 'profile');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(path.join(sessionDir, '.tmp'), { recursive: true });

  // Browser left by previous process still occupies this directory: clean it up first; if not, do
  // not launch (two browsers cannot share a directory)
  const orphan = await reapOrphan(sessionDir);
  if (orphan.found) say('agent.web.orphan-reaped', { killed: orphan.killed.length, stillHeld: orphan.stillHeld });
  if (orphan.stillHeld) throw new HostedSessionError('profile-busy', 'The browser directory of this chat is held by a leftover browser process, so the browser was not opened this time.');

  const mode = headless ?? (/headless[-_]shell/i.test(path.basename(executablePath)) ? 'shell' : 'new');
  const proxy = await startBrowserProxy({ gate, maxTunnels: limits.maxTunnels, log });
  const extra = filterExtraArgs(extraArgs);
  if (extra.dropped.length) say('agent.web.extra-args-dropped', { count: extra.dropped.length });
  // Leading arguments and deployer-appended arguments go through the same filter
  const prefix = filterExtraArgs(argPrefix);
  if (prefix.dropped.length) say('agent.web.extra-args-dropped', { count: prefix.dropped.length });
  let args = [];
  const ownArgs = [
    ...hostedNetworkArgs(proxy.url),
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    `--disk-cache-size=${limits.diskCacheBytes}`,
    `--media-cache-size=${limits.diskCacheBytes}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--disable-extensions',
    '--disable-breakpad',
    '--deny-permission-prompts',
    '--hide-crash-restore-bubble',
    '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,InterestFeedContentSuggestions',
    ...extra.args,
  ];

  // The browser is spawned by this file itself (`runner.mjs`'s `spawnTree`: no popup window, no shell;
  // on non-Windows it is the leader of a new process group, and the zygote, render, GPU, and network
  // processes it spawns are all in this group, killed and verified by group), and puppeteer is only
  // responsible for speaking the debugging protocol over the pipe.
  let browser;
  let proc;
  let transport = null;
  try {
    // Only use two things from it: compute default launch arguments and connect over pipe. Use
    // puppeteer-core if available (without browser-downloading half); fall back to puppeteer if not
    const pptr = puppeteer ?? (await import('puppeteer-core').catch(() => import('puppeteer'))).default;
    const base = await pptr.defaultArgs({ headless: mode === 'shell' ? 'shell' : true, userDataDir, args: ownArgs });
    args = [...prefix.args, ...base, '--remote-debugging-pipe'];
    proc = spawnBrowser(executablePath, args, { cwd: sessionDir, env: childEnv(sessionDir), stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    const started = whenClosed(proc);
    if (!proc.pid || !proc.stdio?.[3] || !proc.stdio?.[4]) throw new Error('browser did not start');
    transport = new PipeTransport(proc.stdio[3], proc.stdio[4]);
    browser = await withDeadline(Promise.race([
      pptr.connect({ transport, defaultViewport: { ...VIEWPORT } }),
      started.then(() => { throw new Error('browser exited during launch'); }),
    ]), limits.launchMs, 'launching the browser');
  } catch (err) {
    if (proc?.pid) { killTree(proc); await Promise.race([whenClosed(proc), sleep(limits.closeMs)]); }
    try { transport?.close(); } catch { /* Already closed */ }
    await proxy.close();
    say('agent.web.launch-failed', { message: String(err?.message ?? err).slice(0, 160) });
    throw new HostedSessionError('launch-failed', 'The cloud browser failed to start. Tell the user to contact the host to check the node.');
  }

  const browserPid = proc.pid;
  /** Browser process tree PIDs **at this moment** (refreshed to latest copy after each action; does not keep old ones: exited render process PIDs may have been reassigned by OS to another process) */
  let pids = new Set([browserPid]);
  /** Helper child processes not listed in process table (see `childPidsOf`, only recorded on Windows); live with the browser, recorded once at startup */
  const helpers = new Set();
  let exited = false;
  /** Both `exit` and `close` (pipes closed too) of the main process have arrived */
  const gone = whenClosed(proc).then(() => { exited = true; });
  const processGone = () => gone;
  /**
   * Kill the entire tree.
   * Non-Windows: `killTree` kills by process group (even if the leader exited first, processes
   * remaining in the group are still killed by group).
   * Windows: No process groups. First terminate recorded processes from latest process table plus
   * helper processes one by one directly (takes effect immediately), then use `killTree` (taskkill
   * by parent-child relationships) to catch those not in the table:
   * taskkill alone is not enough: when machine is busy, querying process tree takes several seconds,
   * and once the main process is gone, it can no longer find the tree.
   */
  const killAll = () => {
    if (process.platform === 'win32') {
      for (const pid of new Set([...pids, ...helpers])) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited */ } }
    }
    killTree(proc);
    return true;
  };

  const state = {
    rev: readRev(sessionDir), // Manifest version (continues numbering from previous browser of this chat)
    viewEpoch: -1,          // Page generation when this manifest version was produced
    epoch: 0,               // Page generation: increments by one on each main-frame navigation
    marks: new Map(),       // id → fingerprint
    opened: false,          // Whether any web page has been opened
    hasView: false,         // Whether this browser has produced any manifest
    blocked: [],            // Items blocked during this action (downloads, protocols, new tabs, dialogs)
    lastNavRequestAt: 0,
    lastNavEndedAt: 0,      // Timestamp when main frame navigation request finished or failed (finished without page change = downloads, 204, etc.)
    closed: false,
    closing: null,
    lastUsedAt: now(),
    busy: 0,
  };
  const noteBlocked = (item) => { if (state.blocked.length < 20) state.blocked.push(item); };

  let page;
  let cdp;
  try {
    cdp = await browser.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    cdp.on('Browser.downloadWillBegin', (event) => {
      noteBlocked({ kind: 'download', name: String(event?.suggestedFilename ?? '').slice(0, 80) });
      say('agent.web.download-denied', {});
    });
    page = (await browser.pages())[0] ?? await browser.newPage();
    await page.setViewport({ ...VIEWPORT });
    page.setDefaultTimeout(limits.actionMs);
    page.setDefaultNavigationTimeout(limits.navigationMs);
    await page.evaluateOnNewDocument(keepInOneTab);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      let url = '';
      try { url = request.url(); } catch { /* Request is already gone */ }
      const allowed = pageRequestAllowed(url);
      try {
        if (!allowed) {
          noteBlocked({ kind: 'protocol', scheme: (/^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1] ?? '').toLowerCase() });
          say('agent.web.scheme-blocked', {});
          void request.abort('blockedbyclient').catch(() => {});
          return;
        }
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) state.lastNavRequestAt = now();
        void request.continue().catch(() => {});
      } catch { /* Interception handle invalid (page navigated away): ignore */ }
    });
    const navEnded = (request) => {
      try {
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
        state.lastNavEndedAt = now();
        // Main frame navigation rejected by proxy: plaintext returns 403 with reason code; https fails
        // to establish tunnel
        const code = request.response()?.headers()?.['x-egress-refused'];
        if (code) noteBlocked({ kind: 'egress', code: String(code).slice(0, 40) });
        else if (/ERR_TUNNEL_CONNECTION_FAILED/.test(String(request.failure()?.errorText ?? ''))) noteBlocked({ kind: 'egress', code: 'refused' });
      } catch { /* Request is already gone */ }
    };
    page.on('requestfinished', navEnded);
    page.on('requestfailed', navEnded);
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) state.epoch += 1; });
    page.on('dialog', (dialog) => {
      noteBlocked({ kind: 'dialog', type: dialog.type(), text: String(dialog.message() ?? '').slice(0, 120) });
      void dialog.dismiss().catch(() => {});
    });
    // Fallback: if the page still opened another tab (bypassed keepInOneTab), close it
    browser.on('targetcreated', (target) => {
      if (target.type() !== 'page') return;
      void (async () => {
        try {
          const other = await target.page();
          if (other && other !== page) { noteBlocked({ kind: 'popup' }); await other.close({ runBeforeUnload: false }); }
        } catch { /* Already closed */ }
      })();
    });
    browser.on('disconnected', () => { state.closed = true; });
  } catch (err) {
    killAll();
    await Promise.race([processGone(), sleep(limits.closeMs)]);
    await proxy.close();
    say('agent.web.launch-failed', { message: String(err?.message ?? err).slice(0, 160) });
    throw new HostedSessionError('launch-failed', 'The cloud browser failed to start. Tell the user to contact the host to check the node.');
  }

  /** Refresh process tree PIDs (render processes change with navigations) */
  async function refreshPids() {
    if (state.closed) return [...pids];
    try {
      const info = await withDeadline(cdp.send('SystemInfo.getProcessInfo'), 2_000, 'fetching the process table');
      const current = new Set(browserPid ? [browserPid] : []);
      for (const p of info?.processInfo ?? []) if (Number.isSafeInteger(p?.id) && p.id > 0) current.add(p.id);
      pids = current;
      fs.writeFileSync(path.join(sessionDir, OWNER_FILE), JSON.stringify({ servicePid: process.pid, browserPid, pids: [...pids], at: now() }));
    } catch { /* If unavailable, use the existing one */ }
    return [...pids];
  }
  await refreshPids();
  // Query system in background once: among main process descendants, those not in process table
  // are helper processes
  const helpersKnown = (async () => {
    if (process.platform !== 'win32' || !browserPid) return;
    const before = new Set(pids);
    const children = await childPidsOf(browserPid);
    if (state.closed && !children.length) return;
    await refreshPids();
    for (const pid of children) if (!before.has(pid) && !pids.has(pid) && pidAlive(pid)) helpers.add(pid);
  })().catch(() => {});
  say('agent.web.launched', { mode, processes: pids.size });

  /* ---------------------------------------------------------------- Serialization and finalize */

  let queue = Promise.resolve();
  /** Browser for a chat has only one page, actions are serialized; entire action has a time limit */
  function enqueue(job, what) {
    const run = async () => {
      if (state.closed) throw new HostedSessionError('closed', 'The browser is already closed.');
      state.busy += 1;
      // After timeout, this action must not touch page: each subsequent operation must pass check()
      const token = { dead: false };
      const check = (guard) => {
        if (token.dead) throw new HostedSessionError('timeout', `${what} has already timed out, and the later steps were not run`);
        if (state.closed) throw new HostedSessionError('closed', 'The browser is already closed.');
        guard?.();
      };
      try { return await withDeadline(job(check), limits.actionMs, what); }
      catch (err) {
        token.dead = true;
        // Action interrupted halfway: page state is uncertain, this manifest version is invalidated
        state.viewEpoch = -1;
        throw err;
      }
      finally { state.busy -= 1; state.lastUsedAt = now(); }
    };
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  /** Finalize each action: produce a new version of the manifest */
  async function finish(extra = {}) {
    state.rev += 1;
    // Record version before handing out manifest: version numbers seen by model are guaranteed
    // written to disk, so next browser will not reuse them
    try { fs.writeFileSync(path.join(sessionDir, REV_FILE), String(state.rev)); } catch { /* Cannot write: still no duplicates within this browser */ }
    state.hasView = true;
    const epochBefore = state.epoch;
    const { result, marks } = await captureHostedView(page, state.rev);
    state.marks = marks;
    // Page navigated again during screenshot: this manifest version is expired and marked mismatched;
    // actions will be rejected
    state.viewEpoch = epochBefore === state.epoch ? state.epoch : -1;
    void refreshPids();
    const out = { ...result, ...extra, ok: true };
    if (state.blocked.length) {
      // Blocked items since previous manifest (including background page actions between two actions);
      // cleared once handed out
      out.blocked = state.blocked.splice(0);
      // Dialog text and download filenames in blocked come from the page, treated as data (results carry
      // dataNotice); this description is fixed
      out.blockedNote = 'Something in this step was blocked by the cloud: '
        + [...new Set(out.blocked.map((b) => ({ download: 'download (the cloud browser does not download files)', protocol: 'non-http(s) address', popup: 'newly opened tab', dialog: 'dialog popped up by the page (closed automatically)', egress: 'the address the page tried to navigate to was rejected by the egress restrictions (the cloud node itself, internal network, etc. are not allowed)' })[b.kind] ?? b.kind))].join(', ') + '.';
    }
    return out;
  }

  /** After typing: if the page starts navigating, wait for it to settle */
  async function settle(sinceEpoch, inputAt) {
    await sleep(350);
    if (state.lastNavRequestAt >= inputAt && state.epoch === sinceEpoch) {
      const end = now() + limits.settleMs;
      while (state.epoch === sinceEpoch && now() < end && !state.closed) {
        // Request finished (or failed) without page change: responses like downloads or 204 that do not
        // change page, no need to wait further
        if (state.lastNavEndedAt >= state.lastNavRequestAt) { await sleep(250); break; }
        await sleep(60);
      }
    }
    await sleep(150);
  }

  /** Whether id is valid (version, page generation, fingerprint present); returns reason if not */
  function checkUid(u) {
    const parsed = parseUid(u);
    if (!parsed) return { reason: 'format' };
    if (!state.hasView) return { reason: parsed.rev <= state.rev ? 'old_rev' : 'no_view' };
    if (parsed.rev !== state.rev) return { reason: 'old_rev' };
    if (state.viewEpoch !== state.epoch) return { reason: 'navigated' };
    const mark = state.marks.get(u);
    if (!mark) return { reason: 'gone' };
    return { mark };
  }

  /** Reply when an id has expired. Sentence is fixed; text on covering layer comes from page, placed separately in coveredBy and marked as data */
  const stale = (reason, detail = {}) => ({
    ok: false, stale: true, reason, error: explainStale(reason, detail),
    ...(reason === 'covered' && typeof detail.by === 'string' && detail.by ? { coveredBy: detail.by, dataNotice: PAGE_DATA_NOTICE } : {}),
  });

  /* ---------------------------------------------------------------- Actions */

  /**
   * Open a link. The address passes through egress gate in this process first (disallowed ones
   * are rejected on the spot without touching the browser); each request sent by the browser then
   * passes through the proxy individually.
   * @param {string} input Address provided by the model
   * @param {{ guard?: () => void }} [o] Gate called again before actually touching the page
   *   (throws if revoked this round)
   */
  const open = (input, { guard } = {}) => enqueue(async (check) => {
    const admitted = await admitWebTarget(gate, input);
    if (!admitted.ok) return admitted.result;
    const target = admitted.target;
    check(guard);
    const mark = proxy.seq;
    const blockedBefore = state.blocked.length;
    let response = null;
    let failure = null;
    try {
      response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: limits.navigationMs });
    } catch (err) { failure = err; }
    state.opened = true;
    const refused = proxy.refusedSince(mark);
    const landed = page.url();
    // Landed on non-http(s) address (normally unreachable: blocked at entry and request interception):
    // navigate back to blank page
    if (!isWebUrl(landed) && landed !== 'about:blank' && !landed.startsWith('chrome-error://')) {
      try { await page.goto('about:blank', { timeout: 5_000 }); } catch { /* Report truthfully even if unable to navigate back */ }
      return { ok: false, error: 'Not opened: the Cloud Agent\'s browser only opens http / https addresses.', refused: 'protocol' };
    }
    // Rejected by egress gate: for plaintext (including redirected hops), the last response carries
    // reason code; for https, tunnel fails to establish and reason code is in proxy logs.
    // Other rejections in proxy logs (browser's background requests) do not count: only recognize
    // single failure type "tunnel failure".
    const proxyRefusedMain = response?.headers?.()['x-egress-refused'];
    const tunnelRefused = failure && /ERR_TUNNEL_CONNECTION_FAILED/.test(String(failure?.message ?? '')) && refused.filter((e) => e.kind === 'connect').pop();
    if (proxyRefusedMain || tunnelRefused) {
      const code = proxyRefusedMain ?? tunnelRefused.code;
      // This rejection has already been reported here; no need to mention it again in next manifest
      state.blocked.splice(blockedBefore);
      return { ok: false, error: `Not opened: this address (or the address it redirects to) was refused. ${egressRefusalText(code)}`, egress: code };
    }
    // When download is rejected, browser reports "navigation aborted"; "this is a download" event
    // arrives one tick later
    if (failure && /ERR_ABORTED/.test(String(failure?.message ?? '')) && !state.blocked.some((b) => b.kind === 'download')) await sleep(400);
    if (failure && state.blocked.some((b) => b.kind === 'download')) {
      state.blocked.splice(blockedBefore);
      return { ok: false, refused: 'download', error: 'Not opened: this address is a file download, and the Cloud Agent\'s browser does not download files. To bring media from the web into the project, use media collection or the tool that imports media by address.' };
    }
    if (failure) {
      if (failure instanceof HostedSessionError) throw failure;
      // Original text reported by browser contains page-controllable text such as addresses, which are
      // not concatenated into sentences: only extract error code (fixed uppercase string) separately
      const text = String(failure?.message ?? failure);
      const timedOut = /timeout|timed out/i.test(text);
      const netError = /net::(ERR_[A-Z0-9_]{1,60})/.exec(text)?.[1] ?? null;
      return {
        ok: false,
        error: timedOut ? `This page did not finish loading within ${Math.round(limits.navigationMs / 1000)} seconds, so it was not opened.` : 'Not opened: the page failed to load (cannot connect, bad certificate, address does not exist, and the like). Try another address, or try again later.',
        ...(netError ? { netError } : {}),
      };
    }
    return finish({ navigated: target });
  }, 'open web page');

  const view = () => enqueue(async () => {
    if (!state.opened) return { ok: false, error: 'No web page is open in the browser yet. Use web_open to open a link first.' };
    return finish();
  }, 'screenshot');

  /**
   * Click. `u` is the versioned id; or `x,y` are coordinates on the most recent image (strongly
   * recommended to include `expect`).
   * Before clicking, verify that the id still points to that element in manifest, and clicking
   * will not land on another element.
   */
  const click = ({ u, x, y, expect } = {}, { guard } = {}) => enqueue(async (check) => {
    if (!state.opened) return { ok: false, error: 'No web page is open in the browser yet. Use web_open to open a link first.' };
    let uid = typeof u === 'string' && u ? u : null;
    let positional = false;
    if (!uid) {
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, error: 'Give either u, or x,y. x,y are pixel coordinates on the image returned by the last web_view.' };
      }
      if (!state.hasView) return stale('no_view');
      if (state.viewEpoch !== state.epoch) return stale('navigated');
      const res = await resolveAt(page, x, y, { expect: typeof expect === 'string' && expect ? expect : null });
      if (!res.ok) {
        // Sentence is fixed; candidate element names and text seen at that position come from the page
        // and are placed only in separate fields
        return {
          ok: false, reason: res.reason, error: explainPick(res),
          ...(res.cands ? { candidates: res.cands } : {}),
          ...(typeof res.saw === 'string' && res.saw ? { seen: res.saw } : {}),
          dataNotice: PAGE_DATA_NOTICE,
        };
      }
      uid = res.pick.u;
      positional = true;
    }
    const checked = checkUid(uid);
    if (checked.reason) return stale(checked.reason, { u: uid });
    const spot = await locate(page, uid, checked.mark, { positional });
    if (!spot.ok) return stale(spot.reason, { u: uid, by: spot.by });
    check(guard);
    const epoch = state.epoch;
    const at = now();
    await page.mouse.click(spot.x, spot.y);
    await settle(epoch, at);
    return finish({ clicked: { u: uid, n: spot.label } });
  }, 'click');

  /**
   * Type text into an input box. Fields like passphrases, verification codes, and card numbers are
   * not filled.
   * Text is only allowed into this one input box: re-verify after focusing (do not type if check fails);
   * typing is split into small chunks, checking whether focus remains on it before each chunk and
   * after all typing completes:
   * if the page moves focus to another box halfway (such as a passphrase box), stop and report
   * truthfully without pressing Enter.
   */
  const type = ({ u, text, append = false, submit = false } = {}, { guard } = {}) => enqueue(async (check) => {
    if (!state.opened) return { ok: false, error: 'No web page is open in the browser yet. Use web_open to open a link first.' };
    if (typeof u !== 'string' || !u) return { ok: false, error: 'u is required: the ID of that input box in the clickable manifest.' };
    const value = String(text ?? '');
    if (value.length > limits.maxTypeChars) return { ok: false, error: `At most ${limits.maxTypeChars} characters can be typed at a time.` };
    const checked = checkUid(u);
    if (checked.reason) return stale(checked.reason, { u });
    const spot = await locate(page, u, checked.mark);
    if (!spot.ok) return stale(spot.reason, { u, by: spot.by });
    if (spot.secret) return { ok: false, refused: 'credentials', error: explainSecret(spot.secret) };
    if (!spot.editable) return { ok: false, error: 'The element this ID refers to is not a text input.' };
    if (spot.disabled) return { ok: false, error: 'This input box cannot be edited right now (disabled or read-only).' };
    check(guard);
    await page.mouse.click(spot.x, spot.y);
    // Do not type if focus did not land on this input box: text must not enter elsewhere
    if (!await focusElement(page, u)) return stale('covered', { u });
    // Re-verify after clicking: if missing, content changed, or covered, reject as expired; if changed
    // to a passphrase box (some sites change type only on focus), do not fill
    const again = await locate(page, u, checked.mark);
    if (!again.ok) return stale(again.reason, { u, by: again.by });
    if (again.secret) return { ok: false, refused: 'credentials', error: explainSecret(again.secret) };
    if (!again.editable || again.disabled) return stale('changed', { u });
    /** Focus lost, or it became a passphrase box halfway: stop and report truthfully */
    const stopped = (focus, typedChars) => {
      state.viewEpoch = -1;
      if (focus.ok && focus.secret) return { ok: false, refused: 'credentials', typedChars, error: explainSecret(focus.secret) };
      return {
        ok: false, reason: 'focus_moved', typedChars,
        error: `Focus left this input box partway through typing (the page moved it away, or the input box is gone), so typing stopped: the remaining characters were not typed and Enter was not pressed. Keystrokes for ${typedChars} characters had been sent before it stopped. Use web_view first to see what the page looks like now.`,
      };
    };
    check(guard);
    let focus = await focusState(page, u);
    if (!focus.ok || !focus.focused || focus.secret) return stopped(focus, 0);
    if (!append) await clearElement(page, u);
    let typedChars = 0;
    const chars = Array.from(value);
    for (let at = 0; at < chars.length; at += limits.typeChunkChars) {
      if (at > 0) {
        focus = await focusState(page, u);
        if (!focus.ok || !focus.focused || focus.secret) return stopped(focus, typedChars);
      }
      check(guard);
      const chunk = chars.slice(at, at + limits.typeChunkChars);
      await page.keyboard.type(chunk.join(''), { delay: limits.typeDelayMs });
      typedChars += chunk.length;
    }
    focus = await focusState(page, u);
    if (!focus.ok || !focus.focused || focus.secret) return stopped(focus, typedChars);
    if (submit) {
      check(guard);
      const epoch = state.epoch;
      const at = now();
      await page.keyboard.press('Enter');
      await settle(epoch, at);
    }
    return finish({ typed: { u, submit: submit === true } });
  }, 'type');

  const scroll = ({ dy, to } = {}, { guard } = {}) => enqueue(async (check) => {
    if (!state.opened) return { ok: false, error: 'No web page is open in the browser yet. Use web_open to open a link first.' };
    const args = {};
    if (to === 'top' || to === 'bottom') args.to = to;
    else if (to !== undefined && to !== null) return { ok: false, error: 'to can only be "top" or "bottom".' };
    if (dy !== undefined && dy !== null) {
      if (typeof dy !== 'number' || !Number.isFinite(dy)) return { ok: false, error: 'dy must be a number (page pixels, positive scrolls down).' };
      args.dy = Math.max(-limits.maxScrollPx, Math.min(limits.maxScrollPx, dy));
    }
    check(guard);
    // Same scrolling behavior as desktop app scroll() (defaults to 600, waits half a second after
    // scrolling for lazy loading to fill in); not called directly because it takes its own screenshot
    const amount = args.dy ?? 600;
    await page.evaluate((dy, where) => {
      if (where === 'top') scrollTo({ top: 0 });
      else if (where === 'bottom') scrollTo({ top: document.body.scrollHeight });
      else scrollBy({ top: dy });
    }, amount, args.to ?? null);
    await sleep(500);
    return finish({ scrolled: args.to || amount });
  }, 'scroll');

  /** Read main text, do not return images */
  const read = ({ limit } = {}) => enqueue(async () => {
    if (!state.opened) return { ok: false, error: 'No web page is open in the browser yet. Use web_open to open a link first.' };
    let n = 8000;
    if (limit !== undefined && limit !== null) {
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) return { ok: false, error: 'limit must be a positive number.' };
      n = Math.min(Math.floor(limit), limits.maxReadChars);
    }
    const out = await desktopRead(page, { limit: n });
    return { ...out, dataNotice: PAGE_DATA_NOTICE };
  }, 'read body text');

  /* ---------------------------------------------------------------- Close */

  /**
   * Close this session: the entire browser process tree exits and the proxy is closed; when
   * `removeProfile` is set, the user data directory is deleted as well.
   * Returns proof, not "close issued": `exited` is true if and only if both main process exit and pipe
   * closure have arrived, every recorded PID is no longer alive, and (on non-Windows) no live
   * processes remain in the browser's process group.
   *
   * @param {{ graceful?: boolean, removeProfile?: boolean, removeAll?: boolean, reason?: string }} [o]
   *   `graceful`: Let the browser exit on its own first (flushing cookies to disk); when authorization
   *     is revoked, kill directly without this chance.
   *   `removeProfile`: Delete user data directory (keeping manifest version count);
   *     `removeAll`: Delete entire directory (chat and project gone).
   */
  function close({ graceful = true, removeProfile = false, removeAll = false, reason = 'close' } = {}) {
    const wipe = () => removeSessionData(sessionDir, { keepRev: !removeAll, timeoutMs: limits.closeMs });
    if (state.closing) {
      // Already closing: subsequent calls only perform the additional step of "delete directory"
      return state.closing.then(async (first) => {
        if (!(removeProfile || removeAll)) return first;
        return { ...first, profileRemoved: await wipe() };
      });
    }
    state.closing = (async () => {
      // If helper process list query is still running (closed right after launch), wait for it; if unable
      // to query, proceed with what is known
      await Promise.race([helpersKnown, sleep(limits.closeMs)]);
      const known = [...new Set([...await refreshPids(), ...helpers])];
      state.closed = true;
      if (graceful && browser.connected !== false) {
        // Request it to exit on its own, and wait for it to actually exit (it flushes cookies to disk
        // before exiting); kill it if it still has not exited by the deadline
        try { await withDeadline(browser.close(), limits.gracefulCloseMs, 'close browser'); } catch { /* Kill if it refuses to exit */ }
        await Promise.race([processGone(), sleep(limits.gracefulCloseMs)]);
      }
      // Regardless of whether it exited on its own, directly terminate each recorded process once: after
      // main process exits, child processes on busy machines can take several seconds to follow
      killAll();
      const quick = await Promise.race([processGone().then(() => true), sleep(1_500).then(() => false)]);
      if (!quick && process.platform === 'win32') {
        // Anyone still holding the pipe without exiting: likely a helper process missed at launch. Even
        // without main process, descendants can still be queried by parent-child relations and terminated
        for (const pid of await childPidsOf(browserPid, { timeoutMs: limits.closeMs })) {
          if (!pidAlive(pid)) continue;
          helpers.add(pid);
          known.push(pid);
          try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited */ }
        }
      }
      await Promise.race([processGone(), sleep(limits.closeMs)]);
      // Child processes may take a moment after main process exits; verify one by one and kill any
      // remaining directly
      let alive = await waitPidsGone(known, 1_500);
      for (const pid of alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited */ } }
      if (alive.length) alive = await waitPidsGone(alive, limits.closeMs);
      // Non-Windows: check whether browser process group is empty (unlisted processes like zygote are
      // also in the group; zombies excluded).
      // If group still has living processes (spawned after group cleanup at main process exit): group
      // still has members, so group ID will not be reused, and can be killed by group again
      let groupLive = browserGroupLive(browserPid);
      const groupEnd = Date.now() + limits.closeMs;
      while (groupLive === true && Date.now() < groupEnd) {
        try { process.kill(-browserPid, 'SIGKILL'); } catch { /* No more processes in the group */ }
        await sleep(100);
        groupLive = browserGroupLive(browserPid);
      }
      try { browser.disconnect(); } catch { /* Already disconnected */ }
      try { transport.close(); } catch { /* Already closed */ }
      const proxyClosed = await proxy.close();
      let profileRemoved = false;
      let profileBytes = null;
      if (removeProfile || removeAll) profileRemoved = await wipe();
      else {
        try { fs.rmSync(path.join(sessionDir, OWNER_FILE), { force: true }); } catch { /* Safe to ignore if deletion fails */ }
        // User data directory exceeds limit: delete entirely (login state is lost too), to prevent a single
        // chat from filling up disk
        profileBytes = dirBytes(userDataDir);
        if (profileBytes > limits.maxProfileBytes) {
          profileRemoved = await removeSessionData(sessionDir, { keepRev: true, timeoutMs: limits.closeMs });
          say('agent.web.profile-over-limit', { bytes: profileBytes });
        }
      }
      const exitedAll = alive.length === 0 && exited && groupLive !== true;
      say('agent.web.closed', { reason, exited: exitedAll, processes: known.length, profileRemoved });
      return { exited: exitedAll, pids: known, alivePids: alive, groupLive, proxyClosed: proxyClosed.closed, profileRemoved, profileBytes };
    })();
    return state.closing;
  }

  return {
    sessionDir,
    userDataDir,
    mode,
    args,
    browserPid,
    /** Kill entire process tree (issued synchronously; check receipts of `processGone` and `close()` for whether it actually exited) */
    kill: killAll,
    proxy,
    /** PIDs of entire process tree at this moment (those in process table, plus helper processes) */
    pids: () => [...new Set([...pids, ...helpers])],
    /** Whether helper process list query is finished (tests wait for it) */
    helpersKnown,
    refreshPids,
    get rev() { return state.rev; },
    get opened() { return state.opened; },
    get closed() { return state.closed; },
    get busy() { return state.busy > 0; },
    get lastUsedAt() { return state.lastUsedAt; },
    /** Whether the process has really exited (both exit and close arrived) */
    get processExited() { return exited; },
    /** Still alive at this moment: whether main process exit event arrived, recorded PIDs still alive, live processes in process group (used for recheck after close) */
    leftovers: () => ({ exited, alivePids: [...new Set([...pids, ...helpers])].filter((pid) => pidLive(pid)), groupLive: browserGroupLive(browserPid) }),
    processGone,
    /** Current URL of the current page at this moment (only used by "web handoff" to get address); returns null if no page or closed. Does not touch page content */
    currentUrl: () => { try { return state.closed || !state.opened ? null : String(page.url() || '') || null; } catch { return null; } },
    open, view, click, type, scroll, read, close,
  };
}
