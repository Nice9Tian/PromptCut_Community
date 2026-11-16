/**
 * Stopping a job's whole process tree on Linux and macOS.
 *
 * The dev server's Python jobs (speech-to-text, media collect, subject detection) start other
 * programs themselves: yt-dlp runs ffmpeg to merge streams, pip runs build tools. On Windows the
 * plugins stop a job with `taskkill /F /T`, which takes the whole tree. Elsewhere they called
 * `child.kill()`, which signals only the direct child, so whatever that child had started kept
 * running after a cancel or a timeout.
 *
 * `killTreePosix` is the counterpart of `taskkill /T`: read the process table once, collect
 * everything descended from the job's process, and signal all of it.
 *
 * Why by parent-child relationship and not by process group (the way the Cloud Agent's
 * `spawnTree` in `server/agent/service/perception/runner.mjs` does it): a group needs the child
 * started with `detached`, which also takes it out of the terminal's foreground group, and then
 * Ctrl+C in the terminal running `npm run dev` would stop the dev server and leave the job
 * running. A service with no terminal does not have that problem; a dev server does.
 *
 * The same limit as `taskkill /T` applies: a process whose parent has already exited is no longer
 * connected to the tree and is not found.
 *
 * Only the Node standard library is used.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Parent PID from the text of `/proc/<pid>/stat`, or null when it cannot be read.
 * The process name is in parentheses and may itself contain spaces and parentheses, so the fields
 * are counted from the last `)`: state, then parent PID.
 */
export function parentPidFromStat(text) {
  const close = String(text ?? '').lastIndexOf(')');
  if (close < 0) return null;
  const ppid = Number(text.slice(close + 1).trim().split(/\s+/)[1]);
  return Number.isSafeInteger(ppid) && ppid >= 0 ? ppid : null;
}

/**
 * Every process with its parent, as `{ pid, ppid }`.
 * Linux reads `/proc` (no process started); macOS and the rest ask `ps`. Returns an empty list
 * when neither works, and the caller then signals the root alone.
 * @param {{ platform?: string, procRoot?: string, run?: typeof spawnSync }} [deps] for unit tests
 */
export function processTable({ platform = process.platform, procRoot = '/proc', run = spawnSync } = {}) {
  const rows = [];
  if (platform === 'linux') {
    let names = [];
    try { names = fs.readdirSync(procRoot); } catch { return rows; }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      let ppid = null;
      try { ppid = parentPidFromStat(fs.readFileSync(path.join(procRoot, name, 'stat'), 'utf8')); } catch { /* Exited while listing */ }
      if (ppid !== null) rows.push({ pid: Number(name), ppid });
    }
    return rows;
  }
  try {
    const out = run('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000 });
    for (const line of String(out?.stdout ?? '').split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]) });
    }
  } catch { /* No ps: fall back to the root alone */ }
  return rows;
}

/** PIDs descended from `rootPid` in `table`, nearest first; the root itself is not included */
export function descendantsOf(rootPid, table) {
  const children = new Map();
  for (const { pid, ppid } of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const pid of children.get(queue.shift()) ?? []) {
      if (seen.has(pid)) continue; // A table read while processes come and go can contain a loop
      seen.add(pid);
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

/**
 * Signal a process and everything descended from it (Linux / macOS; on Windows use taskkill).
 * The table is read before anything is signalled, because a child whose parent is gone can no
 * longer be traced. The root goes first, so it cannot start a replacement for a child it sees die.
 * Never touches PID 1 or this process.
 *
 * @param {number | undefined | null} rootPid
 * @param {{ signal?: NodeJS.Signals, table?: () => Array<{ pid: number, ppid: number }>, kill?: (pid: number, signal: string) => void, selfPid?: number }} [deps]
 *   `table`, `kill`, `selfPid` are for unit tests
 * @returns {number[]} the PIDs a signal was delivered to
 */
export function killTreePosix(rootPid, { signal = 'SIGKILL', table = processTable, kill = process.kill.bind(process), selfPid = process.pid } = {}) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1 || rootPid === selfPid) return [];
  let rows = [];
  try { rows = table(); } catch { /* Cannot list: the root alone */ }
  const signalled = [];
  for (const pid of [rootPid, ...descendantsOf(rootPid, rows)]) {
    if (pid <= 1 || pid === selfPid) continue;
    try { kill(pid, signal); signalled.push(pid); } catch { /* Already exited */ }
  }
  return signalled;
}
