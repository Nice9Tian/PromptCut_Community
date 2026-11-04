/**
 * Bounds search (semantics `docs/semantics/mechanism/rendering.md` "Bounds search and cost records";
 * light/heavy classification in `product/platforms.md` "Online browser"; contract
 * `docs/plan/c10-contract.md` section 3). **Pure logic**: does not touch stage or network;
 * measurement and local storage/retrieval are both injected by caller; same code for browser and
 * Node unit tests.
 *
 * # Procedure
 *
 * 1. Take a representative duration for each card: median of single-frame live render durations
 *    across environments for this card (`identityKey`) in this project's shared cost records;
 * 2. Sort cards in ascending order of representative duration (ties ordered by `identityKey`);
 *    for cards without records: when `measureUnrecorded` is true, **measure one by one**
 *    ((user decision, 2026-10-07) "measure one by one if missing"; online pages always pass true);
 *    when false, treat as heavy cards without measuring (legacy approach, kept for unit tests);
 * 3. Perform binary search on the sorted cards: measure the local single-frame live render duration
 *    of the middle card; if it does not exceed budget B, search in the more time-consuming half;
 *    if it exceeds, search in the cheaper half, until finding the first card this machine cannot run
 *    (the boundary). It and cards more time-consuming than it are all classified as heavy; cards
 *    cheaper than it are all classified as light;
 * 4. Margin: measure `margin` additional cards on each side of the boundary (defaults to 1),
 *    picking the card closest to the boundary whose local duration is not yet known. If measurements
 *    contradict the sort order, measurements take precedence and the boundary moves accordingly
 *    (measured as cannot run on the cheaper side: boundary moves to it; measured as can run on the
 *    heavy side: boundary moves behind it); after moving, continue measuring on the same side, such
 *    that the total number of extra measurements does not exceed `extraMax` (defaults to 2);
 * 5. Measured cards are always classified by measurement; unmeasured cards are classified by which
 *    side of the boundary they fall on; unrecorded and unmeasured cards are classified as heavy cards.
 *
 * Upper bound on measurement count = ⌈log₂(card count + 1)⌉ + 2 × margin + extraMax,
 * i.e., approximately log₂(card count) + 2 (`maxMeasurements`).
 *
 * # Local reuse
 *
 * Locally measured results are accessed via injected `store.getCost(key)` / `store.putCost(key, rec)`
 * by "card identity + local environment fingerprint" (`localCostKey`, shaped like
 * `<identityKey>|<envFingerprint>`) (same method names as in-page snapshot store L2, connected to
 * L2's `costs` table during integration). If retrieved, it is not measured again and does not count
 * toward measurement count. Measurement failures (stage did not respond, interrupted) are treated
 * as unable to run and not stored.
 *
 * # Standard for classifying as heavy
 *
 * Same formula as desktop dispatch: `stepMs × COST_SCALE > B` (`clipWeight` in
 * `pipelinePlan.mjs`). `scale` defaults to 1.
 */

/** Number of additional cards to measure on each side of the boundary (tier-3 tunable, `mechanism/rendering.md` "Bounds search and cost records") */
export const BOUNDARY_MARGIN = 1;
/** Maximum number of additional cards to measure after margin measurements contradict and the boundary moves (tier-3 tunable) */
export const BOUNDARY_EXTRA_MAX = 2;

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Median; returns undefined for empty array. Takes the average of middle two for even count */
export function median(values) {
  const s = (values ?? []).filter(finite).sort((a, b) => a - b);
  if (!s.length) return undefined;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/**
 * Representative duration for each card: takes the median of `stepMs` across records for the same
 * `identityKey` (from different environments).
 * @param {Iterable<{ identityKey: string, stepMs: number }>} records
 * @returns {Map<string, number>}
 */
export function representativeCosts(records) {
  const byCard = new Map();
  for (const r of records ?? []) {
    if (!r || typeof r.identityKey !== 'string' || !finite(r.stepMs)) continue;
    const list = byCard.get(r.identityKey);
    if (list) list.push(r.stepMs);
    else byCard.set(r.identityKey, [r.stepMs]);
  }
  const out = new Map();
  for (const [key, list] of byCard) out.set(key, median(list));
  return out;
}

/** Key for local reuse: card identity + local environment fingerprint */
export function localCostKey(identityKey, envFingerprint) {
  return `${identityKey}|${envFingerprint ?? ''}`;
}

/** Upper bound on measurement count: ⌈log₂(n + 1)⌉ + 2 × margin + extraMax */
export function maxMeasurements(n, margin = BOUNDARY_MARGIN, extraMax = BOUNDARY_EXTRA_MAX) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (count === 0) return 0;
  return Math.ceil(Math.log2(count + 1)) + 2 * Math.max(0, margin) + Math.max(0, extraMax);
}

/**
 * Bounds search.
 *
 * @param {object} o
 * @param {Iterable<string>} o.keys Cards to classify (`identityKey`, duplicates counted once)
 * @param {Iterable<{ identityKey: string, stepMs: number }>} o.records Shared cost records for this
 *   project (all environments)
 * @param {number} o.budgetMs Budget B (`budgetOf(fps)`)
 * @param {(key: string) => Promise<{ stepMs: number, samples?: number } | null>} o.measure Measures
 *   single-frame live render duration of this card on the local stage
 * @param {{ getCost(key: string): any, putCost(key: string, rec: object): any } | null} [o.store] Local reuse
 * @param {string} [o.envFingerprint] Local environment fingerprint (used by local reuse key)
 * @param {number} [o.scale] `COST_SCALE`, defaults to 1
 * @param {number} [o.margin] Number of additional cards to measure on each side of the boundary,
 *   defaults to `BOUNDARY_MARGIN`
 * @param {number} [o.extraMax] Maximum additional cards to measure after moving the boundary,
 *   defaults to `BOUNDARY_EXTRA_MAX`
 * @param {string} [o.mode] Build mode recorded in local reuse records
 * @param {boolean} [o.measureUnrecorded] Measure unrecorded cards one by one (defaults to false:
 *   treat as heavy cards without measuring)
 * @param {() => number} [o.now]
 * @returns {Promise<BoundaryResult>}
 */
export async function boundarySearch({
  keys, records, budgetMs, measure, store = null, envFingerprint = '', scale = 1,
  margin = BOUNDARY_MARGIN, extraMax = BOUNDARY_EXTRA_MAX, mode = 'build', now = Date.now, measureUnrecorded = false,
}) {
  const B = Number(budgetMs);
  const k = finite(scale) && scale > 0 ? scale : 1;
  const reps = representativeCosts(records);
  const all = [...new Set([...(keys ?? [])].filter((x) => typeof x === 'string' && x))].sort(byKey);
  const unrecorded = all.filter((key) => !reps.has(key));
  const order = all.filter((key) => reps.has(key)).map((key) => ({ key, rep: reps.get(key) }))
    .sort((a, b) => a.rep - b.rep || byKey(a.key, b.key));
  const n = order.length;

  /** key → { ms, cached, failed } */
  const known = new Map();
  let measurements = 0;
  const trace = [];

  async function costAt(i) {
    return costOf(order[i].key, i);
  }
  async function costOf(key, i) {
    const hit = known.get(key);
    if (hit) return hit.ms;
    const lk = localCostKey(key, envFingerprint);
    if (store) {
      let cached;
      try { cached = await store.getCost(lk); } catch { cached = undefined; }
      if (cached && finite(cached.stepMs)) {
        known.set(key, { ms: cached.stepMs, cached: true, failed: false });
        trace.push({ index: i, key, ms: cached.stepMs, cached: true });
        return cached.stepMs;
      }
    }
    measurements++;
    let r = null;
    try { r = await measure(key); } catch { r = null; }
    const ok = !!r && finite(r.stepMs) && r.stepMs >= 0;
    const ms = ok ? r.stepMs : Infinity;
    known.set(key, { ms, cached: false, failed: !ok });
    trace.push({ index: i, key, ms: ok ? ms : null, cached: false });
    if (ok && store) {
      const rec = { identityKey: key, envFingerprint, stepMs: r.stepMs, samples: Number.isSafeInteger(r.samples) && r.samples > 0 ? r.samples : 1, measuredAt: now(), mode };
      try { await store.putCost(lk, rec); } catch { /* If it cannot be stored, measure again next time */ }
    }
    return ms;
  }
  const heavyMs = (ms) => ms * k > B;
  const heavyAt = async (i) => heavyMs(await costAt(i));

  // 3. Binary search: the first card that cannot keep up
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (await heavyAt(mid)) hi = mid;
    else lo = mid + 1;
  }
  let boundary = lo;
  const searchMeasurements = measurements;

  // 4. Margin: measure margin cards on each side; on contradiction, shift boundary and continue
  // measuring on the same side, with total extra measurements not exceeding extraMax
  let extra = Math.max(0, extraMax);
  const unknownBelow = (f) => { for (let i = f - 1; i >= 0; i--) if (!known.has(order[i].key)) return i; return -1; };
  const unknownAtOrAbove = (f) => { for (let i = f; i < n; i++) if (!known.has(order[i].key)) return i; return -1; };
  for (let m = 0; m < Math.max(0, margin); m++) {
    // Light side
    for (let allowance = 1; allowance > 0; allowance--) {
      const j = unknownBelow(boundary);
      if (j < 0) break;
      if (await heavyAt(j)) {
        boundary = j;
        if (extra > 0) { extra--; allowance++; }
      }
    }
    // Heavy side
    for (let allowance = 1; allowance > 0; allowance--) {
      const j = unknownAtOrAbove(boundary);
      if (j < 0) break;
      if (!(await heavyAt(j))) {
        boundary = j + 1;
        if (extra > 0) { extra--; allowance++; }
      }
    }
  }

  // 4b. Measure cards without records card by card (online page; legacy unit test approach
  // skips measurement)
  if (measureUnrecorded) for (const key of unrecorded) await costOf(key, -1);

  // 5. Classify
  const heavy = new Set();
  const light = new Set();
  for (const key of unrecorded) {
    const hit = known.get(key);
    (hit && !heavyMs(hit.ms) ? light : heavy).add(key);
  }
  order.forEach(({ key }, i) => {
    const hit = known.get(key);
    const isHeavy = hit ? heavyMs(hit.ms) : i >= boundary;
    (isHeavy ? heavy : light).add(key);
  });
  const threshold = boundary < n ? order[boundary].rep : Infinity;
  const measured = new Map([...known.entries()].map(([key, v]) => [key, { ...v }]));
  return {
    heavy, light, unrecorded, order, boundary, threshold, measured, measurements, searchMeasurements, trace,
    budgetMs: B, scale: k, envFingerprint,
  };
}

/**
 * When new cards arrive in the project after search (or another machine adds records): do not
 * measure again; classify based on existing results.
 * Measured cards follow actual measurements; cards with representative costs are classified by
 * which side of the boundary they fall on (considered heavy if representative cost is not less than
 * the boundary card); cards without records are considered heavy (the online page first catches up
 * measurements for new, unrecorded cards into `result.measured` before classifying;
 * `measureNewCards` in `src/editor/costSearch.ts`).
 * @param {BoundaryResult} result
 * @param {Iterable<string>} keys
 * @param {Iterable<{ identityKey: string, stepMs: number }>} records
 * @returns {{ heavy: Set<string>, light: Set<string> }}
 */
export function classifyWithBoundary(result, keys, records) {
  const reps = representativeCosts(records);
  const heavy = new Set();
  const light = new Set();
  for (const key of new Set(keys ?? [])) {
    if (typeof key !== 'string' || !key) continue;
    const hit = result?.measured?.get(key);
    if (hit) { (hit.ms * (result.scale ?? 1) > result.budgetMs ? heavy : light).add(key); continue; }
    const rep = reps.get(key);
    if (rep === undefined || !result) { heavy.add(key); continue; }
    (rep >= result.threshold ? heavy : light).add(key);
  }
  return { heavy, light };
}

/** Default implementation for local reuse: in-page memory (lost on close). Replaced with L2 `costs` table upon integration */
export function createMemoryCostStore() {
  const map = new Map();
  return {
    getCost: async (key) => (map.has(key) ? { ...map.get(key) } : undefined),
    putCost: async (key, rec) => { map.set(key, { ...rec }); },
    size: () => map.size,
  };
}
