/** Shared pieces of the installed-application reopen acceptance (`reopen-installed.mjs`).
 * The checks that decide whether a launch counts are pure functions so they can be unit tested;
 * the Windows queries behind them are read-only (`reopen-installed-query.ps1`).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'reopen-installed-query.ps1'), openScript = path.join(here, 'reopen-installed-open.ps1');
const shellDir = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0');
const powershell = path.join(shellDir, 'powershell.exe');
const queryArgs = extra => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra];
/** The helper must load Windows PowerShell's own modules even when the caller's PSModulePath points elsewhere. */
function queryEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PSMODULEPATH' && k.toUpperCase() !== 'NODE_OPTIONS'));
  return { ...env, PSModulePath: path.join(shellDir, 'Modules') };
}
const same = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();

export const sha256File = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** `--remote-debugging-port=N` in a WebView2 command line, or null. */
export function debuggingPort(commandLine) {
  const port = Number(/--remote-debugging-port=(\d{1,5})(?!\d)/.exec(String(commandLine ?? ''))?.[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** Does this process row prove that the shell started the expected program with the expected file?
 * @returns {{ ok: boolean, reasons: string[] }} every failed condition, so a wrong launch is explained */
export function launchReceipt(row, { exe, file, armedAt, parentName, parentPid }) {
  const reasons = [];
  if (!row || !Number.isInteger(row.pid) || row.pid <= 0) return { ok: false, reasons: ['no process'] };
  if (!row.exe || !same(row.exe, exe)) reasons.push('another executable');
  if (!String(row.commandLine ?? '').toLowerCase().includes(String(file).toLowerCase())) reasons.push('command line lacks the file');
  const created = Date.parse(row.createdAt), armed = Date.parse(armedAt);
  if (!(created >= armed)) reasons.push('started before the hand-off was armed');
  // When this probe asked Explorer itself to open the file, the helper it started is known by id and may already be gone.
  if (Number.isInteger(parentPid) && row.parentPid === parentPid) return { ok: reasons.length === 0, reasons };
  if (String(row.parentName ?? '').toLowerCase() !== String(parentName).toLowerCase()) reasons.push(`parent is ${row.parentName ?? 'unknown'}, not ${parentName}`);
  // A recycled process id can make an unrelated program look like the parent.
  else if (!(Date.parse(row.parentCreatedAt) <= created)) reasons.push('parent is younger than the launched process');
  return { ok: reasons.length === 0, reasons };
}

/** Compare an installed runtime with a release manifest (`files`: relative path → SHA-256). */
export function verifyPayload(appDir, manifest) {
  const missing = [], mismatched = [];
  for (const [rel, expected] of Object.entries(manifest.files ?? {})) {
    const file = path.join(appDir, rel);
    if (!fs.existsSync(file)) missing.push(rel); else if (sha256File(file) !== expected) mismatched.push(rel);
  }
  return { files: Object.keys(manifest.files ?? {}).length, missing, mismatched };
}

/** Is the program Windows runs for `.proc` the installed build described by the manifest? Read-only. */
export function installedIdentity(association, { manifest, appSrcHash }) {
  const reasons = [];
  if (!association?.exe || !fs.existsSync(association.exe)) return { ok: false, reasons: ['.proc has no installed program'] };
  const exe = fs.realpathSync(association.exe), installDir = path.dirname(exe), runtime = path.join(installDir, 'runtime');
  if (path.basename(exe).toLowerCase() !== 'promptcut.exe') reasons.push(`.proc opens ${path.basename(exe)}`);
  if (association.userChoice && association.userChoice !== association.progId) reasons.push('a per-user choice overrides the installed association');
  let versions = null, payload = null;
  // A patched installation has this file rewritten by PowerShell, with a byte order mark.
  try { versions = JSON.parse(fs.readFileSync(path.join(runtime, 'VERSIONS.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { reasons.push('installed runtime has no readable VERSIONS.json'); }
  if (versions && versions.appSrcHash !== appSrcHash) reasons.push('installed runtime is not the candidate (appSrcHash differs)');
  if (versions && manifest.appVersion && versions.app !== manifest.appVersion) reasons.push('installed application version differs from the manifest');
  if (!reasons.length) {
    payload = verifyPayload(path.join(runtime, 'app'), manifest);
    if (payload.missing.length || payload.mismatched.length) reasons.push(`installed files differ from the manifest (${payload.missing.length} missing, ${payload.mismatched.length} changed)`);
  }
  return { ok: reasons.length === 0, reasons, exe, installDir, exeSha256: sha256File(exe), versions,
    payload: payload && { files: payload.files, missing: payload.missing.length, mismatched: payload.mismatched.length, sample: [...payload.missing, ...payload.mismatched].slice(0, 10) } };
}

/** Have Explorer open a program or a file as it would for the user; returns the helper process it started. */
export function openThroughExplorer(target) {
  return JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', openScript, '-Path', target], { windowsHide: true, env: queryEnv(), encoding: 'utf8' }).trim());
}
export function queryAssociation() {
  return JSON.parse(execFileSync(powershell, queryArgs(['-Mode', 'assoc']), { windowsHide: true, env: queryEnv(), encoding: 'utf8' }).trim());
}
export function queryProcesses(exe) {
  const out = JSON.parse(execFileSync(powershell, queryArgs(['-Mode', 'processes', '-Exe', exe]), { windowsHide: true, env: queryEnv(), encoding: 'utf8' }).trim());
  // PowerShell 5 unwraps one-element arrays when it converts to JSON.
  const list = value => (value == null ? [] : Array.isArray(value) ? value : [value]);
  return { processes: list(out.processes), webviews: list(out.webviews) };
}
/** Start watching for new processes of `exe`; resolves once the watcher has its baseline. */
export async function watchLaunches(exe, timeoutSec = 3600) {
  const child = spawn(powershell, queryArgs(['-Mode', 'watch', '-Exe', exe, '-TimeoutSec', String(timeoutSec)]), { windowsHide: true, env: queryEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const rows = []; let ready, failed = '';
  const started = new Promise((resolve, reject) => { ready = resolve; child.once('exit', code => reject(new Error(`launch watcher exited (${code}) ${failed.slice(0, 200)}`))); child.once('error', reject); });
  child.stderr.on('data', b => { failed += b; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let row; try { row = JSON.parse(line); } catch { return; }
    if (row.watching) ready(row); else rows.push(row);
  });
  const baseline = await started;
  return { rows, existing: baseline.existing, stop() { if (child.exitCode === null) child.kill(); } };
}

/** One file the operator (a person or a computer-use session) reads to know what to double-click. */
export function handoffWriter(controlDir) {
  fs.mkdirSync(controlDir, { recursive: true });
  const file = path.join(controlDir, 'handoff.json'); let seq = 0;
  return {
    file,
    write(state) {
      const record = { kind: 'promptcut-installed-double-click-v1', seq: ++seq, at: new Date().toISOString(), ...state };
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2)); fs.renameSync(`${file}.tmp`, file);
      console.log(JSON.stringify({ phase: 'handoff', ...record }));
      return record;
    },
  };
}
