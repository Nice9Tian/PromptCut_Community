/**
 * Deterministic representative-frame selection for animation library thumbnails.
 *
 * Fixed-timestamp rules (`t = 0` or `t = duration / 2`) fail on common motion patterns:
 *   - Entrance animations are transparent, off-screen, or heavily blurred at `t = 0`;
 *   - Exit and short pulse animations (`av-pulse`, decaying particle bursts) are blank at late `t`;
 *   - Typewriters, counters, charts, and multi-step cards build up progressively toward `settleMs`;
 *   - Lottie catalog assets (`ip..op`) often introduce their main subject well after frame 0.
 *
 * This pure module generates a deterministic candidate timestamp grid across an animation's active
 * window and scores measured visual features of each candidate frame to pick a single deterministic,
 * non-empty, visually representative timestamp.
 */

/** Normalized candidate phases across [0, 1] of the sampling window. */
export const CANDIDATE_PHASES = Object.freeze([0.05, 0.16, 0.30, 0.46, 0.62, 0.78, 0.90]);

/** Canonical mid-late phase favored when multiple frames have comparable visual richness. */
export const CANONICAL_PHASE = 0.62;

export const DEFAULT_WINDOW_SEC = 1.6;
export const MIN_WINDOW_SEC = 0.1;
export const MAX_WINDOW_SEC = 16;

const EMPTY_EPS = 1e-5;
const TIE_EPS = 1e-7;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v) {
  return clamp(v, 0, 1);
}

function finitePos(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolves the deterministic sampling window `{ windowSec, settleSec }` for an animation item
 * from its static/dynamic timing metadata without running any nondeterministic code.
 *
 * @param {object} [meta]
 * @param {number | null} [meta.settleMs]
 * @param {number | null} [meta.durationSec]
 * @param {number | null} [meta.catalogSeconds]
 * @param {"card" | "part" | "lottie" | "particles" | "graph"} [meta.kind]
 * @returns {{ windowSec: number, settleSec?: number }}
 */
export function resolveSampleWindow(meta = {}) {
  const catalogSec = finitePos(meta.catalogSeconds);
  if (catalogSec !== null) {
    return { windowSec: clamp(catalogSec, MIN_WINDOW_SEC, MAX_WINDOW_SEC) };
  }

  const settleMs = finitePos(meta.settleMs);
  if (settleMs !== null) {
    const settleSec = clamp(settleMs / 1000, 0.05, MAX_WINDOW_SEC);
    const windowSec = clamp(Math.max(settleSec * 1.15, settleSec + 0.12), MIN_WINDOW_SEC, MAX_WINDOW_SEC);
    return { windowSec, settleSec };
  }

  const durationSec = finitePos(meta.durationSec);
  if (durationSec !== null && durationSec <= MAX_WINDOW_SEC) {
    return { windowSec: clamp(durationSec, MIN_WINDOW_SEC, MAX_WINDOW_SEC) };
  }

  if (meta.kind === "particles") {
    return { windowSec: 1.2 };
  }

  return { windowSec: DEFAULT_WINDOW_SEC };
}

/**
 * Produces a strictly ascending, deduplicated list of deterministic `{ t, phase }` candidate points
 * across `[0, windowSec]`. When `fps` is supplied, timestamps snap to exact frame grid points
 * (`frame / fps`) so stage frame numbers and GL plane frame tags align without rounding drift.
 *
 * @param {number} windowSec
 * @param {object} [options]
 * @param {number} [options.settleSec]
 * @param {readonly number[]} [options.phases]
 * @param {number} [options.fps]
 * @returns {Array<{ t: number, phase: number }>}
 */
export function candidateTimestamps(windowSec, options = {}) {
  const w = clamp(finitePos(windowSec) ?? DEFAULT_WINDOW_SEC, MIN_WINDOW_SEC, MAX_WINDOW_SEC);
  const phases = Array.isArray(options.phases) && options.phases.length > 0 ? options.phases : CANDIDATE_PHASES;
  const fps = finitePos(options.fps);

  const quantize = (rawSec) => {
    const clamped = clamp(rawSec, 0, w);
    if (fps !== null) {
      const maxFrame = Math.max(1, Math.floor(w * fps));
      // Keep candidates strictly inside the active window when possible so decaying animations
      // whose opacity reaches 0 at exactly `t = w` (e.g. av-pulse at t = duration) stay visible.
      const frame = clamp(Math.round(clamped * fps), 0, Math.max(0, maxFrame - 1));
      return Math.round((frame / fps) * 1e6) / 1e6;
    }
    return Math.round(clamped * 1000) / 1000;
  };

  const byKey = new Map();
  const addRaw = (rawSec) => {
    const t = quantize(rawSec);
    const key = Math.round(t * 1e6);
    if (!byKey.has(key)) {
      byKey.set(key, {
        t,
        phase: Math.round(clamp01(t / w) * 1e6) / 1e6,
      });
    }
  };

  for (const p of phases) {
    const pn = Number(p);
    if (!Number.isFinite(pn)) continue;
    addRaw(clamp01(pn) * w);
  }

  const settleSec = finitePos(options.settleSec);
  if (settleSec !== null && settleSec <= w) {
    addRaw(settleSec);
  }

  if (byKey.size === 0) {
    addRaw(CANONICAL_PHASE * w);
  }

  return [...byKey.values()].sort((a, b) => a.t - b.t);
}

/**
 * Normalizes raw sample fields into finite non-negative numbers.
 *
 * @param {object} sample
 * @param {number} index
 * @param {number} total
 */
function normalizeSample(sample, index, total) {
  const t = Math.max(0, Number(sample?.t) || 0);
  const fallbackPhase = total > 1 ? index / (total - 1) : CANONICAL_PHASE;
  const phase = typeof sample?.phase === "number" && Number.isFinite(sample.phase)
    ? clamp01(sample.phase)
    : clamp01(fallbackPhase);
  const opacityMass = Math.max(0, Number(sample?.opacityMass) || 0);
  const coverage = clamp01(Number(sample?.coverage) || 0);
  const spread = sample?.spread !== undefined && Number.isFinite(Number(sample.spread))
    ? clamp01(Number(sample.spread))
    : coverage;
  const detail = Math.max(0, Number(sample?.detail) || 0);
  const contrast = clamp01(Number(sample?.contrast) || 0);
  const blurPx = Math.max(0, Number(sample?.blurPx) || 0);
  const empty = opacityMass <= EMPTY_EPS && coverage <= EMPTY_EPS && detail <= EMPTY_EPS;
  return { t, phase, opacityMass, coverage, spread, detail, contrast, blurPx, empty };
}

/**
 * Picks the single most representative frame from an array of measured candidate samples.
 *
 * Scoring properties:
 *   1. Empty / transparent frames (`opacityMass`, `coverage`, and `detail` all ~0) score strictly 0.
 *   2. Non-empty frames normalize each visual dimension (`opacityMass`, `detail`, `coverage`,
 *      `spread`, `contrast`) against the animation's own peak across the candidate set, so both
 *      compact HUD badges and full-bleed particle scenes score on an equal [0, 1] scale.
 *   3. Blurred intermediate entrance frames (`blurPx > 0`) receive a smooth sharpness penalty.
 *   4. A gentle Gaussian prior centered at `CANONICAL_PHASE` (0.62) breaks plateaus among settled
 *      frames while allowing genuine brief peaks (e.g. an early flash or late build-up) to win.
 *   5. Exact ties break deterministically by proximity to `CANONICAL_PHASE`, then lower index.
 *
 * @param {readonly object[]} samples
 * @param {object} [options]
 * @param {number} [options.canonicalPhase]
 * @returns {{ index: number, t: number, phase: number, score: number, scores: number[] }}
 */
export function pickRepresentativeFrame(samples, options = {}) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { index: -1, t: 0, phase: 0, score: 0, scores: [] };
  }

  const canonical = typeof options.canonicalPhase === "number" && Number.isFinite(options.canonicalPhase)
    ? clamp01(options.canonicalPhase)
    : CANONICAL_PHASE;

  const norm = samples.map((s, i) => normalizeSample(s, i, samples.length));

  let maxMass = 0;
  let maxCov = 0;
  let maxSpr = 0;
  let maxDet = 0;
  let maxCon = 0;
  for (const s of norm) {
    if (s.empty) continue;
    if (s.opacityMass > maxMass) maxMass = s.opacityMass;
    if (s.coverage > maxCov) maxCov = s.coverage;
    if (s.spread > maxSpr) maxSpr = s.spread;
    if (s.detail > maxDet) maxDet = s.detail;
    if (s.contrast > maxCon) maxCon = s.contrast;
  }

  const allEmpty = maxMass <= EMPTY_EPS && maxCov <= EMPTY_EPS && maxDet <= EMPTY_EPS;

  const wDet = maxDet > EMPTY_EPS ? 0.24 : 0;
  const wCon = maxCon > EMPTY_EPS ? 0.08 : 0;
  const wMass = 0.34 + (0.24 - wDet);
  const wCov = 0.16 + (0.08 - wCon);
  const wSpr = 0.10;

  const scores = norm.map((s) => {
    if (allEmpty || s.empty) return 0;
    const rMass = maxMass > EMPTY_EPS ? s.opacityMass / maxMass : 0;
    const rCov = maxCov > EMPTY_EPS ? s.coverage / maxCov : 0;
    const rSpr = maxSpr > EMPTY_EPS ? s.spread / maxSpr : rCov;
    const rDet = maxDet > EMPTY_EPS ? s.detail / maxDet : rMass;
    const rCon = maxCon > EMPTY_EPS ? s.contrast / maxCon : 0;

    const visual = wMass * rMass + wDet * rDet + wCov * rCov + wSpr * rSpr + wCon * rCon;
    const sharpness = 1 / (1 + 0.18 * s.blurPx);
    const presence = Math.sqrt(Math.max(rMass, rCov, rDet));
    const phasePrior = 0.08 * Math.exp(-Math.pow((s.phase - canonical) / 0.32, 2)) * presence;
    return Math.round((visual * sharpness + phasePrior) * 1e9) / 1e9;
  });

  let bestIdx = 0;
  for (let i = 1; i < norm.length; i++) {
    const diff = scores[i] - scores[bestIdx];
    if (diff > TIE_EPS) {
      bestIdx = i;
      continue;
    }
    if (Math.abs(diff) <= TIE_EPS) {
      const distI = Math.abs(norm[i].phase - canonical);
      const distBest = Math.abs(norm[bestIdx].phase - canonical);
      if (distI + TIE_EPS < distBest) {
        bestIdx = i;
      }
    }
  }

  return {
    index: bestIdx,
    t: norm[bestIdx].t,
    phase: norm[bestIdx].phase,
    score: scores[bestIdx],
    scores,
  };
}
