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

test('被拒 + 什么都没产出:报错误,不许报成功', async () => {
  const events = await run({
    conversation_id: 'c1',
    status: 'SUCCESS',
    response: '',
    denied_actions: [{ display_name: 'RunCommand', action: 'run_command' }],
  });
  const err = events.find((e) => e.type === 'error');
  assert.ok(err, '该有 error 事件 —— 这一轮实际上什么都没做成');
  assert.equal(events.find((e) => e.type === 'done'), undefined, '不该同时报 done');
  assert.match(err.message, /RunCommand/, '要说清是哪个动作被拒的');
  assert.match(err.message, /wait/, '要告诉用户现在有 wait 工具可用,不然他不知道下一步做什么');
});

test('被拒但**有**产出:照常收尾,只提一句 —— 那一轮的成果不能因为一次被拒就作废', async () => {
  const events = await run({
    conversation_id: 'c1',
    status: 'SUCCESS',
    response: '我已经把素材放进时间轴了。',
    denied_actions: [{ display_name: 'RunCommand', action: 'run_command' }],
  });
  assert.ok(events.some((e) => e.type === 'done'), '有产出就该正常结束');
  assert.equal(events.find((e) => e.type === 'error'), undefined);
  assert.ok(
    events.some((e) => e.type === 'status' && /部分动作被拒绝/.test(e.text)),
    '仍然要提醒有动作被拒',
  );
});

test('没有被拒的动作时,一切照旧', async () => {
  const events = await run({ conversation_id: 'c1', status: 'SUCCESS', response: '好的' });
  assert.ok(events.some((e) => e.type === 'done'));
  assert.equal(events.find((e) => e.type === 'error'), undefined);
});

test('response 空但流里已经说过话:算有产出,不报错', async () => {
  const events = await run(
    {
      conversation_id: 'c1',
      status: 'SUCCESS',
      response: '',
      denied_actions: [{ display_name: 'RunCommand' }],
    },
    [{ event: 'step_update', step_update: { step_type: 'text', text_delta: '我先看看素材。' } }],
  );
  assert.ok(events.some((e) => e.type === 'done'), '流里已经有正文了,不该判成空轮');
  assert.equal(events.find((e) => e.type === 'error'), undefined);
});

/*
 * 自动续跑要用到的两个字段。前端拿它们决定「要不要自动接一句、接什么」,
 * 所以形状必须钉住:少一个,自动续跑就静默失效,而失效的表现和以前一模一样
 * (界面上一个错误躺在那儿),不会有人发现。
 */
test('可续跑的中断要带 retryable 和拼好的 retryPrompt', async () => {
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
  assert.ok(err.retryPrompt, '要有拼好的续跑话术');
  assert.match(err.retryPrompt, /Start-Sleep/, '把被拒的原始说明拼进去 —— 让模型直接看见,不用自己开口问');
  assert.match(err.retryPrompt, /wait/, '要指出替代方案,不然它只会换个说法再撞一次');
  assert.match(err.retryPrompt, /接着|继续/, '要说清是接着做,不是重头再来');
});

test('续跑话术按被拒的权限类型指路:读文件被拒不能说成 command、不能只给 wait', async () => {
  const events = await run({
    conversation_id: 'c1', status: 'SUCCESS', response: '',
    denied_actions: [{
      display_name: 'GrepSearch',
      reason: 'permission check failed for read_file "C:\\app": user denied permission for read_file(C:\\app)',
    }],
  });
  const err = events.find((e) => e.type === 'error');
  assert.match(err.retryPrompt, /get_project/, '读文件被拒要指到看工程的工具');
  assert.doesNotMatch(err.retryPrompt, /wait\(/, '跟等待无关,别把它往 wait 上带');
  assert.match(err.retryPrompt, /换一个内建工具也一样/, '实跑里它被拒一次就换另一个内建工具再撞');
  assert.doesNotMatch(err.message, /command 权限/);
});

test('读网页被拒:指到 web_open / web_read', async () => {
  const events = await run({
    conversation_id: 'c1', status: 'SUCCESS', response: '',
    denied_actions: [{ display_name: 'ReadUrlContent', action: 'read_url_content' }],
  });
  assert.match(events.find((e) => e.type === 'error').retryPrompt, /web_open/);
});

test('不可续跑的错(agy 自己报 ERROR)不带 retryable —— 那种续跑一百次也一样', async () => {
  const events = await run({ conversation_id: 'c1', status: 'ERROR', error: 'invalid model selection' });
  const err = events.find((e) => e.type === 'error');
  assert.ok(err);
  assert.notEqual(err.retryable, true, '模型名错了,自动续跑只会空烧额度');
});

test('有产出时即使被拒也不带 retryable:没什么可续的', async () => {
  const events = await run({
    conversation_id: 'c1', status: 'SUCCESS', response: '做完了。',
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

test('报错里同时有 permission 和「找不到文件」时,按找不到文件算', async () => {
  const events = await run(
    { conversation_id: 'c1', status: 'SUCCESS', response: '换个路径再试。' },
    toolError('declaring permissions: cortex tool view_file: convert tool call for permissions: '
      + 'model output error: invalid tool call error (invalid_args) failed to read file: '
      + 'open C:/x/instructions.md: The system cannot find the file specified.'),
  );
  const tr = events.find((e) => e.type === 'tool_result');
  assert.ok(tr && tr.ok === false, '要当成一次失败的工具调用交回去');
  assert.match(tr.summary, /cannot find the file/, '把原文给模型,让它自己看出是路径写错了');
  assert.doesNotMatch(tr.summary, /Antigravity 自己拒绝/, '这不是拒绝,别这么说');
  assert.equal(
    events.find((e) => e.type === 'status' && /弹窗征求同意/.test(e.text)), undefined,
    '不该冒出权限相关的提示 —— 那会把模型和用户一起带偏',
  );
});

test('真正的权限拒绝仍然按拒绝算', async () => {
  const events = await run(
    { conversation_id: 'c1', status: 'SUCCESS', response: '好' },
    toolError('permission check failed for read_file "C:\\x": user denied permission for read_file(C:\\x)'),
  );
  const tr = events.find((e) => e.type === 'tool_result');
  assert.ok(tr && tr.ok === false);
  assert.match(tr.summary, /Antigravity 自己拒绝/, '这条确实是被拒,要说明是它自家的工具被拒');
});
