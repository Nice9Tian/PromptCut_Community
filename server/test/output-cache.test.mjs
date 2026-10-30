/**
 * A07(2026-10-22 用户定:回复被截断时的处理):单次输出上限调大、400 降档、截断后把写了一半的参数存进代码块接着写、
 * 代码块空间的工具与 `@code_cache:` 引用。验收见 `docs/reports/AGENT-output-cache.md`。
 *
 * 全部用假模型(脚本化的 provider / 假 fetch),不调真模型。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { modelOutputLimit, resolveMaxOutput, usesMaxCompletionTokens, lowerOutputAfter400, swapOutputParamAfter400, UNKNOWN_OUTPUT_TOKENS } from '../harness/model-limits.mjs';
import { parsePartialObject, salvageToolCall } from '../harness/partial-json.mjs';
import { createCodeCacheStore, codeCacheTools, resolveCodeCacheRefs, CODE_CACHE_TOOL_NAMES } from '../tools/code-cache.mjs';
import { salvageTruncation } from '../harness/truncation.mjs';
import { Agent } from '../harness/agent.mjs';
import { buildTools } from '../harness/tools/index.mjs';
import { CLOUD_OPEN_TOOLS } from '../agent/service/cloud-tools.mjs';
import * as openai from '../harness/providers/openai.mjs';
import * as anthropic from '../harness/providers/anthropic.mjs';
import * as gemini from '../harness/providers/gemini.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `pc-oc-${p}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理 */ } };

// ───────────── 输出上限 ─────────────

test('各模型的单次输出上限:Claude 当前各型号 128K、GPT-5 系 128000、o 系 100000、Gemini 2.5 及以后 65536,认不出给保守值', () => {
  assert.equal(modelOutputLimit('claude-opus-5-5'), 128000);
  assert.equal(modelOutputLimit('claude-sonnet-4-6'), 128000);
  assert.equal(modelOutputLimit('claude-haiku-4-5-20251001'), 64000);
  assert.equal(modelOutputLimit('claude-sonnet-4-5-20250929'), 64000);
  assert.equal(modelOutputLimit('claude-opus-4-1-20250805'), 32000);
  assert.equal(modelOutputLimit('claude-opus-4-20250514'), 32000);
  assert.equal(modelOutputLimit('claude-sonnet-4-20250514'), 64000);
  assert.equal(modelOutputLimit('gpt-5'), 128000);
  assert.equal(modelOutputLimit('gpt-6.1-sol'), 128000);
  assert.equal(modelOutputLimit('openai/gpt-5.6-terra'), 128000);
  assert.equal(modelOutputLimit('o3'), 100000);
  assert.equal(modelOutputLimit('o4-mini'), 100000);
  assert.equal(modelOutputLimit('gpt-4.1'), 32768);
  assert.equal(modelOutputLimit('gpt-4o-mini'), 16384);
  assert.equal(modelOutputLimit('gemini-3.8-flash'), 65536);
  assert.equal(modelOutputLimit('gemini-2.5-pro'), 65536);
  assert.equal(modelOutputLimit('gemini-4-argon'), 65536);
  assert.equal(modelOutputLimit('gemini-2.0-flash'), 8192);
  assert.equal(modelOutputLimit('some-other-model'), null);
  assert.equal(resolveMaxOutput({ model: 'some-other-model' }), UNKNOWN_OUTPUT_TOKENS);
});

test('配置里的 maxTokens 是上限的上限;没配或等于旧缺省 4096 时按模型', () => {
  assert.equal(resolveMaxOutput({ model: 'gemini-3.8-flash' }), 65536);
  assert.equal(resolveMaxOutput({ model: 'gemini-3.8-flash', maxTokens: 4096 }), 65536, '旧缺省当没配');
  assert.equal(resolveMaxOutput({ model: 'gemini-3.8-flash', maxTokens: 0 }), 65536);
  assert.equal(resolveMaxOutput({ model: 'gemini-3.8-flash', maxTokens: 32000 }), 32000, '配得比模型小就用配的');
  assert.equal(resolveMaxOutput({ model: 'gemini-3.8-flash', maxTokens: 128000 }), 65536, '配得比模型大就用模型的');
  assert.equal(resolveMaxOutput({ model: 'claude-opus-5-5', maxTokens: 128000 }), 128000);
  assert.equal(resolveMaxOutput({ model: 'unknown-x', maxTokens: 50000 }), 50000);
  assert.equal(resolveMaxOutput({ model: 'unknown-x', maxTokens: 2000 }), 2000, '特意压小的照用');
});

test('推理模型用 max_completion_tokens;400 的话能认出「数太大」和「字段名不对」', () => {
  for (const m of ['gpt-5', 'gpt-5.6-terra', 'gpt-6-astra', 'o3', 'o4-mini', 'openai/o1']) assert.equal(usesMaxCompletionTokens(m), true, m);
  for (const m of ['gpt-4o', 'gpt-4.1', 'gemini-3.8-flash', 'claude-sonnet-5-5']) assert.equal(usesMaxCompletionTokens(m), false, m);
  assert.equal(lowerOutputAfter400('max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-x', 128000), 64000);
  assert.equal(lowerOutputAfter400("Invalid 'max_tokens': integer above maximum value. Expected a value <= 16384, but got 128000 instead.", 128000), 16384);
  assert.equal(lowerOutputAfter400('max_tokens is too large', 128000), 100000, '没写上限就取下一档');
  assert.equal(lowerOutputAfter400('Invalid API key', 128000), null);
  assert.equal(swapOutputParamAfter400("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", 'max_tokens'), 'max_completion_tokens');
  assert.equal(swapOutputParamAfter400('Unrecognized request argument supplied: max_completion_tokens', 'max_completion_tokens'), 'max_tokens');
  assert.equal(swapOutputParamAfter400('max_tokens is too large', 'max_tokens'), null);
});

// 假 SSE
const sse = (chunks) => ({ ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: (async function* () { for (const c of chunks) yield c; })() });
const errRes = (status, message) => ({ ok: false, status, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message } }) });
const openaiDone = (text = '好') => sse([
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
  'data: [DONE]\n\n',
]);
async function drain(provider, tools = []) {
  const out = [];
  for await (const ev of provider.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools, 'sys', undefined)) out.push(ev);
  return out;
}
function recorder(responses) {
  const sent = [];
  let n = 0;
  const fetchImpl = async (_url, init) => { sent.push(JSON.parse(init.body)); const r = responses[Math.min(n, responses.length - 1)]; n += 1; return typeof r === 'function' ? r() : r; };
  return { sent, fetchImpl };
}

test('OpenAI 兼容口:普通模型发 max_tokens = 模型上限;推理模型只发 max_completion_tokens', async () => {
  let r = recorder([openaiDone()]);
  await drain(openai.createProvider({ apiKey: 'k', model: 'gemini-3.8-flash', baseUrl: 'https://x/v1', maxTokens: 4096 }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent[0].max_tokens, 65536);
  assert.equal('max_completion_tokens' in r.sent[0], false);
  r = recorder([openaiDone()]);
  await drain(openai.createProvider({ apiKey: 'k', model: 'gpt-5', baseUrl: 'https://x/v1' }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent[0].max_completion_tokens, 128000);
  assert.equal('max_tokens' in r.sent[0], false, '两个字段不同时带');
});

test('OpenAI 兼容口:数太大回 400 → 降一档重发一次、交一条日志事件;再 400 就照常报错,不再重发', async () => {
  let r = recorder([errRes(400, 'max_tokens is too large: 65536. This model supports at most 32768 completion tokens.'), openaiDone('成')]);
  const evs = await drain(openai.createProvider({ apiKey: 'k', model: 'gemini-3.8-flash', baseUrl: 'https://x/v1' }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].max_tokens, 32768);
  const notice = evs.find((e) => e.type === 'notice');
  assert.deepEqual({ action: notice.data.action, from: notice.data.from, to: notice.data.to }, { action: 'lower', from: 65536, to: 32768 });
  assert.ok(evs.some((e) => e.type === 'text_delta' && e.text === '成'));

  r = recorder([errRes(400, 'max_tokens is too large'), errRes(400, 'max_tokens is too large')]);
  await assert.rejects(drain(openai.createProvider({ apiKey: 'k', model: 'gemini-3.8-flash', baseUrl: 'https://x/v1' }, { fetchImpl: r.fetchImpl })), /HTTP 400/);
  assert.equal(r.sent.length, 2, '只降一次');
});

test('OpenAI 兼容口:上游说字段名不对就换另一个字段重发一次', async () => {
  const r = recorder([errRes(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."), openaiDone()]);
  await drain(openai.createProvider({ apiKey: 'k', model: 'gpt-4o', baseUrl: 'https://x/v1' }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].max_completion_tokens, 16384);
  assert.equal('max_tokens' in r.sent[1], false);
});

test('OpenAI 兼容口:写到上限(length)时没写完的工具调用交成 tool_use_partial,带收到的参数原文;写完的照常交', async () => {
  const args = '{"id":"demo","source":"export default {\\n  name: \\"x\\",';
  const r = recorder([sse([
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'add_clip', arguments: '{"cardId":"t"}' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'create_card', arguments: args.slice(0, 20) } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: args.slice(20) } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 9 } })}\n\n`,
    'data: [DONE]\n\n',
  ])]);
  const evs = await drain(openai.createProvider({ apiKey: 'k', model: 'gemini-3.8-flash', baseUrl: 'https://x/v1' }, { fetchImpl: r.fetchImpl }));
  assert.deepEqual(evs.filter((e) => e.type === 'tool_use').map((e) => e.name), ['add_clip']);
  const partial = evs.find((e) => e.type === 'tool_use_partial');
  assert.equal(partial.name, 'create_card');
  assert.equal(partial.args, args);
  assert.equal(evs.at(-1).reason, 'length');
});

const anthropicStream = (events) => sse(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

test('Anthropic:max_tokens 按模型(Opus 5.5 是 128000);数太大回 400 按报错里的上限降一次', async () => {
  const done = () => anthropicStream([['message_start', { message: { usage: { input_tokens: 1 } } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: '好' } }], ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', {}]]);
  let r = recorder([done()]);
  await drain(anthropic.createProvider({ apiKey: 'k', model: 'claude-opus-5-5' }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent[0].max_tokens, 128000);
  r = recorder([errRes(400, 'max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-future'), done()]);
  const evs = await drain(anthropic.createProvider({ apiKey: 'k', model: 'claude-opus-5-5' }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent[1].max_tokens, 64000);
  assert.ok(evs.some((e) => e.type === 'notice' && e.data.to === 64000));
});

test('Anthropic:max_tokens 截断时没写完的 tool_use 交成 tool_use_partial;不是截断的坏 JSON 照旧报参数错误', async () => {
  const mk = (stop) => anthropicStream([
    ['message_start', { message: { usage: { input_tokens: 1 } } }],
    ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't1', name: 'create_card' } }],
    ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"id":"d","source":"line1\\nli' } }],
    ['content_block_stop', { index: 0 }],
    ['message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: 5 } }],
    ['message_stop', {}],
  ]);
  let evs = await drain(anthropic.createProvider({ apiKey: 'k', model: 'claude-opus-5-5' }, { fetchImpl: recorder([mk('max_tokens')]).fetchImpl }));
  const p = evs.find((e) => e.type === 'tool_use_partial');
  assert.equal(p.name, 'create_card'); assert.equal(p.args, '{"id":"d","source":"line1\\nli');
  evs = await drain(anthropic.createProvider({ apiKey: 'k', model: 'claude-opus-5-5' }, { fetchImpl: recorder([mk('tool_use')]).fetchImpl }));
  assert.ok(evs.some((e) => e.type === 'tool_use' && e.inputError));
  assert.equal(evs.some((e) => e.type === 'tool_use_partial'), false);
});

test('Gemini:maxOutputTokens 按模型;400 数太大降一档重发一次', async () => {
  const done = () => sse([`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '好' }] }, finishReason: 'STOP' }] })}\n\n`]);
  let r = recorder([done()]);
  await drain(gemini.createProvider({ apiKey: 'k', model: 'gemini-3.8-flash' }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent[0].generationConfig.maxOutputTokens, 65536);
  r = recorder([errRes(400, 'The specified maxOutputTokens value 65536 is out of range; the maximum is 32768.'), done()]);
  await drain(gemini.createProvider({ apiKey: 'k', model: 'gemini-3.8-flash' }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].generationConfig.maxOutputTokens, 32768);
});

// ───────────── 半截 JSON ─────────────

test('从半截 JSON 里取出写了一半的长字符串字段和已经写完的短字段', () => {
  const s = salvageToolCall('{"id":"price-tag","overwrite":true,"source":"const a = \\"x\\";\\nconst b = 1;\\nexport default {\\n  na');
  assert.equal(s.key, 'source');
  assert.equal(s.text, 'const a = "x";\nconst b = 1;\nexport default {\n  na');
  assert.equal(s.complete, false);
  assert.deepEqual(s.rest, { id: 'price-tag', overwrite: true });
  // 转义写到一半的那一截丢掉
  assert.equal(salvageToolCall('{"source":"ab\\').text, 'ab');
  assert.equal(salvageToolCall('{"source":"ab\\u00').text, 'ab');
  assert.equal(salvageToolCall('{"source":"\\u4e2d\\u6587').text, '中文');
  assert.deepEqual(parsePartialObject('{"a":{"b":[1,2]},"c":"d"').fields.map((f) => f.key), ['a', 'c']);
  assert.equal(salvageToolCall('').key, null);
  assert.equal(salvageToolCall('{"id":"x"').text, 'x', '只有短字段时取它(没写完的工具多半也就这样)');
  const s2 = salvageToolCall('{"id":"a-very-long-card-identifier","source":"imp');
  assert.equal(s2.key, 'source', '写到一半的那个字段优先,哪怕它比前面的短');
  assert.equal(s2.text, 'imp');
});

// ───────────── 代码块空间 ─────────────

test('代码块工具:写入、追加、按行/按字符读、替换、列出、删除;名字不合法和超上限都明说', async () => {
  const dir = tmp('cc');
  try {
    const store = createCodeCacheStore({ dir, writer: 'conv-1' });
    const t = Object.fromEntries(codeCacheTools(store).map((x) => [x.name, x]));
    assert.deepEqual(Object.keys(t).sort(), [...CODE_CACHE_TOOL_NAMES].sort());
    await t.code_cache_write.execute({ name: 'card', text: 'line1\nline2\n' });
    const ap = await t.code_cache_append.execute({ name: 'card', text: 'line3\nline4' });
    assert.equal(ap.lines, 4); assert.match(ap.tail, /line4$/);
    assert.equal((await t.code_cache_read.execute({ name: 'card' })).text, 'line1\nline2\nline3\nline4');
    assert.equal((await t.code_cache_read.execute({ name: 'card', startLine: 2, endLine: 3 })).text, 'line2\nline3');
    assert.equal((await t.code_cache_read.execute({ name: 'card', start: 6, end: 11 })).text, 'line2');
    const rep = await t.code_cache_replace.execute({ name: 'card', old: 'line3', new: 'LINE-3' });
    assert.equal(rep.replaced, 1);
    await assert.rejects(t.code_cache_replace.execute({ name: 'card', old: 'line', new: 'x' }), /出现了 3 次/);
    assert.equal((await t.code_cache_replace.execute({ name: 'card', old: 'line', new: 'L', all: true })).replaced, 3);
    await assert.rejects(t.code_cache_replace.execute({ name: 'card', old: 'nope', new: 'x' }), /没有找到/);
    const list = await t.code_cache_list.execute({});
    assert.equal(list.blocks.length, 1); assert.equal(list.blocks[0].name, 'card'); assert.equal(list.blocks[0].by, 'conv-1');
    await assert.rejects(t.code_cache_write.execute({ name: '../x', text: 'a' }), /名字不合法/);
    await assert.rejects(t.code_cache_read.execute({ name: 'missing' }), /不存在/);
    const small = createCodeCacheStore({ dir, limits: { blockBytes: 10 } });
    assert.throws(() => small.write('big', 'x'.repeat(11)), /超过一块的上限/);
    await t.code_cache_delete.execute({ name: 'card' });
    assert.equal((await t.code_cache_list.execute({})).blocks.length, 0);
    // 读的时候一次最多交回 readChars 字,告诉下一段从哪开始
    const tiny = createCodeCacheStore({ dir, limits: { readChars: 4 } });
    tiny.write('long', 'abcdefghij');
    const rd = await codeCacheTools(tiny).find((x) => x.name === 'code_cache_read').execute({ name: 'long' });
    assert.equal(rd.text, 'abcd'); assert.match(rd.more, /start=4/);
  } finally { rm(dir); }
});

test('@code_cache:名字 只在整个字符串就是这个写法时换成内容;不存在就报错', () => {
  const dir = tmp('ref');
  try {
    const store = createCodeCacheStore({ dir });
    store.write('src', 'FULL SOURCE');
    const input = { id: 'x', source: '@code_cache:src', nested: { list: ['@code_cache:src', 'keep @code_cache:src inline'] } };
    const out = resolveCodeCacheRefs(input, store);
    assert.equal(out.source, 'FULL SOURCE');
    assert.equal(out.nested.list[0], 'FULL SOURCE');
    assert.equal(out.nested.list[1], 'keep @code_cache:src inline');
    assert.equal(input.source, '@code_cache:src', '不改原来的对象');
    assert.equal(resolveCodeCacheRefs({ a: 1 }, store).a, 1);
    assert.throws(() => resolveCodeCacheRefs({ s: '@code_cache:nope' }, store), /不存在/);
  } finally { rm(dir); }
});

test('Agent 在调用工具之前把引用换成内容;历史与事件里留的是引用', async () => {
  const dir = tmp('agent-ref');
  try {
    const store = createCodeCacheStore({ dir });
    store.write('src', 'X'.repeat(5000));
    let got = null;
    const tool = { name: 'create_card', description: 'x', inputSchema: { type: 'object', properties: { id: { type: 'string' }, source: { type: 'string' } }, required: ['id', 'source'] }, async execute(input) { got = input; return { ok: true }; } };
    let n = 0;
    const provider = { name: 'f', async *stream() { n += 1; if (n === 1) { yield { type: 'tool_use', id: 'c1', name: 'create_card', input: { id: 'a', source: '@code_cache:src' } }; yield { type: 'stop', reason: 'tool_use' }; } else { yield { type: 'text_delta', text: '好了' }; yield { type: 'stop', reason: 'end_turn' }; } } };
    const events = [];
    const agent = new Agent({ provider, system: 's', tools: [tool], codeCache: store, onEvent: (e) => events.push(e) });
    await agent.run('建卡');
    assert.equal(got.source.length, 5000);
    assert.equal(events.find((e) => e.type === 'tool_call').input.source, '@code_cache:src');
    assert.ok(JSON.stringify(agent.history.get()).includes('@code_cache:src'));
    assert.equal(JSON.stringify(agent.history.get()).includes('X'.repeat(5000)), false);
  } finally { rm(dir); }
});

test('截断时写了一半的参数存进代码块;本来就在追加代码块的,写出的那一截直接接上', () => {
  const dir = tmp('salv');
  try {
    const store = createCodeCacheStore({ dir });
    const s = salvageTruncation([{ name: 'create_card', args: '{"id":"demo","source":"line1\\nline2\\nli' }], store);
    assert.equal(s.progress, true);
    assert.equal(s.saved[0].block, 'cut_create_card_1');
    assert.equal(store.read('cut_create_card_1'), 'line1\nline2\nli');
    assert.match(s.note, /code_cache_append/); assert.match(s.note, /@code_cache:cut_create_card_1/); assert.match(s.note, /"id":"demo"/);
    assert.match(s.status, /已存进代码块 cut_create_card_1/);
    const d = salvageTruncation([{ name: 'code_cache_append', args: '{"name":"cut_create_card_1","text":"ne3\\nline4' }], store);
    assert.equal(d.saved[0].direct, true);
    assert.equal(store.read('cut_create_card_1'), 'line1\nline2\nline3\nline4');
    const none = salvageTruncation([{ name: 'create_card', args: '{"i' }], store);
    assert.equal(none.progress, false);
    const noStore = salvageTruncation([{ name: 'create_card', args: '{"source":"abc' }], null);
    assert.equal(noStore.progress, false);
  } finally { rm(dir); }
});

test('工具清单:本机与云端(托管档开放清单)都有代码块的六个工具', async () => {
  const dir = tmp('list');
  try {
    const codeCache = createCodeCacheStore({ dir });
    const cloud = (await buildTools({ callTool: async () => [], workspaceDir: null, only: CLOUD_OPEN_TOOLS, localTools: false, codeCache })).map((t) => t.name);
    const local = (await buildTools({ callTool: async () => [], workspaceDir: dir, codeCache })).map((t) => t.name);
    for (const n of CODE_CACHE_TOOL_NAMES) { assert.ok(cloud.includes(n), `云端缺 ${n}`); assert.ok(local.includes(n), `本机缺 ${n}`); }
  } finally { rm(dir); }
});

// ───────────── 端到端:假模型,第一轮在 create_card 的源码中途被截断 ─────────────

const { startRun } = await import('../runners/api.mjs');
const FULL_SOURCE = [
  "import { defineCard } from 'promptcut';",
  'export default defineCard({',
  "  id: 'demo-long',",
  "  render: (ctx) => ctx.text('你好，世界', { x: 10, y: 20 }),",
  '});',
].join('\n');
const CUT = 70;

function runMock(script, { codeCacheDir, sessionId }) {
  const events = [];
  const calls = [];
  return new Promise((resolve) => {
    startRun({
      prompt: `做一张长卡\n\`\`\`mock-script\n${JSON.stringify(script)}\n\`\`\``, systemPrompt: 's', sessionId,
      apiConfig: { vendor: 'mock', model: 'mock' }, codeCacheDir, localTools: false,
      callTool: async (name, args) => { calls.push({ name, args }); return name === 'list_cards' || name === 'list_parts' ? [] : { ok: true, id: args?.id }; },
      onEvent: (ev) => { events.push(ev); if (ev.type === 'done' || ev.type === 'error') setTimeout(() => resolve({ events, calls }), 10); },
    });
  });
}
const historyOf = (sid) => path.join(os.tmpdir(), 'promptcut', 'harness-sessions', `${sid}.json`);

test('端到端:create_card 源码写到一半被截断 → 存进代码块 → 模型追加剩下的 → 引用交给 create_card,卡片源码完整', async () => {
  const dir = tmp('e2e');
  const sid = `oc-e2e-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const half = JSON.stringify({ id: 'demo-long', source: FULL_SOURCE }).slice(0, JSON.stringify({ id: 'demo-long', source: '' }).length - 2 + CUT);
    const written = salvageToolCall(half).text;
    assert.ok(written.length > 10 && written.length < FULL_SOURCE.length, '脚本里的截断点在源码中间');
    const script = [
      { truncate: { tool: 'create_card', args: half } },
      { tool: 'code_cache_append', input: { name: 'cut_create_card_1', text: FULL_SOURCE.slice(written.length) } },
      { tool: 'create_card', input: { id: 'demo-long', source: '@code_cache:cut_create_card_1' } },
      { say: '卡片建好了。' },
    ];
    const { events, calls } = await runMock(script, { codeCacheDir: dir, sessionId: sid });
    const err = events.find((e) => e.type === 'error');
    assert.equal(err, undefined, err?.message);
    const created = calls.filter((c) => c.name === 'create_card');
    assert.equal(created.length, 1, '截断的那次没有执行,只有最后一次');
    assert.equal(created[0].args.source, FULL_SOURCE, '交给 create_card 的源码完整');
    assert.ok(events.some((e) => e.type === 'status' && /已存进代码块 cut_create_card_1/.test(e.text)));
    assert.ok(events.some((e) => e.type === 'diagnostic' && e.stage === 'truncated'));
    assert.equal(events.find((e) => e.type === 'done')?.outcome, 'completed');
    // 代码块按宿主给的目录放(本机按项目、云端按项目)
    assert.ok(fs.existsSync(path.join(dir, 'cut_create_card_1.txt')));
  } finally { rm(dir); try { fs.unlinkSync(historyOf(sid)); } catch { /* 清理 */ } }
});

test('端到端:截断次数超限照样明说没做成,并说已写出的部分存在哪个代码块', async () => {
  const dir = tmp('e2e-limit');
  const sid = `oc-lim-${Math.random().toString(36).slice(2, 8)}`;
  try {
    // 每次都在 create_card 源码中途截断、每次都留下内容:有进展的截断一轮最多 6 次,第 7 次明说没做成
    const step = { truncate: { tool: 'create_card', args: '{"id":"x","source":"abc' } };
    const { events, calls } = await runMock(Array(10).fill(step), { codeCacheDir: dir, sessionId: sid });
    const err = events.find((e) => e.type === 'error');
    assert.ok(err, '要以错误结束');
    assert.match(err.message, /超过单次输出上限被截断，这一轮没能完成/);
    assert.match(err.message, /已经写出的部分存在代码块 cut_create_card_1/);
    assert.equal(calls.filter((c) => c.name === 'create_card').length, 0);
    // 一次都没留下内容的截断:连续 3 次就停
    const sid2 = `${sid}-b`;
    const r2 = await runMock(Array(10).fill({ truncate: { say: '草稿……' } }), { codeCacheDir: dir, sessionId: sid2 });
    assert.match(r2.events.find((e) => e.type === 'error')?.message ?? '', /连续 3 次超过单次输出上限被截断/);
    try { fs.unlinkSync(historyOf(sid2)); } catch { /* 清理 */ }
  } finally { rm(dir); try { fs.unlinkSync(historyOf(sid)); } catch { /* 清理 */ } }
});
