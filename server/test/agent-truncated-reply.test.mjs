/**
 * Reply truncated upon hitting single-output limit without calling any tool (production run,
 * 2026-10-17: exhausted 4096 tokens and "completed" with 0 operations):
 * Cannot be treated as finished and done; must have the model continue, and explicitly state
 * failure if consecutively truncated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../harness/agent.mjs';

const NOOP = { name: 'noop', description: 'x', inputSchema: { type: 'object', properties: {} }, async execute() { return { ok: true }; } };
function scripted(rounds) {
  let n = 0; const seen = [];
  return { seen, get calls() { return n; }, provider: { name: 'fake', async *stream(messages) {
    seen.push(structuredClone(messages)); const r = rounds[n++] ?? rounds.at(-1);
    if (r.text) yield { type: 'text_delta', text: r.text };
    if (r.tool) yield { type: 'tool_use', id: `c${n}`, name: 'noop', input: {} };
    yield { type: 'stop', reason: r.stop };
  } } };
}

for (const reason of ['length', 'max_tokens', 'MAX_TOKENS']) {
  test(`After truncation (${reason}) the model continues, the events carry a human-readable explanation line, and after finishing it wraps up as usual`, async () => {
    const s = scripted([{ text: 'Let me write a draft first…', stop: reason }, { tool: true, stop: 'tool_use' }, { text: 'Finished', stop: 'end_turn' }]);
    const events = [];
    const out = await new Agent({ provider: s.provider, system: 's', tools: [NOOP], onEvent: e => events.push(e) }).run('Make an animation');
    assert.equal(s.calls, 3);
    assert.equal(out.outcome, 'completed'); assert.equal(out.completed, 1);
    assert.ok(events.some(e => e.type === 'status' && /exceeded the per-output limit and was truncated/.test(e.text)), 'There must be a status line for people to read');
    const second = s.seen[1], last = second.at(-1);
    assert.equal(last.role, 'user'); assert.match(JSON.stringify(last.content), /truncated/, 'The last message of the second request is the one telling the model to continue');
    assert.equal(second.at(-2).role, 'assistant', 'The draft written before the truncation stays in the history, neither duplicated nor lost');
  });
}

test('Not a single word, all spent on thinking and then truncated: continue anyway, without reporting "API returned no text"', async () => {
  const s = scripted([{ stop: 'length' }, { text: 'OK', stop: 'end_turn' }]);
  const out = await new Agent({ provider: s.provider, system: 's', tools: [NOOP], onEvent: () => {} }).run('Do it');
  assert.equal(s.calls, 2); assert.equal(out.outcome, 'completed');
});

test('More than two truncations in a row: say plainly it was not done, end with an error, and make no more requests', async () => {
  const s = scripted([{ text: 'Draft', stop: 'length' }]);
  await assert.rejects(new Agent({ provider: s.provider, system: 's', tools: [NOOP], onEvent: () => {} }).run('Do it'),
    /The model's reply exceeded the single-output limit and was truncated 3 times in a row, so this round could not finish/);
  assert.equal(s.calls, 3);
});

test('If a tool was called in between, the truncation count restarts', async () => {
  const s = scripted([{ stop: 'length' }, { stop: 'length' }, { tool: true, stop: 'tool_use' }, { stop: 'length' }, { stop: 'length' }, { text: 'Done', stop: 'end_turn' }]);
  const out = await new Agent({ provider: s.provider, system: 's', tools: [NOOP], onEvent: () => {} }).run('Do it');
  assert.equal(out.outcome, 'completed'); assert.equal(s.calls, 6);
});

test('The last round is truncated: do not go past the round limit, say plainly it was not done', async () => {
  const s = scripted([{ tool: true, stop: 'tool_use' }, { stop: 'length' }]);
  await assert.rejects(new Agent({ provider: s.provider, system: 's', tools: [NOOP], maxIterations: 2, onEvent: () => {} }).run('Do it'),
    /exceeded the single-output limit and was truncated, so this round could not finish/);
  assert.equal(s.calls, 2);
});

test('A normal finish (stop / end_turn) is unaffected: it wraps up in one pass', async () => {
  const s = scripted([{ text: 'That\'s all', stop: 'end_turn' }]);
  const out = await new Agent({ provider: s.provider, system: 's', tools: [NOOP], onEvent: () => {} }).run('Ask');
  assert.equal(s.calls, 1); assert.equal(out.outcome, 'completed');
});
