/**
 * 占位平面的**舞台一侧**(product/rendering.md「兜底顺序」;接口见 `placeholder/contract.ts`)。
 *
 * 管四件事,都不碰 React、不 import 占位组件本身(组件由 `Stage.tsx` 引;B 交付后只换那一行 import):
 *
 *   1. **挂不挂**:只有人看的预览(舞台页、`front` 角色)挂。导出页、预渲染、Agent 的查询渲染从不调
 *      `setPlaceholdersEnabled(true)`;`StageView` 在 `setRole('back')` 时关掉。关着时 `Stage` 一个节点都不渲、
 *      样式表也不注入 —— 导出像素基线不受影响。
 *   2. **显示谁**(`placeholderWanted`,纯函数):T1 兜底链尽头(被抑制、这一拍流 blank、又没挂快照)、
 *      T2 `.pc-awaiting`(快照还没到、这一拍流也没在画)、T3 `.pc-settling` 且没挂快照(不可见地追帧)、
 *      T4 等后台补跑互换的轻卡(被抑制、分派表说它这一刻是轻卡);在线浏览器模式下这台设备跑不了的卡
 *      (用户卡、素材效果卡)没有可贴的快照 / 流时一律是沙漏 `awaiting`,等渲染节点的结果到了换上
 *      (2026-10-21 用户定:没有「本地 PC 辅助渲染」这种情况)。
 *   3. **显隐**:`StageView` 每拍 / 每次平面提交之后按上面的结果只用 contract 的 `setPlaceholderShown`
 *      切槽位的 `hidden`,不经 React 提交(`applyPlaceholders`)。满 120 ms 才可见由占位组件的 CSS 负责。
 *   4. **几何**(`geometryFor`):流清单的实体框(`tight ?? bound`)→ 这张卡上次活渲时量到的墨迹框 →
 *      都没有就在位置框中心只放一个小沙漏徽标(`badge`,不铺噪点)。坐标一律相对包裹层、舞台像素。
 *
 * # 槽位
 *
 * `Stage` 在每张卡的包裹层里挂一个 `[data-pc-placeholder-slot]`(和快照 / 流平面同级,`position:absolute;
 * inset:0`,默认 `hidden`),占位组件渲在槽位里面。显隐切的是槽位的 `hidden`:contract 没规定组件根元素的
 * 初始显隐,而组件又是无状态的纯渲染 —— 由槽位托着,React 每次提交都不会把手动切过的 `hidden` 冲掉
 * (prop 一直是 `true`,React 不会重写它)。截图、墨迹采样、像素扫描、命中测试对槽位和组件根元素
 * 一视同仁(`isPlaceholderNode`)。
 */
import {
  PLACEHOLDER_ATTR, PLACEHOLDER_SLOT_ATTR, PLACEHOLDER_STATIC_ATTR, setPlaceholderShown,
  type PlaceholderBox, type PlaceholderGeometry, type PlaceholderReason,
} from "./placeholder/contract.ts";
import { cardRunnableHere, getCard, graphCardsRunnableHere, isUserCardId } from "../kernel/registry.ts";
import { hourglassFit, type PlaceholderFit } from "./placeholderFit.ts";

/** 包裹层里托着占位组件的槽位(常量在 contract 里,这里转出去给已有的引用方) */
export { PLACEHOLDER_SLOT_ATTR };
/** 槽位或组件根元素 —— 排除 / 命中都按它 */
export const PLACEHOLDER_SELECTOR = `[${PLACEHOLDER_SLOT_ATTR}],[${PLACEHOLDER_ATTR}]`;

/** 这个节点是不是占位符的一部分(槽位、组件根元素或它们里面的东西) */
export function isPlaceholderNode(el: Element | null | undefined): boolean {
  return !!el && typeof el.closest === "function" && !!el.closest(PLACEHOLDER_SELECTOR);
}

/* ------------------------------------------------------------------ 1. 挂不挂 */

let enabled = false;

/** 只有 `StageView`(舞台页、`front` 角色)会打开。缺省关:导出页 / 预渲染 / 后台舞台一个节点都没有 */
export function setPlaceholdersEnabled(on: boolean): void {
  enabled = !!on;
}

export function placeholdersEnabled(): boolean {
  return enabled;
}

let styleEl: HTMLStyleElement | null = null;
/** 占位组件的整张样式表,打开时注入一次(导出页永远走不到这里) */
export function ensurePlaceholderStyle(css: string): void {
  if (styleEl || typeof document === "undefined" || !css) return;
  styleEl = document.createElement("style");
  styleEl.dataset.pcPlaceholder = "1";
  styleEl.textContent = css;
  document.head.appendChild(styleEl);
}

/**
 * 摘掉样式表(`setRole('back')`):K5 互换之后这一台成了后台舞台,
 * 「后台舞台不注入占位样式」要对它也成立。再转正时 `Stage` 会重新注入。
 */
export function removePlaceholderStyle(): void {
  styleEl?.remove();
  styleEl = null;
}

/* ------------------------------------------------------------------ 2. 显示谁 */

export interface PlaceholderState {
  /** 播放中被抑制的卡(判重 + K3(b) 的额外抑制) */
  suppressed: ReadonlySet<string>;
  /** 此刻挂着快照平面的卡 */
  snapshots: ReadonlyMap<string, unknown> | ReadonlySet<string>;
  /** `.pc-awaiting`:这一帧的快照还没到 */
  awaiting: ReadonlySet<string>;
  /** `.pc-settling`:正在不可见地追帧 */
  settling: ReadonlyMap<string, unknown>;
  /** 这一拍流画面在的卡(`StreamPlayer.showingClips()`) */
  streamShowing: ReadonlySet<string>;
  /** 被抑制但这一刻判轻的卡(K3(b) 的 `vtOk = false` 轻卡在等后台补跑);缺省看 `setCatchingUpClips` 那一份 */
  isLight?: (clipId: string) => boolean;
  /**
   * 此刻在场、这台设备跑不了的卡(在线浏览器模式下的用户卡、素材效果卡;`localOnlyClipIds`)。它们照兜底顺序贴快照 / 流;
   * 什么都贴不上时显示沙漏 `awaiting`,暂停时也一样,渲染节点的结果到了自动换上。不管在不在抑制、等快照里。缺省空。
   */
  unsupported?: ReadonlySet<string>;
}

/** T4 的那几张(被抑制、这一刻判轻:等后台补跑互换)。`StageView` 收到 `setSuppressed` 时按分派表算好 */
let catchingUp: ReadonlySet<string> = new Set();
export function setCatchingUpClips(ids: Iterable<string>): void {
  catchingUp = new Set(ids);
}
export function isCatchingUpClip(clipId: string): boolean {
  return catchingUp.has(clipId);
}

/**
 * 这一拍哪几张卡要显示占位符、为什么(T1~T4;这台设备跑不了的卡在兜底顺序尽头是沙漏 `awaiting`:结果由渲染节点出)
 */
export function placeholderWanted(s: PlaceholderState): Map<string, PlaceholderReason> {
  const out = new Map<string, PlaceholderReason>();
  const unsupported = s.unsupported;
  // 这台设备跑不了的卡:贴着快照或流就不显示;否则是沙漏(结果由渲染节点出,到了自动换上)
  if (unsupported) {
    for (const id of unsupported) {
      if (s.snapshots.has(id) || s.streamShowing.has(id)) continue;
      out.set(id, "awaiting");
    }
  }
  const skip = (id: string) => !!unsupported?.has(id);
  for (const id of s.suppressed) {
    if (skip(id)) continue;
    if (s.snapshots.has(id) || s.streamShowing.has(id)) continue;
    // T4:等后台补跑后互换的轻卡;其余是 T1(兜底链尽头)
    out.set(id, (s.isLight ?? isCatchingUpClip)(id) ? "catching-up" : "no-data");
  }
  // T2:快照还没到(`.pc-awaiting` 500 ms 兜底之后由舞台摘掉,占位符随之撤)
  // 这张卡的流这一拍在画(单卡流、它所在的组流、依赖下层的流;留着上一张的那一段也算)就不显示:兜底顺序里流排在前面,
  // 流在画就轮不到占位符。超出预算而不发流的层没有轨道、不在 `streamShowing` 里,照旧显示
  for (const id of s.awaiting) if (!skip(id) && !s.streamShowing.has(id)) out.set(id, "awaiting");
  // T3:不可见地追帧,又没有快照垫着
  for (const id of s.settling.keys()) {
    if (skip(id)) continue;
    if (!s.snapshots.has(id) && !out.has(id)) out.set(id, "catching-up");
  }
  return out;
}

/* ------------------------------------------------------------------ 2b. 本机渲染不了的卡(unsupported) */

/**
 * 在线浏览器模式(product/platforms.md「在线浏览器」):这台设备跑不了的用户卡、素材效果卡(转译失败、引用了页面里没有的模块、
 * 没有隔离环境、图形能力不够)有预渲染结果就照贴,与内置卡相同(一律按重卡:播放中抑制、不活渲,停下不追);
 * 什么都贴不上时在兜底顺序尽头显示沙漏,渲染节点的结果到了自动换上(2026-10-21 用户定:不存在「本地 PC 辅助渲染」)。
 *
 * 开关:在线页面(`ONLINE`)与舞台地址上的 `platform=browser`(截图和探针用)。桌面、导出、预渲染、Agent 看到的画面恒为关。
 */
let onlineBrowser = false;
export function setOnlineBrowserMode(on: boolean): void {
  onlineBrowser = !!on;
}
export function onlineBrowserMode(): boolean {
  return onlineBrowser;
}

/*
 * 在线逐帧导出的导出页(与编辑页面同源的 `?export=1` 文档,`src/export/frameCompositor.ts` 开的 iframe)里同步来的用户卡:
 * 这个文档不执行卡片代码、也没有它们的定义,但导出要把每一帧里这些卡的包裹层换成预渲染原尺寸(契约第 8 节「在线导出」),
 * 所以包裹层得先挂出来。编辑页面经 `__pcSetSyncedUserCards` 把同步表交给导出页并打开这个开关;只对「没有定义的同步卡」生效,
 * 内置卡、素材效果卡与桌面的导出一个字不变(开关只有在线导出才会打开)。
 */
let exportSyncedMount = false;
export function setExportSyncedMount(on: boolean): void {
  exportSyncedMount = !!on;
}
export function exportSyncedMountFor(cardId: string | undefined, def: unknown): boolean {
  return exportSyncedMount && !def && !!cardId && isUserCardId(cardId);
}

/** 这份文档能不能跑素材效果卡:看注册表(`registry.graphCardsRunnableHere`,只有执行卡片的舞台为真) */
export function graphCardsHere(): boolean {
  return graphCardsRunnableHere();
}

/** 这张用户卡在本页能不能运行:看注册表(`registry.cardRunnableHere`;同步来的卡要两台舞台、单舞台时那一台报了 `ready` 才算) */
export function userCardRunnableHere(cardId: string): boolean {
  return cardRunnableHere(cardId);
}

/**
 * 这张卡在此刻的平台上是不是渲染不了。`isUserCard` 缺省查注册表的 `isUserCardId`(构建时的定制卡登记,
 * 加上内容库同步来的用户卡);素材效果卡的判法见 `needsLocalPc`。
 */
export function unsupportedHere(
  cardId: string | undefined,
  def: { card?: unknown; audio?: unknown; Component?: unknown } | undefined,
  isUserCard: (cardId: string) => boolean = isUserCardId,
): boolean {
  if (!onlineBrowser) return false;
  return needsLocalPc(cardId, def, isUserCard);
}

/**
 * 这张卡是不是本页运行不了、要靠渲染节点(`docs/plan/online-card-exec-contract.md` 第 6、8 节)。同步来的用户卡在编辑页面没有定义
 * (`def` 为 undefined),靠 `isUserCard` 认出来;两边都没有的 id(未知卡片)回 false。
 *
 * 用户卡:本页能运行的不算 —— 构建时就在包里的仓库用户卡(它是页面自己的代码);同步来的、运行状态是 `ready` 的
 * (编辑页面看舞台报回的状态,舞台看自己载入成功没有)。转译失败、引用了页面里没有的模块、没有隔离环境的照旧算。
 *
 * 素材效果卡 = 写了 `card()` 的(画面由宿主在 GPU 上执行),或只写了 `audio()`、没有画面组件的(音频素材效果卡)。
 * 有画面组件、同时带 `audio()` 的内置有声动效卡不是素材效果卡:它的画面就是一张普通的 DOM 卡,在线页面照常渲染
 * (声音另由宿主合成,`product/platforms.md`「卡片声音的平台边界」)。2026-10-06 之前这里把凡是写了 `audio()` 的都当素材效果卡,
 * 内置有声卡的画面在在线页面里因此成了「本机跑不了」、导出时一直等预渲染原尺寸。
 */
export function needsLocalPc(
  cardId: string | undefined,
  def: { card?: unknown; audio?: unknown; Component?: unknown } | undefined,
  isUserCard: (cardId: string) => boolean = isUserCardId,
  runnable: (cardId: string) => boolean = userCardRunnableHere,
  graphRunnable: () => boolean = graphCardsHere,
): boolean {
  if (!cardId) return false;
  /*
   * 素材效果卡(画面由 card() 出,或只有 audio()):只在能跑素材效果卡的文档里运行 —— 跨源舞台、画面那一半允许执行、图形能力够
   * (`registry.graphCardsRunnableHere`,由舞台写;契约 4.3)。编辑页面、同源单舞台、桌面仿在线模式里恒为运行不了。
   * 能跑素材效果卡的文档里再看这张卡自己(下面用户卡那一支:载入成功、没出过事)。
   */
  if (!!def && (typeof def.card === "function" || (typeof def.audio === "function" && !def.Component)) && !graphRunnable()) return true;
  // 用户卡:本页能运行的不算(构建时就在包里的仓库用户卡;同步来的、载入成功的,`registry.cardRunnableHere`)
  if (isUserCard(cardId)) return !runnable(cardId);
  return false;
}

/*
 * 占位符在屏幕上的大小(`placeholderFit.ts`):舞台 iframe 被父页用 CSS `scale(预览缩放)` 缩进预览框,占位组件要按它补偿。
 * 父页经 `setViewScale` 发来预览缩放(桌面与在线都发),`Stage` 渲占位组件时按片段的框、这一层的缩放与它算出 `fit`。
 */
let viewScale = 1;
/** 记下父页的预览缩放;变了回 true(`StageView` 据此重渲一次) */
export function setPlaceholderViewScale(scale: unknown): boolean {
  const s = Number(scale);
  const next = Number.isFinite(s) && s > 0 ? s : 1;
  if (next === viewScale) return false;
  viewScale = next;
  return true;
}
export function placeholderViewScale(): number {
  return viewScale;
}

const fitCache = new Map<string, { key: string; fit: PlaceholderFit }>();
/**
 * 这张卡的占位组件怎么放(包裹层本地像素):沙漏只抵消预览缩放。
 * 不超出框:徽标形态看位置框(`size`),铺满形态看实体框。同样的输入回同一个对象(占位组件是 `React.memo`)。
 */
export function placeholderFitFor(clipId: string, reason: PlaceholderReason, geometry: PlaceholderGeometry,
  size: { width: number; height: number }, layerScale: unknown): PlaceholderFit {
  const box = geometry.kind === "solid" ? { width: geometry.box.width, height: geometry.box.height } : { width: size.width, height: size.height };
  void reason; // 各种原因都是沙漏,放法一样(参数留着:调用方与单测照旧传)
  const fit = hourglassFit({ box, viewScale, layerScale });
  const key = String(fit.scale);
  const hit = fitCache.get(clipId);
  if (hit && hit.key === key) return hit.fit;
  if (fitCache.size > 512) fitCache.clear();
  fitCache.set(clipId, { key, fit });
  return fit;
}

/**
 * 在线浏览器模式下这台设备跑不了的片段(`unsupportedHere`,定义从注册表取)。模式关着回空集合。
 * 舞台据此不挂组件、照挂快照 / 流平面,占位符在兜底顺序尽头显示沙漏。
 */
export function localOnlyClipIds(clips: Iterable<{ id: string; cardId?: string }>): Set<string> {
  const out = new Set<string>();
  if (!onlineBrowser) return out;
  for (const c of clips) if (c.cardId && unsupportedHere(c.cardId, getCard(c.cardId))) out.add(c.id);
  return out;
}

/* ------------------------------------------------------------------ 3. 显隐 */

/** 同屏最多几个沙漏在转(占位组件的 `maxAnimated`,由 `Stage` 登记) */
let animatedLimit = Infinity;
export function setMaxAnimated(n: number): void {
  animatedLimit = Number.isFinite(n) && n >= 0 ? n : Infinity;
}

/** 上一次显示着的那几张(下一次要能把它们关掉) */
let shown = new Set<string>();
/** 每张从哪一刻起显示着(真墙钟;探针据此把 120 ms 延迟内的空档单列) */
const since = new Map<string, number>();
/** 舞台页的 `performance.now` / `Date.now` 都被接管成舞台时间,量真实时间要用 `__pcRealNow` */
const realNow = (): number => {
  const w = globalThis as unknown as { __pcRealNow?: () => number };
  return typeof w.__pcRealNow === "function" ? w.__pcRealNow() : Date.now();
};

/**
 * 按 `wanted` 切槽位的 `hidden`。只动这几张:这一拍要显示的 + 上一拍显示着的。
 * `slotOf` 找这张卡包裹层里的槽位(没挂着就跳过:卡刚下场、或者 `Stage` 还没提交)。
 * 回这一次显示着几个(诊断 / 探针用)。
 */
export function applyPlaceholders(wanted: ReadonlyMap<string, PlaceholderReason>, slotOf: (clipId: string) => HTMLElement | null): number {
  let n = 0;
  for (const id of new Set([...wanted.keys(), ...shown])) {
    const slot = slotOf(id);
    if (!slot) continue;
    const on = wanted.has(id);
    setPlaceholderShown(slot, on);
    if (on) {
      n++;
      const reason = wanted.get(id)!;
      if (slot.getAttribute("data-pc-placeholder-reason") !== reason) slot.setAttribute("data-pc-placeholder-reason", reason);
    }
    // 同屏超过 `maxAnimated` 个时,多出来的沙漏静止(contract 的 `PLACEHOLDER_STATIC_ATTR`,只动槽位属性)
    const still = on && n > animatedLimit;
    if (slot.hasAttribute(PLACEHOLDER_STATIC_ATTR) !== still) slot.toggleAttribute(PLACEHOLDER_STATIC_ATTR, still);
  }
  const now = realNow();
  for (const id of wanted.keys()) if (!shown.has(id) || !since.has(id)) since.set(id, now);
  for (const id of [...since.keys()]) if (!wanted.has(id)) since.delete(id);
  shown = new Set(wanted.keys());
  return n;
}

/** 这张从哪一刻起显示着(真墙钟毫秒);没显示回 undefined */
export function shownSince(clipId: string): number | undefined {
  return since.get(clipId);
}

/** 全部撤下(`setRole('back')`、关掉时) */
export function hideAllPlaceholders(slotOf: (clipId: string) => HTMLElement | null): void {
  applyPlaceholders(new Map(), slotOf);
}

export function shownPlaceholders(): ReadonlySet<string> {
  return shown;
}

/* ------------------------------------------------------------------ 4. 几何 */

/** 流清单的实体框(包裹层坐标)。由 `StageView` 接到 `StreamPlayer.boxOf` 上 */
let streamBoxOf: (clipId: string) => { x: number; y: number; w: number; h: number } | null = () => null;
export function setStreamBoxSource(fn: typeof streamBoxOf): void {
  streamBoxOf = fn;
}

/**
 * 超出预算的组流:整组只有一个位置矩形(成员的并集),每个成员的占位符都会铺在它上面,N 个成员叠 N 块同样的框。
 * 每一组里只留这一拍要显示占位符的成员中最上面的那一张(`groups` 每项按画家顺序,最后一个在最上面),其余的从 `wanted` 里拿掉。
 * 原地改 `wanted` 并返回它。
 */
export function keepTopOfGroups<T>(wanted: Map<string, T>, groups: readonly (readonly string[])[]): Map<string, T> {
  for (const members of groups) {
    const showing = members.filter((id) => wanted.has(id));
    for (const id of showing.slice(0, -1)) wanted.delete(id);
  }
  return wanted;
}

/**
 * 舞台坐标里的一个矩形换到某一层包裹层自己的坐标(超出预算的组流、依赖下层的流的位置矩形是舞台坐标,占位符摆在包裹层里)。
 *
 * 用屏幕上量到的两块矩形换:`ref` 是舞台坐标的原点所在的那个元素(包裹层的定位祖先,流的舞台平面也挂在它下面),`wrap` 是包裹层;
 * `*Width` 是它们各自布局里的宽(没算变形的)。只认平移加等比缩放的包裹层:转过、斜切过、带三维的(`transform` 不是这种矩阵)回 null,
 * 那一层照老办法定位。
 */
export function stageBoxToLocal(
  box: { x: number; y: number; w: number; h: number },
  at: { ref: { left: number; top: number; width: number }; refWidth: number; wrap: { left: number; top: number; width: number }; wrapWidth: number; transform?: string | null },
): { x: number; y: number; w: number; h: number } | null {
  const t = at.transform;
  if (t && t !== "none") {
    const m = /^matrix\(([^)]+)\)$/.exec(t.trim())?.[1].split(",").map(Number);
    if (!m || m.length !== 6 || Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6 || Math.abs(m[0] - m[3]) > 1e-6 || !(m[0] > 0)) return null;
  }
  // 舞台像素 → 屏幕像素(预览缩放);包裹层自己的像素 → 屏幕像素(预览缩放 × 这一层的缩放)
  const view = at.ref.width / at.refWidth;
  const own = at.wrap.width / at.wrapWidth;
  if (!(view > 0) || !(own > 0) || !Number.isFinite(view) || !Number.isFinite(own)) return null;
  const r = (n: number) => Math.round(n * 100) / 100;
  return { x: r((at.ref.left + box.x * view - at.wrap.left) / own), y: r((at.ref.top + box.y * view - at.wrap.top) / own), w: r((box.w * view) / own), h: r((box.h * view) / own) };
}

/**
 * 超出预算的层:流清单里这一帧所在分段的位置矩形(已经换到包裹层坐标)。由 `StageView` 接到 `StreamPlayer.overBoxOf` / `stageBoxOf` 上。
 * 它只管这一帧,**不记进 `streamBoxes`**:这一层之后换不出矩形(包裹层转了、下一段没量过)时照老办法定位,不沿用上一段的。
 */
let overBoxOf: (clipId: string) => { x: number; y: number; w: number; h: number } | null = () => null;
export function setOverBoxSource(fn: typeof overBoxOf): void {
  overBoxOf = fn;
}

/** 预算以内的流:清单量到过的框,流停了也留着(下一次来不及时还用得上) */
const streamBoxes = new Map<string, PlaceholderBox>();
/** 上次活渲时量到的墨迹框(包裹层坐标) */
const inkBoxes = new Map<string, PlaceholderBox>();

/**
 * 真渲之后量到的墨迹框(`StageView` 暂停态防抖采样)。量不到(`null`:什么都没画,或内容铺满整张卡 ——
 * `measureContentBox` 两者不分)就不记:宁可退到徽标,也不在量不准的时候铺满噪点。
 */
export function noteInkBox(clipId: string, box: PlaceholderBox | null): void {
  if (box && box.width > 0 && box.height > 0) inkBoxes.set(clipId, box);
}

/** 换项目时清掉:clipId 会复用 */
export function resetPlaceholderGeometry(): void {
  streamBoxes.clear();
  inkBoxes.clear();
  geometryCache.clear();
  fitCache.clear();
}

const geometryCache = new Map<string, { key: string; geometry: PlaceholderGeometry }>();

/**
 * 这张卡的占位几何(相对包裹层、舞台像素)。`size` 是包裹层(= 位置框)的尺寸。
 * 同样的输入回同一个对象(占位组件是 `React.memo`,几何对象换了才重渲)。
 */
export function geometryFor(clipId: string, size: { width: number; height: number }): PlaceholderGeometry {
  const fresh = streamBoxOf(clipId);
  if (fresh && fresh.w > 0 && fresh.h > 0) streamBoxes.set(clipId, { left: fresh.x, top: fresh.y, width: fresh.w, height: fresh.h });
  const stream = streamBoxes.get(clipId);
  const ink = inkBoxes.get(clipId);
  const over = overBoxOf(clipId);
  let geometry: PlaceholderGeometry;
  if (over && over.w > 0 && over.h > 0) geometry = { kind: "solid", box: { left: over.x, top: over.y, width: over.w, height: over.h } };
  else if (stream) geometry = { kind: "solid", box: stream };
  else if (ink) geometry = { kind: "solid", box: ink };
  else geometry = { kind: "badge", center: { x: size.width / 2, y: size.height / 2 } };
  const key = JSON.stringify(geometry);
  const hit = geometryCache.get(clipId);
  if (hit && hit.key === key) return hit.geometry;
  geometryCache.set(clipId, { key, geometry });
  return geometry;
}
