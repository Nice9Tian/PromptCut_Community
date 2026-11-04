/**
 * Various paths of the review loop (harness/loop.mjs). Models are all mock providers with scripted
 * lines by role, making no network calls.
 *
 * Things monitored: only judger can declare completion; worker sees the user's original words
 * every round; switch to reflection after three failures, with no tools provided during reflection;
 * rewritten lessons from judger are saved; reflect early when stuck; stop and hand over to the user
 * if neither batch passes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runReviewLoop, presentLoopEvent } from '../harness/loop.mjs';

const USER = 'Add motion graphics to this narration, within thirty seconds';

/** Lines for a role: emit one on each "new round of requests"; reply "OK" to wrap up right after executing tools */
function scripted(role, actions, calls) {
  const queue = [...actions];
  let n = 0;
  return {
    name: role,
    async *stream(messages, tools, system) {
      const last = messages[messages.length - 1];
      const afterTool = last?.role === 'user' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
      calls.push({ role, messages: JSON.parse(JSON.stringify(messages)), tools: tools.map((t) => t.name), system, afterTool });
      if (afterTool) { yield { type: 'text_delta', text: 'OK' }; yield { type: 'stop', reason: 'end_turn' }; return; }
      const a = queue.shift();
      if (!a) throw new Error(`${role} has run out of scripted lines`);
      if (a.abort) { a.abort(); yield { type: 'text_delta', text: '…' }; yield { type: 'stop', reason: 'end_turn' }; return; }
      if (a.tool) { yield { type: 'tool_use', id: `${role}-${++n}`, name: a.tool, input: a.input }; yield { type: 'stop', reason: 'tool_use' }; return; }
      yield { type: 'text_delta', text: a.text }; yield { type: 'stop', reason: 'end_turn' };
    },
  };
}

const tool = (name) => ({ name, inputSchema: { type: 'object', properties: {} }, execute: async () => ({ ok: true }) });
const TOOLS = [tool('get_project'), tool('see_frames'), tool('add_clip'), tool('think')];

const plan = (req = 'Requirement A', lessons) => ({ tool: 'issue_plan', input: { requirements: req, reviewerBrief: 'Check item X', ...(lessons ? { lessons } : {}) } });
const done = { tool: 'phase_done', input: { summary: 'All four are backed by evidence' } };
const revise = (op, req) => ({ tool: 'request_revision', input: { rulings: [{ opinion: op, verdict: 'Accept', reason: 'holds' }], requirements: req || `Revise ${op}` } });
const review = (issue = 'Card 3 template is repetitive') => ({ tool: 'submit_review', input: { opinions: [{ issue, evidence: 'list_cards' }] } });
const deliver = (s = 'Delivery: did A') => ({ text: s });

async function run({ judger, worker, reviewer, lessons = [], signal }) {
  const calls = [];
  const events = [];
  const saved = [];
  const out = await runReviewLoop({
    providers: { judger: scripted('judger', judger, calls), worker: scripted('worker', worker, calls), reviewer: scripted('reviewer', reviewer, calls) },
    tools: TOOLS, system: 'Editor system prompt', userText: USER, signal,
    lessonsStore: { read: () => lessons, add: (l) => saved.push(...l) },
    onEvent: (e) => events.push(e),
  });
  const first = (role) => calls.filter((c) => c.role === role && !c.afterTool);
  return { out, calls, events, saved, first };
}

test('Passes on the first try: judger opens → worker → reviewer → judger rules phase_done', async () => {
  const { out, first } = await run({ judger: [plan(), done], worker: [deliver()], reviewer: [review()] });
  assert.equal(out.outcome, 'passed');
  assert.match(out.text, /All four are backed by evidence/);
  const w = first('worker')[0];
  assert.match(JSON.stringify(w.messages), new RegExp(USER), 'The worker must be able to see the user\'s original words');
  assert.match(JSON.stringify(w.messages), /Requirement A/, 'The worker must be able to see the judger\'s requirements');
  assert.ok(!w.tools.includes('phase_done'), 'The worker must not have phase_done');
  const r = first('reviewer')[0];
  assert.ok(!r.tools.includes('add_clip'), 'The reviewer can only get read-only tools');
  assert.ok(r.tools.includes('see_frames') && r.tools.includes('submit_review'));
});

test('Fails once then passes: in the second round the worker gets the requirements as revised by the judger, and a fresh history', async () => {
  const { out, first } = await run({
    judger: [plan(), revise('Card 3 template is repetitive', 'Replace card 3 with a different kind of card'), done],
    worker: [deliver(), deliver('Delivery: replaced card 3')],
    reviewer: [review(), review('none')],
  });
  assert.equal(out.outcome, 'passed');
  const second = first('worker')[1];
  assert.match(JSON.stringify(second.messages), /Replace card 3 with a different kind of card/);
  assert.equal(second.messages.length, 1, 'Every round the worker gets a fresh history, with only this round\'s task description');
});

test('Three failures → reflection (no tools) → judger rewrites → passes; the approved lessons are saved', async () => {
  const { out, calls, saved, first } = await run({
    judger: [plan(), revise('Issue one'), revise('Issue two'), revise('Issue three'), plan('New requirements', ['Look at the picture before laying out cards']), done],
    worker: [deliver(), deliver(), deliver(), { text: 'Reflection: laid out cards without looking at the picture' }, deliver('Delivery: done per the new requirements')],
    reviewer: [review(), review(), review(), review()],
  });
  assert.equal(out.outcome, 'passed');
  const reflect = first('worker')[3];
  assert.deepEqual(reflect.tools, [], 'The reflection round gets no tools');
  assert.match(JSON.stringify(reflect.messages), /Issue one[\s\S]*Issue two[\s\S]*Issue three/, 'The reflection must see all three rulings');
  const rewrite = calls.filter((c) => c.role === 'judger' && !c.afterTool)[4];
  assert.match(JSON.stringify(rewrite.messages), /laid out cards without looking at the picture/, 'When the judger rewrites, it must see the reflection');
  assert.match(JSON.stringify(first('worker')[4].messages), /Look at the picture before laying out cards/, 'The lesson must be handed to later workers');
  assert.deepEqual(saved, ['Look at the picture before laying out cards']);
});

test('judger gives no ruling: nudge once; if it still does not hand one in after the nudge, count it as not passed and the worker gets another round', async () => {
  const { out, events, first } = await run({
    judger: [plan(), { text: 'I think it\'s fine' }, { text: 'Hmm' }, done],
    worker: [deliver(), deliver()],
    reviewer: [review(), review()],
  });
  assert.equal(out.outcome, 'passed');
  assert.equal(first('worker').length, 2);
  assert.ok(events.some((e) => e.type === 'loop' && e.stage === 'verdict' && e.verdict === 'none'));
});

test('Stuck: when two consecutive rulings show the same gap, reflect without waiting for the third', async () => {
  const { out, first } = await run({
    judger: [plan(), revise('The same issue'), revise('The same issue'), plan('Different requirements'), done],
    worker: [deliver(), deliver(), { text: 'Reflection' }, deliver()],
    reviewer: [review(), review(), review()],
  });
  assert.equal(out.outcome, 'passed');
  assert.deepEqual(first('worker')[2].tools, [], 'The third worker call should be the reflection');
});

test('Both batches failed: stop after the second reflection and hand both reflections to the user', async () => {
  const { out } = await run({
    judger: [plan(), revise('One'), revise('Two'), revise('three'), plan('rewrite'), revise('four'), revise('five'), revise('six')],
    worker: [deliver(), deliver(), deliver(), { text: 'Contents of the first reflection' }, deliver(), deliver(), deliver(), { text: 'Contents of the second reflection' }],
    reviewer: Array(6).fill(0).map(() => review()),
  });
  assert.equal(out.outcome, 'exhausted');
  assert.match(out.text, /Contents of the first reflection[\s\S]*Contents of the second reflection/);
});

test('Chat panel display: rulings become status lines listed one by one, reviewer/judger speech goes into the thinking area, and worker speech goes into the body', () => {
  const [st] = presentLoopEvent({ type: 'loop', stage: 'verdict', role: 'judger', verdict: 'request_revision',
    input: { rulings: [{ opinion: 'Card 3 is repetitive', verdict: 'Accept', reason: 'holds' }, { opinion: 'Swap the score', verdict: 'Reject', reason: 'can\'t be changed' }] } });
  assert.equal(st.type, 'status');
  assert.match(st.text, /1 accepted, 0 downgraded, 1 rejected/);
  assert.match(st.text, /\[Reject\] Swap the score —— can't be changed/);
  assert.equal(presentLoopEvent({ type: 'text', role: 'judger', delta: 'Let me take a look' })[0].type, 'thinking');
  assert.equal(presentLoopEvent({ type: 'text', role: 'worker', delta: 'Delivery' })[0].type, 'text');
  assert.match(presentLoopEvent({ type: 'progress', role: 'reviewer', text: 'Round 1' })[0].text, /^reviewer · Round 1/);
  assert.deepEqual(presentLoopEvent({ type: 'loop', stage: 'done', outcome: 'passed' }), [], 'The end does not start a separate status line, the conclusion goes in the body');
  // Seen in actual runs: no item-by-item rulings, judger checks on its own and requests rework:
  // must lay out the requirements, cannot just write "0 items accepted"
  const [own] = presentLoopEvent({ type: 'loop', stage: 'verdict', role: 'judger', verdict: 'request_revision',
    input: { rulings: [], requirements: 'worker must actually call tools to carry out the fixes\n1. Remove all redundant cards' } });
  assert.match(own.text, /checked on its own and requested rework/);
  assert.match(own.text, /worker must actually call tools to carry out the fixes/);
  assert.equal(presentLoopEvent({ type: 'loop', stage: 'judging', role: 'judger' })[0].text, 'judger is ruling on the reviewer\'s opinions one by one');
});

test('Gateway timeout: retry on the same history without voiding the whole loop; only surface the error once the retries are used up', async () => {
  const flaky = (inner, fails) => {
    let left = fails;
    return { name: 'flaky', async *stream(...a) {
      if (left-- > 0) throw Object.assign(new Error('The operation was aborted due to timeout (no data received for 120 seconds)'), { name: 'TimeoutError' });
      yield* inner.stream(...a);
    } };
  };
  const calls = [], events = [];
  const out = await runReviewLoop({
    providers: {
      judger: scripted('judger', [plan(), done], calls),
      worker: flaky(scripted('worker', [deliver()], calls), 1),
      reviewer: scripted('reviewer', [review()], calls),
    },
    tools: TOOLS, system: 's', userText: USER, onEvent: (e) => events.push(e),
  });
  assert.equal(out.outcome, 'passed', 'Should keep running to completion after one timeout');
  assert.ok(events.some((e) => e.type === 'loop' && e.stage === 'retry' && e.role === 'worker'));
  assert.match(presentLoopEvent({ type: 'loop', stage: 'retry', role: 'worker', attempt: 1 })[0].text, /the request gateway timed out/);

  await assert.rejects(() => runReviewLoop({
    providers: { judger: flaky(scripted('judger', [plan()], []), 5) },
    tools: TOOLS, system: 's', userText: USER,
  }), /timeout/, 'When retries are used up and it still times out, hand it to the upper layer (api.mjs will mark it as resumable)');
});

test('Stop clicked in the middle of a review: the whole loop throws AbortError', async () => {
  const ac = new AbortController();
  await assert.rejects(() => run({
    judger: [plan()], worker: [deliver()], reviewer: [{ abort: () => ac.abort() }], signal: ac.signal,
  }), (e) => e.name === 'AbortError');
});
