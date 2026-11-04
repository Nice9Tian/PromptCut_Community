/**
 * node --test server/test/api-timeout-resume.test.mjs
 *
 * After timeout interruption: (1) history must be written to disk (2) error must be marked as
 * resumable.
 *
 * The user hit "The operation was aborted due to timeout", and only reconnected after **manually
 * typing "continue"**. Two defects: automatic resumption was not triggered (that error was not
 * marked retryable), and even if resumed, it could not reconnect: history is only written to disk
 * on the success path, losing everything done in this interrupted round, and next time it still
 * reads from the previous round.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { startRun } = await import('../runners/api.mjs');

const historyFileOf = (sid) => path.join(os.tmpdir(), 'promptcut', 'harness-sessions', `${sid}.json`);

function sse(lines) {
  return {
    ok: true, status: 200, headers: { get: () => 'text/event-stream' },
    text: async () => '', json: async () => ({}),
    body: (async function* () { for (const l of lines) yield l; })(),
  };
}

const okReply = (text) => sse([
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
]);

/** Run a round and collect all events */
function run(sessionId, fetchImpl, prompt = 'Hello') {
  const events = [];
  return new Promise((resolve) => {
    startRun({
      prompt, systemPrompt: '', sessionId,
      apiConfig: { vendor: 'openai', apiKey: 'sk-t', model: 'm', baseUrl: 'https://x/v1', maxTokens: 64 },
      callTool: async () => ({ ok: true }),
      fetchImpl,
      onEvent: (ev) => {
        events.push(ev);
        if (ev.type === 'done' || ev.type === 'error') setTimeout(() => resolve(events), 20);
      },
    });
  });
}

test('Timeout: reported as a resumable error, with the reason for the interruption assembled into the resume prompt', async () => {
  const sid = `t-timeout-${Math.random().toString(36).slice(2, 8)}`;
  try { fs.unlinkSync(historyFileOf(sid)); } catch { /* Did not exist in the first place */ }

  const events = await run(sid, async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  });

  const err = events.find((e) => e.type === 'error');
  assert.ok(err, 'A timeout should be reported as an error, not quietly turn into an "Aborted" status');
  assert.equal(err.retryable, true, 'A timeout is resumable: the context is all still there, it just produced no text this time');
  assert.match(err.retryPrompt, /timeout/i, 'Put the reason for the interruption in, so the model does not have to ask');
  assert.match(err.retryPrompt, /continue|carry on/);
});

test('An interrupted round must still be saved to the history, otherwise "Continue" would pick up an earlier round', async () => {
  const sid = `t-hist-${Math.random().toString(36).slice(2, 8)}`;
  const file = historyFileOf(sid);
  try { fs.unlinkSync(file); } catch { /* Did not exist in the first place */ }

  await run(sid, async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  }, 'Organize the puppy media');

  assert.ok(fs.existsSync(file), 'The history of the interrupted round must be saved');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dump = JSON.stringify(saved);
  assert.match(dump, /Organize the puppy media/, 'At the very least it must remember what the user said this round');
  try { fs.unlinkSync(file); } catch { /* Cleanup */ }
});

test('The success path still saves to the history as before', async () => {
  const sid = `t-ok-${Math.random().toString(36).slice(2, 8)}`;
  const file = historyFileOf(sid);
  try { fs.unlinkSync(file); } catch { /* Did not exist in the first place */ }
  await run(sid, async () => okReply('OK'));
  assert.ok(fs.existsSync(file));
  try { fs.unlinkSync(file); } catch { /* Cleanup */ }
});

test('An ordinary error (not a timeout) is not marked resumable: resuming it would be pointless anyway', async () => {
  const sid = `t-plain-${Math.random().toString(36).slice(2, 8)}`;
  const events = await run(sid, async () => ({
    ok: false, status: 401, headers: { get: () => null },
    text: async () => JSON.stringify({ error: { message: 'invalid api key' } }),
  }));
  const err = events.find((e) => e.type === 'error');
  assert.ok(err);
  assert.notEqual(err.retryable, true, 'The key is wrong, so automatic resuming just burns resources for nothing');
  try { fs.unlinkSync(historyFileOf(sid)); } catch { /* Cleanup */ }
});
