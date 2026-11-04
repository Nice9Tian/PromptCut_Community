import test from 'node:test';
import assert from 'node:assert/strict';
import { isUserMessageCall, sayingsOf, userMessageText } from './userMessages.ts';

const say = (text, extra = {}) => ({ kind: 'tool', name: 'send_message', input: { to: 'user', text }, ok: true, ...extra });

test('A round that called send_message(to user): the bubble lists only these messages, in order; text replies do not go into the bubble', () => {
  const m = { text: 'Let me read the project first', parts: [{ kind: 'text', text: 'Let me read the project first' }, say('Let me look at the opening frames first'),
    { kind: 'tool', name: 'see_frames', input: {}, ok: true }, say('The title card is in place'), { kind: 'tool', name: 'report_progress', input: { final: true, done: ['x'] } }] };
  assert.deepEqual(sayingsOf(m).map(s => [s.text, s.from]), [['Let me look at the opening frames first', 'send_message'], ['The title card is in place', 'send_message']]);
});

test('No calls at all, only text replies: the text is treated as one "what I\'m doing" line; adjacent text is merged into one line, text separated by a tool stays separate', () => {
  const m = { text: '', parts: [{ kind: 'text', text: 'O' }, { kind: 'thinking', text: 'hmm' }, { kind: 'text', text: 'K' },
    { kind: 'tool', name: 'get_project', input: {} }, { kind: 'text', text: '  ' }, { kind: 'text', text: 'Done.' }] };
  assert.deepEqual(sayingsOf(m).map(s => s.text), ['OK', 'Done.']);
  assert.deepEqual(sayingsOf({ text: 'Old record', tools: [] }).map(s => s.text), ['Old record'], 'Old record without parts');
});

test('Sending to another Agent, sending an empty message, or a failed attempt does not count as speaking to the user; names with a prefix are accepted too', () => {
  assert.equal(isUserMessageCall('mcp__promptcut__send_message', { to: 'User', text: 'x' }), true);
  assert.equal(isUserMessageCall('send_message', { to: 'cc-1', text: 'x' }), false);
  assert.equal(userMessageText('send_message', { to: 'user', text: '  ' }), null);
  const m = { text: '', parts: [say('Failed to say it', { ok: false }), { kind: 'tool', name: 'send_message', input: { to: 'all', text: 'I\'ll take Track 2' } }, { kind: 'text', text: 'All done' }] };
  assert.deepEqual(sayingsOf(m).map(s => [s.text, s.from]), [['All done', 'text']]);
});
