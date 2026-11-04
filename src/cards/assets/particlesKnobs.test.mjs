/**
 * Unit test for particle config "function translation". Run: node --test
 * src/cards/assets/particlesKnobs.test.mjs
 *
 * Two baseline rules for translation:
 *   - Only knobs present in the config are exposed, with default values matching the config:
 *     when no knobs are changed, the applied config is equivalent to the original config;
 *   - Changing a knob only modifies the corresponding key, intervals retain interval shape;
 *     the original config object is not mutated.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { translateParticlesConfig } from "./particlesKnobs.ts";

const basic = JSON.parse(fs.readFileSync(new URL("../../../server/catalog/particles/basic.json", import.meta.url), "utf8"));

test("basic config: count / speed / size / links all translate into knobs (it has no color section), and the defaults equal the values in the config", () => {
  const k = translateParticlesConfig(basic);
  const keys = k.controls.map((c) => c.key);
  for (const key of ["count", "speed", "size", "links"]) assert.ok(keys.includes(key), key);
  assert.equal(k.defaults.count, basic.particles.number.value);
  assert.equal(k.defaults.links, basic.particles.links.enable === false ? "no" : "yes");
  // No knobs changed → equivalent configuration
  assert.deepEqual(k.apply(basic, k.defaults), basic);
});

test("Changing a knob changes only the corresponding key; a range keeps its range shape; the original config is not modified", () => {
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
  assert.equal(k.defaults.speed, 2, "A range uses its midpoint as the representative value");
  assert.equal(k.defaults.size, 4);
  assert.equal(k.defaults.color, "#ff0000", "With multiple colors, take the first");
  const out = k.apply(cfg, { ...k.defaults, count: 50, speed: 4, color: "#0000ff", links: "no" });
  assert.equal(out.particles.number.value, 50);
  assert.deepEqual(out.particles.move.speed, { min: 2, max: 6 }, "A range is scaled proportionally");
  assert.deepEqual(out.particles.size.value, { min: 2, max: 6 }, "Keys not touched stay as they were");
  assert.deepEqual(out.particles.color.value, ["#0000ff", "#00ff00"], "With multiple colors, only the first is replaced");
  assert.equal(out.particles.links.enable, false);
  assert.equal(out.particles.links.distance, 100, "Other keys in the same section are untouched");
  assert.equal(JSON.stringify(cfg), snapshot, "The original config was not modified");
});

test("Knobs absent from the config are not exposed; a random color does not expose a color knob", () => {
  const k = translateParticlesConfig({ particles: { number: { value: 10 }, color: { value: "random" } } });
  assert.deepEqual(k.controls.map((c) => c.key), ["count"]);
});

test("All 53 configs in the catalog can be translated, and are equivalent when no knob is touched", () => {
  const dir = new URL("../../../server/catalog/particles/", import.meta.url);
  const index = JSON.parse(fs.readFileSync(new URL("index.json", dir), "utf8"));
  for (const it of index.items) {
    const cfg = JSON.parse(fs.readFileSync(new URL(`${it.name}.json`, dir), "utf8"));
    const k = translateParticlesConfig(cfg);
    assert.ok(k.controls.length >= 1, `${it.name} translates into at least one knob`);
    assert.deepEqual(k.apply(cfg, k.defaults), cfg, `${it.name} is equivalent when no knob is touched`);
  }
});
