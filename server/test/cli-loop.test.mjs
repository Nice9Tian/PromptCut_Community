/**
 * Review loop via CLI (runners/cli-loop.mjs): spawns a CLI once per role turn, extracts
 * conclusions from the code block at the end of the reply, and enforces read-only via server
 * locks. Here a mock runner with scripted lines per role replaces agy without spawning real
 * processes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCliLoop, parseSubmission, submitFormat } from '../runners/cli-loop.mjs';

const block = (name, obj) => `OK.\n\`\`\`${name}\n${JSON.stringify(obj)}\n\`\`\``;
const roleOf = (sys) => sys.startsWith('You are the judger (judge) of this video') ? 'judger' : sys.startsWith('You are the reviewer') ? 'reviewer' : 'worker';

/** Mock runner: emits lines by role; sends session, text, and done on each call, just like agy */
function fakeCli(lines, calls) {
  const q = { judger: [...(lines.judger || [])], worker: [...(lines.worker || [])], reviewer: [...(lines.reviewer || [])] };
  let n = 0;
  return (opts) => {
    const role = roleOf(opts.systemPrompt);
    const say = q[role].shift();
    calls.push({ role, sessionId: opts.sessionId, systemPrompt: opts.systemPrompt, prompt: opts.prompt });
    const done = (async () => {
      await null;
      const sid = opts.sessionId || `${role}-conv-${++n}`;
      opts.onEvent({ type: 'session', sessionId: sid });
      if (say === undefined) { opts.onEvent({ type: 'error', message: `${role} has run out of scripted lines` }); return; }
      if (say?.error) { opts.onEvent({ type: 'error', ...say.error }); return; }
      opts.onEvent({ type: 'tool_call', name: 'get_project', input: {} });
      opts.onEvent({ type: 'text', delta: say });
      opts.onEvent({ type: 'done', sessionId: sid, usage: { input_tokens: 100, output_tokens: 10 } });
    })();
    return { abort() {}, done };
  };
}

async function run(lines) {
  const calls = [], events = [], locks = [];
  const r = startCliLoop({
    provider: 'agy', prompt: 'Add three cards', systemPrompt: 'Editor system prompt', cwd: '.', reviewLoop: true,
    setToolAccess: (l) => locks.push(l === null ? null : [...l]),
    onEvent: (e) => events.push(e),
  }, fakeCli(lines, calls), { lessonsStore: { read: () => [], add() {} } });
  await r.done;
  return { calls, events, locks };
}

test('Conclusion block: take the last valid one; broken JSON or missing required fields do not count', () => {
  assert.deepEqual(parseSubmission(block('phase_done', { summary: 'All met' }), ['phase_done']), { name: 'phase_done', input: { summary: 'All met' } });
  assert.equal(parseSubmission('```phase_done\n{broken}\n```', ['phase_done']), null);
  assert.equal(parseSubmission(block('phase_done', {}), ['phase_done']), null, 'Missing summary');
  assert.equal(parseSubmission(block('phase_done', { summary: 'x' }), ['issue_plan']), null, 'phase_done may not be submitted this turn');
  const two = block('request_revision', { rulings: [], requirements: 'One' }) + '\n' + block('request_revision', { rulings: [], requirements: 'Two' });
  assert.equal(parseSubmission(two, ['request_revision']).input.requirements, 'Two');
});

test('The instructions for submitting a conclusion state "not a tool" clearly and give the fields', () => {
  const s = submitFormat(['request_revision']);
  assert.match(s, /not tools/);
  assert.match(s, /rulings/);
  assert.match(s, /Accept \/ Reject \/ downgrade/);
});

test('Full loop run: the judger/reviewer turns take the read-only lock, the worker turn unlocks, and it always unlocks at the end; inner done/session do not leak out', async () => {
  const { events, locks, calls } = await run({
    judger: [block('issue_plan', { requirements: 'Requirement A', reviewerBrief: 'Check X' }), block('phase_done', { summary: 'All four are backed by evidence' })],
    worker: ['Delivery: did A'],
    reviewer: [block('submit_review', { opinions: [] })],
  });
  const done = events.filter((e) => e.type === 'done');
  assert.equal(done.length, 1, 'There can be only the loop\'s final done');
  assert.equal(done[0].outcome, 'passed');
  assert.ok(!events.some((e) => e.type === 'session'), 'A role turn\'s session id must not leak to the frontend');
  assert.ok(events.some((e) => e.type === 'status' && /judger: passed/.test(e.text)));
  // judger starts read-only → unlock → worker fully open (null) → reviewer read-only →
  // judger read-only, unlocked after each turn
  const readonly = (l) => Array.isArray(l) && l.includes('see_frames') && !l.includes('add_clip');
  assert.ok(readonly(locks[0]), 'The judger opens with the read-only lock');
  assert.equal(locks.at(-1), null, 'Must be unlocked at the end');
  const workerCall = calls.find((c) => c.role === 'worker');
  assert.match(workerCall.prompt, /Requirement A/, 'The worker receives the judger\'s requirements');
  assert.ok(!calls.find((c) => c.role === 'judger').sessionId, 'The judger opens with a new session');
});

test('judger submitted no conclusion: nudge it once in its own session', async () => {
  const { calls, events } = await run({
    judger: [block('issue_plan', { requirements: 'A', reviewerBrief: 'X' }), 'I think it\'s fine', block('phase_done', { summary: 'ok' })],
    worker: ['Delivery'],
    reviewer: [block('submit_review', { opinions: [{ issue: 'Minor issue', evidence: 't=1' }] })],
  });
  const judgerCalls = calls.filter((c) => c.role === 'judger');
  assert.equal(judgerCalls.length, 3);
  assert.ok(judgerCalls[2].sessionId, 'The nudge must carry the session id');
  assert.match(judgerCalls[2].prompt, /not submitted your conclusion as required/);
  assert.equal(events.find((e) => e.type === 'done').outcome, 'passed');
});

test('Resumable errors: retry in the same session; non-resumable errors end the loop and report the error', async () => {
  const ok = await run({
    judger: [{ error: { message: 'Rejected', retryable: true, retryPrompt: 'Continue' } }, block('issue_plan', { requirements: 'A', reviewerBrief: 'X' }), block('phase_done', { summary: 'ok' })],
    worker: ['Delivery'], reviewer: [block('submit_review', { opinions: [] })],
  });
  assert.equal(ok.events.find((e) => e.type === 'done').outcome, 'passed');
  assert.ok(ok.events.some((e) => e.type === 'status' && /retry/.test(e.text)));

  const bad = await run({ judger: [{ error: { message: 'Wrong model name' } }] });
  assert.ok(bad.events.some((e) => e.type === 'error' && /Wrong model name/.test(e.message)));
  assert.equal(bad.locks.at(-1), null, 'Must unlock even on error');
});

/*
 * Live run: worker was rejected all three times by agy's built-in tools (list_dir /
 * read_url_content / grep_search), and threw once retries were exhausted, ending the entire
 * loop with an error: the requirements set by judger and the project edits made by worker
 * were all wasted.
 */
const denied = { error: { message: 'Antigravity denied its own built-in tool (GrepSearch)', retryable: true, retryPrompt: 'Continue' } };

test('worker still interrupted after retries are used up: the loop is not voided, the changes go to the reviewer / judger to verify, counted as one non-pass', async () => {
  const { events, calls } = await run({
    judger: [block('issue_plan', { requirements: 'A', reviewerBrief: 'X' }),
      block('request_revision', { rulings: [], requirements: 'Go on and finish A' }), block('phase_done', { summary: 'ok' })],
    worker: [denied, denied, denied, 'Delivery: A is done'],
    reviewer: [block('submit_review', { opinions: [] }), block('submit_review', { opinions: [] })],
  });
  assert.ok(!events.some((e) => e.type === 'error'), 'Must not end with an error');
  assert.equal(events.find((e) => e.type === 'done').outcome, 'passed');
  assert.ok(events.some((e) => e.type === 'status' && /still interrupted after using up its retries/.test(e.text)));
  const reviewer = calls.find((c) => c.role === 'reviewer');
  assert.match(reviewer.prompt, /interrupted by technical causes[\s\S]*GrepSearch/, 'The reviewer must know this delivery was interrupted, and why');
  const workers = calls.filter((c) => c.role === 'worker');
  assert.equal(workers.length, 4, 'Three attempts + one new attempt in the next round');
  assert.ok(!workers[3].sessionId, 'The next round\'s worker is a new session');
});

test('worker interrupted two rounds in a row: stop and wrap up normally (not as an error), stating the reason', async () => {
  const { events } = await run({
    judger: [block('issue_plan', { requirements: 'A', reviewerBrief: 'X' }), block('request_revision', { rulings: [], requirements: 'A' })],
    worker: Array(6).fill(denied),
    reviewer: [block('submit_review', { opinions: [] })],
  });
  assert.ok(!events.some((e) => e.type === 'error'));
  assert.equal(events.find((e) => e.type === 'done').outcome, 'interrupted');
  assert.ok(events.some((e) => e.type === 'text' && /interrupted by technical causes for 2 rounds in a row[\s\S]*GrepSearch/.test(e.delta)));
});

test('reviewer still interrupted after retries are used up: the judger is told to verify on its own, rather than treating it as "no opinions"', async () => {
  const { events, calls } = await run({
    judger: [block('issue_plan', { requirements: 'A', reviewerBrief: 'X' }), block('phase_done', { summary: 'ok' })],
    worker: ['Delivery'],
    reviewer: [denied, denied, denied],
  });
  assert.equal(events.find((e) => e.type === 'done').outcome, 'passed');
  assert.match(calls.filter((c) => c.role === 'judger')[1].prompt, /reviewer was interrupted this round for technical reasons/);
});
