/**
 * node --test server/test/api-wiring.test.mjs
 *
 * **走真实接线**的集成测试。
 *
 * 评审抓到的两条阻断有同一个形状:单元测试测的是被绕过的那一段。
 *   - idle-timeout 的单测里,假 fetchImpl 老老实实监听 init.signal;而 api.mjs 里那个
 *     箭头函数 `{ ...options, signal: abortController.signal }` 把组合信号覆盖掉了,
 *     于是整层是死的 —— 单测照样全绿。
 * 所以这一档只从 startRun 进去,只用「真 fetch 会看到什么」来判断。
 *
 * 另外:这里的用例都往**真实的** %TEMP%/promptcut/harness-sessions 写文件
 * (startRun 的目录不可注入)。断言失败时如果不清,残留会被诊断报告的会话文件柜
 * 数进去 —— 我们自己的测试污染我们自己的排查工具。所以清理一律放 finally。
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
  try { fs.unlinkSync(historyFileOf(sid)); } catch { /* 本来就没有 */ }

  /*
   * 这个假 fetch **只认 init.signal** —— 和真 fetch 一样。
   * 接线断了的话它永远不 reject,这条测试就会超时失败(而不是悄悄通过)。
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
    try { fs.unlinkSync(historyFileOf(sid)); } catch { /* 清理 */ }
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
    try { fs.unlinkSync(historyFileOf(sid)); } catch { /* 清理 */ }
  }
});

test('The history saved on interruption must not contain a dangling tool_use, otherwise this session gets a 400 every time from then on', async () => {
  const sid = `w-heal-${Math.random().toString(36).slice(2, 8)}`;
  const file = historyFileOf(sid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 先埋一份「有 tool_use、没有 tool_result」的历史,模拟上一次在工具执行途中被停掉
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
    try { fs.unlinkSync(file); } catch { /* 清理 */ }
  }
});

test('A history already corrupted on disk must be repaired when read back: it must not hit a 400 first and heal itself afterward', async () => {
  const sid = `w-healread-${Math.random().toString(36).slice(2, 8)}`;
  const file = historyFileOf(sid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  /*
   * 埋一份带悬空 tool_use 的历史。这种文件是真实存在的:「中断也落盘」是后来才加的,
   * 在那之前 / 在那个改动的中间态里,盘上留下过一批只有 tool_use 没有 tool_result 的会话。
   * 只在写的时候治,这种会话第一句必然 400,靠 catch 里的 saveHistory 才自愈。
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
   * 这两条用例往**真实的** harness-sessions 写文件(startRun 的目录不可注入)。
   * 断言失败时如果不清,残留会被诊断报告的会话文件柜数进去 —— 我们自己的测试
   * 污染我们自己的排查工具。所以清理放 finally。
   */
  try {
    assert.ok(sent, 'The first request must be able to go out');
    const roles = sent.messages.map((m) => m.role);
    assert.ok(roles.includes('tool'), `A dangling tool_use should already be paired with a tool_result **in the first request**, actual: ${roles.join(',')}`);
    const tool = sent.messages.find((m) => m.role === 'tool');
    assert.equal(tool.tool_call_id, 'call_1');
  } finally {
    try { fs.unlinkSync(file); } catch { /* 清理 */ }
  }
});

test('When continuing from old history, the messages sent out must not contain two consecutive user messages', async () => {
  const sid = `w-dupuser-${Math.random().toString(36).slice(2, 8)}`;
  const file = historyFileOf(sid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 末尾是一条 user(中断落盘补的那种形状),再进来一句话就会拼出两条连着的 user
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
    try { fs.unlinkSync(file); } catch { /* 清理 */ }
  }
});
