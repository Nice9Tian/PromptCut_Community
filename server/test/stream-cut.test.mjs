/**
 * stream-cut(2026-10-22 用户定:「现在修:中途被网关掐断按截断处理(保住半截参数、走代码块续写),按实测速度给单次输出设上限;
 * 顺带把合并窗口放宽到 1 秒。」)。报告 `docs/reports/AGENT-stream-cut.md`。
 *
 * 全部用假模型:假 fetch 交的 SSE,以及在 5990～5999 上起的本机假网关(真 fetch,网关在流中途发 error 事件或直接断连接)。
 * 不调真模型。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import * as openai from '../harness/providers/openai.mjs';
import * as anthropic from '../harness/providers/anthropic.mjs';
import * as gemini from '../harness/providers/gemini.mjs';
import { STREAM_CUT } from '../harness/providers/base.mjs';
import { Agent } from '../harness/agent.mjs';
import { createCodeCacheStore } from '../tools/code-cache.mjs';
import { salvageTruncation } from '../harness/truncation.mjs';
import { resolveMaxOutput } from '../harness/model-limits.mjs';
import {
  createOutputSpeedBook, outputSpeedBookFor, withOutputSpeed, conservativeSpeed, _resetOutputSpeedBooks,
  OUTPUT_TIME_BUDGET_S, DEFAULT_TOKENS_PER_SECOND, MIN_SAMPLE_OUTPUT_TOKENS, MIN_SPEED_CAP, GATEWAY_REQUEST_LIMIT_S,
} from '../harness/output-speed.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `pc-sc-${p}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理 */ } };
const GATEWAY_CUT = 'The upstream stream ended before the response was complete.';

// ───────────── 假 SSE ─────────────

/** chunks 交完后:end 正常结束;throw 抛 err(模拟连接被断) */
function sse(chunks, { throwAfter = null } = {}) {
  return { ok: true, status: 200, headers: { get: () => 'text/event-stream' },
    body: (async function* () { for (const c of chunks) yield c; if (throwAfter) throw throwAfter; })() };
}
const d = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const ev = (event, obj) => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
const fetchOf = (res) => async () => res;
async function drain(provider) {
  const out = [];
  for await (const e of provider.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], [], 'sys', undefined)) out.push(e);
  return out;
}
const terminated = () => Object.assign(new TypeError('terminated'), { cause: new Error('other side closed') });

const HALF_ARGS = '{"id":"demo","source":"export default {\\n  name: \\"写了一半';

// ── OpenAI 兼容口 ──
const openaiHead = [
  d({ choices: [{ delta: { role: 'assistant' } }] }),
  d({ choices: [{ delta: { content: '我来写卡。' } }] }),
  d({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'add_clip', arguments: '{"cardId":"t"}' } }] } }] }),
  d({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'create_card', arguments: HALF_ARGS.slice(0, 15) } }] } }] }),
  d({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: HALF_ARGS.slice(15) } }] } }] }),
];
const oa = (res) => openai.createProvider({ apiKey: 'k', model: 'gemini-3.8-flash', baseUrl: 'https://x/v1' }, { fetchImpl: fetchOf(res) });

function assertCut(evs, { partialName = 'create_card', args = HALF_ARGS, text = '我来写卡。', complete = ['add_clip'] } = {}) {
  assert.equal(evs.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), text, '已经收到的文字保留');
  assert.deepEqual(evs.filter((e) => e.type === 'tool_use').map((e) => e.name), complete, '写完的工具调用照常交');
  const partial = evs.filter((e) => e.type === 'tool_use_partial');
  if (partialName) {
    assert.equal(partial.length, 1);
    assert.equal(partial[0].name, partialName);
    assert.equal(partial[0].args, args, '半截参数原文');
  } else assert.equal(partial.length, 0);
  assert.equal(evs.at(-1).type, 'stop');
  assert.equal(evs.at(-1).reason, STREAM_CUT, '按截断收尾');
  assert.ok(evs.some((e) => e.type === 'notice' && e.stage === 'stream-cut'), '交一条掐断的提示进运行日志');
}

test('OpenAI 兼容口:流中途来 error 事件(网关约 300 秒掐断)→ 文字保留、半截工具调用交成 tool_use_partial、以 stream_cut 收尾', async () => {
  const evs = await drain(oa(sse([...openaiHead, d({ error: { message: GATEWAY_CUT, type: 'upstream_error' } })])));
  assertCut(evs);
  assert.equal(evs.find((e) => e.stage === 'stream-cut').data.how, 'error-event');
  assert.match(evs.find((e) => e.stage === 'stream-cut').data.detail, /upstream stream ended/);
});

test('OpenAI 兼容口:连接在流中途被断 → 按截断收尾', async () => {
  const evs = await drain(oa(sse(openaiHead, { throwAfter: terminated() })));
  assertCut(evs);
  assert.equal(evs.find((e) => e.stage === 'stream-cut').data.how, 'connection');
});

test('OpenAI 兼容口:流读完了却没有 finish_reason → 按截断收尾;参数一个字没来的调用也不当 {} 执行', async () => {
  const evs = await drain(oa(sse([...openaiHead, d({ choices: [{ delta: { tool_calls: [{ index: 2, id: 'c', function: { name: 'set_position' } }] } }] })])));
  assert.deepEqual(evs.filter((e) => e.type === 'tool_use_partial').map((e) => [e.name, e.args]), [['create_card', HALF_ARGS], ['set_position', '']]);
  assert.equal(evs.at(-1).reason, STREAM_CUT);
});

test('OpenAI 兼容口:还没出数据就失败的照旧抛错,不当截断', async () => {
  await assert.rejects(drain(oa(sse([d({ choices: [{ delta: { role: 'assistant' } }] }), d({ error: { message: GATEWAY_CUT } })]))), /upstream stream ended/);
  await assert.rejects(drain(oa(sse([], { throwAfter: terminated() }))), /terminated/);
  await assert.rejects(drain(oa(sse([d({ choices: [{ delta: { role: 'assistant' } }] })]))), /提前结束/);
});

test('OpenAI 兼容口:正常收尾之后再来的错不影响;我们自己的闲置超时不当截断', async () => {
  const done = [...openaiHead.slice(0, 2), d({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } })];
  let evs = await drain(oa(sse([...done, d({ error: { message: 'late' } })])));
  assert.equal(evs.at(-1).reason, 'stop');
  evs = await drain(oa(sse(done, { throwAfter: terminated() })));
  assert.equal(evs.at(-1).reason, 'stop');
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  await assert.rejects(drain(oa(sse(openaiHead, { throwAfter: timeout }))), /timeout/);
});

// ── Anthropic ──
const anthropicHead = [
  ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 7 } } }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我来写卡。' } }),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'add_clip', input: {} } }),
  ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cardId":"t"}' } }),
  ev('content_block_stop', { type: 'content_block_stop', index: 1 }),
  ev('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'b', name: 'create_card', input: {} } }),
  ev('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: HALF_ARGS } }),
];
const an = (res) => anthropic.createProvider({ apiKey: 'k', model: 'claude-sonnet-5-5' }, { fetchImpl: fetchOf(res) });

test('Anthropic:流中途来 error 事件 / 连接被断 / 没有 message_stop 就结束 → 都按截断收尾', async () => {
  assertCut(await drain(an(sse([...anthropicHead, ev('error', { type: 'error', error: { type: 'overloaded_error', message: GATEWAY_CUT } })]))));
  assertCut(await drain(an(sse(anthropicHead, { throwAfter: terminated() }))));
  assertCut(await drain(an(sse(anthropicHead))));
});

test('Anthropic:还没出内容就失败的照旧抛错', async () => {
  await assert.rejects(drain(an(sse([anthropicHead[0], ev('error', { type: 'error', error: { message: GATEWAY_CUT } })]))), /upstream stream ended/);
  await assert.rejects(drain(an(sse([anthropicHead[0]]))), /提前结束/);
  await assert.rejects(drain(an(sse([anthropicHead[0]], { throwAfter: terminated() }))), /terminated/);
});

// ── Gemini ──
const geminiHead = [
  d({ candidates: [{ content: { parts: [{ text: '我来写卡。' }] } }] }),
  d({ candidates: [{ content: { parts: [{ functionCall: { name: 'add_clip', args: { cardId: 't' } } }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9, thoughtsTokenCount: 30 } }),
];
const ge = (res) => gemini.createProvider({ apiKey: 'k', model: 'gemini-3.8-flash' }, { fetchImpl: fetchOf(res) });

test('Gemini:流中途来 error 事件 / 连接被断 / 没有 finishReason 就结束 → 文字和整块到达的工具调用保留,按截断收尾', async () => {
  for (const res of [
    sse([...geminiHead, d({ error: { code: 502, message: GATEWAY_CUT } })]),
    sse(geminiHead, { throwAfter: terminated() }),
    sse(geminiHead),
  ]) {
    const evs = await drain(ge(res));
    assertCut(evs, { partialName: null });
    assert.deepEqual(evs.find((e) => e.type === 'usage'), { type: 'usage', input: 5, output: 9, thoughts: 30 }, '思考 token 另报(给速度记录用)');
  }
});

test('Gemini:还没出内容就失败的照旧抛错;正常收尾照旧', async () => {
  await assert.rejects(drain(ge(sse([d({ error: { message: GATEWAY_CUT } })]))), /upstream stream ended/);
  await assert.rejects(drain(ge(sse([], { throwAfter: terminated() }))), /terminated/);
  const evs = await drain(ge(sse([...geminiHead, d({ candidates: [{ finishReason: 'STOP' }] })])));
  assert.equal(evs.at(-1).reason, 'STOP');
});

// ───────────── 截断收尾:给模型和用户的话说「被网关掐断」 ─────────────

test('掐断时存代码块的那段话和状态行说的是「被网关中途掐断」,不是「超过单次输出上限」', () => {
  const dir = tmp('salvage');
  try {
    const store = createCodeCacheStore({ dir, writer: 't' });
    const s = salvageTruncation([{ name: 'create_card', args: HALF_ARGS }], store, { cause: 'cut' });
    assert.equal(s.progress, true);
    assert.match(s.note, /连接被网关中途掐断了/);
    assert.match(s.note, /和单次输出上限无关/);
    assert.match(s.note, /被网关掐断,这次调用没有执行/);
    assert.match(s.note, /@code_cache:cut_create_card_1/);
    assert.match(s.status, /^模型这次回复写到一半被网关中途掐断了.*已存进代码块 cut_create_card_1，已让它接着写。$/);
    assert.doesNotMatch(s.status, /单次输出上限/);
    const empty = salvageTruncation([], store, { cause: 'cut' });
    assert.match(empty.status, /被网关中途掐断了.*没有执行任何操作/);
    // 写到上限的那种照旧
    assert.match(salvageTruncation([], store).status, /超过单次输出上限被截断了/);
  } finally { rm(dir); }
});

function scripted(turns) {
  let i = 0;
  return { name: 'fake', async *stream() { const t = turns[Math.min(i, turns.length - 1)]; i += 1; for (const e of t) yield e; } };
}

test('Agent:stream_cut 和写到上限一样存代码块、让模型接着写;次数超限时的话说被网关掐断,不叫人调大上限', async () => {
  const dir = tmp('agent');
  try {
    const codeCache = createCodeCacheStore({ dir, writer: 't' });
    const cut = [{ type: 'text_delta', text: '写卡' }, { type: 'tool_use_partial', id: 'p', name: 'create_card', args: HALF_ARGS }, { type: 'stop', reason: 'stream_cut' }];
    const events = [];
    const agent = new Agent({ provider: scripted([cut]), system: 's', tools: [{ name: 'create_card', inputSchema: { type: 'object' }, execute: async () => ({ ok: true }) }], codeCache, onEvent: (e) => events.push(e) });
    await assert.rejects(agent.run('做卡'), (err) => {
      assert.match(err.message, /^模型的回复连续 7 次被网关中途掐断（网关对单次请求有时长上限），这一轮没能完成。已经写出的部分存在代码块 cut_create_card_1/);
      assert.doesNotMatch(err.message, /调大单次输出上限/);
      return true;
    });
    const statuses = events.filter((e) => e.type === 'status').map((e) => e.text);
    assert.equal(statuses.length, 6, '前 6 次都让它接着写');
    assert.match(statuses[0], /被网关中途掐断了（网关对单次请求有时长上限）；写了一半的 create_card/);
    const diag = events.filter((e) => e.type === 'diagnostic' && e.stage === 'truncated');
    assert.equal(diag[0].data.cause, 'cut');
    // 第一次掐断后交给模型的话
    const notes = agent.history.get().filter((m) => m.role === 'user').flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => b.text);
    assert.ok(notes.some((t) => /连接被网关中途掐断了/.test(t)));
  } finally { rm(dir); }
});

test('Agent:掐断和写到上限混着来时,话里两样都说', async () => {
  const dir = tmp('agent-mix');
  try {
    const codeCache = createCodeCacheStore({ dir, writer: 't' });
    const turn = (reason) => [{ type: 'tool_use_partial', id: 'p', name: 'create_card', args: HALF_ARGS }, { type: 'stop', reason }];
    const agent = new Agent({ provider: scripted([turn('stream_cut'), turn('length'), turn('stream_cut'), turn('length'), turn('stream_cut'), turn('length'), turn('length')]), system: 's',
      tools: [{ name: 'create_card', inputSchema: { type: 'object' }, execute: async () => ({ ok: true }) }], codeCache });
    await assert.rejects(agent.run('做卡'), /连续 7 次被截断（超过单次输出上限或被网关中途掐断）/);
  } finally { rm(dir); }
});

// ───────────── 按实测速度设上限 ─────────────

test('速度常量:网关约 300 秒、预算 250 秒;没有记录时按缺省速度,上限 = 缺省速度 × 250', () => {
  assert.equal(GATEWAY_REQUEST_LIMIT_S, 300);
  assert.equal(OUTPUT_TIME_BUDGET_S, 250);
  const book = createOutputSpeedBook();
  assert.deepEqual(book.speedOf('gemini-3.8-flash'), { tps: DEFAULT_TOKENS_PER_SECOND, samples: 0 });
  assert.equal(book.capFor('gemini-3.8-flash'), DEFAULT_TOKENS_PER_SECOND * OUTPUT_TIME_BUDGET_S);
});

test('速度记录:太短的不记;取偏慢的那个(不到 5 个取最慢,多了取四分之一处);上限不低于下限', () => {
  let t = 1_000_000;
  const book = createOutputSpeedBook({ now: () => t });
  assert.equal(book.record('m', { output: MIN_SAMPLE_OUTPUT_TOKENS - 1, ms: 1000 }), null, '太短不记');
  book.record('m', { output: 10000, ms: 100_000 }); // 100 token/s
  book.record('m', { output: 15000, ms: 100_000 }); // 150
  assert.equal(book.speedOf('M ').tps, 100, '不到 5 个取最慢;键不分大小写');
  assert.equal(book.capFor('m'), 25000);
  for (const tps of [190, 60, 120, 80]) book.record('m', { output: tps * 100, ms: 100_000 });
  // 60 80 100 120 150 190:四分之一处是第 2 个(80)
  assert.equal(book.speedOf('m').tps, 80);
  assert.equal(conservativeSpeed([{ tps: 50 }]), 50);
  // 很慢也不低于下限
  const slow = createOutputSpeedBook();
  slow.record('s', { output: 2000, ms: 1_000_000 });
  assert.equal(slow.capFor('s'), MIN_SPEED_CAP);
  // 太旧的样本不算
  t += 15 * 24 * 3600 * 1000;
  assert.equal(book.speedOf('m').samples, 0);
});

test('单次上限 = min(模型上限, 配置上限, 速度 × 预算):有记录、没记录、配置更小、模型上限更小', () => {
  const book = createOutputSpeedBook();
  const cap = () => book.capFor('gemini-3.8-flash');
  // 没记录:40 × 250 = 10000
  assert.equal(resolveMaxOutput({ model: 'gemini-3.8-flash', outputCap: cap }), 10000);
  // 有记录:120 token/s × 250 = 30000
  book.record('gemini-3.8-flash', { output: 12000, ms: 100_000 });
  assert.equal(resolveMaxOutput({ model: 'gemini-3.8-flash', outputCap: cap }), 30000);
  // 配置更小
  assert.equal(resolveMaxOutput({ model: 'gemini-3.8-flash', maxTokens: 20000, outputCap: cap }), 20000);
  // 模型上限更小:速度很快时 Gemini 停在 65536
  const fast = createOutputSpeedBook();
  fast.record('gemini-3.8-flash', { output: 100000, ms: 200_000 }); // 500 token/s → 125000
  assert.equal(resolveMaxOutput({ model: 'gemini-3.8-flash', outputCap: () => fast.capFor('gemini-3.8-flash') }), 65536);
  // 没给 outputCap 时与原来相同
  assert.equal(resolveMaxOutput({ model: 'gemini-3.8-flash' }), 65536);
});

test('速度记录存进文件,下一代进程(新建的那一份)读得到;同进程按文件共用一份', () => {
  const dir = tmp('speed');
  try {
    const file = path.join(dir, 'usage', 'model-speed.json');
    const a = createOutputSpeedBook({ file });
    a.record('gemini-3.8-flash', { output: 9000, ms: 100_000 });
    assert.ok(fs.existsSync(file));
    const b = createOutputSpeedBook({ file }); // 相当于任务进程新开的一代
    assert.deepEqual(b.speedOf('gemini-3.8-flash'), { tps: 90, samples: 1 });
    // 两份各记一笔,合并不丢
    b.record('gemini-3.8-flash', { output: 7000, ms: 100_000 });
    a.record('claude-sonnet-5-5', { output: 5000, ms: 100_000 });
    const c = createOutputSpeedBook({ file });
    assert.equal(c.speedOf('gemini-3.8-flash').samples, 2);
    assert.equal(c.speedOf('claude-sonnet-5-5').tps, 50);
    _resetOutputSpeedBooks();
    assert.equal(outputSpeedBookFor(file), outputSpeedBookFor(file));
    // 文件坏了也照常工作(当没有记录)
    fs.writeFileSync(file, '{坏');
    assert.equal(createOutputSpeedBook({ file }).speedOf('gemini-3.8-flash').samples, 0);
    _resetOutputSpeedBooks();
  } finally { rm(dir); }
});

test('包一层 provider:按用量(含思考)记样本;被掐断、用量没回来时按字数估', async () => {
  const book = createOutputSpeedBook();
  const p = { name: 'x', async *stream() {
    yield { type: 'response_open', sentAt: Date.now() - 50_000 };
    yield { type: 'text_delta', text: 'a' };
    yield { type: 'usage', input: 1, output: 3000, thoughts: 2000 };
    yield { type: 'stop', reason: 'stop' };
  } };
  const evs = [];
  for await (const e of withOutputSpeed(p, book, 'm').stream()) evs.push(e);
  assert.equal(evs[0].type, 'notice');
  assert.equal(evs[0].stage, 'output-speed');
  assert.equal(evs[0].data.cap, 10000);
  assert.ok(!evs.some((e) => e.type === 'response_open'), 'response_open 不往下交');
  const tps = book.speedOf('m').tps;
  assert.ok(tps > 95 && tps <= 100, `5000 token / 约 50 秒 ≈ 100 token/s,实得 ${tps}`);

  const cutBook = createOutputSpeedBook();
  const cutP = { name: 'x', async *stream() {
    yield { type: 'response_open', sentAt: Date.now() - 300_000 };
    yield { type: 'text_delta', text: 'x'.repeat(40000) };
    yield { type: 'tool_use_partial', name: 'create_card', args: 'y'.repeat(20000) };
    yield { type: 'usage', input: 0, output: 0 };
    yield { type: 'stop', reason: 'stream_cut' };
  } };
  for await (const _ of withOutputSpeed(cutP, cutBook, 'm').stream()) { /* 读完 */ }
  // 60000 字 ÷ 4 = 15000 token / 300 秒 = 50 token/s → 上限 12500
  assert.equal(cutBook.speedOf('m').tps, 50);
  assert.equal(cutBook.capFor('m'), 12500);
});

// ───────────── 端到端:本机假网关,create_card 写源码时被中途掐断 ─────────────

const { startRun } = await import('../runners/api.mjs');
const FULL_SOURCE = [
  "import { defineCard } from 'promptcut';",
  'export default defineCard({',
  "  id: 'demo-long',",
  "  render: (ctx) => ctx.text('你好，世界', { x: 10, y: 20 }),",
  '  duration: 5,',
  '});',
].join('\n');

/** 在 5990～5999 里找一个空端口起假网关(端口段由主会话分配) */
async function listenInRange(server) {
  for (let port = 5990; port <= 5999; port += 1) {
    const ok = await new Promise((resolve) => {
      const onErr = () => { server.off('listening', onOk); resolve(false); };
      const onOk = () => { server.off('error', onErr); resolve(true); };
      server.once('error', onErr); server.once('listening', onOk);
      server.listen(port, '127.0.0.1');
    });
    if (ok) return port;
  }
  throw new Error('5990～5999 没有空端口');
}

/**
 * 假网关:按 OpenAI 兼容口回 SSE。第一次请求写到 create_card 源码中途被掐断(mode 'error-event':发 error 事件后结束;'socket':直接断连接),
 * 之后几次按模型「看了提示」的样子:code_cache_append 接着写 → create_card 用引用交 → 说一句收尾。
 */
async function fakeGateway(mode) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body);
      requests.push(json);
      const n = requests.length;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const call = (name, args, id = `call_${n}`) => d({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }] });
      const finish = (reason) => `${d({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}data: [DONE]\n\n`;
      if (n === 1) {
        const whole = JSON.stringify({ id: 'demo-long', source: FULL_SOURCE });
        const half = whole.slice(0, whole.indexOf('render') + 20);
        res.write(d({ choices: [{ delta: { role: 'assistant' } }] }));
        res.write(d({ choices: [{ delta: { content: '我来建这张卡。' } }] }));
        res.write(call('create_card', half.slice(0, 30), 'call_cc'));
        res.write(d({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: half.slice(30) } }] } }] }));
        if (mode === 'socket') { setTimeout(() => res.socket.destroy(), 30); return; }
        res.end(d({ error: { message: GATEWAY_CUT, type: 'upstream_error' } }));
        return;
      }
      if (n === 2) {
        // 「模型」看到提示,知道写到哪了:接着写剩下的
        const note = JSON.stringify(json.messages.at(-1));
        const written = /写到第 \d+ 行\((\d+) 字\)/.exec(note);
        const at = written ? Number(written[1]) : 0;
        res.end(call('code_cache_append', JSON.stringify({ name: 'cut_create_card_1', text: FULL_SOURCE.slice(at) })) + finish('tool_calls'));
        return;
      }
      if (n === 3) { res.end(call('create_card', JSON.stringify({ id: 'demo-long', source: '@code_cache:cut_create_card_1' })) + finish('tool_calls')); return; }
      res.end(d({ choices: [{ delta: { content: '卡片建好了。' } }] }) + finish('stop'));
    });
  });
  const port = await listenInRange(server);
  return { port, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

function runAgainst(port, { codeCacheDir, sessionId, outputSpeedFile, retry = { maxRetries: 0 } }) {
  const events = [];
  const calls = [];
  return new Promise((resolve) => {
    startRun({
      prompt: '做一张长卡', systemPrompt: 's', sessionId,
      apiConfig: { vendor: 'openai', model: 'gemini-3.8-flash', apiKey: 'test-key-not-real', baseUrl: `http://127.0.0.1:${port}/v1` },
      codeCacheDir, outputSpeedFile, localTools: false,
      retryForTest: retry,
      callTool: async (name, args) => { calls.push({ name, args }); return name === 'list_cards' || name === 'list_parts' ? [] : { ok: true, id: args?.id }; },
      onEvent: (e) => { events.push(e); if (e.type === 'done' || e.type === 'error') setTimeout(() => resolve({ events, calls }), 10); },
    });
  });
}
const historyOf = (sid) => path.join(os.tmpdir(), 'promptcut', 'harness-sessions', `${sid}.json`);

for (const mode of ['error-event', 'socket']) {
  test(`端到端(本机假网关,${mode === 'socket' ? '直接断连接' : '流里发 error 事件'}):create_card 写源码时被网关中途掐断 → 存进代码块 → 接着写 → @code_cache: 交给 create_card,源码完整`, async () => {
    const dir = tmp(`e2e-${mode}`);
    const sid = `sc-e2e-${mode}-${Math.random().toString(36).slice(2, 8)}`;
    const gw = await fakeGateway(mode);
    try {
      const { events, calls } = await runAgainst(gw.port, { codeCacheDir: path.join(dir, 'cc'), sessionId: sid, outputSpeedFile: path.join(dir, 'model-speed.json') });
      const err = events.find((e) => e.type === 'error');
      assert.equal(err, undefined, err?.message);
      assert.equal(gw.requests.length, 4);
      // 单次上限按速度压:还没有记录,40 token/s × 250 秒 = 10000
      assert.equal(gw.requests[0].max_tokens, 10000);
      // 第二次请求里交给模型的话说的是被网关掐断
      const note = JSON.stringify(gw.requests[1].messages.at(-1));
      assert.match(note, /连接被网关中途掐断了/);
      assert.match(note, /cut_create_card_1/);
      // 掐断那次的文字留在历史里
      assert.match(JSON.stringify(gw.requests[1].messages), /我来建这张卡。/);
      const created = calls.filter((c) => c.name === 'create_card');
      assert.equal(created.length, 1, '被掐断的那次没有执行');
      assert.equal(created[0].args.source, FULL_SOURCE, '卡片源码完整');
      const status = events.filter((e) => e.type === 'status').map((e) => e.text);
      assert.ok(status.some((t) => /被网关中途掐断了（网关对单次请求有时长上限）；写了一半的 create_card（\d+ 字） 已存进代码块 cut_create_card_1/.test(t)), status.join('\n'));
      assert.ok(!status.some((t) => /超过单次输出上限/.test(t)));
      assert.ok(events.some((e) => e.type === 'diagnostic' && e.stage === 'stream-cut' && e.data.how === (mode === 'socket' ? 'connection' : 'error-event')));
      assert.ok(events.some((e) => e.type === 'diagnostic' && e.stage === 'truncated' && e.data.cause === 'cut'));
      assert.equal(events.find((e) => e.type === 'done')?.outcome, 'completed');
      assert.ok(!JSON.stringify(events).includes('test-key-not-real'), 'Key 不进事件');
    } finally { await gw.close(); rm(dir); try { fs.unlinkSync(historyOf(sid)); } catch { /* 清理 */ } }
  });
}

test('端到端:还没出数据就被网关断开的照旧报错,并标成可续跑(本机自动接着说)', async () => {
  const dir = tmp('e2e-pre');
  const sid = `sc-pre-${Math.random().toString(36).slice(2, 8)}`;
  let hits = 0;
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { hits += 1; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(d({ error: { message: GATEWAY_CUT } })); }); });
  const port = await listenInRange(server);
  try {
    // 现有的重试(retry-fetch.mjs 的首块预读)照旧:还没出内容就来的可重试 error 先重发;这里只给 1 次、退避 10 毫秒
    const { events, calls } = await runAgainst(port, { codeCacheDir: path.join(dir, 'cc'), sessionId: sid, outputSpeedFile: path.join(dir, 'model-speed.json'), retry: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 10 } });
    assert.equal(hits, 2, '先按现有重试重发一次');
    const err = events.find((e) => e.type === 'error');
    assert.ok(err);
    assert.match(err.message, /upstream stream ended/);
    assert.equal(err.retryable, true);
    assert.equal(calls.filter((c) => c.name === 'create_card').length, 0);
    assert.ok(!events.some((e) => e.type === 'diagnostic' && e.stage === 'truncated'));
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())); rm(dir); try { fs.unlinkSync(historyOf(sid)); } catch { /* 清理 */ } }
});

test('模拟 provider 的 cut 步骤:以 stream_cut 收尾,状态行说被网关掐断', async () => {
  const dir = tmp('mock-cut');
  const sid = `sc-mock-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const half = '{"id":"demo-long","source":"import x from \'y\';\\nexport default';
    const script = [
      { cut: { tool: 'create_card', args: half } },
      { tool: 'code_cache_append', input: { name: 'cut_create_card_1', text: ' 1;' } },
      { tool: 'create_card', input: { id: 'demo-long', source: '@code_cache:cut_create_card_1' } },
      { say: '好了。' },
    ];
    const events = [], calls = [];
    await new Promise((resolve) => startRun({
      prompt: `做卡\n\`\`\`mock-script\n${JSON.stringify(script)}\n\`\`\``, systemPrompt: 's', sessionId: sid,
      apiConfig: { vendor: 'mock', model: 'mock' }, codeCacheDir: dir, localTools: false,
      callTool: async (name, args) => { calls.push({ name, args }); return name === 'list_cards' || name === 'list_parts' ? [] : { ok: true }; },
      onEvent: (e) => { events.push(e); if (e.type === 'done' || e.type === 'error') setTimeout(resolve, 10); },
    }));
    assert.equal(events.find((e) => e.type === 'error'), undefined);
    assert.equal(calls.find((c) => c.name === 'create_card').args.source, "import x from 'y';\nexport default 1;");
    assert.ok(events.some((e) => e.type === 'status' && /被网关中途掐断/.test(e.text)));
  } finally { rm(dir); try { fs.unlinkSync(historyOf(sid)); } catch { /* 清理 */ } }
});
