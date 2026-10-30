import { measureContentBox, measureInk, type Ink } from "./contentBox";

/**
 * 实体模式:浏览时把每张卡画成一个色块,不渲真内容。暂停了再渲真的。
 *
 * # ⚠ 现在没有任何地方打开它
 *
 * 编辑台的 2D 预览曾经在播放时切到这里,后来撤了 —— 2D 那一页的契约是
 * 「预览所见 = 导出所得」,播放时换成色块就把这条破了:用户按播放是要看成片长什么样,
 * 不是要看构图草图。代理现在只活在 3D 视图里(`src/editor/preview/Scene3DView.tsx`),
 * 而且只是「贴图还没渲好」时的过渡,渲好立刻换成真图。
 *
 * 这套东西留着没删,是因为「浏览时降级、暂停时真渲」这个思路本身还成立:
 * 将来真遇到预览卡顿(同屏很多毛玻璃之类)可以再接回去。接的时候记住两条 ——
 * 必须**显式**打开(`?stage=1&proxy=1`),而且导出那条路永远拿不到这个参数。
 *
 * # 硬规矩:绝不进 Agent 的眼睛
 *
 * `see_frames` 走 `server/bakery/` 另起一个 Chrome、加载 `?export=1`,
 * 根本不经过编辑台那个窗口。所以只要实体模式活在 `?stage=1` 这条路上,vision 那边读都读不到。
 *
 * 而且必须**显式打开**:
 *
 *     ?stage=1            → 真渲(默认)
 *     ?stage=1&proxy=1    → 实体模式(只有编辑台预览会加)
 *
 * 反过来设计(默认开、导出时关)的话,一个漏掉的判断就能让导出悄悄输出彩色方块,
 * 而那种错不会报,只会被当成渲染 bug 查半天。**退化方向必须是「慢但正确」。**
 *
 * `src/StageView.tsx` 开头写着「预览所见 = 导出所得」。实体模式是这句话的例外,
 * 破得**自明**(彩色方块没人会当成成品),而且只破在人这一侧。
 *
 * # 换挡不能靠卸载重挂
 *
 * `src/render/pinAnimations.ts` 的锚点是「**头一次出现时**的舞台时间」。卡片卸载再挂回来
 * 会拿到新锚点,进场动画在升级那一刻从头播一遍 —— 用户看到的是「每次暂停,字都重新飞进来一次」。
 *
 * 所以真卡一直挂着,只是被一条 CSS 规则藏起来:
 *   - `display:none` 跳过布局和绘制 → backdrop-filter / blur 的开销归零,这正是要省的;
 *   - 元素还在 DOM 里 → 锚点不丢;
 *   - 动画本来就被 pinAnimations 钉住并暂停了 → 藏着几乎不花钱。
 *
 * 用 class + 样式表而不是给卡片套一层 div:套 div 会让 React 在切换那一刻重挂载卡片,
 * 正好踩中上面那个坑。
 *
 * # 铺满整幅的背景不画色块,是有意的
 *
 * 色块的框来自 measureContentBox,而它把「占了这张卡九成以上」的元素当背景跳过。
 * 于是满屏渐变、粒子底纹这类卡在实体模式下是看不见的 —— 这正合适:实体模式要回答的是
 * 「这块压上去会不会打架、会不会盖住人」,而铺底的东西恰恰是不需要看的那一类。
 * 全画出来的话满屏一片色,什么也判断不出来。
 */

/** 这一趟页面能不能用实体模式。只看 URL,和当前开没开无关 */
export function proxyAllowed(): boolean {
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).has("proxy");
}

/**
 * 卡片的墨色缓存,按 clipId。
 *
 * 「实例这一层是白捡的」:按「暂停 = 真渲」,卡片每次真渲都是一次采样机会。
 * **用得越久,实体模式越准** —— 用户改了 accent、换了文案,方块跟着变。
 * 一次都没真渲过的卡没有条目,代理平面退回一个中性灰,浏览一下就自愈。
 */
const inkByClip = new Map<string, Ink>();

/**
 * 这张卡真正画了东西的那一块,坐标**相对卡片自己的框**(不是舞台)。
 * null = 内容基本铺满这张卡,代理平面直接 inset:0。
 *
 * 用内容框而不是卡片框:大多数卡是整屏画布、内容只在中间一小块。拿卡片框画色块的话,
 * 满屏一片,构图什么也判断不出来 —— 而"这块压上去是不是太重了"正是实体模式要回答的问题。
 */
const boxByClip = new Map<string, { left: number; top: number; width: number; height: number } | null>();

export interface Proxy {
  /** 代理平面用的颜色,已经是可以直接写进 CSS 的 rgba() */
  color: string;
  /** 相对卡片自己框的矩形;null = 铺满整张卡 */
  box: { left: number; top: number; width: number; height: number } | null;
}

/** 一次都没采过样的卡用它。中性灰、半透明 —— 一眼看得出「这块还没量过」,又不至于喧宾夺主 */
const UNKNOWN: Proxy = { color: "rgba(148, 163, 184, 0.35)", box: null };

export function proxyOf(clipId: string): Proxy {
  const ink = inkByClip.get(clipId);
  if (!ink) return UNKNOWN;
  const [r, g, b] = ink.rgb;
  // cover 太低的话方块几乎看不见,给一个下限:它要能表达「这儿有东西」
  const a = Math.max(0.12, Math.min(1, ink.cover));
  return { color: `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`, box: boxByClip.get(clipId) ?? null };
}

/**
 * 真渲之后采一次样。每个 `[data-pc-clip]` 各量各的。
 *
 * 只在真渲那一帧调 —— 实体模式下画面上是色块,量它等于把上一次的结论抄一遍再劣化。
 * 量不到的(canvas 还没画、整张卡全透明)保持上一次的结论,不覆盖成 null:
 * 一次量空就把颜色清掉的话,色块会在浏览时忽明忽暗。
 */
export function sampleAll(stageEl: HTMLElement): void {
  for (const el of stageEl.querySelectorAll<HTMLElement>("[data-pc-clip]")) {
    const id = el.getAttribute("data-pc-clip");
    if (!id) continue;
    /*
     * 内容框和墨色用同一趟量:measureContentBox 把这张卡里所有「画了东西」的元素矩形并起来,
     * 坐标是相对传进去的那个元素的(这里就是卡片自己),正好可以直接给代理平面用。
     * 它对「内容铺满整张卡」的情况返回 null —— 那时候平面就该铺满,语义正好对上。
     */
    const box = measureContentBox(el);
    const ink = measureInk(el, box);
    if (ink) inkByClip.set(id, ink);
    boxByClip.set(id, box ? { left: box.l, top: box.t, width: box.r - box.l, height: box.b - box.t } : null);
  }
}

/** 换项目时清掉:clipId 会复用,留着旧颜色就会张冠李戴 */
export function resetInk(): void {
  inkByClip.clear();
  boxByClip.clear();
}

/**
 * 藏真卡的样式表。只在实体模式这条路上注入一次。
 *
 * `.pc-proxy > *` 命中的是卡片组件的根元素(以及代理平面本身,所以要排除掉它)。
 * 用 `!important` 是因为卡片自己可能写了 display —— 这条规则必须赢。
 */
let styleInjected = false;
export function ensureProxyStyle(): void {
  if (styleInjected || typeof document === "undefined") return;
  styleInjected = true;
  const s = document.createElement("style");
  s.dataset.pcProxy = "1";
  s.textContent = `.pc-proxy > *:not([data-pc-proxy-plane]) { display: none !important; }`;
  document.head.appendChild(s);
}
