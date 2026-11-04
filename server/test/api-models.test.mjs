/**
 * node --test server/test/api-models.test.mjs
 *
 * Pull the model manifest from OpenAI-compatible APIs. Pin down two error-prone places:
 *   - baseUrl concatenation: user-entered addresses sometimes have /v1 and sometimes not;
 *     concatenating incorrectly gives 404;
 *   - Response shape: relay service implementations vary; if unrecognized, **return an empty
 *     manifest** instead of throwing an exception: this is a nice-to-have button and should not
 *     error out just because the other side returned something strange.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { modelsUrl, parseModels, listApiModels } = await import('../runners/api-models.mjs');

test('modelsUrl: with or without /v1, with or without a trailing slash, all produce the same URL', () => {
  assert.equal(modelsUrl('https://api.openlux.ai'), 'https://api.openlux.ai/v1/models');
  assert.equal(modelsUrl('https://api.openlux.ai/'), 'https://api.openlux.ai/v1/models');
  assert.equal(modelsUrl('https://api.openlux.ai/v1'), 'https://api.openlux.ai/v1/models');
  assert.equal(modelsUrl('https://api.openlux.ai/v1/'), 'https://api.openlux.ai/v1/models');
  assert.equal(modelsUrl('  https://x.dev/v1  '), 'https://x.dev/v1/models');
  assert.equal(modelsUrl(''), '');
  assert.equal(modelsUrl(undefined), '');
});

test('parseModels: standard OpenAI shape', () => {
  const out = parseModels({ object: 'list', data: [{ id: 'gpt-4o' }, { id: 'claude-opus-4-6' }] });
  assert.deepEqual(out, ['claude-opus-4-6', 'gpt-4o'], 'Sorted, so they are easy to find in the interface');
});

test('parseModels: also accepts the several odd shapes returned by relay services', () => {
  assert.deepEqual(parseModels(['a-1', 'b-2']), ['a-1', 'b-2'], 'The response is a bare array');
  assert.deepEqual(parseModels({ models: [{ name: 'x-1' }] }), ['x-1'], 'models + name');
  assert.deepEqual(parseModels({ data: ['deepseek/v3:free'] }), ['deepseek/v3:free'], 'Names containing / and : must be kept');
});

test('parseModels: if nothing is recognized, return an empty list and do not throw', () => {
  assert.deepEqual(parseModels(null), []);
  assert.deepEqual(parseModels({}), []);
  assert.deepEqual(parseModels({ data: 'nope' }), []);
  assert.deepEqual(parseModels({ data: [{ nope: 1 }, 42, null] }), []);
  assert.deepEqual(parseModels({ data: [{ id: 'ok-1' }, { id: 'has space' }] }), ['ok-1'], 'Invalid names are filtered out, valid ones are kept');
});

test('parseModels: duplicates keep only one', () => {
  assert.deepEqual(parseModels({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }), ['a', 'b']);
});

test('listApiModels: sends Bearer auth and hits the right URL', async () => {
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

test('listApiModels: 401 gives a plain-language message and does not paste the response body (it may echo the key)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: 'bad key sk-secret' }) });
  await assert.rejects(
    () => listApiModels({ baseUrl: 'https://relay.dev', apiKey: 'sk-secret' }, { fetchImpl }),
    (e) => {
      assert.match(e.message, /rejected this key/);
      assert.ok(!e.message.includes('sk-secret'), 'The error message must not contain the key');
      return true;
    },
  );
});

test('listApiModels: if the address is empty, say so directly instead of hitting a URL that cannot be built', async () => {
  await assert.rejects(() => listApiModels({ baseUrl: '', apiKey: 'k' }), /The endpoint URL is empty/);
});

test('listApiModels: the response is not JSON', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('boom'); } });
  await assert.rejects(() => listApiModels({ baseUrl: 'https://x/v1', apiKey: 'k' }, { fetchImpl }), /not JSON/);
});
