// Installation progress parsing. Fed with realistic pip output shape; key point is not confusing
// "has progress" with "unknown progress": fabricated percentages are worse than no percentages.
// Run: node --test server/test/stt-install.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-stt-test-'));

// Transpiled artifacts land in temp directory and cannot resolve node_modules,
// so replace react with absolute URL
const reactUrl = pathToFileURL(require_.resolve('react')).href;
const i18nUrl = pathToFileURL(path.join(ROOT, 'src/i18n/index.ts')).href;
let src = fs.readFileSync(path.join(ROOT, 'src/ai/sttInstallStore.ts'), 'utf8')
  .replace('from "react"', `from '${reactUrl}'`)
  // tr() comes from src/i18n: likewise replace with an absolute URL
  .replace('from "../i18n/index.ts"', `from '${i18nUrl}'`);
const js = ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;
const file = path.join(OUT, 'store.mjs');
fs.writeFileSync(file, js);
const store = await import(pathToFileURL(file).href);

/** Realistic output shape of pip installing faster-whisper */
const PIP_LINES = [
  'Collecting faster-whisper>=1.0.3',
  '  Downloading faster_whisper-1.0.3-py3-none-any.whl.metadata (14 kB)',
  'Collecting ctranslate2>=4.4.0',
  '  Downloading ctranslate2-4.4.0-cp311-cp311-win_amd64.whl.metadata (10 kB)',
  '  Downloading faster_whisper-1.0.3-py3-none-any.whl (1.9 MB)',
  '     ---------------------------------------- 1.9/1.9 MB 5.2 MB/s eta 0:00:00',
  '  Downloading ctranslate2-4.4.0-cp311-cp311-win_amd64.whl (43.2 MB)',
  '     ------------------                       20.1/43.2 MB 8.1 MB/s eta 0:00:03',
];

function fresh(id = 'job1') {
  store.startJob(id, 'faster-whisper');
  return id;
}

test('Just started: the state is starting, with no fake percentage', () => {
  const id = fresh('t-start');
  const job = store.getJob(id);
  assert.equal(job.phase, 'starting');
  assert.equal(store.fractionOf(job), null);
});

test('Collecting enters the dependency-resolving stage and records the package name', () => {
  const id = fresh('t-collect');
  store.feedLine(id, 'Collecting faster-whisper>=1.0.3');
  const job = store.getJob(id);
  assert.equal(job.phase, 'resolving');
  assert.equal(job.currentPackage, 'faster-whisper');
  assert.equal(store.fractionOf(job), null, 'The resolving stage should have no percentage');
});

test('.whl.metadata does not count as a downloaded package', () => {
  const id = fresh('t-meta');
  store.feedLine(id, '  Downloading faster_whisper-1.0.3-py3-none-any.whl.metadata (14 kB)');
  assert.equal(store.getJob(id).downloaded, 0, 'metadata is fetched on the side while resolving dependencies, it is not the package body');
});

test('Only a real whl download is counted, and the package name is read from it', () => {
  const id = fresh('t-dl');
  store.feedLine(id, '  Downloading ctranslate2-4.4.0-cp311-cp311-win_amd64.whl (43.2 MB)');
  const job = store.getJob(id);
  assert.equal(job.phase, 'downloading');
  assert.equal(job.downloaded, 1);
  assert.equal(job.currentPackage, 'ctranslate2');
});

test('The progress line gives the real ratio of the current file', () => {
  const id = fresh('t-frac');
  store.feedLine(id, '  Downloading ctranslate2-4.4.0-cp311-cp311-win_amd64.whl (43.2 MB)');
  store.feedLine(id, '     ------------------                       20.1/43.2 MB 8.1 MB/s eta 0:00:03');
  const job = store.getJob(id);
  assert.ok(Math.abs(store.fractionOf(job) - 20.1 / 43.2) < 1e-6);
  assert.match(store.describe(job), /Downloading ctranslate2/);
});

test('kB units convert to MB', () => {
  const id = fresh('t-kb');
  store.feedLine(id, '  Downloading tiny-0.1.whl (900 kB)');
  store.feedLine(id, '     ------ 450/900 kB 1.0 MB/s');
  const job = store.getJob(id);
  assert.ok(Math.abs(job.totalMB - 900 / 1024) < 1e-6);
  assert.ok(Math.abs(store.fractionOf(job) - 0.5) < 1e-6);
});

test('Entering the install stage: the package count is known, but a percentage is **not given**', () => {
  const id = fresh('t-install');
  store.feedLine(id, 'Installing collected packages: tokenizers, onnxruntime, ctranslate2, av, faster-whisper');
  const job = store.getJob(id);
  assert.equal(job.phase, 'installing');
  assert.equal(job.packageCount, 5);
  assert.equal(store.fractionOf(job), null, 'pip prints no line at all in this stage, so giving a percentage would be fake');
  assert.match(store.describe(job), /Installing 5 packages/);
});

test('Running through the whole real output does not crash, and the stages advance correctly', () => {
  const id = fresh('t-all');
  for (const l of PIP_LINES) store.feedLine(id, l);
  const job = store.getJob(id);
  assert.equal(job.phase, 'downloading');
  assert.equal(job.downloaded, 2, 'The two metadata lines do not count');
  assert.ok(store.fractionOf(job) > 0 && store.fractionOf(job) < 1);
});

test('Successful finish: progress full, elapsed time recorded, no error', () => {
  const id = fresh('t-done');
  store.feedLine(id, 'Successfully installed av-12.0.0 ctranslate2-4.4.0 faster-whisper-1.0.3');
  store.finishJob(id, true);
  const job = store.getJob(id);
  assert.equal(job.phase, 'done');
  assert.equal(store.fractionOf(job), 1);
  assert.ok(job.finishedAt >= job.startedAt);
  assert.equal(job.error, undefined);
});

test('Failed finish: the reason and the log tail are kept', () => {
  const id = fresh('t-fail');
  store.feedLine(id, 'ERROR: Could not find a version that satisfies the requirement');
  store.finishJob(id, false, 'Network unreachable');
  const job = store.getJob(id);
  assert.equal(job.phase, 'failed');
  assert.equal(store.describe(job), 'Network unreachable');
  assert.ok(job.logTail.some((l) => l.includes('Could not find')));
});

test('runningJob recognizes only the one that has not finished', () => {
  for (const id of ['r1', 'r2']) store.startJob(id, 'faster-whisper');
  store.finishJob('r1', true);
  const running = store.getJobs().filter((j) => j.phase !== 'done' && j.phase !== 'failed');
  assert.ok(running.every((j) => j.jobId !== 'r1'));
});

test('The log tail has a cap, so a long install does not exhaust memory', () => {
  const id = fresh('t-cap');
  for (let i = 0; i < 500; i++) store.feedLine(id, `line ${i}`);
  assert.ok(store.getJob(id).logTail.length <= 60);
});

// ── Matching tool calls ↔ installation tasks ────────────────────────────────
const A = { jobId: 'install-faster-whisper-abc123', engine: 'faster-whisper', phase: 'done', downloaded: 3, startedAt: 1, logTail: [] };
const B = { jobId: 'install-faster-whisper-xyz789', engine: 'faster-whisper', phase: 'downloading', downloaded: 1, startedAt: 2, logTail: [] };

test('When the summary has a jobId it matches exactly and does not get mixed up with a new job', () => {
  const tool = { name: 'stt_install', ok: true, summary: '{"jobId":"install-faster-whisper-abc123","started":true}' };
  assert.equal(store.matchInstallJob(tool, [A, B]), A, 'An old message should show the result of its own run at the time');
});

test('When the result has not come back yet, fall back to the one currently running', () => {
  const tool = { name: 'stt_install', ok: undefined };
  assert.equal(store.matchInstallJob(tool, [A, B]), B);
});

test('A finished call without a jobId is not matched to just any job', () => {
  const tool = { name: 'stt_install', ok: true };
  assert.equal(store.matchInstallJob(tool, [A, B]), undefined);
});

test('Other tools are never matched', () => {
  assert.equal(store.matchInstallJob({ name: 'add_clip', ok: undefined }, [B]), undefined);
});

test('When jobId points to a job that no longer exists, return undefined instead of grabbing the wrong one', () => {
  const tool = { name: 'stt_install', ok: true, summary: '{"jobId":"install-whisper-gone999"}' };
  assert.equal(store.matchInstallJob(tool, [A, B]), undefined);
});
