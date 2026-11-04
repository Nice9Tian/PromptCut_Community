/**
 * How to wrap up this round after an agy built-in tool is denied.
 *
 * How to run: **must include this flag**:
 *   node --experimental-test-module-mocks --test server/test/agy-denied.test.mjs
 *
 * Pins the symptom reported by users: ending without warning after a series of tool calls, with
 * neither reply nor error.
 * The cause is that agy automatically denies its own run_command in unattended mode (it cannot pop
 * up a dialog to ask for consent), and then abandons the entire round: denied_actions in result has
 * values, response is empty, but status is not ERROR.
 * Originally it only sent one status and called finish('done') as usual, so in the UI it appeared
 * to end normally.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import * as realChildProcess from 'node:child_process';

/** What result to have the fake agy return for this round */
let nextResult = null;
/** Which event lines to feed on stdout first (simulating tool calls, etc.) */
let preEvents = [];

mock.module('node:child_process', { exports: { ...realChildProcess, spawn: () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  child.stdin = new Writable({ write(_c, _e, done) { done(); } });
  child.stdin.on('finish', () => {
    for (const ev of preEvents) child.stdout.write(JSON.stringify(ev) + '\n');
    child.stdout.write(JSON.stringify({ event: 'result', result: nextResult }) + '\n');
    queueMicrotask(() => child.emit('close', 0));
  });
  return child;
} } });

const { startRun } = await import('../runners/agy.mjs');

async function run(result, pre = []) {
  nextResult = result;
  preEvents = pre;
  const events = [];
  const r = startRun({
    provider: 'agy', cwd: 'C:\\tmp', onEvent: (e) => events.push(e),
    systemPrompt: 's', prompt: 'p',
  });
  await r.done;
  return events;
}

test('Denied + nothing produced: report an error, never success', async () => {
  const events = await run({
    conversation_id: 'c1',
    status: 'SUCCESS',
    response: '',
    denied_actions: [{ display_name: 'RunCommand', action: 'run_command' }],
  });
  const err = events.find((e) => e.type === 'error');
  assert.ok(err, 'There should be an error event: this round actually accomplished nothing');
  assert.equal(events.find((e) => e.type === 'done'), undefined, 'Should not also report done');
  assert.match(err.message, /RunCommand/, 'Must say clearly which action was denied');
  assert.match(err.message, /wait/, 'Must tell the user that the wait tool is available now, otherwise they do not know what to do next');
});

test('Denied but **with** output: wrap up as usual and mention it in just one line, since a round\'s results must not be voided by a single denial', async () => {
  const events = await run({
    conversation_id: 'c1',
    status: 'SUCCESS',
    response: 'I\'ve already put the media on the timeline.',
    denied_actions: [{ display_name: 'RunCommand', action: 'run_command' }],
  });
  assert.ok(events.some((e) => e.type === 'done'), 'With output it should end normally');
  assert.equal(events.find((e) => e.type === 'error'), undefined);
  assert.ok(
    events.some((e) => e.type === 'status' && /Some actions were rejected/.test(e.text)),
    'Should still warn that an action was denied',
  );
});

test('When no action is denied, everything stays as before', async () => {
  const events = await run({ conversation_id: 'c1', status: 'SUCCESS', response: 'OK' });
  assert.ok(events.some((e) => e.type === 'done'));
  assert.equal(events.find((e) => e.type === 'error'), undefined);
});

test('response is empty but the stream has already produced text: counts as output, no error', async () => {
  const events = await run(
    {
      conversation_id: 'c1',
      status: 'SUCCESS',
      response: '',
      denied_actions: [{ display_name: 'RunCommand' }],
    },
    [{ event: 'step_update', step_update: { step_type: 'text', text_delta: 'Let me look at the media first.' } }],
  );
  assert.ok(events.some((e) => e.type === 'done'), 'The stream already has body text, so it must not be judged an empty round');
  assert.equal(events.find((e) => e.type === 'error'), undefined);
});

/*
 * Two fields used by auto-continuation. The front end uses them to decide "whether to automatically
 * append a message and what to append", so the shape must be pinned down: missing one,
 * auto-continuation silently fails, and the failure behaves exactly as before (an error just sitting
 * there in the UI), and no one will notice.
 */
test('A resumable interruption must carry retryable and an assembled retryPrompt', async () => {
  const events = await run({
    conversation_id: 'c1',
    status: 'SUCCESS',
    response: '',
    denied_actions: [{
      display_name: 'RunCommand',
      reason: 'user denied permission to run command:\npowershell -Command "Start-Sleep -Seconds 3"',
    }],
  });
  const err = events.find((e) => e.type === 'error');
  assert.equal(err.retryable, true);
  assert.ok(err.retryPrompt, 'There must be an assembled resume prompt');
  assert.match(err.retryPrompt, /Start-Sleep/, 'Include the original denial message: the model sees it directly and does not have to ask');
  assert.match(err.retryPrompt, /wait/, 'Must point out the alternative, otherwise it will only rephrase and run into it again');
  assert.match(err.retryPrompt, /continue|carry on/, 'Must make clear it is continuing the work, not starting over');
});

test('The resume prompt gives directions by the type of the denied permission: a denied file read must not be described as command and must not be given only wait', async () => {
  const events = await run({
    conversation_id: 'c1', status: 'SUCCESS', response: '',
    denied_actions: [{
      display_name: 'GrepSearch',
      reason: 'permission check failed for read_file "C:\\app": user denied permission for read_file(C:\\app)',
    }],
  });
  const err = events.find((e) => e.type === 'error');
  assert.match(err.retryPrompt, /get_project/, 'A denied file read must point to the tool for viewing the project');
  assert.doesNotMatch(err.retryPrompt, /wait\(/, 'Unrelated to waiting, don\'t steer it toward wait');
  assert.match(err.retryPrompt, /Switching to another built-in tool makes no difference/, 'In real runs, once it is denied it switches to another built-in tool and runs into the same wall again');
  assert.doesNotMatch(err.message, /command permission/);
});

test('Denied reading a web page: point to web_open / web_read', async () => {
  const events = await run({
    conversation_id: 'c1', status: 'SUCCESS', response: '',
    denied_actions: [{ display_name: 'ReadUrlContent', action: 'read_url_content' }],
  });
  assert.match(events.find((e) => e.type === 'error').retryPrompt, /web_open/);
});

test('A non-resumable error (agy itself reports ERROR) carries no retryable: resuming it a hundred times gives the same result', async () => {
  const events = await run({ conversation_id: 'c1', status: 'ERROR', error: 'invalid model selection' });
  const err = events.find((e) => e.type === 'error');
  assert.ok(err);
  assert.notEqual(err.retryable, true, 'The model name is wrong, so automatic resuming only burns quota for nothing');
});

test('With output, even when denied, no retryable is carried: there is nothing to resume', async () => {
  const events = await run({
    conversation_id: 'c1', status: 'SUCCESS', response: 'Done.',
    denied_actions: [{ display_name: 'RunCommand' }],
  });
  assert.equal(events.find((e) => e.type === 'error'), undefined);
});

/*
 * Categorization of tool errors: "file not found" and "denied" are two different things.
 *
 * agy's permission check first parses the tool arguments, reading files along the way; if unreadable,
 * it throws ENOENT upward as-is, so the error text contains both `declaring permissions` and
 * `cannot find the file`.
 * Originally it checked only by includes('permission'), so a "mistyped path" was reported as
 * "unattended mode cannot request consent": the model tried guessing permissions based on this
 * sentence and nothing worked; what the user saw was also a nonexistent permission failure.
 */
function toolError(message) {
  return [{
    event: 'step_update',
    step_update: {
      step_type: 'tool', state: 'ERROR', tool_name: 'view_file',
      tool_info: { error: { message } },
    },
  }];
}

test('When the error contains both permission and "cannot find the file", treat it as a missing file', async () => {
  const events = await run(
    { conversation_id: 'c1', status: 'SUCCESS', response: 'Try a different path.' },
    toolError('declaring permissions: cortex tool view_file: convert tool call for permissions: '
      + 'model output error: invalid tool call error (invalid_args) failed to read file: '
      + 'open C:/x/instructions.md: The system cannot find the file specified.'),
  );
  const tr = events.find((e) => e.type === 'tool_result');
  assert.ok(tr && tr.ok === false, 'Must be handed back as a failed tool call');
  assert.match(tr.summary, /cannot find the file/, 'Give the original text to the model so it can see for itself that the path was wrong');
  assert.doesNotMatch(tr.summary, /Antigravity itself rejected/, 'This is not a denial, don\'t say it that way');
  assert.equal(
    events.find((e) => e.type === 'status' && /no popup can ask for consent/.test(e.text)), undefined,
    'No permission-related hint should appear: it would mislead the model and the user alike',
  );
});

test('A real permission denial still counts as a denial', async () => {
  const events = await run(
    { conversation_id: 'c1', status: 'SUCCESS', response: 'OK' },
    toolError('permission check failed for read_file "C:\\x": user denied permission for read_file(C:\\x)'),
  );
  const tr = events.find((e) => e.type === 'tool_result');
  assert.ok(tr && tr.ok === false);
  assert.match(tr.summary, /Antigravity itself rejected/, 'This one really was denied, and it must say that it was its own tool that was denied');
});
