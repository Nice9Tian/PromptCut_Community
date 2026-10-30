/**
 * 图片怎么从工具结果一路走到模型跟前。跑：node --test server/test/vision-plumbing.test.mjs
 *
 * 这条链上每一段都能悄悄地坏：base64 留在 tool_result 里模型看不见画面、
 * 某家 provider 把 image 块丢了、历史按字面长度算把整段对话截光。
 * 三者都不会报错，只会表现成「模型好像没看图」，所以逐段钉住。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../harness/agent.mjs';
import { MessageHistory } from '../harness/history.mjs';
import { createProvider as anthropic } from '../harness/providers/anthropic.mjs';
import { createProvider as openai } from '../harness/providers/openai.mjs';
import { createProvider as gemini } from '../harness/providers/gemini.mjs';

const B64 = 'A'.repeat(200000);
const imageMsg = () => ({ role: 'user', content: [{ type: 'image', mime: 'image/png', data: B64 }, { type: 'text', text: '看这张' }] });

/** 把 provider 的请求体截下来，不真的发网络 */
async function bodyOf(create, messages) {
  let captured;
  const fetchImpl = async (_url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, status: 200, headers: new Map(), body: { getReader: () => ({ read: async () => ({ done: true }), releaseLock() {} }) } };
  };
  const p = create({ apiKey: 'k', model: 'm' }, { fetchImpl });
  // 只关心它发出去的请求体。空流会让 provider 抱怨「没返回 SSE 数据」，
  // 那是它该有的行为，这里咽掉就行——请求体在报错之前就已经截到了。
  try {
    for await (const _ of p.stream(messages, [], '', undefined)) void _;
  } catch { /* 空流 */ }
  assert.ok(captured, 'provider 没发出请求');
  return captured;
}

test('anthropic 把 image 块转成本家的 source/base64 形状', async () => {
  const body = await bodyOf(anthropic, [imageMsg()]);
  const blocks = body.messages[0].content;
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[0].source.type, 'base64');
  assert.equal(blocks[0].source.media_type, 'image/png');
  assert.equal(blocks[0].source.data, B64);
});

test('openai 把 image 块转成 data: URL 的 image_url', async () => {
  const body = await bodyOf(openai, [imageMsg()]);
  const msg = body.messages.find((m) => m.role === 'user');
  assert.ok(Array.isArray(msg.content), '带图时必须发多模态数组');
  const img = msg.content.find((p) => p.type === 'image_url');
  assert.equal(img.image_url.url, `data:image/png;base64,${B64}`);
});

test('openai 没有图片时仍旧发纯字符串（兼容端点不一定吃数组）', async () => {
  const body = await bodyOf(openai, [{ role: 'user', content: [{ type: 'text', text: '你好' }] }]);
  assert.equal(body.messages.find((m) => m.role === 'user').content, '你好');
});

/** 真实形状:同一条 user 消息里先是工具结果,后面跟着图片和说明 */
const mixedMsg = () => ({
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: 'call-1', content: '{"ok":true}' },
    { type: 'image', mime: 'image/png', data: B64 },
    { type: 'text', text: '以上是画面' },
  ],
});

test('anthropic：工具结果和图片同在一条消息里，两者都留住且图排在结果之后', async () => {
  const body = await bodyOf(anthropic, [mixedMsg()]);
  const blocks = body.messages[0].content;
  assert.deepEqual(blocks.map((b) => b.type), ['tool_result', 'image', 'text']);
  assert.equal(blocks[1].source.data, B64);
});

test('openai：工具结果发成 role:tool，图片另起一条 user 跟在后面（曾经这里会把图丢掉）', async () => {
  const body = await bodyOf(openai, [mixedMsg()]);
  const roles = body.messages.map((m) => m.role);
  assert.deepEqual(roles, ['tool', 'user'], 'tool 在前，带图的 user 在后');
  assert.equal(body.messages[0].tool_call_id, 'call-1');
  const img = body.messages[1].content.find((p) => p.type === 'image_url');
  assert.ok(img, '图片不能被丢掉');
  assert.equal(img.image_url.url, `data:image/png;base64,${B64}`);
  assert.ok(body.messages[1].content.some((p) => p.type === 'text'), '说明文字要和图在同一条里');
});

test('openai：只有工具结果、没有图片时不多发一条空的 user 消息', async () => {
  const body = await bodyOf(openai, [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
  ]);
  assert.deepEqual(body.messages.map((m) => m.role), ['tool']);
});

test('gemini：工具结果和图片同在一条消息里，都转过去了', async () => {
  const body = await bodyOf(gemini, [mixedMsg()]);
  const parts = body.contents[0].parts;
  assert.ok(parts.some((p) => p.functionResponse), '工具结果要在');
  assert.ok(parts.some((p) => p.inlineData?.data === B64), '图片要在');
});

test('gemini 把 image 块转成 inlineData', async () => {
  const body = await bodyOf(gemini, [imageMsg()]);
  const part = body.contents[0].parts.find((p) => p.inlineData);
  assert.equal(part.inlineData.mimeType, 'image/png');
  assert.equal(part.inlineData.data, B64);
});

// ── agent.mjs 把 __image 从工具结果里摘出来 ────────────────────────────
// 这一段是整条链的入口：漏了它，base64 会当成普通文本灌进历史，模型什么也看不见，
// 界面存档还会被撑大。而它不报错，只表现成「模型好像没看图」。

/** 第一轮调一次工具，第二轮说句话收尾 */
function scriptedProvider(toolName) {
  let turn = 0;
  return { name: 'scripted', async *stream() {
    if (++turn === 1) {
      yield { type: 'tool_use', id: 'call_1', name: toolName, input: {} };
      yield { type: 'stop', reason: 'tool_use' };
    } else {
      yield { type: 'text_delta', text: '看完了。' };
      yield { type: 'stop', reason: 'end_turn' };
    }
  } };
}

async function runWithTool(result) {
  const events = [];
  const agent = new Agent({
    provider: scriptedProvider('see_frames'),
    system: 's',
    tools: [{ name: 'see_frames', inputSchema: { type: 'object', properties: {} }, execute: async () => result }],
    onEvent: (e) => events.push(e),
  });
  const out = await agent.run('看一眼画面');
  return { history: out.history.get(), events };
}

test('__image 被摘出来，变成同一条 user 消息末尾的 image 块', async () => {
  const { history } = await runWithTool({ ok: true, t: 2, __image: { mime: 'image/png', base64: B64 } });
  const msg = history.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'));
  const kinds = msg.content.map((b) => b.type);
  assert.deepEqual(kinds, ['tool_result', 'image', 'text'], '图要排在工具结果之后');
  assert.equal(msg.content[1].data, B64);
  assert.ok(!msg.content.some((b) => b.type === 'tool_result' && b.content.includes(B64.slice(0, 50))),
    'base64 不能同时还留在 tool_result 的文本里');
});

test('摘出来之后不多出一条 user 消息（连续同角色三家 API 容忍度不一样）', async () => {
  const { history } = await runWithTool({ ok: true, __image: { mime: 'image/png', base64: B64 } });
  for (let i = 1; i < history.length; i++) {
    assert.notEqual(history[i].role, history[i - 1].role, `第 ${i} 条和上一条都是 ${history[i].role}`);
  }
});

test('转发给界面的 tool_result 事件里不带 base64，存档才不会被撑大', async () => {
  const { events } = await runWithTool({ ok: true, __image: { mime: 'image/png', base64: B64 } });
  const ev = events.find((e) => e.type === 'tool_result');
  assert.ok(!JSON.stringify(ev).includes(B64.slice(0, 50)), '事件里漏了 base64');
  assert.match(ev.output.image, /画面/, '该留一句话说明画面在哪');
});

test('普通工具（没有 __image）走原来的路，一个字都不变', async () => {
  const { history } = await runWithTool({ ok: true, clips: 2 });
  const msg = history.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'));
  assert.deepEqual(msg.content.map((b) => b.type), ['tool_result']);
  assert.equal(msg.content[0].content, JSON.stringify({ ok: true, clips: 2 }));
});

test('工具失败时不摘图（失败结果里的 __image 不该被当成画面送进去）', async () => {
  const { history } = await runWithTool({ ok: false, error: '炸了', __image: { mime: 'image/png', base64: B64 } });
  const msg = history.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'));
  assert.ok(!msg.content.some((b) => b.type === 'image'), '失败的调用不该带图');
});

test('历史长度不按 base64 的字面长度算，否则看一次图就会把对话截光', () => {
  const h = new MessageHistory({ maxChars: 120000 });
  h.append({ role: 'user', content: [{ type: 'text', text: '给字号调大' }] });
  h.append(imageMsg());
  h.append({ role: 'assistant', content: [{ type: 'text', text: '好的' }] });
  h.truncate();
  assert.equal(h.get().length, 3, '一条都不该被截掉');
  assert.equal(h.get()[1].content[0].data, B64, '图片本身要原样留着');
});

test('只保留最近的截图，更早的换成一句说明', () => {
  const h = new MessageHistory();
  h.append(imageMsg());
  h.append(imageMsg());
  h.append(imageMsg());
  h.pruneImages(2);
  const kinds = h.get().map((m) => m.content[0].type);
  assert.deepEqual(kinds, ['text', 'image', 'image'], '最早那张该被换掉，最近两张留着');
  assert.match(h.get()[0].content[0].text, /已从上下文移除/);
});

test('pruneImages 不动没有图片的消息', () => {
  const h = new MessageHistory();
  h.append({ role: 'user', content: [{ type: 'text', text: 'x' }] });
  h.pruneImages(0);
  assert.equal(h.get()[0].content[0].text, 'x');
});

// ── 回归面 ────────────────────────────────────────────────────────────
// 这次改动碰到了这几条路但不打算改变它们的行为。改坏了不会报错，只会让
// 「什么时候截断」「消息发成什么形状」悄悄变掉，所以拿旧行为当基准钉住。

test('回归：纯文本历史的长度算法和改之前逐字节相同', () => {
  const msgs = [];
  for (let i = 0; i < 200; i++) {
    msgs.push({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: '长文本'.repeat(200) + i }] });
  }
  const old = JSON.stringify(msgs).length; // 改之前就是这么算的
  assert.equal(MessageHistory.fromJSON(msgs, {}).estimateTokens(), Math.ceil(old / 3));
});

test('回归：纯文本历史该截断的仍然截断', () => {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: '最初的请求' }] }];
  for (let i = 0; i < 60; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: 'x'.repeat(3000) }] });
  const h = MessageHistory.fromJSON(msgs, { maxChars: 120000 });
  h.truncate();
  assert.ok(h.get().length < 61, '应当截过');
  assert.ok(JSON.stringify(h.get()).length <= 120000, '截完还超');
});

test('回归：OpenAI 纯文本对话的 content 仍是字符串，不是多模态数组', async () => {
  const body = await bodyOf(openai, [
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', content: [{ type: 'text', text: '在' }] },
    { role: 'user', content: [{ type: 'text', text: '再问一句' }] },
  ]);
  for (const m of body.messages) assert.equal(typeof m.content, 'string', `${m.role} 的 content 成了 ${typeof m.content}`);
});

test('回归：OpenAI 无图的工具往返不多出一条 user 消息', async () => {
  const body = await bodyOf(openai, [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'seek', input: { t: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"ok":true}' }] },
  ]);
  assert.deepEqual(body.messages.map((m) => m.role), ['assistant', 'tool']);
});

test('回归：OpenAI 工具结果后跟文字（无图）时，文字仍以字符串发出', async () => {
  const body = await bodyOf(openai, [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'seek', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }, { type: 'text', text: '接着做' }] },
  ]);
  assert.equal(body.messages.at(-1).content, '接着做', '无图时不该变成多模态数组');
});
