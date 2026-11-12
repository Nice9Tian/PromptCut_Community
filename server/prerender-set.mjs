/**
 * Prerender set `plan.prerenderSet` (pinned render 9).
 *
 * **Identical pure function on both sides**: `planPipelines` in `src/render/pipelinePlan.mjs`
 * greedily dispatches based on measured costs from K1; the **union of cards classified as heavy
 * at any position** is the prerender set. The page uses it to decide how to render each tick,
 * and the prerender process uses it to decide which cards to prerender: the two sides do not
 * exchange dispatch tables, **only synchronizing `costs` and `tuning`** (the last item in K2),
 * so identical inputs must yield field-by-field identical tables on both sides.
 *
 * # Where the three inputs on the prerender process side come from
 *
 * 1. **`costs` / `tuning`**: Both processes mount `vite-plugin-costs`. After each PUT, the editor
 *    process forwards the **identical copy** as is (`forwardToPrerender`), and this side persists
 *    its own copy locally; `loadCosts(root)` / `loadTuning(root)` read from disk.
 * 2. **clipId → `cardCostKey`**: `plan()` in `card-cache.mjs` also computes `costKey` at the same
 *    place where it computes `snapshotKey` (only there do graph nodes and `sourceVersions` exist),
 *    with criteria verbatim aligned with `clipCostIndex` on the page side.
 * 3. **Clip table for segmentation**: controls come with `clipId` / `start` / `end`, assembled
 *    into a synthetic project with only these three items and fed to `planPipelines`: it reads
 *    only `id` / `cardId` / `nodeId` / `start` / `end` on `tracks[].clips[]`, ignoring all other
 *    fields.
 *
 * # How `device` is selected
 *
 * `costs` is deduplicated by `(identityKey, device)`, but the prerender process **does not know
 * the `device` string of that editor machine** (it is probed on the page side: GPU, core count,
 * single stage, `offscreenGl`, two `tuning` items …).
 * Here it takes the entry with the latest `measuredAt` for the `identityKey`: there is usually only
 * one on the same machine; if there are indeed two (e.g. offline probe and resident probe each
 * wrote one), the most recent measurement is more trustworthy.
 * **This is an addition in this implementation relative to the task brief** (the task brief did
 * not specify how this side selects device); see report.
 */
import { loadCosts, loadTuning } from './costs-store.mjs';
import { planPipelines } from '../src/render/pipelinePlan.mjs';
import { activeCutKind } from '../src/kernel/camera.mjs';

/** Whether a card (control / review table capabilities) enters the prerender set when there is **no dispatch table** */
export function declaredHeavy(capabilities) {
  const caps = capabilities ?? {};
  if (caps.frameMode === 'direct') return false;
  return caps.frameMode === 'stateful' || caps.need_prerendering === true || caps.needPrerendering === true;
}

/** When the same `identityKey` has multiple entries (multiple devices), takes the one with the latest `measuredAt` */
export function pickLatestCosts(costs) {
  const byKey = new Map();
  for (const record of costs ?? []) {
    if (!record || typeof record.identityKey !== 'string') continue;
    const old = byKey.get(record.identityKey);
    if (!old || (Number(record.measuredAt) || 0) >= (Number(old.measuredAt) || 0)) byKey.set(record.identityKey, record);
  }
  return [...byKey.values()];
}

/** controls → synthetic project fed to `planPipelines` + two indexes */
export function planInputsOfControls(controls, fps, cardIdOf = () => undefined) {
  const clips = [];
  const identityKeys = {};
  const frameModes = {};
  for (const control of controls ?? []) {
    const clipId = control?.clipId;
    if (!clipId) continue;
    const start = Number(control.start), end = Number(control.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const cardId = control.cardId ?? cardIdOf(clipId);
    clips.push({ id: clipId, cardId, nodeId: control.nodeId ?? clipId, start, end, ...(control.in3dCut === true ? { in3dCut: true } : null) });
    if (typeof control.costKey === 'string') identityKeys[clipId] = control.costKey;
    const mode = control.frameMode ?? control.capabilities?.frameMode;
    if (typeof mode === 'string') frameModes[clipId] = mode;
  }
  return { project: { fps, tracks: [{ id: 'plan', clips }] }, identityKeys, frameModes };
}

/**
 * Prerender set when a card plan (`plan()` in `card-cache.mjs`) is in hand: the prerender process
 * takes this path.
 *
 * @param {any[]} controls card plan
 * @param {object} [opts] `fps`, `costs` / `tuning` (reads from disk via `root` if omitted), `root`
 */
export function prerenderSetOfPlan(controls, opts = {}) {
  const list = controls ?? [];
  const fps = Number(opts.fps) || Number(list[0]?.sampling?.fps?.numerator) / Number(list[0]?.sampling?.fps?.denominator) || 30;
  const root = opts.root;
  const costs = opts.costs ?? (root ? loadCosts(root) : null);

  const mirror = typeof globalThis !== 'undefined' ? (globalThis.__PC_LATEST_MIRROR__?.() ?? null) : null;
  const mirrorClips = (mirror?.project?.tracks ?? opts.project?.tracks ?? []).flatMap((t) => t?.clips ?? []) ?? [];
  const cardIdOf = (clipId) => {
    return mirrorClips.find((c) => c?.id === clipId)?.cardId;
  };

  const hasScene3d = mirrorClips.some((c) => c?.cardId === 'scene-3d')
    || list.some((c) => c?.cardId === 'scene-3d' || c?.definitionId === 'scene-3d' || c?.definitionId === 'def:scene-3d' || cardIdOf(c?.clipId) === 'scene-3d');
  const is3DCut = opts.cutKind === '3d' || opts.project?.cutKind === '3d' || activeCutKind(opts.project) === '3d' || activeCutKind(mirror?.project) === '3d';
  const for3D = Boolean(opts.includeLightCardsFor3D || opts.view3d || is3DCut || (opts.includeLightCardsFor3D !== false && hasScene3d));

  // If there are no records at all (not yet probed / cannot read from disk), falls back to declarations: consistent with behavior before connecting planPipelines
  if (!costs || !costs.length) {
    const set = new Set();
    for (const control of list) {
      if (!control?.clipId) continue;
      const cardId = control.cardId ?? cardIdOf(control.clipId);
      if (declaredHeavy(control.capabilities)) set.add(control.clipId);
      else if ((for3D || control.in3dCut === true) && cardId !== 'scene-3d') {
        const comp = control.compositing ?? control.capabilities?.compositing ?? 'independent';
        if (comp === 'independent') set.add(control.clipId);
      }
    }
    return set;
  }
  const tuning = opts.tuning ?? (root ? loadTuning(root) : null);
  const { project, identityKeys, frameModes } = planInputsOfControls(list, fps, cardIdOf);
  return planPipelines(project, pickLatestCosts(costs), fps, {
    tuning, identityKeys, frameModes,
    cutKind: is3DCut ? '3d' : opts.cutKind,
    includeLightCardsFor3D: for3D,
    view3d: opts.view3d,
    capabilities: opts.capabilities ?? Object.fromEntries(list.map((c) => [c.clipId, c.capabilities])),
    compositing: opts.compositing,
    isIndependent: opts.isIndependent,
  }).prerenderSet;
}

/**
 * `prerenderSetOf(project, costs, fps)`: used when holding a **project** rather than a card plan
 * (end-to-end probe, unit tests). `capabilitiesOf` is only used when there are no records at all
 * (falls back to declarations).
 */
export function prerenderSetOf(project, costs = null, fps = Number(project?.fps) || 30, capabilitiesOf = () => undefined, opts = {}) {
  const controls = [];
  for (const track of project?.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      if (!clip?.id || !(clip.cardId || clip.nodeId)) continue;
      controls.push({
        clipId: clip.id, cardId: clip.cardId, nodeId: clip.nodeId ?? clip.id, start: clip.start, end: clip.end,
        ...(clip.flat?.in3dCut === true || clip.in3dCut === true ? { in3dCut: true } : null),
        costKey: opts.identityKeys?.[clip.id],
        capabilities: capabilitiesOf(clip) ?? { frameMode: clip.mode },
        frameMode: opts.frameModes?.[clip.id],
      });
    }
  }
  return prerenderSetOfPlan(controls, {
    fps, costs, tuning: opts.tuning, root: opts.root, project,
    cutKind: opts.cutKind,
    includeLightCardsFor3D: opts.includeLightCardsFor3D ?? opts.view3d,
    view3d: opts.view3d,
    capabilities: opts.capabilities,
    compositing: opts.compositing,
    isIndependent: opts.isIndependent,
  });
}
