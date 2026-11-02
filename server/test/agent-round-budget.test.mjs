/**
 * Two general gates (user decision, 2026-10-24; background in docs/plan/agent-blind-stop.md):
 *
 * 1. **Round budget notice**: "Round N/M" on the screen does not enter model context, so the model
 *    works as if "time is infinite": in one actual run it spent 18 rounds polishing a card's
 *    source code, hitting the limit without calling `create_card` even once, and the timeline
 *    was empty. Reminds once when past half and once when only one quarter is left. Nothing sent
 *    under deepAuto (the entire point of that toggle is not to discuss rounds with the model).
 * 2. **Same tool + same error chained together**: hard prompt on the 2nd time, stop on the 3rd.
 *    Existing repeat detection calculates by whole-round fingerprint, and as long as there are
 *    other calls in a round the fingerprint differs, failing to stop "repeatedly asking for the
 *    same capability".
 *
 * Assertions all fall on **the context visible to the model** (history), not on progress
 * events: same reason as deep-auto.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, failureKey } from '../harness/agent.mjs';

/** Always only calls tools, never finishes: pushes the loop to the limit. Different input per round avoids whole-round repeat detection */
function neverStops(toolName = 'noop') {
  let n = 0;
  return { name: 'never', async *stream() {
    n++;
    yield { type: 'tool_use', id: `call_${n}`, name: toolName, input: { n } };
    yield { type: 'stop', reason: 'tool_use' };
  } };
}

const noopTool = {
  name: 'noop',
  inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
  execute: async (input) => ({ ok: true, seq: input.n }),
};

/** A tool that always fails with the same code: simulates "this capability is unavailable this time" */
const deadTool = {
  name: 'see_frames',
  inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
  execute: async () => ({ ok: false, code: 'media-fetch-failed', error: 'This cloud node cannot read the bytes of the project media right now, retrying won\'t help.' }),
};

const userText = (history) => history
  .filter((m) => m.role === 'user')
  .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text))
  .join('\n');

async function run(opts, tools = [noopTool], provider = neverStops()) {
  const events = [];
  const agent = new Agent({ provider, system: 's', tools, onEvent: (e) => events.push(e), ...opts });
  const out = await agent.run('Keep going');
  return { out, events, text: userText(out.history.get()) };
}

const count = (text, re) => (text.match(re) ?? []).length;

// ── Round budget notice ───────────────────────────────────────────────

test('remind once at the halfway point and once when only a quarter is left, each sent only once', async () => {
  const { text } = await run({ maxIterations: 8 });
  // 8 rounds: half line is 4 rounds left (end of round 4), one-quarter line is 2 rounds left (end of round 6)
  assert.match(text, /4 model round trips left \(/);
  assert.match(text, /Only 2 model round trips left/);
  assert.equal(count(text, /\d+ model round trips left \(/g), 1, 'the halfway hint is sent only once');
  assert.equal(count(text, /Only \d+ model round trips left/g), 1, 'the quarter hint is sent only once');
  assert.match(text, /first land the smallest deliverable version in the project/);
  assert.match(text, /card source in a code block → create_card → add_clip/);
});

test('the budget hint is not written into the last round: that round is meant to wrap up anyway', async () => {
  const { out, text } = await run({ maxIterations: 4 });
  assert.equal(out.outcome, 'round_limit');
  // 4 rounds: half line leaves 2 rounds (end of round 2), one-quarter line leaves 1 round (end of round 3); at end of round 4 left is 0, not mentioned
  assert.match(text, /2 model round trips left \(/);
  assert.match(text, /Only 1 model round trips left/);
  assert.match(text, /Reached the limit of 4 model round trips/);
});

test('deep autonomy: no budget hint is sent at all, and no mention of rounds appears in the context', async () => {
  const { out, text } = await run({ maxIterations: 8, deepAuto: true });
  assert.equal(out.outcome, 'round_limit');
  assert.doesNotMatch(text, /round/, 'the whole point of deepAuto is to not talk to the model about rounds');
});

test('unlimited rounds: there is no denominator to compute with, so no budget hints are sent', async () => {
  let rounds = 0;
  const ac = new AbortController();
  const provider = { name: 'never', async *stream() {
    if (++rounds >= 12) ac.abort();
    yield { type: 'tool_use', id: `c${rounds}`, name: 'noop', input: { n: rounds } };
    yield { type: 'stop', reason: 'tool_use' };
  } };
  const agent = new Agent({ provider, system: 's', tools: [noopTool], maxIterations: Infinity, signal: ac.signal, onEvent: () => {} });
  await assert.rejects(() => agent.run('Keep going'), (e) => e.name === 'AbortError');
  assert.doesNotMatch(userText(agent.history.get()), /model round trips/);
});

// ── Same tool + same error chained together ──────────────────────────────

test('the same error 2 times in a row: give a hard hint that names the capability as unavailable this time and offers two options', async () => {
  const { text } = await run({ maxIterations: 2 }, [deadTool], neverStops('see_frames'));
  assert.match(text, /see_frames failed 2 times in a row with the same error/);
  assert.match(text, /Do not call it a 3rd time with the same arguments/);
  assert.match(text, /hard prerequisite/, 'must point back to the criterion in the decision table in the prompt');
  assert.match(text, /report_progress/);
  assert.match(text, /cannot read the bytes of the project media/, 'the original wording must be included so the model knows which problem it is');
});

test('the same error 3 times in a row: stop right away, and the stop reason names that tool', async () => {
  const { out } = await run({ maxIterations: 20 }, [deadTool], neverStops('see_frames'));
  assert.equal(out.outcome, 'stalled');
  assert.match(out.text, /see_frames failed 3 times in a row with the same error/);
  assert.equal(out.failed, 3, 'after the 3rd time it stops calling');
});

test('one success in between breaks the streak: no hard hint, no stop', async () => {
  // Fail, fail, succeed, fail: send a hard prompt once in round 2, reset afterward, should not stop
  const script = [false, false, true, false, true, true];
  let n = 0;
  const flaky = {
    name: 'see_frames',
    inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
    execute: async () => (script[n++] ? { ok: true } : { ok: false, code: 'media-fetch-failed', error: 'Cannot read' }),
  };
  const { out } = await run({ maxIterations: 6 }, [flaky], neverStops('see_frames'));
  assert.equal(out.outcome, 'round_limit', 'must not be stopped as a futile retry');
});

test('the two failures have different problems: not counted as consecutive', async () => {
  let n = 0;
  const twoFaults = {
    name: 'see_frames',
    inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
    execute: async () => ({ ok: false, code: n++ === 0 ? 'media-fetch-failed' : 'asset-missing', error: 'x' }),
  };
  const { out, text } = await run({ maxIterations: 2 }, [twoFaults], neverStops('see_frames'));
  assert.equal(out.outcome, 'round_limit');
  assert.doesNotMatch(text, /failed 2 times in a row/);
});

test('failure identity: prefer the code, fall back to the error text when there is no code, and count it as unknown when there is neither', () => {
  assert.equal(failureKey('t', { ok: false, code: 'c1', error: 'e' }), 't\u0000c1');
  assert.equal(failureKey('t', { ok: false, error: 'Missing required parameter x' }), 't\u0000Missing required parameter x');
  assert.notEqual(failureKey('t', { error: 'Missing required parameter x' }), failureKey('t', { error: 'Missing required parameter y' }), 'errors that carry specific parameters should naturally count as different problems');
  assert.equal(failureKey('t', 'plain text'), 't\u0000plain text');
  assert.equal(failureKey('t', null), 't\u0000unknown');
  assert.notEqual(failureKey('a', { code: 'c' }), failureKey('b', { code: 'c' }), 'different tools are not the same problem');
});
