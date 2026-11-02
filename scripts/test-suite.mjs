/**
 * Test subprocesses of Node 24.19 occasionally crash natively with 0xC0000005 on Windows
 * (nodejs/node#65756), and the spec reporter only displays "test failed" for the whole file
 * without printing subprocess exit codes.
 *
 * npm test uses this script to run the original full command, retaining real-time spec output
 * while attaching an event reporter; each file-level failure prints exit code, meaning, reported
 * test count, and stderr line count; diagnosis of the first exception cannot be skipped.
 * Only rerun individually files that have no assertion failures and terminated abnormally,
 * at most twice; only when root summary shows original failures were exclusively these files
 * with no cancelled items will passing reruns return success. Reruns might mask non-deterministic
 * native crashes, so initial exit information is always retained in terminal output.
 *
 * Can be removed after upgrading to Node versions containing nodejs/node#65778: v26.10.0 and above,
 * or a v24.x release incorporating backported nodejs/node#66168.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canRecoverInitialRun, exitDescription, retryReason, rootSummaryCounts, summarizeTestEvents } from './test-suite-policy.mjs';

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const reporter = path.join(root, 'scripts', 'test-event-reporter.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-test-'));
/*
 * Tests to run by default.
 *
 * A2 (2026-10-28) moved cloud-exclusive tests and probes to the closed-source directory
 * (mirroring the original directory structure). They still need to run in the private repository;
 * in the public repository that directory does not exist at all, making these an empty set.
 *
 * The closed-source directory is located via `PROMPTCUT_CLOUD_DIR`, defaulting to `cloud` under
 * the repository root: the same convention as `server/docservice/extensions.mjs` and
 * `server/vite-plugin-hosted-gate.ts`: after switching to the submodule layout, the closed-source
 * directory is no longer under the public repository root, so hardcoding paths would make these
 * entries always miss. This file is therefore registered in `LOADER_WHITELIST` of
 * `server/test/community-ownership.mjs`.
 */
function defaultGlobs() {
  const base = ['server/test/*.test.mjs', 'src/**/*.test.mjs', 'tools/report-worker/*.test.mjs'];
  const envDir = process.env.PROMPTCUT_CLOUD_DIR?.trim();
  const cloudDir = envDir ? path.resolve(envDir) : path.join(root, 'cloud');
  if (!fs.existsSync(cloudDir)) return base;
  const rel = path.relative(root, cloudDir).split(path.sep).join('/') || '.';
  return [...base, `${rel}/server/test/*.test.mjs`, `${rel}/src/**/*.test.mjs`];
}

const files = process.argv.length > 2 ? process.argv.slice(2) : defaultGlobs();
const baseArgs = ['--experimental-test-module-mocks', '--test-global-setup=server/test/global-setup.mjs', '--test'];

// Watchdog: if a test file process exceeds the time limit without exiting (common cause: services
// were not closed after test failures, so the process cannot exit), kill its process tree.
// Killed files are recorded by the test runner as file-level failures; they are named again here
// and listed before the final summary. Does not alter pass/fail verdicts of other files.
// Do not use node's built-in --test-force-exit: in experiments it caused otherwise passing files
// (such as asset-announce) to be recorded as file-level failures.
const WATCHDOG_MS = Number(process.env.PROMPTCUT_TEST_FILE_LIMIT_MS) || 15 * 60 * 1000;
const WATCHDOG_POLL_MS = Number(process.env.PROMPTCUT_TEST_WATCHDOG_POLL_MS) || 30 * 1000;
const killedByWatchdog = [];

function listChildren(parentPid) {
  const rows = [];
  if (process.platform === 'win32') {
    const script = `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, [int]((Get-Date) - $_.CreationDate).TotalMilliseconds, $_.CommandLine }`;
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    for (const line of (out.stdout ?? '').split(/\r?\n/)) {
      const [pid, age, ...cmd] = line.split('|');
      if (pid && age !== undefined) rows.push({ pid: Number(pid), ageMs: Number(age), cmd: cmd.join('|') });
    }
  } else {
    const out = spawnSync('ps', ['-o', 'pid=,etimes=,args=', '--ppid', String(parentPid)], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    for (const line of (out.stdout ?? '').split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match) rows.push({ pid: Number(match[1]), ageMs: Number(match[2]) * 1000, cmd: match[3] });
    }
  }
  return rows;
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20000 });
  else { spawnSync('pkill', ['-KILL', '-P', String(pid)], { windowsHide: true }); try { process.kill(pid, 'SIGKILL'); } catch {} }
}

function watchdog(runnerPid) {
  const timer = setInterval(() => {
    for (const row of listChildren(runnerPid)) {
      const file = /([^\s"']+\.test\.mjs)/.exec(row.cmd)?.[1];
      if (!file || row.ageMs < WATCHDOG_MS) continue;
      console.error(`
⏱ Watchdog: process of ${file} (pid ${row.pid}) has been running for ${Math.round(row.ageMs / 1000)} seconds without finishing, exceeding the ${Math.round(WATCHDOG_MS / 1000)} second limit; force-killing its process tree`);
      killedByWatchdog.push(file);
      killTree(row.pid);
    }
  }, WATCHDOG_POLL_MS);
  timer.unref();
  return timer;
}

async function run(testFiles, attempt) {
  const report = path.join(temp, `events-${attempt}.ndjson`);
  const args = [...baseArgs, '--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${pathToFileURL(reporter).href}`, `--test-reporter-destination=${report}`, ...testFiles];
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    const dog = watchdog(child.pid);
    child.once('close', () => clearInterval(dog));
    child.once('error', (error) => { console.error(`Failed to start test process: ${error.message}`); resolve(1); });
    child.once('close', (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1));
  });
  let events = [];
  if (fs.existsSync(report)) {
    try {
      events = fs.readFileSync(report, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      console.error(`Failed to read test event report: ${error.message}`);
      return { code: 1, events: [], files: [], reportError: true };
    }
  }
  return { code, events, files: summarizeTestEvents(events, root), reportError: !fs.existsSync(report) };
}

function note(file, attempt, retriable) {
  const { exitCode, signal } = file.processFailure;
  const status = signal ? `signal=${signal}` : `exitCode=${exitDescription(exitCode)}`;
  console.error(`\n${retriable ? '⚠ Test file process crashed' : '✖ File-level failure (not retried)'}: ${file.file} (time ${attempt})`);
  console.error(`  ${status}; reported cases=${file.testCases}; stderr=${file.stderrLines} lines${retriable ? '; see nodejs/node#65756: https://github.com/nodejs/node/issues/65756' : ''}`);
}

function reportKilled() {
  if (killedByWatchdog.length) console.error(`⏱ Test files killed by the watchdog (counted as failed): ${[...new Set(killedByWatchdog)].join(', ')}`);
}

async function main() {
  const first = await run(files, 'all');
  if (first.code === 0) {
    const counts = rootSummaryCounts(first.events);
    if (first.reportError || !counts || counts.failed !== 0 || counts.cancelled !== 0) {
      console.error('✖ Test root summary is missing or inconsistent with the exit code, keeping the failure');
      return 1;
    }
    console.log('✓ npm test final result: zero failures');
    return 0;
  }
  if (first.reportError) return 1;

  const failures = first.files.filter((file) => file.assertionFailures > 0 || file.processFailure);
  const retryable = failures.filter((file) => retryReason(file));
  for (const file of failures) if (file.processFailure) note(file, 1, Boolean(retryReason(file)));
  let unrecovered = !canRecoverInitialRun(first.events, first.files);
  for (const file of retryable) {
    let recovered = false;
    for (let retry = 1; retry <= 2; retry++) {
      console.error(`↻ Rerunning ${file.file} on its own (${retry}/2)`);
      const result = await run([file.file], `${path.basename(file.file)}-${retry}`);
      const retryCounts = rootSummaryCounts(result.events);
      if (result.code === 0 && !result.reportError && retryCounts?.failed === 0 && retryCounts.cancelled === 0) {
        console.error(`✓ ${file.file} passed on rerun; the first crash was recorded`);
        recovered = true;
        break;
      }
      const next = result.files.find((entry) => path.normalize(entry.file).toLowerCase() === path.normalize(file.file).toLowerCase());
      if (!next || !retryReason(next)) {
        if (next?.processFailure) note(next, retry + 1, false);
        console.error(`✖ ${file.file} rerun did not give a fully successful result, keeping the failure`);
        break;
      }
      note(next, retry + 1, true);
    }
    if (!recovered) unrecovered = true;
  }
  if (unrecovered) {
    console.error('✖ npm test final result: failures remain');
    return 1;
  }
  console.log(`✓ npm test final result: zero failures (${retryable.length} crashed files passed on rerun)`);
  return 0;
}

try {
  process.exitCode = await main();
  reportKilled();
} finally {
  const relative = path.relative(path.resolve(os.tmpdir()), temp);
  if (!relative.startsWith('promptcut-test-') || relative.includes(path.sep)) throw new Error(`Refusing to clean up a temp directory that does not belong to this test run: ${temp}`);
  fs.rmSync(temp, { recursive: true, force: true });
}
