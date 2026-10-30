// 本文件导出的内部可变状态与写入原语(state、listeners、history、future、emit、set、
// setProject 以及各个纯函数辅助)只给 src/store/actions 用,属于包内可见性;
// 外部一律走 project.ts —— 它只转出 EditorState / planPlacement / getState /
// subscribe / useStore / actions 这几个公开名字。
import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import { createEmptyProject, type Project, type Track, type TrackClip } from "../kernel/project";
import { type Transition } from "../kernel/transitions";
import { cutEditView, foldCutEdit } from "../kernel/cuts";

/**
 * 编辑器状态存储(单例)。所有面板、时间轴、MCP 工具都通过这里读写,不直接改 Project 对象。
 * 用法:const project = useStore(s => s.project);  actions.addClip(...)
 * 每个 action 都是同步的、产生新对象(不可变更新),方便撤销和 React 重渲染。
 */

export interface EditorState {
  /** Changes only when a project is opened/replaced; async jobs must not survive reopening. */
  projectLoadToken: number;
  project: Project;
  /** 播放头(秒) */
  t: number;
  playing: boolean;
  /** 每次 seek/重播 +1,Stage 用它重新挂载卡片 */
  playToken: number;
  /** 选中的 clip id(可多选,第一个是主选) */
  selection: string[];
  /** 项目文件路径(未保存为 null) */
  filePath: string | null;
  dirty: boolean;
  /** 用户手动拖范围卡标设定的总时长，没设过就是 null */
  durationManual: number | null;
  /**
   * 上一次用过的三维视角。关掉三维(camera3dFov 被抹掉)时记在这儿,再打开就回到那个值。
   *
   * **不落盘**:存盘结果要和从没开过三维一样。放在 store 而不是模块变量,是因为模块变量
   * 跨项目存活 —— A 项目调过 60、关掉,再打开一个从没开过三维的 B 项目,B 会莫名其妙拿到 60。
   * 挂在这儿,loadProject 顺手清掉就干净了。
   */
  lastCamera3dFov: number | null;
  /** 预览总音量 0–1(只影响预览,不写进项目;导出由 ffmpeg 合成原音) */
  volume: number;
  /** 预览静音开关,和 volume 分开记,取消静音能回到原音量 */
  muted: boolean;
}

type Listener = () => void;

/** 预览音量记在本机,跟项目无关 */
export const VOLUME_KEY = "pc.volume";
export function readVolume(): number {
  try {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY) ?? "");
    if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
  } catch {}
  return 0.7;
}

export let state: EditorState = {
  projectLoadToken: 0,
  project: createEmptyProject(),
  t: 0,
  playing: false,
  playToken: 1,
  selection: [],
  filePath: null,
  dirty: false,
  durationManual: null,
  lastCamera3dFov: null,
  volume: readVolume(),
  muted: false,
};
export const listeners = new Set<Listener>();
export const history: Project[] = [];
export const future: Project[] = [];

export function emit() {
  for (const l of listeners) l();
}

export function set(patch: Partial<EditorState>) {
  if (cutScope) { outsideCutScope(() => set(patch)); return; }
  state = { ...state, ...patch };
  emit();
}

/*
 * 就地改停放剪辑里的片段(Agent 的 update_clip 等,见 kernel/cuts.ts「就地改停放剪辑里的片段」)。
 *
 * `runInCutScope(cutId, fn)` 在 fn 执行期间把 `state.project` 换成「那条剪辑当激活」的视图,
 * 让现成的、按激活剪辑写的 actions(`findClip(state.project, …)` + `setProject`)原样工作;
 * 这期间 `setProject` 把动作产出的新项目折回真实形状再提交(撤销栈、文档服务同步看到的都是真实形状,
 * 只有那条剪辑条目里的内容变了,activeCutId 与激活剪辑原样不动),`set` 通知监听者时也先换回真实项目 ——
 * 所以任何监听者、同步层都看不到视图。fn 必须是同步的。
 */
let cutScope: { cutId: string; real: Project } | null = null;

/** 在 scope 里要往外办事(提交、通知监听者)时:先换回真实项目、办完把视图按办完后的真实项目重建 */
function outsideCutScope<T>(fn: () => T): T {
  const sc = cutScope!;
  cutScope = null;
  state = { ...state, project: sc.real };
  try {
    return fn();
  } finally {
    sc.real = state.project;
    const view = cutEditView(sc.real, sc.cutId);
    if (view) {
      state = { ...state, project: view };
      cutScope = sc;
    }
  }
}

export function runInCutScope<T>(cutId: string, fn: () => T): T {
  if (cutScope) {
    if (cutScope.cutId !== cutId) throw new Error("不能在改一条剪辑的过程中嵌套改另一条");
    return fn();
  }
  const real = state.project;
  const view = cutEditView(real, cutId);
  if (!view) return fn(); // 就是激活那条、或找不到:照常做
  cutScope = { cutId, real };
  state = { ...state, project: view };
  let out: T;
  try {
    out = fn();
  } finally {
    const sc = cutScope as { cutId: string; real: Project } | null;
    cutScope = null;
    if (sc) state = { ...state, project: sc.real };
  }
  if (out && typeof (out as { then?: unknown }).then === "function") {
    throw new Error("runInCutScope 只能包同步函数(异步的后半段已经不在这条剪辑的视图里了)");
  }
  return out;
}

export interface SetProjectOptions {
  /** false:不进撤销栈 */
  undoable?: boolean;
  /**
   * 同一个 key、合并窗口内的连续修改合并成撤销栈上的一步(滑块一次拖动、数字框连续步进)。
   * 不传就和以前一样,每次一步。没传时取 `withMerge` 圈出的那一个。
   */
  mergeKey?: string;
  /** 合并窗口(毫秒,以上一次合并为准往后滚);不传取 `MERGE_WINDOW_MS`。`Infinity` = 只认 key、不看时间(一次拖动的 key 是独一份的) */
  mergeWindowMs?: number;
}

/**
 * 连上文档服务时接管项目写入与撤销的一方(docsync.ts 的 bindStore 装上)。
 * 没装时(缺省)一切照旧:整份替换 + history / future 快照栈。
 * 两种模式对 actions 与界面的接口一样:setProject / undo / redo / canUndo / canRedo。
 */
export interface ProjectSyncHooks {
  /** 本地改成 next;返回真正落地的那一份(键的顺序可能与 next 不同,内容相同) */
  commit(prev: Project, next: Project, opts: SetProjectOptions): Project;
  /** 整份换成另一份内容(打开 .proc 等);返回落地的那一份 */
  load(project: Project): Project;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** 等所有本地修改都拿到文档服务的确认(.proc 保存前等它);没接文档服务时没有这一项 */
  whenSettled?(opts?: { timeoutMs?: number }): Promise<{ rev: number; project: Project }>;
}

let projectSync: ProjectSyncHooks | null = null;

export function attachProjectSync(hooks: ProjectSyncHooks | null) {
  projectSync = hooks;
}

export function getProjectSync(): ProjectSyncHooks | null {
  return projectSync;
}

/** 快照栈模式下的合并判据:上一次带 mergeKey 的修改,以及它落地后的那一份项目 */
let lastMerge: { key: string; at: number; project: Project } | null = null;
export const MERGE_WINDOW_MS = 300;

/**
 * 把 `fn` 里发生的项目修改都归到同一个 mergeKey 下:界面上的滑块拖动、数字框步进靠它,
 * 不必给每个 action 都多长一个参数。同步执行;嵌套时里层覆盖外层,出来后还原。
 */
let ambientMerge: { key: string; windowMs?: number } | null = null;
export function withMerge<T>(merge: { key: string; windowMs?: number }, fn: () => T): T {
  const outer = ambientMerge;
  ambientMerge = merge;
  try { return fn(); } finally { ambientMerge = outer; }
}

/**
 * 本页面自己的修改(经 setProject 落地的;远端来的改动、撤销 / 重做不经这里)。
 * 「用户正在编辑」(src/editor/userEditing.ts)据此判「选中的片段刚被用户动过」。
 */
type LocalCommitListener = (prev: Project, next: Project) => void;
const localCommitListeners = new Set<LocalCommitListener>();

export function onLocalCommit(fn: LocalCommitListener): () => void {
  localCommitListeners.add(fn);
  return () => { localCommitListeners.delete(fn); };
}

function noteLocalCommit(prev: Project, next: Project) {
  if (prev === next) return;
  for (const fn of localCommitListeners) {
    try { fn(prev, next); } catch { /* 旁听的出错不影响修改 */ }
  }
}

/** 改项目文档(会进撤销栈) */
export function setProject(next: Project, opts: SetProjectOptions = {}) {
  if (cutScope) {
    if (next === state.project) return; // 视图原样提交 = 没改,不凭空产出一份新项目
    const folded = foldCutEdit(cutScope.real, next, cutScope.cutId);
    outsideCutScope(() => setProject(folded, opts));
    return;
  }
  if (ambientMerge && opts.mergeKey === undefined) opts = { ...opts, mergeKey: ambientMerge.key, mergeWindowMs: opts.mergeWindowMs ?? ambientMerge.windowMs };
  const prev = state.project;
  if (projectSync) {
    const landed = projectSync.commit(state.project, next, opts);
    set({ project: landed, dirty: true });
    noteLocalCommit(prev, landed);
    return;
  }
  if (opts.undoable !== false) {
    const now = Date.now();
    // 同一个数字框的连续输入:上一步就是它、中间没有别的修改、300 ms 内 → 不另起一步
    const merge = !!opts.mergeKey && lastMerge !== null && lastMerge.key === opts.mergeKey && lastMerge.project === state.project && now - lastMerge.at <= (opts.mergeWindowMs ?? MERGE_WINDOW_MS) && history.length > 0;
    if (!merge) {
      history.push(state.project);
      if (history.length > 100) history.shift();
    }
    future.length = 0;
    lastMerge = opts.mergeKey ? { key: opts.mergeKey, at: now, project: next } : null;
  }
  set({ project: next, dirty: true });
  noteLocalCommit(prev, next);
}

/** 把一条转场写下的淡化擦掉(片段可能已经不在了,擦不到就跳过) */
export function clearTransitionFades(p: Project, tr: Transition): Project {
  const clear = (clipId: string | undefined, side: "fadeIn" | "fadeOut") => {
    if (!clipId) return;
    p = {
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? { ...c, [side]: 0 } : c)),
      })),
    };
  };
  if (tr.kind === "crossfade") {
    clear(tr.aId, "fadeOut");
    clear(tr.bId, "fadeIn");
  } else {
    clear(tr.aId, tr.kind === "fadeIn" ? "fadeIn" : "fadeOut");
  }
  return p;
}

export function updateTrack(p: Project, trackId: string, fn: (t: Track) => Track): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? fn(t) : t)) };
}

/**
 * 删片段 / 删序列之后剔掉没人要的素材效果卡节点。
 *
 * cardNodes 的写入方只有 cardAuthoring,片段是它唯一的入口,所以判据就是
 * 「从还在的片段出发走不走得到」。走不到的、以及输入指着已删片段那个合成源
 * (`@clip/<id>/source`)的,连同它的下游一起剔掉 —— 留着的话 projectCardGraph
 * 每次都要靠丢边规则兜,而那条规则是留给「图已经存盘」的旧项目的。
 */
export function pruneCardNodes(p: Project): Project {
  const nodes = p.cardNodes;
  if (!nodes?.length) return p;
  const clips = p.tracks.flatMap((t) => t.clips);
  const liveClipIds = new Set(clips.map((c) => c.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const refsOf = (n: (typeof nodes)[number]) =>
    Object.values(n.inputs ?? {}).map((r) => (typeof r === "string" ? r : r?.nodeId)).filter((x): x is string => !!x);
  const keep = new Set<string>();
  const walk = (id?: string) => {
    if (!id || keep.has(id) || !byId.has(id)) return;
    keep.add(id);
    for (const ref of refsOf(byId.get(id)!)) walk(ref);
  };
  for (const clip of clips) walk(clip.nodeId);
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of [...keep]) {
      const dangling = refsOf(byId.get(id)!).some((ref) => {
        if (ref.startsWith("@clip/")) {
          const owner = /^@clip\/(.+)\/[^/]+$/.exec(ref);
          return !owner || !liveClipIds.has(owner[1]);
        }
        return !keep.has(ref);
      });
      if (dangling) { keep.delete(id); changed = true; }
    }
  }
  if (keep.size === nodes.length) return p;
  const next: Project = { ...p, cardNodes: nodes.filter((n) => keep.has(n.id)) };
  if (!clips.some((c) => c.nodeId && !keep.has(c.nodeId))) return next;
  // 节点没了的片段把 nodeId 一并擦掉:留着就是一个指向不存在节点的引用
  return { ...next, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => {
    if (!c.nodeId || keep.has(c.nodeId)) return c;
    const { nodeId: _gone, ...rest } = c;
    return rest;
  }) })) };
}

/**
 * 把一组片段整体平移 dt 秒。轨内不能重叠、不能被推到 0 之前 —— 有一处放不下就整组不动
 * (返回 null),不做「挪一半」这种半吊子结果。组内的相对关系原样保留,所以转场不会散。
 */
export function shiftClipsBy(p: Project, ids: string[], dt: number): Project | null {
  const set = new Set(ids);
  let found = 0;
  const tracks = p.tracks.map((t) => ({
    ...t,
    clips: sortClips(
      t.clips.map((c) => {
        if (!set.has(c.id)) return c;
        found++;
        return { ...c, start: c.start + dt, end: c.end + dt };
      }),
    ),
  }));
  if (found !== set.size) return null;
  for (const t of tracks) {
    for (let i = 0; i < t.clips.length; i++) {
      if (t.clips[i].start < -1e-6) return null;
      if (i > 0 && t.clips[i].start < t.clips[i - 1].end - 1e-6) return null;
    }
  }
  return { ...p, tracks };
}

export function sortClips(clips: TrackClip[]): TrackClip[] {
  return [...clips].sort((a, b) => a.start - b.start);
}

/**
 * 轨内不重叠:把 clip 夹到相邻 clip 之间,时长不变。
 * 空档放不下整段时返回 null(调用方拒绝这次移动),不再把 clip 压扁。
 */
export function resolveOverlap(track: Track, clip: TrackClip): TrackClip | null {
  const others = track.clips.filter((c) => c.id !== clip.id);
  let { start, end } = clip;
  const len = Math.max(0.1, end - start);
  const mid = start + len / 2;
  const prev = others.filter((c) => c.end <= mid).sort((a, b) => b.end - a.end)[0];
  const next = others.filter((c) => c.start >= mid).sort((a, b) => a.start - b.start)[0];
  const lo = prev ? prev.end : 0;
  const hi = next ? next.start : Infinity;
  if (hi - lo < len - 1e-6) return null;
  start = Math.max(lo, Math.min(start, hi - len));
  end = start + len;
  return { ...clip, start: Math.max(0, start), end };
}

/** 新增用:原位放不下就往后找第一个放得下的空档(时长不变)。 */
export function placeOrShift(track: Track, clip: TrackClip): TrackClip {
  const fit = resolveOverlap(track, clip);
  if (fit) return fit;
  const len = Math.max(0.1, clip.end - clip.start);
  const sorted = [...track.clips].filter((c) => c.id !== clip.id).sort((a, b) => a.start - b.start);
  let cursor = clip.start;
  for (const c of sorted) {
    if (c.end <= cursor) continue;
    if (c.start - cursor >= len) break;
    cursor = Math.max(cursor, c.end);
  }
  return { ...clip, start: cursor, end: cursor + len };
}

/**
 * 落点预演:用和落卡完全相同的规则算一遍新片段会落在哪,但不改文档。
 * 时间轴的落点预览用它,保证「拖动时看到的位置」和松手后真正落下的位置一致。
 * shifted = 原位放不下、被顺延到了后面的空档。
 */
export function planPlacement(track: Track, start: number, dur: number): { start: number; end: number; shifted: boolean } {
  const from = Math.max(0, start);
  const probe: TrackClip = { id: "__probe", cardId: "", start: from, end: from + dur, params: {} };
  const placed = placeOrShift(track, probe);
  return { start: placed.start, end: placed.end, shifted: Math.abs(placed.start - from) > 1e-6 };
}

/**
 * 不指定序列时该落在哪条:挑第一条这个时间段空着的序列(序列不分种类了,所以只看占没占)。
 * 都放不下就用第一条没锁的,由 placeOrShift 往后顺延。
 */
export function pickTrack(p: Project, start: number, dur: number): Track | undefined {
  const free = p.tracks.find(
    (t) => !t.locked && !t.clips.some((c) => Math.max(start, c.start) < Math.min(start + dur, c.end)),
  );
  return free ?? p.tracks.find((t) => !t.locked) ?? p.tracks[0];
}


;

export function getState(): EditorState {
  return state;
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * 「这棵子树此刻看不见,先别跟 store 的更新」。停靠栏里没选中、或所在一侧收起着的分区页
 * (`DockPages` 给每个分区包一层)在 `true` 下:`useStore` 不订阅、一直回上一次看得见时读到的值,
 * 项目每变一次(挪片段、改参数)也不重渲;重新露出来的那一次提交里按当时的 store 重读,
 * 和一直跟着的结果一样。
 *
 * 为什么要有它(tiers-probe T4,docs/archive/agent-reports/AGENT-perf-t4.md):分区页常驻挂载、只是 display:none,
 * 以前每次编辑都把看不见的特效库、节点图、字幕列表整棵重渲一遍,和看得见的时间轴、预览挤在同一个
 * 同步任务里(useSyncExternalStore 的更新不能切片),后台转码、上传一抢 CPU 就超过 50 ms。
 */
const StoreHoldContext = createContext(false);
export const StoreHold = StoreHoldContext.Provider;
const holdSubscribe = () => () => {};

export function useStore<T>(selector: (s: EditorState) => T): T {
  const held = useContext(StoreHoldContext);
  const last = useRef<{ value: T } | null>(null);
  // 刚挂上就是看不见的(last 还没有值)照常读一次;之后看不见期间一直回上一次的值
  const read = () => (held && last.current ? last.current.value : selector(state));
  const value = useSyncExternalStore(held ? holdSubscribe : subscribe, read, read);
  last.current = { value };
  return value;
}
/** The UI owns project-opening policy; the store only calls its registered hook. */
let projectLoader: ((project: Project) => Project) | null = null;
export function setProjectLoader(loader: (project: Project) => Project) { projectLoader = loader; }
export function getProjectLoader() { return projectLoader; }
