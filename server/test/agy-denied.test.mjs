/**
 * agy 的内建工具被拒之后,这一轮该怎么收。
 *
 * 跑法 —— **必须带这个 flag**:
 *   node --experimental-test-module-mocks --test server/test/agy-denied.test.mjs
 *
 * 钉的是用户报的那个现象:一串工具调用之后毫无征兆地结束,没有回复也没有报错。
 * 起因是 agy 在无人值守模式下把自己的 run_command 自动拒掉(它没法弹窗征求同意),
 * 然后放弃整轮 —— result 里 denied_actions 有值、response 是空的,但 status 不是 ERROR。
 * 原来这里只发一条 status 就照常 finish('done'),于是界面上看起来像正常结束了。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import * as realChildProcess from 'node:child_process';

/** 这一轮要让假的 agy 回什么 result */
let nextResult = null;
/** stdout 上先喂哪些事件行(模拟工具调用等) */
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
    events.some((e) => e.type === 'status' && /Some actions were denied/.test(e.text)),
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
 * 自动续跑要用到的两个字段。前端拿它们决定「要不要自动接一句、接什么」,
 * 所以形状必须钉住:少一个,自动续跑就静默失效,而失效的表现和以前一模一样
 * (界面上一个错误躺在那儿),不会有人发现。
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
  assert.match(err.retryPrompt, /switching to another built-in tool makes no difference/, 'In real runs, once it is denied it switches to another built-in tool and runs into the same wall again');
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
 * 工具报错的分类:「找不到文件」和「被拒绝」是两回事。
 *
 * agy 的权限判定会先把工具参数转一遍,这一步顺手读文件;读不到就把 ENOENT 原样往上抛,
 * 报错文本里因此同时出现 `declaring permissions` 和 `cannot find the file`。
 * 原来只按 includes('permission') 判,于是一个「路径写错了」被报成「无人值守没法征求同意」——
 * 模型照着这句去猜权限,怎么改都不对;用户看到的也是一个根本不存在的权限故障。
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
  assert.doesNotMatch(tr.summary, /Antigravity itself denied/, 'This is not a denial, don\'t say it that way');
  assert.equal(
    events.find((e) => e.type === 'status' && /pop-up asking for consent/.test(e.text)), undefined,
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
  assert.match(tr.summary, /Antigravity itself denied/, 'This one really was denied, and it must say that it was its own tool that was denied');
});
