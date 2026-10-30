/**
 * node --test server/test/api-timeout-resume.test.mjs
 *
 * 超时中断之后:①历史要落盘 ②错误要标成可续跑。
 *
 * 用户撞到的是「The operation was aborted due to timeout」,然后**手打「继续」**才接上。
 * 两个毛病:自动续跑没触发(那个错没标 retryable),而且就算续了也接不上 ——
 * 历史只在成功那条路写盘,中断这一轮做过的事全丢,下次读到的还是上一轮的。
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

/** 跑一轮,收齐事件 */
function run(sessionId, fetchImpl, prompt = '你好') {
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

test('超时:报成可续跑的错误,并把中断原因拼进续跑话术', async () => {
  const sid = `t-timeout-${Math.random().toString(36).slice(2, 8)}`;
  try { fs.unlinkSync(historyFileOf(sid)); } catch { /* 本来就没有 */ }

  const events = await run(sid, async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  });

  const err = events.find((e) => e.type === 'error');
  assert.ok(err, '超时该报错误,不该悄悄变成一条「已中止」的状态');
  assert.equal(err.retryable, true, '超时是可续跑的 —— 上下文都在,只是这次没吐字');
  assert.match(err.retryPrompt, /timeout/i, '把中断原因拼进去,模型不用自己开口问');
  assert.match(err.retryPrompt, /接着|继续/);
});

test('中断了也要落历史 —— 不然「继续」接的是更早的那一轮', async () => {
  const sid = `t-hist-${Math.random().toString(36).slice(2, 8)}`;
  const file = historyFileOf(sid);
  try { fs.unlinkSync(file); } catch { /* 本来就没有 */ }

  await run(sid, async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  }, '把小狗素材整理一下');

  assert.ok(fs.existsSync(file), '中断这一轮的历史必须存下来');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dump = JSON.stringify(saved);
  assert.match(dump, /把小狗素材整理一下/, '至少要记住用户这一轮说了什么');
  try { fs.unlinkSync(file); } catch { /* 清理 */ }
});

test('成功那条路照旧落历史', async () => {
  const sid = `t-ok-${Math.random().toString(36).slice(2, 8)}`;
  const file = historyFileOf(sid);
  try { fs.unlinkSync(file); } catch { /* 本来就没有 */ }
  await run(sid, async () => okReply('好的'));
  assert.ok(fs.existsSync(file));
  try { fs.unlinkSync(file); } catch { /* 清理 */ }
});

test('普通错误(不是超时)不标可续跑 —— 那种续了也是白续', async () => {
  const sid = `t-plain-${Math.random().toString(36).slice(2, 8)}`;
  const events = await run(sid, async () => ({
    ok: false, status: 401, headers: { get: () => null },
    text: async () => JSON.stringify({ error: { message: 'invalid api key' } }),
  }));
  const err = events.find((e) => e.type === 'error');
  assert.ok(err);
  assert.notEqual(err.retryable, true, '密钥错了,自动续跑只会空烧');
  try { fs.unlinkSync(historyFileOf(sid)); } catch { /* 清理 */ }
});
