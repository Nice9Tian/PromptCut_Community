/**
 * 界限搜索（语义 `docs/semantics/mechanism/rendering.md`「界限搜索与成本记录」；`product/platforms.md`「在线浏览器」的轻重判定；
 * 契约 `docs/plan/c10-contract.md` 第 3 节）。**纯逻辑**：不碰舞台、不碰网络，测量与本地存取都由调用方注入，
 * 浏览器和 Node 单测同一份代码。
 *
 * # 做法
 *
 * 1. 每张卡取一个代表耗时：本项目的共享成本记录里这张卡（`identityKey`）各环境的活渲单帧耗时取中位数；
 * 2. 按代表耗时从小到大排序（相同的按 `identityKey` 定序）；没有记录的卡：`measureUnrecorded` 为真时**逐张实测**
 *    （2026-10-07 用户定「没有就逐张实测」；在线页面一律给真），为假时按重卡、不测（旧做法，单测留着）；
 * 3. 对排好的卡做二分查找：测中间那一张在本机的活渲单帧耗时，不超过预算 B 往更耗时的一半找，超过往更省的一半找，
 *    直到找到第一张本机跑不动的卡（界限）。它和比它耗时的全判重，比它省的全判轻；
 * 4. 余量：界限两侧各再测 `margin` 张（缺省 1），取离界限最近、还不知道本机耗时的那一张。实测和排序矛盾时以实测为准，
 *    界限随之挪动（省的一侧测出跑不动：界限挪到它；重的一侧测出跑得动：界限挪到它后面），挪动之后在同一侧接着再测，
 *    这样多测的总数不超过 `extraMax`（缺省 2）；
 * 5. 测过的卡一律按实测判，没测的卡按它在界限的哪一侧判；没有记录又没测的按重卡。
 *
 * 测量次数上界 = ⌈log₂(卡数 + 1)⌉ + 2 × margin + extraMax，即约 log₂(卡数) + 2（`maxMeasurements`）。
 *
 * # 本地复用
 *
 * 本机测过的结果按「卡片身份 + 本机环境指纹」（`localCostKey`，形如 `<identityKey>|<envFingerprint>`）经注入的
 * `store.getCost(key)` / `store.putCost(key, rec)` 存取（与页面内快照库 L2 的方法同名，集成时接到 L2 的 `costs` 表）。
 * 取到了就不再测，也不算进测量次数。测量失败（舞台没回、被打断）按跑不动算，不存。
 *
 * # 判重的口径
 *
 * 与桌面分派同一个式子：`stepMs × COST_SCALE > B`（`pipelinePlan.mjs` 的 `clipWeight`）。`scale` 缺省 1。
 */

/** 界限两侧各再测几张（三级可调，`mechanism/rendering.md`「界限搜索与成本记录」） */
export const BOUNDARY_MARGIN = 1;
/** 余量测出矛盾、界限挪动之后，最多再多测几张（三级可调） */
export const BOUNDARY_EXTRA_MAX = 2;

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 中位数；空数组回 undefined。偶数个取中间两个的平均 */
export function median(values) {
  const s = (values ?? []).filter(finite).sort((a, b) => a - b);
  if (!s.length) return undefined;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/**
 * 每张卡的代表耗时：同一个 `identityKey` 的各条记录（来自不同环境）取 `stepMs` 的中位数。
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

/** 本地复用的键：卡片身份 + 本机环境指纹 */
export function localCostKey(identityKey, envFingerprint) {
  return `${identityKey}|${envFingerprint ?? ''}`;
}

/** 测量次数的上界：⌈log₂(n + 1)⌉ + 2 × margin + extraMax */
export function maxMeasurements(n, margin = BOUNDARY_MARGIN, extraMax = BOUNDARY_EXTRA_MAX) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (count === 0) return 0;
  return Math.ceil(Math.log2(count + 1)) + 2 * Math.max(0, margin) + Math.max(0, extraMax);
}

/**
 * 界限搜索。
 *
 * @param {object} o
 * @param {Iterable<string>} o.keys 要判的卡（`identityKey`，重复的只算一张）
 * @param {Iterable<{ identityKey: string, stepMs: number }>} o.records 本项目的共享成本记录（全部环境）
 * @param {number} o.budgetMs 预算 B（`budgetOf(fps)`）
 * @param {(key: string) => Promise<{ stepMs: number, samples?: number } | null>} o.measure 在本机舞台里测这张卡的活渲单帧耗时
 * @param {{ getCost(key: string): any, putCost(key: string, rec: object): any } | null} [o.store] 本地复用
 * @param {string} [o.envFingerprint] 本机环境指纹（本地复用的键用）
 * @param {number} [o.scale] `COST_SCALE`，缺省 1
 * @param {number} [o.margin] 界限两侧各再测几张，缺省 `BOUNDARY_MARGIN`
 * @param {number} [o.extraMax] 挪界限后最多再多测几张，缺省 `BOUNDARY_EXTRA_MAX`
 * @param {string} [o.mode] 本地复用的记录里记的构建模式
 * @param {boolean} [o.measureUnrecorded] 没有记录的卡逐张实测（缺省假：按重卡、不测）
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
      try { await store.putCost(lk, rec); } catch { /* 存不下就下次再测 */ }
    }
    return ms;
  }
  const heavyMs = (ms) => ms * k > B;
  const heavyAt = async (i) => heavyMs(await costAt(i));

  // 3. 二分：第一张跑不动的卡
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (await heavyAt(mid)) hi = mid;
    else lo = mid + 1;
  }
  let boundary = lo;
  const searchMeasurements = measurements;

  // 4. 余量：两侧各测 margin 张；矛盾时挪界限，同一侧接着测，多测的总数不超过 extraMax
  let extra = Math.max(0, extraMax);
  const unknownBelow = (f) => { for (let i = f - 1; i >= 0; i--) if (!known.has(order[i].key)) return i; return -1; };
  const unknownAtOrAbove = (f) => { for (let i = f; i < n; i++) if (!known.has(order[i].key)) return i; return -1; };
  for (let m = 0; m < Math.max(0, margin); m++) {
    // 省的一侧
    for (let allowance = 1; allowance > 0; allowance--) {
      const j = unknownBelow(boundary);
      if (j < 0) break;
      if (await heavyAt(j)) {
        boundary = j;
        if (extra > 0) { extra--; allowance++; }
      }
    }
    // 重的一侧
    for (let allowance = 1; allowance > 0; allowance--) {
      const j = unknownAtOrAbove(boundary);
      if (j < 0) break;
      if (!(await heavyAt(j))) {
        boundary = j + 1;
        if (extra > 0) { extra--; allowance++; }
      }
    }
  }

  // 4b. 没有记录的卡逐张实测（在线页面；单测的旧做法不测）
  if (measureUnrecorded) for (const key of unrecorded) await costOf(key, -1);

  // 5. 判
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
 * 搜索之后项目里又来了新卡（或别的机器补了记录）：不再测，按已有的结果判。
 * 测过的按实测；有代表耗时的按它落在界限的哪一侧（代表耗时不小于界限那张卡的算重）；没有记录的算重
 * （在线页面先把新来的、没有记录的卡补测进 `result.measured` 再来判，`src/editor/costSearch.ts` 的 `measureNewCards`）。
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

/** 本地复用的缺省实现：页面内存（关掉页面就没了）。集成时换成 L2 的 `costs` 表 */
export function createMemoryCostStore() {
  const map = new Map();
  return {
    getCost: async (key) => (map.has(key) ? { ...map.get(key) } : undefined),
    putCost: async (key, rec) => { map.set(key, { ...rec }); },
    size: () => map.size,
  };
}
