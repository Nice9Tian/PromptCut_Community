/**
 * Test subprocesses of Node 24.19 occasionally crash natively with 0xC0000005 on Windows
 * (nodejs/node#65756), and the spec reporter does not print subprocess exit codes. This reporter
 * leaves minimal event records for scripts/test-suite.mjs: file test cases, stderr, exit
 * information for file-level failures, and total counts from root test:summary.
 *
 * Do not serialize assertion actual/cause objects: they may contain circular references. Do not
 * throw exceptions when recording fails; the wrapper script remains failed if root summary is
 * missing. See scripts/test-suite.mjs for first exception diagnosis and up to two reruns.
 * Can be removed after upgrading to Node versions containing nodejs/node#65778: v26.10.0 and above,
 * or a v24.x release incorporating backported nodejs/node#66168.
 */
const asString = (value) => typeof value === 'string' ? value : undefined;
const asNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function minimalEvent(event) {
  const { type, data } = event;
  if (type === 'test:summary') {
    if (data?.file != null) return null; // Sub-files also have summaries; only keep the root summary of the entire runner.
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
      // Even if a single event has a throwing getter or non-serializable value, it must not interrupt Node's test runner.
      yield '{"type":"reporter:error"}\n';
    }
  }
}
