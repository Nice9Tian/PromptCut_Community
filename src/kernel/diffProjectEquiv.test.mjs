/**
 * V8B: equivalence differential testing of diffProject before and after speedup.
 * Run: node --test src/kernel/diffProjectEquiv.test.mjs
 *
 * On 2026-09-27, to leave headroom for V8 (project with 1000 clips, single diff ≤ 5 ms),
 * diffProject added a cheap "this pair definitely produces no operations" check (noOpsBetween)
 * before recursing into elements of arrays with IDs. The requirement is that output under any input
 * must be byte-for-byte identical to before the speedup. Below, referenceDiffProject is the verbatim
 * implementation before the speedup (main 8a5d6ff), with only types removed, kept only in tests as
 * a reference; for each set of random inputs, both sides compute once, comparing operations item by
 * item: op, path, index are equal, value is the same object (===, even references match), plus an
 * additional byte-for-byte JSON comparison. See
 * docs/archive/agent-reports/AGENT-v8-diff-perf.md for details.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { diffProject } from "./diffProject.ts";
import { rng, randProject, mutate, mutateOnce, realisticEdit, bigProject } from "../testing/randomProject.mjs";

/* ---------------- Implementation before speedup (reference, do not modify) ---------------- */

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

/* ---------------- Differential testing ---------------- */

/** Compare item by item: key order, op, path, index identical, value is same reference; JSON re-compared byte-for-byte */
function sameOps(label, got, want) {
  assert.equal(got.length, want.length, `${label}: entry count ${got.length} ≠ ${want.length}`);
  for (let i = 0; i < want.length; i++) {
    const g = got[i];
    const w = want[i];
    assert.deepEqual(Object.keys(g), Object.keys(w), `${label} entry ${i} keys`);
    assert.equal(g.op, w.op, `${label} entry ${i} op`);
    assert.equal(g.path, w.path, `${label} entry ${i} path`);
    assert.ok(Object.is(g.index, w.index), `${label} entry ${i} index`);
    assert.ok(Object.is(g.value, w.value), `${label} entry ${i} value is not the same reference`);
  }
}

let checked = 0;
function check(label, prev, next, opts) {
  const want = referenceDiffProject(prev, next, opts);
  const got = diffProject(prev, next, opts);
  sameOps(`${label} ops`, got.ops, want.ops);
  sameOps(`${label} inverse`, got.inverse, want.inverse);
  assert.equal(JSON.stringify(got), JSON.stringify(want), `${label}: JSON differs`);
  checked++;
  return want.ops.length;
}

const randLimit = (r) => (r.chance(0.2) ? r.int(8) : undefined);

test("V8B-1 random projects × 1~12 random edits after a deep copy (mutate), 3000 cases", () => {
  const r = rng(80001);
  let withOps = 0;
  for (let i = 0; i < 3000; i++) {
    const prev = randProject(r);
    const next = mutate(r, prev, 1 + r.int(12));
    if (check(`V8B-1 #${i}`, prev, next, { limit: randLimit(r) }) > 0) withOps++;
  }
  assert.ok(withOps > 2500, `Too few cases produce ops: ${withOps}`);
});

test("V8B-2 immutable updates like editor actions (drag, param edit, delete, add, reorder, edit track, add/delete track, edit settings), a chain of 3000 steps; each step is also compared against a whole deep copy", () => {
  const r = rng(80002);
  let p = randProject(r, { maxTracks: 5 });
  for (let i = 0; i < 3000; i++) {
    if (i % 100 === 0) p = randProject(r, { maxTracks: 5 });
    const next = realisticEdit(r, p);
    check(`V8B-2 #${i} immutable`, p, next, { limit: randLimit(r) });
    check(`V8B-2 #${i} deep copy`, p, structuredClone(next));
    p = next;
  }
});

test("V8B-3 edit one spot / edit nothing after a whole deep copy, 3000 cases", () => {
  const r = rng(80003);
  let empty = 0;
  for (let i = 0; i < 3000; i++) {
    const prev = randProject(r);
    const next = structuredClone(prev);
    if (r.chance(0.85)) mutateOnce(r, next);
    if (check(`V8B-3 #${i}`, prev, next) === 0) empty++;
  }
  assert.ok(empty > 300, `Too few cases produce no ops: ${empty}`);
});

test("V8B-4 large project with 1000 clips: after a deep copy, edit one spot / reorder / delete and add at random positions, 300 cases", () => {
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

test("V8B-5 two completely unrelated random projects, 1000 cases", () => {
  const r = rng(80005);
  for (let i = 0; i < 1000; i++) check(`V8B-5 #${i}`, randProject(r), randProject(r), { limit: randLimit(r) });
});

/* Corner-case inputs: undefined values, NaN, -0, prototype-less objects, class instances, Date,
   differing key orders, non-enumerable own properties, inherited enumerable properties,
   sparse arrays, duplicate ids, empty ids, non-string ids, "id-bearing arrays" whose elements
   are not plain objects */

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
    else if (roll === 2 && out.length) e.id = out[0].id; // Duplicate id
    else e.id = `w${(wid++).toString(36)}${r.chance(0.1) ? "/~" : ""}`;
    out.push(roll === 3 ? Object.defineProperties(new Box(1), Object.getOwnPropertyDescriptors(e)) : e); // Class instance with id
  }
  if (r.chance(0.05)) out.length += 1; // Empty slot at the end
  return out;
}

/** Deep copy with probabilistic corner-case mutations; sometimes an entire subtree is shared as-is (same identity) */
function perturb(r, v, p) {
  if (v === null || typeof v !== "object") {
    if (r.chance(p)) return weirdScalar(r);
    return v;
  }
  if (r.chance(0.15)) return v; // Shared
  if (Object.prototype.toString.call(v) === "[object Date]") return r.chance(p) ? new Date(v.getTime() + 1) : new Date(v.getTime());
  if (v instanceof Box) {
    const b = new Box(perturb(r, v.v, p));
    for (const k of Object.keys(v)) {
      if (k !== "v") Object.defineProperty(b, k, { value: perturb(r, v[k], p), enumerable: true, writable: true, configurable: true });
    }
    return r.chance(p) ? { ...b } : b; // Class instance becomes a plain object
  }
  if (Array.isArray(v)) {
    const a = new Array(v.length);
    for (let i = 0; i < v.length; i++) if (i in v) a[i] = perturb(r, v[i], p);
    if (a.length > 1 && r.chance(p)) { const i = r.int(a.length); const j = r.int(a.length); [a[i], a[j]] = [a[j], a[i]]; }
    if (a.length && r.chance(p / 2)) a.splice(r.int(a.length), 1);
    if (r.chance(p / 2)) a.splice(r.int(a.length + 1), 0, weirdValue(r, 3));
    if (a.length && r.chance(p / 3) && a[0] && typeof a[0] === "object") a.push({ ...a[0] }); // Create duplicate id
    return a;
  }
  // Plain object / prototype-less object: may swap prototype, reverse keys, add non-enumerable properties
  const keys = Object.keys(v);
  if (r.chance(0.2)) keys.reverse();
  const proto = r.chance(p / 2) ? (Object.getPrototypeOf(v) === null ? Object.prototype : null) : Object.getPrototypeOf(v);
  const o = Object.create(proto);
  for (const k of keys) {
    if (r.chance(p / 2)) continue; // Delete key
    const val = r.chance(p / 3) ? undefined : perturb(r, v[k], p);
    Object.defineProperty(o, k, { value: val, enumerable: true, writable: true, configurable: true });
  }
  if (r.chance(p / 2)) o[r.pick(WK.filter((k) => k !== "__proto__"))] = weirdValue(r, 3);
  if (r.chance(p / 4) && keys.length) {
    // Make a key non-enumerable (value unchanged)
    const k = r.pick(keys);
    if (Object.prototype.hasOwnProperty.call(o, k)) Object.defineProperty(o, k, { enumerable: false });
  }
  if (r.chance(p / 4)) Object.defineProperty(o, "hidden", { value: 1, enumerable: false });
  return o;
}

test("V8B-6 tricky inputs (undefined, NaN, -0, no prototype, class instances, Date, key order, non-enumerable, sparse, duplicate id…), 5000 cases", () => {
  const r = rng(80006);
  let empty = 0;
  // Inherited enumerable property: give some objects' prototypes an enumerable key
  const protoWithKey = Object.create(Object.prototype, { a: { value: 9, enumerable: true, writable: true } });
  for (let i = 0; i < 5000; i++) {
    const prev = weirdObject(r, 0);
    prev.list = weirdIdArray(r, 1);
    if (r.chance(0.1)) prev.inh = Object.assign(Object.create(protoWithKey), { b: 1 });
    const next = perturb(r, prev, r.pick([0, 0.02, 0.1, 0.3]));
    if (check(`V8B-6 #${i}`, prev, next, { limit: randLimit(r) }) === 0) empty++;
  }
  assert.ok(empty > 500, `Too few cases produce no ops: ${empty}`);
});

test("V8B-7 tricky values stuffed into the clips of random projects, then a deep copy plus tricky edits, 2000 cases", () => {
  const r = rng(80007);
  for (let i = 0; i < 2000; i++) {
    const prev = randProject(r);
    for (const t of prev.tracks) for (const c of t.clips) if (r.chance(0.3)) c.params.w = weirdValue(r, 1);
    const next = perturb(r, prev, r.pick([0, 0.01, 0.05]));
    check(`V8B-7 #${i}`, prev, next);
  }
});

test("V8B-8 hand-written corner cases: situations only distinguishable by non-enumerable properties, duplicate ids, NaN, undefined keys, key order, prototypes", () => {
  const hidden = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: false, writable: true, configurable: true });
  // All wrapped in an element of an id-bearing array so it reaches the "determine no operations first" step
  const wrap = (v) => ({ list: [{ id: "outer", v }] });
  const cases = [
    // Duplicate id (not an id-bearing array), item-by-item comparison produces no operations,
    // but deepEqual is false: old implementation sets the whole thing
    () => [[hidden({ id: "d", x: 1 }, "y", 2), { id: "d" }], [{ id: "d", x: 1, y: 2 }, { id: "d" }]],
    // id is non-enumerable and order is swapped on both sides: item-by-item comparison cannot
    // see id, only the id-alignment step catches it
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
    check(`V8B-8 #${n} direct`, a, b);
    check(`V8B-8 #${n} wrapped one level`, wrap(a), wrap(b));
    n++;
  }
});

test("V8B-9 total cross-checked cases", () => {
  assert.ok(checked >= 20000, `Not enough cross-checked cases: ${checked}`);
  console.log(`V8B cross-checked ${checked} cases, both sides identical entry by entry`);
});
