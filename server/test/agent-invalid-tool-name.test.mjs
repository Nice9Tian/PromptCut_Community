/**
 * 模型发出名字为空的工具调用(实跑见过):不能把空名原样写进历史,
 * 否则下一次请求被 Gemini 的 OpenAI 兼容口整个 400,会话从此废掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../harness/agent.mjs';

test('empty tool name: replaced in the history with a valid placeholder name, paired with an erroring tool_result, and the loop carries on as usual', async () => {
  let n = 0;
  const provider = { name: 'fake', async *stream() {
    n++;
    if (n === 1) { yield { type: 'tool_use', id: 'c1', name: '', input: {} }; yield { type: 'stop', reason: 'tool_use' }; return; }
    yield { type: 'text_delta', text: 'OK' }; yield { type: 'stop', reason: 'end_turn' };
  } };
  const out = await new Agent({ provider, system: 's', tools: [], onEvent: () => {} }).run('Do something');
  const msgs = out.history.get();
  const use = msgs.flatMap((m) => m.content).find((b) => b.type === 'tool_use');
  assert.equal(use.name, 'invalid_tool_name', 'an empty name must not remain in the history');
  const res = msgs.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
  assert.equal(res.tool_use_id, 'c1');
  assert.equal(res.is_error, true);
  assert.match(JSON.parse(res.content).error, /Tool name "" is invalid/, 'must report the real reason, not "Unknown tool invalid_tool_name"');
  assert.equal(n, 2, 'after the error the model must be requested once more');
});
