/**
 * 预渲染的排队算法:**空闲时先把贴图渲好**,而不是等播放头走到了才现场渲染。
 *
 * 现场渲染的问题很直接:每渲一张要起一个 Chrome、四五秒,而这四五秒正好发生在用户
 * 刚拖到那一段、最想看清楚的时候。预渲染把这笔开销挪到没人等的时候付。
 *
 * # 排的是「时刻」,不是「卡」
 *
 * 一张卡在它那几秒里是会动的,所以要预渲染的不是一张图,而是**若干个时刻**
 * (哪几个时刻由 `bakeTime.ts` 的 `sampleTimesFor` 定,键由它的 `texKeyOf` 给)。
 * 这里只管两件事:**先渲哪个**、**留多少**。
 *
 * 键由调用方带进来,这里不自己算 —— 两处各算一套键,迟早会出现
 * 「明明预渲染过却当成没渲」或者「把正在用的删了」,而且都不报错,只是莫名其妙地慢。
 *
 * # 顺序:先眼前,再两侧,最后从头
 *
 *   1. **此刻画面上那几张卡各自最贴近当前时间的那个时刻** —— 用户正在看的就是它们,一格都不能等。
 *   2. **按「离播放头多远」向两侧展开**。往前往后都要:用户既会往后拖,也会往回看。
 *      一样远时优先往后(播放方向)。
 *   3. **从 0 开始**把剩下的补齐。跳回片头重看是最常见的动作之一,
 *      而且整条片子早晚都要有,不如按时间顺序稳稳铺过去。
 *
 * # 预算管的是**磁盘上那些 PNG**,而且只按真实字节算
 *
 * 预渲染攒下来的东西是一张张 PNG(以前落在 `out/media` 的 `bake-*.png`;现在经素材服务存进 `px`,
 * 本机记着「哪个键对应哪一块」,见 server/bake-store.mjs —— 下文说的「磁盘上的文件」「删」照这个读:
 * 占用是本机记着的那些快照的字节,删是忘掉这条记录)。实测 80 个文件 4.04MB,
 * 单个从 2.4KB 到 95KB —— 差几十倍(满底的卡压不动,几乎空白的卡压得只剩两千多字节)。
 * 所以**不能按张数算**,得按每个文件真实多大算,这也是这套东西唯一诚实的口径。
 *
 * 这里**没有任何估算**:没预渲染过的文件在磁盘上根本不存在,一个字节都不占,
 * 所以只把**已经渲出来的**计入占用。要渲的按优先级一张张发,
 * 每张回来带着自己的真实大小,占用是加出来的实测值。满了就不再往下发 ——
 * 最多超出一个文件的大小(几十 KB),换来的是全程不用猜。
 *
 * # 「这个项目用不到的文件」排在最后,但**不是一看到就删**
 *
 * 缓存键是卡片内容和时刻的哈希,所以改一次参数就多一批文件,旧的再也不会被命中;
 * 一个会话下来能攒出几十个(实测这一天里从 45 个涨到 105 个,而项目只有十来张卡)。
 * 这些文件对当前项目确实是死的,但 `out/media` 是**所有项目共用**的 ——
 * 「不属于当前项目」和「没用了」是两回事:照着前者删,用户切个项目回来,
 * 上一个项目的缓存就全没了,而且没有任何提示,只表现为「怎么又要等五秒」。
 *
 * 所以它们只是**排在最后**:空间够就都留着(缓存本来就该这样),
 * 空间不够时它们最先被挤出去。删不删由预算说了算,不由「是不是这个项目的」说了算。
 *
 * # 显存不归这里管
 *
 * 顺带记一笔实测,免得以后有人拿这套预算去套显存:同样这批贴图,磁盘上 2.22MB,
 * **解码成贴图进显存是 135MB**,61 倍,而且压缩比 25×~114× 不等,推不出来。
 * 但那笔账不由预渲染决定 —— Scene3DView 只给**当前这一刻**的卡建材质,
 * 场景一重建就全部 dispose。预渲染出来的文件在被用到之前一点显存都不占。
 */

/**
 * 两档预渲染。
 *
 * coarse —— **低帧率**那一档(0.25 秒一格)。先把整条片子铺满它:成本只有原始帧率的
 *   零头,而且拖到任何地方都立刻有画面,只是最多差 0.25 秒。
 * full   —— **原始帧率**那一档(项目 fps)。coarse 全部铺完之后才开始,
 *   预渲染好之后那一段就是逐帧精确的。
 *
 * 顺序写死成「coarse 全部完成 → 才开始 full」,不是按距离混着排:
 * 先让整条片子都能看(哪怕差 0.25 秒),比让开头那几秒精确、后面全是空白有用得多。
 */
export type BakeTier = "coarse" | "full";

/** 要预渲染的一个时刻。`key` 由调用方给(见 bakeTime.ts 的 texKeyOf),这里不自己算 */
export interface BakeMoment {
  clipId: string;
  /** 属于哪一档。不写按 coarse 算 */
  tier?: BakeTier;
  /** 是否落在原始帧率的格子上。排队不看它,画进度条要看(见 bakeCoverage) */
  fine?: boolean;
  /** 预渲染哪一刻(时间轴绝对秒) */
  t: number;
  /** 这张卡在时间轴上的区间 —— 用来判断「现在是不是正播到它」 */
  start: number;
  end: number;
  key: string;
}

/** spare = 当前项目对不上号的文件(旧版本 / 别的项目 / 老格式),排在所有时刻之后 */
export type BakePhase = "current" | "near" | "rest" | "spare";

export interface BakeJob {
  clipId: string;
  t: number;
  key: string;
  phase: BakePhase;
  tier: BakeTier;
}

export interface KeptFile {
  key: string;
  clipId: string;
  /** 这个文件在磁盘上真实多大(实测,不是估的) */
  bytes: number;
  phase: BakePhase;
}

export interface PlanInput {
  /** 整条片子要预渲染的所有时刻 */
  moments: BakeMoment[];
  /** 当前播放头(秒) */
  t: number;
  /** 磁盘预算(字节) */
  budgetBytes: number;
  /** 已经预渲染好的:键 → 文件真实字节数 */
  known: Map<string, number>;
  /** 「身边」窗口有多宽(秒)。超出这个范围的走第三阶段(从 0 开始铺) */
  nearWindowSec?: number;
}

export interface BakePlan {
  /** 还没预渲染的,已按优先级排好。调度器从头往下发,`footprintBytes` 到预算就停 */
  jobs: BakeJob[];
  /** 预算之内、该留着的文件(含不属于当前项目的那些) */
  keep: KeptFile[];
  /** 该删的键 —— **只有被预算挤出去的**。空间够的时候这里永远是空的 */
  evict: string[];
  /** keep 加起来占多少磁盘(全是实测值) */
  footprintBytes: number;
  /** 被挤出去的文件数 */
  dropped: number;
}

/**
 * 把一个时刻**归到帧号上**:`start + i / fps`,i 是整数帧号。
 *
 * # 它现在解决的是「两档格子对不齐」
 *
 * 预渲染分两档:低帧率(0.25 秒一格)和原始帧率(1/fps 一格)。这两套格子**本来对不上** ——
 * 30fps 下 0.25 秒 = 7.5 帧,所以 0.25 / 0.75 / 1.25 / 1.75 这些点根本不落在帧格子上
 * (实测 8 个低帧率点里有 4 个落空)。对不上的后果有两个,都不报错:
 *
 *   - 同一个瞬间被当成两个不同的键,**渲两遍**;
 *   - 低帧率那张渲好了,却不算进「原始帧率」的覆盖,绿条每隔半秒缺一块。
 *
 * 归一之后低帧率成为原始帧率的**子集**,两个问题一起消失。
 *
 * # 顺带兜住的历史问题(根因已由 bakeTime.ts 修掉)
 *
 * 曾经 `sampleTimesFor` 是**累加** step、`pickBakeT` 是 **floor 再乘**,两者在 1/30 这种
 * 非二进制精确的步长上差 2.8e-17(30fps 下 60 个采样有 39 个对不上),而缓存键是对这个
 * 浮点数做哈希的 —— 于是逐帧那一档预渲染出来的图显示端一张都问不到。现在 `bakeTime.ts` 的
 * `gridAt` 统一成「按序号乘」,根因没了;这里仍然按帧号归一,等于多一道防线:
 * 时刻要是从别处来、或者用了别的步长,照样能被归回同一个值。
 *
 * **别改成按固定小数位量化。** 试过,更糟:1/30 被截成 0.033333,比帧边界小一点,
 * `floor` 直接退回一整帧(60 个错 20 个)。非有限小数的步长上那条路根本不成立。
 *
 * 用 round 而不是 floor:传进来的值本来就该落在某一帧上,只是带表示误差,round 把它还原成
 * 本来的帧号;而「不显示还没播到的那一帧」在调用 `pickBakeT` 时已经用 floor 保证过了。
 */
export function canonFrameT(t: number, start: number, fps: number): number {
  const f = Math.max(1, fps);
  return start + Math.round((t - start) * f) / f;
}

const DEFAULT_NEAR_WINDOW_SEC = 20;

/** 播放头是不是正落在这张卡上 */
export function isLive(m: { start: number; end: number }, t: number): boolean {
  return t >= m.start && t < m.end;
}

/**
 * 这个时刻离播放头多远。**按时刻自己的时间算**,不是按整张卡算 ——
 * 一张卡有好几个时刻,正在播的那张里也有「马上要看到的」和「还早」的分别。
 */
export function distanceFrom(m: { t: number }, t: number): number {
  return Math.abs(m.t - t);
}

/** 一档之内怎么排:眼前 → 两侧 → 从 0 铺 */
function orderWithinTier(
  moments: BakeMoment[],
  t: number,
  nearWindowSec: number,
): { m: BakeMoment; phase: BakePhase }[] {
  /*
   * 「此刻正在播的每张卡,离当前时间最近的那个时刻」—— 这些就是屏幕上正显示的东西。
   * 按 clip 取最近的一个,而不是把正在播的卡的所有时刻都算成 current:
   * 那张卡后面几秒的样子固然也要预渲染,但没道理和「现在这一帧」抢同一个优先级。
   */
  const liveBest = new Map<string, BakeMoment>();
  for (const m of moments) {
    if (!isLive(m, t)) continue;
    const cur = liveBest.get(m.clipId);
    if (!cur || distanceFrom(m, t) < distanceFrom(cur, t)) liveBest.set(m.clipId, m);
  }
  const currentKeys = new Set([...liveBest.values()].map((m) => m.key));

  const current = [...liveBest.values()].sort((a, b) => distanceFrom(a, t) - distanceFrom(b, t));
  const others = moments.filter((m) => !currentKeys.has(m.key));
  /*
   * 「身边」只按距离排 —— 前后自然交替,不用手写「一前一后」的交错逻辑。
   * 一样远时优先往后:用户往后拖的次数远多于往回拖。
   */
  const near = others
    .filter((m) => distanceFrom(m, t) <= nearWindowSec)
    .sort((a, b) => distanceFrom(a, t) - distanceFrom(b, t) || (a.t >= t ? -1 : 1) - (b.t >= t ? -1 : 1) || a.t - b.t);
  // 剩下的从 0 开始按时间顺序铺
  const rest = others.filter((m) => distanceFrom(m, t) > nearWindowSec).sort((a, b) => a.t - b.t);

  return [
    ...current.map((m) => ({ m, phase: "current" as const })),
    ...near.map((m) => ({ m, phase: "near" as const })),
    ...rest.map((m) => ({ m, phase: "rest" as const })),
  ];
}

export function planBakes(input: PlanInput): BakePlan {
  const { moments, t, budgetBytes, known, nearWindowSec = DEFAULT_NEAR_WINDOW_SEC } = input;

  /*
   * **先把低帧率那一档整条铺完,再开始原始帧率那一档。**
   *
   * 不混着排:混排的结果是播放头附近变成逐帧精确、而片子后半段还一片空白 ——
   * 而"拖到哪儿都有画面(哪怕差 0.25 秒)"比"开头几秒特别准"有用得多。
   * 两档各自再按「眼前 → 两侧 → 从 0 铺」排,所以低帧率那一档也是先照顾眼前。
   */
  const coarse = moments.filter((m) => (m.tier ?? "coarse") === "coarse");
  const full = moments.filter((m) => m.tier === "full");
  const ordered = [
    ...orderWithinTier(coarse, t, nearWindowSec),
    ...orderWithinTier(full, t, nearWindowSec),
  ];

  const keep: KeptFile[] = [];
  const jobs: BakeJob[] = [];
  const seen = new Set<string>();
  const evict: string[] = [];
  let footprintBytes = 0;
  let dropped = 0;

  for (const { m, phase } of ordered) {
    // 同一个键出现两次(同样的卡、同样的时刻)只对应一个文件
    if (seen.has(m.key)) continue;
    seen.add(m.key);

    const bytes = known.get(m.key);
    if (bytes === undefined) {
      // 还没渲 —— 磁盘上不存在,不占任何空间,所以不参与预算,只排进待渲队列
      jobs.push({ clipId: m.clipId, t: m.t, key: m.key, phase, tier: m.tier ?? "coarse" });
      continue;
    }
    /*
     * 当前这一刻的**不受预算限制**:预算再小也不能把用户正在看的这一张删掉 ——
     * 删了下一秒就得现场渲,等于这套东西白做。
     */
    if (phase !== "current" && footprintBytes + bytes > budgetBytes) {
      dropped++;
      evict.push(m.key);
      continue;
    }
    keep.push({ key: m.key, clipId: m.clipId, bytes, phase });
    footprintBytes += bytes;
  }

  /*
   * 剩下的都是**当前项目对不上号**的文件:改过参数的旧版本、别的项目渲的、老格式留下的。
   * 它们排在所有时刻之后,但同样是「装得下就留着」——
   * 缓存的价值就在于留着,而 out/media 是所有项目共用的,按「不是这个项目的」去删会误伤。
   */
  for (const [key, bytes] of known) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (footprintBytes + bytes > budgetBytes) {
      dropped++;
      evict.push(key);
      continue;
    }
    keep.push({ key, clipId: "", bytes, phase: "spare" });
    footprintBytes += bytes;
  }

  return { jobs, keep, evict, footprintBytes, dropped };
}

/**
 * 预算多大。按机器内存分,而不是拍一个固定值 —— 8GB 的本子和 64GB 的工作站
 * 能拿出来的空间差一个数量级。
 *
 * `navigator.deviceMemory` 只有 Chromium 有,而且是**粗粒度**的(0.25/0.5/1/2/4/8,
 * 8GB 封顶,不是真实内存)。所以它只是个档位参考,不是精确值,拿不到就按 4GB 算。
 *
 * 取 1.5%:8GB 的机器约 120MB。按实测平均 55KB 一个文件,是两千多个。
 * 一张卡要预渲染十来个时刻,所以「两千多个文件」大约是**一两百张卡**的量 —— 正常项目够用。
 * 但它**确实是唯一的回收口**:除了被这条线挤出去,没有任何东西会被删。
 * 所以这个数既不能小到误删还在用的,也不能大到让 out/media 无限长。
 * 真要调,先量目录实际涨到了多少再改。
 */
export function defaultBudgetBytes(deviceMemoryGB?: number): number {
  const gb = Number.isFinite(deviceMemoryGB) && (deviceMemoryGB as number) > 0 ? (deviceMemoryGB as number) : 4;
  const bytes = gb * 1024 * 1024 * 1024 * 0.015;
  return Math.round(Math.min(512 * 1024 * 1024, Math.max(64 * 1024 * 1024, bytes)));
}
