/**
 * 「时间轴上哪几段已经预渲染好了」—— 算给那条绿条用的(像 AE 顶上那条)。
 *
 * # 一个预渲染好的时刻覆盖的是一小段,不是一个点
 *
 * 预渲染是按**时刻**渲的(哪几个时刻由 bakeTime.ts 的 sampleTimesFor 定),而播放头落在
 * 两个时刻之间时,显示的是**往回取**的那一个(pickBakeT 用 floor)。所以渲好 t_i 那一张,
 * 等于 `[t_i, t_{i+1})` 这一整段都有图可显示 —— 最后一个时刻一直管到这张卡结束。
 *
 * 这也是绿条唯一诚实的画法:绿的地方拖过去一定立刻有画面,不绿的地方一定要等。
 * 按「渲好几张 / 一共几张」画个百分比进度条就做不到这一点 —— 那种条能显示 90%,
 * 而用户偏偏拖到了剩下那 10% 里,一样要干等五秒,条却是绿的。
 *
 * # 为什么不按 clip 整段算
 *
 * 一张卡有十来个时刻,渲到一半时它**前半段能看、后半段不能**。整段涂绿会骗人,
 * 整段留白又埋没了已经渲好的部分。所以按时刻切段,一段一段涂。
 */

export interface CoverageSegment {
  start: number;
  end: number;
}

/** 浮点比较的容差:时刻是 0.25 秒一格累加出来的,末位会有误差 */
const EPS = 1e-6;

/**
 * 一刻的标识:`<clipId>@<t>`。
 *
 * **判断「渲了没」用它,不用服务端那个缓存键。** 前台现场渲染和空闲预渲染走的是两条路,
 * 前台手上只有 (clipId, t),没有服务端算的哈希;两条路要是各用各的键,前台渲完了
 * 覆盖表也认不出来 —— 表现就是「画面已经出来了,时间轴上的条还没变」。
 */
export const momentId = (clipId: string, t: number) => `${clipId}@${t}`;

export interface CoverageInput {
  clipId: string;
  /** 这一刻的标识(momentId)。覆盖表按它记「渲了没」 */
  id?: string;
  /** 这一刻的缓存键。判断「渲了没」要用它,所以这里也带上 */
  key?: string;
  /** 属于哪一档(低帧率 / 原始帧率)。分开画黄绿两条 */
  tier?: "coarse" | "full";
  /** 是否落在原始帧率的格子上 */
  fine?: boolean;
  /** 这一刻预渲染出来的图代表哪个瞬间(时间轴绝对秒) */
  t: number;
  /** 这张卡的区间 —— 最后一个时刻要一直管到 end */
  start: number;
  end: number;
}

/**
 * 已经渲好的那些时刻,在时间轴上覆盖了哪几段。
 *
 * `isBaked` 由调用方给:预渲染那边知道哪些键已经落盘了。
 * 返回的段按时间排好,并且**相邻的合并过** —— 不合并的话一张卡会画出十几条挨着的小绿块,
 * 每块之间一道缝,看着像"渲得断断续续",其实是连续的。
 */
export function coverageSegments(
  moments: CoverageInput[],
  isBaked: (m: CoverageInput) => boolean,
): CoverageSegment[] {
  // 按卡分组:一个时刻能管到哪儿,取决于**同一张卡里**的下一个时刻,不能跨卡去找
  const byClip = new Map<string, CoverageInput[]>();
  for (const m of moments) {
    const list = byClip.get(m.clipId);
    if (list) list.push(m);
    else byClip.set(m.clipId, [m]);
  }

  const raw: CoverageSegment[] = [];
  for (const list of byClip.values()) {
    const sorted = [...list].sort((a, b) => a.t - b.t);
    for (let i = 0; i < sorted.length; i++) {
      const m = sorted[i];
      if (!isBaked(m)) continue;
      const next = sorted[i + 1];
      // 管到下一个时刻为止;它是这张卡的最后一个,就一直管到卡结束
      const end = next ? Math.min(next.t, m.end) : m.end;
      const start = Math.max(m.start, m.t);
      if (end > start + EPS) raw.push({ start, end });
    }
  }

  return mergeSegments(raw);
}

/**
 * 把挨着或重叠的段并起来。不合并的话一张卡会画出十几条挨着的小块,每块之间一道缝,
 * 看着像「渲得断断续续」,其实是连续的。
 *
 * 单独导出是因为**画的时候还要再合一次**:覆盖是按卡分开存的(见 ClipCoverage),
 * 而首尾相接的两张卡各自的段应该连成一条。
 */
export function mergeSegments(segs: CoverageSegment[]): CoverageSegment[] {
  const raw = [...segs].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: CoverageSegment[] = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && seg.start <= last.end + EPS) last.end = Math.max(last.end, seg.end);
    else merged.push({ ...seg });
  }
  return merged;
}

/**
 * 时间轴上**压根没有东西要预渲染**的那几段。
 *
 * # 为什么这些段也该是绿的
 *
 * 条子的契约是「绿的地方拖过去一定立刻有画面,不绿的地方一定要等」。空白的那几秒
 * ——没有卡、或者只有素材段(视频 / 图片,本来就是位图,不用渲)、或者只有 scene-3d
 * (在 3D 视图里是真几何,不需要贴图)—— 拖过去**立刻**就是它该有的样子,一秒都不用等。
 * 按契约它就该是绿的。
 *
 * 原来它们永远是白的,后果不只是难看:用户没法把「这一段还没渲」和「这一段本来就没东西」
 * 分开,于是条子永远差一块,**看上去像预渲染卡住了**,而其实早就全渲完了。
 *
 * `spans` 传的是「有东西要渲」的那些段(调用方按项目当前状态算),这里返回它们在
 * `[0, duration]` 里的补集。
 */
export function idleSpans(spans: CoverageSegment[], duration: number): CoverageSegment[] {
  if (!(duration > 0)) return [];
  const busy = mergeSegments(spans.filter((s) => s.end > s.start));
  const out: CoverageSegment[] = [];
  let at = 0;
  for (const s of busy) {
    if (s.start > at + EPS) out.push({ start: at, end: Math.min(s.start, duration) });
    at = Math.max(at, s.end);
    if (at >= duration) break;
  }
  if (at < duration - EPS) out.push({ start: at, end: duration });
  return out.filter((s) => s.end > s.start + EPS);
}

/**
 * 进度条要显示的全部信息。**两档分开**:
 *
 * coarse(黄)—— 低帧率那一档。拖过去立刻有画面,但看到的那一刻最多和播放头差 0.25 秒。
 * full(绿)—— 原始帧率那一档。那一段是逐帧精确的。
 *
 * 两档分开画而不是合成一个百分比,是因为它们对用户的意义完全不同:
 * 黄的地方"能看但不准",绿的地方"就是这一帧"。合成一条就把这个区别抹掉了。
 */
/**
 * 一张卡的覆盖情况。**带着这张卡当时的内容指纹**。
 *
 * 分卡存 + 带指纹,是为了「改了 A,A 那一段立刻变白」这件事能**不依赖任何异步**:
 * 画条子的时候拿当前项目的指纹对一遍,对不上的直接不画。用户一改参数,store 里的
 * project 就换了,条子这一帧就把 A 抹掉了 —— 不用等盘点、不用等预渲染、也不会有竞态。
 *
 * 之前是把所有卡合成一条整段存的,于是**只有预渲染循环能更新它**,而那个循环要等
 * 当前这批渲完、再盘点一次才轮得到发布。结果就是「改完卡片,条子纹丝不动」。
 */
export interface ClipCoverage {
  clipId: string;
  /** 这张卡当时长什么样(clipFingerprint)。和当前项目对不上就说明它已经作废了 */
  fp: string;
  /**
   * 发布这条覆盖时,这张卡在时间轴上的起点。
   *
   * **没有它,条子会在卡挪走之后继续在原地涂绿。** 指纹里故意不带时间轴位置(挪一下位置
   * 像素一个都不变,预渲染出来的图还是那一张,见 bakeTarget),所以光看指纹是看不出卡挪没挪的;
   * 而每个时刻记的 `t / start / end` 都是**绝对秒**,卡挪走了它们还停在老地方。
   * 实测:把一张 [20,24] 的卡挪到 27 秒,条子仍然在 [20,24] 上画着绿,而那里已经空了,
   * `stale` 还报 0 —— 正是「明明没渲好却是绿的」。
   *
   * 记下起点之后,画的时候按差值整体平移(见 visibleCoverage):图还是那几张、账还是那本账,
   * 只是画到卡片现在待的地方去。
   */
  start: number;
  /** 这张卡要预渲染的全部时刻 */
  moments: CoverageInput[];
}

/**
 * 覆盖表存的是**事实**(有哪些时刻、哪些已经渲好),段落是画的时候现算的。
 *
 * 这样安排是因为「渲好了」这件事有两个来源:空闲预渲染,和用户正盯着时前台的现场渲染。
 * 存算好的段的话,只有预渲染那条路能更新它 —— 前台渲完,画面出来了,条子还得等下一轮
 * 盘点才变。存事实就没这问题:哪条路渲完都只是往 `baked` 里加一个 id,条子当帧就重算。
 */
export interface BakeCoverage {
  /** 按卡分开存,画的时候按指纹过滤 */
  clips: ClipCoverage[];
  /** 已经渲好的那些时刻(momentId)。两条渲染路径共用这一个集合 */
  baked: Set<string>;
  /** 正在渲的那一刻(时间轴绝对秒);没在渲就是 null */
  bakingAt: number | null;
  /** 已经占了多少磁盘(字节,实测值) */
  bytes: number;
}

const EMPTY: BakeCoverage = { clips: [], baked: new Set(), bakingAt: null, bytes: 0 };

/**
 * 一张卡「长什么样」的指纹 —— 只带**决定像素**的东西。
 *
 * 这一份是**唯一**的算法:Scene3DView 判断要不要重建场景用它,进度条判断某段覆盖
 * 是不是过期了也用它。两处各写一套的话,会出现「条子认为还有效、画面已经换了」这种
 * 对不上的状态,而且不报错。
 *
 * 位置和三维变换不进指纹:服务端预渲染的时候会把 frame 整个摘掉(见 bakeTarget),
 * 转一下卡、推一下深度,像素一个都不变。
 */
export function clipFingerprint(c: {
  id: string; cardId: string; params?: unknown; frame?: { w?: number; h?: number } | null;
  start?: number; end?: number;
}): string {
  /*
   * **列黑名单,不列白名单。**
   *
   * 服务端的缓存键是拿「整个 clip 去掉 frame」哈希出来的(见 bakeTarget),所以凡是 clip 上的
   * 字段变了,预渲染出来就可能是另一张图。这里原来只挑了 id / cardId / params / frame 四样,
   * 于是 `emphasis`(描边)、`motion`(运动轨迹)、`fadeIn/fadeOut`、`opacity`、`parts`
   * (组合卡的部件树)改了之后**指纹纹丝不动** —— 条子照旧是绿的,而那几张图其实已经作废。
   * 白名单还有个毛病:以后往 Clip 上加字段的人不会想到来这里补一笔,漏了也不报错。
   *
   * 所以反过来:除了下面这三样,**其余一律进指纹**。
   *   - `start` 单独排除:挪位置不改像素(bakeTarget 会把片段挪到固定起跑线再渲),
   *     所以挪一下不该让覆盖作废 —— 位置的变化由 ClipCoverage.start 平移来吸收。
   *   - `end` 也不直接进,但**长度进**:剪短剪长会改键(键里带片内帧数),必须作废。
   *   - `frame` 只取 w×h:那是排版尺寸,会改像素;x/y/旋转/缩放不改(预渲染的时候整个 frame 被摘掉)。
   */
  const { start: _start, end: _end, frame: _frame, ...rest } = c as Record<string, unknown> & typeof c;
  const dur = Math.max(0, (Number(c.end) || 0) - (Number(c.start) || 0));
  return [
    JSON.stringify(rest),
    `${c.frame?.w ?? "-"}x${c.frame?.h ?? "-"}`,
    dur.toFixed(6),
  ].join("|");
}

/*
 * 模块级的小仓库:预渲染那边写,时间轴那边读。
 *
 * 走模块级而不是 React context,是因为这两处在组件树上离得很远(预渲染挂在预览面板的 3D 页里,
 * 绿条在时间轴顶上),中间那一整条链路没有一个组件需要这个值 —— 穿过去只会让沿途每个组件
 * 都多一个用不上的 prop 或者多一次重渲染。
 *
 * 值留在模块里还有个好处:从 3D 页切回 2D 页,预渲染停了,但**已经渲到哪儿的信息还在**,
 * 绿条不会因为切了个页就整条清空。
 */
let current: BakeCoverage = EMPTY;
const listeners = new Set<() => void>();

export function publishCoverage(next: BakeCoverage): void {
  current = next;
  for (const fn of listeners) fn();
}

/** useSyncExternalStore 要的那两个:订阅 + 取快照 */
export function subscribeCoverage(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * 取当前值。**必须返回同一个引用**(除非真的变了)—— useSyncExternalStore 每次渲染都会
 * 调它并和上次比引用,这里要是每次新建一个对象,React 会判定"变了"从而无限重渲染。
 */
export function getCoverage(): BakeCoverage {
  return current;
}


/** 进度条真正要画的东西:过滤掉作废的卡之后,跨卡合并出来的段和计数 */
export interface VisibleCoverage {
  coarse: CoverageSegment[];
  full: CoverageSegment[];
  coarseBaked: number;
  coarseTotal: number;
  fullBaked: number;
  fullTotal: number;
  /** 有多少张卡的覆盖已经作废(刚改过参数,还没重渲) */
  stale: number;
}

/**
 * 拿**当前项目**的指纹过一遍覆盖,只留还算数的,再跨卡合并。
 *
 * 这是「改了 A,A 那一段当帧就变白」的全部机制:指纹对不上就不画。
 * 它是个纯函数,所以这条行为可以单测 —— 而它要是错了,界面上的表现是
 * 「条子显示绿的,拖过去却要等五秒」,属于会骗人的那一类,必须钉住。
 */
export function visibleCoverage(
  cov: BakeCoverage,
  /** 当前项目里还活着的卡:指纹 → 它**现在**在时间轴上的起点(指纹里带 clip.id,所以不会撞) */
  liveClips: Map<string, number>,
): VisibleCoverage {
  const isBaked = (m: CoverageInput) => !!m.id && cov.baked.has(m.id);
  const coarseM: CoverageInput[] = [];
  const fineM: CoverageInput[] = [];
  let dropped = 0;
  for (const c of cov.clips) {
    const liveStart = liveClips.get(c.fp);
    // 指纹对不上 = 这张卡改过或者没了,它的覆盖全部作废
    if (liveStart === undefined) { dropped++; continue; }
    /*
     * **卡挪走了就把覆盖跟着挪。**
     *
     * 时刻记的是绝对秒,卡一挪它们就指着老地方;而挪位置并不会让预渲染好的图作废
     * (bakeTarget 把片段挪到固定起跑线再渲,实测挪完 34/34 张仍命中同一个文件)。
     * 所以正确的做法是平移,不是作废 —— 作废会让条子在缓存明明还在的时候闪一下白。
     * 平移只动画到哪儿,`m.id` 一个字不改,所以「渲没渲」这本账照旧对得上。
     */
    const shift = liveStart - (c.start ?? 0);
    for (const m of c.moments) {
      const at = Math.abs(shift) < EPS
        ? m
        : { ...m, t: m.t + shift, start: m.start + shift, end: m.end + shift };
      if ((m.tier ?? "coarse") === "coarse") coarseM.push(at);
      // 绿用 fine 而不是 tier:0.5 秒这类点两档都落在上面,排队时算低帧率,
      // 但它同样是逐帧那一档的一格 —— 漏掉它绿条会每隔半秒缺一块
      if (m.fine) fineM.push(at);
    }
  }
  return {
    coarse: coverageSegments(coarseM, isBaked),
    full: coverageSegments(fineM, isBaked),
    coarseBaked: coarseM.filter(isBaked).length,
    coarseTotal: coarseM.length,
    fullBaked: fineM.filter(isBaked).length,
    fullTotal: fineM.length,
    stale: dropped,
  };
}

/**
 * 记下「这一刻渲好了」。**前台现场渲染完也要调这个** —— 不调的话画面已经换成真图了,
 * 时间轴上那一段还是空的,要等下一轮盘点才补上,看起来就是条子慢半拍。
 *
 * 只加不算段:段是画的时候现算的,所以这里 O(1) 就够,每渲完一张调一次不心疼。
 */
export function markBaked(ids: string[]): void {
  const add = ids.filter((id) => !current.baked.has(id));
  if (!add.length) return;
  const baked = new Set(current.baked);
  for (const id of add) baked.add(id);
  publishCoverage({ ...current, baked });
}
