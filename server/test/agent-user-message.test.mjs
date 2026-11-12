/**
 * Agent speaks to user: send_message with to set to "user" (user decision, 2026-10-20: "only show
 * what is being done inside the bubble (harness may need changes, such as adding the usage of
 * send_message(user,xxx).)").
 *
 * - harness answers in place without going through multi-Agent bulletin board; in a round where it
 *   spoke, the final empty reply is not treated as an error.
 * - As of 2026-10-19, "submitting a report on its behalf using text reply if no final report was
 *   submitted" was removed: when the model only replied with text, the UI renders that text into
 *   the bubble as "what is being done" (src/ai/userMessages.ts), and no longer submits on its
 *   behalf, preventing the same text from appearing in both the bubble and the report.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, isUserMessageCall } from '../harness/agent.mjs';
import { buildTools } from '../agent/build-promptcut-tools.mjs';
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

test('Text-only reply, no report submitted: the report is no longer submitted on its behalf (the interface shows the text as a "what I\'m doing" line), and this round still counts as complete', async () => {
  const s = scripted([{ text: 'OK' }]);
  const events = [];
  const out = await new Agent({ provider: s.provider, system: 's', tools: [REPORT], onEvent: e => events.push(e) }).run('Please reply with just one word: OK');
  assert.equal(out.outcome, 'completed'); assert.equal(s.calls, 1);
  assert.equal(reports(events).length, 0, 'Not submitted on its behalf');
  assert.ok(events.some(e => e.type === 'text' && e.delta === 'OK'), 'The text is still sent to the interface as usual');
});

test('With send_message, the execution rules tell the model to use it to say what it is doing; without it, keep "state in one sentence"', async () => {
  const a = scripted([{ text: 'OK' }]);
  await new Agent({ provider: a.provider, system: 's', tools: [REPORT, SAY], onEvent: () => {} }).run('Do it');
  assert.match(a.systems[0], /send_message \(set `to` to "user"\)/);
  assert.match(a.systems[0], /Still finish by calling report_progress with final set to true/);
  const b = scripted([{ text: 'OK' }]);
  await new Agent({ provider: b.provider, system: 's', tools: [REPORT], onEvent: () => {} }).run('Do it');
  assert.doesNotMatch(b.systems[0], /send_message/);
  assert.match(b.systems[0], /Before each group of operations, say in one short sentence what you will do/);
});

test('Has spoken to the user via send_message but said nothing on the last turn: do not report "API returned no text"', async () => {
  const s = scripted([{ say: 'Add a title card first', tool: true, stop: 'tool_use' }, { say: 'Added', stop: 'tool_use' }, { text: '' }]);
  const events = [];
  const out = await new Agent({ provider: s.provider, system: 's', tools: [NOOP, SAY], onEvent: e => events.push(e) }).run('Add a card');
  assert.equal(out.outcome, 'completed'); assert.equal(s.calls, 3);
  assert.deepEqual(events.filter(e => e.type === 'tool_call' && e.name === 'send_message').map(e => e.input.text), ['Add a title card first', 'Added']);
});

test('Tools finished and the final report was submitted, silent on the last turn: do not report "API returned no text"', async () => {
  const s = scripted([{ tool: true, stop: 'tool_use' }, { report: { final: true, done: ['Added a title card'] }, stop: 'tool_use' }, { text: '' }]);
  const events = [];
  const out = await new Agent({ provider: s.provider, system: 's', tools: [REPORT, NOOP], onEvent: e => events.push(e) }).run('Add a card');
  assert.equal(out.outcome, 'completed'); assert.equal(s.calls, 3); assert.equal(reports(events).length, 1);
});

test('Truly nothing returned (no text, no tools, no report submitted, nothing said): still ends with an error', async () => {
  const s = scripted([{ text: '' }]);
  await assert.rejects(new Agent({ provider: s.provider, system: 's', tools: [REPORT, SAY], onEvent: () => {} }).run('Do it'), /API returned no text or tool calls/);
  assert.equal(s.calls, 1);
});

test('Wrap-up summary when the round limit is reached: no report is submitted on its behalf, and the reason for stopping is still written into the outcome and the text', async () => {
  const s = scripted([{ tool: true, stop: 'tool_use' }, { text: 'Half of it is done' }]);
  const events = [];
  const out = await new Agent({ provider: s.provider, system: 's', tools: [REPORT, NOOP], maxIterations: 1, onEvent: e => events.push(e) }).run('Do it');
  assert.equal(out.outcome, 'round_limit'); assert.equal(reports(events).length, 0);
  assert.match(out.text, /model round trips/);
});

test('Recognizes a call that speaks to the user: the name may carry a prefix, and only user counts as the recipient', () => {
  assert.equal(isUserMessageCall('send_message', { to: 'user', text: 'x' }), true);
  assert.equal(isUserMessageCall('mcp__promptcut__send_message', { to: ' User ', text: 'x' }), true);
  assert.equal(isUserMessageCall('send_message', { to: 'cc-1', text: 'x' }), false);
  assert.equal(isUserMessageCall('send_messages', { to: 'user' }), false);
  assert.equal(isUserMessageCall('send_message', null), false);
});

test('buildTools: send_message to user is answered in place and not handed to callTool; to another Agent it is still handed to callTool', async () => {
  const called = [];
  const callTool = async (name, input) => { called.push([name, input?.to]); if (name === 'list_cards' || name === 'list_parts') return []; return { ok: true, delivered: [input?.to] }; };
  const tools = await buildTools({ callTool, workspaceDir: process.cwd(), localTools: false });
  const say = tools.find(t => t.name === 'send_message');
  assert.match(say.description, /With to set to "user" you speak to the user/);
  assert.deepEqual(await say.execute({ to: 'user', text: 'Let me look at the picture first' }), { ok: true, shown: true, note: 'Shown in the user\'s chat bubble' });
  assert.equal((await say.execute({ to: 'user', text: '  ' })).ok, false, 'Empty text is rejected');
  assert.equal(called.filter(([n]) => n === 'send_message').length, 0, 'Messages to the user do not go through the bulletin board');
  await say.execute({ to: 'cc-other', text: 'Track 2, I\'ll edit it' });
  assert.deepEqual(called.filter(([n]) => n === 'send_message'), [['send_message', 'cc-other']]);
});

test('buildTools: when the open list has no send_message, add one that can only send to the user', async () => {
  const callTool = async () => [];
  const tools = await buildTools({ callTool, workspaceDir: process.cwd(), localTools: false, only: new Set(['report_progress']) });
  const say = tools.find(t => t.name === 'send_message');
  assert.ok(say); assert.deepEqual(say.inputSchema.properties.to.enum, ['user']);
  assert.equal((await say.execute({ to: 'user', text: 'OK' })).ok, true);
  assert.equal((await say.execute({ to: 'cc-1', text: 'OK' })).ok, false);
});

test('Via the MCP route (CLI driver, bulletin board): send_message to user answers "Shown" directly, without delivering and without reporting "No such Agent"', () => {
  const board = createAgentBoard();
  assert.deepEqual(board.sendMessage('cc-me', { to: 'user', text: 'Let me look at the picture first' }), { ok: true, shown: true, note: 'Shown in the user\'s chat bubble' });
  assert.throws(() => board.sendMessage('cc-me', { to: 'cc-nobody', text: 'x' }), /No such Agent/);
});

test('When a tool fails, the debug info (debug) and the error code are handed to the model together, with credentials stripped and truncated', async () => {
  const { toolErrorResult, TOOL_DEBUG_CHARS } = await import('../harness/agent.mjs');
  const debug = { card: 'user-card-1', line: 42, stage: 'render', pageError: 'ReferenceError: x is not defined',
    token: 'abc', headers: { Authorization: 'Bearer abcdef123456' }, note: 'key sk-ABCDEFGHIJKLMNOP and ticket v1.AAAAAAAAAAAAAAAAAAAA.BBBB' };
  const r = toolErrorResult(Object.assign(new Error('Render timed out'), { code: 'look-timeout', debug }));
  assert.equal(r.error, 'Render timed out'); assert.equal(r.code, 'look-timeout');
  assert.match(r.debug, /user-card-1/); assert.match(r.debug, /"line":42/); assert.match(r.debug, /ReferenceError/);
  assert.doesNotMatch(r.debug, /abcdef123456|sk-ABCDEFGHIJKLMNOP|v1\.AAAA/); assert.doesNotMatch(r.debug, /"token":"abc"/);
  const long = toolErrorResult(Object.assign(new Error('x'), { debug: 'y'.repeat(5000) }));
  assert.ok(long.debug.length < TOOL_DEBUG_CHARS + 40); assert.match(long.debug, /truncated/);
  assert.deepEqual(toolErrorResult(new Error('plain')), { error: 'plain' });

  // Run through Agent once: tool_result received by model contains debug
  const BOOM = { name: 'see_frames', description: 'x', inputSchema: { type: 'object', properties: {} },
    async execute() { throw Object.assign(new Error('Render timed out'), { debug: { card: 'c9', line: 7 } }); } };
  let n = 0; const seen = [];
  const provider = { name: 'f', async *stream(messages) { seen.push(structuredClone(messages));
    if (n++ === 0) { yield { type: 'tool_use', id: 'c1', name: 'see_frames', input: {} }; yield { type: 'stop', reason: 'tool_use' }; }
    else { yield { type: 'text_delta', text: 'Can\'t see it' }; yield { type: 'stop', reason: 'stop' }; } } };
  await new Agent({ provider, system: 's', tools: [BOOM], onEvent: () => {} }).run('Look');
  const toolResult = seen[1].flatMap(m => Array.isArray(m.content) ? m.content : []).find(b => b.type === 'tool_result');
  assert.equal(toolResult.is_error, true); assert.match(toolResult.content, /"debug":"\{\\"card\\":\\"c9\\",\\"line\\":7\}"/);
});
