// node --test server/test/think-tags.test.mjs: streaming split of inline <think>
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createThinkSplitter, splitThinkTags } = await import('../harness/think-tags.mjs');

/** Slice the whole text by size and feed it in to simulate streaming; return both assembled channels */
function feed(text, size) {
  const sp = createThinkSplitter();
  const events = [];
  for (let i = 0; i < text.length; i += size) events.push(...sp.push(text.slice(i, i + size)));
  events.push(...sp.flush());
  let out = '';
  let think = '';
  for (const e of events) {
    if (e.kind === 'text') out += e.text;
    else think += e.text;
  }
  return { text: out, think };
}

// Real shape from a user diagnostic report (chat-diagnostic-20260908-114215)
const REAL = '<think>**Clarifying article link and scope**\n\n</think>\n\nFirst I will check the media collection environment; there is no WeChat article link in the messages so far.';

test('Real sample: think goes to the thinking channel, and not a single tag remains in the body', () => {
  const { text, think } = splitThinkTags(REAL);
  assert.equal(think, '**Clarifying article link and scope**\n\n');
  assert.equal(text, '\n\nFirst I will check the media collection environment; there is no WeChat article link in the messages so far.');
  assert.ok(!text.includes('<think'), 'The body must not contain <think');
  assert.ok(!text.includes('</think'), 'The body must not contain </think, which is exactly the string that leaked into the bubble');
});

test('The result is the same however large the chunks are: a tag being split in half is the norm', () => {
  const expect = splitThinkTags(REAL);
  for (const size of [1, 2, 3, 5, 7, 13, 64, 1000]) {
    assert.deepEqual(feed(REAL, size), expect, `Results differ when chunked by ${size} bytes`);
  }
});

test('Multiple think blocks in one message: all are split out, and the body is joined back in order', () => {
  const s = 'A<think>t1</think>B<think>t2</think>C';
  assert.deepEqual(splitThinkTags(s), { text: 'ABC', think: 't1t2' });
  assert.deepEqual(feed(s, 1), { text: 'ABC', think: 't1t2' });
});

test('<thinking> is recognized as well', () => {
  assert.deepEqual(splitThinkTags('x<thinking>y</thinking>z'), { text: 'xz', think: 'y' });
});

test('Plain text without tags passes through unchanged, without losing a single character', () => {
  const s = 'This is a plain reply containing < and >, and also comparisons like 1 < 2.';
  assert.deepEqual(splitThinkTags(s), { text: s, think: '' });
  assert.deepEqual(feed(s, 1), { text: s, think: '' });
});

test('The stream breaks off before it ends: a held-back partial tag must be released back into the body and must not swallow the user\'s text', () => {
  const sp = createThinkSplitter();
  const seen = [...sp.push('The ending is exactly <thi'), ...sp.flush()];
  assert.equal(seen.map((e) => e.text).join(''), 'The ending is exactly <thi');
  assert.ok(seen.every((e) => e.kind === 'text'));
});

test('The stream breaks off before think is closed: hand it out as thinking instead of dropping it', () => {
  const sp = createThinkSplitter();
  const seen = [...sp.push('a<think>not finished'), ...sp.flush()];
  assert.equal(seen.filter((e) => e.kind === 'text').map((e) => e.text).join(''), 'a');
  assert.equal(seen.filter((e) => e.kind === 'think').map((e) => e.text).join(''), 'not finished');
});

test('inThink reflects the current state', () => {
  const sp = createThinkSplitter();
  assert.equal(sp.inThink, false);
  sp.push('x<think>y');
  assert.equal(sp.inThink, true);
  sp.push('</think>z');
  assert.equal(sp.inThink, false);
});

test('The opening tag spans chunks and so does the closing tag: feeding one character at a time exposes problems most easily', () => {
  const s = 'before<think>mid</think>after';
  assert.deepEqual(feed(s, 1), { text: 'beforeafter', think: 'mid' });
});

test('Empty input and empty fragments produce no events', () => {
  const sp = createThinkSplitter();
  assert.deepEqual(sp.push(''), []);
  assert.deepEqual(sp.push('<think>'), [], 'With only the opening tag, no empty text should be produced');
  assert.deepEqual(sp.push('</think>'), [], 'Closing right away should not produce an empty think either');
});
