/**
 * "Deep autonomy": round limit is relaxed, and no statements regarding rounds are given to the model.
 *
 * What is monitored here is **the context visible to the model**. Displaying the round number on
 * screen is helpful, but once that same phrase enters history, the model calculates a budget for
 * itself and wraps up prematurely: exactly what enabling this toggle aims to avoid. Therefore,
 * assertions are placed on history, not on progress events.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../harness/agent.mjs';

/** A model that only ever calls tools and never finalizes: use it to push the loop to the limit */
function neverStops() {
  let n = 0;
  return { name: 'never', async *stream() {
    n++;
    yield { type: 'tool_use', id: `call_${n}`, name: 'noop', input: { n } };
    yield { type: 'stop', reason: 'tool_use' };
  } };
}

/**
 * Returns something different each time to avoid "duplicate operation" detection stopping
 * the loop before the limit
 */
const noopTool = {
  name: 'noop',
  inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
  execute: async (input) => ({ ok: true, seq: input.n }),
};

async function runTo(limitOpts) {
  const events = [];
  const agent = new Agent({
    provider: neverStops(),
    system: 's',
    tools: [noopTool],
    onEvent: (e) => events.push(e),
    ...limitOpts,
  });
  const out = await agent.run('Keep going');
  return { out, events, history: out.history.get() };
}

/** All user text in the model's context concatenated into a single string */
const userText = (history) => history
  .filter((m) => m.role === 'user')
  .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text))
  .join('\n');

test('Normal mode: when the limit is reached, explicitly tell the model "the limit of N rounds has been reached"', async () => {
  const { out, history } = await runTo({ maxIterations: 3 });
  assert.equal(out.outcome, 'round_limit');
  assert.match(userText(history), /Reached the limit of 3 model round trips/);
});

test('Deep autonomy: it still wraps up at the limit, but the message does not mention the number of rounds', async () => {
  const { out, history } = await runTo({ maxIterations: 3, deepAuto: true });
  assert.equal(out.outcome, 'round_limit', 'It must still stop and let the model summarize, not silently return an empty result');
  const text = userText(history);
  assert.match(text, /This run has reached its limit/);
  assert.doesNotMatch(text, /round/, 'No mention of rounds should appear in the model context');
  assert.doesNotMatch(text, /3/, 'The specific limit number certainly must not be disclosed to it');
});

test('The deep autonomy limit really is relaxed, not still running at the normal 48 rounds', async () => {
  const { out } = await runTo({ maxIterations: 40, deepAuto: true });
  // Only tops out at 40 rounds: shows maxIterations was actually used, not the constructor default
  assert.equal(out.outcome, 'round_limit');
  assert.equal(out.completed, 40, 'Running noop once per round should complete exactly 40 times');
});

test('The on-screen progress should still show the round; with no round limit, no denominator is written', async () => {
  const { events } = await runTo({ maxIterations: 3, deepAuto: true });
  const req = events.find((e) => e.type === 'progress' && e.phase === 'requesting');
  assert.match(req.text, /Round 1\/3/, 'With a limit, both numerator and denominator are shown to the user');

  const infinite = [];
  const agent = new Agent({
    provider: { name: 'once', async *stream() { yield { type: 'text_delta', text: 'OK' }; yield { type: 'stop', reason: 'end_turn' }; } },
    system: 's', tools: [noopTool], maxIterations: Infinity, deepAuto: true,
    onEvent: (e) => infinite.push(e),
  });
  await agent.run('whatever');
  const first = infinite.find((e) => e.type === 'progress' && e.phase === 'requesting');
  assert.match(first.text, /Round 1/);
  assert.doesNotMatch(first.text, /Infinity|\//, 'With no round limit, do not write Infinity, and do not leave an empty denominator');
});

test('With no round limit the loop has no end: if the model does not wrap up it just keeps running, and only stopping can halt it', async () => {
  const ac = new AbortController();
  let rounds = 0;
  const agent = new Agent({
    provider: { name: 'never', async *stream() {
      // Reaching 60 rounds is treated as "far past the normal limit of 48", then simulate user clicking Stop
      if (++rounds >= 60) ac.abort();
      yield { type: 'tool_use', id: `c${rounds}`, name: 'noop', input: { n: rounds } };
      yield { type: 'stop', reason: 'tool_use' };
    } },
    system: 's', tools: [noopTool], maxIterations: Infinity, deepAuto: true,
    signal: ac.signal,
    onEvent: () => {},
  });
  await assert.rejects(() => agent.run('Keep going'), (e) => e.name === 'AbortError');
  assert.ok(rounds >= 60, `With no round limit it should run straight past the normal 48 rounds, but it only ran ${rounds}`);
});

// ── The "Autonomous rounds" setting itself ──────────────────────────────────
// 0 is a meaningful value (unlimited), so the lower bound must be 0: if someone casually writes
// `v < 1`, entering 0 in settings will be rejected as an invalid value, while the UI explicitly
// states that 0 means unlimited.

async function withConfig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-deep-'));
  const file = path.join(dir, 'ai.json');
  const previous = process.env.PROMPTCUT_AI_CONFIG;
  process.env.PROMPTCUT_AI_CONFIG = file;
  try {
    const mod = await import(`../ai-config.mjs?deep=${encodeURIComponent(file)}`);
    await fn(mod);
  } finally {
    if (previous === undefined) delete process.env.PROMPTCUT_AI_CONFIG;
    else process.env.PROMPTCUT_AI_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Autonomous rounds: default 300, filled in even when an old config lacks this field', async () => {
  await withConfig(async ({ publicConfig }) => {
    assert.equal(publicConfig().deepAutoRounds, 300);
  });
});

test('Autonomous rounds: 0 is valid (meaning unlimited), negative numbers and huge values are not', async () => {
  await withConfig(async ({ writeConfig, publicConfig }) => {
    writeConfig({ deepAutoRounds: 0 });
    assert.equal(publicConfig().deepAutoRounds, 0);
    writeConfig({ deepAutoRounds: 1000 });
    assert.equal(publicConfig().deepAutoRounds, 1000);
    assert.throws(() => writeConfig({ deepAutoRounds: -1 }), /0 to 100000/);
    assert.throws(() => writeConfig({ deepAutoRounds: 100001 }), /0 to 100000/);
    assert.throws(() => writeConfig({ deepAutoRounds: 'many' }), /0 to 100000/);
    assert.equal(publicConfig().deepAutoRounds, 1000, 'An invalid value must not overwrite the stored one');
  });
});
