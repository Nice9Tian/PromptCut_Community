import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardNodeIdentities, cardSampling, cardLocalTime, cardCacheIdentity } from '../card-identity.mjs';
import { frameIdentity } from '../frame-identity.mjs';
const graph = () => ({ nodes: [
  { id: 'source', adapter: 'media', media: { stamp: '1' } },
  { id: 'effect', adapter: 'card', cardId: 'invert', kind: 'filter', params: { amount: .5 }, inputs: { source: 'source' } },
  { id: 'dom', adapter: 'chrome', cardId: 'title', inputs: {} },
  { id: 'unrelated', adapter: 'media', media: { stamp: '2' } },
], outputs: [{ nodeId: 'effect', start: 10, end: 11 }] });
const style = () => ({ color: 'red', font: 'sans' });
test('node identity invalidates downstream source/code/used style, preserves unrelated nodes', () => {
  const value = graph();
  const base = cardNodeIdentities(value, { style: style() });
  value.outputs[0].start = 20;
  const moved = cardNodeIdentities(value, { style: style() });
  assert.deepEqual(base, moved); // Timeline position does not enter identity
  const restyled = cardNodeIdentities(value, { style: { color: 'blue', font: 'sans' } });
  assert.equal(base.get('source'), restyled.get('source'));
  // Media effect cards **intentionally** do not consume project.style (needed style values are
  // written into params), changing global style does not change its identity;
  // DOM cards consume style in full as usual, and test cases attach to it.
  assert.equal(base.get('effect'), restyled.get('effect'));
  assert.notEqual(base.get('dom'), restyled.get('dom'));
  const retuned = cardNodeIdentities({ ...value, nodes: value.nodes.map(n => n.id === 'effect' ? { ...n, params: { amount: .9 } } : n) }, { style: style() });
  assert.notEqual(base.get('effect'), retuned.get('effect'));
  // Whether input clips are deleted results in different visuals: after dropping edges, missingInputs enters digest
  const deleted = cardNodeIdentities({ ...value, nodes: value.nodes.map(n => n.id === 'effect' ? { ...n, inputs: { source: 'source', gone: '@clip/x/source' } } : n) }, { style: style() });
  assert.notEqual(base.get('effect'), deleted.get('effect'));
  value.nodes[0].media.stamp = 'edited';
  const edit = cardNodeIdentities(value, { style: style() });
  assert.notEqual(edit.get('effect'), base.get('effect'));
  assert.equal(edit.get('unrelated'), base.get('unrelated'));
});
test('local MOV sampling retains subframe phase and reuses integer-frame translations', () => {
  const sample = cardSampling(10.005, 60);
  assert.equal(sample.firstFrame, 601);
  assert.deepEqual(sample.phase, { numerator: '7', denominator: '600' });
  assert.equal(cardLocalTime(sample, 0).seconds, 7 / 600);
  assert.equal(cardLocalTime(sample, 1).seconds, 17 / 600);
  const shifted = cardSampling(20.005, 60);
  assert.equal(cardCacheIdentity('same', sample, 1), cardCacheIdentity('same', shifted, 1));
  assert.notEqual(cardCacheIdentity('same', sample, 1), cardCacheIdentity('same', cardSampling(10.006, 60), 1));
  assert.equal(cardSampling(0.1, 30).phase.numerator, '0');
});
test('whole scene cache includes the card graph nodes and global style', () => {
  // Source code of media effect card is not in project (it is a src/cards/user/<id>.tsx file);
  // whole-clip cache checks nodes
  const project = { tracks: [], media: [], cardNodes: [{ id: 'n', adapter: 'card', cardId: 'invert', params: { amount: .5 } }], style: { tint: 'red' } };
  const before = frameIdentity(project);
  project.cardNodes[0].params.amount = .9; assert.notEqual(frameIdentity(project), before);
  const code = frameIdentity(project); project.style.tint = 'blue'; assert.notEqual(frameIdentity(project), code);
});
test('Chrome TSX source versions and stamped media invalidate only their downstream card key', () => {
  const value = { definitions: [], nodes: [
    { id: 'media', adapter: 'media', media: { id: 'm', _frameSourceStamp: '10:1' }, inputs: {} },
    { id: 'tsx', adapter: 'chrome', cardId: 'tsx-card', inputs: { source: { nodeId: 'media' } } },
  ], outputs: [{ nodeId: 'tsx' }] };
  const before = cardNodeIdentities(value, { sourceVersions: { 'tsx-card': 'component-v1' } });
  const sourceEdit = cardNodeIdentities(value, { sourceVersions: { 'tsx-card': 'component-v2' } });
  assert.equal(before.get('media'), sourceEdit.get('media'));
  assert.notEqual(before.get('tsx'), sourceEdit.get('tsx'));
  value.nodes[0].media._frameSourceStamp = '11:2';
  const mediaEdit = cardNodeIdentities(value, { sourceVersions: { 'tsx-card': 'component-v2' } });
  assert.notEqual(sourceEdit.get('tsx'), mediaEdit.get('tsx'));
});
