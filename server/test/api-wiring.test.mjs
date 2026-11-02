/**
 * node --test server/test/api-wiring.test.mjs
 *
 * Integration tests **using real wiring**.
 *
 * The two blockers caught during review share the same shape: unit tests were testing the
 * bypassed section.
 *   - In the unit test for idle-timeout, fake fetchImpl dutifully listens to init.signal; but the
 *     arrow function `{ ...options, signal: abortController.signal }` in api.mjs overwrote the
 *     composed signal, leaving the entire layer dead: yet unit tests were all green.
 * Therefore, this tier only enters from startRun, judging solely by "what a real fetch would see".
 *
 * In addition: test cases here write files to the **real** %TEMP%/promptcut/harness-sessions
 * (the startRun directory is not injectable). If not cleaned up on assertion failure, leftovers
 * will be counted into the session filing cabinet of the diagnostic report: our own tests would
 * pollute our own troubleshooting tools. Therefore, cleanup is always placed in finally.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { startRun } = await import('../runners/api.mjs');

const historyFileOf = (sid) => path.join(os.tmpdir(), 'promptcut', 'harness-sessions', `${sid}.json`);

function run(sessionId, fetchImpl, extra = {}) {
  const events = [];
  return new Promise((resolve) => {
    const r = startRun({
      prompt: 'Hello', systemPrompt: '', sessionId,
      apiConfig: { vendor: 'openai', apiKey: 'sk-t', model: 'm', baseUrl: 'https://x/v1', maxTokens: 64 },
      callTool: async () => ({ ok: true }),
      fetchImpl,
      onEvent: (ev) => {
        events.push(ev);
        if (ev.type === 'done' || ev.type === 'error') setTimeout(() => resolve({ events, run: r }), 20);
      },
      ...extra,
    });
  });
}

test('Idle timeout is really wired up: if upstream sends not a single byte, it must eventually be cut off and report a timeout', async () => {
  const sid = `w-idle-${Math.random().toString(36).slice(2, 8)}`;
  try { fs.unlinkSync(historyFileOf(sid)); } catch { /* Did not exist in the first place */ }

  /*
   * This fake fetch **only recognizes init.signal**: just like real fetch.
   * If the wiring is broken, it will never reject, and this test will fail by timing out (instead of
   * quietly passing).
   */
  let sawSignal = null;
  const fetchImpl = (url, init) => {
    sawSignal = init?.signal ?? null;
    return new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(init.signal.reason ?? new Error('aborted')), { once: true });
    });
  };

  const { events } = await run(sid, fetchImpl, { idleMsForTest: 150 });
  try {
    assert.ok(sawSignal, 'The real fetch must receive a signal');
    const err = events.find((e) => e.type === 'error');
    assert.ok(err, `Should report an error when upstream emits no text, actual events: ${events.map((e) => e.type).join(',')}`);
    assert.match(err.message, /timeout|timed out/i);
    assert.equal(err.retryable, true, 'A timeout should be automatically resumable');
  } finally {
    try { fs.unlinkSync(historyFileOf(sid)); } catch { /* Cleanup */ }
  }
});

test('Stop from the user still works: the merged signal must not lose the stop path', async () => {
  const sid = `w-stop-${Math.random().toString(36).slice(2, 8)}`;
  let handle = null;
  const fetchImpl = (url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => rej(Object.assign(new Error('Stopped'), { name: 'AbortError' })), { once: true });
  });
  const p = new Promise((resolve) => {
    const events = [];
    handle = startRun({
      prompt: 'Hello', systemPrompt: '', sessionId: sid,
      apiConfig: { vendor: 'openai', apiKey: 'sk-t', model: 'm', baseUrl: 'https://x/v1', maxTokens: 64 },
      callTool: async () => ({ ok: true }),
      fetchImpl,
      onEvent: (ev) => { events.push(ev); if (ev.type === 'status' && ev.text === 'Aborted') resolve(events); },
    });
  });
  setTimeout(() => handle.abort(), 60);
  const events = await p;
  try {
    assert.ok(events.some((e) => e.type === 'status' && e.text === 'Aborted'));
  } finally {
    try { fs.unlinkSync(historyFileOf(sid)); } catch { /* Cleanup */ }
  }
});

test('The history saved on interruption must not contain a dangling tool_use, otherwise this session gets a 400 every time from then on', async () => {
  const sid = `w-heal-${Math.random().toString(36).slice(2, 8)}`;
  const file = historyFileOf(sid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Seed a history with "tool_use but no tool_result" to simulate being stopped during tool execution last time
  fs.writeFileSync(file, JSON.stringify([
    { role: 'user', content: [{ type: 'text', text: 'Start' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_project', input: {} }] },
  ]), 'utf8');

  await run(sid, async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  });

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const idx = saved.findIndex((m) => m.role === 'assistant' && m.content?.some?.((b) => b.type === 'tool_use'));
    assert.ok(idx >= 0, 'The message with the tool_use is still there');
    const next = saved[idx + 1];
    assert.ok(next, 'Something must follow the tool_use');
    assert.equal(next.role, 'user');
    const paired = next.content.find((b) => b.type === 'tool_result' && b.tool_use_id === 'call_1');
    assert.ok(paired, 'A dangling tool_use must be given a paired tool_result');
    assert.equal(paired.is_error, true, 'The added one must be marked as failed, so the model knows that step was interrupted');
  } finally {
    try { fs.unlinkSync(file); } catch { /* Cleanup */ }
  }
});

test('A history already corrupted on disk must be repaired when read back: it must not hit a 400 first and heal itself afterward', async () => {
  const sid = `w-healread-${Math.random().toString(36).slice(2, 8)}`;
  const file = historyFileOf(sid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  /*
   * Seed a history with dangling tool_use. Such files exist in reality: "write to disk even on abort"
   * was added later; before that / during the intermediate state of that change, a batch of sessions
   * with only tool_use and no tool_result was left on disk. If cured only when writing, the first
   * message of such a session will inevitably return 400, self-healing only via saveHistory in
   * catch.
   */
  fs.writeFileSync(file, JSON.stringify([
    { role: 'user', content: [{ type: 'text', text: 'Start' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_project', input: {} }] },
  ]), 'utf8');

  let sent = null;
  const fetchImpl = (url, init) => {
    if (!sent) { try { sent = JSON.parse(init.body); } catch { sent = null; } }
    return Promise.reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
  };
  await run(sid, fetchImpl);

  /*
   * These two test cases write files to the **real** harness-sessions (the directory of startRun is
   * not injectable). If not cleaned up on assertion failure, leftovers will be counted into the
   * session filing cabinet of the diagnostic report: our own tests pollute our own troubleshooting
   * tools. Therefore, cleanup is put in finally.
   */
  try {
    assert.ok(sent, 'The first request must be able to go out');
    const roles = sent.messages.map((m) => m.role);
    assert.ok(roles.includes('tool'), `A dangling tool_use should already be paired with a tool_result **in the first request**, actual: ${roles.join(',')}`);
    const tool = sent.messages.find((m) => m.role === 'tool');
    assert.equal(tool.tool_call_id, 'call_1');
  } finally {
    try { fs.unlinkSync(file); } catch { /* Cleanup */ }
  }
});

test('When continuing from old history, the messages sent out must not contain two consecutive user messages', async () => {
  const sid = `w-dupuser-${Math.random().toString(36).slice(2, 8)}`;
  const file = historyFileOf(sid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The end is a user message (the shape patched when writing to disk on abort); another
  // incoming message would piece together two consecutive user messages
  fs.writeFileSync(file, JSON.stringify([
    { role: 'user', content: [{ type: 'text', text: 'Start' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
    { role: 'user', content: [{ type: 'text', text: 'The last time was interrupted' }] },
  ]), 'utf8');

  let sent = null;
  const fetchImpl = (url, init) => {
    if (!sent) { try { sent = JSON.parse(init.body); } catch { sent = null; } }
    return Promise.reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
  };
  await run(sid, fetchImpl);

  try {
    assert.ok(sent, 'The first request must be able to go out');
    const roles = sent.messages.map((m) => m.role);
    for (let i = 1; i < roles.length; i++) {
      assert.ok(!(roles[i] === 'user' && roles[i - 1] === 'user'), `Message ${i} and the previous one are both user: ${roles.join(',')}`);
    }
    assert.ok(JSON.stringify(sent.messages).includes('Hello'), 'The newly spoken sentence must actually be included');
  } finally {
    try { fs.unlinkSync(file); } catch { /* Cleanup */ }
  }
});
