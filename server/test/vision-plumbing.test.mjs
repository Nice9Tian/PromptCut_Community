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
const imageMsg = () => ({ role: 'user', content: [{ type: 'image', mime: 'image/png', data: B64 }, { type: 'text', text: 'Look at this one' }] });

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
  assert.ok(captured, 'The provider sent no request');
  return captured;
}

test('anthropic converts image blocks into its own source/base64 shape', async () => {
  const body = await bodyOf(anthropic, [imageMsg()]);
  const blocks = body.messages[0].content;
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[0].source.type, 'base64');
  assert.equal(blocks[0].source.media_type, 'image/png');
  assert.equal(blocks[0].source.data, B64);
});

test('openai converts image blocks into image_url with a data: URL', async () => {
  const body = await bodyOf(openai, [imageMsg()]);
  const msg = body.messages.find((m) => m.role === 'user');
  assert.ok(Array.isArray(msg.content), 'A multimodal array must be sent when there is an image');
  const img = msg.content.find((p) => p.type === 'image_url');
  assert.equal(img.image_url.url, `data:image/png;base64,${B64}`);
});

test('openai still sends a plain string when there are no images (compatible endpoints do not necessarily accept arrays)', async () => {
  const body = await bodyOf(openai, [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]);
  assert.equal(body.messages.find((m) => m.role === 'user').content, 'Hello');
});

/** 真实形状:同一条 user 消息里先是工具结果,后面跟着图片和说明 */
const mixedMsg = () => ({
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: 'call-1', content: '{"ok":true}' },
    { type: 'image', mime: 'image/png', data: B64 },
    { type: 'text', text: 'The above is the picture' },
  ],
});

test('anthropic: the tool result and the image are in the same message, both are kept, and the image comes after the result', async () => {
  const body = await bodyOf(anthropic, [mixedMsg()]);
  const blocks = body.messages[0].content;
  assert.deepEqual(blocks.map((b) => b.type), ['tool_result', 'image', 'text']);
  assert.equal(blocks[1].source.data, B64);
});

test('openai: the tool result is sent as role:tool and the image goes in a separate user message after it (this used to drop the image)', async () => {
  const body = await bodyOf(openai, [mixedMsg()]);
  const roles = body.messages.map((m) => m.role);
  assert.deepEqual(roles, ['tool', 'user'], 'tool first, the user message with the image after');
  assert.equal(body.messages[0].tool_call_id, 'call-1');
  const img = body.messages[1].content.find((p) => p.type === 'image_url');
  assert.ok(img, 'The image must not be dropped');
  assert.equal(img.image_url.url, `data:image/png;base64,${B64}`);
  assert.ok(body.messages[1].content.some((p) => p.type === 'text'), 'The explanatory text must be in the same message as the image');
});

test('openai: with only a tool result and no image, no extra empty user message is sent', async () => {
  const body = await bodyOf(openai, [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
  ]);
  assert.deepEqual(body.messages.map((m) => m.role), ['tool']);
});

test('gemini: the tool result and the image are in the same message, and both are converted', async () => {
  const body = await bodyOf(gemini, [mixedMsg()]);
  const parts = body.contents[0].parts;
  assert.ok(parts.some((p) => p.functionResponse), 'The tool result must be present');
  assert.ok(parts.some((p) => p.inlineData?.data === B64), 'The image must be present');
});

test('gemini converts image blocks into inlineData', async () => {
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
      yield { type: 'text_delta', text: 'Done looking.' };
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
  const out = await agent.run('Take a look at the picture');
  return { history: out.history.get(), events };
}

test('__image is pulled out and becomes an image block at the end of the same user message', async () => {
  const { history } = await runWithTool({ ok: true, t: 2, __image: { mime: 'image/png', base64: B64 } });
  const msg = history.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'));
  const kinds = msg.content.map((b) => b.type);
  assert.deepEqual(kinds, ['tool_result', 'image', 'text'], 'The image must come after the tool result');
  assert.equal(msg.content[1].data, B64);
  assert.ok(!msg.content.some((b) => b.type === 'tool_result' && b.content.includes(B64.slice(0, 50))),
    'base64 must not also remain in the tool_result text');
});

test('No extra user message appears after extraction (the three APIs tolerate consecutive messages of the same role differently)', async () => {
  const { history } = await runWithTool({ ok: true, __image: { mime: 'image/png', base64: B64 } });
  for (let i = 1; i < history.length; i++) {
    assert.notEqual(history[i].role, history[i - 1].role, `Message ${i} and the previous one are both ${history[i].role}`);
  }
});

test('The tool_result event forwarded to the interface carries no base64, so the archive does not bloat', async () => {
  const { events } = await runWithTool({ ok: true, __image: { mime: 'image/png', base64: B64 } });
  const ev = events.find((e) => e.type === 'tool_result');
  assert.ok(!JSON.stringify(ev).includes(B64.slice(0, 50)), 'base64 leaked into the event');
  assert.match(ev.output.image, /See the image at the end of this message for the frame/, 'One sentence must be left saying where the picture is');
});

test('Ordinary tools (without __image) take the original path, with not a single character changed', async () => {
  const { history } = await runWithTool({ ok: true, clips: 2 });
  const msg = history.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'));
  assert.deepEqual(msg.content.map((b) => b.type), ['tool_result']);
  assert.equal(msg.content[0].content, JSON.stringify({ ok: true, clips: 2 }));
});

test('No image is extracted when a tool fails (an __image in a failed result must not be sent in as a picture)', async () => {
  const { history } = await runWithTool({ ok: false, error: 'boom', __image: { mime: 'image/png', base64: B64 } });
  const msg = history.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'));
  assert.ok(!msg.content.some((b) => b.type === 'image'), 'A failed call must not carry an image');
});

test('History length is not counted by the literal length of base64, otherwise viewing one image would trim the chat down to nothing', () => {
  const h = new MessageHistory({ maxChars: 120000 });
  h.append({ role: 'user', content: [{ type: 'text', text: 'Make the font size bigger' }] });
  h.append(imageMsg());
  h.append({ role: 'assistant', content: [{ type: 'text', text: 'OK' }] });
  h.truncate();
  assert.equal(h.get().length, 3, 'Not a single message should be truncated');
  assert.equal(h.get()[1].content[0].data, B64, 'The image itself must be kept as is');
});

test('Keep only the most recent screenshots, replace earlier ones with a one-sentence note', () => {
  const h = new MessageHistory();
  h.append(imageMsg());
  h.append(imageMsg());
  h.append(imageMsg());
  h.pruneImages(2);
  const kinds = h.get().map((m) => m.content[0].type);
  assert.deepEqual(kinds, ['text', 'image', 'image'], 'The earliest one should be replaced, the two most recent ones are kept');
  assert.match(h.get()[0].content[0].text, /removed from the context/);
});

test('pruneImages leaves messages without images alone', () => {
  const h = new MessageHistory();
  h.append({ role: 'user', content: [{ type: 'text', text: 'x' }] });
  h.pruneImages(0);
  assert.equal(h.get()[0].content[0].text, 'x');
});

// ── 回归面 ────────────────────────────────────────────────────────────
// 这次改动碰到了这几条路但不打算改变它们的行为。改坏了不会报错，只会让
// 「什么时候截断」「消息发成什么形状」悄悄变掉，所以拿旧行为当基准钉住。

test('Regression: the length algorithm for plain-text history is byte-for-byte identical to before the change', () => {
  const msgs = [];
  for (let i = 0; i < 200; i++) {
    msgs.push({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: 'Long text'.repeat(200) + i }] });
  }
  const old = JSON.stringify(msgs).length; // 改之前就是这么算的
  assert.equal(MessageHistory.fromJSON(msgs, {}).estimateTokens(), Math.ceil(old / 3));
});

test('Regression: plain-text history that should be truncated is still truncated', () => {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'The initial request' }] }];
  for (let i = 0; i < 60; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: 'x'.repeat(3000) }] });
  const h = MessageHistory.fromJSON(msgs, { maxChars: 120000 });
  h.truncate();
  assert.ok(h.get().length < 61, 'should have been trimmed');
  assert.ok(JSON.stringify(h.get()).length <= 120000, 'still over after trimming');
});

test('Regression: content in an OpenAI plain-text chat is still a string, not a multimodal array', async () => {
  const body = await bodyOf(openai, [
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Here' }] },
    { role: 'user', content: [{ type: 'text', text: 'One more question' }] },
  ]);
  for (const m of body.messages) assert.equal(typeof m.content, 'string', `The content of ${m.role} became ${typeof m.content}`);
});

test('Regression: an OpenAI tool round trip without images adds no extra user message', async () => {
  const body = await bodyOf(openai, [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'seek', input: { t: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"ok":true}' }] },
  ]);
  assert.deepEqual(body.messages.map((m) => m.role), ['assistant', 'tool']);
});

test('Regression: when OpenAI tool results are followed by text (no image), the text is still sent as a string', async () => {
  const body = await bodyOf(openai, [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'seek', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }, { type: 'text', text: 'Continue' }] },
  ]);
  assert.equal(body.messages.at(-1).content, 'Continue', 'Without an image it must not become a multimodal array');
});
