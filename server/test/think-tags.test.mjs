// node --test server/test/think-tags.test.mjs —— 内联 <think> 的流式拆分
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createThinkSplitter, splitThinkTags } = await import('../harness/think-tags.mjs');

/** 把整段按 size 切碎喂进去,模拟流式;返回拼好的两条通道 */
function feed(text, size) {
  const sp = createThinkSplitter();
  const events = [];
  for (let i = 0; i < text.length; i += size) events.push(...sp.push(text.slice(i, i + size)));
  events.push(...sp.flush());
  let out = '';
  let think = '';
  for (const e of events) {
    if (e.kind === 'text') out += e.text;
    else think += e.text;
  }
  return { text: out, think };
}

// 用户诊断报告里的真实形状(对话诊断-20260908-114215)
const REAL = '<think>**Clarifying article link and scope**\n\n</think>\n\n我先确认素材收集环境；目前消息里没有看到微信文章链接。';

test('真实样本:think 走思考通道,正文里一个标签都不剩', () => {
  const { text, think } = splitThinkTags(REAL);
  assert.equal(think, '**Clarifying article link and scope**\n\n');
  assert.equal(text, '\n\n我先确认素材收集环境；目前消息里没有看到微信文章链接。');
  assert.ok(!text.includes('<think'), '正文里不能有 <think');
  assert.ok(!text.includes('</think'), '正文里不能有 </think —— 这正是漏到气泡里的那一串');
});

test('无论按多大的块切,结果都一样 —— 标签被切成两半是常态', () => {
  const expect = splitThinkTags(REAL);
  for (const size of [1, 2, 3, 5, 7, 13, 64, 1000]) {
    assert.deepEqual(feed(REAL, size), expect, `按 ${size} 字节切时结果不一致`);
  }
});

test('一条消息里多段 think:全部拆走,正文按顺序接起来', () => {
  const s = 'A<think>t1</think>B<think>t2</think>C';
  assert.deepEqual(splitThinkTags(s), { text: 'ABC', think: 't1t2' });
  assert.deepEqual(feed(s, 1), { text: 'ABC', think: 't1t2' });
});

test('<thinking> 这种写法也认', () => {
  assert.deepEqual(splitThinkTags('x<thinking>y</thinking>z'), { text: 'xz', think: 'y' });
});

test('没有标签的普通文本原样通过,一个字符都不能少', () => {
  const s = '这是一段普通回复,里面有 < 和 > 还有 1 < 2 这种比较。';
  assert.deepEqual(splitThinkTags(s), { text: s, think: '' });
  assert.deepEqual(feed(s, 1), { text: s, think: '' });
});

test('流没结束就断了:扣住的半个标签要吐回正文,不能把用户的字吞掉', () => {
  const sp = createThinkSplitter();
  const seen = [...sp.push('结尾正好是 <thi'), ...sp.flush()];
  assert.equal(seen.map((e) => e.text).join(''), '结尾正好是 <thi');
  assert.ok(seen.every((e) => e.kind === 'text'));
});

test('think 没等到闭合就断流:当思考交出去,而不是丢掉', () => {
  const sp = createThinkSplitter();
  const seen = [...sp.push('a<think>没写完'), ...sp.flush()];
  assert.equal(seen.filter((e) => e.kind === 'text').map((e) => e.text).join(''), 'a');
  assert.equal(seen.filter((e) => e.kind === 'think').map((e) => e.text).join(''), '没写完');
});

test('inThink 反映当前状态', () => {
  const sp = createThinkSplitter();
  assert.equal(sp.inThink, false);
  sp.push('x<think>y');
  assert.equal(sp.inThink, true);
  sp.push('</think>z');
  assert.equal(sp.inThink, false);
});

test('开标签跨块、闭标签也跨块 —— 逐字符喂最容易露馅', () => {
  const s = 'before<think>mid</think>after';
  assert.deepEqual(feed(s, 1), { text: 'beforeafter', think: 'mid' });
});

test('空输入和空片段不产出事件', () => {
  const sp = createThinkSplitter();
  assert.deepEqual(sp.push(''), []);
  assert.deepEqual(sp.push('<think>'), [], '只有开标签时不该产出空的 text');
  assert.deepEqual(sp.push('</think>'), [], '紧接着闭合也不该产出空的 think');
});
