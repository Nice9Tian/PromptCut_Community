/**
 * 回复写到单次输出上限被截断、一个工具都没调(2026-10-17 生产实跑:4096 个 token 花完,0 次操作就「完成」了):
 * 不能当成说完了收工;要让模型接着做,连续截断就明说没做成。
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
  test(`截断(${reason})以后让模型接着做,事件里有一行给人看的说明,接着做完照常收尾`, async () => {
    const s = scripted([{ text: '先打个草稿……', stop: reason }, { tool: true, stop: 'tool_use' }, { text: '做完了', stop: 'end_turn' }]);
    const events = [];
    const out = await new Agent({ provider: s.provider, system: 's', tools: [NOOP], onEvent: e => events.push(e) }).run('做个动画');
    assert.equal(s.calls, 3);
    assert.equal(out.outcome, 'completed'); assert.equal(out.completed, 1);
    assert.ok(events.some(e => e.type === 'status' && /超过单次输出上限被截断/.test(e.text)), '要有一行给人看的状态');
    const second = s.seen[1], last = second.at(-1);
    assert.equal(last.role, 'user'); assert.match(JSON.stringify(last.content), /被截断/, '第二次请求的最后一条是让它接着做的话');
    assert.equal(second.at(-2).role, 'assistant', '截断前写的草稿留在历史里,不重复也不丢');
  });
}

test('一个字都没有、全花在思考上被截断:也是接着做,不报「API 没有返回文字」', async () => {
  const s = scripted([{ stop: 'length' }, { text: '好', stop: 'end_turn' }]);
  const out = await new Agent({ provider: s.provider, system: 's', tools: [NOOP], onEvent: () => {} }).run('做');
  assert.equal(s.calls, 2); assert.equal(out.outcome, 'completed');
});

test('连续截断超过两次:明说没做成,以错误结束,不再请求', async () => {
  const s = scripted([{ text: '草稿', stop: 'length' }]);
  await assert.rejects(new Agent({ provider: s.provider, system: 's', tools: [NOOP], onEvent: () => {} }).run('做'),
    /连续 3 次超过单次输出上限被截断，这一轮没能完成/);
  assert.equal(s.calls, 3);
});

test('中间调过工具,截断计数重新算', async () => {
  const s = scripted([{ stop: 'length' }, { stop: 'length' }, { tool: true, stop: 'tool_use' }, { stop: 'length' }, { stop: 'length' }, { text: '完', stop: 'end_turn' }]);
  const out = await new Agent({ provider: s.provider, system: 's', tools: [NOOP], onEvent: () => {} }).run('做');
  assert.equal(out.outcome, 'completed'); assert.equal(s.calls, 6);
});

test('最后一轮被截断:不越过轮数上限,明说没做成', async () => {
  const s = scripted([{ tool: true, stop: 'tool_use' }, { stop: 'length' }]);
  await assert.rejects(new Agent({ provider: s.provider, system: 's', tools: [NOOP], maxIterations: 2, onEvent: () => {} }).run('做'),
    /超过单次输出上限被截断，这一轮没能完成/);
  assert.equal(s.calls, 2);
});

test('正常说完(stop / end_turn)不受影响:一次就收尾', async () => {
  const s = scripted([{ text: '说完了', stop: 'end_turn' }]);
  const out = await new Agent({ provider: s.provider, system: 's', tools: [NOOP], onEvent: () => {} }).run('问');
  assert.equal(s.calls, 1); assert.equal(out.outcome, 'completed');
});
