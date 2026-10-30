/**
 * Node 24.19 在 Windows 上的测试子进程偶发以 0xC0000005 原生崩溃（nodejs/node#65756），
 * spec 报告器不打印子进程退出码。本报告器给 scripts/test-suite.mjs 留下最小事件记录：
 * 文件用例、stderr、文件级失败的退出信息，以及根 test:summary 的总数。
 *
 * 不序列化断言的 actual/cause 对象：它们可能循环引用。记录失败时也不抛异常；
 * 包装脚本缺少根汇总就保持失败。首次异常的诊断和最多两次重跑见 scripts/test-suite.mjs。
 * 升级到包含 nodejs/node#65778 的 Node 后可移除：v26.10.0 起，或合入回移
 * nodejs/node#66168 的 v24.x 发布版。
 */
const asString = (value) => typeof value === 'string' ? value : undefined;
const asNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function minimalEvent(event) {
  const { type, data } = event;
  if (type === 'test:summary') {
    if (data?.file != null) return null; // 子文件也有 summary，只保留整个运行器的根汇总。
    const counts = {};
    for (const key of ['tests', 'failed', 'passed', 'cancelled', 'skipped', 'todo', 'topLevel', 'suites']) {
      const value = asNumber(data?.counts?.[key]);
      if (value !== undefined) counts[key] = value;
    }
    return { type, data: { counts } };
  }
  if (type !== 'test:pass' && type !== 'test:fail' && type !== 'test:stderr') return null;

  const record = { type, data: {} };
  const file = asString(data?.file);
  const name = asString(data?.name);
  const nesting = asNumber(data?.nesting);
  if (file !== undefined) record.data.file = file;
  if (name !== undefined) record.data.name = name;
  if (nesting !== undefined) record.data.nesting = nesting;
  if (type === 'test:stderr') {
    const message = asString(data?.message);
    if (message !== undefined) record.data.message = message;
  }
  if (type === 'test:fail') {
    const rawError = data?.details?.error;
    if (rawError != null) {
      const error = {};
      for (const key of ['code', 'failureType', 'cause', 'signal']) {
        const value = asString(rawError[key]);
        if (value !== undefined) error[key] = value;
      }
      const exitCode = asNumber(rawError.exitCode);
      if (exitCode !== undefined) error.exitCode = exitCode;
      if (rawError.signal === null) error.signal = null;
      if (rawError.exitCode === null) error.exitCode = null;
      record.data.details = { error };
    }
  }
  return record;
}

export default async function* testEventReporter(events) {
  for await (const event of events) {
    try {
      const record = minimalEvent(event);
      if (record) yield `${JSON.stringify(record)}\n`;
    } catch {
      // 单条事件即使带异常 getter/不可序列化值，也不能中断 Node 的测试运行器。
      yield '{"type":"reporter:error"}\n';
    }
  }
}
