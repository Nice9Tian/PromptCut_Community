import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import testEventReporter from '../../scripts/test-event-reporter.mjs';
import { canRecoverInitialRun, exitDescription, retryReason, rootSummaryCounts, summarizeTestEvents } from '../../scripts/test-suite-policy.mjs';

const cwd = path.resolve('fixture-root');
const file = 'server/test/example.test.mjs';
const event = (type, data) => ({ type, data: { file, ...data } });
const processFail = (exitCode, signal = null) => event('test:fail', {
  name: file,
  details: { error: { code: 'ERR_TEST_FAILURE', cause: 'test failed', exitCode, signal } },
});
const summary = (...events) => summarizeTestEvents(events, cwd)[0];
const root = (failed, cancelled = 0) => ({ type: 'test:summary', data: { counts: { failed, cancelled } } });

test('Windows 原生异常和信号只对文件级失败重跑', () => {
  for (const code of [0xC0000005, 0xC0000142, 0xC0000409, 0xC000001D]) {
    const state = summary(event('test:pass', { name: 'case A' }), processFail(code));
    assert.equal(state.testCases, 1);
    assert.equal(retryReason(state), 'ntstatus');
    assert.match(exitDescription(code), /^0xC000/);
  }
  assert.equal(retryReason(summary(processFail(-1073741819))), 'ntstatus');
  assert.equal(retryReason(summary(processFail(null, 'SIGTERM'))), 'signal');
});

test('零用例、零 stderr 的非零退出最多可作为静默退出候选', () => {
  assert.equal(retryReason(summary(processFail(7))), 'silent-exit');
  assert.equal(retryReason(summary(event('test:pass', { name: 'case A' }), processFail(7))), null);
  assert.equal(retryReason(summary(event('test:stderr', { message: 'warn\n' }), processFail(7))), null);
});

test('真实断言失败和加载错误保留失败', () => {
  const assertion = event('test:fail', { name: 'bad assertion', details: { error: { code: 'ERR_TEST_FAILURE', cause: {} } } });
  const state = summary(assertion, processFail(0xC0000005));
  assert.equal(state.assertionFailures, 1);
  assert.equal(retryReason(state), null);
  const loading = summary(event('test:stderr', { message: 'Error [ERR_MODULE_NOT_FOUND]: bad import\n' }), processFail(1));
  assert.equal(loading.stderrLines, 1);
  assert.equal(retryReason(loading), null);
  assert.equal(retryReason(summary(event('test:stderr', { message: 'SyntaxError: bad syntax\n' }), processFail(0xC0000005))), null);
});

test('不同文件的用例和 stderr 分别计数', () => {
  const other = 'server/test/other.test.mjs';
  const states = summarizeTestEvents([
    event('test:pass', { name: 'one' }),
    event('test:stderr', { message: 'line one\nline two\n' }),
    { type: 'test:pass', data: { file: other, name: 'another' } },
    processFail(0xC0000005),
  ], cwd);
  assert.equal(states.length, 2);
  assert.equal(states[0].testCases, 1);
  assert.equal(states[0].stderrLines, 2);
  assert.equal(states[1].testCases, 1);
  assert.equal(states[1].processFailure, null);
  assert.equal(summary(event('test:stderr', { message: 'partial\nlast line' })).stderrLines, 2);
});

test('根汇总必须恰好覆盖可重跑文件，不能有额外失败或取消', () => {
  const files = [summary(processFail(0xC0000005))];
  assert.equal(canRecoverInitialRun([root(1)], files), true);
  assert.equal(canRecoverInitialRun([root(2)], files), false);
  assert.equal(canRecoverInitialRun([root(1, 1)], files), false);
  assert.equal(canRecoverInitialRun([], files), false);
  assert.equal(rootSummaryCounts([{ type: 'test:summary', data: { file, counts: { failed: 0, cancelled: 0 } } }]), null);
  const assertion = summary(event('test:fail', { name: 'bad assertion', details: { error: { code: 'ERR_TEST_FAILURE' } } }));
  assert.equal(canRecoverInitialRun([root(1)], [...files, assertion]), false);
});

test('报告器只序列化原始类型字段，循环引用和异常 getter 不打断后续事件', async () => {
  const cyclic = { value: 1 };
  cyclic.self = cyclic;
  async function* source() {
    yield event('test:fail', { name: 'cyclic assertion', nesting: 0, details: { error: { code: 'ERR_TEST_FAILURE', cause: cyclic, actual: cyclic } } });
    yield event('test:fail', { name: file, nesting: 0, details: { error: { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', cause: 'test failed', exitCode: 0xC0000005, signal: null, actual: cyclic } } });
    yield { type: 'test:stderr', data: { get file() { throw new Error('bad getter'); } } };
    yield event('test:pass', { name: 'later case', nesting: 0 });
    yield { type: 'test:summary', data: { file, counts: { failed: 1, cancelled: 0 } } };
    yield root(1);
  }
  const rows = [];
  for await (const line of testEventReporter(source())) rows.push(JSON.parse(line));
  assert.equal(rows.length, 5);
  assert.equal(rows[0].data.details.error.code, 'ERR_TEST_FAILURE');
  assert.equal('cause' in rows[0].data.details.error, false);
  assert.deepEqual(rows[1].data.details.error, { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', cause: 'test failed', signal: null, exitCode: 0xC0000005 });
  assert.deepEqual(rows[2], { type: 'reporter:error' });
  assert.equal(rows[3].data.name, 'later case');
  assert.deepEqual(rows[4], root(1));
});
