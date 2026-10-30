/**
 * node --test server/test/api-models.test.mjs
 *
 * 从 OpenAI 兼容接口拉模型清单。两处容易出错,都钉住:
 *   - baseUrl 拼接:用户填的地址有的带 /v1 有的不带,拼错就是 404;
 *   - 响应形状:中转站的实现参差,认不出来要**返回空清单**而不是抛异常 ——
 *     这是个锦上添花的按钮,不该因为对方回了个怪东西就报错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { modelsUrl, parseModels, listApiModels } = await import('../runners/api-models.mjs');

test('modelsUrl:带不带 /v1、带不带尾斜杠,都拼成同一个地址', () => {
  assert.equal(modelsUrl('https://api.openlux.ai'), 'https://api.openlux.ai/v1/models');
  assert.equal(modelsUrl('https://api.openlux.ai/'), 'https://api.openlux.ai/v1/models');
  assert.equal(modelsUrl('https://api.openlux.ai/v1'), 'https://api.openlux.ai/v1/models');
  assert.equal(modelsUrl('https://api.openlux.ai/v1/'), 'https://api.openlux.ai/v1/models');
  assert.equal(modelsUrl('  https://x.dev/v1  '), 'https://x.dev/v1/models');
  assert.equal(modelsUrl(''), '');
  assert.equal(modelsUrl(undefined), '');
});

test('parseModels:标准 OpenAI 形状', () => {
  const out = parseModels({ object: 'list', data: [{ id: 'gpt-4o' }, { id: 'claude-opus-4-6' }] });
  assert.deepEqual(out, ['claude-opus-4-6', 'gpt-4o'], '排过序,界面上好找');
});

test('parseModels:中转站的几种歪形状也认', () => {
  assert.deepEqual(parseModels(['a-1', 'b-2']), ['a-1', 'b-2'], '直接回数组');
  assert.deepEqual(parseModels({ models: [{ name: 'x-1' }] }), ['x-1'], 'models + name');
  assert.deepEqual(parseModels({ data: ['deepseek/v3:free'] }), ['deepseek/v3:free'], '带 / 和 : 的名字要留住');
});

test('parseModels:认不出来就给空清单,不抛', () => {
  assert.deepEqual(parseModels(null), []);
  assert.deepEqual(parseModels({}), []);
  assert.deepEqual(parseModels({ data: 'nope' }), []);
  assert.deepEqual(parseModels({ data: [{ nope: 1 }, 42, null] }), []);
  assert.deepEqual(parseModels({ data: [{ id: 'ok-1' }, { id: '带空格 的' }] }), ['ok-1'], '不合法的名字滤掉,合法的照留');
});

test('parseModels:重复的只留一个', () => {
  assert.deepEqual(parseModels({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }), ['a', 'b']);
});

test('listApiModels:带上 Bearer,打对地址', async () => {
  let seen = {};
  const fetchImpl = async (url, opts) => {
    seen = { url, auth: opts.headers.Authorization };
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm-1' }] }) };
  };
  const out = await listApiModels({ baseUrl: 'https://relay.dev', apiKey: 'sk-x' }, { fetchImpl });
  assert.equal(seen.url, 'https://relay.dev/v1/models');
  assert.equal(seen.auth, 'Bearer sk-x');
  assert.deepEqual(out, ['m-1']);
});

test('listApiModels:401 说人话,而且不把响应体贴出来(可能回显 Key)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: 'bad key sk-secret' }) });
  await assert.rejects(
    () => listApiModels({ baseUrl: 'https://relay.dev', apiKey: 'sk-secret' }, { fetchImpl }),
    (e) => {
      assert.match(e.message, /拒绝了这个 Key/);
      assert.ok(!e.message.includes('sk-secret'), '错误信息里不能带 Key');
      return true;
    },
  );
});

test('listApiModels:地址是空的就直接说,别去打一个拼不出来的 URL', async () => {
  await assert.rejects(() => listApiModels({ baseUrl: '', apiKey: 'k' }), /接口地址是空的/);
});

test('listApiModels:回来的不是 JSON', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('boom'); } });
  await assert.rejects(() => listApiModels({ baseUrl: 'https://x/v1', apiKey: 'k' }, { fetchImpl }), /不是 JSON/);
});
