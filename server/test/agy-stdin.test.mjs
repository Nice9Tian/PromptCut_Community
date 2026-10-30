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
    child.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: '收到' } }) + '\n');
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

test('提示词进 stdin,不进命令行', async () => {
  const big = 'x'.repeat(49000);
  const { args, stdin } = await run({ systemPrompt: big, prompt: '做点什么' });

  assert.ok(!args.some((a) => a.includes(big)), '提示词不该出现在任何一个命令行参数里');
  assert.ok(!args.includes('-p'), '不再用 -p 传提示词(--input-format stream-json 本身就是 print 模式)');
  assert.ok(args.includes('--input-format') && args[args.indexOf('--input-format') + 1] === 'stream-json');

  assert.ok(stdin.includes(big), '提示词该整个写进 stdin');
  assert.ok(stdin.includes('做点什么'));
});

test('命令行长度和提示词无关:提示词再大也撑不爆 32767', async () => {
  const len = (args) => args.join(' ').length;
  const small = await run({ systemPrompt: 's'.repeat(100) });
  const huge = await run({ systemPrompt: 's'.repeat(200000) });
  assert.equal(len(small.args), len(huge.args), '提示词大小不该影响命令行长度');
  assert.ok(len(huge.args) < WINDOWS_CMDLINE_LIMIT / 10, `命令行只剩标志,应该远低于上限,实际 ${len(huge.args)}`);
});

test('stdin 是 agy 认的那种 NDJSON:少 event 或少 message 它都会拒', async () => {
  const { stdin } = await run({ systemPrompt: '系统', prompt: '用户' });
  const lines = stdin.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, '一轮就一条消息');
  const msg = JSON.parse(lines[0]);
  // 这两个字段的名字是对着真 CLI 试出来的,写错任何一个 agy 都会当场报错
  assert.equal(msg.event, 'user');
  assert.equal(msg.message.role, 'user');
  assert.match(msg.message.content, /系统[\s\S]*用户/);
});

test('模型 / 推理档 / 会话 id 还是走命令行,没被一起挪走', async () => {
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
test('带档位后缀的模型名:剥成基名,后缀当档位,保证配得上', async () => {
  const { args } = await run({ model: 'gemini-3.8-flash-low', effort: 'high' });
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.8-flash');
  assert.equal(args[args.indexOf('--effort') + 1], 'low', '名字里那档说了算,不能把对不上的 high 发出去');
});

test('带后缀但没给档位:也要补上,不然 agy 说 requires --effort', async () => {
  const { args } = await run({ model: 'gemini-3.1-pro-high', effort: '' });
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.1-pro');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
});

test('不带档位后缀的模型名原样传,也不硬塞一个档位', async () => {
  const { args } = await run({ model: 'claude-sonnet-4-6', effort: '' });
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-4-6');
  assert.ok(!args.includes('--effort'), 'claude-sonnet-4-6 不吃 --effort,给了会被拒');
});
