import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANDIDATE_PHASES,
  CANONICAL_PHASE,
  candidateTimestamps,
  pickRepresentativeFrame,
  resolveSampleWindow,
} from "./representativeFrame.mjs";

test("determinism: candidateTimestamps and pickRepresentativeFrame return identical results across runs", () => {
  const win1 = resolveSampleWindow({ settleMs: 1200, kind: "card" });
  const win2 = resolveSampleWindow({ settleMs: 1200, kind: "card" });
  assert.deepEqual(win1, win2);

  const pts1 = candidateTimestamps(win1.windowSec, { settleSec: win1.settleSec, fps: 30 });
  const pts2 = candidateTimestamps(win1.windowSec, { settleSec: win1.settleSec, fps: 30 });
  assert.deepEqual(pts1, pts2);
  assert.ok(pts1.length >= CANDIDATE_PHASES.length, "includes candidate grid plus settled timestamp");
  for (let i = 1; i < pts1.length; i++) {
    assert.ok(pts1[i].t > pts1[i - 1].t, `strictly ascending timestamps at index ${i}`);
  }

  const samples = pts1.map((pt, idx) => ({
    t: pt.t,
    phase: pt.phase,
    opacityMass: idx === 0 ? 0 : Math.min(1, idx / 4) * 0.42,
    coverage: idx === 0 ? 0 : Math.min(1, idx / 4) * 0.28,
    spread: idx === 0 ? 0 : Math.min(1, idx / 3) * 0.35,
    detail: idx === 0 ? 0 : idx * 6,
    contrast: idx === 0 ? 0 : 0.65,
    blurPx: Math.max(0, 6 - idx * 2),
  }));

  const pickA = pickRepresentativeFrame(samples);
  const pickB = pickRepresentativeFrame(structuredClone(samples));
  assert.deepEqual(pickA, pickB);
  assert.ok(pickA.score > 0);
});

test("entrance animation: never picks an empty or heavily blurred early frame", () => {
  const pts = candidateTimestamps(1.5, { settleSec: 1.2, fps: 30 });
  const samples = pts.map(({ t, phase }) => {
    if (phase < 0.12) {
      // Blank at t ≈ 0 (opacity 0 before entrance delay)
      return { t, phase, opacityMass: 0, coverage: 0, spread: 0, detail: 0, contrast: 0, blurPx: 8 };
    }
    if (phase < 0.40) {
      // Mid-entrance: partially faded in and still blurred (e.g. BlurFade)
      return { t, phase, opacityMass: 0.18, coverage: 0.14, spread: 0.20, detail: 8, contrast: 0.4, blurPx: 4 };
    }
    // Fully settled crisp state
    return { t, phase, opacityMass: 0.45, coverage: 0.28, spread: 0.36, detail: 18, contrast: 0.72, blurPx: 0 };
  });

  const picked = pickRepresentativeFrame(samples);
  assert.ok(picked.phase >= 0.40, `expected settled frame, got phase=${picked.phase} (t=${picked.t})`);
  assert.equal(samples[picked.index].blurPx, 0, "picked crisp unblurred settled frame");
  assert.equal(picked.scores[0], 0, "empty first frame scored 0");
});

test("exit / decaying animation: never picks an empty end frame", () => {
  // Models av-pulse (0.3s expanding ring that reaches opacity 0 at t >= 0.3s)
  const win = resolveSampleWindow({ durationSec: 0.3, kind: "card" });
  const pts = candidateTimestamps(win.windowSec, { fps: 30 });
  assert.ok(pts.every((p) => p.t < 0.3), "all 30fps candidates stay strictly inside active 0.3s window");

  const exitSamples = [
    { t: 0.05, phase: 0.05, opacityMass: 0.52, coverage: 0.30, spread: 0.32, detail: 12, contrast: 0.8 },
    { t: 0.24, phase: 0.24, opacityMass: 0.50, coverage: 0.34, spread: 0.38, detail: 12, contrast: 0.8 },
    { t: 0.46, phase: 0.46, opacityMass: 0.22, coverage: 0.18, spread: 0.24, detail: 8, contrast: 0.4 },
    { t: 0.62, phase: 0.62, opacityMass: 0, coverage: 0, spread: 0, detail: 0, contrast: 0 },
    { t: 0.78, phase: 0.78, opacityMass: 0, coverage: 0, spread: 0, detail: 0, contrast: 0 },
    { t: 0.90, phase: 0.90, opacityMass: 0, coverage: 0, spread: 0, detail: 0, contrast: 0 },
  ];

  const picked = pickRepresentativeFrame(exitSamples);
  assert.ok(picked.index <= 1, `expected active early frame before fade-out, got index=${picked.index}`);
  assert.ok(exitSamples[picked.index].opacityMass >= 0.5, "picked fully visible frame before exit");
  assert.equal(picked.scores[3], 0);
  assert.equal(picked.scores[4], 0);
  assert.equal(picked.scores[5], 0);
});

test("brief pulse / flash animation: picks the active peak frame over idle frames", () => {
  const pulseSamples = [
    { t: 0.05, phase: 0.05, opacityMass: 0, coverage: 0, spread: 0, detail: 0, contrast: 0 },
    { t: 0.16, phase: 0.16, opacityMass: 0.04, coverage: 0.02, spread: 0.03, detail: 1, contrast: 0.1 },
    { t: 0.30, phase: 0.30, opacityMass: 0.68, coverage: 0.44, spread: 0.55, detail: 24, contrast: 0.9 },
    { t: 0.46, phase: 0.46, opacityMass: 0.08, coverage: 0.04, spread: 0.06, detail: 2, contrast: 0.15 },
    { t: 0.62, phase: 0.62, opacityMass: 0, coverage: 0, spread: 0, detail: 0, contrast: 0 },
    { t: 0.78, phase: 0.78, opacityMass: 0, coverage: 0, spread: 0, detail: 0, contrast: 0 },
    { t: 0.90, phase: 0.90, opacityMass: 0, coverage: 0, spread: 0, detail: 0, contrast: 0 },
  ];

  const picked = pickRepresentativeFrame(pulseSamples);
  assert.equal(picked.index, 2, "must pick the active flash peak at phase=0.30");
  assert.equal(picked.t, 0.30);
});

test("progressive build-up animation: prefers completed content over sparse early state", () => {
  // Models typewriter / checklist / Lottie character entering late
  const pts = candidateTimestamps(2.0, { settleSec: 1.8 });
  const samples = pts.map(({ t, phase }) => {
    const progress = Math.min(1, t / 1.8);
    const chars = Math.floor(progress * 24);
    return {
      t,
      phase,
      opacityMass: 0.05 + progress * 0.40,
      coverage: 0.04 + progress * 0.26,
      spread: 0.08 + progress * 0.34,
      detail: chars,
      contrast: chars > 0 ? 0.7 : 0,
    };
  });

  const picked = pickRepresentativeFrame(samples);
  assert.ok(picked.t >= 1.5, `expected near-complete build-up frame, got t=${picked.t}`);
  assert.ok(samples[picked.index].detail >= 20);
});

test("all-empty fallback: deterministically selects candidate closest to CANONICAL_PHASE with score 0", () => {
  const pts = candidateTimestamps(1.6, { fps: 30 });
  const emptySamples = pts.map(({ t, phase }) => ({
    t,
    phase,
    opacityMass: 0,
    coverage: 0,
  }));

  const picked = pickRepresentativeFrame(emptySamples);
  assert.equal(picked.score, 0);
  const distances = pts.map((p) => Math.abs(p.phase - CANONICAL_PHASE));
  const minDist = Math.min(...distances);
  assert.ok(Math.abs(Math.abs(picked.phase - CANONICAL_PHASE) - minDist) <= 1e-6);
});
