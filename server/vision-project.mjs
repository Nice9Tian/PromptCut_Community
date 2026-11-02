import { createRequire } from 'node:module';

/**
 * Node-side loading for the review table (`src/cards/capabilities.json`). **Missing table is not an
 * error**: this file is the product of manual review and may be absent from the installation
 * package. In that case, each card falls back to `unknown`, taking the most conservative path
 * (preserving the lower scene) rather than failing to load the entire visual pipeline.
 *
 * Each card in the table registers three aspects (field and value details in `src/cards/capabilities.md`):
 *   `writing`      Which syntax style. Registered value comes from card declaration, which takes
 *                  precedence; mismatches between table and declaration are caught by gatekeeper tests
 *   `surface`      What to draw on, table takes precedence
 *   `compositing`  Whether it depends on lower layers, table takes precedence
 * The three constants below are value tables for these three aspects, used by gatekeeper tests
 * (`src/cards/capabilities.test.mjs`) to verify the entire table.
 */
/** Syntax style → `frameMode` in card declaration. */
export const CARD_WRITINGS = Object.freeze({ remotion: 'direct', motion: 'stateful' });
/** What to draw on: DOM (including SVG), 2D canvas, WebGL, no visuals (audio-only card). */
export const CARD_SURFACES = Object.freeze(['dom', 'canvas2d', 'webgl', 'none']);
/** The two types classified as canvas cards. */
export const CANVAS_SURFACES = Object.freeze(['canvas2d', 'webgl']);
/**
 * Three reviewed conclusions plus two markers: `unknown` = registered but intentionally
 * unreviewed (probes require it to remain unknown), `fromParts` = composite card, derived from
 * parts. Neither marker is treated as a review conclusion at runtime.
 */
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

/** Exact id first, then longest `prefix-*` wildcard (aligned with `reviewedCard` in `frameMode.mjs`). */
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
 * Organizes the three aspects registered for a card in the table into a form directly usable by
 * the reader; returns undefined if the card is not in the table.
 *
 *   `writing`      'remotion' | 'motion'
 *   `frameMode`    Declared value corresponding to syntax style: 'direct' | 'stateful' (when the
 *                  card definition is on hand, the definition's declaration takes precedence; this
 *                  is only the registered value)
 *   `surface`      'dom' | 'canvas2d' | 'webgl' | 'none'
 *   `canvas`       Whether it is a canvas card (2D canvas or WebGL), inferred from `surface`;
 *                  defaults to false if `surface` is missing
 *   `compositing`  'independent' | 'sourceDependent' | 'belowDependent'; if registered as
 *                  `unknown`, `fromParts`, or any other value, always returns 'unknown' (same as
 *                  `frameMode.mjs`, not treated as a review conclusion)
 *   `reviewed`     Whether the third axis has a review conclusion
 *
 * If a field is missing or contains an unrecognized value, that item is set to undefined without
 * throwing an error: the table is shipped with the package, so the reader takes the conservative path.
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
  // independent media effect cards still resolve hidden inputs through sourceProject.
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
