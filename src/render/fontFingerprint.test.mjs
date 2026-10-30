/**
 * 字体指纹的单测(I0,A3a 第 2 步落地)。跑:node --test src/render/fontFingerprint.test.mjs
 *
 * 这个值进共享快照键。它算错不会报错,只会让两台字体不同的机器互相复用对方的快照
 * (字全换掉、排版全错),或者反过来让同一台机器每次开项目都算出新键、共享档永远
 * 不命中。所以三条性质各钉一条:只认已加载的、同一族只算一次、和迭代顺序无关。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { fontFamilyNames, fontFingerprintOf } from "./fontFingerprint.ts";

/** FontFaceSet 是可迭代的 FontFace 集合;这里只用到 family / status 两个字段。 */
const set = (...faces) => faces.map(([family, status = "loaded"]) => ({ family, status }));

test("只取已加载的 family:声明了但没下下来的 @font-face 不影响这一帧的排版", () => {
  assert.deepEqual(fontFamilyNames(set(["Inter"], ["Noto Sans CJK SC", "unloaded"], ["Fira Code", "loading"])), ["Inter"]);
  // 一个都没加载:是空列表,不是「没算过」。
  assert.deepEqual(fontFamilyNames(set(["Inter", "unloaded"])), []);
  assert.deepEqual(fontFamilyNames([]), []);
  assert.deepEqual(fontFamilyNames(null), []);
  assert.deepEqual(fontFamilyNames(undefined), []);
});

test("同一族的多个字重 / 字形只算一次,空名字不算", () => {
  // 一个 family 的 400 / 700 / italic 是三个 FontFace,但排版落到的是同一族。
  assert.deepEqual(fontFamilyNames(set(["Inter"], ["Inter"], ["Inter"])), ["Inter"]);
  assert.deepEqual(fontFamilyNames(set(["Inter"], ["  Inter  "])), ["Inter"], "前后空白不是另一个族");
  assert.deepEqual(fontFamilyNames(set(["", "loaded"], ["   "], ["Inter"])), ["Inter"]);
});

test("和 FontFaceSet 的迭代顺序无关 —— 顺序跟加载先后有关,不排序两台机器必不同键", () => {
  const a = fontFingerprintOf(set(["Inter"], ["Noto Sans CJK SC"], ["Fira Code"]));
  const b = fontFingerprintOf(set(["Fira Code"], ["Inter"], ["Noto Sans CJK SC"]));
  assert.equal(a, b);
  assert.deepEqual(fontFamilyNames(set(["Fira Code"], ["Inter"])), ["Fira Code", "Inter"], "输出本身是排好序的");
});

test("字体集合变了指纹就变,缺字体的机器和装齐的机器不共用快照", () => {
  const full = fontFingerprintOf(set(["Inter"], ["Noto Sans CJK SC"]));
  const missingCjk = fontFingerprintOf(set(["Inter"]));
  assert.notEqual(full, missingCjk);
  // 多出一个族也算变。
  assert.notEqual(full, fontFingerprintOf(set(["Inter"], ["Noto Sans CJK SC"], ["Fira Code"])));
  // 「一个字体都没有」是一个确定值,不是空串 —— 「没有字体」和「没算过」必须分得开。
  const empty = fontFingerprintOf([]);
  assert.match(empty, /^[0-9a-f]{16}$/);
  assert.equal(empty, fontFingerprintOf(null));
  assert.notEqual(empty, "");
  assert.notEqual(empty, full);
});

test("同一个输入永远同一个值(纯函数,跨进程跨机器可复算)", () => {
  const fonts = set(["Inter"], ["Noto Sans CJK SC"]);
  assert.equal(fontFingerprintOf(fonts), fontFingerprintOf(fonts));
  assert.match(fontFingerprintOf(fonts), /^[0-9a-f]{16}$/);
  // 不是把名字直接拼起来:族名里出现分隔符也不会撞键。
  assert.notEqual(fontFingerprintOf(set(["A\nB"])), fontFingerprintOf(set(["A"], ["B"])));
});
