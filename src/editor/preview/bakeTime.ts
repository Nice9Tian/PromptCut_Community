/**
 * 「这张卡该预渲染哪一刻」—— 3D 视图显示哪一刻、预渲染排哪几刻,都问这里。
 *
 * # 为什么要有这个文件
 *
 * 原来这个问题有一个写死的答案:**片段中点**(`t: (c.start + c.end) / 2`)。
 * 理由是「起止两端常卡在进出场动画上,预渲染出来是个半透明中间态」——避开半透明这件事本身没错,
 * 错在它把「避开」做成了「永远只看那一刻」。代价是**任何带动画的卡在 3D 里显示的都不是当前这一刻**:
 *
 *     mu-number-ticker(滚动 1.6 秒),clip [0,2],播放头 0.23 秒
 *       2D 预览 / 成片:  81%
 *       3D 视图(渲中点): 100%
 *
 * 这个视图是给人**摆位置**用的。摆的时候看到的是别的时刻的画面,判断就是错的 ——
 * 而且它不会报错,只会让人对着一张不存在的画面调参数。数字滚动、打字机、进度环、
 * 清单打勾、步骤时间线,全中。
 *
 * # 为什么不是「跟着播放头逐帧渲」
 *
 * 预渲染一张要起一个 Chrome,实测 4.7~6.5 秒。逐帧不可能。所以把播放头**吸附到一个格子**上:
 * 看到的那一刻和播放头最多差一格,而同一格永远命中同一份缓存(缓存键里本来就有 t)。
 *
 * # 格子不是均匀铺满的,因为卡片自己说了它什么时候还在动
 *
 * `CardLifecycle.after` 已经把这件事写清楚了(见 kernel/types.ts):
 *   - `hold`   落定之后停住 —— 落定点之后**整段只需要一张图**,再密也是同一帧;
 *   - `loop` / `evolve` 一直在变 —— 整段都得按格子采。
 * 库里 31 张卡,22 张 hold、8 张 evolve、1 张 loop。所以绝大多数卡的代价是
 * 「进场那一两秒密采几张 + 落定后一张」,而不是整段密采。
 *
 * `timing(params)` 比 `lifecycle` 更准(条目数、字数一改落定时刻就变),有就用它。
 *
 * # 一份口径,两个用途
 *
 * 前台显示问 `pickBakeT`,预渲染排队问 `sampleTimesFor`,两者产出的时刻**落在同一个格子上**。
 * 分成两处各自算的话,会出现「明明预渲染过还是要现场渲染」——而且不报错,只表现为莫名其妙的慢。
 * 这和 `bakeTarget` 只有一处的理由是同一个。
 */

/** 排队和显示都只需要片段的这几件事 */
export interface TimedClip {
  id: string;
  cardId: string;
  start: number;
  end: number;
  params?: Record<string, unknown>;
  frame?: { w?: number; h?: number } | null;
}

/** 卡片对「我什么时候还在动」的自述。从 CardDef 的 lifecycle / timing 里摘出来的那一小块 */
export interface CardMotion {
  /** 进场动画多久落定(毫秒) */
  settleMs?: number;
  /** 落定之后:停住 / 循环 / 一直在变 */
  after?: "hold" | "loop" | "evolve";
}

export interface SampleOpts {
  /** 吸附格子(秒)。看到的那一刻和播放头最多差这么多 */
  stepSec?: number;
  /**
   * 一段最多排几个时刻去预渲染。**只影响预渲染的覆盖率,不影响 `pickBakeT` 的正确性** ——
   * 播放头停在没被预渲染的格子上,那一格照样会被现场渲染,只是要等几秒。
   */
  maxPerClip?: number;
}

/** 吸附格子。0.25 秒 = 一格 7~8 帧,肉眼够用,又不至于让一段两秒的卡产出几十张 */
export const DEFAULT_STEP_SEC = 0.25;
/** 一段最多排几张去预渲染。按单张 5 秒算,12 张是一分钟——再多就该让别的片段先排上了 */
export const DEFAULT_MAX_PER_CLIP = 12;
/**
 * 卡片没写 lifecycle 时假设的落定时刻。
 *
 * 库里写了的那些落在 250~1900 毫秒之间,取上限一侧:**宁可多采几张,不要让还在动的卡显示旧帧**。
 * 少采的代价是画面骗人,多采的代价只是多花几秒预渲染——两者不对等。
 * (31 张卡里只有 2 张没写,所以这个默认值很少真的用上。)
 */
export const DEFAULT_SETTLE_MS = 2000;

/** 浮点比较用。时间是秒,格子是 0.25,这个量级足够 */
const EPS = 1e-6;

/**
 * 第 `i` 个格子落在哪一刻(相对片段起点的秒数)。
 *
 * **只有这一处算得出格子的位置** —— `pickBakeT` 和 `sampleTimesFor` 都走它。
 * 分开算过一次,代价是这样的:`sampleTimesFor` 当时是**累加**(`rel += step`),
 * `pickBakeT` 是 **floor 再乘**(`Math.floor(rel / step) * step`)。step = 0.25 时
 * 两者逐位相同(0.25 是二进制精确的),**1/30 不是** —— 30fps 下 60 个采样点里
 * 有 39 个对不上,差 2.8e-17。
 *
 * 而缓存键是拿这个浮点数格式化出来的,所以后果不是"差一点点",是**预渲染出来的图
 * 显示端一张都问不到,而且不报错** —— 只表现为「明明预渲染过还是要现场渲染」。
 * 按序号乘则两边必然逐位相同:`floor(i * step / step)` 取整回 `i`,再乘同一个 `step`。
 *
 * (顺带记一笔:试过"量化到固定小数位"来兜这件事,更糟 —— 1/30 截成 0.033333 比
 * 帧边界小一点,floor 会直接退回一整帧。别再走那条路。)
 */
const gridAt = (i: number, step: number): number => i * step;

/**
 * 从卡片定义里读出「它什么时候还在动」。`timing(params)` 优先 —— 它按**这一张**卡的
 * 实际参数算,而 lifecycle 里的是默认参数下的静态值。
 *
 * `timing` 是卡片作者写的任意函数,可能对没见过的参数抛异常。抛了就退回 lifecycle:
 * 一张卡的时序函数写坏了,不该让整个 3D 视图跟着黑掉。
 */
export function motionOf(
  def:
    | {
      lifecycle?: { settleMs?: number; after?: "hold" | "loop" | "evolve" };
      timing?: (p: any) => { settleMs?: number; after?: "hold" | "loop" | "evolve" } | undefined;
      defaults?: Record<string, unknown>;
    }
    | undefined
    | null,
  params?: Record<string, unknown>,
): CardMotion {
  if (!def) return {};
  let timed: { settleMs?: number; after?: "hold" | "loop" | "evolve" } | undefined;
  if (typeof def.timing === "function") {
    try {
      timed = def.timing({ ...(def.defaults ?? {}), ...(params ?? {}) });
    } catch {
      // 时序函数写坏了就当没写,下面退回 lifecycle
    }
  }
  return {
    settleMs: timed?.settleMs ?? def.lifecycle?.settleMs,
    after: timed?.after ?? def.lifecycle?.after,
  };
}

/** 这张卡在这段里「还在动」的那一段有多长(秒,相对片段起点) */
function liveSpan(clip: TimedClip, motion: CardMotion): { len: number; settle: number; alwaysMoving: boolean } {
  const len = Math.max(0, clip.end - clip.start);
  const settleMs = Number.isFinite(motion.settleMs as number) ? Math.max(0, motion.settleMs as number) : DEFAULT_SETTLE_MS;
  const settle = Math.min(len, settleMs / 1000);
  // 没写 after 的按 hold 处理 —— 和 kernel/types.ts 里「没写 = 有进场动画、之后停住」一致
  const alwaysMoving = motion.after === "loop" || motion.after === "evolve";
  return { len, settle, alwaysMoving };
}

/**
 * 播放头在 `t` 这一刻,这块板子该显示**哪一刻**预渲染出来的图。返回时间轴绝对秒。
 *
 * 两条不变式:
 *
 *   1. **只往回取,不往前取**(`Math.floor`)。看到的一定是**已经发生过的**那一刻 ——
 *      往前取会把还没播到的画面提前显示出来,比慢一格更让人误判。
 *   2. **hold 的卡落定之后一律返回落定那一刻**。落定之后每一帧都一样,再分格子只是
 *      同一张图渲很多遍。一段 10 秒的静态卡因此只要 1 张,不是 40 张。
 */
export function pickBakeT(clip: TimedClip, motion: CardMotion, t: number, opts: SampleOpts = {}): number {
  const step = Math.max(1e-3, opts.stepSec ?? DEFAULT_STEP_SEC);
  const { len, settle, alwaysMoving } = liveSpan(clip, motion);
  if (len <= 0) return clip.start;
  // 播放头在段外(预渲染会问到还没播到的段)就按段首算
  const rel = Math.min(Math.max(0, (Number.isFinite(t) ? t : clip.start) - clip.start), Math.max(0, len - EPS));
  if (!alwaysMoving && rel >= settle - EPS) return clip.start + settle;
  const snapped = gridAt(Math.floor(rel / step + EPS), step);
  return clip.start + Math.min(snapped, Math.max(0, len - EPS));
}

/**
 * 这一段一共有哪几个时刻值得预渲染,按时间升序。**产出的每个值都是 `pickBakeT` 可能返回的值**,
 * 所以预渲染过的格子前台一定命中缓存。
 *
 * 超过 `maxPerClip` 就均匀抽稀,但**首尾必留**:段首是进场第一帧(最常被看),
 * 末尾对 hold 的卡是落定帧(占了整段最长的时间)。抽稀只让预渲染覆盖得疏一点,
 * 没被覆盖的格子照样能现场渲染。
 */
export function sampleTimesFor(clip: TimedClip, motion: CardMotion, opts: SampleOpts = {}): number[] {
  const step = Math.max(1e-3, opts.stepSec ?? DEFAULT_STEP_SEC);
  const cap = Math.max(1, Math.floor(opts.maxPerClip ?? DEFAULT_MAX_PER_CLIP));
  const { len, settle, alwaysMoving } = liveSpan(clip, motion);
  if (len <= 0) return [clip.start];

  const out: number[] = [];
  const live = alwaysMoving ? len : settle;
  // 按**序号**取格子,不要 `rel += step` 累加 —— 累加出来的值 pickBakeT 吸附不回来(见 gridAt)
  for (let i = 0; ; i++) {
    const rel = gridAt(i, step);
    if (rel >= live - EPS) break;
    out.push(clip.start + rel);
  }
  // 落定之后整段是同一帧,用落定那一刻当它的代表
  if (!alwaysMoving) out.push(clip.start + settle);
  if (!out.length) out.push(clip.start);

  if (out.length <= cap) return out;
  // 均匀抽稀,首尾必留
  const thinned: number[] = [];
  for (let i = 0; i < cap; i++) thinned.push(out[Math.round((i * (out.length - 1)) / (cap - 1))]);
  return [...new Set(thinned)];
}

/**
 * 贴图缓存的键。**必须带上是哪一刻** —— 原来的键只有「哪张卡、什么参数、画布多大」,
 * 于是同一张卡的不同时刻算同一个键,换了时刻也不会重新取图,画面就停在第一次渲的那一帧。
 *
 * 位置和三维变换**不进键**:服务端预渲染的时候会把 frame 整个摘掉(见 bakeTarget),
 * 转一下卡片、推一下深度贴图一个像素都不会变。进了键的后果是在「三维」面板里拖滑杆,
 * 每一格都算缓存未命中,于是每一格发一次预渲染请求。
 */
export function texKeyOf(clip: TimedClip, bakeT: number): string {
  return [
    clip.id,
    clip.cardId,
    JSON.stringify(clip.params ?? {}),
    `${clip.frame?.w ?? "-"}x${clip.frame?.h ?? "-"}`,
    `@${bakeT.toFixed(3)}`,
  ].join("|");
}

/**
 * 显示的那一刻和播放头差了多少(秒)。给界面用:差得超过一格就该说出来是第几秒,
 * 别让人以为板子上就是当前这一帧 —— 沉默地显示另一个时刻正是原来那个 bug。
 */
export function staleBy(bakeT: number, t: number): number {
  return Math.abs((Number.isFinite(t) ? t : bakeT) - bakeT);
}
