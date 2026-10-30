/**
 * 预渲染集合 `plan.prerenderSet`(pinned 渲染 9)。
 *
 * **两端同一份纯函数**:`src/render/pipelinePlan.mjs` 的 `planPipelines` 按 K1 的实测成本
 * 贪心分派,**任一位置判重的卡的并集**就是预渲染集合。页面按它决定每拍怎么渲,
 * 预渲染进程按它决定预渲染哪些卡 —— 两端不交换分派表,**只同步 `costs` 和 `tuning`**
 * (K2 末条),所以同一份输入必须在两端算出逐字段相同的表。
 *
 * # 预渲染进程这一端的三样输入从哪来
 *
 * 1. **`costs` / `tuning`**:`vite-plugin-costs` 两个进程都挂,编辑器进程每次 PUT 之后
 *    把**同一份**原样转过来(`forwardToPrerender`),这边就地落自己那一份;
 *    `loadCosts(root)` / `loadTuning(root)` 读盘。
 * 2. **clipId → `cardCostKey`**:`card-cache.mjs` 的 `plan()` 在算 `snapshotKey` 的同一处
 *    顺手算了 `costKey`(那里才有 graph 的节点和 `sourceVersions`),口径逐字对齐页面侧的
 *    `clipCostIndex`。
 * 3. **分段用的片段表**:controls 自带 `clipId` / `start` / `end`,拼成一份只有这三项的
 *    合成项目喂给 `planPipelines` —— 它只读 `tracks[].clips[]` 的
 *    `id` / `cardId` / `nodeId` / `start` / `end`,别的字段一概不看。
 *
 * # `device` 怎么挑
 *
 * `costs` 按 `(identityKey, device)` 去重,而预渲染进程**不知道编辑器那台机器的 `device` 串**
 * (它是页面侧探测出来的:GPU、核数、只有一个舞台、`offscreenGl`、`tuning` 的两项……)。
 * 这里按 `identityKey` 取 `measuredAt` 最新的那一条 —— 同一台机器上通常只有一条;
 * 真有两条(比如离线探针和常驻探针各写了一份)时,最近一次实测更可信。
 * **这是本实现相对任务书的一处补齐**(任务书没写这一端怎么挑 device),见报告。
 */
import { loadCosts, loadTuning } from './costs-store.mjs';
import { planPipelines } from '../src/render/pipelinePlan.mjs';

/** 一张卡(control / 审阅表 capabilities)在**没有分派表**时要不要进预渲染集合 */
export function declaredHeavy(capabilities) {
  const caps = capabilities ?? {};
  if (caps.frameMode === 'direct') return false;
  return caps.frameMode === 'stateful' || caps.need_prerendering === true || caps.needPrerendering === true;
}

/** 同一个 `identityKey` 有多条(多台 device)时取 `measuredAt` 最新的那一条 */
export function pickLatestCosts(costs) {
  const byKey = new Map();
  for (const record of costs ?? []) {
    if (!record || typeof record.identityKey !== 'string') continue;
    const old = byKey.get(record.identityKey);
    if (!old || (Number(record.measuredAt) || 0) >= (Number(old.measuredAt) || 0)) byKey.set(record.identityKey, record);
  }
  return [...byKey.values()];
}

/** controls → 喂给 `planPipelines` 的合成项目 + 两张索引 */
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
    clips.push({ id: clipId, cardId, nodeId: control.nodeId ?? clipId, start, end });
    if (typeof control.costKey === 'string') identityKeys[clipId] = control.costKey;
    const mode = control.frameMode ?? control.capabilities?.frameMode;
    if (typeof mode === 'string') frameModes[clipId] = mode;
  }
  return { project: { fps, tracks: [{ id: 'plan', clips }] }, identityKeys, frameModes };
}

/**
 * card plan(`card-cache.mjs` 的 `plan()`)在手时的预渲染集合 —— 预渲染进程走这条。
 *
 * @param {any[]} controls card plan
 * @param {object} [opts] `fps`、`costs` / `tuning`(不给就从 `root` 读盘)、`root`
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
  const for3D = Boolean(opts.includeLightCardsFor3D || opts.view3d || (opts.includeLightCardsFor3D !== false && hasScene3d));

  // 一条记录都没有(还没探针过 / 读不到盘)就按声明兜底:和接上 planPipelines 之前的行为一致
  if (!costs || !costs.length) {
    const set = new Set();
    for (const control of list) {
      if (!control?.clipId) continue;
      const cardId = control.cardId ?? cardIdOf(control.clipId);
      if (declaredHeavy(control.capabilities)) set.add(control.clipId);
      else if (for3D && cardId !== 'scene-3d') {
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
    includeLightCardsFor3D: for3D,
    view3d: opts.view3d ?? (for3D ? true : undefined),
    capabilities: opts.capabilities ?? Object.fromEntries(list.map((c) => [c.clipId, c.capabilities])),
    compositing: opts.compositing,
    isIndependent: opts.isIndependent,
  }).prerenderSet;
}

/**
 * `prerenderSetOf(project, costs, fps)` —— 手里是**项目**而不是 card plan 时用
 * (端到端探针、单测)。`capabilitiesOf` 只在一条记录都没有时用得上(按声明兜底)。
 */
export function prerenderSetOf(project, costs = null, fps = Number(project?.fps) || 30, capabilitiesOf = () => undefined, opts = {}) {
  const controls = [];
  for (const track of project?.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      if (!clip?.id || !(clip.cardId || clip.nodeId)) continue;
      controls.push({
        clipId: clip.id, cardId: clip.cardId, nodeId: clip.nodeId ?? clip.id, start: clip.start, end: clip.end,
        costKey: opts.identityKeys?.[clip.id],
        capabilities: capabilitiesOf(clip) ?? { frameMode: clip.mode },
        frameMode: opts.frameModes?.[clip.id],
      });
    }
  }
  return prerenderSetOfPlan(controls, {
    fps, costs, tuning: opts.tuning, root: opts.root,
    includeLightCardsFor3D: opts.includeLightCardsFor3D ?? opts.view3d,
    view3d: opts.view3d,
    capabilities: opts.capabilities,
    compositing: opts.compositing,
    isIndependent: opts.isIndependent,
  });
}
