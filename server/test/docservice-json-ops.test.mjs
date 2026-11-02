/**
 * Generic JSON path engine (`server/docservice/json-ops.mjs`; C6.5 design draft section 2,
 * exact semantics `docs/plan/c65-ops-spec.md`).
 * Test cases DS-J1 to DS-J12.
 * Run: node --test server/test/docservice-json-ops.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOps, checkOps, parsePath, formatPath, idSegment, entityOf, entitiesOf, normalizeEntity, jsonEqual, OpError,
} from '../docservice/json-ops.mjs';

const base = () => ({
  width: 1920,
  fps: 30,
  tracks: [
    { id: 't1', name: 'A', clips: [{ id: 'c1', start: 0, frame: { x: 1 } }, { id: 'c2', start: 1 }, { id: 'c3', start: 2 }] },
    { id: 't2', name: 'B', clips: [] },
  ],
  filters: [{ id: 'f1', params: { a: 1 } }],
  offsets: [[0, 1], [2, 3]],
});

const deepFreeze = (v) => {
  if (v && typeof v === 'object') {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
};

const codeOf = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof OpError, `should throw OpError: ${err}`);
    return err.code;
  }
  return null;
};

test('DS-J1 paths: the empty string is the root; ~0 ~1 unescaping; an @ segment carries an id; invalid syntax returns null; formatPath round trip', () => {
  assert.deepEqual(parsePath(''), []);
  assert.deepEqual(parsePath('/a~1b/@x~0y/c'), [{ text: 'a/b', id: null }, { text: '@x~y', id: 'x~y' }, { text: 'c', id: null }]);
  assert.equal(parsePath('a'), null);
  assert.equal(parsePath('/a~2'), null);
  assert.equal(parsePath('/@'), null);
  assert.equal(parsePath(5), null);
  for (const p of ['', '/a', '/a~1b/@x~0y/c', '/tracks/@t1/clips/@c3/frame/x']) assert.equal(formatPath(parsePath(p)), p);
  assert.equal(idSegment('a/b'), '@a~1b');
});

test('DS-J2 set: changes a deep value by @id; missing parent objects are created along with it; the old root is not changed by a single byte', () => {
  const prev = deepFreeze(base());
  const before = JSON.stringify(prev);
  const { root } = applyOps(prev, [
    { op: 'set', path: '/tracks/@t1/clips/@c3/frame/x', value: 120 },
    { op: 'set', path: '/meta/new/deep', value: true },
  ]);
  assert.equal(JSON.stringify(prev), before, 'the root passed in is unchanged');
  assert.deepEqual(root.tracks[0].clips[2].frame, { x: 120 });
  assert.deepEqual(root.meta, { new: { deep: true } });
  assert.equal(root.tracks[1], prev.tracks[1], 'branches not walked are shared as is');
});

test('DS-J3 set bad-path: @id not found in the array, an index used on an array, a scalar or null midway, an array element given a different id', () => {
  const prev = base();
  prev.nothing = null;
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'set', path: '/tracks/@t9/name', value: 'x' }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'set', path: '/tracks/0/name', value: 'x' }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'set', path: '/width/x', value: 1 }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'set', path: '/nothing/x', value: 1 }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'set', path: '/tracks/@t1', value: { id: 't9' } }])), 'bad-path');
  const { root } = applyOps(prev, [{ op: 'set', path: '/tracks/@t2', value: { id: 't2', name: 'Z', clips: [] } }]);
  assert.equal(root.tracks[1].name, 'Z', 'replacing the whole element (same id) is allowed');
});

test('DS-J4 remove: a missing parent is bad-path; a missing target is noop; in an array, removal is by @id', () => {
  const prev = base();
  const r = applyOps(prev, [
    { op: 'remove', path: '/tracks/@t1/clips/@c2' },
    { op: 'remove', path: '/tracks/@t1/clips/@c99' },
    { op: 'remove', path: '/fps' },
    { op: 'remove', path: '/nope' },
  ]);
  assert.deepEqual(r.root.tracks[0].clips.map((c) => c.id), ['c1', 'c3']);
  assert.equal('fps' in r.root, false);
  assert.deepEqual(r.effects.map((e) => e.noop), [false, true, false, true]);
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'remove', path: '/tracks/@t9/clips/@c1' }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'remove', path: '/nope/x' }])), 'bad-path');
});

test('DS-J5 insert: inserts at an index, an index past the end inserts at the end; an existing id or a non-array target is bad-path', () => {
  const prev = base();
  const { root, effects } = applyOps(prev, [
    { op: 'insert', path: '/tracks/@t1/clips', index: 1, value: { id: 'c10' } },
    { op: 'insert', path: '/tracks/@t1/clips', index: 99, value: { id: 'c11' } },
    { op: 'insert', path: '/tracks/@t2/clips', index: 0, value: { id: 'c12' } },
  ]);
  assert.deepEqual(root.tracks[0].clips.map((c) => c.id), ['c1', 'c10', 'c2', 'c3', 'c11']);
  assert.deepEqual(root.tracks[1].clips.map((c) => c.id), ['c12']);
  assert.equal(effects[0].target, '/tracks/@t1/clips/@c10');
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'insert', path: '/tracks/@t1/clips', index: 0, value: { id: 'c1' } }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'insert', path: '/width', index: 0, value: { id: 'x' } }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'insert', path: '/missing', index: 0, value: { id: 'x' } }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'insert', path: '/offsets', index: 0, value: { id: 'x' } }])), 'bad-path', 'insert is not allowed on an array without ids');
  assert.equal(codeOf(() => applyOps({ a: [{ id: 5 }] }, [{ op: 'set', path: '/a/@5/x', value: 1 }])), 'bad-path', 'ids are matched only by strict string equality');
});

test('DS-J6 move: index is the index after the move, an index past the end means the end; a missing element is noop; a missing array is bad-path', () => {
  const prev = base();
  const ids = (ops) => applyOps(prev, ops).root.tracks[0].clips.map((c) => c.id);
  assert.deepEqual(ids([{ op: 'move', path: '/tracks/@t1/clips/@c3', index: 0 }]), ['c3', 'c1', 'c2']);
  assert.deepEqual(ids([{ op: 'move', path: '/tracks/@t1/clips/@c1', index: 1 }]), ['c2', 'c1', 'c3']);
  assert.deepEqual(ids([{ op: 'move', path: '/tracks/@t1/clips/@c1', index: 50 }]), ['c2', 'c3', 'c1']);
  const r = applyOps(prev, [{ op: 'move', path: '/tracks/@t1/clips/@c99', index: 0 }]);
  assert.equal(r.effects[0].noop, true);
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'move', path: '/tracks/@t9/clips/@c1', index: 0 }])), 'bad-path');
});

test('DS-J7 the whole batch is atomic: if a later op fails, the whole batch is discarded and the old root is unchanged', () => {
  const prev = deepFreeze(base());
  const text = JSON.stringify(prev);
  assert.equal(codeOf(() => applyOps(prev, [
    { op: 'set', path: '/width', value: 1 },
    { op: 'remove', path: '/tracks/@t1/clips/@c1' },
    { op: 'set', path: '/tracks/@nope/x', value: 1 },
  ])), 'bad-path');
  assert.equal(JSON.stringify(prev), text);
});

test('DS-J8 root replacement; with no content, set creates the root and other operations get bad-path', () => {
  const { root } = applyOps(base(), [{ op: 'set', path: '', value: { a: 1 } }]);
  assert.deepEqual(root, { a: 1 });
  assert.deepEqual(applyOps(null, [{ op: 'set', path: '/a/b', value: 2 }]).root, { a: { b: 2 } });
  assert.equal(codeOf(() => applyOps(null, [{ op: 'remove', path: '/a' }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(undefined, [{ op: 'insert', path: '', index: 0, value: { id: 'x' } }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(base(), [{ op: 'set', path: '', value: [1] }])), 'bad-op', 'the value of a root replacement must be a plain object');
});

test('DS-J9 a malformed op is bad-op (unrelated to the document): unknown operation, bad path, set without value, remove of the root, insert without id, move with a non-@ last segment, negative index', () => {
  const bads = [
    [{ op: 'copy', path: '/a' }],
    [{ op: 'set', path: 'a', value: 1 }],
    [{ op: 'set', path: '/a' }],
    [{ op: 'remove', path: '' }],
    [{ op: 'insert', path: '/tracks', index: 0, value: { name: 'x' } }],
    [{ op: 'move', path: '/tracks/x', index: 0 }],
    [{ op: 'insert', path: '/tracks', index: -1, value: { id: 'x' } }],
    [{ op: 'insert', path: '/tracks', index: 0, value: { id: 5 } }],
    [{ op: 'set', path: '', value: null }],
    'nope',
  ];
  for (const ops of bads) assert.equal(codeOf(() => checkOps(ops)), 'bad-op', JSON.stringify(ops));
});

test('DS-J10 a __proto__ key is written as an ordinary key and does not change the prototype', () => {
  const { root } = applyOps({}, [{ op: 'set', path: '/__proto__/polluted', value: 1 }]);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(root), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(root)), JSON.parse('{"__proto__":{"polluted":1}}'));
});

test('DS-J11 entity: the longest prefix of /<name>/@<id> pairs starting at the root, with the names optionally restricted; with no pair at all it is filed under /meta/<key> by top-level key; the root is *', () => {
  const o = { names: ['tracks', 'clips', 'transitions'] };
  assert.equal(entityOf('/tracks/@t1/clips/@c3/frame/x', o), '/tracks/@t1/clips/@c3');
  assert.equal(entityOf('/tracks/@t1/clips/@c3/parts/@p1/params/a', o), '/tracks/@t1/clips/@c3');
  assert.equal(entityOf('/tracks/@t1/clips/@c3/parts/@p1/params/a'), '/tracks/@t1/clips/@c3/parts/@p1', 'names is unrestricted when not given');
  assert.equal(entityOf('/cuts/@k2/tracks/@t1/clips/@c3/start', o), '/cuts/@k2/tracks/@t1/clips/@c3');
  assert.equal(entityOf('/tracks/@t1/name', o), '/tracks/@t1');
  assert.equal(entityOf('/filters/@f1/params/a', o), '/filters/@f1');
  assert.equal(entityOf('/width', o), '/meta/width', 'each top-level scalar counts as one entity (integration ruling)');
  assert.equal(entityOf('/tracks', o), '/meta/tracks');
  assert.equal(entityOf('/style/x/@y', o), '/meta/style', 'pairs must start at the root');
  assert.equal(entityOf('/a~1b', o), '/meta/a~1b', 'top-level keys are escaped as well');
  assert.equal(normalizeEntity('/meta/fps', o), '/meta/fps', 'a name that is already an entity name is returned as is');
  assert.equal(normalizeEntity('/fps', o), '/meta/fps');
  assert.equal(normalizeEntity('*', o), '*');
  assert.equal(normalizeEntity('/tracks/@t1/clips/@c3/x', o), '/tracks/@t1/clips/@c3');
  assert.equal(entityOf('', o), '*');
  assert.equal(entityOf('bad'), null);
});

test('DS-J12 entitiesOf: set counts by actual difference; insert counts the new element; noop does not count; root replacement compares entity by entity', () => {
  const prev = base();
  const r1 = applyOps(prev, [
    { op: 'set', path: '/tracks/@t1/clips/@c1/frame/x', value: 1 }, // Value did not change
    { op: 'set', path: '/tracks/@t1/clips/@c2/start', value: 9 },
    { op: 'insert', path: '/tracks/@t2/clips', index: 0, value: { id: 'c7' } },
    { op: 'remove', path: '/tracks/@t1/clips/@zz' },
    { op: 'set', path: '/fps', value: 60 },
  ]);
  assert.deepEqual(entitiesOf(r1.effects), ['/tracks/@t1/clips/@c2', '/tracks/@t2/clips/@c7', '/meta/fps']);

  const next = structuredClone(prev);
  next.tracks[0].clips[2].start = 5; // c3
  next.tracks[0].name = 'A2'; // t1 itself
  next.filters.push({ id: 'f2' }); // New effect
  next.tracks[1].clips.push({ id: 'c8' });
  const r2 = applyOps(prev, [{ op: 'set', path: '', value: next }]);
  assert.deepEqual(new Set(entitiesOf(r2.effects)), new Set(['/tracks/@t1/clips/@c3', '/tracks/@t1', '/filters/@f2', '/tracks/@t2/clips/@c8']));

  // Order changed: record to the entity the array itself belongs to
  const moved = structuredClone(prev);
  moved.tracks[0].clips.reverse();
  assert.deepEqual(entitiesOf(applyOps(prev, [{ op: 'set', path: '', value: moved }]).effects), ['/tracks/@t1']);
  assert.ok(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }));
});
