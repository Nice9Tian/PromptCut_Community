/**
 * Truncate by actual token count: once context is full, truncation no longer relies on guessing
 * tokens by "character count ÷ 3", but looks at the input reported back by the API in each round.
 * Chinese is roughly one token per character, so guessing by character count underestimates by 3x.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageHistory } from '../harness/history.mjs';
import { Agent } from '../harness/agent.mjs';

const longTurns = (n, text) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `${i}:${text}` }] }));

test('fitTokens: if the reported token count is within budget, nothing is touched', () => {
  const h = MessageHistory.fromJSON(longTurns(20, 'x'.repeat(2000)), { maxChars: Infinity });
  h.fitTokens(500_000, 900_000);
  assert.equal(h.get().length, 20);
});

test('fitTokens: when over budget, trim by the measured ratio; after trimming, the character count falls within the amount that corresponds to the budget', () => {
  const h = MessageHistory.fromJSON(longTurns(40, 'x'.repeat(2000)), { maxChars: Infinity });
  const before = h.size();
  h.fitTokens(1_200_000, 900_000);
  assert.ok(h.get().length < 40, 'should have been trimmed');
  assert.ok(h.size() <= before * (900_000 / 1_200_000) * 0.9, 'still over after trimming');
});

test('keeps 10 screenshots by default', () => {
  const h = new MessageHistory();
  for (let i = 0; i < 12; i++) h.append({ role: 'user', content: [{ type: 'image', mime: 'image/png', data: 'A'.repeat(5000) }] });
  h.pruneImages();
  const kept = h.get().filter((m) => m.content[0].type === 'image').length;
  assert.equal(kept, 10);
});

test('Agent: when maxInputTokens is given, trim by the reported input, and the user\'s original request is kept', async () => {
  const history = MessageHistory.fromJSON([], { maxChars: Infinity });
  let n = 0;
  const provider = { name: 'fake', async *stream() {
    n++;
    // The first three rounds keep calling tools, with input reported each round getting larger;
    // round 3 exceeds budget
    if (n <= 3) {
      yield { type: 'tool_use', id: `c${n}`, name: 'noop', input: { n } };
      yield { type: 'usage', input: n * 400_000, output: 10 };
      yield { type: 'stop', reason: 'tool_use' };
    } else {
      yield { type: 'text_delta', text: 'Finished' };
      yield { type: 'usage', input: 100, output: 3 };
      yield { type: 'stop', reason: 'end_turn' };
    }
  } };
  const noop = { name: 'noop', inputSchema: { type: 'object', properties: {} }, execute: async (i) => ({ ok: true, big: 'x'.repeat(20000), n: i.n }) };
  const agent = new Agent({ provider, system: 's', tools: [noop], maxInputTokens: 900_000, history, onEvent: () => {} });
  await agent.run('Make a thirty-second video');
  const texts = JSON.stringify(history.get());
  assert.match(texts, /Make a thirty-second video/, 'the original request was trimmed away');
  assert.ok(history.get().length < 8, 'should have been trimmed after the over-budget turn');
});
