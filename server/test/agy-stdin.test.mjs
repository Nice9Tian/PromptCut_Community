/**
 * agy 这条路的提示词必须走 stdin,不能塞进命令行。
 *
 * 跑法 —— **必须带这个 flag**:
 *   node --experimental-test-module-mocks --test server/test/agy-stdin.test.mjs
 *
 * 钉住的是一个真事故:原来是 `-p <整个提示词>`。Windows 单条命令行上限 32767 字符,
 * 系统提示词本身 15,000 出头还撑得住,一旦叠上文本协议那份工具清单(33,000)就是 49,000,
 * 直接 spawn ENAMETOOLONG —— 也就是「原生工具被拒 → 改用文本协议重试」这条兜底路
 * 从来没成功过,一进去就炸。claude.mjs / codex.mjs 早就走 stdin 了,agy 是唯一的例外。
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import * as realChildProcess from 'node:child_process';
import { useFakeCliHome } from './fake-cli-home.mjs';

// claude / agy 解析到临时目录里的假 .exe,断言 spawn 实参时不受本机装法(npm 垫片等)影响
const fakeCli = useFakeCliHome();
after(() => fakeCli.dispose());

/** Windows 一条命令行(含 exe 路径和所有参数)的硬上限 */
const WINDOWS_CMDLINE_LIMIT = 32767;

let spawned;
// 只换掉 spawn,其余原样透传 —— 整个模块换掉的话,同一张图里别的模块
// (runners/auth.mjs 要 execFile)会在 import 阶段就找不到导出而挂掉
mock.module('node:child_process', { exports: { ...realChildProcess, spawn: (exe, args) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  let stdin = '';
  child.stdin = new Writable({ write(chunk, _enc, done) { stdin += chunk.toString(); done(); } });
  child.stdin.on('finish', () => {
    spawned.stdin = stdin;
    // 回一条最小的 result,好让 runner 正常收尾
    child.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'Got it' } }) + '\n');
    queueMicrotask(() => child.emit('close', 0));
  });
  spawned = { exe, args, stdin: '' };
  return child;
} } });

const { startRun } = await import('../runners/agy.mjs');

/** 跑一轮,把这次 spawn 的实参和写进 stdin 的东西交回来 */
async function run(opts) {
  spawned = null;
  const events = [];
  const r = startRun({
    provider: 'agy', cwd: 'C:\\tmp', onEvent: (e) => events.push(e),
    systemPrompt: 's', prompt: 'p', ...opts,
  });
  await r.done;
  return { ...spawned, events };
}

test('The prompt goes into stdin, not the command line', async () => {
  const big = 'x'.repeat(49000);
  const { args, stdin } = await run({ systemPrompt: big, prompt: 'Do something' });

  assert.ok(!args.some((a) => a.includes(big)), 'The prompt should not appear in any command-line argument');
  assert.ok(!args.includes('-p'), 'No longer pass the prompt with -p (--input-format stream-json is itself print mode)');
  assert.ok(args.includes('--input-format') && args[args.indexOf('--input-format') + 1] === 'stream-json');

  assert.ok(stdin.includes(big), 'The whole prompt should be written into stdin');
  assert.ok(stdin.includes('Do something'));
});

test('Command-line length is independent of the prompt: however large the prompt is, it cannot blow past 32767', async () => {
  const len = (args) => args.join(' ').length;
  const small = await run({ systemPrompt: 's'.repeat(100) });
  const huge = await run({ systemPrompt: 's'.repeat(200000) });
  assert.equal(len(small.args), len(huge.args), 'Prompt size should not affect command-line length');
  assert.ok(len(huge.args) < WINDOWS_CMDLINE_LIMIT / 10, `The command line holds only flags, so it should be far below the limit, actual ${len(huge.args)}`);
});

test('stdin is the kind of NDJSON that agy accepts: it rejects input missing event or message', async () => {
  const { stdin } = await run({ systemPrompt: 'System', prompt: 'User' });
  const lines = stdin.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'One round, one message');
  const msg = JSON.parse(lines[0]);
  // 这两个字段的名字是对着真 CLI 试出来的,写错任何一个 agy 都会当场报错
  assert.equal(msg.event, 'user');
  assert.equal(msg.message.role, 'user');
  assert.match(msg.message.content, /System[\s\S]*User/);
});

test('Model / reasoning tier / session id still go on the command line and were not moved along with it', async () => {
  const { args } = await run({ model: 'gemini-3.8-flash', effort: 'low', sessionId: 'abc' });
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.8-flash');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.equal(args[args.indexOf('--conversation') + 1], 'abc');
});

/*
 * 名字里带档位的写法(gemini-3.8-flash-low)和 --effort 必须配对,配不上 agy 直接拒整轮。
 * 面板已经拆成「基名 + 档位」了,但后台任务、分工模式那几条路不经过面板,
 * 会话历史里也可能存着早先带后缀的名字 —— 这里是最后一道。
 */
test('A model name with a tier suffix: strip it down to the base name and use the suffix as the tier, so the pair is guaranteed to be valid', async () => {
  const { args } = await run({ model: 'gemini-3.8-flash-low', effort: 'high' });
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.8-flash');
  assert.equal(args[args.indexOf('--effort') + 1], 'low', 'The tier in the name wins, and a mismatched high must not be sent');
});

test('Suffix present but no tier given: fill one in anyway, otherwise agy says requires --effort', async () => {
  const { args } = await run({ model: 'gemini-3.1-pro-high', effort: '' });
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.1-pro');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
});

test('A model name without a tier suffix is passed as is, and no tier is forced onto it', async () => {
  const { args } = await run({ model: 'claude-sonnet-4-6', effort: '' });
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-4-6');
  assert.ok(!args.includes('--effort'), 'claude-sonnet-4-6 does not accept --effort, and passing it gets rejected');
});
