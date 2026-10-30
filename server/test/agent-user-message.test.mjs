/**
 * Agent 对用户说话:send_message 的 to 填 "user"(2026-10-20 用户定:「气泡里面只展示在做什么(harness可能要改,
 * 比如加入send_message(user,xxx)的用法。)」)。
 *
 * - harness 就地答,不经多 Agent 公告板;说过话的这一轮,最后一次空回复不算出错。
 * - 2026-10-19 起「没交收尾汇报就按文字回复代交一份汇报」已撤掉:模型只回了文字时,界面把那段文字当一句「在做什么」画进气泡
 *   (src/ai/userMessages.ts),不再另代交,免得同一段话在气泡和汇报里各出现一次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, isUserMessageCall } from '../harness/agent.mjs';
import { buildTools } from '../harness/tools/index.mjs';
import { createAgentBoard } from '../agent/agent-board.mjs';

const REPORT = { name: 'report_progress', description: 'r', inputSchema: { type: 'object', properties: {} }, async execute(input) { return { ok: true, report: input }; } };
const NOOP = { name: 'noop', description: 'x', inputSchema: { type: 'object', properties: {} }, async execute() { return { ok: true }; } };
const SAY = { name: 'send_message', description: 's', inputSchema: { type: 'object', properties: {}, required: ['to', 'text'] }, async execute() { return { ok: true, shown: true }; } };
function scripted(rounds) {
  let n = 0; const seen = [], systems = [];
  return { seen, systems, get calls() { return n; }, provider: { name: 'fake', async *stream(messages, _tools, system) {
    seen.push(structuredClone(messages)); systems.push(system); const r = rounds[n++] ?? rounds.at(-1);
    if (r.text) yield { type: 'text_delta', text: r.text };
    if (r.say) yield { type: 'tool_use', id: `s${n}`, name: 'send_message', input: { to: 'user', text: r.say } };
    if (r.report) yield { type: 'tool_use', id: `c${n}`, name: 'report_progress', input: r.report };
    if (r.tool) yield { type: 'tool_use', id: `c${n}`, name: 'noop', input: {} };
    yield { type: 'stop', reason: r.stop ?? 'stop' };
  } } };
}
const reports = events => events.filter(e => e.type === 'tool_call' && e.name === 'report_progress');

test('只回文字、没交汇报:不再代交汇报(文字由界面当一句「在做什么」显示),这一轮照常算完成', async () => {
  const s = scripted([{ text: '好' }]);
  const events = [];
  const out = await new Agent({ provider: s.provider, system: 's', tools: [REPORT], onEvent: e => events.push(e) }).run('请只回复一个字：好');
  assert.equal(out.outcome, 'completed'); assert.equal(s.calls, 1);
  assert.equal(reports(events).length, 0, '不代交');
  assert.ok(events.some(e => e.type === 'text' && e.delta === '好'), '文字照常发给界面');
});

test('有 send_message 时,执行规则让模型用它说明在做什么;没有时沿用「用一句话说明」', async () => {
  const a = scripted([{ text: '好' }]);
  await new Agent({ provider: a.provider, system: 's', tools: [REPORT, SAY], onEvent: () => {} }).run('做');
  assert.match(a.systems[0], /send_message（to 填 "user"）/);
  assert.match(a.systems[0], /收尾仍调 final 为 true 的 report_progress/);
  const b = scripted([{ text: '好' }]);
  await new Agent({ provider: b.provider, system: 's', tools: [REPORT], onEvent: () => {} }).run('做');
  assert.doesNotMatch(b.systems[0], /send_message/);
  assert.match(b.systems[0], /每组操作前用一句简短的话说明将做什么/);
});

test('用 send_message 对用户说过话、最后一次没说话:不报「API 没有返回文字」', async () => {
  const s = scripted([{ say: '先加一张标题卡', tool: true, stop: 'tool_use' }, { say: '加好了', stop: 'tool_use' }, { text: '' }]);
  const events = [];
  const out = await new Agent({ provider: s.provider, system: 's', tools: [NOOP, SAY], onEvent: e => events.push(e) }).run('加卡');
  assert.equal(out.outcome, 'completed'); assert.equal(s.calls, 3);
  assert.deepEqual(events.filter(e => e.type === 'tool_call' && e.name === 'send_message').map(e => e.input.text), ['先加一张标题卡', '加好了']);
});

test('工具做完、交了收尾汇报,最后一次没说话:不报「API 没有返回文字」', async () => {
  const s = scripted([{ tool: true, stop: 'tool_use' }, { report: { final: true, done: ['加了一张标题卡'] }, stop: 'tool_use' }, { text: '' }]);
  const events = [];
  const out = await new Agent({ provider: s.provider, system: 's', tools: [REPORT, NOOP], onEvent: e => events.push(e) }).run('加卡');
  assert.equal(out.outcome, 'completed'); assert.equal(s.calls, 3); assert.equal(reports(events).length, 1);
});

test('真的什么都没回(没有文字、没有工具、没交汇报、没说过话):照旧以错误结束', async () => {
  const s = scripted([{ text: '' }]);
  await assert.rejects(new Agent({ provider: s.provider, system: 's', tools: [REPORT, SAY], onEvent: () => {} }).run('做'), /API 没有返回文字或工具调用/);
  assert.equal(s.calls, 1);
});

test('轮数到顶的收尾摘要:不代交汇报,停下的原因照旧写进结局(outcome)与文字', async () => {
  const s = scripted([{ tool: true, stop: 'tool_use' }, { text: '已完成一半' }]);
  const events = [];
  const out = await new Agent({ provider: s.provider, system: 's', tools: [REPORT, NOOP], maxIterations: 1, onEvent: e => events.push(e) }).run('做');
  assert.equal(out.outcome, 'round_limit'); assert.equal(reports(events).length, 0);
  assert.match(out.text, /轮模型往返上限/);
});

test('认得对用户说话的调用:名字可带前缀,收件人只认 user', () => {
  assert.equal(isUserMessageCall('send_message', { to: 'user', text: 'x' }), true);
  assert.equal(isUserMessageCall('mcp__promptcut__send_message', { to: ' User ', text: 'x' }), true);
  assert.equal(isUserMessageCall('send_message', { to: 'cc-1', text: 'x' }), false);
  assert.equal(isUserMessageCall('send_messages', { to: 'user' }), false);
  assert.equal(isUserMessageCall('send_message', null), false);
});

test('buildTools:send_message 发给 user 就地答,不交给 callTool;发给别的 Agent 照旧交给 callTool', async () => {
  const called = [];
  const callTool = async (name, input) => { called.push([name, input?.to]); if (name === 'list_cards' || name === 'list_parts') return []; return { ok: true, delivered: [input?.to] }; };
  const tools = await buildTools({ callTool, workspaceDir: process.cwd(), localTools: false });
  const say = tools.find(t => t.name === 'send_message');
  assert.match(say.description, /to 填 "user" 是对用户说话/);
  assert.deepEqual(await say.execute({ to: 'user', text: '先看画面' }), { ok: true, shown: true, note: '已显示在用户的对话气泡里' });
  assert.equal((await say.execute({ to: 'user', text: '  ' })).ok, false, '空话退回去');
  assert.equal(called.filter(([n]) => n === 'send_message').length, 0, '对用户说的话不经公告板');
  await say.execute({ to: 'cc-other', text: '序列2 我来改' });
  assert.deepEqual(called.filter(([n]) => n === 'send_message'), [['send_message', 'cc-other']]);
});

test('buildTools:开放清单里没有 send_message 时补一个只能发给用户的', async () => {
  const callTool = async () => [];
  const tools = await buildTools({ callTool, workspaceDir: process.cwd(), localTools: false, only: new Set(['report_progress']) });
  const say = tools.find(t => t.name === 'send_message');
  assert.ok(say); assert.deepEqual(say.inputSchema.properties.to.enum, ['user']);
  assert.equal((await say.execute({ to: 'user', text: '好' })).ok, true);
  assert.equal((await say.execute({ to: 'cc-1', text: '好' })).ok, false);
});

test('经 MCP 的路(CLI 驱动、公告板):send_message 发给 user 直接答「已显示」,不投递、不报「没有这个 Agent」', () => {
  const board = createAgentBoard();
  assert.deepEqual(board.sendMessage('cc-me', { to: 'user', text: '先看画面' }), { ok: true, shown: true, note: '已显示在用户的对话气泡里' });
  assert.throws(() => board.sendMessage('cc-me', { to: 'cc-nobody', text: 'x' }), /没有这个 Agent/);
});

test('工具出错时调试信息(debug)与错误码一并交给模型:去掉凭证、截短', async () => {
  const { toolErrorResult, TOOL_DEBUG_CHARS } = await import('../harness/agent.mjs');
  const debug = { card: 'user-card-1', line: 42, stage: 'render', pageError: 'ReferenceError: x is not defined',
    token: 'abc', headers: { Authorization: 'Bearer abcdef123456' }, note: 'key sk-ABCDEFGHIJKLMNOP and ticket v1.AAAAAAAAAAAAAAAAAAAA.BBBB' };
  const r = toolErrorResult(Object.assign(new Error('渲染超时'), { code: 'look-timeout', debug }));
  assert.equal(r.error, '渲染超时'); assert.equal(r.code, 'look-timeout');
  assert.match(r.debug, /user-card-1/); assert.match(r.debug, /"line":42/); assert.match(r.debug, /ReferenceError/);
  assert.doesNotMatch(r.debug, /abcdef123456|sk-ABCDEFGHIJKLMNOP|v1\.AAAA/); assert.doesNotMatch(r.debug, /"token":"abc"/);
  const long = toolErrorResult(Object.assign(new Error('x'), { debug: 'y'.repeat(5000) }));
  assert.ok(long.debug.length < TOOL_DEBUG_CHARS + 40); assert.match(long.debug, /已截断/);
  assert.deepEqual(toolErrorResult(new Error('plain')), { error: 'plain' });

  // 走一遍 Agent:模型拿到的 tool_result 里有 debug
  const BOOM = { name: 'see_frames', description: 'x', inputSchema: { type: 'object', properties: {} },
    async execute() { throw Object.assign(new Error('渲染超时'), { debug: { card: 'c9', line: 7 } }); } };
  let n = 0; const seen = [];
  const provider = { name: 'f', async *stream(messages) { seen.push(structuredClone(messages));
    if (n++ === 0) { yield { type: 'tool_use', id: 'c1', name: 'see_frames', input: {} }; yield { type: 'stop', reason: 'tool_use' }; }
    else { yield { type: 'text_delta', text: '看不了' }; yield { type: 'stop', reason: 'stop' }; } } };
  await new Agent({ provider, system: 's', tools: [BOOM], onEvent: () => {} }).run('看');
  const toolResult = seen[1].flatMap(m => Array.isArray(m.content) ? m.content : []).find(b => b.type === 'tool_result');
  assert.equal(toolResult.is_error, true); assert.match(toolResult.content, /"debug":"\{\\"card\\":\\"c9\\",\\"line\\":7\}"/);
});
