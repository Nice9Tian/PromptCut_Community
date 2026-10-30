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
      prompt: '你好', systemPrompt: '', sessionId,
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

test('闲置超时真的接上了:上游一个字节都不给,最终要被掐断并报超时', async () => {
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
    assert.ok(sawSignal, '真 fetch 必须收到一个 signal');
    const err = events.find((e) => e.type === 'error');
    assert.ok(err, `上游不吐字时该报错,实际事件:${events.map((e) => e.type).join(',')}`);
    assert.match(err.message, /timeout|超时/i);
    assert.equal(err.retryable, true, '超时应当可自动续跑');
  } finally {
    try { fs.unlinkSync(historyFileOf(sid)); } catch { /* 清理 */ }
  }
});

test('用户点停止照样管用 —— 合并信号不能把停止那一路弄丢', async () => {
  const sid = `w-stop-${Math.random().toString(36).slice(2, 8)}`;
  let handle = null;
  const fetchImpl = (url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => rej(Object.assign(new Error('已停止'), { name: 'AbortError' })), { once: true });
  });
  const p = new Promise((resolve) => {
    const events = [];
    handle = startRun({
      prompt: '你好', systemPrompt: '', sessionId: sid,
      apiConfig: { vendor: 'openai', apiKey: 'sk-t', model: 'm', baseUrl: 'https://x/v1', maxTokens: 64 },
      callTool: async () => ({ ok: true }),
      fetchImpl,
      onEvent: (ev) => { events.push(ev); if (ev.type === 'status' && ev.text === '已中止') resolve(events); },
    });
  });
  setTimeout(() => handle.abort(), 60);
  const events = await p;
  try {
    assert.ok(events.some((e) => e.type === 'status' && e.text === '已中止'));
  } finally {
    try { fs.unlinkSync(historyFileOf(sid)); } catch { /* 清理 */ }
  }
});

test('中断落盘的历史里不能有悬空 tool_use —— 否则这个会话从此每次都 400', async () => {
  const sid = `w-heal-${Math.random().toString(36).slice(2, 8)}`;
  const file = historyFileOf(sid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 先埋一份「有 tool_use、没有 tool_result」的历史,模拟上一次在工具执行途中被停掉
  fs.writeFileSync(file, JSON.stringify([
    { role: 'user', content: [{ type: 'text', text: '开始' }] },
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
    assert.ok(idx >= 0, '那条带 tool_use 的消息还在');
    const next = saved[idx + 1];
    assert.ok(next, 'tool_use 后面必须跟着东西');
    assert.equal(next.role, 'user');
    const paired = next.content.find((b) => b.type === 'tool_result' && b.tool_use_id === 'call_1');
    assert.ok(paired, '悬空的 tool_use 必须被补上配对的 tool_result');
    assert.equal(paired.is_error, true, '补的那条要标成失败,让模型知道那一步被打断了');
  } finally {
    try { fs.unlinkSync(file); } catch { /* 清理 */ }
  }
});

test('盘上已经写坏的历史,读回来就要治好 —— 不能先撞一次 400 再自愈', async () => {
  const sid = `w-healread-${Math.random().toString(36).slice(2, 8)}`;
  const file = historyFileOf(sid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  /*
   * 埋一份带悬空 tool_use 的历史。这种文件是真实存在的:「中断也落盘」是后来才加的,
   * 在那之前 / 在那个改动的中间态里,盘上留下过一批只有 tool_use 没有 tool_result 的会话。
   * 只在写的时候治,这种会话第一句必然 400,靠 catch 里的 saveHistory 才自愈。
   */
  fs.writeFileSync(file, JSON.stringify([
    { role: 'user', content: [{ type: 'text', text: '开始' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_project', input: {} }] },
  ]), 'utf8');

  let sent = null;
  const fetchImpl = (url, init) => {
    if (!sent) { try { sent = JSON.parse(init.body); } catch { sent = null; } }
    return Promise.reject(Object.assign(new Error('已停止'), { name: 'AbortError' }));
  };
  await run(sid, fetchImpl);

  /*
   * 这两条用例往**真实的** harness-sessions 写文件(startRun 的目录不可注入)。
   * 断言失败时如果不清,残留会被诊断报告的会话文件柜数进去 —— 我们自己的测试
   * 污染我们自己的排查工具。所以清理放 finally。
   */
  try {
    assert.ok(sent, '第一次请求要发得出去');
    const roles = sent.messages.map((m) => m.role);
    assert.ok(roles.includes('tool'), `悬空的 tool_use 在**第一次请求里**就该配上 tool_result,实际:${roles.join(',')}`);
    const tool = sent.messages.find((m) => m.role === 'tool');
    assert.equal(tool.tool_call_id, 'call_1');
  } finally {
    try { fs.unlinkSync(file); } catch { /* 清理 */ }
  }
});

test('接着旧历史往下说时,发出去的消息里不许有两条连着的 user', async () => {
  const sid = `w-dupuser-${Math.random().toString(36).slice(2, 8)}`;
  const file = historyFileOf(sid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 末尾是一条 user(中断落盘补的那种形状),再进来一句话就会拼出两条连着的 user
  fs.writeFileSync(file, JSON.stringify([
    { role: 'user', content: [{ type: 'text', text: '开始' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
    { role: 'user', content: [{ type: 'text', text: '上一次被打断了' }] },
  ]), 'utf8');

  let sent = null;
  const fetchImpl = (url, init) => {
    if (!sent) { try { sent = JSON.parse(init.body); } catch { sent = null; } }
    return Promise.reject(Object.assign(new Error('已停止'), { name: 'AbortError' }));
  };
  await run(sid, fetchImpl);

  try {
    assert.ok(sent, '第一次请求要发得出去');
    const roles = sent.messages.map((m) => m.role);
    for (let i = 1; i < roles.length; i++) {
      assert.ok(!(roles[i] === 'user' && roles[i - 1] === 'user'), `第 ${i} 条和上一条都是 user:${roles.join(',')}`);
    }
    assert.ok(JSON.stringify(sent.messages).includes('你好'), '新说的那句要真的带上');
  } finally {
    try { fs.unlinkSync(file); } catch { /* 清理 */ }
  }
});
