import type { Project, Track, TrackClip } from "../kernel/project";

/** 顶层按引用比的字段表(和 frameClient 的 signature 同一组) */
export const TOP_FIELDS: readonly string[];

/** 一条轨道上的一段变化;`clip: null` = 这一段被删掉了 */
export interface ClipPatch {
  id: string;
  clip: TrackClip | null;
}

/** 一条轨道的变化 */
export interface TrackPatch {
  id: string;
  /** 整条轨道换新(新增的轨道)。给了它就忽略下面三项 */
  track?: Track;
  /** 轨道自身属性(`clips` 以外的全部自有键),任一项变了就整组给 */
  props?: Record<string, unknown>;
  /** 逐片段增量 */
  clips?: ClipPatch[];
  /** 片段 id 的新顺序;顺序或集合变了才有 */
  clipOrder?: string[];
}

/**
 * 两份项目之间的补丁。将来舞台 RPC 的 `setProject(patch)` 收的就是它。
 *
 * - `kind: "full"` —— 整份项目。`tracks` 以外任一顶层字段变了、或者没有基线时是这个。
 * - `kind: "tracks"` —— 只有轨道变了。`order` 是轨道 id 的新顺序(为 `null` 表示
 *   轨道的集合和顺序都没变;不为 `null` 时**不在里面的轨道就是被删掉的**),
 *   `tracks` 是逐轨道的增量。
 */
export type ProjectPatch =
  | { kind: "full"; project: Project }
  | { kind: "tracks"; order: string[] | null; tracks: TrackPatch[] };

export function hashString(s: string): string;
/** 项目的渲染身份哈希(只覆盖 TOP_FIELDS),三级 WeakMap 缓存 */
export function projectHash(project: Project): string;
/** 重算次数快照(缓存未命中计数),测试用 */
export function hashStats(): { fields: number; tracks: number; clips: number; values: number };
export function resetHashStats(): void;
/** 两层 diff */
export function changedClips(prev: Project | null | undefined, next: Project): ProjectPatch;
/** 补丁里没有任何改动? */
export function isEmptyPatch(patch: ProjectPatch | null | undefined): boolean;
/** 应用补丁,返回新项目;对不上就抛 */
export function applyProjectPatch(project: Project, patch: ProjectPatch): Project;
