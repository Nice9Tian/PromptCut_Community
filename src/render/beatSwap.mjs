/**
 * 在线双舞台播放时的「按拍换快照」预算(C10 契约 `docs/plan/c10-contract.md` 第 6 节、第 18 节第 1 条;
 * 语义 `product/rendering.md`「兜底顺序」、`product/platforms.md`「在线浏览器模式」)。
 *
 * 在线页面没有预渲染进程,也就没有轨道流:重层每拍换一次 HTML 快照。换一次快照的成本计入每拍预算,
 * 装不下的重层这一拍显示占位符(兜底顺序第 4 步)。
 *
 *   deadMs = max(0, B − 已占用)          B = budgetOf(fps) = 1000 / fps × 0.7(与 `pipelinePlan.mjs` 的分派同一个预算)
 *   从上到下逐层累加各层自己的换帧成本,累加到超过 deadMs 的那一层起(含)都显示占位符
 *
 * 各层的换帧成本由调用方给(`costOf`;swap-tuning 实测,`scripts/probes/swap-cost-probe.mjs`):已知这一层快照大小的
 * 按大小估(`swapCostOfSize`),不知道的按卡种(`SWAP_MS_BY_KIND`);认不出卡种的层、调用方没给每层成本时,
 * 取缺省 `SWAP_MS`(兜底)。只给 `swapMs` 的旧调用每层同一个成本,
 * 结果与原来的 `floor(deadMs / swapMs)` 相同。
 *
 * 「已占用」是这一拍轻管线里活渲的卡的权重之和(`planDispatch.ts` 的 `lightCostAt`,口径同 `clipWeight` 的 `w`)。
 * 重层按调用方给的顺序取(调用方从上到下排:最上面的层先换);装不下的那一层之后的都不换,即使更便宜 ——
 * 占位符只出现在下层,不出现「上层占位、下层照换」。同一输入结果稳定。
 *
 * 纯函数:浏览器与 Node 同一份。
 */
import { budgetOf } from './pipelinePlan.mjs';

/** 换一次快照的成本缺省值(毫秒):卡种认不出来、或调用方没给每层成本时的兜底(C10 契约第 6 节) */
export const SWAP_MS = 3;

/**
 * 按卡种的换帧成本(毫秒;swap-tuning 实测,可见舞台主线程每多换一层这一拍多干的时长,见 `swap-cost-probe.mjs`;
 * 取各卡种实测中位数向上取到 0.5:DOM 25 张 1.7、Lottie 5 张 6.3、画布 7 张 3.7)。只在还不知道这一层快照大小时用
 * (分派、这一层的第一次投递);Lottie 的长尾(大的一帧 27～31 ms)由按大小估接住。
 *   - `dom`:普通 DOM 卡(含毛玻璃 `backdrop-filter`、`filter: blur` 的卡、按声明是 DOM 的用户卡);
 *   - `lottie`:Lottie 卡(SVG 节点多,快照大);
 *   - `canvas`:画布卡(快照里画布已栅格成内联位图:粒子、三维、共享 WebGL 渲染器的卡)。
 * 数字是三级机制(`docs/semantics/mechanism/rendering.md`「兜底顺序」)。
 */
export const SWAP_MS_BY_KIND = Object.freeze({ dom: 2, lottie: 6.5, canvas: 4 });

/**
 * 已知这一层快照有多大时的估法(swap-tuning 实测拟合,见 `swap-cost-probe.mjs`):换帧成本基本与快照的字符数成正比,
 * DOM 与 Lottie 的 SVG 同属「文本」,每 KB 的成本相近;画布卡的快照几乎全是内联位图(一个长属性值),每 KB 便宜得多。
 *
 *   成本 = baseMs + (位图 ? bitmapMsPerKB : textMsPerKB) × 字符数 / 1024
 *
 * 同一卡种里快照大小可以差十倍(实测 DOM 卡 12～144 KB、Lottie 65～733 KB),按大小估比按卡种估准
 * (37 张卡相对实测的中位误差:按大小 11%、按卡种 32%、一律 3 ms 64%);
 * 这一层还没投递过(不知道大小)时退回按卡种。数字是三级机制(`mechanism/rendering.md`「兜底顺序」)。
 */
export const SWAP_COST_MODEL = Object.freeze({ baseMs: 0.8, textMsPerKB: 0.04, bitmapMsPerKB: 0.009 });

/**
 * 按快照大小估这一层的换帧成本;大小不是正数回 `null`(调用方退回按卡种)。
 * @param {{ bytes?: number, bitmap?: boolean } | null | undefined} size `bytes`:快照 HTML 的字符数;`bitmap`:内含内联位图(`data:image/`)
 * @param {{ baseMs: number, textMsPerKB: number, bitmapMsPerKB: number }} [model]
 * @returns {number | null}
 */
export function swapCostOfSize(size, model = SWAP_COST_MODEL) {
  const bytes = Number(size?.bytes);
  if (!(bytes > 0)) return null;
  const perKB = size.bitmap ? model.bitmapMsPerKB : model.textMsPerKB;
  const v = model.baseMs + perKB * bytes / 1024;
  return v > 0 ? v : null;
}

/**
 * 一层属于哪个卡种。认不出来回 `null`(按 `SWAP_MS` 兜底)。
 *
 * @param {{ cardId?: string | null, known?: boolean, source?: string, canvas?: boolean, canvasHeavy?: boolean } | null | undefined} desc
 *   `known`:这个页面上有没有这张卡的定义(没有 = 代码不在这里的用户卡,内容认不出来);
 *   `canvas`:定义里声明了画布契约(`dom2d` 除外);`canvasHeavy`:审阅表或定义标了画布重。
 * @returns {'dom' | 'lottie' | 'canvas' | null}
 */
export function swapKindOf(desc) {
  const id = typeof desc?.cardId === 'string' ? desc.cardId : '';
  if (!id) return null;
  if (id === 'lottie' || id.startsWith('lottie-')) return 'lottie';
  if (id === 'particles' || id.startsWith('particles-')) return 'canvas';
  if (desc.known === false) return null;
  if (desc.canvas === true || desc.canvasHeavy === true) return 'canvas';
  return 'dom';
}

/**
 * 这个卡种的换帧成本;认不出来(`null`)或表里没有就回 `fallback`。
 * @param {string | null | undefined} kind
 * @param {Readonly<Record<string, number>>} [table]
 * @param {number} [fallback]
 */
export function swapCostOf(kind, table = SWAP_MS_BY_KIND, fallback = SWAP_MS) {
  const v = kind ? Number(table?.[kind]) : NaN;
  return v > 0 ? v : fallback;
}

/**
 * @param {{ fps: number, occupiedMs?: number, layers: readonly string[], swapMs?: number, costOf?: (id: string) => number | null | undefined }} input
 *   `swapMs`:每层同一个成本(旧调用;缺省 `SWAP_MS`,也是 `costOf` 给不出数时的兜底);
 *   `costOf`:每层自己的成本(毫秒),回的不是正数就按 `swapMs`。
 * @returns {{ swap: string[], placeholder: string[], deadMs: number, fit: number, usedMs: number }}
 */
export function fitBeatSwaps({ fps, occupiedMs = 0, layers, swapMs = SWAP_MS, costOf }) {
  const rate = Math.max(1, Number(fps) || 30);
  const occupied = Math.max(0, Number(occupiedMs) || 0);
  const uniform = Number(swapMs) > 0 ? Number(swapMs) : SWAP_MS;
  const deadMs = Math.max(0, budgetOf(rate) - occupied);
  const list = [];
  const seen = new Set();
  for (const id of layers ?? []) {
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(key);
  }
  const costAt = (id) => {
    if (typeof costOf !== 'function') return uniform;
    let v;
    try { v = Number(costOf(id)); } catch { v = NaN; }
    return v > 0 ? v : uniform;
  };
  let fit = 0;
  let usedMs = 0;
  for (const id of list) {
    const next = usedMs + costAt(id);
    // 浮点:17.5 = 5 × 3.5 这类恰好装满的情形别因为 17.500000000000004 少装一层
    if (next > deadMs + 1e-9) break;
    usedMs = next;
    fit++;
  }
  return { swap: list.slice(0, fit), placeholder: list.slice(fit), deadMs, fit, usedMs };
}
