/**
 * codex、agy 两路的工具调用也带 callId(修 C6.5 遗留:原来这两路拿不到,只能在 Agent 操作记录里撤)。
 *
 * 跑法 —— **必须带这个 flag**(假的 child_process):
 *   node --experimental-test-module-mocks --test server/test/runner-callid.test.mjs
 *
 * 夹具是 2026-09-27 在本机实录的输出流和 MCP 请求(codex-cli 0.156.1、agy 1.2.11,原文见
 * docs/archive/agent-reports/AGENT-runner-callid.md;里面没有凭证,用户目录换成了占位):
 *   - codex 的 `_meta` 带 threadId(= 输出流 thread.started 的 thread_id)和它自己的 callId(输出流里没有);
 *     输出流工具条目的 id 是 item_0、item_1 —— 只能按(thread、工具名、参数)配对;
 *   - agy 的 `_meta` 带 conversation_id 和 progressToken "<uuid>:<步号>",步号 = 输出流的 step_index。
 * 覆盖:两种先后顺序、同名同参并行(不配,退回原来的行为)、同名同参先后(配对各自的)、配对失败的退化。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as realChildProcess from 'node:child_process';

/** 假的 CLI 进程:测试自己往它的 stdout 写行,决定每一行在什么时候到 */
let lastChild = null;
mock.module('node:child_process', { exports: { ...realChildProcess, spawn: (cmd, args, opts) => {
  if (cmd === 'taskkill') { const k = new EventEmitter(); return k; }
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  child.pid = 0;
  child.stdin = new Writable({ write(_c, _e, done) { done(); } });
  child.feed = (obj) => child.stdout.write(JSON.stringify(obj) + '\n');
  child.end = () => new Promise((r) => setTimeout(() => { child.emit('close', 0); r(); }, 5));
  lastChild = child;
  return child;
} } });

const { createCallPairing, argsKey } = await import('../agent/call-pairing.mjs');
const codex = await import('../runners/codex.mjs');
const agy = await import('../runners/agy.mjs');

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 夹具(实录)

const CODEX_THREAD = '01a0e00b-4a61-7e70-af46-a8cf5a166523';
/** codex exec --json 的输出流(实录,两次串行的 get_answer;工具名换成了 get_clip,参数原样) */
const codexStream = (tool = 'get_clip') => [
  { type: 'thread.started', thread_id: CODEX_THREAD },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'item_0', type: 'mcp_tool_call', server: 'promptcut', tool, arguments: { key: 'alpha' }, result: null, error: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_0', type: 'mcp_tool_call', server: 'promptcut', tool, arguments: { key: 'alpha' }, result: { content: [{ type: 'text', text: 'answer for alpha is 42' }], structured_content: null }, error: null, status: 'completed' } },
  { type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server: 'promptcut', tool, arguments: { key: 'beta' }, result: null, error: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server: 'promptcut', tool, arguments: { key: 'beta' }, result: { content: [{ type: 'text', text: 'answer for beta is 42' }], structured_content: null }, error: null, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'alpha: 42\nbeta: 42' } },
  { type: 'turn.completed', usage: { input_tokens: 29129, cached_input_tokens: 26752, output_tokens: 83 } },
];
/** codex 发给 MCP 的 tools/call 的 _meta(实录) */
const codexMeta = {
  callId: 'exec-ba81ac03-fea9-48f1-85a9-4ec13937f9f9',
  'x-codex-turn-metadata': { session_id: CODEX_THREAD, thread_id: CODEX_THREAD, reasoning_effort: 'low', turn_id: '01a0e00b-4a9a-7c10-8644-674679b27b6e', model: 'gpt-6-astra', thread_source: 'user', turn_trigger: 'exec', sandbox: 'none', sandbox_mode: 'read-only', codex_version: '0.156.1' },
  threadId: CODEX_THREAD, sessionId: CODEX_THREAD, windowId: `${CODEX_THREAD}:0`,
  itemId: 'ctc_0caa429e5666034f016ab854d340e887d08ba42bd7148af1b0', progressToken: 1,
};

const AGY_CONV = '5b290f32-0511-401d-8e85-30ceb9cbd662';
/** agy --output-format stream-json 的输出流(实录,init 里的内建工具清单删了) */
const agyStream = [
  { event: 'init', conversation_id: AGY_CONV, init: { model: 'gemini-3.8-flash', permission_mode: 'request-review' } },
  { event: 'step_update', step_update: { conversation_id: AGY_CONV, step_index: 0, state: 'DONE', step_type: 'user_input' } },
  { event: 'step_update', step_update: { conversation_id: AGY_CONV, step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { Arguments: { clip_id: 'c1', id: 'c1' }, ServerName: 'promptcut', ToolName: 'get_clip' } } } },
  { event: 'step_update', step_update: { conversation_id: AGY_CONV, step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'call_mcp_tool', duration_seconds: 0.27, tool_info: { name: 'call_mcp_tool', parameters: { Arguments: { clip_id: 'c1', id: 'c1' }, ServerName: 'promptcut', ToolName: 'get_clip' }, output: 'clip c1 has length 42' } } },
  { event: 'step_update', step_update: { conversation_id: AGY_CONV, step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { Arguments: { clip_id: 'c2', id: 'c2' }, ServerName: 'promptcut', ToolName: 'get_clip' } } } },
  { event: 'step_update', step_update: { conversation_id: AGY_CONV, step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'call_mcp_tool', duration_seconds: 2.44, tool_info: { name: 'call_mcp_tool', parameters: { Arguments: { clip_id: 'c2', id: 'c2' }, ServerName: 'promptcut', ToolName: 'get_clip' }, output: 'clip c2 has length 42' } } },
  { event: 'step_update', step_update: { conversation_id: AGY_CONV, step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: 'c1: 42, c2: 42' } },
  { event: 'result', result: { conversation_id: AGY_CONV, status: 'SUCCESS', response: 'c1: 42, c2: 42', num_turns: 1 } },
];
/** agy 发给 MCP 的 tools/call 的 _meta(实录;artifacts_dir 里的用户目录换成了占位) */
const agyMeta = (step) => ({
  'antigravity.google/artifacts_dir': `C:\\Users\\<user>\\.gemini\\antigravity-cli\\brain\\${AGY_CONV}`,
  'antigravity.google/conversation_id': AGY_CONV,
  progressToken: `29d2aeee-8ff2-4280-9aec-237872d543e5:${step}`,
});

// ---------------------------------------------------------------- 配对本身

test('配对:先报到后认领、先认领后报到,都拿到 runner 发给页面的同一个 callId', async () => {
  const p = createCallPairing({ waitMs: 500 });
  p.open('codex:t');
  p.announce('codex:t', 'add_clip', { a: 1, b: [1, { y: 2, x: 1 }] }, 'cx-1');
  // 键的顺序不同也认得出来
  assert.equal(await p.claim('codex:t', 'add_clip', { b: [1, { x: 1, y: 2 }], a: 1 }), 'cx-1');
  const waiting = p.claim('codex:t', 'add_clip', { a: 2 });
  await tick();
  p.announce('codex:t', 'add_clip', { a: 2 }, 'cx-2');
  assert.equal(await waiting, 'cx-2');
});

test('配对:同名同参并行 —— 分不清谁是谁,两边都不配(退回原来的行为),不许配错', async () => {
  const p = createCallPairing({ waitMs: 300 });
  p.open('codex:t');
  // 报到在前:两条同钥匙都还没被认领
  p.announce('codex:t', 'add_clip', { a: 1 }, 'cx-1');
  p.announce('codex:t', 'add_clip', { a: 1 }, 'cx-2');
  assert.equal(await p.claim('codex:t', 'add_clip', { a: 1 }), undefined);
  assert.equal(await p.claim('codex:t', 'add_clip', { a: 1 }), undefined);
  // 认领在前:两个认领者在等同一把钥匙
  const q = createCallPairing({ waitMs: 300 });
  q.open('codex:u');
  const w1 = q.claim('codex:u', 'add_clip', { a: 1 });
  const w2 = q.claim('codex:u', 'add_clip', { a: 1 });
  await tick();
  q.announce('codex:u', 'add_clip', { a: 1 }, 'cx-3');
  assert.deepEqual(await Promise.all([w1, w2]), [undefined, undefined]);
  assert.equal(q.stats().waiters, 0);
});

test('配对:同名同参先后(上一次结清了才有下一次)—— 各配各的', async () => {
  const p = createCallPairing({ waitMs: 300 });
  p.open('codex:t');
  p.announce('codex:t', 'add_clip', { a: 1 }, 'cx-1');
  assert.equal(await p.claim('codex:t', 'add_clip', { a: 1 }), 'cx-1');
  p.settle('cx-1');
  p.announce('codex:t', 'add_clip', { a: 1 }, 'cx-2');
  assert.equal(await p.claim('codex:t', 'add_clip', { a: 1 }), 'cx-2');
  p.settle('cx-2');
  assert.equal(p.stats().entries, 0);
});

test('配对失败的退化:参数不一致、范围不一致、没人报到、报到已结清 —— 都回 undefined', async () => {
  const p = createCallPairing({ waitMs: 60, unknownWaitMs: 20 });
  p.open('codex:t');
  p.announce('codex:t', 'add_clip', { a: 1 }, 'cx-1');
  assert.equal(await p.claim('codex:t', 'add_clip', { a: 2 }), undefined, '参数不一致');
  assert.equal(await p.claim('codex:t', 'remove_clip', { a: 1 }), undefined, '工具名不一致');
  assert.equal(await p.claim('codex:other', 'add_clip', { a: 1 }), undefined, '范围不一致');
  p.settle('cx-1');
  assert.equal(await p.claim('codex:t', 'add_clip', { a: 1 }), undefined, '结清了的报到不再能认领');
  const t0 = Date.now();
  assert.equal(await p.claim('codex:nobody', 'get_project', {}), undefined);
  assert.ok(Date.now() - t0 < 200, '范围未知时只短等');
  assert.equal(await p.claim(undefined, 'get_project', {}), undefined);
  assert.equal(p.stats().waiters, 0);
});

test('配对:agy 的提示(对话 + 步号)只认那一条;提示对上但参数不符不配', async () => {
  const p = createCallPairing({ waitMs: 60 });
  p.open(`agy:${AGY_CONV}`);
  // 同名同参两步都挂着,有提示照样分得清
  p.announce(`agy:${AGY_CONV}`, 'get_clip', { id: 'c1' }, `agy:${AGY_CONV}:2`);
  p.announce(`agy:${AGY_CONV}`, 'get_clip', { id: 'c1' }, `agy:${AGY_CONV}:3`);
  assert.equal(await p.claim(`agy:${AGY_CONV}`, 'get_clip', { id: 'c1' }, `agy:${AGY_CONV}:3`), `agy:${AGY_CONV}:3`);
  assert.equal(await p.claim(`agy:${AGY_CONV}`, 'get_clip', { id: 'c1' }, `agy:${AGY_CONV}:2`), `agy:${AGY_CONV}:2`);
  p.announce(`agy:${AGY_CONV}`, 'get_clip', { id: 'c9' }, `agy:${AGY_CONV}:7`);
  assert.equal(await p.claim(`agy:${AGY_CONV}`, 'get_clip', { id: 'zz' }, `agy:${AGY_CONV}:7`), undefined);
  // 提示的那一步还没报到:等它;别的步报到不抢
  const w = p.claim(`agy:${AGY_CONV}`, 'get_clip', { id: 'c5' }, `agy:${AGY_CONV}:9`);
  await tick();
  p.announce(`agy:${AGY_CONV}`, 'get_clip', { id: 'c5' }, `agy:${AGY_CONV}:8`);
  p.announce(`agy:${AGY_CONV}`, 'get_clip', { id: 'c5' }, `agy:${AGY_CONV}:9`);
  assert.equal(await w, `agy:${AGY_CONV}:9`);
});

test('argsKey:键顺序无关,值不同就不同', () => {
  assert.equal(argsKey({ b: 1, a: { d: 1, c: 2 } }), argsKey({ a: { c: 2, d: 1 }, b: 1 }));
  assert.notEqual(argsKey({ a: 1 }), argsKey({ a: '1' }));
  assert.equal(argsKey(undefined), argsKey({}));
});

// ---------------------------------------------------------------- runner 用实录的输出流

async function startCodex(pairing) {
  const events = [];
  const run = codex.startRun({ provider: 'codex', cwd: 'C:\\tmp', systemPrompt: 's', prompt: 'p', onEvent: (e) => events.push(e), callPairing: pairing });
  await tick();
  return { run, events, child: lastChild };
}

test('codex:实录输出流 —— tool_call / tool_result 带同一个 callId,MCP 那边先到后到都认领得到', async () => {
  const pairing = createCallPairing({ waitMs: 500, unknownWaitMs: 500 });
  const { run, events, child } = await startCodex(pairing);
  const [started, turn, s0, c0, s1, c1, msg, done] = codexStream();
  const scope = `codex:${CODEX_THREAD}`;
  child.feed(started); child.feed(turn);
  await tick();
  // 第一次:MCP 先到(输出流那行还没到)
  const claim0 = pairing.claim(scope, 'get_clip', { key: 'alpha' });
  await tick();
  child.feed(s0);
  const id0 = await claim0;
  child.feed(c0);
  // 第二次:输出流先到
  child.feed(s1);
  await tick();
  const id1 = await pairing.claim(scope, 'get_clip', { key: 'beta' });
  child.feed(c1); child.feed(msg); child.feed(done);
  await child.end();
  await run.done;

  const calls = events.filter((e) => e.type === 'tool_call');
  const results = events.filter((e) => e.type === 'tool_result');
  assert.equal(calls.length, 2);
  assert.match(calls[0].callId, /^cx-[a-z0-9]+-item_0$/);
  assert.match(calls[1].callId, /^cx-[a-z0-9]+-item_1$/);
  assert.equal(id0, calls[0].callId, 'MCP 先到:等到报到后认领');
  assert.equal(id1, calls[1].callId, '输出流先到:直接认领');
  assert.deepEqual(results.map((r) => r.callId), calls.map((c) => c.callId), '结果带同一个 callId,页面按它盖章');
  assert.deepEqual(pairing.stats(), { entries: 0, waiters: 0, scopes: 0 }, '运行结束全部清掉');
});

test('codex:同名同参并行(两个 item 都开始了才结束)—— 都不配,事件照样带各自的 callId', async () => {
  const pairing = createCallPairing({ waitMs: 200 });
  const { run, events, child } = await startCodex(pairing);
  const [started, turn, s0, c0] = codexStream('add_clip');
  const same = (o, id) => ({ ...o, item: { ...o.item, id, arguments: { key: 'same' } } });
  const scope = `codex:${CODEX_THREAD}`;
  child.feed(started); child.feed(turn);
  child.feed(same(s0, 'item_0')); child.feed(same(s0, 'item_1'));
  await tick();
  const got = await Promise.all([pairing.claim(scope, 'add_clip', { key: 'same' }), pairing.claim(scope, 'add_clip', { key: 'same' })]);
  assert.deepEqual(got, [undefined, undefined], '分不清就不配 —— 退回原来的行为,只能在 Agent 操作记录里撤');
  child.feed(same(c0, 'item_0')); child.feed(same(c0, 'item_1'));
  await child.end();
  await run.done;
  const calls = events.filter((e) => e.type === 'tool_call');
  assert.equal(new Set(calls.map((c) => c.callId)).size, 2, '页面那边两条各有各的 id,结果不会盖错行');
});

test('codex:不接编辑器(没给 callPairing)时照常跑,事件也带 callId', async () => {
  const { run, events, child } = await startCodex(undefined);
  for (const l of codexStream()) child.feed(l);
  await child.end();
  await run.done;
  assert.equal(events.filter((e) => e.type === 'tool_call' && e.callId).length, 2);
  assert.ok(events.some((e) => e.type === 'done'));
});

test('agy:实录输出流 —— callId 是 agy:<对话>:<步号>,和按 _meta 拼出的提示一致,认领得到', async () => {
  const pairing = createCallPairing({ waitMs: 500 });
  const events = [];
  const run = agy.startRun({ provider: 'agy', cwd: 'C:\\tmp', systemPrompt: 's', prompt: 'p', onEvent: (e) => events.push(e), callPairing: pairing });
  await tick();
  const child = lastChild;
  const scope = `agy:${AGY_CONV}`;
  const hintOf = (meta) => `agy:${meta['antigravity.google/conversation_id']}:${Number(/:(\d+)$/.exec(meta.progressToken)[1])}`;
  const [init, user, a2, d2, a3, d3, text, result] = agyStream;
  child.feed(init); child.feed(user);
  await tick();
  // 步 2:MCP 先到
  const claim2 = pairing.claim(scope, 'get_clip', { clip_id: 'c1', id: 'c1' }, hintOf(agyMeta(2)));
  await tick();
  child.feed(a2);
  const id2 = await claim2;
  child.feed(d2);
  // 步 3:输出流先到
  child.feed(a3);
  await tick();
  const id3 = await pairing.claim(scope, 'get_clip', { clip_id: 'c2', id: 'c2' }, hintOf(agyMeta(3)));
  child.feed(d3); child.feed(text); child.feed(result);
  await child.end();
  await run.done;

  const calls = events.filter((e) => e.type === 'tool_call');
  assert.deepEqual(calls.map((c) => c.callId), [`agy:${AGY_CONV}:2`, `agy:${AGY_CONV}:3`]);
  assert.equal(id2, calls[0].callId);
  assert.equal(id3, calls[1].callId);
  assert.deepEqual(events.filter((e) => e.type === 'tool_result').map((r) => r.callId), calls.map((c) => c.callId));
  assert.deepEqual(pairing.stats(), { entries: 0, waiters: 0, scopes: 0 });
});

// ---------------------------------------------------------------- mcp-server 把 _meta 里的线索转给编辑器

test('mcp-server:codex 的 _meta 转成 pair.scope,agy 的转成 scope + hint;Claude 的 toolUseId 照旧,不带 pair', async () => {
  const bodies = [];
  const bridge = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/mcp/call') bodies.push(JSON.parse(body));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { ok: true } }));
    });
  });
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  const port = bridge.address().port;
  // 用真的 spawn 起 mcp-server(上面 mock 的是 runner 用的那份;这里从原模块拿)
  const child = realChildProcess.spawn(process.execPath, [fileURLToPath(new URL('../mcp-server.mjs', import.meta.url))], { env: { ...process.env, PROMPTCUT_PORT: String(port), PROMPTCUT_AGENT: 'conv-x' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  const call = async (id, name, args, meta) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }) + '\n');
    const t0 = Date.now();
    while (!buf.split('\n').some((l) => l.includes(`"id":${id}`))) {
      if (Date.now() - t0 > 10000) throw new Error(`10 秒没收到 id ${id} 的回复`);
      await tick(20);
    }
  };
  try {
    await call(21, 'get_clip', { key: 'alpha' }, codexMeta);
    await call(22, 'get_clip', { clip_id: 'c1', id: 'c1' }, agyMeta(2));
    await call(23, 'get_clip', { id: 'c1' }, { 'claudecode/toolUseId': 'toolu_01XYZ', progressToken: 3 });
    await call(24, 'get_clip', { id: 'c1' }, { progressToken: 'weird' });
    await call(25, 'get_clip', { id: 'c1' }, { 'antigravity.google/conversation_id': AGY_CONV, progressToken: 7 });
    const got = bodies.filter((b) => b.tool === 'get_clip');
    if (got.length !== 5) console.error(buf);
    assert.equal(got.length, 5);
    assert.deepEqual(got[0].pair, { scope: `codex:${CODEX_THREAD}` });
    assert.equal('callId' in got[0], false, 'codex 自己的 _meta.callId 输出流里没有,不能当 callId 用');
    assert.deepEqual(got[1].pair, { scope: `agy:${AGY_CONV}`, hint: `agy:${AGY_CONV}:2` });
    assert.equal(got[2].callId, 'toolu_01XYZ');
    assert.equal('pair' in got[2], false);
    assert.equal('pair' in got[3], false, '认不出是哪家就不带');
    assert.deepEqual(got[4].pair, { scope: `agy:${AGY_CONV}` }, 'progressToken 不是 "<uuid>:<步号>" 就不给提示');
    assert.equal(got[0].agent, 'conv-x');
  } finally {
    child.kill();
    bridge.close();
    bridge.closeAllConnections?.();
  }
});
