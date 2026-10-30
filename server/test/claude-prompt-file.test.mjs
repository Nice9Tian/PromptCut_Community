/**
 * claude 这条路的系统提示词必须走文件,不能塞进命令行。
 *
 * 跑法 —— **必须带这个 flag**:
 *   node --experimental-test-module-mocks --test server/test/claude-prompt-file.test.mjs
 *
 * 钉住的是一个真事故(诊断报告 对话诊断-20260910-204342):原来是 `--append-system-prompt <整段>`。
 * 原生工具一被拒就改走文本协议重试,工具清单拼进系统提示词后 48,000 字符,超过 Windows
 * 单条命令行 32767 的上限,当场 `spawn ENAMETOOLONG`。agy 那边同样的坑见 agy-stdin.test.mjs。
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import * as realChildProcess from 'node:child_process';
import { useFakeCliHome } from './fake-cli-home.mjs';

// claude / agy 解析到临时目录里的假 .exe,断言 spawn 实参时不受本机装法(npm 垫片等)影响
const fakeCli = useFakeCliHome();
after(() => fakeCli.dispose());

const WINDOWS_CMDLINE_LIMIT = 32767;

let spawned;
/** 每次 spawn 时让假 CLI 往 stdout 吐的行 */
let script = [];
/** 假 CLI 收尾那条 result 里额外带的字段(比如 permission_denials) */
let resultExtra = {};
let spawnCount = 0;
mock.module('node:child_process', { exports: { ...realChildProcess, spawn: (exe, args) => {
  spawnCount++;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const i = args.indexOf('--append-system-prompt-file');
  // 文件要在 CLI 启动那一刻就在,内容就是系统提示词
  const promptFile = i >= 0 ? args[i + 1] : null;
  spawned = { exe, args, promptFile, promptText: promptFile && fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : null };
  child.stdin = new Writable({ write(_c, _e, done) { done(); } });
  child.stdin.on('finish', () => {
    for (const line of script) child.stdout.write(JSON.stringify(line) + '\n');
    child.stdout.write(JSON.stringify({ type: 'result', session_id: 's1', usage: {}, ...resultExtra }) + '\n');
    queueMicrotask(() => child.emit('close', 0));
  });
  return child;
} } });

const { startRun } = await import('../runners/claude.mjs');

async function run(opts = {}) {
  spawned = null;
  spawnCount = 0;
  const events = [];
  const r = startRun({ provider: 'claude', cwd: 'C:\\tmp', onEvent: (e) => events.push(e), systemPrompt: 's', prompt: 'p', ...opts });
  await r.done;
  return { ...spawned, events, spawnCount };
}

/*
 * 自带工具(Read / Grep / Bash / Write / Skill)在这里本来就一律被拒,不能拿它当「原生工具通道坏了」。
 * 以前任何一次被拒都触发文本协议重试:整轮已经做完、答复也写好了,又吞掉 done 从头重跑 ——
 * 诊断报告 对话诊断-20260910-234339 的 #7 #13 #15 都是这么在最后一步报错的。
 */
test('只有自带工具被拒:照常结束,不重跑', async () => {
  script = [];
  resultExtra = { permission_denials: [
    { tool_name: 'Grep', tool_use_id: 't1', tool_input: {} },
    { tool_name: 'Skill', tool_use_id: 't2', tool_input: {} },
  ] };
  try {
    const { events, spawnCount } = await run();
    assert.equal(spawnCount, 1);
    assert.ok(!events.some((e) => e.type === 'status' && /文本协议/.test(e.text)));
    assert.equal(events.filter((e) => e.type === 'done').length, 1);
  } finally { resultExtra = {}; }
});

test('PromptCut 自己的工具被拒:改走文本协议重试', async () => {
  script = [];
  resultExtra = { permission_denials: [{ tool_name: 'mcp__promptcut__get_project', tool_use_id: 't1', tool_input: {} }] };
  try {
    const { events, spawnCount } = await run();
    assert.equal(spawnCount, 2);
    assert.ok(events.some((e) => e.type === 'status' && /改用文本协议重试/.test(e.text)));
    assert.equal(events.filter((e) => e.type === 'done').length, 1, '第一轮的 done 被吞掉,只剩重试那一轮的');
  } finally { resultExtra = {}; }
});

test('系统提示词进文件,不进命令行;命令行长度和提示词大小无关', async () => {
  script = [];
  const big = 'x'.repeat(49000);
  const { args, promptText } = await run({ systemPrompt: big });
  assert.ok(!args.includes('--append-system-prompt'), '不该再用把整段塞进参数的那个标志');
  assert.ok(!args.some((a) => a.includes(big)), '提示词不该出现在任何命令行参数里');
  assert.ok(promptText && promptText.includes(big), 'CLI 启动时文件里就该是整段系统提示词');
  assert.ok(args.join(' ').length < WINDOWS_CMDLINE_LIMIT / 2, '命令行只剩标志和工具白名单');
});

test('系统提示词后面带着自带工具的对照表', async () => {
  script = [];
  const { promptText } = await run({ systemPrompt: '主提示词' });
  assert.match(promptText, /^主提示词/);
  assert.match(promptText, /自带的那套工具/);
  assert.match(promptText, /cardUrl/);
  assert.match(promptText, /collect_search/);
});

test('跑完把临时文件删掉', async () => {
  script = [];
  const { promptFile } = await run();
  assert.ok(promptFile);
  assert.ok(!fs.existsSync(promptFile), `临时文件该删掉了:${promptFile}`);
});

/*
 * 并行调用同名工具时,结果要按 tool_use_id 对回去。以前不带 callId,界面按名字配对,
 * 四个并行的 see_frames 结果全错位(诊断报告 7939–7979 行:传 A 的调用下面挂着 D 的结果)。
 */
test('tool_call / tool_result 带 callId', async () => {
  script = [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tu_1', name: 'mcp__promptcut__see_frames', input: { mediaId: 'a' } },
      { type: 'tool_use', id: 'tu_2', name: 'mcp__promptcut__see_frames', input: { mediaId: 'b' } },
    ] } },
    { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu_2', content: 'B 的结果' },
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'A 的结果' },
    ] } },
  ];
  const { events } = await run();
  const calls = events.filter((e) => e.type === 'tool_call');
  const results = events.filter((e) => e.type === 'tool_result');
  assert.deepEqual(calls.map((c) => c.callId), ['tu_1', 'tu_2']);
  assert.deepEqual(results.map((r) => [r.callId, r.summary]), [['tu_2', 'B 的结果'], ['tu_1', 'A 的结果']]);
});
