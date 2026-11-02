/**
 * 手机版 Agent 分页的视图模型(`agentView.ts`)。跑:node --test src/mobile/agentView.test.mjs
 * AV1 引用的写法:发送时放在正文前面、消息气泡上能认出来(桌面发的、手机发的同一个写法)
 * AV2 引用条:同一个 id 不重复放
 * AV3 一轮回复拆成:动手之前的话 → 操作卡片(每次工具调用一条,状态跟着成败) → 动手之后的话
 * AV4 小结(report_progress)变成卡片里的行,对用户说话的 send_message 不算操作
 * AV5 没出结果的操作:这一轮在跑是「在做」,收了尾是「还没做」
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addQuote, isUserBubble, ordinals, quoteToken, roundView, splitQuotes, withQuotes } from './agentView.ts';

test('AV1 quote: a sent message is written as "@card name(clip id) text", and the leading quote string can be recognized again', () => {
  const q = [{ id: 'c-1', label: 'beach-run.mp4' }, { id: 'tr-2', label: 'Transition crossfade' }];
  assert.equal(quoteToken(q[0]), '@卡片 beach-run.mp4(c-1)');
  const text = withQuotes('  Cut it a bit shorter  ', q);
  assert.equal(text, '@卡片 beach-run.mp4(c-1) @卡片 Transition crossfade(tr-2) Cut it a bit shorter');
  const back = splitQuotes(text);
  assert.deepEqual(back.quotes, q);
  assert.equal(back.rest, 'Cut it a bit shorter');
  assert.equal(withQuotes('Hello', []), 'Hello');
  assert.deepEqual(splitQuotes('Text with no quote'), { quotes: [], rest: 'Text with no quote' });
  // 名字里带括号:只认最后一对括号当片段 id
  assert.deepEqual(splitQuotes('@卡片 Title(replica)(c-9) Enlarge').quotes, [{ label: 'Title(replica)', id: 'c-9' }]);
  // 桌面「引用到 AI」插进输入框的写法(引用后一个空格、再写话)
  assert.deepEqual(splitQuotes('@卡片 Number ticker(c-3) Make the font size a bit larger'), { quotes: [{ label: 'Number ticker', id: 'c-3' }], rest: 'Make the font size a bit larger' });
  // 只有引用、没有话
  assert.deepEqual(splitQuotes('@卡片 a(b)'), { quotes: [{ label: 'a', id: 'b' }], rest: '' });
  // 引用不在开头的不认(那是用户自己写的)
  assert.deepEqual(splitQuotes('Please look at @卡片 a(b) this one').quotes, []);
});

test('AV1b A quote of a single overlay card is written as "@overlay card name(clip id#kind:definition id)", and the quote bar carries the level all the way to sending', () => {
  const q = { id: 'c1#filter:f1', label: 'Darken', kind: '叠加卡' };
  const list = addQuote([], q);
  assert.deepEqual(list, [q], 'addQuote must keep kind as well, otherwise sending would write "@card" again');
  assert.equal(withQuotes('Make it a bit lighter', list), '@叠加卡 Darken(c1#filter:f1) Make it a bit lighter');
  // 不写 kind 的还是整段那一级,和以前一字不差
  assert.equal(withQuotes('Make it shorter', [{ id: 'c1', label: 'Front door' }]), '@卡片 Front door(c1) Make it shorter');
});

test('AV2 The same id is not added twice in the quote bar', () => {
  const a = [{ id: 'c1', label: 'A' }];
  assert.deepEqual(addQuote(a, { id: 'c1', label: 'A' }), a);
  assert.deepEqual(addQuote(a, { id: 'c2', label: 'B' }).map((x) => x.id), ['c1', 'c2']);
  assert.notEqual(addQuote(a, { id: 'c1', label: 'A' }), a, 'Returns a new array, does not modify in place');
});

const say = (text) => ({ kind: 'tool', name: 'mcp__promptcut__send_message', input: { to: 'user', text }, ok: true });
const op = (name, ok) => ({ kind: 'tool', name: `mcp__promptcut__${name}`, input: {}, ...(ok === undefined ? {} : { ok }) });
const asst = (id, parts, extra = {}) => ({ id, role: 'assistant', text: '', parts, ...extra });

test('AV3 One round of reply: words before acting → operation card → words after acting; entries carry category and status', () => {
  const m = asst('a1', [say('Let me look at the media first'), op('list_media', true), op('add_clip', true), op('set_clip_param', false), say('The title is placed')]);
  const v = roundView(m, 1);
  assert.deepEqual(v.before.map((s) => s.text), ['Let me look at the media first']);
  assert.deepEqual(v.after.map((s) => s.text), ['The title is placed']);
  assert.deepEqual(v.items.map((i) => [i.state, i.kind, i.name]), [['done', 'Read', 'list_media'], ['done', 'Add', 'add_clip'], ['err', 'Change', 'set_clip_param']]);
  assert.equal(v.title, 'Turn 1 · 3 actions');
  assert.equal(v.hasCard, true);
});

test('AV4 The summary becomes a row in the card; words sent to the user via send_message do not count as operations; no operations and no summary means no card', () => {
  const report = { kind: 'tool', name: 'mcp__promptcut__report_progress', input: { final: true, done: ['Added a title'], todo: ['Background music'], problems: ['Font missing'] }, ok: true };
  const v = roundView(asst('a2', [op('add_clip', true), report, say('Done')]), 2);
  assert.equal(v.items.length, 1);
  assert.equal(v.reports.length, 1);
  assert.equal(v.reports[0].title, 'Round summary');
  assert.deepEqual(v.reports[0].rows.map((r) => [r.state, r.text]), [['done', 'Added a title'], ['todo', 'Background music'], ['ask', 'Font missing']]);
  const only = roundView(asst('a3', [say('Hmm, I\'m thinking')]), 3);
  assert.equal(only.hasCard, false);
  assert.deepEqual(only.before.map((s) => s.text), ['Hmm, I\'m thinking']);
  assert.equal(only.after.length, 0);
  // 只回了文字(没调 send_message)的那一轮:文字当一句话
  const plain = roundView({ id: 'a4', role: 'assistant', text: '', parts: [{ kind: 'text', text: 'OK' }] }, 4);
  assert.deepEqual(plain.before.map((s) => s.text), ['OK']);
});

test('AV5 An operation with no result: while the round is still running it is "in progress", once the round has ended it is "not done yet"', () => {
  const running = roundView(asst('a5', [op('add_clip')], { pending: true }), 1);
  assert.equal(running.items[0].state, 'run');
  const stopped = roundView(asst('a6', [op('add_clip')]), 1);
  assert.equal(stopped.items[0].state, 'todo');
  // 老历史没有 parts:按 text / tools 兜底
  const legacy = roundView({ id: 'a7', role: 'assistant', text: 'Finished', tools: [{ name: 'add_clip', ok: true }] }, 1);
  assert.equal(legacy.items.length, 1);
  assert.deepEqual(legacy.after.map((s) => s.text).concat(legacy.before.map((s) => s.text)), ['Finished']);
});

test('AV6 Round numbering counts only assistant replies; user messages passed in by other Agents get no bubble', () => {
  const ms = [{ id: 'u1', role: 'user', text: 'x' }, asst('a1', []), { id: 'u2', role: 'user', text: 'y', inbound: [{ from: 'z', text: 't' }] }, asst('a2', [])];
  const o = ordinals(ms);
  assert.equal(o.get('a1'), 1);
  assert.equal(o.get('a2'), 2);
  assert.equal(isUserBubble(ms[0]), true);
  assert.equal(isUserBubble(ms[2]), false);
  assert.equal(isUserBubble(ms[1]), false);
});
