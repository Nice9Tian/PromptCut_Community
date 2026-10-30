/**
 * scripts/test-suite.mjs 的纯判定逻辑：从最小报告事件识别文件级原生异常，
 * 并用 Node 根 test:summary 的总数确认没有其它失败被重跑掩盖。
 */
import path from 'node:path';

const NTSTATUS = new Map([
  [0xC0000005, 'STATUS_ACCESS_VIOLATION（访问违例）'],
  [0xC0000142, 'STATUS_DLL_INIT_FAILED（DLL 初始化失败）'],
  [0xC0000409, 'STATUS_STACK_BUFFER_OVERRUN（栈缓冲区越界）'],
  [0xC000001D, 'STATUS_ILLEGAL_INSTRUCTION（非法指令）'],
]);

const keyOf = (file, cwd) => path.normalize(path.resolve(cwd, file)).toLowerCase();
const lineCount = (message) => message ? (message.match(/\n/g)?.length ?? 0) + Number(!message.endsWith('\n')) : 0;

export function exitDescription(code) {
  if (typeof code !== 'number') return '退出码未知';
  const unsigned = code >>> 0;
  if (unsigned >= 0xC0000000) {
    return `0x${unsigned.toString(16).toUpperCase().padStart(8, '0')} ${NTSTATUS.get(unsigned) ?? 'Windows 原生异常'}`;
  }
  return String(code);
}

export function summarizeTestEvents(events, cwd = process.cwd()) {
  const files = new Map();
  const get = (file) => {
    const key = keyOf(file, cwd);
    if (!files.has(key)) files.set(key, { file: path.relative(cwd, path.resolve(cwd, file)), testCases: 0, assertionFailures: 0, stderrLines: 0, stderr: '', processFailure: null });
    return files.get(key);
  };

  for (const { type, data } of events) {
    if (!data?.file) continue;
    const state = get(data.file);
    if (type === 'test:stderr') {
      const message = String(data.message ?? '');
      state.stderrLines += lineCount(message);
      state.stderr += message;
    } else if (type === 'test:pass') {
      state.testCases++;
    } else if (type === 'test:fail') {
      const error = data.details?.error;
      const namedFile = keyOf(data.name ?? '', cwd) === keyOf(data.file, cwd);
      if (namedFile && error?.code === 'ERR_TEST_FAILURE' && error.cause === 'test failed' && ('exitCode' in error || 'signal' in error)) {
        state.processFailure = { exitCode: error.exitCode ?? null, signal: error.signal ?? null };
      } else {
        state.testCases++;
        state.assertionFailures++;
      }
    }
  }
  return [...files.values()];
}

export function retryReason(file) {
  const failure = file.processFailure;
  if (!failure || file.assertionFailures > 0) return null;
  const { exitCode, signal } = failure;
  // 启动阶段已经打印明确的 JS/模块错误时，不把它当作进程异常掩盖。
  if (file.testCases === 0 && /(?:^|\n)(?:Error(?: \[[A-Z_]+\])?|SyntaxError|TypeError|ReferenceError|RangeError):|ERR_UNKNOWN_FILE_EXTENSION|Cannot find module/.test(file.stderr)) return null;
  if (signal) return 'signal';
  if (typeof exitCode === 'number' && (exitCode >>> 0) >= 0xC0000000) return 'ntstatus';
  if (typeof exitCode === 'number' && exitCode !== 0 && file.testCases === 0 && file.stderrLines === 0) return 'silent-exit';
  return null;
}

export function rootSummaryCounts(events) {
  const summaries = events.filter(({ type, data }) => type === 'test:summary' && data?.file == null);
  if (summaries.length !== 1) return null;
  const counts = summaries[0].data?.counts;
  if (!Number.isInteger(counts?.failed) || counts.failed < 0 || !Number.isInteger(counts?.cancelled) || counts.cancelled < 0) return null;
  return counts;
}

export function canRecoverInitialRun(events, files) {
  const counts = rootSummaryCounts(events);
  if (!counts || counts.cancelled !== 0) return false;
  const failedFiles = files.filter((file) => file.assertionFailures > 0 || file.processFailure);
  const retryable = failedFiles.filter((file) => retryReason(file));
  return retryable.length > 0 && failedFiles.length === retryable.length && counts.failed === retryable.length;
}
