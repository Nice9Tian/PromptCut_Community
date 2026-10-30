/**
 * 通用 JSON 路径引擎（`server/docservice/json-ops.mjs`；C6.5 设计稿第 2 节，精确语义 `docs/plan/c65-ops-spec.md`）。
 * 用例 DS-J1～DS-J12。
 * 跑：node --test server/test/docservice-json-ops.test.mjs
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
    assert.ok(err instanceof OpError, `应当抛 OpError：${err}`);
    return err.code;
  }
  return null;
};

test('DS-J1 路径：空串是根；~0 ~1 反转义；@ 段带 id；语法不对回 null；formatPath 往返', () => {
  assert.deepEqual(parsePath(''), []);
  assert.deepEqual(parsePath('/a~1b/@x~0y/c'), [{ text: 'a/b', id: null }, { text: '@x~y', id: 'x~y' }, { text: 'c', id: null }]);
  assert.equal(parsePath('a'), null);
  assert.equal(parsePath('/a~2'), null);
  assert.equal(parsePath('/@'), null);
  assert.equal(parsePath(5), null);
  for (const p of ['', '/a', '/a~1b/@x~0y/c', '/tracks/@t1/clips/@c3/frame/x']) assert.equal(formatPath(parsePath(p)), p);
  assert.equal(idSegment('a/b'), '@a~1b');
});

test('DS-J2 set：按 @id 改深处的值；缺的父级对象一起建；旧的根一个字节不改', () => {
  const prev = deepFreeze(base());
  const before = JSON.stringify(prev);
  const { root } = applyOps(prev, [
    { op: 'set', path: '/tracks/@t1/clips/@c3/frame/x', value: 120 },
    { op: 'set', path: '/meta/new/deep', value: true },
  ]);
  assert.equal(JSON.stringify(prev), before, '传入的根不变');
  assert.deepEqual(root.tracks[0].clips[2].frame, { x: 120 });
  assert.deepEqual(root.meta, { new: { deep: true } });
  assert.equal(root.tracks[1], prev.tracks[1], '没走过的分支原样共享');
});

test('DS-J3 set 的 bad-path：数组里找不到 @id、在数组上用下标、中途是标量或 null、数组元素换 id', () => {
  const prev = base();
  prev.nothing = null;
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'set', path: '/tracks/@t9/name', value: 'x' }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'set', path: '/tracks/0/name', value: 'x' }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'set', path: '/width/x', value: 1 }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'set', path: '/nothing/x', value: 1 }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'set', path: '/tracks/@t1', value: { id: 't9' } }])), 'bad-path');
  const { root } = applyOps(prev, [{ op: 'set', path: '/tracks/@t2', value: { id: 't2', name: 'Z', clips: [] } }]);
  assert.equal(root.tracks[1].name, 'Z', '整个元素替换（id 相同）可以');
});

test('DS-J4 remove：父级不存在是 bad-path；目标不存在是 noop；数组里按 @id 删', () => {
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

test('DS-J5 insert：按下标插，下标超长插到末尾；id 已存在或目标不是数组是 bad-path', () => {
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
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'insert', path: '/offsets', index: 0, value: { id: 'x' } }])), 'bad-path', '不带 id 的数组不能 insert');
  assert.equal(codeOf(() => applyOps({ a: [{ id: 5 }] }, [{ op: 'set', path: '/a/@5/x', value: 1 }])), 'bad-path', 'id 只按字符串全等配');
});

test('DS-J6 move：index 是挪完之后的下标，超长按末尾；元素不存在是 noop；数组不存在是 bad-path', () => {
  const prev = base();
  const ids = (ops) => applyOps(prev, ops).root.tracks[0].clips.map((c) => c.id);
  assert.deepEqual(ids([{ op: 'move', path: '/tracks/@t1/clips/@c3', index: 0 }]), ['c3', 'c1', 'c2']);
  assert.deepEqual(ids([{ op: 'move', path: '/tracks/@t1/clips/@c1', index: 1 }]), ['c2', 'c1', 'c3']);
  assert.deepEqual(ids([{ op: 'move', path: '/tracks/@t1/clips/@c1', index: 50 }]), ['c2', 'c3', 'c1']);
  const r = applyOps(prev, [{ op: 'move', path: '/tracks/@t1/clips/@c99', index: 0 }]);
  assert.equal(r.effects[0].noop, true);
  assert.equal(codeOf(() => applyOps(prev, [{ op: 'move', path: '/tracks/@t9/clips/@c1', index: 0 }])), 'bad-path');
});

test('DS-J7 整批原子：后面一条失败，整批作废、旧根不变', () => {
  const prev = deepFreeze(base());
  const text = JSON.stringify(prev);
  assert.equal(codeOf(() => applyOps(prev, [
    { op: 'set', path: '/width', value: 1 },
    { op: 'remove', path: '/tracks/@t1/clips/@c1' },
    { op: 'set', path: '/tracks/@nope/x', value: 1 },
  ])), 'bad-path');
  assert.equal(JSON.stringify(prev), text);
});

test('DS-J8 根替换；没有内容时 set 建根，别的操作 bad-path', () => {
  const { root } = applyOps(base(), [{ op: 'set', path: '', value: { a: 1 } }]);
  assert.deepEqual(root, { a: 1 });
  assert.deepEqual(applyOps(null, [{ op: 'set', path: '/a/b', value: 2 }]).root, { a: { b: 2 } });
  assert.equal(codeOf(() => applyOps(null, [{ op: 'remove', path: '/a' }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(undefined, [{ op: 'insert', path: '', index: 0, value: { id: 'x' } }])), 'bad-path');
  assert.equal(codeOf(() => applyOps(base(), [{ op: 'set', path: '', value: [1] }])), 'bad-op', '根替换的值必须是普通对象');
});

test('DS-J9 格式不对是 bad-op（与文档无关）：未知操作、坏路径、set 缺 value、remove 根、insert 无 id、move 非 @ 末段、负下标', () => {
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

test('DS-J10 __proto__ 键按普通键写，不改原型', () => {
  const { root } = applyOps({}, [{ op: 'set', path: '/__proto__/polluted', value: 1 }]);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(root), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(root)), JSON.parse('{"__proto__":{"polluted":1}}'));
});

test('DS-J11 实体：从根成对的 /<名>/@<id> 最长前缀，之后的名字可限定；一对都没有按顶层键归 /meta/<键>；根是 *', () => {
  const o = { names: ['tracks', 'clips', 'transitions'] };
  assert.equal(entityOf('/tracks/@t1/clips/@c3/frame/x', o), '/tracks/@t1/clips/@c3');
  assert.equal(entityOf('/tracks/@t1/clips/@c3/parts/@p1/params/a', o), '/tracks/@t1/clips/@c3');
  assert.equal(entityOf('/tracks/@t1/clips/@c3/parts/@p1/params/a'), '/tracks/@t1/clips/@c3/parts/@p1', 'names 不给时不限');
  assert.equal(entityOf('/cuts/@k2/tracks/@t1/clips/@c3/start', o), '/cuts/@k2/tracks/@t1/clips/@c3');
  assert.equal(entityOf('/tracks/@t1/name', o), '/tracks/@t1');
  assert.equal(entityOf('/filters/@f1/params/a', o), '/filters/@f1');
  assert.equal(entityOf('/width', o), '/meta/width', '顶层标量各算一个实体（集成裁定）');
  assert.equal(entityOf('/tracks', o), '/meta/tracks');
  assert.equal(entityOf('/style/x/@y', o), '/meta/style', '成对要从根开始');
  assert.equal(entityOf('/a~1b', o), '/meta/a~1b', '顶层键照样转义');
  assert.equal(normalizeEntity('/meta/fps', o), '/meta/fps', '已是实体名的原样返回');
  assert.equal(normalizeEntity('/fps', o), '/meta/fps');
  assert.equal(normalizeEntity('*', o), '*');
  assert.equal(normalizeEntity('/tracks/@t1/clips/@c3/x', o), '/tracks/@t1/clips/@c3');
  assert.equal(entityOf('', o), '*');
  assert.equal(entityOf('bad'), null);
});

test('DS-J12 entitiesOf：set 按实际差别算；insert 算新元素；noop 不算；根替换逐实体比', () => {
  const prev = base();
  const r1 = applyOps(prev, [
    { op: 'set', path: '/tracks/@t1/clips/@c1/frame/x', value: 1 }, // 值没变
    { op: 'set', path: '/tracks/@t1/clips/@c2/start', value: 9 },
    { op: 'insert', path: '/tracks/@t2/clips', index: 0, value: { id: 'c7' } },
    { op: 'remove', path: '/tracks/@t1/clips/@zz' },
    { op: 'set', path: '/fps', value: 60 },
  ]);
  assert.deepEqual(entitiesOf(r1.effects), ['/tracks/@t1/clips/@c2', '/tracks/@t2/clips/@c7', '/meta/fps']);

  const next = structuredClone(prev);
  next.tracks[0].clips[2].start = 5; // c3
  next.tracks[0].name = 'A2'; // t1 自身
  next.filters.push({ id: 'f2' }); // 新效果
  next.tracks[1].clips.push({ id: 'c8' });
  const r2 = applyOps(prev, [{ op: 'set', path: '', value: next }]);
  assert.deepEqual(new Set(entitiesOf(r2.effects)), new Set(['/tracks/@t1/clips/@c3', '/tracks/@t1', '/filters/@f2', '/tracks/@t2/clips/@c8']));

  // 顺序变了：记到数组本身所属的实体
  const moved = structuredClone(prev);
  moved.tracks[0].clips.reverse();
  assert.deepEqual(entitiesOf(applyOps(prev, [{ op: 'set', path: '', value: moved }]).effects), ['/tracks/@t1']);
  assert.ok(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }));
});
