/**
 * Remotion-style framework: tool unit tests and gatekeeper tests. Run: node
 * scripts/test-suite.mjs src/kernel/remotionStyle/remotionStyle.test.mjs
 *
 *   RS-T-01  Each tool: repeated evaluation with the same time, parameters, and seed yields
 *            bit-for-bit identical results
 *   RS-T-02  Calculating frame N then frame M gives the same result as sequential calculation
 *            (backward, jumping, and sequential orders are bit-for-bit identical)
 *   RS-T-03  Check whether interpolation, transition, easing, spring, and staggered entrance
 *            values are correct (endpoints, out of bounds, analytical solution matches numerical
 *            integration)
 *   RS-T-04  Seeded randomness: independent of call order; yields no numbers without a seed;
 *            roughly uniform distribution; different seeds and sequence numbers are independent
 *   RS-T-05  Gatekeeper: framework contains no tools that store state across frames (externally
 *            only pure functions and frozen constants; no module-level mutables in source)
 *   RS-T-06  Lock read-only on load (`lock.ts`): writing to top-level objects, arrays, Maps, Sets,
 *            functions, or regexes throws immediately; exports of other modules untouched;
 *            un-lockable items flagged immediately
 *   RS-T-07  Gatekeeper: framework is outside the import closure of existing cards (existing files
 *            do not import it, nor does it import other modules)
 *
 * Bugs in these tools throw no errors, but make "playing forward" and "jumping directly" produce
 * two different visuals, so these properties are pinned down.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as F from "./index.ts";
import { lockTopLevel } from "./lock.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const FRAMES = 150;
const PALETTE = Object.freeze(["#ef476f", "#ffd166", "#06d6a0"]);
const BEZIER = F.Easing.bezier(0.16, 1, 0.3, 1);
const BACK = F.Easing.out(F.Easing.back(1.4));

/** Run every tool once in a single frame: returned numbers and strings are "this frame's visuals" */
function frameValues(n) {
  const t = n / FPS;
  const out = [];
  out.push(F.interpolate(t, [0, 0.5, 2, 4], [0, 1, 0.25, 3], { easing: [F.Easing.easeOut, BEZIER, F.Easing.inOut(F.Easing.quad)] }));
  out.push(F.interpolate(t, [1, 2], [10, 20], { extrapolateLeft: "extend", extrapolateRight: "extend" }));
  out.push(F.interpolateColors(t, [0, 2, 4], ["#ff0000", "rgba(0, 255, 0, 0.5)", "#00f"]));
  out.push(F.tween(t, { from: 40, to: 0, delay: 0.2, duration: 0.8, easing: BACK }));
  out.push(F.spring(t, { stiffness: 180, damping: 12 }), F.spring(t, { stiffness: 100, damping: 20 }), F.spring(t, { stiffness: 50, damping: 40, from: 3, to: -2, delay: 0.5 }));
  out.push(F.spring(t, { stiffness: 220, damping: 9, velocity: 4, clamp: true }));
  out.push(F.loop(t, 0.7), F.pingPong(t, 0.45), F.clamp(t - 1), F.lerp(2, 9, t / 5));
  for (let i = 0; i < 12; i++) {
    const local = F.stagger(t, i, { each: 0.08, from: "center", count: 12, delay: 0.1 });
    out.push(local, F.tween(local, { duration: 0.4 }), F.spring(local, { from: 60, to: 0 }));
    out.push(F.random(7, i), F.random("seed", i, "hue"), F.randomRange(-20, 20, 7, i, n), F.randomInt(1, 6, 7, i, n), F.randomPick(PALETTE, 7, i));
    out.push(F.noise(t * 2, 7, i));
  }
  for (const e of [F.Easing.linear, F.Easing.quad, F.Easing.cubic, F.Easing.quart, F.Easing.sin, F.Easing.circ, F.Easing.expo, F.Easing.bounce,
    F.Easing.elastic(2), F.Easing.steps(5), F.Easing.easeIn, F.Easing.easeOut, F.Easing.easeInOut]) out.push(e(F.clamp(t / 5)));
  return out;
}

/** Compare bit by bit: numbers use IEEE 754 64-bit (distinguish +0 / −0, NaN equals NaN), strings verbatim */
function bits(values) {
  const buf = new Float64Array(1), view = new BigUint64Array(buf.buffer);
  return values.map((v) => { if (typeof v !== "number") return `s:${v}`; buf[0] = v; return `n:${view[0].toString(16)}`; }).join(",");
}

test("RS-T-01 Evaluating repeatedly with the same time, parameters and seed gives bit-identical results", () => {
  for (const n of [0, 1, 7, 29, 30, 31, 74, 149]) {
    const a = bits(frameValues(n));
    for (let k = 0; k < 5; k++) assert.equal(bits(frameValues(n)), a, `Evaluation ${k + 2} of frame ${n}`);
  }
  // Every single item truly changes over time (otherwise the check above was comparing a bunch of constants)
  assert.notEqual(bits(frameValues(10)), bits(frameValues(11)));
});

test("RS-T-02 Computing frame N first and then frame M gives the same result as computing in order", () => {
  const forward = [];
  for (let n = 0; n < FRAMES; n++) forward.push(bits(frameValues(n)));
  // Compute backward
  for (let n = FRAMES - 1; n >= 0; n--) assert.equal(bits(frameValues(n)), forward[n], `Computing backwards to frame ${n}`);
  // Compute out of order: order is determined by the framework's own random generator (fixed seed),
  // with other frames sandwiched before and after each frame
  const order = Array.from({ length: FRAMES }, (_, n) => n).sort((a, b) => F.random("order", a) - F.random("order", b));
  assert.notDeepEqual(order, [...order].sort((a, b) => a - b), "The order is really shuffled");
  for (const n of order) assert.equal(bits(frameValues(n)), forward[n], `Computing by jumping to frame ${n}`);
  // For each pair of N then M: take only a few representative pairs, with N after and M before
  for (const [first, then] of [[149, 0], [90, 3], [1, 148], [60, 59], [0, 0]]) {
    frameValues(first);
    assert.equal(bits(frameValues(then)), forward[then], `Computing frame ${first} first, then frame ${then}`);
  }
});

test("RS-T-03 Interpolation: endpoints, segments, outside the range, easing; wrong arguments throw immediately", () => {
  assert.equal(F.interpolate(0, [0, 1], [10, 20]), 10);
  assert.equal(F.interpolate(1, [0, 1], [10, 20]), 20);
  assert.equal(F.interpolate(0.25, [0, 1], [10, 20]), 12.5);
  assert.equal(F.interpolate(-5, [0, 1], [10, 20]), 10, "Default: before the first time point, it stays at the first value");
  assert.equal(F.interpolate(9, [0, 1], [10, 20]), 20, "Default: after the last time point, it stays at the last value");
  assert.equal(F.interpolate(2, [0, 1], [10, 20], { extrapolateRight: "extend" }), 30);
  assert.equal(F.interpolate(-1, [0, 1], [10, 20], { extrapolateLeft: "extend" }), 0);
  assert.equal(F.interpolate(1.5, [0, 1, 2], [0, 100, 0]), 50);
  assert.equal(F.interpolate(1, [0, 1, 2], [0, 100, 0]), 100, "Landing exactly on a middle time point gives that value");
  assert.equal(F.interpolate(0.5, [0, 1], [0, 100], { easing: F.Easing.quad }), 25);
  assert.equal(F.interpolate(1.5, [0, 1, 2], [0, 100, 0], { easing: [F.Easing.linear, F.Easing.quad] }), 75, "One easing per segment");
  assert.throws(() => F.interpolate(0, [0, 1], [1]), /needs the same number of time points and values/);
  assert.throws(() => F.interpolate(0, [1, 1], [0, 1]), /must be strictly increasing/);
  assert.throws(() => F.interpolate(0, [0], [0]), /at least two/);
  assert.throws(() => F.interpolate(0, [0, NaN], [0, 1]), /finite number/);

  assert.equal(F.interpolateColors(0, [0, 1], ["#ff0000", "#0000ff"]), "rgba(255, 0, 0, 1)");
  assert.equal(F.interpolateColors(0.5, [0, 1], ["#f00", "#00f"]), "rgba(128, 0, 128, 1)");
  assert.equal(F.interpolateColors(1, [0, 1], ["#ff000080", "rgba(0, 0, 255, 0.25)"]), "rgba(0, 0, 255, 0.25)");
  assert.equal(F.interpolateColors(0.5, [0, 1], ["rgb(0 0 0)", "rgb(100% 50% 0% / 50%)"]), "rgba(128, 64, 0, 0.75)");
  assert.throws(() => F.interpolateColors(0, [0, 1], ["red", "#00f"]), /does not recognize this color/);

  assert.equal(F.tween(0, { duration: 1 }), 0);
  assert.equal(F.tween(1, { duration: 1 }), 1);
  assert.equal(F.tween(5, { from: 40, to: 0, delay: 0.2, duration: 0.5 }), 0);
  assert.equal(F.tween(0.1, { from: 40, to: 0, delay: 0.2, duration: 0.5 }), 40, "Before the start, the value is from");
  assert.equal(F.tween(0.5, { duration: 1, easing: F.Easing.linear }), 0.5);
  assert.equal(F.tween(0.5, { duration: 0 }), 1, "Duration is 0: it is the end value as soon as the time arrives");
  assert.equal(F.tween(-1, { duration: 0 }), 0);

  assert.equal(F.loop(2.5, 2), 0.5);
  assert.equal(F.loop(-0.5, 2), 1.5);
  assert.equal(F.pingPong(0.25, 1), 0.25);
  assert.equal(F.pingPong(1.25, 1), 0.75);
  assert.equal(F.clamp(5), 1);
  assert.equal(F.clamp(-5, -1, 1), -1);
});

test("RS-T-03 Easing: all go from 0 to 1; Bezier matches the CSS curves of the same name; steps", () => {
  const curves = { linear: F.Easing.linear, quad: F.Easing.quad, cubic: F.Easing.cubic, quart: F.Easing.quart, sin: F.Easing.sin, circ: F.Easing.circ, expo: F.Easing.expo,
    bounce: F.Easing.bounce, back: F.Easing.back(), elastic: F.Easing.elastic(), easeIn: F.Easing.easeIn, easeOut: F.Easing.easeOut, easeInOut: F.Easing.easeInOut,
    outBack: F.Easing.out(F.Easing.back()), inOutExpo: F.Easing.inOut(F.Easing.expo), bezier: BEZIER, steps: F.Easing.steps(4) };
  for (const [name, e] of Object.entries(curves)) {
    assert.ok(Math.abs(e(0)) < 1e-9, `${name}(0) = ${e(0)}`);
    assert.ok(Math.abs(e(1) - 1) < 1e-9, `${name}(1) = ${e(1)}`);
    for (let i = 0; i <= 20; i++) assert.ok(Number.isFinite(e(i / 20)), `${name}(${i / 20})`);
  }
  // cubic-bezier(0.25, 0.1, 0.25, 1) (CSS ease) is approximately 0.8024 at x = 0.5
  assert.ok(Math.abs(F.Easing.bezier(0.25, 0.1, 0.25, 1)(0.5) - 0.8024) < 1e-3);
  // A linear Bezier is constant speed
  for (let i = 0; i <= 10; i++) assert.ok(Math.abs(F.Easing.bezier(0.3, 0.3, 0.7, 0.7)(i / 10) - i / 10) < 1e-6);
  assert.equal(F.Easing.out(F.Easing.quad)(0.5), 0.75);
  assert.equal(F.Easing.inOut(F.Easing.quad)(0.25), 0.125);
  assert.deepEqual([0, 0.24, 0.25, 0.5, 0.99, 1].map(F.Easing.steps(4)), [0, 0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual([0, 0.01, 0.25, 0.26].map(F.Easing.steps(4, false)), [0, 0.25, 0.25, 0.5]);
  assert.throws(() => F.Easing.bezier(1.2, 0, 0, 1), /between 0 and 1/);
  assert.throws(() => F.Easing.steps(0), /positive integer/);
  assert.ok(Object.isFrozen(F.Easing), "The Easing table is read-only");
});

test("RS-T-03 The four easing aliases: circle, exp and the original names are the same function; ease is the Bezier (0.42, 0, 1, 1); poly(n) is the n-th power", () => {
  assert.equal(F.Easing.circle, F.Easing.circ);
  assert.equal(F.Easing.exp, F.Easing.expo);
  // ease: ends are 0 and 1; middle value is pinned (bit-identical to Easing.bezier for the same
  // numbers), starts slow
  assert.equal(F.Easing.ease(0), 0);
  assert.equal(F.Easing.ease(1), 1);
  const sameBezier = F.Easing.bezier(0.42, 0, 1, 1);
  for (let i = 0; i <= 20; i++) assert.equal(F.Easing.ease(i / 20), sameBezier(i / 20));
  // Pinned value was independently calculated using bisection to solve cubic-bezier(0.42, 0, 1, 1)
  for (const [p, value] of [[0.1, 0.017027], [0.25, 0.093465], [0.5, 0.315357], [0.75, 0.621862], [0.9, 0.839428]]) {
    assert.ok(Math.abs(F.Easing.ease(p) - value) < 1e-6, `ease(${p}) = ${F.Easing.ease(p)}`);
  }
  assert.ok(F.Easing.ease(0.5) < 0.5, "ease starts slowly");
  assert.notEqual(F.Easing.ease(0.5), F.Easing.easeIn(0.5), "ease is not the cubic-curve easeIn");
  // poly
  for (let i = 0; i <= 20; i++) {
    assert.ok(Math.abs(F.Easing.poly(3)(i / 20) - F.Easing.cubic(i / 20)) < 1e-12);
    assert.ok(Math.abs(F.Easing.poly(4)(i / 20) - F.Easing.quart(i / 20)) < 1e-12);
  }
  assert.equal(F.Easing.poly(1)(0.3), 0.3);
  assert.equal(F.Easing.poly(0.5)(0.25), 0.5);
  for (const bad of [undefined, null, "4", NaN, Infinity, {}]) assert.throws(() => F.Easing.poly(bad), /Easing\.poly exponent must be a number, got .+\. Usage: `Easing\.poly\(4\)`, which equals `Easing\.quart`\./);
  assert.throws(() => F.Easing.poly("4"), /got "4"/);
  assert.throws(() => F.Easing.poly(), /got undefined/);
});

test("RS-T-03 Spring: the analytic solution matches the trajectory integrated in many small steps (underdamped, critically damped, overdamped)", () => {
  const cases = [
    { stiffness: 180, damping: 12, mass: 1 }, // Underdamped
    { stiffness: 100, damping: 20, mass: 1 }, // Critical (ζ = 1)
    { stiffness: 50, damping: 40, mass: 1 }, // Overdamped
    { stiffness: 120, damping: 8, mass: 2, from: 3, to: -2, velocity: 5 },
  ];
  for (const c of cases) {
    const from = c.from ?? 0, to = c.to ?? 1, m = c.mass ?? 1;
    // Semi-implicit Euler, step size 1/100000 seconds
    let x = from, v = c.velocity ?? 0;
    const dt = 1e-5;
    let worst = 0;
    for (let i = 1; i <= 200000; i++) {
      v += ((-c.stiffness * (x - to) - c.damping * v) / m) * dt;
      x += v * dt;
      if (i % 2000 === 0) worst = Math.max(worst, Math.abs(F.spring(i * dt, c) - x));
    }
    assert.ok(worst < 2e-3, `max deviation of ${JSON.stringify(c)} from the integration: ${worst}`);
  }
  assert.equal(F.spring(0), 0);
  assert.equal(F.spring(-3, { from: 5, to: 9 }), 5, "Before the start, the value is from");
  assert.equal(F.spring(0.3, { from: 5, to: 9, delay: 0.5 }), 5);
  assert.ok(Math.abs(F.spring(30) - 1) < 1e-9, "After long enough it stops at to");
  // Underdamped motion will overshoot; clamp clips the overshoot
  let peak = 0, clampedPeak = 0;
  for (let i = 0; i <= 300; i++) { peak = Math.max(peak, F.spring(i / 100, { stiffness: 180, damping: 8 })); clampedPeak = Math.max(clampedPeak, F.spring(i / 100, { stiffness: 180, damping: 8, clamp: true })); }
  assert.ok(peak > 1.05, `Overshoot peak ${peak}`);
  assert.equal(clampedPeak, 1);
  assert.throws(() => F.spring(1, { stiffness: 0 }), /stiffness/);

  // Settling time: stays within one thousandth from this point on, with prior values exceeding it
  for (const c of cases.slice(0, 3)) {
    const d = F.springDuration(c);
    assert.ok(d > 0 && d < 10, `${JSON.stringify(c)} settles after ${d}`);
    for (let i = 0; i <= 200; i++) assert.ok(Math.abs(F.spring(d + i / 50, c) - 1) <= 0.001 + 1e-12, `Step ${i} after settling`);
    let early = false;
    for (let i = 1; i <= 50; i++) if (Math.abs(F.spring((d * i) / 100, c) - 1) > 0.001) early = true;
    assert.ok(early, "Before settling it really has not arrived yet");
  }
  assert.equal(F.springDuration({ delay: 0.5, from: 1, to: 1 }), 0.5);
  assert.ok(F.springDuration({ delay: 0.5 }) > F.springDuration() + 0.49);
});

test("RS-T-03 Spring: writing it the Remotion way throws an error and no longer silently returns the start point", () => {
  // Case 1: the first argument is not a number
  assert.throws(() => F.spring({ frame: 12, fps: 30, config: { damping: 200 } }),
    { message: "The first argument of spring must be a time (in seconds), got object. The syntax here is `spring(t, { stiffness, damping, mass, from, to, delay })`, where `t` is clip-local seconds; it is not Remotion's `spring({ frame, fps, config })`. Change it to: `spring(t, { stiffness: 100, damping: 10 })`." });
  assert.throws(() => F.spring(undefined, { stiffness: 100 }), /first argument of spring must be a time \(in seconds\), got undefined\./);
  assert.throws(() => F.spring("0.5"), /got string\./);
  assert.throws(() => F.spring(NaN), /got NaN\./);
  assert.throws(() => F.spring(null), /got null\./);
  // Case 2: the second argument contains Remotion keys
  assert.throws(() => F.spring(0.4, { fps: 30, stiffness: 100 }),
    { message: "spring arguments contain fps: this is Remotion syntax. Here time is in seconds and passed as the first argument, not frame number and frame rate; write `stiffness`, `damping`, `mass` directly in the second argument, without wrapping them in `config`. Usage: `spring(t, { stiffness: 100, damping: 10, mass: 1 })`." });
  assert.throws(() => F.spring(0.4, { config: { stiffness: 100, damping: 10 } }), /spring arguments contain config: this is Remotion syntax\./);
  assert.throws(() => F.spring(0.4, { frame: 12 }), /spring arguments contain frame:/);
  assert.throws(() => F.springDuration({ config: { damping: 200 } }), /spring arguments contain config:/);
  assert.throws(() => F.springDuration({ fps: 30 }), /spring arguments contain fps:/);
  // Valid calls proceed as usual: negative numbers, 0, and infinity are all numbers
  assert.equal(F.spring(-1), 0);
  assert.equal(F.spring(0, { from: 2 }), 2);
  assert.equal(F.spring(0.4, undefined), F.spring(0.4));
});

test("RS-T-03 Staggered entrance: various start points; total duration", () => {
  assert.equal(F.stagger(1, 0, { each: 0.1 }), 1);
  assert.ok(Math.abs(F.stagger(1, 3, { each: 0.1 }) - 0.7) < 1e-12);
  assert.ok(Math.abs(F.stagger(1, 3, { each: 0.1, delay: 0.5 }) - 0.2) < 1e-12);
  assert.equal(F.stagger(1, 4, { each: 0.1, from: "last", count: 5 }), 1);
  assert.ok(Math.abs(F.stagger(1, 0, { each: 0.1, from: "last", count: 5 }) - 0.6) < 1e-12);
  assert.equal(F.stagger(1, 2, { each: 0.1, from: "center", count: 5 }), 1);
  assert.equal(F.stagger(1, 0, { each: 0.1, from: "center", count: 5 }), F.stagger(1, 4, { each: 0.1, from: "center", count: 5 }));
  assert.equal(F.stagger(1, 3, { each: 0.1, from: 3 }), 1);
  assert.throws(() => F.stagger(1, 0, { each: 0.1, from: "center" }), /count/);
  assert.ok(Math.abs(F.staggerDuration(5, { each: 0.08 }, 0.4) - 0.72) < 1e-12);
  assert.ok(Math.abs(F.staggerDuration(5, { each: 0.1, from: "center", delay: 1 }, 0.5) - 1.7) < 1e-12);
  assert.equal(F.staggerDuration(0, { each: 0.1, delay: 0.3 }), 0.3);
});

test("RS-T-04 Seeded random: independent of call order; no seed gives no number; independent of each other; roughly uniform", () => {
  // The same pair (seed, sequence number) returns the same number at any time: call others heavily
  // first, then query again
  const want = F.random(42, 5);
  for (let i = 0; i < 1000; i++) F.random(i, i * 3, "x");
  assert.equal(F.random(42, 5), want);
  assert.equal(F.random("42", 5) === want, false, "A numeric seed and a string seed are not the same");
  // Pin down one by one: if the algorithm changes, visuals of already created cards will change
  assert.deepEqual([F.random(0), F.random(1), F.random("a"), F.random(7, 3), F.random(7, 3, "hue"), F.random(1.5), F.random(-1, 2 ** 40)].map((x) => x.toFixed(12)),
    ["0.611923245713", "0.897906372324", "0.756856766297", "0.887180288788", "0.241473339032", "0.060155360727", "0.427354121581"]);
  const seen = new Set();
  for (let s = 0; s < 50; s++) for (let i = 0; i < 50; i++) { const r = F.random(s, i); assert.ok(r >= 0 && r < 1); seen.add(r); }
  assert.ok(seen.size > 2490, `${seen.size} of 2500 are distinct`);
  assert.notEqual(F.random(1, 2), F.random(2, 1), "Swapping seed and index gives a different number");
  assert.notEqual(F.random(1, 2, 3), F.random(1, 23), "Indexes are not simply concatenated");
  // Roughly uniform: 100,000 numbers split into 10 buckets, each bucket within 4% of 10,000
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 100000; i++) buckets[Math.floor(F.random("uniform", i) * 10)]++;
  for (const b of buckets) assert.ok(Math.abs(b - 10000) < 400, `${b} in the bucket`);
  // No discernable pattern between adjacent sequence numbers: average difference between adjacent
  // numbers is close to 1/3
  let diff = 0;
  for (let i = 0; i < 20000; i++) diff += Math.abs(F.random(9, i) - F.random(9, i + 1));
  assert.ok(Math.abs(diff / 20000 - 1 / 3) < 0.01, `Average adjacent difference ${diff / 20000}`);

  assert.throws(() => F.random(), /seed/);
  assert.throws(() => F.random(null), /seed/);
  assert.throws(() => F.random(NaN), /seed/);
  assert.throws(() => F.random(1, undefined), /index/);
  assert.throws(() => F.random(1, {}), /index/);

  for (let i = 0; i < 200; i++) {
    const r = F.randomRange(-20, 20, 3, i);
    assert.ok(r >= -20 && r < 20);
    const k = F.randomInt(1, 6, 3, i);
    assert.ok(Number.isInteger(k) && k >= 1 && k <= 6);
    assert.ok(PALETTE.includes(F.randomPick(PALETTE, 3, i)));
  }
  assert.deepEqual([...new Set(Array.from({ length: 300 }, (_, i) => F.randomInt(1, 6, 3, i)))].sort(), [1, 2, 3, 4, 5, 6], "Both ends are reachable");
  assert.throws(() => F.randomPick([], 1), /empty/);

  // Smooth fluctuations: unrelated random numbers at integer points, continuous in between, range -1 to 1
  assert.equal(F.noise(3, 5), F.random(5, 3) * 2 - 1);
  for (let i = 0; i < 2000; i++) {
    const a = F.noise(i / 100, 5), b = F.noise((i + 1) / 100, 5);
    assert.ok(a >= -1 && a <= 1);
    assert.ok(Math.abs(a - b) < 0.05, `Difference between adjacent points ${Math.abs(a - b)}`);
  }
  assert.throws(() => F.noise(Infinity, 1), /finite number/);
});

test("RS-T-05 Gatekeeper: the framework has no tool that can store things across frames", () => {
  // These are all the externally exposed items; adding or removing any requires updating this table
  // and matching it in the report's interface table
  assert.deepEqual(Object.keys(F).sort(), [
    "Easing", "clamp", "interpolate", "interpolateColors", "lerp", "loop", "noise", "pingPong",
    "random", "randomInt", "randomPick", "randomRange", "spring", "springDuration", "stagger", "staggerDuration", "tween",
  ]);
  // Everything is either a function or a frozen table; functions have no attached writable properties
  for (const [name, value] of Object.entries(F)) {
    if (typeof value === "function") { assert.deepEqual(Object.keys(value), [], `Nothing is attached to ${name}`); continue; }
    assert.ok(Object.isFrozen(value), `${name} is read-only`);
    for (const [k, v] of Object.entries(value)) assert.equal(typeof v, "function", `${name}.${k}`);
  }
  // In names: no tools like "store, fetch, record, previous, count, accumulate"
  const stateful = /^(use[A-Z]|set[A-Z]|get[A-Z]|store|save|load|remember|memo|cache|prev|previous|last[A-Z]|counter|accumulate|state|ref|on[A-Z]|subscribe|emit)/;
  for (const name of [...Object.keys(F), ...Object.keys(F.Easing)]) assert.doesNotMatch(name, stateful, name);

  // In source code: every framework file (including lock.ts which locks read-only on load) has no
  // top-level mutable variables, and does not touch clocks, timers, unseeded random, or global objects
  const files = fs.readdirSync(HERE).filter((f) => f.endsWith(".ts"));
  assert.deepEqual(files.sort(), ["easing.ts", "index.ts", "interpolate.ts", "lock.ts", "random.ts", "spring.ts", "stagger.ts"]);
  for (const file of files) {
    const code = fs.readFileSync(path.join(HERE, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const line of code.split("\n")) {
      // Top-level declarations are written unindented: unindented let / var are module-level mutable variables
      assert.doesNotMatch(line, /^(export\s+)?(let|var)\s/, `${file}: ${line}`);
      // Unindented const cannot be containers (Map, Set, ArrayBuffer, empty objects, empty arrays)
      assert.doesNotMatch(line, /^(export\s+)?const\s+\w+[^=]*=\s*(new\s+(Map|Set|WeakMap|WeakSet|Array|Float\d+Array|Uint\d+Array|Int\d+Array|ArrayBuffer)\b|\{\s*\}|\[\s*\])/, `${file}: ${line}`);
    }
    assert.doesNotMatch(code, /\bDate\b|\bperformance\b|setTimeout|setInterval|requestAnimationFrame|Math\.random|\bcrypto\b|\bwindow\b|\bglobalThis\b|localStorage|sessionStorage|\bdocument\b/, file);
    if (file !== "lock.ts") assert.doesNotMatch(code, /\bWeakMap\b|\bWeakSet\b|\bnew Map\b|\bnew Set\b/, `${file} does not use containers`);
  }
  // In behavior: repeating the same call twice with other calls interspersed yields the same result
  // (no hidden "previous")
  const probe = () => bits([F.spring(0.31, { stiffness: 90 }), F.noise(1.37, "k"), F.tween(0.2, { duration: 0.5 }), F.random("k", 1), F.interpolateColors(0.3, [0, 1], ["#000", "#fff"])]);
  const first = probe();
  frameValues(99);
  assert.equal(probe(), first);
});

test("RS-T-07 Gatekeeper: the framework is outside the import closure of existing cards (only new cards written with the framework import it)", () => {
  /*
   * Source version of each card = full text of its definition file together with every file in its
   * import closure (`src/render/cardSourceVersion.mjs`).
   * If any existing kernel, render, card, or part file imports the framework, the framework enters
   * the closure of a batch of old cards: every time the framework changes a line in the future,
   * keys for prerender output of those cards all change, and generated card audio is also
   * invalidated. Therefore, nothing under `src/` imports the framework except the framework itself.
   * Conversely, the framework imports no other modules (its closure contains only its own few files).
   * Script comparing source versions card by card before and after changes:
   * `scripts/probes/card-source-version-compare.mjs`.
   */
  const SRC = path.resolve(HERE, "..", "..");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const specifiers = (text) => [...text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    .matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map((m) => m[1]);
  const offenders = [];
  for (const file of walk(SRC)) {
    if (!/\.(ts|tsx|mts|mjs|js)$/.test(file) || /\.test\.(ts|tsx|mjs|js)$/.test(file) || file.startsWith(HERE + path.sep)) continue;
    for (const spec of specifiers(fs.readFileSync(file, "utf8"))) if (/remotionStyle/.test(spec)) offenders.push(`${path.relative(SRC, file).replace(/\\/g, "/")} → ${spec}`);
  }
  assert.deepEqual(offenders, [], "Existing files do not import the framework (except new cards written with the framework under the user card directory; there are none in the repository)");
  for (const file of fs.readdirSync(HERE).filter((f) => f.endsWith(".ts"))) {
    for (const spec of specifiers(fs.readFileSync(path.join(HERE, file), "utf8"))) assert.match(spec, /^\.\/(easing|interpolate|spring|stagger|random)\.ts$/, `${file} → ${spec}`);
  }
});

/* ------------------------------------------------------------------ Lock read-only on load */

const throwsLocked = (fn, what) => assert.throws(fn, (err) => err instanceof TypeError, what);

test("RS-T-06 Locked read-only on load: any write to a top-level object, array, Map, Set, function or regex throws immediately", () => {
  const COUNTER = { frames: 0, nested: { list: [1, 2, { deep: true }] } };
  const TRAIL = [0];
  const TABLE = new Map([["a", { n: 1 }]]);
  const TAGS = new Set(["x"]);
  const RE = /a/g;
  function Component() { return null; }
  const card = { id: "x", defaults: { size: 1 }, controls: [{ key: "size" }], Component };
  lockTopLevel("src/cards/user/x.tsx", [["COUNTER", () => COUNTER], ["TRAIL", () => TRAIL], ["TABLE", () => TABLE], ["TAGS", () => TAGS], ["RE", () => RE],
    ["Component", () => Component], ["card", () => card], ["OnlyAType", () => { throw new ReferenceError("OnlyAType is not defined"); }]]);

  // This file is a module, strict mode: writing to a frozen object throws immediately
  throwsLocked(() => { COUNTER.frames += 1; }, "Object property");
  throwsLocked(() => { COUNTER.fresh = 1; }, "Adding a new property");
  throwsLocked(() => { delete COUNTER.frames; }, "Deleting a property");
  throwsLocked(() => { COUNTER.nested.list.push(4); }, "Deeply nested array");
  throwsLocked(() => { COUNTER.nested.list[2].deep = false; }, "Deeply nested object");
  throwsLocked(() => { TRAIL.push(1); }, "Array push");
  throwsLocked(() => { TRAIL[0] = 9; }, "Array index");
  throwsLocked(() => { TRAIL.length = 0; }, "Array length");
  throwsLocked(() => { TABLE.set("b", 1); }, "Map.set");
  throwsLocked(() => { TABLE.delete("a"); }, "Map.delete");
  throwsLocked(() => { TABLE.clear(); }, "Map.clear");
  throwsLocked(() => { TABLE.get("a").n += 1; }, "Value inside a Map");
  throwsLocked(() => { TAGS.add("y"); }, "Set.add");
  throwsLocked(() => { TAGS.clear(); }, "Set.clear");
  throwsLocked(() => { RE.lastIndex = 3; }, "lastIndex of a regex");
  throwsLocked(() => { Component.count = 1; }, "Attaching something to a function");
  throwsLocked(() => { card.defaults.size = 2; }, "Default parameters of the card definition");
  throwsLocked(() => { card.controls.push({}); }, "Controls table of the card definition");
  // Indirection through a variable behaves the same: the lock is on the object, not the name
  const alias = COUNTER;
  throwsLocked(() => { alias.frames = 5; }, "Write through an alias");
  assert.match((() => { try { TABLE.set("b", 1); } catch (e) { return e.message; } return ""; })(), /src\/cards\/user\/x\.tsx.*TABLE.*read-only/s, "The error says which name of which card it is");

  // Reads are unaffected; values have not been modified
  assert.equal(COUNTER.frames, 0);
  assert.deepEqual(TRAIL, [0]);
  assert.equal(TABLE.get("a").n, 1);
  assert.equal(TAGS.has("x"), true);
  assert.deepEqual({ ...card.defaults, size: 3 }, { size: 3 }, "A copy can be modified as usual");
  assert.equal(Component(), null);
  assert.deepEqual([...COUNTER.nested.list.map((x) => x), 4].length, 4);
});

test("RS-T-06 Locked read-only on load: things exported by other modules are left alone; React elements are left alone; what cannot be locked is reported immediately; locking twice and circular references are safe", () => {
  // Exports of other modules (and their next level down) do not belong to this card: neither frozen
  // nor traversed
  const shared = { controls: [{ key: "position", options: [1, 2] }], defaults: { accent: "" }, internals: { H: null } };
  const reactLike = { default: { useMemo() {}, __INTERNALS: { H: null } }, useMemo() {} };
  const OWN = { controls: [...shared.controls, { key: "mine" }], defaults: { ...shared.defaults, x: 1 }, ref: shared.internals, React: reactLike.default };
  lockTopLevel("src/cards/user/y.tsx", [["OWN", () => OWN], ["ALIAS", () => shared.defaults], ["R", () => reactLike.default]], [shared, reactLike]);
  assert.ok(Object.isFrozen(OWN) && Object.isFrozen(OWN.controls) && Object.isFrozen(OWN.defaults) && Object.isFrozen(OWN.controls[1]));
  assert.equal(Object.isFrozen(shared), false);
  assert.equal(Object.isFrozen(shared.controls), false);
  assert.equal(Object.isFrozen(shared.controls[0]), false, "Someone else's object that is spread in is not frozen");
  assert.equal(Object.isFrozen(shared.defaults), false);
  assert.equal(Object.isFrozen(shared.internals), false);
  assert.equal(Object.isFrozen(reactLike.default), false);
  assert.equal(Object.isFrozen(reactLike.default.__INTERNALS), false, "React's own internal objects, which it needs to write to, must not be frozen");
  reactLike.default.__INTERNALS.H = 1;
  assert.equal(Object.isFrozen(reactLike.useMemo), false);

  // Do not touch React elements (with $$typeof): development mode React records data into
  // their _store
  const element = { $$typeof: Symbol.for("react.transitional.element"), type: "div", props: { children: [] }, _store: { validated: 0 } };
  const HOLDER = { icon: element };
  lockTopLevel("src/cards/user/z.tsx", [["HOLDER", () => HOLDER]]);
  assert.ok(Object.isFrozen(HOLDER));
  element._store.validated = 1;
  assert.equal(element._store.validated, 1);

  // Items that cannot be locked: throws an error immediately on load, identifying which one
  class Thing { n = 0; }
  for (const [value, what] of [[new Float32Array(4), /BUF.*Float32Array.*cannot be locked read-only/s], [new Thing(), /BUF.*Thing/s], [Promise.resolve(1), /BUF.*Promise/s], [new Date(0), /BUF.*Date/s], [new WeakMap(), /BUF.*WeakMap/s]]) {
    assert.throws(() => lockTopLevel("src/cards/user/b.tsx", [["BUF", () => value]]), (err) => err instanceof TypeError && what.test(err.message) && /src\/cards\/user\/b\.tsx/.test(err.message));
  }
  assert.throws(() => lockTopLevel("src/cards/user/b.tsx", [["OUTER", () => ({ inner: [new Uint8Array(1)] })]]), /OUTER\.inner\[0\]/);
  // If the same unlockable item comes from another module, it is not this card's concern
  const foreignBuffer = new Float32Array(2);
  lockTopLevel("src/cards/user/b.tsx", [["BUF", () => foreignBuffer]], [{ foreignBuffer }]);

  // Circular references, repeated locks
  const A = { name: "a" }; const B = { name: "b", a: A }; A.b = B;
  lockTopLevel("src/cards/user/c.tsx", [["A", () => A], ["B", () => B]]);
  lockTopLevel("src/cards/user/c.tsx", [["A", () => A]]);
  assert.ok(Object.isFrozen(A) && Object.isFrozen(B));
  // Primitive values, names without values: do nothing
  lockTopLevel("src/cards/user/c.tsx", [["N", () => 1], ["S", () => "s"], ["U", () => undefined], ["NIL", () => null]]);
});
