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

test('AV1 引用:发送写成「@卡片 名字(片段 id) 正文」,开头的引用串能认回来', () => {
  const q = [{ id: 'c-1', label: '沙滩奔跑.mp4' }, { id: 'tr-2', label: '转场 交叉溶解' }];
  assert.equal(quoteToken(q[0]), '@卡片 沙滩奔跑.mp4(c-1)');
  const text = withQuotes('  把它剪短一点  ', q);
  assert.equal(text, '@卡片 沙滩奔跑.mp4(c-1) @卡片 转场 交叉溶解(tr-2) 把它剪短一点');
  const back = splitQuotes(text);
  assert.deepEqual(back.quotes, q);
  assert.equal(back.rest, '把它剪短一点');
  assert.equal(withQuotes('你好', []), '你好');
  assert.deepEqual(splitQuotes('没有引用的话'), { quotes: [], rest: '没有引用的话' });
  // 名字里带括号:只认最后一对括号当片段 id
  assert.deepEqual(splitQuotes('@卡片 标题(副本)(c-9) 放大').quotes, [{ label: '标题(副本)', id: 'c-9' }]);
  // 桌面「引用到 AI」插进输入框的写法(引用后一个空格、再写话)
  assert.deepEqual(splitQuotes('@卡片 数字滚动(c-3) 字号再大点'), { quotes: [{ label: '数字滚动', id: 'c-3' }], rest: '字号再大点' });
  // 只有引用、没有话
  assert.deepEqual(splitQuotes('@卡片 a(b)'), { quotes: [{ label: 'a', id: 'b' }], rest: '' });
  // 引用不在开头的不认(那是用户自己写的)
  assert.deepEqual(splitQuotes('请看 @卡片 a(b) 这个').quotes, []);
});

test('AV1b 单张叠加卡的引用写成「@叠加卡 名字(片段id#种类:定义id)」,标记条到发送一路带着级别', () => {
  const q = { id: 'c1#filter:f1', label: '压暗', kind: '叠加卡' };
  const list = addQuote([], q);
  assert.deepEqual(list, [q], 'addQuote 要把 kind 一起留下,不然发送时又写回「@卡片」');
  assert.equal(withQuotes('调淡一点', list), '@叠加卡 压暗(c1#filter:f1) 调淡一点');
  // 不写 kind 的还是整段那一级,和以前一字不差
  assert.equal(withQuotes('改短些', [{ id: 'c1', label: '入户门' }]), '@卡片 入户门(c1) 改短些');
});

test('AV2 引用条里同一个 id 不重复放', () => {
  const a = [{ id: 'c1', label: 'A' }];
  assert.deepEqual(addQuote(a, { id: 'c1', label: 'A' }), a);
  assert.deepEqual(addQuote(a, { id: 'c2', label: 'B' }).map((x) => x.id), ['c1', 'c2']);
  assert.notEqual(addQuote(a, { id: 'c1', label: 'A' }), a, '回新数组,不原地改');
});

const say = (text) => ({ kind: 'tool', name: 'mcp__promptcut__send_message', input: { to: 'user', text }, ok: true });
const op = (name, ok) => ({ kind: 'tool', name: `mcp__promptcut__${name}`, input: {}, ...(ok === undefined ? {} : { ok }) });
const asst = (id, parts, extra = {}) => ({ id, role: 'assistant', text: '', parts, ...extra });

test('AV3 一轮回复:动手之前的话 → 操作卡片 → 动手之后的话;条目带类别和状态', () => {
  const m = asst('a1', [say('我先看一下素材'), op('list_media', true), op('add_clip', true), op('set_clip_param', false), say('标题放好了')]);
  const v = roundView(m, 1);
  assert.deepEqual(v.before.map((s) => s.text), ['我先看一下素材']);
  assert.deepEqual(v.after.map((s) => s.text), ['标题放好了']);
  assert.deepEqual(v.items.map((i) => [i.state, i.kind, i.name]), [['done', '读取', 'list_media'], ['done', '新增', 'add_clip'], ['err', '修改', 'set_clip_param']]);
  assert.equal(v.title, '第 1 轮 · 3 项操作');
  assert.equal(v.hasCard, true);
});

test('AV4 小结变成卡片里的行;send_message 给用户的话不算操作;没有操作也没有小结就没有卡片', () => {
  const report = { kind: 'tool', name: 'mcp__promptcut__report_progress', input: { final: true, done: ['加了标题'], todo: ['配乐'], problems: ['字体缺失'] }, ok: true };
  const v = roundView(asst('a2', [op('add_clip', true), report, say('好了')]), 2);
  assert.equal(v.items.length, 1);
  assert.equal(v.reports.length, 1);
  assert.equal(v.reports[0].title, '本轮小结');
  assert.deepEqual(v.reports[0].rows.map((r) => [r.state, r.text]), [['done', '加了标题'], ['todo', '配乐'], ['ask', '字体缺失']]);
  const only = roundView(asst('a3', [say('嗯,我在想')]), 3);
  assert.equal(only.hasCard, false);
  assert.deepEqual(only.before.map((s) => s.text), ['嗯,我在想']);
  assert.equal(only.after.length, 0);
  // 只回了文字(没调 send_message)的那一轮:文字当一句话
  const plain = roundView({ id: 'a4', role: 'assistant', text: '', parts: [{ kind: 'text', text: '好的' }] }, 4);
  assert.deepEqual(plain.before.map((s) => s.text), ['好的']);
});

test('AV5 没出结果的操作:这一轮还在跑是「在做」,收了尾是「还没做」', () => {
  const running = roundView(asst('a5', [op('add_clip')], { pending: true }), 1);
  assert.equal(running.items[0].state, 'run');
  const stopped = roundView(asst('a6', [op('add_clip')]), 1);
  assert.equal(stopped.items[0].state, 'todo');
  // 老历史没有 parts:按 text / tools 兜底
  const legacy = roundView({ id: 'a7', role: 'assistant', text: '做完了', tools: [{ name: 'add_clip', ok: true }] }, 1);
  assert.equal(legacy.items.length, 1);
  assert.deepEqual(legacy.after.map((s) => s.text).concat(legacy.before.map((s) => s.text)), ['做完了']);
});

test('AV6 轮次编号只数助手回复;其他 Agent 递来的用户消息不画气泡', () => {
  const ms = [{ id: 'u1', role: 'user', text: 'x' }, asst('a1', []), { id: 'u2', role: 'user', text: 'y', inbound: [{ from: 'z', text: 't' }] }, asst('a2', [])];
  const o = ordinals(ms);
  assert.equal(o.get('a1'), 1);
  assert.equal(o.get('a2'), 2);
  assert.equal(isUserBubble(ms[0]), true);
  assert.equal(isUserBubble(ms[2]), false);
  assert.equal(isUserBubble(ms[1]), false);
});
