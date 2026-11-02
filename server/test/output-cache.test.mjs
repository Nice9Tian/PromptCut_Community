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

test('per-model single-response output limits: all current Claude models 128K, GPT-5 family 128000, o family 100000, Gemini 2.5 and later 65536, and a conservative value for unrecognized models', () => {
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

test('maxTokens in the config is the cap on the cap; when unset or equal to the old default 4096, the model\'s limit applies', () => {
  assert.equal(resolveMaxOutput({ model: 'gemini-3.8-flash' }), 65536);
  assert.equal(resolveMaxOutput({ model: 'gemini-3.8-flash', maxTokens: 4096 }), 65536, 'the old default counts as unset');
  assert.equal(resolveMaxOutput({ model: 'gemini-3.8-flash', maxTokens: 0 }), 65536);
  assert.equal(resolveMaxOutput({ model: 'gemini-3.8-flash', maxTokens: 32000 }), 32000, 'if configured lower than the model\'s limit, the configured value is used');
  assert.equal(resolveMaxOutput({ model: 'gemini-3.8-flash', maxTokens: 128000 }), 65536, 'if configured higher than the model\'s limit, the model\'s limit is used');
  assert.equal(resolveMaxOutput({ model: 'claude-opus-5-5', maxTokens: 128000 }), 128000);
  assert.equal(resolveMaxOutput({ model: 'unknown-x', maxTokens: 50000 }), 50000);
  assert.equal(resolveMaxOutput({ model: 'unknown-x', maxTokens: 2000 }), 2000, 'a deliberately lowered value is used as is');
});

test('reasoning models use max_completion_tokens; on a 400 it can tell "number too large" from "wrong field name"', () => {
  for (const m of ['gpt-5', 'gpt-5.6-terra', 'gpt-6-astra', 'o3', 'o4-mini', 'openai/o1']) assert.equal(usesMaxCompletionTokens(m), true, m);
  for (const m of ['gpt-4o', 'gpt-4.1', 'gemini-3.8-flash', 'claude-sonnet-5-5']) assert.equal(usesMaxCompletionTokens(m), false, m);
  assert.equal(lowerOutputAfter400('max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-x', 128000), 64000);
  assert.equal(lowerOutputAfter400("Invalid 'max_tokens': integer above maximum value. Expected a value <= 16384, but got 128000 instead.", 128000), 16384);
  assert.equal(lowerOutputAfter400('max_tokens is too large', 128000), 100000, 'if no limit is stated, take the next lower tier');
  assert.equal(lowerOutputAfter400('Invalid API key', 128000), null);
  assert.equal(swapOutputParamAfter400("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", 'max_tokens'), 'max_completion_tokens');
  assert.equal(swapOutputParamAfter400('Unrecognized request argument supplied: max_completion_tokens', 'max_completion_tokens'), 'max_tokens');
  assert.equal(swapOutputParamAfter400('max_tokens is too large', 'max_tokens'), null);
});

// 假 SSE
const sse = (chunks) => ({ ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: (async function* () { for (const c of chunks) yield c; })() });
const errRes = (status, message) => ({ ok: false, status, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message } }) });
const openaiDone = (text = 'OK') => sse([
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

test('OpenAI-compatible endpoint: normal models send max_tokens = the model\'s limit; reasoning models send only max_completion_tokens', async () => {
  let r = recorder([openaiDone()]);
  await drain(openai.createProvider({ apiKey: 'k', model: 'gemini-3.8-flash', baseUrl: 'https://x/v1', maxTokens: 4096 }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent[0].max_tokens, 65536);
  assert.equal('max_completion_tokens' in r.sent[0], false);
  r = recorder([openaiDone()]);
  await drain(openai.createProvider({ apiKey: 'k', model: 'gpt-5', baseUrl: 'https://x/v1' }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent[0].max_completion_tokens, 128000);
  assert.equal('max_tokens' in r.sent[0], false, 'the two fields are never sent together');
});

test('OpenAI-compatible endpoint: a 400 for a number that is too large → drop one tier and resend once, emit one log event; a second 400 is reported as usual, with no more resends', async () => {
  let r = recorder([errRes(400, 'max_tokens is too large: 65536. This model supports at most 32768 completion tokens.'), openaiDone('Done')]);
  const evs = await drain(openai.createProvider({ apiKey: 'k', model: 'gemini-3.8-flash', baseUrl: 'https://x/v1' }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].max_tokens, 32768);
  const notice = evs.find((e) => e.type === 'notice');
  assert.deepEqual({ action: notice.data.action, from: notice.data.from, to: notice.data.to }, { action: 'lower', from: 65536, to: 32768 });
  assert.ok(evs.some((e) => e.type === 'text_delta' && e.text === 'Done'));

  r = recorder([errRes(400, 'max_tokens is too large'), errRes(400, 'max_tokens is too large')]);
  await assert.rejects(drain(openai.createProvider({ apiKey: 'k', model: 'gemini-3.8-flash', baseUrl: 'https://x/v1' }, { fetchImpl: r.fetchImpl })), /HTTP 400/);
  assert.equal(r.sent.length, 2, 'downgrade only once');
});

test('OpenAI-compatible endpoint: if the upstream says the field name is wrong, switch to the other field and resend once', async () => {
  const r = recorder([errRes(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."), openaiDone()]);
  await drain(openai.createProvider({ apiKey: 'k', model: 'gpt-4o', baseUrl: 'https://x/v1' }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].max_completion_tokens, 16384);
  assert.equal('max_tokens' in r.sent[1], false);
});

test('OpenAI-compatible endpoint: when output hits the limit (length), an unfinished tool call is delivered as tool_use_partial carrying the raw arguments received; finished ones are delivered as usual', async () => {
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

test('Anthropic: max_tokens follows the model (Opus 5.5 is 128000); a 400 for a number that is too large drops it once to the limit stated in the error', async () => {
  const done = () => anthropicStream([['message_start', { message: { usage: { input_tokens: 1 } } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } }], ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', {}]]);
  let r = recorder([done()]);
  await drain(anthropic.createProvider({ apiKey: 'k', model: 'claude-opus-5-5' }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent[0].max_tokens, 128000);
  r = recorder([errRes(400, 'max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-future'), done()]);
  const evs = await drain(anthropic.createProvider({ apiKey: 'k', model: 'claude-opus-5-5' }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent[1].max_tokens, 64000);
  assert.ok(evs.some((e) => e.type === 'notice' && e.data.to === 64000));
});

test('Anthropic: when max_tokens truncates, an unfinished tool_use is delivered as tool_use_partial; bad JSON that is not from truncation still reports an argument error', async () => {
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

test('Gemini: maxOutputTokens follows the model; on a 400 for a number that is too large, drop one tier and resend once', async () => {
  const done = () => sse([`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] })}\n\n`]);
  let r = recorder([done()]);
  await drain(gemini.createProvider({ apiKey: 'k', model: 'gemini-3.8-flash' }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent[0].generationConfig.maxOutputTokens, 65536);
  r = recorder([errRes(400, 'The specified maxOutputTokens value 65536 is out of range; the maximum is 32768.'), done()]);
  await drain(gemini.createProvider({ apiKey: 'k', model: 'gemini-3.8-flash' }, { fetchImpl: r.fetchImpl }));
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].generationConfig.maxOutputTokens, 32768);
});

// ───────────── 半截 JSON ─────────────

test('extracts the half-written long string field and the already completed short fields from a partial JSON', () => {
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
  assert.equal(salvageToolCall('{"id":"x"').text, 'x', 'when there is only a short field, take it (an unfinished tool mostly looks like this)');
  const s2 = salvageToolCall('{"id":"a-very-long-card-identifier","source":"imp');
  assert.equal(s2.key, 'source', 'the field that was cut off mid-write takes priority, even if it is shorter than the earlier ones');
  assert.equal(s2.text, 'imp');
});

// ───────────── 代码块空间 ─────────────

test('code block tools: write, append, read by line / by character, replace, list, delete; invalid names and exceeding the limit are both stated explicitly', async () => {
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
    await assert.rejects(t.code_cache_replace.execute({ name: 'card', old: 'line', new: 'x' }), /occurs 3 times/);
    assert.equal((await t.code_cache_replace.execute({ name: 'card', old: 'line', new: 'L', all: true })).replaced, 3);
    await assert.rejects(t.code_cache_replace.execute({ name: 'card', old: 'nope', new: 'x' }), /Could not find the original text old/);
    const list = await t.code_cache_list.execute({});
    assert.equal(list.blocks.length, 1); assert.equal(list.blocks[0].name, 'card'); assert.equal(list.blocks[0].by, 'conv-1');
    await assert.rejects(t.code_cache_write.execute({ name: '../x', text: 'a' }), /Invalid code block name/);
    await assert.rejects(t.code_cache_read.execute({ name: 'missing' }), /does not exist/);
    const small = createCodeCacheStore({ dir, limits: { blockBytes: 10 } });
    assert.throws(() => small.write('big', 'x'.repeat(11)), /over the per-block limit/);
    await t.code_cache_delete.execute({ name: 'card' });
    assert.equal((await t.code_cache_list.execute({})).blocks.length, 0);
    // 读的时候一次最多交回 readChars 字,告诉下一段从哪开始
    const tiny = createCodeCacheStore({ dir, limits: { readChars: 4 } });
    tiny.write('long', 'abcdefghij');
    const rd = await codeCacheTools(tiny).find((x) => x.name === 'code_cache_read').execute({ name: 'long' });
    assert.equal(rd.text, 'abcd'); assert.match(rd.more, /start=4/);
  } finally { rm(dir); }
});

test('@code_cache:name is replaced with its content only when the whole string is exactly this form; a missing one is an error', () => {
  const dir = tmp('ref');
  try {
    const store = createCodeCacheStore({ dir });
    store.write('src', 'FULL SOURCE');
    const input = { id: 'x', source: '@code_cache:src', nested: { list: ['@code_cache:src', 'keep @code_cache:src inline'] } };
    const out = resolveCodeCacheRefs(input, store);
    assert.equal(out.source, 'FULL SOURCE');
    assert.equal(out.nested.list[0], 'FULL SOURCE');
    assert.equal(out.nested.list[1], 'keep @code_cache:src inline');
    assert.equal(input.source, '@code_cache:src', 'the original object is not modified');
    assert.equal(resolveCodeCacheRefs({ a: 1 }, store).a, 1);
    assert.throws(() => resolveCodeCacheRefs({ s: '@code_cache:nope' }, store), /does not exist/);
  } finally { rm(dir); }
});

test('the Agent replaces the reference with its content before calling the tool; the history and events keep the reference', async () => {
  const dir = tmp('agent-ref');
  try {
    const store = createCodeCacheStore({ dir });
    store.write('src', 'X'.repeat(5000));
    let got = null;
    const tool = { name: 'create_card', description: 'x', inputSchema: { type: 'object', properties: { id: { type: 'string' }, source: { type: 'string' } }, required: ['id', 'source'] }, async execute(input) { got = input; return { ok: true }; } };
    let n = 0;
    const provider = { name: 'f', async *stream() { n += 1; if (n === 1) { yield { type: 'tool_use', id: 'c1', name: 'create_card', input: { id: 'a', source: '@code_cache:src' } }; yield { type: 'stop', reason: 'tool_use' }; } else { yield { type: 'text_delta', text: 'Done' }; yield { type: 'stop', reason: 'end_turn' }; } } };
    const events = [];
    const agent = new Agent({ provider, system: 's', tools: [tool], codeCache: store, onEvent: (e) => events.push(e) });
    await agent.run('Create a card');
    assert.equal(got.source.length, 5000);
    assert.equal(events.find((e) => e.type === 'tool_call').input.source, '@code_cache:src');
    assert.ok(JSON.stringify(agent.history.get()).includes('@code_cache:src'));
    assert.equal(JSON.stringify(agent.history.get()).includes('X'.repeat(5000)), false);
  } finally { rm(dir); }
});

test('on truncation the half-written arguments are saved into a code block; if a code block was already being appended to, the portion just written is appended directly', () => {
  const dir = tmp('salv');
  try {
    const store = createCodeCacheStore({ dir });
    const s = salvageTruncation([{ name: 'create_card', args: '{"id":"demo","source":"line1\\nline2\\nli' }], store);
    assert.equal(s.progress, true);
    assert.equal(s.saved[0].block, 'cut_create_card_1');
    assert.equal(store.read('cut_create_card_1'), 'line1\nline2\nli');
    assert.match(s.note, /code_cache_append/); assert.match(s.note, /@code_cache:cut_create_card_1/); assert.match(s.note, /"id":"demo"/);
    assert.match(s.status, /saved into code block cut_create_card_1/);
    const d = salvageTruncation([{ name: 'code_cache_append', args: '{"name":"cut_create_card_1","text":"ne3\\nline4' }], store);
    assert.equal(d.saved[0].direct, true);
    assert.equal(store.read('cut_create_card_1'), 'line1\nline2\nline3\nline4');
    const none = salvageTruncation([{ name: 'create_card', args: '{"i' }], store);
    assert.equal(none.progress, false);
    const noStore = salvageTruncation([{ name: 'create_card', args: '{"source":"abc' }], null);
    assert.equal(noStore.progress, false);
  } finally { rm(dir); }
});

test('tool list: both local and cloud (the hosted tier\'s open list) have the six code block tools', async () => {
  const dir = tmp('list');
  try {
    const codeCache = createCodeCacheStore({ dir });
    const cloud = (await buildTools({ callTool: async () => [], workspaceDir: null, only: CLOUD_OPEN_TOOLS, localTools: false, codeCache })).map((t) => t.name);
    const local = (await buildTools({ callTool: async () => [], workspaceDir: dir, codeCache })).map((t) => t.name);
    for (const n of CODE_CACHE_TOOL_NAMES) { assert.ok(cloud.includes(n), `cloud is missing ${n}`); assert.ok(local.includes(n), `local is missing ${n}`); }
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
      prompt: `Make a long card\n\`\`\`mock-script\n${JSON.stringify(script)}\n\`\`\``, systemPrompt: 's', sessionId,
      apiConfig: { vendor: 'mock', model: 'mock' }, codeCacheDir, localTools: false,
      callTool: async (name, args) => { calls.push({ name, args }); return name === 'list_cards' || name === 'list_parts' ? [] : { ok: true, id: args?.id }; },
      onEvent: (ev) => { events.push(ev); if (ev.type === 'done' || ev.type === 'error') setTimeout(() => resolve({ events, calls }), 10); },
    });
  });
}
const historyOf = (sid) => path.join(os.tmpdir(), 'promptcut', 'harness-sessions', `${sid}.json`);

test('end to end: create_card source is truncated halfway → saved into a code block → the model appends the rest → the reference is handed to create_card, and the card source is complete', async () => {
  const dir = tmp('e2e');
  const sid = `oc-e2e-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const half = JSON.stringify({ id: 'demo-long', source: FULL_SOURCE }).slice(0, JSON.stringify({ id: 'demo-long', source: '' }).length - 2 + CUT);
    const written = salvageToolCall(half).text;
    assert.ok(written.length > 10 && written.length < FULL_SOURCE.length, 'the truncation point in the script is in the middle of the source');
    const script = [
      { truncate: { tool: 'create_card', args: half } },
      { tool: 'code_cache_append', input: { name: 'cut_create_card_1', text: FULL_SOURCE.slice(written.length) } },
      { tool: 'create_card', input: { id: 'demo-long', source: '@code_cache:cut_create_card_1' } },
      { say: 'The card has been created.' },
    ];
    const { events, calls } = await runMock(script, { codeCacheDir: dir, sessionId: sid });
    const err = events.find((e) => e.type === 'error');
    assert.equal(err, undefined, err?.message);
    const created = calls.filter((c) => c.name === 'create_card');
    assert.equal(created.length, 1, 'the truncated attempt was not executed, only the last one');
    assert.equal(created[0].args.source, FULL_SOURCE, 'the source handed to create_card is complete');
    assert.ok(events.some((e) => e.type === 'status' && /saved into code block cut_create_card_1/.test(e.text)));
    assert.ok(events.some((e) => e.type === 'diagnostic' && e.stage === 'truncated'));
    assert.equal(events.find((e) => e.type === 'done')?.outcome, 'completed');
    // 代码块按宿主给的目录放(本机按项目、云端按项目)
    assert.ok(fs.existsSync(path.join(dir, 'cut_create_card_1.txt')));
  } finally { rm(dir); try { fs.unlinkSync(historyOf(sid)); } catch { /* 清理 */ } }
});

test('end to end: when the truncation count exceeds the limit it still says plainly that it did not succeed, and says which code block holds the part already written', async () => {
  const dir = tmp('e2e-limit');
  const sid = `oc-lim-${Math.random().toString(36).slice(2, 8)}`;
  try {
    // 每次都在 create_card 源码中途截断、每次都留下内容:有进展的截断一轮最多 6 次,第 7 次明说没做成
    const step = { truncate: { tool: 'create_card', args: '{"id":"x","source":"abc' } };
    const { events, calls } = await runMock(Array(10).fill(step), { codeCacheDir: dir, sessionId: sid });
    const err = events.find((e) => e.type === 'error');
    assert.ok(err, 'it must end with an error');
    assert.match(err.message, /exceeded the single-output limit and was truncated 7 times in a row, so this round could not finish/);
    assert.match(err.message, /The part already written is stored in code block cut_create_card_1/);
    assert.equal(calls.filter((c) => c.name === 'create_card').length, 0);
    // 一次都没留下内容的截断:连续 3 次就停
    const sid2 = `${sid}-b`;
    const r2 = await runMock(Array(10).fill({ truncate: { say: 'Draft…' } }), { codeCacheDir: dir, sessionId: sid2 });
    assert.match(r2.events.find((e) => e.type === 'error')?.message ?? '', /exceeded the single-output limit and was truncated 3 times in a row/);
    try { fs.unlinkSync(historyOf(sid2)); } catch { /* 清理 */ }
  } finally { rm(dir); try { fs.unlinkSync(historyOf(sid)); } catch { /* 清理 */ } }
});
