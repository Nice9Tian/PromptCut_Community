/**
 * 随机与墙上时钟钉死的单测。跑:node --test src/kernel/pinEntropy.test.mjs
 *
 * 这些错了都不会报错,只会让「导两遍」出两个画面 —— 而且只在用到随机的第三方素材上发作
 * (实测 lottie 的 wiggle / random 表达式)。所以把几条钉死:同一个起点出同一串数、
 * 墙上时钟跟着帧走、带参数的 Date 不受影响、crypto 也走种子。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { installPinnedEntropy, withSeededRandom, PINNED_EPOCH_MS } from "./pinEntropy.ts";

/** 沙箱:不碰测试进程自己的 Math / Date / crypto */
function makeHost() {
  const c = globalThis.crypto;
  return {
    Math: Object.create(Math),
    Date,
    crypto: { getRandomValues: c.getRandomValues.bind(c), randomUUID: c.randomUUID.bind(c) },
  };
}

test("After two independent pages install it, Math.random produces the same sequence of numbers", () => {
  const a = makeHost(), b = makeHost();
  installPinnedEntropy(a);
  installPinnedEntropy(b);
  const sa = Array.from({ length: 8 }, () => a.Math.random());
  const sb = Array.from({ length: 8 }, () => b.Math.random());
  assert.deepEqual(sa, sb);
  assert.ok(sa.every((x) => x >= 0 && x < 1));
});

test("The sequence after __pcResetRandom(1) is bit-for-bit identical to the original exportClock's mulberry32", () => {
  const h = makeHost();
  installPinnedEntropy(h);
  h.Math.random(); h.Math.random();          // 模块加载期先消耗几次
  h.__pcResetRandom(1);
  // 原 exportClock 里的实现,照抄一份当参照
  let s = 1;
  const ref = () => { s = (s + 0x6d2b79f5) | 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = 0; i < 16; i++) assert.equal(h.Math.random(), ref());
});

test("Wall clock = fixed epoch + current frame milliseconds; when the clock is not in place it is the epoch itself", () => {
  const h = makeHost();
  installPinnedEntropy(h);
  assert.equal(h.Date.now(), PINNED_EPOCH_MS);
  assert.equal(new h.Date().getTime(), PINNED_EPOCH_MS);
  h.__pcExportMs = 1234.4;
  assert.equal(h.Date.now(), PINNED_EPOCH_MS + 1234);
  assert.equal(new h.Date().getTime(), PINNED_EPOCH_MS + 1234);
  assert.equal(h.Date(), new Date(PINNED_EPOCH_MS + 1234).toString());
  delete h.__pcExportMs;
  h.__pcStageClock = { now: () => 500 };
  assert.equal(h.Date.now(), PINNED_EPOCH_MS + 500);
});

test("A Date with arguments is a calculation, not a clock read, and is left untouched; instanceof works as before", () => {
  const h = makeHost();
  installPinnedEntropy(h);
  assert.equal(new h.Date(0).getTime(), 0);
  assert.equal(new h.Date("2020-02-03T00:00:00Z").getTime(), Date.UTC(2020, 1, 3));
  assert.equal(new h.Date(2021, 0, 1).getFullYear(), 2021);
  assert.equal(h.Date.UTC(2000, 0, 1), Date.UTC(2000, 0, 1));
  assert.equal(h.Date.parse("1970-01-01T00:00:01Z"), 1000);
  assert.ok(new h.Date() instanceof Date);
  assert.ok(new h.Date(5) instanceof h.Date);
});

test("crypto uses the same seed: two pages fill in the same bytes, and the UUID is correctly formatted and identical", () => {
  const a = makeHost(), b = makeHost();
  installPinnedEntropy(a);
  installPinnedEntropy(b);
  const ua = a.crypto.getRandomValues(new Uint32Array(4));
  const ub = b.crypto.getRandomValues(new Uint32Array(4));
  assert.deepEqual([...ua], [...ub]);
  const ida = a.crypto.randomUUID(), idb = b.crypto.randomUUID();
  assert.equal(ida, idb);
  assert.match(ida, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("withSeededRandom: inside it numbers start from the seed regardless of how many times the outside has drawn; after leaving, the outside sequence has not lost a single number", () => {
  const a = makeHost(), b = makeHost();
  installPinnedEntropy(a);
  installPinnedEntropy(b);
  // a 先取 5 次再进去,b 直接进去:里面拿到的应当一样
  for (let i = 0; i < 5; i++) a.Math.random();
  const inA = withSeededRandom(42, () => [a.Math.random(), a.Math.random(), a.Math.random()], a);
  const inB = withSeededRandom(42, () => [b.Math.random(), b.Math.random(), b.Math.random()], b);
  assert.deepEqual(inA, inB);
  // 和 __pcResetRandom(42) 之后的头三个数相同:同一个算法、同一个起点
  const c = makeHost();
  installPinnedEntropy(c);
  c.__pcResetRandom(42);
  assert.deepEqual(inA, [c.Math.random(), c.Math.random(), c.Math.random()]);
  // 出来以后:a 接着的是它的第 6 个数,b 接着的是它的第 1 个数
  const d = makeHost();
  installPinnedEntropy(d);
  const plain = Array.from({ length: 7 }, () => d.Math.random());
  assert.equal(a.Math.random(), plain[5]);
  assert.equal(b.Math.random(), plain[0]);
});

test("withSeededRandom: different seeds give different numbers; crypto follows the same sequence inside, and likewise leaves no trace after leaving", () => {
  const h = makeHost();
  installPinnedEntropy(h);
  const one = withSeededRandom(1, () => h.Math.random(), h);
  const two = withSeededRandom(2, () => h.Math.random(), h);
  assert.notEqual(one, two);
  const bytesA = withSeededRandom(7, () => [...h.crypto.getRandomValues(new Uint8Array(8))], h);
  const bytesB = withSeededRandom(7, () => [...h.crypto.getRandomValues(new Uint8Array(8))], h);
  assert.deepEqual(bytesA, bytesB);
  const fresh = makeHost();
  installPinnedEntropy(fresh);
  assert.equal(h.Math.random(), fresh.Math.random());
});

test("withSeededRandom: can be nested; even if it throws inside, the outer state is restored", () => {
  const h = makeHost(), ref = makeHost();
  installPinnedEntropy(h);
  installPinnedEntropy(ref);
  const first = ref.Math.random();
  const got = withSeededRandom(3, () => {
    const x = h.Math.random();
    const inner = withSeededRandom(3, () => h.Math.random(), h);
    assert.equal(inner, x);               // 里层同一个种子,从头出数
    return [x, h.Math.random()];          // 回到外层,接着外层的第 2 个数
  }, h);
  ref.__pcResetRandom(3);
  assert.deepEqual(got, [ref.Math.random(), ref.Math.random()]);
  assert.throws(() => withSeededRandom(9, () => { h.Math.random(); throw new Error("boom"); }, h), /boom/);
  assert.equal(h.Math.random(), first);
});

test("withSeededRandom: in an unpinned page it temporarily swaps Math.random, the numbers match the pinned ones, and on exit the original is swapped back", () => {
  const h = makeHost();                     // 不装钉子
  const real = () => 0.123;
  h.Math.random = real;
  const got = withSeededRandom(42, () => [h.Math.random(), h.Math.random()], h);
  const pinned = makeHost();
  installPinnedEntropy(pinned);
  pinned.__pcResetRandom(42);
  assert.deepEqual(got, [pinned.Math.random(), pinned.Math.random()]);
  assert.equal(h.Math.random, real);
  assert.throws(() => withSeededRandom(1, () => { throw new Error("boom"); }, h), /boom/);
  assert.equal(h.Math.random, real);
});

test("Installing again does not rewind the seed stream to the start", () => {
  const h = makeHost();
  installPinnedEntropy(h);
  const first = h.Math.random();
  installPinnedEntropy(h);
  assert.notEqual(h.Math.random(), first);
});
