import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardCostKey, stableJson } from './cardCostKey.mjs';

const node = { id: '@clip/a/source', adapter: 'chrome', cardId: 'odometer', clipId: 'a', params: { value: 12 }, parts: undefined,
  inputs: {}, capabilities: { frameMode: 'stateful', compositing: 'independent' } };

test('clipId, id and inputs do not affect the key; params, sourceVersion, fps, length and capabilities do', () => {
  const k = cardCostKey(node, 'v1', 30, 60);
  assert.equal(cardCostKey({ ...node, clipId: 'b', id: '@clip/b/source' }, 'v1', 30, 60), k);
  assert.notEqual(cardCostKey({ ...node, params: { value: 13 } }, 'v1', 30, 60), k);
  assert.notEqual(cardCostKey(node, 'v2', 30, 60), k);
  assert.notEqual(cardCostKey(node, 'v1', 60, 60), k);
  assert.notEqual(cardCostKey(node, 'v1', 30, 61), k);
  assert.notEqual(cardCostKey({ ...node, capabilities: { ...node.capabilities, compositing: 'belowDependent' } }, 'v1', 30, 60), k);
  assert.match(k, /^[0-9a-f]{1,14}$/);
});
test('stableJson sorts keys and drops undefined like frame-identity.mjs', () => {
  assert.equal(stableJson({ b: 1, a: [2, { d: undefined, c: 3 }] }), '{"a":[2,{"c":3}],"b":1}');
});
