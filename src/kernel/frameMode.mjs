import REVIEW from '../cards/capabilities.json' with { type: 'json' };

/** Time evaluation is independent of the component framework.
 * direct: evaluate the requested time without replaying earlier frames.
 * stateful: retain Motion/CSS/rAF/simulation history.
 */
export function normalizeFrameMode(mode) {
  // Framework labels in embedded .proc source are accepted, but do not
  // establish random-access capability. Replay preserves their old output.
  if (mode === 'direct') return 'direct';
  if (mode === 'stateful' || mode === 'non-react' || mode === 'react') return 'stateful';
  return undefined;
}
export function cardFrameMode(def, params = def?.defaults || {}) {
  if (!def?._derivedPrerendering && def?.need_prerendering === true) return 'stateful';
  const declared = normalizeFrameMode(def?.frameMode);
  // Conflicting declarations retain history rather than silently skipping it.
  if (declared === 'stateful' && def?.frameMode !== 'react') return 'stateful';
  if (!def?._derivedPrerendering && def?.need_prerendering === false) return 'direct';
  if (declared) return declared;
  try {
    const timing = { ...def?.lifecycle, ...def?.timing?.(params) };
    // Compatibility for static cards embedded in existing .proc files,
    // including the paper texture: no need to rewrite their source/file.
    if (timing.after === 'hold' && timing.settleMs === 0) return 'direct';
  } catch { /* Unknown/broken declarations must retain full history. */ }
  return 'stateful';
}

/** 轴三(依不依赖下层)的取值。`context` 是 sourceDependent / belowDependent 的旧统称,
 * 老 .proc 里的声明照旧读得出来,新审阅只写两个具体值。
 * 顺序 = 保守程度从低到高,组合卡按部件取最保守的那个。
 */
export const COMPOSITING_VALUES = ['independent', 'sourceDependent', 'belowDependent', 'context', 'unknown'];
const CONSERVATISM = { independent: 0, sourceDependent: 1, belowDependent: 2, context: 3, unknown: 4 };
/** 审阅表只能给出这三个值;源码里写的 independent 一律不作数(A0.2)。 */
const REVIEWED_ONLY = ['independent', 'sourceDependent', 'belowDependent'];

/** 组合卡(cardId "composite")没有自己的画面,能力由部件树推导,所以不进审阅表。 */
export const DERIVED_FROM_PARTS = ['composite'];

/** 审阅表的通配:先精确 id,再取最长的 `前缀-*`。53 张粒子卡用 `particles-*` 一条覆盖。 */
export function reviewedCard(id) {
  if (typeof id !== 'string' || !id) return undefined;
  const exact = REVIEW[id];
  if (exact && typeof exact === 'object') return exact;
  let best, bestLen = -1;
  for (const key of Object.keys(REVIEW)) {
    if (!key.endsWith('-*')) continue;
    const prefix = key.slice(0, -1); // 连字符留着:`particles-*` 只配 `particles-xxx`,不配 `particles`
    if (id.startsWith(prefix) && prefix.length > bestLen) { best = REVIEW[key]; bestLen = prefix.length; }
  }
  return best && typeof best === 'object' ? best : undefined;
}

/** 组合卡按部件取最保守的那个;一个部件都没有时只剩占位文字,是独立卡。
 * 传进来的是部件出处的**卡 id**(PartDef.from),解析不出来的按 unknown 算。
 */
export function derivedCompositing(parts) {
  let worst = 'independent';
  for (const part of parts ?? []) {
    const id = typeof part === 'string' ? part : (part?.from ?? part?.cardId);
    const value = reviewedCompositing(id) ?? 'unknown';
    if (CONSERVATISM[value] > CONSERVATISM[worst]) worst = value;
  }
  return worst;
}

function reviewedCompositing(id) {
  const value = reviewedCard(id)?.compositing;
  return REVIEWED_ONLY.includes(value) ? value : undefined;
}

/** 算画布卡的两种 `surface`(审阅表的轴二)。表里不再另写 `canvasHeavy`,由它推出。 */
const CANVAS_SURFACES = ['canvas2d', 'webgl'];
/** 审阅表说这张卡是不是画布卡;表里没有这张卡、或没登记 `surface`,返回 undefined。 */
export function reviewedCanvas(id) {
  const surface = reviewedCard(id)?.surface;
  return typeof surface === 'string' ? CANVAS_SURFACES.includes(surface) : undefined;
}

/** 运行期兜底(A0.2 末句):审阅表说 independent、渲染时却量到 backdrop-filter 或读像素,
 * 这一节会话里就按 belowDependent 处理。只加不减,和审阅表一样喂给身份 digest。
 */
const DEGRADED = new Map();
export function degradeCard(id, reason = 'backdrop-filter') {
  if (typeof id !== 'string' || !id) return false;
  if (DEGRADED.has(id)) return false;
  DEGRADED.set(id, reason);
  return true;
}
export function degradedCards() { return new Map(DEGRADED); }
export function resetDegradedCards() { DEGRADED.clear(); }

/** Scheduling and compositing are independent capabilities. A stateful glass
 * card needs prerendering in its scene, never an isolated transparent movie.
 * Independence is an explicit, reviewed declaration, not a source-code guess.
 *
 * 写法(frameMode)只取卡的声明,审阅表不盖它。
 * 依不依赖下层的读的顺序:审阅表 → CardDef。`independent` / `sourceDependent` / `belowDependent`
 * 的唯一权威是审阅表,源码里写的这三个值一概忽略(只有旧的 `context` 还读得出来)。
 * 画布卡:审阅表的 `surface` 是 canvas2d / webgl 就是;表里不是画布卡或没登记的,再看卡自己写的 `canvasHeavy`。
 * `parts` 是组合卡的部件出处卡 id 列表,不传 = 没有部件。
 */
export function cardCapabilities(def, params = def?.defaults || {}, parts) {
  const frameMode = cardFrameMode(def, params);
  let compositing = reviewedCompositing(def?.id);
  if (!compositing && DERIVED_FROM_PARTS.includes(def?.id)) compositing = derivedCompositing(parts);
  // 源码声明只剩 `context` 这一个还算数:它是「依赖下层 / 依赖源」的旧统称,不是独立声明。
  if (!compositing) compositing = def?.compositing === 'context' ? 'context' : 'unknown';
  if (compositing === 'independent' && DEGRADED.has(def?.id)) compositing = 'belowDependent';
  const canvasHeavy = reviewedCanvas(def?.id) === true || def?.canvasHeavy === true;
  return { frameMode, need_prerendering: frameMode === 'stateful', compositing,
    canvasHeavy, independentCache: compositing === 'independent' };
}
export function clipFrameMode(clip, def) {
  if (clip.parts?.length) return 'stateful';
  return cardFrameMode(def, { ...def?.defaults, ...clip.params });
}
