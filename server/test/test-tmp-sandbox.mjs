/**
 * Temporary-directory sandbox of `npm test` (entry: `scripts/test-suite.mjs`).
 *
 * The suite gives every test process a private temporary directory (`TMPDIR`, and `TEMP`/`TMP` on
 * Windows) inside its own `promptcut-test-*` directory and removes it when the run ends, so
 * whatever a test forgets to clean up never stays in the system temporary directory (a tmpfs on
 * the Linux machines we share, where it takes memory until the next reboot). What is left in the
 * sandbox when a run ends is reported by prefix: that is the list of tests that still need their
 * own cleanup. `PROMPTCUT_TEST_TMP_STRICT=1` turns the report into a failure.
 *
 * Two things must not follow the sandbox:
 *  - the port claims of `server/test/free-ports.mjs`, which only work while every process of
 *    every user looks at the same directory: the real system temporary directory is passed on in
 *    `PROMPTCUT_TEST_SHARED_TMP` (see `sharedTmpDir`);
 *  - nothing else; a test that writes to a literal `/tmp` escapes the sandbox, which `findEscaped`
 *    reports (entries of the same user that appeared there during the run).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SHARED_TMP_ENV = 'PROMPTCUT_TEST_SHARED_TMP';
export const STRICT_ENV = 'PROMPTCUT_TEST_TMP_STRICT';
/** Left alone by `findEscaped`: shared on purpose, see `free-ports.mjs`. */
const SHARED_ON_PURPOSE = new Set(['promptcut-test-port-claims']);

/** The temporary directory shared by all test processes, whatever `TMPDIR` the process has. */
export function sharedTmpDir(env = process.env) {
  return env[SHARED_TMP_ENV] || os.tmpdir();
}

/** Environment that makes a child process use `dir` as its temporary directory. */
export function sandboxEnv(dir, realTmp, env = process.env) {
  return { ...env, TMPDIR: dir, TEMP: dir, TMP: dir, [SHARED_TMP_ENV]: realTmp };
}

function sizeOf(entry) {
  let bytes = 0;
  let stat;
  try { stat = fs.lstatSync(entry); } catch { return 0; }
  if (!stat.isDirectory()) return stat.size;
  try {
    for (const name of fs.readdirSync(entry)) bytes += sizeOf(path.join(entry, name));
  } catch { /* disappeared meanwhile */ }
  return bytes;
}

/** Name without the random suffix of `mkdtemp` or the timestamp of a log: `pc-order-AbC123` → `pc-order`. */
export function prefixOf(name) {
  return name.replace(/(?:[-.]?\d{8,}|-?[A-Za-z0-9]{6})(?:\.[a-z]+)?$/, '') || name;
}

/** Entries of `dir` with sizes, grouped by prefix. */
export function describeEntries(dir, names = fs.readdirSync(dir)) {
  const byPrefix = new Map();
  let bytes = 0;
  for (const name of names) {
    const size = sizeOf(path.join(dir, name));
    bytes += size;
    const group = byPrefix.get(prefixOf(name)) ?? { count: 0, bytes: 0 };
    group.count += 1;
    group.bytes += size;
    byPrefix.set(prefixOf(name), group);
  }
  return { count: names.length, bytes, byPrefix };
}

/** Everything the run left in its sandbox. */
export function describeLeftovers(dir) {
  return describeEntries(dir);
}

/**
 * Entries of the real temporary directory created by this user since `since` (ms), apart from
 * `own` (the run's own directory) and the shared claims. Without uids (Windows) every recent entry counts.
 */
export function findEscaped(realTmp, since, own, uid = process.getuid?.()) {
  const names = [];
  for (const name of fs.readdirSync(realTmp)) {
    if (SHARED_ON_PURPOSE.has(name) || path.join(realTmp, name) === own) continue;
    if (name.startsWith('promptcut-test-')) continue; // another run's own directory, removed by that run
    let stat;
    try { stat = fs.lstatSync(path.join(realTmp, name)); } catch { continue; }
    if (uid != null && stat.uid !== uid) continue;
    if (Math.max(stat.birthtimeMs, stat.mtimeMs) < since) continue;
    names.push(name);
  }
  return names;
}

export function formatSize(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/** Report text, or '' when nothing is left. */
export function formatReport(title, { count, bytes, byPrefix }) {
  if (!count) return '';
  const rows = [...byPrefix].sort((a, b) => b[1].count - a[1].count).map(([name, g]) => `    ${name} ×${g.count} (${formatSize(g.bytes)})`);
  return `${title}: ${count} entries, ${formatSize(bytes)}\n${rows.join('\n')}`;
}

/** Empty `dir` but keep it. */
export function emptyDir(dir) {
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 3 });
}
