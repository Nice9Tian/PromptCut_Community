/**
 * V8B:diffProject 提速前后的等价性对拍。跑:node --test src/kernel/diffProjectEquiv.test.mjs
 *
 * 2026-09-27 为了给 V8(1000 个片段的项目,单次差异 ≤ 5 ms)留出余量,diffProject 在带 id 数组的
 * 元素递归之前加了一道「这一对肯定不出操作」的廉价判断(noOpsBetween)。要求是任何输入下输出与
 * 提速前逐字节相同。下面的 referenceDiffProject 是提速前(main 8a5d6ff)的原样实现,只去掉了类型,
 * 只放在测试里当参照;每组随机输入两边各算一遍,逐条比操作:op、path、index 相等,value 是同一个
 * 对象(===,连引用都一样),另外再比一遍 JSON。详见 docs/archive/agent-reports/AGENT-v8-diff-perf.md。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { diffProject } from "./diffProject.ts";
import { rng, randProject, mutate, mutateOnce, realisticEdit, bigProject } from "../testing/randomProject.mjs";

/* ---------------- 提速前的实现(参照,勿改) ---------------- */

function refIsPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function refIsIdArray(a) {
  if (!Array.isArray(a)) return false;
  if (a.length === 0) return true;
  const seen = new Set();
  for (const e of a) {
    if (!refIsPlainObject(e)) return false;
    const id = e.id;
    if (typeof id !== "string" || id === "" || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

function refEscapeSegment(s) {
  if (s.indexOf("~") < 0 && s.indexOf("/") < 0) return s;
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}
const refKeyPath = (base, key) => `${base}/${refEscapeSegment(key)}`;
const refIdPath = (base, id) => `${base}/@${refEscapeSegment(id)}`;

function refDeepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!refDeepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  let na = 0;
  for (const k in a) {
    if (!Object.prototype.hasOwnProperty.call(a, k) || a[k] === undefined) continue;
    na++;
    if (!Object.prototype.hasOwnProperty.call(b, k) || !refDeepEqual(a[k], b[k])) return false;
  }
  let nb = 0;
  for (const k in b) {
    if (Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined) nb++;
  }
  return na === nb;
}

class RefTooMany extends Error {}

function refPush(ctx, op, inv) {
  ctx.ops.push(op);
  ctx.inv.push(inv);
  if (ctx.ops.length > ctx.limit) throw new RefTooMany();
}

const refHas = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

function refDiffValue(prev, next, path, ctx) {
  if (prev === next) return;
  if (refIsPlainObject(prev) && refIsPlainObject(next)) {
    refDiffObject(prev, next, path, ctx);
    return;
  }
  if (Array.isArray(prev) && Array.isArray(next) && refIsIdArray(prev) && refIsIdArray(next)) {
    refDiffIdArray(prev, next, path, ctx);
    return;
  }
  if (refDeepEqual(prev, next)) return;
  refPush(ctx, { op: "set", path, value: next }, { op: "set", path, value: prev });
}

function refDiffObject(prev, next, path, ctx) {
  for (const k in prev) {
    if (!refHas(prev, k)) continue;
    if (!refHas(next, k)) {
      const p = refKeyPath(path, k);
      refPush(ctx, { op: "remove", path: p }, { op: "set", path: p, value: prev[k] });
    }
  }
  for (const k in next) {
    if (!refHas(next, k)) continue;
    const b = next[k];
    if (!refHas(prev, k)) {
      const p = refKeyPath(path, k);
      refPush(ctx, { op: "set", path: p, value: b }, { op: "remove", path: p });
      continue;
    }
    const a = prev[k];
    if (a === b) continue;
    refDiffValue(a, b, refKeyPath(path, k), ctx);
  }
}

function refLisIndices(seq) {
  const tails = [];
  const prevIdx = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prevIdx[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Set();
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) {
    out.add(k);
    k = prevIdx[k];
  }
  return out;
}

function refDiffIdArray(prev, next, path, ctx) {
  const nextIndex = new Map();
  for (let i = 0; i < next.length; i++) nextIndex.set(next[i].id, i);
  const prevById = new Map();
  for (const e of prev) prevById.set(e.id, e);
  const work = prev.map((e) => e.id);
  for (let i = work.length - 1; i >= 0; i--) {
    const id = work[i];
    if (nextIndex.has(id)) continue;
    const p = refIdPath(path, id);
    refPush(ctx, { op: "remove", path: p }, { op: "insert", path, index: i, value: prevById.get(id) });
    work.splice(i, 1);
  }
  const targets = work.map((id) => nextIndex.get(id));
  const keepPos = refLisIndices(targets);
  const stable = new Set();
  for (const pos of keepPos) stable.add(work[pos]);
  if (!(stable.size === work.length && work.length === next.length)) {
    for (let t = 0; t < next.length; t++) {
      const id = next[t].id;
      if (stable.has(id)) continue;
      const at = t === 0 ? 0 : work.indexOf(next[t - 1].id) + 1;
      if (prevById.has(id)) {
        const from = work.indexOf(id);
        work.splice(from, 1);
        const to = from < at ? at - 1 : at;
        work.splice(to, 0, id);
        if (to !== from) {
          const p = refIdPath(path, id);
          refPush(ctx, { op: "move", path: p, index: to }, { op: "move", path: p, index: from });
        }
      } else {
        work.splice(at, 0, id);
        refPush(ctx, { op: "insert", path, index: at, value: next[t] }, { op: "remove", path: refIdPath(path, id) });
      }
      stable.add(id);
    }
  }
  for (const e of next) {
    const id = e.id;
    const before = prevById.get(id);
    if (before !== undefined && before !== e) refDiffValue(before, e, refIdPath(path, id), ctx);
  }
}

function referenceDiffProject(prev, next, opts = {}) {
  const limit = opts.limit ?? 500;
  const ctx = { ops: [], inv: [], limit };
  try {
    refDiffValue(prev, next, "", ctx);
  } catch (e) {
    if (!(e instanceof RefTooMany)) throw e;
    return { ops: [{ op: "set", path: "", value: next }], inverse: [{ op: "set", path: "", value: prev }] };
  }
  return { ops: ctx.ops, inverse: ctx.inv.reverse() };
}

/* ---------------- 对拍 ---------------- */

/** 逐条比:键的顺序、op、path、index 相同,value 是同一个引用;再比一遍 JSON(逐字节) */
function sameOps(label, got, want) {
  assert.equal(got.length, want.length, `${label}:条数 ${got.length} ≠ ${want.length}`);
  for (let i = 0; i < want.length; i++) {
    const g = got[i];
    const w = want[i];
    assert.deepEqual(Object.keys(g), Object.keys(w), `${label} 第 ${i} 条的键`);
    assert.equal(g.op, w.op, `${label} 第 ${i} 条的 op`);
    assert.equal(g.path, w.path, `${label} 第 ${i} 条的 path`);
    assert.ok(Object.is(g.index, w.index), `${label} 第 ${i} 条的 index`);
    assert.ok(Object.is(g.value, w.value), `${label} 第 ${i} 条的 value 不是同一个引用`);
  }
}

let checked = 0;
function check(label, prev, next, opts) {
  const want = referenceDiffProject(prev, next, opts);
  const got = diffProject(prev, next, opts);
  sameOps(`${label} ops`, got.ops, want.ops);
  sameOps(`${label} inverse`, got.inverse, want.inverse);
  assert.equal(JSON.stringify(got), JSON.stringify(want), `${label}:JSON 不同`);
  checked++;
  return want.ops.length;
}

const randLimit = (r) => (r.chance(0.2) ? r.int(8) : undefined);

test("V8B-1 随机项目 × 深拷贝后随机改 1~12 处(mutate),3000 组", () => {
  const r = rng(80001);
  let withOps = 0;
  for (let i = 0; i < 3000; i++) {
    const prev = randProject(r);
    const next = mutate(r, prev, 1 + r.int(12));
    if (check(`V8B-1 #${i}`, prev, next, { limit: randLimit(r) }) > 0) withOps++;
  }
  assert.ok(withOps > 2500, `出操作的组太少:${withOps}`);
});

test("V8B-2 像编辑器 action 的不可变更新(拖动、改参数、删、加、换序、改序列、加删序列、改设置),连改链 3000 步;每步另比一次整份深拷贝", () => {
  const r = rng(80002);
  let p = randProject(r, { maxTracks: 5 });
  for (let i = 0; i < 3000; i++) {
    if (i % 100 === 0) p = randProject(r, { maxTracks: 5 });
    const next = realisticEdit(r, p);
    check(`V8B-2 #${i} 不可变`, p, next, { limit: randLimit(r) });
    check(`V8B-2 #${i} 深拷贝`, p, structuredClone(next));
    p = next;
  }
});

test("V8B-3 整份深拷贝后只改一处 / 一处不改,3000 组", () => {
  const r = rng(80003);
  let empty = 0;
  for (let i = 0; i < 3000; i++) {
    const prev = randProject(r);
    const next = structuredClone(prev);
    if (r.chance(0.85)) mutateOnce(r, next);
    if (check(`V8B-3 #${i}`, prev, next) === 0) empty++;
  }
  assert.ok(empty > 300, `不出操作的组太少:${empty}`);
});

test("V8B-4 1000 个片段的大项目:深拷贝后在随机位置改一处 / 换序 / 删加,300 组", () => {
  const r = rng(80004);
  const prev = bigProject(r, 1000);
  for (let i = 0; i < 300; i++) {
    const next = structuredClone(prev);
    const t = next.tracks[r.int(next.tracks.length)];
    const c = t.clips[r.int(t.clips.length)];
    switch (r.int(8)) {
      case 0: c.start += 1; break;
      case 1: c.params.shadow.blur = r.int(9); break;
      case 2: c.params.items.push("d"); break;
      case 3: t.clips.splice(r.int(t.clips.length), 1); break;
      case 4: { const [el] = t.clips.splice(r.int(t.clips.length), 1); t.clips.splice(r.int(t.clips.length + 1), 0, el); break; }
      case 5: c.frame = { ...c.frame, x: -1 }; break;
      case 6: delete c.fadeOut; break;
      default: mutateOnce(r, next);
    }
    check(`V8B-4 #${i}`, prev, next);
  }
});

test("V8B-5 毫不相干的两个随机项目,1000 组", () => {
  const r = rng(80005);
  for (let i = 0; i < 1000; i++) check(`V8B-5 #${i}`, randProject(r), randProject(r), { limit: randLimit(r) });
});

/* 刁钻输入:undefined 值、NaN、-0、无原型对象、类实例、Date、键的顺序不同、不可枚举的自有属性、
   继承来的可枚举属性、稀疏数组、重复 id、空 id、非字符串 id、元素不是普通对象的「带 id 数组」 */

class Box {
  constructor(v) {
    this.v = v;
  }
}

function weirdScalar(r) {
  return r.pick([undefined, null, NaN, -0, 0, 1, 2, "", "a", "a/b", "~x", true, false]);
}

function weirdValue(r, depth) {
  const roll = r.int(12);
  if (depth > 3 || roll < 4) return weirdScalar(r);
  if (roll < 6) return weirdObject(r, depth + 1);
  if (roll < 7) return new Box(weirdScalar(r));
  if (roll < 8) return r.chance(0.5) ? new Date(1000 * r.int(3)) : Array.from({ length: r.int(4) }, () => weirdScalar(r));
  return weirdIdArray(r, depth + 1);
}

const WK = ["id", "a", "b", "c", "x/y", "~0", "__proto__", "constructor", "0"];

function weirdObject(r, depth) {
  const o = r.chance(0.2) ? Object.create(null) : {};
  const n = r.int(5);
  for (let i = 0; i < n; i++) {
    const k = r.pick(WK);
    if (k === "__proto__") Object.defineProperty(o, k, { value: weirdValue(r, depth), enumerable: true, writable: true, configurable: true });
    else o[k] = weirdValue(r, depth);
  }
  return o;
}

let wid = 0;
function weirdIdArray(r, depth) {
  const n = r.int(5);
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = weirdObject(r, depth);
    const roll = r.int(20);
    if (roll === 0) e.id = "";
    else if (roll === 1) e.id = 7;
    else if (roll === 2 && out.length) e.id = out[0].id; // 重复 id
    else e.id = `w${(wid++).toString(36)}${r.chance(0.1) ? "/~" : ""}`;
    out.push(roll === 3 ? Object.defineProperties(new Box(1), Object.getOwnPropertyDescriptors(e)) : e); // 带 id 的类实例
  }
  if (r.chance(0.05)) out.length += 1; // 末尾一个空位
  return out;
}

/** 深拷贝,并按概率在各处做刁钻的改动;有时整棵子树原样共享(身份相同) */
function perturb(r, v, p) {
  if (v === null || typeof v !== "object") {
    if (r.chance(p)) return weirdScalar(r);
    return v;
  }
  if (r.chance(0.15)) return v; // 共享
  if (Object.prototype.toString.call(v) === "[object Date]") return r.chance(p) ? new Date(v.getTime() + 1) : new Date(v.getTime());
  if (v instanceof Box) {
    const b = new Box(perturb(r, v.v, p));
    for (const k of Object.keys(v)) {
      if (k !== "v") Object.defineProperty(b, k, { value: perturb(r, v[k], p), enumerable: true, writable: true, configurable: true });
    }
    return r.chance(p) ? { ...b } : b; // 类实例变成普通对象
  }
  if (Array.isArray(v)) {
    const a = new Array(v.length);
    for (let i = 0; i < v.length; i++) if (i in v) a[i] = perturb(r, v[i], p);
    if (a.length > 1 && r.chance(p)) { const i = r.int(a.length); const j = r.int(a.length); [a[i], a[j]] = [a[j], a[i]]; }
    if (a.length && r.chance(p / 2)) a.splice(r.int(a.length), 1);
    if (r.chance(p / 2)) a.splice(r.int(a.length + 1), 0, weirdValue(r, 3));
    if (a.length && r.chance(p / 3) && a[0] && typeof a[0] === "object") a.push({ ...a[0] }); // 造重复 id
    return a;
  }
  // 普通对象 / 无原型对象:可能换原型、倒序键、加不可枚举属性
  const keys = Object.keys(v);
  if (r.chance(0.2)) keys.reverse();
  const proto = r.chance(p / 2) ? (Object.getPrototypeOf(v) === null ? Object.prototype : null) : Object.getPrototypeOf(v);
  const o = Object.create(proto);
  for (const k of keys) {
    if (r.chance(p / 2)) continue; // 删键
    const val = r.chance(p / 3) ? undefined : perturb(r, v[k], p);
    Object.defineProperty(o, k, { value: val, enumerable: true, writable: true, configurable: true });
  }
  if (r.chance(p / 2)) o[r.pick(WK.filter((k) => k !== "__proto__"))] = weirdValue(r, 3);
  if (r.chance(p / 4) && keys.length) {
    // 把一个键改成不可枚举(值不变)
    const k = r.pick(keys);
    if (Object.prototype.hasOwnProperty.call(o, k)) Object.defineProperty(o, k, { enumerable: false });
  }
  if (r.chance(p / 4)) Object.defineProperty(o, "hidden", { value: 1, enumerable: false });
  return o;
}

test("V8B-6 刁钻输入(undefined、NaN、-0、无原型、类实例、Date、键序、不可枚举、稀疏、重复 id…),5000 组", () => {
  const r = rng(80006);
  let empty = 0;
  // 继承来的可枚举属性:让一部分对象的原型带一个可枚举键
  const protoWithKey = Object.create(Object.prototype, { a: { value: 9, enumerable: true, writable: true } });
  for (let i = 0; i < 5000; i++) {
    const prev = weirdObject(r, 0);
    prev.list = weirdIdArray(r, 1);
    if (r.chance(0.1)) prev.inh = Object.assign(Object.create(protoWithKey), { b: 1 });
    const next = perturb(r, prev, r.pick([0, 0.02, 0.1, 0.3]));
    if (check(`V8B-6 #${i}`, prev, next, { limit: randLimit(r) }) === 0) empty++;
  }
  assert.ok(empty > 500, `不出操作的组太少:${empty}`);
});

test("V8B-7 刁钻值塞进随机项目的片段里,再深拷贝加刁钻改动,2000 组", () => {
  const r = rng(80007);
  for (let i = 0; i < 2000; i++) {
    const prev = randProject(r);
    for (const t of prev.tracks) for (const c of t.clips) if (r.chance(0.3)) c.params.w = weirdValue(r, 1);
    const next = perturb(r, prev, r.pick([0, 0.01, 0.05]));
    check(`V8B-7 #${i}`, prev, next);
  }
});

test("V8B-8 手写的边角:只在不可枚举属性、重复 id、NaN、undefined 键、键序、原型上才分得出来的情形", () => {
  const hidden = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: false, writable: true, configurable: true });
  // 都包在一个带 id 数组的元素里,这样才会走到「先判不出操作」那一步
  const wrap = (v) => ({ list: [{ id: "outer", v }] });
  const cases = [
    // id 有重复(不是带 id 的数组)、逐个比都不出操作、但 deepEqual 为 false:旧实现整个 set
    () => [[hidden({ id: "d", x: 1 }, "y", 2), { id: "d" }], [{ id: "d", x: 1, y: 2 }, { id: "d" }]],
    // id 不可枚举且两边换了顺序:逐个比看不见 id,只有 id 对齐那一步拦得住
    () => [[hidden({ v: 1 }, "id", "a"), hidden({ v: 1 }, "id", "b")], [hidden({ v: 1 }, "id", "b"), hidden({ v: 1 }, "id", "a")]],
    () => [{ a: NaN }, { a: NaN }],
    () => [{ a: 1, b: undefined }, { a: 1 }],
    () => [{ a: 1, b: undefined }, { a: 1, c: 2 }],
    () => [{ a: 1, b: 2 }, { b: 2, a: 1 }],
    () => [{ a: 0 }, { a: -0 }],
    () => [Object.assign(Object.create(null), { a: 1 }), { a: 1 }],
    () => [[{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "a" }]],
    () => [[{ id: "a" }, { id: "" }], [{ id: "a" }, { id: "" }]],
    () => [[1, 2], [1, 2]],
    () => [[1, 2], { 0: 1, 1: 2 }],
    () => [new Date(0), new Date(1)],
    () => [hidden({ a: 1 }, "b", 2), { a: 1, b: 2 }],
    () => [{ a: 1, b: 2 }, hidden({ a: 1 }, "b", 2)],
  ];
  let n = 0;
  for (const make of cases) {
    const [a, b] = make();
    check(`V8B-8 #${n} 直接`, a, b);
    check(`V8B-8 #${n} 包一层`, wrap(a), wrap(b));
    n++;
  }
});

test("V8B-9 合计对拍组数", () => {
  assert.ok(checked >= 20000, `对拍组数不够:${checked}`);
  console.log(`V8B 对拍 ${checked} 组,两边逐条相同`);
});
