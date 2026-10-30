/**
 * 模型发出名字为空的工具调用(实跑见过):不能把空名原样写进历史,
 * 否则下一次请求被 Gemini 的 OpenAI 兼容口整个 400,会话从此废掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../harness/agent.mjs';

test('空工具名:历史里换成合法占位名、配一条报错的 tool_result,循环照常往下走', async () => {
  let n = 0;
  const provider = { name: 'fake', async *stream() {
    n++;
    if (n === 1) { yield { type: 'tool_use', id: 'c1', name: '', input: {} }; yield { type: 'stop', reason: 'tool_use' }; return; }
    yield { type: 'text_delta', text: '好的' }; yield { type: 'stop', reason: 'end_turn' };
  } };
  const out = await new Agent({ provider, system: 's', tools: [], onEvent: () => {} }).run('做点事');
  const msgs = out.history.get();
  const use = msgs.flatMap((m) => m.content).find((b) => b.type === 'tool_use');
  assert.equal(use.name, 'invalid_tool_name', '历史里不能留空名');
  const res = msgs.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
  assert.equal(res.tool_use_id, 'c1');
  assert.equal(res.is_error, true);
  assert.match(JSON.parse(res.content).error, /工具名 "" 不合法/, '要报真正的原因,不是「未知工具 invalid_tool_name」');
  assert.equal(n, 2, '报错之后模型还要再被请求一次');
});
