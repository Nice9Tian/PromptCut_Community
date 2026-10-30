// 安装进度解析。喂的是真实形状的 pip 输出,重点是别把「有进度」和「不知道进度」
// 搞混 —— 编出来的百分比比没有百分比更糟。
// 跑法:node --test server/test/stt-install.test.mjs
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

// 转译产物落在临时目录,解析不到 node_modules,所以把 react 换成绝对 URL
const reactUrl = pathToFileURL(require_.resolve('react')).href;
let src = fs.readFileSync(path.join(ROOT, 'src/ai/sttInstallStore.ts'), 'utf8')
  .replace('from "react"', `from '${reactUrl}'`);
const js = ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;
const file = path.join(OUT, 'store.mjs');
fs.writeFileSync(file, js);
const store = await import(pathToFileURL(file).href);

/** 真实 pip 装 faster-whisper 时的输出形状 */
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

test('刚启动是 starting,且没有假的百分比', () => {
  const id = fresh('t-start');
  const job = store.getJob(id);
  assert.equal(job.phase, 'starting');
  assert.equal(store.fractionOf(job), null);
});

test('Collecting 进入解析依赖阶段并记下包名', () => {
  const id = fresh('t-collect');
  store.feedLine(id, 'Collecting faster-whisper>=1.0.3');
  const job = store.getJob(id);
  assert.equal(job.phase, 'resolving');
  assert.equal(job.currentPackage, 'faster-whisper');
  assert.equal(store.fractionOf(job), null, '解析阶段不该有百分比');
});

test('.whl.metadata 不算下载了一个包', () => {
  const id = fresh('t-meta');
  store.feedLine(id, '  Downloading faster_whisper-1.0.3-py3-none-any.whl.metadata (14 kB)');
  assert.equal(store.getJob(id).downloaded, 0, 'metadata 是解依赖时顺手拉的,不是包体');
});

test('真正的 whl 下载才计数,并读出包名', () => {
  const id = fresh('t-dl');
  store.feedLine(id, '  Downloading ctranslate2-4.4.0-cp311-cp311-win_amd64.whl (43.2 MB)');
  const job = store.getJob(id);
  assert.equal(job.phase, 'downloading');
  assert.equal(job.downloaded, 1);
  assert.equal(job.currentPackage, 'ctranslate2');
});

test('进度行给出当前文件的真实比例', () => {
  const id = fresh('t-frac');
  store.feedLine(id, '  Downloading ctranslate2-4.4.0-cp311-cp311-win_amd64.whl (43.2 MB)');
  store.feedLine(id, '     ------------------                       20.1/43.2 MB 8.1 MB/s eta 0:00:03');
  const job = store.getJob(id);
  assert.ok(Math.abs(store.fractionOf(job) - 20.1 / 43.2) < 1e-6);
  assert.match(store.describe(job), /正在下载 ctranslate2/);
});

test('kB 单位换算成 MB', () => {
  const id = fresh('t-kb');
  store.feedLine(id, '  Downloading tiny-0.1.whl (900 kB)');
  store.feedLine(id, '     ------ 450/900 kB 1.0 MB/s');
  const job = store.getJob(id);
  assert.ok(Math.abs(job.totalMB - 900 / 1024) < 1e-6);
  assert.ok(Math.abs(store.fractionOf(job) - 0.5) < 1e-6);
});

test('进入安装阶段:知道包数,但**不给**百分比', () => {
  const id = fresh('t-install');
  store.feedLine(id, 'Installing collected packages: tokenizers, onnxruntime, ctranslate2, av, faster-whisper');
  const job = store.getJob(id);
  assert.equal(job.phase, 'installing');
  assert.equal(job.packageCount, 5);
  assert.equal(store.fractionOf(job), null, 'pip 在这一段一行不打,给百分比就是假的');
  assert.match(store.describe(job), /正在安装 5 个包/);
});

test('走完整条真实输出不会崩,阶段推进正确', () => {
  const id = fresh('t-all');
  for (const l of PIP_LINES) store.feedLine(id, l);
  const job = store.getJob(id);
  assert.equal(job.phase, 'downloading');
  assert.equal(job.downloaded, 2, 'metadata 那两行不算');
  assert.ok(store.fractionOf(job) > 0 && store.fractionOf(job) < 1);
});

test('成功收尾:进度满、有耗时、无错误', () => {
  const id = fresh('t-done');
  store.feedLine(id, 'Successfully installed av-12.0.0 ctranslate2-4.4.0 faster-whisper-1.0.3');
  store.finishJob(id, true);
  const job = store.getJob(id);
  assert.equal(job.phase, 'done');
  assert.equal(store.fractionOf(job), 1);
  assert.ok(job.finishedAt >= job.startedAt);
  assert.equal(job.error, undefined);
});

test('失败收尾:保留原因和日志尾巴', () => {
  const id = fresh('t-fail');
  store.feedLine(id, 'ERROR: Could not find a version that satisfies the requirement');
  store.finishJob(id, false, '网络不可达');
  const job = store.getJob(id);
  assert.equal(job.phase, 'failed');
  assert.equal(store.describe(job), '网络不可达');
  assert.ok(job.logTail.some((l) => l.includes('Could not find')));
});

test('runningJob 只认没收尾的那个', () => {
  for (const id of ['r1', 'r2']) store.startJob(id, 'faster-whisper');
  store.finishJob('r1', true);
  const running = store.getJobs().filter((j) => j.phase !== 'done' && j.phase !== 'failed');
  assert.ok(running.every((j) => j.jobId !== 'r1'));
});

test('日志尾巴有上限,长安装不会把内存吃光', () => {
  const id = fresh('t-cap');
  for (let i = 0; i < 500; i++) store.feedLine(id, `line ${i}`);
  assert.ok(store.getJob(id).logTail.length <= 60);
});

// ── 工具调用 ↔ 安装任务的匹配 ────────────────────────────────
const A = { jobId: 'install-faster-whisper-abc123', engine: 'faster-whisper', phase: 'done', downloaded: 3, startedAt: 1, logTail: [] };
const B = { jobId: 'install-faster-whisper-xyz789', engine: 'faster-whisper', phase: 'downloading', downloaded: 1, startedAt: 2, logTail: [] };

test('summary 里有 jobId 时精确匹配,不会串到新任务上', () => {
  const tool = { name: 'stt_install', ok: true, summary: '{"jobId":"install-faster-whisper-abc123","started":true}' };
  assert.equal(store.matchInstallJob(tool, [A, B]), A, '旧消息该显示它当时那次的结果');
});

test('结果还没回来时退回当前正在跑的那个', () => {
  const tool = { name: 'stt_install', ok: undefined };
  assert.equal(store.matchInstallJob(tool, [A, B]), B);
});

test('已完成但没有 jobId 的调用不乱认任务', () => {
  const tool = { name: 'stt_install', ok: true };
  assert.equal(store.matchInstallJob(tool, [A, B]), undefined);
});

test('别的工具一律不认', () => {
  assert.equal(store.matchInstallJob({ name: 'add_clip', ok: undefined }, [B]), undefined);
});

test('jobId 指向一个已经不存在的任务时返回 undefined,而不是抓错一个', () => {
  const tool = { name: 'stt_install', ok: true, summary: '{"jobId":"install-whisper-gone999"}' };
  assert.equal(store.matchInstallJob(tool, [A, B]), undefined);
});
