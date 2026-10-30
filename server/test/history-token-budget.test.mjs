/**
 * 按真实 token 数截断:上下文拉满以后,截断不再靠「字符数 ÷ 3」猜 token,
 * 而是看每轮 API 报回的 input。中文差不多一字一 token,按字符猜会低估三倍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageHistory } from '../harness/history.mjs';
import { Agent } from '../harness/agent.mjs';

const longTurns = (n, text) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `${i}:${text}` }] }));

test('fitTokens:报回的 token 数没超预算就一条都不动', () => {
  const h = MessageHistory.fromJSON(longTurns(20, '字'.repeat(2000)), { maxChars: Infinity });
  h.fitTokens(500_000, 900_000);
  assert.equal(h.get().length, 20);
});

test('fitTokens:超了预算就按实测比例截,截完字符数落在预算对应的量之内', () => {
  const h = MessageHistory.fromJSON(longTurns(40, '字'.repeat(2000)), { maxChars: Infinity });
  const before = h.size();
  h.fitTokens(1_200_000, 900_000);
  assert.ok(h.get().length < 40, '应当截过');
  assert.ok(h.size() <= before * (900_000 / 1_200_000) * 0.9, '截完还超');
});

test('默认保留 10 张截图', () => {
  const h = new MessageHistory();
  for (let i = 0; i < 12; i++) h.append({ role: 'user', content: [{ type: 'image', mime: 'image/png', data: 'A'.repeat(5000) }] });
  h.pruneImages();
  const kept = h.get().filter((m) => m.content[0].type === 'image').length;
  assert.equal(kept, 10);
});

test('Agent:给了 maxInputTokens 就按报回的 input 截,而且用户的原始需求留着', async () => {
  const history = MessageHistory.fromJSON([], { maxChars: Infinity });
  let n = 0;
  const provider = { name: 'fake', async *stream() {
    n++;
    // 前三轮一直调工具,每轮报的 input 越来越大;第 3 轮超预算
    if (n <= 3) {
      yield { type: 'tool_use', id: `c${n}`, name: 'noop', input: { n } };
      yield { type: 'usage', input: n * 400_000, output: 10 };
      yield { type: 'stop', reason: 'tool_use' };
    } else {
      yield { type: 'text_delta', text: '做完了' };
      yield { type: 'usage', input: 100, output: 3 };
      yield { type: 'stop', reason: 'end_turn' };
    }
  } };
  const noop = { name: 'noop', inputSchema: { type: 'object', properties: {} }, execute: async (i) => ({ ok: true, big: '字'.repeat(20000), n: i.n }) };
  const agent = new Agent({ provider, system: 's', tools: [noop], maxInputTokens: 900_000, history, onEvent: () => {} });
  await agent.run('做一条三十秒的片子');
  const texts = JSON.stringify(history.get());
  assert.match(texts, /做一条三十秒的片子/, '原始需求被截掉了');
  assert.ok(history.get().length < 8, '超预算那一轮之后应当截过');
});
