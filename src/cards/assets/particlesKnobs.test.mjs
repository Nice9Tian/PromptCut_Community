/**
 * 粒子配置「函数翻译」的单测。跑:node --test src/cards/assets/particlesKnobs.test.mjs
 *
 * 翻译的两条底线:
 *   - 配置里有的旋钮才露出来,默认值就是配置里的值 —— 一个旋钮都不动时 apply 出来的配置和原配置等价;
 *   - 改旋钮只改对应的键,区间保持区间形状;原配置对象不被改。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { translateParticlesConfig } from "./particlesKnobs.ts";

const basic = JSON.parse(fs.readFileSync(new URL("../../../server/catalog/particles/basic.json", import.meta.url), "utf8"));

test("basic 配置:数量 / 速度 / 大小 / 连线都翻译出来(它没有 color 段),默认值等于配置里的值", () => {
  const k = translateParticlesConfig(basic);
  const keys = k.controls.map((c) => c.key);
  for (const key of ["count", "speed", "size", "links"]) assert.ok(keys.includes(key), key);
  assert.equal(k.defaults.count, basic.particles.number.value);
  assert.equal(k.defaults.links, basic.particles.links.enable === false ? "no" : "yes");
  // 不动旋钮 → 配置等价
  assert.deepEqual(k.apply(basic, k.defaults), basic);
});

test("改旋钮只改对应键;区间保持区间形状;原配置不被改", () => {
  const cfg = {
    particles: {
      number: { value: 100 },
      move: { speed: { min: 1, max: 3 } },
      size: { value: { min: 2, max: 6 } },
      color: { value: ["#ff0000", "#00ff00"] },
      opacity: { value: 0.5 },
      links: { enable: true, distance: 100 },
    },
  };
  const snapshot = JSON.stringify(cfg);
  const k = translateParticlesConfig(cfg);
  assert.equal(k.defaults.speed, 2, "区间取中点当代表值");
  assert.equal(k.defaults.size, 4);
  assert.equal(k.defaults.color, "#ff0000", "多色取第一种");
  const out = k.apply(cfg, { ...k.defaults, count: 50, speed: 4, color: "#0000ff", links: "no" });
  assert.equal(out.particles.number.value, 50);
  assert.deepEqual(out.particles.move.speed, { min: 2, max: 6 }, "区间按比例缩放");
  assert.deepEqual(out.particles.size.value, { min: 2, max: 6 }, "没动的键原样");
  assert.deepEqual(out.particles.color.value, ["#0000ff", "#00ff00"], "多色只换第一种");
  assert.equal(out.particles.links.enable, false);
  assert.equal(out.particles.links.distance, 100, "同段里别的键不动");
  assert.equal(JSON.stringify(cfg), snapshot, "原配置没被改");
});

test("配置里没有的旋钮不露出来;random 颜色不露颜色旋钮", () => {
  const k = translateParticlesConfig({ particles: { number: { value: 10 }, color: { value: "random" } } });
  assert.deepEqual(k.controls.map((c) => c.key), ["count"]);
});

test("目录里全部 53 份配置都能翻译,且不动旋钮时等价", () => {
  const dir = new URL("../../../server/catalog/particles/", import.meta.url);
  const index = JSON.parse(fs.readFileSync(new URL("index.json", dir), "utf8"));
  for (const it of index.items) {
    const cfg = JSON.parse(fs.readFileSync(new URL(`${it.name}.json`, dir), "utf8"));
    const k = translateParticlesConfig(cfg);
    assert.ok(k.controls.length >= 1, `${it.name} 至少翻译出一个旋钮`);
    assert.deepEqual(k.apply(cfg, k.defaults), cfg, `${it.name} 不动旋钮时等价`);
  }
});
