/** 每个控件的快照走哪一档:`none` 不存、`shared` 共享档(可推可拉)、`local` 本地档。 */
export type SnapshotTier = 'none' | 'shared' | 'local';

/** `snapshotTier` 读的能力对象:审阅表的 capabilities(`src/kernel/frameMode.mjs` 的 `cardCapabilities`)或 `cardGraph` 给合成节点写的那一份 */
export type SnapshotTierCapabilities = {
  frameMode?: string;
  need_prerendering?: boolean;
  needPrerendering?: boolean;
  compositing?: string;
  canvasHeavy?: boolean;
  independentCache?: boolean;
} | null | undefined;

/** 判「这张卡存不存快照、存哪一档」的唯一实现;页面一侧(`src/` 下)直接 import 它,不另写一份。 */
export function snapshotTier(capabilities?: SnapshotTierCapabilities): SnapshotTier;
