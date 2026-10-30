/**
 * 同屏轨道流的预算 —— **唯一出处**。划分流的一侧(预渲染进程 `server/frame-stream.mjs` 的 `planStreams`、在线页面
 * `src/online/pageStreamPlan.ts`)据它决定什么时候把相邻的独立重卡并成组流;贴流的一侧(父页 `src/editor/snapshotFeed.ts`、
 * 舞台 `src/render/streamPlayer.ts`)据它决定这一拍哪些层贴流、哪些层超出预算显示占位符。两边是同一个口径、同一组数。
 *
 * # 口径:数像素,不数条数
 *
 * 一条流的开销 = 它的**编码画幅**(上下拼合以后的宽 × 高,按这条流的矩形上界算)× 帧率,单位是「每秒要解的像素」。
 * 三条规则,页面和服务端一样:
 *
 *   1. 同屏不超过 `STREAM_FREE_COUNT`(6)条:**不管像素多少都放行**。原来的预算就是「同屏 6 条」、不看像素,
 *      所以原来放得过的现在一律照样放得过 —— 4K、高帧率的项目里一条流的像素是 1080p 的好几倍,只看像素的话它们同屏两三条就超了;
 *   2. 超过 6 条:各条流的开销加起来不超过 `STREAM_PIXEL_RATE_BUDGET`;
 *   3. 条数的硬上限 `STREAM_COUNT_BUDGET`(32)。
 *
 * 为什么不数条数(`docs/reports/AGENT-rr-merged-eval.md` 第 1.3、4 节,在一台 RTX 3080 的 PC 上量的):同时开 64 个硬件解码器
 * 都正常出帧,30 张小卡各一个解码器、60 帧每秒按时画上 240 / 240;卡住的是硬解每秒能解的像素总量(约 17.8 亿)——
 * 12 张满屏卡 60 帧每秒(30 亿)只按时画上 6 / 240,30 帧每秒(15 亿)118～120 / 120。
 *
 * # 这几个数怎么来的(三级数字,只写在这里)
 *
 *   - `STREAM_FREE_COUNT` = 6:原来的条数预算。6 条以内照原来的办法不看像素(上面第 1 条)。
 *   - `STREAM_PIXEL_RATE_BUDGET` = 6 × 1920 × 2176 × 60 ≈ 15.04 亿像素每秒:第 7 条起才看它。就是原来「同屏 6 条」在
 *     1080p、60 帧每秒的满屏卡上允许的量,是那台 PC 实测产能(约 17.8 亿)的 84%。折下来(1080p):满屏卡 60 帧 6 张、
 *     30 帧 12 张;704×864 的小卡 60 帧 41 张、30 帧 82 张(先碰到条数上限)。大于 1080p 或高于 60 帧的项目里 6 条满屏流
 *     就已经超过这个数,它们照第 1 条放行(和原来一样),第 7 条起一条都加不进。别的机器(核显、手机)的产能没量过,
 *     要按机器定时改这一个数。
 *   - `STREAM_BUDGET_MIN_FPS` = 30:帧率低于 30 的项目按 30 算。不设的话 24 帧的项目能放 15 张满屏卡,而每条流要保底留 3 帧
 *     解好的画面(`streamPlayer.ts` 的 `MIN_FRAMES_PER_STREAM`),显存跟着涨;设了以后保底的解码帧最多是
 *     12 张满屏卡 × 3 帧 ≈ 225 MB(原来 6 张 × 3 帧 ≈ 113 MB)。
 *   - `STREAM_COUNT_BUDGET` = 32:流平面共用一个 WebGL 上下文以后,条数只剩解码器个数和每条流保底的解码帧两样要管。
 *     实测 64 个解码器正常、30 个各播一条按时画齐;取实测正常值的一半。32 条小卡流保底的解码帧约 87 MB。
 *     只贴稀疏版时另有一组小得多的数,见下一节。
 *
 * # 只有一个舞台(精简模式与最低一档,在线浏览器性能不足时)的预算:`sparseStreamBudget()`
 *
 * 这一档每条流**每个分段只解第一帧那一张**(`streamPlayer.ts` 的 `presentFirst`;2026-10-13 用户定「性能不足时只贴稀疏版,
 * 同时活着的解码器给得少」,2026-10-22 起归只有一个舞台的页面(精简模式与最低一档),`mechanism/platforms.md`「三道闸门」〔裁〕),
 * 30 帧的项目一条流一秒解两张,花的不是「每秒解的像素」,是同时开着的解码器个数和留着的画面。所以这一档的开销不乘项目帧率,
 * 一律按「编码画幅 × `STREAM_BUDGET_MIN_FPS`」算(调用方把帧率传成 `STREAM_BUDGET_MIN_FPS`),像素预算就等于「同屏各条流编码画幅之和」的上限。
 * 没在真手机上量过,三个数都是保守的起点(要量什么见 `docs/reports/AGENT-rr-lowmem-streams.md`「真手机上要量的」):
 *
 *   - `SPARSE_STREAM_COUNT` = 4:同时开着的解码器不超过 4 个。手机的硬件 H.264 解码器能同时开几路各家不一,
 *     没有保证的下限;用户给的例子是 2 路,4 是「常见的入门机也开得出、开不出时浏览器还能退到软解」的取值。
 *   - `SPARSE_STREAM_PIXELS` = 2 × 1920 × 2176:同屏各条流的编码画幅之和不超过两张 1080p 的满屏卡。每条流稳态只留画布上那一张
 *     解码帧(换分段的那一下两张),NV12 按 1.5 字节每像素:稳态约 12.5 MB,瞬时最多约 25 MB(双舞台的解码帧预算是 80 MB)。
 *     流裁到实体框,小卡远小于满屏:四张 704×864 的小卡合计约 5 MB。
 *   - `SPARSE_STREAM_FREE` = 1:头一条不看像素。不设的话大于 1080p 的项目里一张满屏卡就超了,一条都贴不上。
 *
 * 超出的层照别的档的办法:父页标 `over`,舞台不建解码器,显示占位符(`snapshotFeed.ts`)。
 * 这组数只在贴流的一侧用(产流、划分流照各自的规矩)。
 *
 * 纯函数;服务端与页面共用这一份(`server/` 引 `src/render/` 下的 `.mjs` 是现成的做法)。
 */
import { resolveFrameSize } from '../kernel/frameSize.mjs';

/** 上下两个半区下面各垫的黑边行数;与 `streamEncode.ts` 的 `STREAM_HALF_PAD`、ffmpeg 滤镜里的 `pad=iw:ih+8` 同值(守门单测核对) */
export const STREAM_BUDGET_HALF_PAD = 8;
/** 单卡流的矩形上界比框大一圈的像素数;与 `server/frame-stream.mjs` 的 `LOCAL_OVERFLOW_PX` 同值(守门单测核对) */
export const STREAM_BUDGET_OVERFLOW_PX = 32;

/** 同屏各条流每秒要解的像素之和的上限(见文件头) */
export const STREAM_PIXEL_RATE_BUDGET = 6 * 1920 * 2176 * 60;
/** 同屏流的条数硬上限(见文件头) */
export const STREAM_COUNT_BUDGET = 32;
/** 同屏不超过这么多条时不看像素(原来的条数预算;见文件头) */
export const STREAM_FREE_COUNT = 6;
/** 算开销时帧率的下限(见文件头) */
export const STREAM_BUDGET_MIN_FPS = 30;
/** 不知道编码画幅的流(没带这一项的旧消息)按一张 1920×1080 的满屏卡算 */
export const STREAM_DEFAULT_PIXELS = 1920 * 2176;

/** 只贴稀疏版时:同时开着的解码器个数上限(见文件头「只贴稀疏版时的预算」) */
export const SPARSE_STREAM_COUNT = 4;
/** 只贴稀疏版时:同屏各条流的编码画幅之和的上限(见文件头) */
export const SPARSE_STREAM_PIXELS = 2 * STREAM_DEFAULT_PIXELS;
/** 只贴稀疏版时:头这么多条不看像素(见文件头) */
export const SPARSE_STREAM_FREE = 1;

/**
 * 只贴稀疏版时的预算,形状同 `streamBudgetOf` 的入参。和它配套的开销要按 `streamCost(pixels, STREAM_BUDGET_MIN_FPS)` 算
 * (不乘项目帧率,见文件头)。
 */
export function sparseStreamBudget() {
  return { count: SPARSE_STREAM_COUNT, pixelRate: SPARSE_STREAM_PIXELS * STREAM_BUDGET_MIN_FPS, free: SPARSE_STREAM_FREE };
}

/** 编码画幅的像素数:矩形宽 × (2 × 矩形高 + 两条黑边) */
export function streamCodedPixels(w, h) {
  if (!(w > 0) || !(h > 0)) return 0;
  return Math.ceil(w) * (2 * Math.ceil(h) + 2 * STREAM_BUDGET_HALF_PAD);
}

const even = (n) => (n % 2 ? n + 1 : n);

/** 按舞台坐标产的流(组流、依赖下层的流)的编码画幅:矩形上界是整幅画面 */
export function stageStreamPixels(stage) {
  const w = Math.max(2, Math.ceil(Number(stage?.width) || 0)), h = Math.max(2, Math.ceil(Number(stage?.height) || 0));
  return streamCodedPixels(even(w), even(h));
}

/**
 * 单卡流矩形上界的宽高:包裹层的框外扩 `STREAM_BUDGET_OVERFLOW_PX`,夹在画面里,宽高外扩到偶数。
 * 与 `server/frame-stream.mjs` 的 `localPlacement(...).bound` 同一个式子(守门单测逐个尺寸核对)。
 */
export function localStreamBoundSize(frame, stage) {
  const size = resolveFrameSize(frame, stage);
  const w = Math.max(2, Math.ceil(size.w)), h = Math.max(2, Math.ceil(size.h));
  const side = (len, full) => {
    // 框在隔离工程里居中:平面坐标下画面覆盖 [-o, full - o];框外扩以后是 [-pad, len + pad]
    const o = Math.max(0, Math.floor((full - len) / 2));
    const lo = -o, hi = full - o;
    let a = Math.max(lo, -STREAM_BUDGET_OVERFLOW_PX), b = Math.min(hi, len + STREAM_BUDGET_OVERFLOW_PX);
    if (b - a < 2) { b = Math.min(hi, a + 2); a = b - 2; }
    if ((b - a) % 2) { if (b < hi) b++; else a--; }
    return Math.max(0, b - a);
  };
  return { w: side(w, Number(stage?.width) || 0), h: side(h, Number(stage?.height) || 0) };
}

/** 单卡流的编码画幅 */
export function localStreamPixels(frame, stage) {
  const { w, h } = localStreamBoundSize(frame, stage);
  return streamCodedPixels(w, h);
}

/** 一条流的开销:每秒要解的像素。`pixels` 不是正数(不知道)按 `STREAM_DEFAULT_PIXELS` 算 */
export function streamCost(pixels, fps) {
  const px = pixels > 0 ? pixels : STREAM_DEFAULT_PIXELS;
  return px * Math.max(STREAM_BUDGET_MIN_FPS, Number(fps) || 0);
}

/**
 * 预算 `{ count, pixelRate, free }`:条数硬上限、像素预算、不看像素的条数。不给就是产品的那一组数;给一个数是只改条数上限
 * (`PROMPTCUT_STREAM_DECODERS`,探针拿它把预算压到 1 逼出组流);给对象可以三样都改(单测)。`free` 不会比条数上限大。
 */
export function streamBudgetOf(budget) {
  const pick = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);
  const of = (count, pixelRate, free) => ({ count, pixelRate, free: Math.min(count, Number.isFinite(free) && free >= 0 ? Math.floor(free) : STREAM_FREE_COUNT) });
  if (typeof budget === 'number') return of(pick(Math.floor(budget), STREAM_COUNT_BUDGET), STREAM_PIXEL_RATE_BUDGET, undefined);
  return of(pick(Math.floor(budget?.count), STREAM_COUNT_BUDGET), pick(budget?.pixelRate, STREAM_PIXEL_RATE_BUDGET), budget?.free);
}

/**
 * 这一拍哪几条放得进预算。`costs`:按优先顺序排好的各条流的开销(`streamCost`)。回放行的下标。
 * 头 `free` 条不看像素(原来放得过的照样放得过);之后某一条的像素放不下时跳过它接着看后面的(后面更小的还放得下);
 * 条数到了硬上限就停。
 */
export function withinStreamBudget(costs, budget) {
  const { count, pixelRate, free } = streamBudgetOf(budget);
  const out = [];
  let used = 0;
  for (let i = 0; i < costs.length; i++) {
    if (out.length >= count) break;
    const cost = costs[i] > 0 ? costs[i] : 0;
    if (out.length >= free && used + cost > pixelRate) continue;
    used += cost;
    out.push(i);
  }
  return out;
}

/**
 * 区间集合在同一帧上的最大重叠数,以及峰值出现在哪一帧。`skip`(帧号的集合)给了,就不把这些帧当候选:
 * 回的是剩下的帧里重叠最多的那一帧。
 */
export function peakConcurrency(intervals, skip = null) {
  const events = [];
  for (const it of intervals) { events.push([it.from, 1]); events.push([it.to + 1, -1]); }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0, at = 0;
  for (const [frame, d] of events) { cur += d; if (cur > peak && !skip?.has(frame)) { peak = cur; at = frame; } }
  return { peak, at };
}

/**
 * 同上,但加的是每条流的开销(`cost`,没带的算 0):同一帧上开销之和的峰值。`moreThan` 给了,只看同屏条数**超过**它的帧
 * (条数不超过它的帧不看像素);回的 `count` 是峰值那一帧上的条数。
 */
export function peakCost(intervals, skip = null, moreThan = 0) {
  const byFrame = new Map();
  const add = (frame, n, c) => { const e = byFrame.get(frame) ?? [0, 0]; e[0] += n; e[1] += c; byFrame.set(frame, e); };
  for (const it of intervals) {
    const c = it.cost > 0 ? it.cost : 0;
    add(it.from, 1, c);
    add(it.to + 1, -1, -c);
  }
  let n = 0, cur = 0, peak = 0, at = 0, count = 0;
  for (const frame of [...byFrame.keys()].sort((a, b) => a - b)) {
    const [dn, dc] = byFrame.get(frame);
    n += dn; cur += dc;
    if (n > moreThan && cur > peak && !skip?.has(frame)) { peak = cur; at = frame; count = n; }
  }
  return { peak, at, count };
}

/**
 * 同屏的流超出预算时,把**相邻**的独立重卡合并成组流(G1:「这是唯一的合并规则」)。
 *
 * `streams`:按画家顺序排好的单卡流 `[{ clipIds: [id], order, from, to, cost }]`;`layers`:全部画面层;
 * `budget`:见 `streamBudgetOf`;`groupCost`:一条组流的开销(组流按整幅画面产,和成员多少无关)。`cost` 都不带时只看条数,
 * 和改成数像素之前完全一样。
 *
 * 先看条数的硬上限、再看像素:
 *   - 条数超了硬上限:在重叠最多的那一帧上,挑画家顺序里**紧挨着**的两条流(两者之间、在它们合并后的时间段里没有别的画面层插着)合并;
 *   - 条数没超硬上限:只看同屏**超过 `free` 条**的帧(不超过的不看像素,原来放得过的照样放得过)。像素超了的,在开销最大的那一帧上
 *     同样只看紧挨着的两条,取「并了以后这一帧要解的像素少得最多」的一对(一样多取画家顺序里最靠前的)。并了不变少的不并 ——
 *     两张小卡并成一条整幅的组流反而更贵;例外是这一帧正好比 `free` 多一条,并掉一条就回到不看像素的条数里,这时照并。
 *     这一帧找不到就换下一个超预算的帧。
 * 反复直到都不超,或者再也找不到可合并的一对。回合并后的列表(每项 `clipIds` 按画家顺序,最后一个是最上面那张)。
 *
 * `fixed`:不参加合并、但同样占预算的流(依赖下层的流、单独成流的两类卡)`[{ from, to, cost }]`。它们只算进峰值,
 * 不会被挑去合并,也不出现在结果里。它们在 `layers` 里本来就有自己那一层,夹在两张卡中间时照旧挡住那两张卡合并。
 * 有它们的时候,峰值那一帧上可能没有能合的一对(挤在那里的都是不能合的流),而别的超预算的帧上有:这一帧找不到就记进
 * `tried`、换下一个超预算的帧,合成一次以后从头再看。
 */
export function groupStreams(streams, layers, budget = undefined, fixed = [], groupCost = 0) {
  const { count: maxCount, pixelRate, free } = streamBudgetOf(budget);
  let list = streams.map(s => ({ ...s, clipIds: [...s.clipIds] }));
  const overlaps = (a, b) => a.from <= b.to && b.from <= a.to;
  const tried = new Set();
  for (let guard = 0; guard < 1000; guard++) {
    const all = fixed.length ? [...list, ...fixed] : list;
    let byCost = false, lastFree = false;
    let { peak, at } = fixed.length ? peakConcurrency(all, tried) : peakConcurrency(all);
    if (peak <= maxCount) {
      byCost = true;
      let count = 0;
      ({ peak, at, count } = peakCost(all, tried, free));
      if (peak <= pixelRate) break;
      // 这一帧正好比不看像素的条数多一条:并掉哪一对都行
      lastFree = count === free + 1;
    }
    const active = list.map((s, i) => ({ s, i })).filter(({ s }) => s.from <= at && at <= s.to).sort((a, b) => a.s.order - b.s.order);
    // 这一帧上能并的一对:条数超了取画家顺序里最靠前的(原来的规则);只为省像素时取省得最多的(一样多取最靠前的)
    let pick = null;
    for (let k = 0; k + 1 < active.length; k++) {
      const lo = active[k].s, hi = active[k + 1].s;
      const saving = (lo.cost > 0 ? lo.cost : 0) + (hi.cost > 0 ? hi.cost : 0) - groupCost;
      // 只为省像素而并:并了以后这一帧不变少的不并(两张小卡并成一条整幅的组流反而更贵)
      if (byCost && !lastFree && !(saving > 0)) continue;
      if (pick && !(saving > pick.saving)) continue;
      const span = { from: Math.min(lo.from, hi.from), to: Math.max(lo.to, hi.to) };
      const members = new Set([...lo.clipIds, ...hi.clipIds]);
      const minOrder = Math.min(lo.order, lo.minOrder ?? lo.order, hi.minOrder ?? hi.order);
      const maxOrder = Math.max(hi.order, lo.order);
      const blocked = layers.some(l => !members.has(l.clipId) && l.order > minOrder && l.order < maxOrder && overlaps(l, span));
      if (blocked) continue;
      pick = { k, saving, next: { clipIds: [...lo.clipIds, ...hi.clipIds], order: maxOrder, minOrder, from: span.from, to: span.to, ...(groupCost > 0 ? { cost: groupCost } : {}) } };
      if (!byCost) break;
    }
    const merged = !!pick;
    if (pick) {
      const drop = new Set([active[pick.k].i, active[pick.k + 1].i]);
      list = list.filter((_, i) => !drop.has(i));
      list.push(pick.next);
      list.sort((a, b) => a.order - b.order);
    }
    if (!merged && !byCost && !fixed.length) break;
    if (merged) tried.clear(); else tried.add(at);
  }
  return list;
}
