import { createRequire } from 'node:module';

/**
 * 审阅表（`src/cards/capabilities.json`）的 Node 侧加载。**表缺失不是错误**：
 * 这份文件是人工审阅的产物，装机包里可以没有它，那时每张卡都按 `unknown` 走，
 * 也就是最保守的那条路（保留下层场景），而不是让整条视觉链路加载失败。
 *
 * 表里每张卡登记三样（字段与取值的说明在 `src/cards/capabilities.md`）：
 *   `writing`      哪种写法。登记的值取自卡的声明，以声明为准；表和声明对不上由守门测试拦
 *   `surface`      画在什么上，以表为准
 *   `compositing`  依不依赖下层，以表为准
 * 下面三个常量是这三样的取值表，守门测试（`src/cards/capabilities.test.mjs`）拿它们核对整张表。
 */
/** 写法 → 卡片声明里的 `frameMode`。 */
export const CARD_WRITINGS = Object.freeze({ remotion: 'direct', motion: 'stateful' });
/** 画在什么上：DOM（含 SVG）、2D 画布、WebGL、没有画面（只出声音的卡）。 */
export const CARD_SURFACES = Object.freeze(['dom', 'canvas2d', 'webgl', 'none']);
/** 算画布卡的那两种。 */
export const CANVAS_SURFACES = Object.freeze(['canvas2d', 'webgl']);
/** 审阅过的三个结论，加两个记号：`unknown` = 登记了但故意不审（探针要它保持未知），
 * `fromParts` = 组合卡，由部件推导。两个记号在运行时都不当审阅结论用。 */
export const REVIEWED_COMPOSITING = Object.freeze(['independent', 'sourceDependent', 'belowDependent']);
export const CARD_COMPOSITINGS = Object.freeze([...REVIEWED_COMPOSITING, 'unknown', 'fromParts']);

let REVIEW;
function reviewTable() {
  if (REVIEW) return REVIEW;
  try {
    REVIEW = createRequire(import.meta.url)('../src/cards/capabilities.json');
  } catch {
    REVIEW = {};
  }
  return REVIEW;
}

/** 先精确 id，再取最长的 `前缀-*` 通配（和 `frameMode.mjs` 的 `reviewedCard` 同一口径）。 */
export function reviewedCapabilities(cardId) {
  if (typeof cardId !== 'string' || !cardId) return undefined;
  const table = reviewTable();
  const exact = table[cardId];
  if (exact && typeof exact === 'object') return exact;
  let best, bestLen = -1;
  for (const key of Object.keys(table)) {
    if (!key.endsWith('-*')) continue;
    const prefix = key.slice(0, -1);
    if (cardId.startsWith(prefix) && prefix.length > bestLen) { best = table[key]; bestLen = prefix.length; }
  }
  return best && typeof best === 'object' ? best : undefined;
}

/**
 * 一张卡在表里登记的三样，整理成读的一方直接能用的样子；表里没有这张卡返回 undefined。
 *
 *   `writing`      'remotion' | 'motion'
 *   `frameMode`    写法对应的声明值 'direct' | 'stateful'（手里有卡片定义时以定义的声明为准，这里只是登记值）
 *   `surface`      'dom' | 'canvas2d' | 'webgl' | 'none'
 *   `canvas`       是不是画布卡（2D 画布或 WebGL），由 `surface` 推出；`surface` 缺了给 false
 *   `compositing`  'independent' | 'sourceDependent' | 'belowDependent'；登记成 `unknown`、`fromParts` 或写了别的值，
 *                  一律给 'unknown'（和 `frameMode.mjs` 一样，不当审阅结论）
 *   `reviewed`     轴三有没有审阅结论
 *
 * 字段缺了或写了不认识的值，对应那一项给 undefined，不抛错：表是随包发的数据，读的一方走保守的路。
 */
export function reviewedClassification(cardId) {
  const entry = reviewedCapabilities(cardId);
  if (!entry) return undefined;
  const writing = Object.hasOwn(CARD_WRITINGS, entry.writing) ? entry.writing : undefined;
  const surface = CARD_SURFACES.includes(entry.surface) ? entry.surface : undefined;
  const reviewed = REVIEWED_COMPOSITING.includes(entry.compositing);
  return { writing, frameMode: writing ? CARD_WRITINGS[writing] : undefined, surface,
    canvas: surface ? CANVAS_SURFACES.includes(surface) : false,
    compositing: reviewed ? entry.compositing : 'unknown', reviewed };
}

/** Hide unrelated outputs without deleting graph inputs. A clip's source can
 * live on its own track, another track, or an otherwise unused card node. */
export function isolateClip(project, clipId, { preserveContext = false, capabilities = reviewedCapabilities } = {}) {
  const targetIndex = (project.tracks || []).findIndex(track => (track.clips || []).some(clip => clip.id === clipId));
  if (targetIndex < 0) return null;
  const targetTrack = project.tracks[targetIndex];
  const clipIndex = targetTrack.clips.findIndex(clip => clip.id === clipId);
  const clip = targetTrack.clips[clipIndex];
  const node = (project.cardNodes || []).find(node => node.id === clip.nodeId);
  // Unknown Chrome composition must keep its lower browser scene. Reviewed
  // independent 素材效果卡 still resolve hidden inputs through sourceProject.
  const context = preserveContext && (node ? capabilities(clip.cardId)?.compositing !== 'independent' : !!clip.cardId);
  const ids = new Set(project.tracks.map(track => track.id));
  const tracks = project.tracks.flatMap((track, index) => {
    if (index !== targetIndex) return [{ ...track, ...(context && index > targetIndex ? {} : { hidden: true, sourceOnly: true }) }];
    const visible = context ? track.clips.slice(0, clipIndex + 1) : [clip];
    const siblings = track.clips.filter(item => !visible.includes(item));
    const result = [{ ...track, hidden: false, sourceOnly: false, clips: visible }];
    if (siblings.length) {
      let id = `__pc_vision_source_${track.id}`, suffix = 1;
      while (ids.has(id)) id = `__pc_vision_source_${track.id}_${suffix++}`;
      ids.add(id);
      result.push({ ...track, id, hidden: true, sourceOnly: true, clips: siblings });
    }
    return result;
  });
  return { clip, context, project: { ...project, tracks } };
}
