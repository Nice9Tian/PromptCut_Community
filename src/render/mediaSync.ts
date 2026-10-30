/**
 * 素材层跟播放头对齐时,这一帧该做什么。
 *
 * # 为什么单独抽出来
 *
 * 原来的做法是一句话:播放中偏差超过 0.2s 就 `el.currentTime = target`。
 * 这句话在时间轴开头没问题,到中段就会把画面拖成一卡一卡的,原因是**纠偏手段的代价
 * 随着纠偏对象一起涨,而且没有任何阻尼**:
 *
 *   1. `el.play()` 本身有启动延迟,视频时钟因此天然落后播放头一小截;
 *   2. 落差一旦过 0.2s 就硬 seek。文件中段的 seek 不便宜 —— 关键帧是每 5 秒一个
 *      (实测用户素材就是 5s),浏览器要从上一个关键帧开始解出最多 150 帧才能出画;
 *   3. 这 100~500ms 里播放头照走,seek 落定时又差了 0.2s 以上 → 再 seek;
 *   4. 于是进入自持循环:每次纠偏都制造出下一次纠偏的理由,画面每隔几百毫秒被打断一次。
 *
 * 开头那十几秒之所以没事,是因为 `preload="auto"` 已经把开头缓冲好了、而且 0 秒就是
 * 关键帧,seek 几乎不要钱,启动落差压根到不了 0.2s,循环起不来。
 *
 * # 现在的做法
 *
 * 把「纠偏」和「重新对齐」分成两件事:
 *
 *   - **小偏差用变速**(`playbackRate` 微调 ±10%)慢慢追回来。变速不打断解码,
 *     没有代价,也就不会制造下一次纠偏的理由;
 *   - **只有真的脱节了才 seek**(阈值放宽到 0.5s),而且 seek 之间有冷却时间,
 *     `el.seeking` 期间一律不下新指令 —— 这两条一起,把上面那个自持循环从根上断掉。
 *
 * 纯函数,不碰 DOM,好单测:所有阈值和状态机都在这里,调用方只负责把 el 的读数递进来、
 * 把结果照着执行。
 */

/** 超过这个偏差才认为「脱节了」,值得付一次 seek 的代价 */
export const HARD_SEEK_SEC = 0.5;
/** 两次纠偏 seek 之间至少隔这么久,给解码器把画面重新喂上的时间 */
export const SEEK_COOLDOWN_MS = 700;
/** 小于这个偏差就当对齐了,不做任何纠正(视频帧本身就有 1/帧率 的粒度) */
export const IN_SYNC_SEC = 0.04;
/** 变速纠偏的上限:±10% 人眼和耳朵都听不出来,再多就该听出变调了 */
export const MAX_RATE_SKEW = 0.1;
/** 暂停时对齐得准一点 —— 这时候 seek 不跟播放抢,而且用户在逐帧看 */
export const PAUSED_SEEK_SEC = 0.03;
/**
 * 手按着播放头拖的时候,两次 seek 之间至少隔这么久。
 *
 * 原来暂停时只要差过 0.03s 就立刻 seek,拖动时鼠标每动一下就是一次 —— 3 秒拖下来实测 154 次,
 * 每次都「从关键帧解到目标」,解码器一直在推翻重来。seeking 期间本来就不发新指令,
 * 这一条再管住「seek 很快落定」的那一头(同一个 GOP 里往后挪几乎不要钱):
 * 50ms 一次,3 秒最多 60 次。没发出去的那次由调用方按 retryInMs 补上,不会丢。
 * 松手之后 scrubbing 变回 false,立刻按 0.03s 精确对齐。
 */
export const SCRUB_SEEK_MIN_MS = 50;

export interface SyncInput {
  /** 元素当前时间,null 表示还没有元数据、读不出来 */
  elTime: number;
  /** 元素这一刻是不是正在 seek */
  seeking: boolean;
  /** 元素这一刻是不是暂停的 */
  paused: boolean;
  /** 元素已经放到素材尽头(`el.ended`)。缺省 false */
  ended?: boolean;
  /** 播放头换算到这条素材上的时刻 */
  target: number;
  /**
   * 基准播放速率:片段速度(`TrackClip.speed`,缺省 1)。对齐时按它放,纠偏的 ±10% 乘在它上面,暂停时也停在它上面
   * (下次起播不带着别的速率)。偏差、门槛照旧按素材秒算。
   */
  baseRate?: number;
  /** 时间轴在播放中 */
  playing: boolean;
  /** 手正按着播放头拖(见 timeline/useScrub.ts 的 isScrubbing);只影响暂停时 seek 的疏密 */
  scrubbing?: boolean;
  /** 现在几点(ms),用来算冷却 */
  now: number;
  /** 上一次由我们发起的纠偏 seek 是什么时候,没有过就是 0 */
  lastSeekAt: number;
}

export interface SyncPlan {
  /** 要把 currentTime 设成这个值;null 表示不要动 */
  seekTo: number | null;
  /** 要把 playbackRate 设成这个值;null 表示不要动 */
  rate: number | null;
  /** 要不要调 play() */
  play: boolean;
  /** 要不要调 pause() */
  pause: boolean;
  /**
   * 这次该 seek 却没发(拖动时离上一次太近),过这么多毫秒再判一次;null 表示不用补。
   * 调用方必须真的补:拖动停住以后不会再有新的渲染来触发同步,不补画面就停在旧的一帧。
   */
  retryInMs: number | null;
}

const NOTHING: SyncPlan = { seekTo: null, rate: null, play: false, pause: false, retryInMs: null };

/**
 * 这一帧该对元素做什么。
 *
 * 调用方拿到结果照做即可;`seekTo` 非空时要把 `lastSeekAt` 更新成 `now`。
 *
 * seeking 期间来的新位置这里一律不理,所以调用方还要在 `seeked` 时拿**最新的**目标再调一次 ——
 * 不然最后一次拖动恰好落在 seek 中间时,最终位置永远补不上(render/mediaDrive.ts 的 driveMedia)。
 */
export function planSync(input: SyncInput): SyncPlan {
  const { elTime, seeking, paused, target, playing, scrubbing, now, lastSeekAt } = input;
  if (!Number.isFinite(target) || target < 0 || !Number.isFinite(elTime)) return NOTHING;
  // 片段速度;缺省(或不合法)是 1,下面每一处 `base` 就是原来写死的 1
  const base = typeof input.baseRate === "number" && Number.isFinite(input.baseRate) && input.baseRate > 0 ? input.baseRate : 1;

  // seek 还没落定时什么都别做。这一条是断开自持循环的关键:seeking 期间 currentTime
  // 读出来的是目标值不是真实进度,拿它算偏差只会得出「还差很多」,于是再发一次 seek,
  // 把刚才那次的解码工作全部作废 —— 画面就永远出不来。
  if (seeking) return playing && paused ? { ...NOTHING, play: true } : NOTHING;

  if (!playing) {
    // 暂停:速度先还原(到片段速度),免得下次起播带着上次的微调
    const rate = base;
    const needSeek = Math.abs(elTime - target) > PAUSED_SEEK_SEC;
    const wait = scrubbing ? SCRUB_SEEK_MIN_MS - (now - lastSeekAt) : 0;
    if (needSeek && wait > 0) return { seekTo: null, rate, play: false, pause: !paused, retryInMs: wait };
    return { seekTo: needSeek ? target : null, rate, play: false, pause: !paused, retryInMs: null };
  }

  const drift = target - elTime; // 正数 = 视频落后于播放头
  const off = Math.abs(drift);

  /*
   * 元素已经放到素材尽头,而播放头还在这一段里(声音比播放头快了一点先放完,或片段比素材长)。
   * 这时候**不能再调 play()**:浏览器对「放完了的元素」的 play() 是从头重播 —— 片段末尾会冒出一下开头的声音,
   * 接着偏差过 0.5s 又被硬 seek 回末尾,尾巴再放一遍。放完了就安静等播放头走出这一段;
   * 只有播放头真的回到了前面(超过硬 seek 的门槛)才 seek 回去接着放,seek 之后元素不再是「放完了」。
   */
  if (input.ended) {
    if (drift >= -HARD_SEEK_SEC) return { ...NOTHING, rate: base };
    if (now - lastSeekAt < SEEK_COOLDOWN_MS) return { ...NOTHING, rate: base };
    return { seekTo: target, rate: base, play: true, pause: false, retryInMs: null };
  }

  if (off > HARD_SEEK_SEC) {
    // 真脱节了。但冷却没过就先忍着 —— 上一次 seek 的解码可能还在路上,
    // 这时候再发一次只会把它推翻重来,这正是原来那个循环的形状。
    if (now - lastSeekAt < SEEK_COOLDOWN_MS) return { ...NOTHING, rate: base, play: paused };
    return { seekTo: target, rate: base, play: paused, pause: false, retryInMs: null };
  }

  if (off <= IN_SYNC_SEC) return { seekTo: null, rate: base, play: paused, pause: false, retryInMs: null };

  /*
   * 中等偏差:变速追。
   *
   * 偏差 0.04~0.5s 之间线性映射到 ±10% 的速率:落后就快放一点、超前就慢放一点。
   * 0.2s 的偏差按 ~4% 的速差算,5 秒左右能追平,期间画面是连续的 —— 而原来这一档
   * 正好落在硬 seek 的触发区里,每次都要付一次中段 seek 的代价。
   */
  const skew = (drift / HARD_SEEK_SEC) * MAX_RATE_SKEW;
  const rate = base * (1 + Math.max(-MAX_RATE_SKEW, Math.min(MAX_RATE_SKEW, skew)));
  return { seekTo: null, rate, play: paused, pause: false, retryInMs: null };
}

/*
 * ────────────────────────────── 双缓冲槽位 ──────────────────────────────
 *
 * 每条序列固定两个 <video>(槽位 0 / 1):一个放当前段,另一个提前装好下一段。
 *
 * 为什么:原来每切一段就新建一个播放器、再从文件中段 seek,关键帧 5 秒一个,切一次要解上百帧
 * 才出画。真实项目 88.7 秒切 25 次,改前实测交界处出画延迟中位数 200ms 左右。同一个文件内部的
 * 切换在源文件里没有一次是连续的,所以光「按素材复用播放器」没用,那次 seek 省不掉 ——
 * 只能**提前付**:离下一段起点还有 PREROLL_SEC 时,把它装进空着的槽位、seek 到起点停好,
 * 等 requestVideoFrameCallback 说「这一帧画出来了」;到了交界只换显示、让它接着放。
 *
 * 下面是纯函数:给它两个槽位眼下装着什么、当前段和下一段是谁,它说每个槽位该装什么、
 * 哪个在播、哪个在备、这一帧显示哪个。执行在 render/VideoTrack.tsx。
 */

/** 离下一段起点还剩这么久时开始提前装(秒)。实测 1080p、5 秒关键帧的中段 seek 落定要 70~600ms */
export const PREROLL_SEC = 1;
/**
 * 新一段迟迟出不了画(没来得及提前装:片段比 PREROLL_SEC 还短、刚在播放中跳了位置)时,
 * 最多让上一段的最后一帧顶这么久;过了就硬切,别让画面一直停在上一段。
 */
export const NOT_READY_GRACE_SEC = 0.5;
/** 判「首尾相接」的容差:上一段的 end 和这一段的 start 差不到这么多,才能拿上一段的末帧顶班 */
const TOUCH_SEC = 0.05;

/** 槽位能装的一段:只有视频段进槽位,图片段直接画 <img> */
export interface SlotClip {
  id: string;
  url: string;
  start: number;
  end: number;
  /** 素材内起点(mediaOffset) */
  offset: number;
  /** 片段速度(`TrackClip.speed`);缺省 1。这一段占用的素材区间是 offset ~ offset + (end − start) × speed */
  speed?: number;
}

export interface SlotState {
  /** 这个槽位眼下装着哪一段;还没装过是 null */
  clip: SlotClip | null;
  /** 装的这一段已经有一帧画出来了(requestVideoFrameCallback 回调过、时刻落在这一段的素材区间里) */
  ready: boolean;
}

export interface SlotsInput {
  slots: readonly SlotState[];
  /** 上一帧显示的是哪个槽位,没显示是 null */
  shown: number | null;
  /** 这条序列此刻的视频段 */
  cur: SlotClip | null;
  /** 这条序列 t 之后的第一段视频(kernel/project.ts 的 nextVideoLayerAfter) */
  next: SlotClip | null;
  t: number;
  playing: boolean;
  /**
   * 换档预热的名额还有没有(同一页面同时预热的层数有上限,`VideoTrack` 的 `MAX_WARMING`)。
   * 缺省 true。没有名额时上一档接着放,不装新档,等下一次渲染再看。
   */
  canWarm?: boolean;
}

export interface SlotsPlan {
  /** 每个槽位该装哪一段;和 slots[i].clip 一样就是不动,null 表示从没装过 */
  load: (SlotClip | null)[];
  /** 放当前段、跟着播放头走的槽位 */
  active: number | null;
  /** 提前装好下一段、停在起点的槽位 */
  preload: number | null;
  /** 这一帧显示哪个槽位 */
  shown: number | null;
  /**
   * 换档预热的槽位(C6.6 第 4 节「页面换档」):同一片段的新一档装在这里,静音、跟着播放头走,
   * 由调用方确认它交出的帧与画面上那一档对齐到一帧以内(`tierAligned`)才标 ready;ready 了下一次
   * 规划就把它换成 active + shown,一次提交里对调。没有换档时是 null。
   */
  warm: number | null;
}

/** `HTMLMediaElement.NETWORK_NO_SOURCE`(纯函数这里不碰 DOM 常量) */
const NETWORK_NO_SOURCE = 3;

/**
 * 素材服务上刚到齐的那一档:之前按它挂过、加载失败了(404:等待上传方)的元素要重新 `load()` 一次。
 *
 * **这一轮刚换上 src 的元素不算**(`freshSrc`):src 一换,浏览器的资源选择算法当场把 `networkState`
 * 置成 `NETWORK_NO_SOURCE`,看上去和「挂失败了」一样,其实加载才刚开始。换档那一轮恰好就是这种情形
 * (到齐 → 换档地址 → 预热槽位换 src 同一次提交),以前会紧跟着再 `load()` 一次,把刚发出的请求和
 * 刚下的 seek 打断重来,慢网络下换档因此更晚(C6.6 T9-X2)。
 */
export function reloadOnComplete(input: {
  /** 这个槽位装的那一档此刻在素材服务上到齐了 */
  doneNow: boolean;
  /** 到齐之后这个槽位已经判过了(在用时判过、或 src 是到齐后才换上的):到齐之后只判一次 */
  seenBefore: boolean;
  /** 槽位装着东西 */
  hasClip: boolean;
  /** src 是这一轮刚换上的 */
  freshSrc: boolean;
  /**
   * 槽位眼下在用(播当前段、换档预热、备下一段)。缺省 true。闲着的槽位不重载:重载只会和可播性探测抢带宽
   * (跨机 T9 `ht9a0927`,`docs/archive/agent-reports/AGENT-tier-reload-seek.md`);调用方要保证轮到它用时还会再判一次。
   */
  inUse?: boolean;
  /** 元素报了错(`el.error` 非空) */
  error: boolean;
  networkState: number;
}): boolean {
  const { doneNow, seenBefore, hasClip, freshSrc, error, networkState, inUse = true } = input;
  if (!doneNow || seenBefore || !hasClip || freshSrc || !inUse) return false;
  return error || networkState === NETWORK_NO_SOURCE;
}

/**
 * 换档对齐判据(C6.6 第 8 节查资料结论第 4 条):新一档交出的这一帧的 `mediaTime`
 * 与画面上那一档此刻的时刻(暂停时就是目标时刻)差不超过一帧(按项目帧率)才算对齐。
 * 只给微秒级容差吸收浮点误差；超过一帧的差值必须等下一帧再切。
 */
export function tierAligned(mediaTime: number, reference: number, fps: number): boolean {
  if (!Number.isFinite(mediaTime) || !Number.isFinite(reference)) return false;
  const frame = 1 / (fps > 0 ? fps : 30);
  return Math.abs(mediaTime - reference) <= frame + 0.000001;
}

/** 把前台已经交出的帧外推到预热帧的预计显示时刻，再比较两档。 */
export function frontTimeAtDisplay(front: { mediaTime: number; expectedDisplayTime: number }, warmExpectedDisplayTime: number, rate = 1): number {
  // 素材时间按片段速度走:墙钟过去 Δ 秒,素材走 Δ × rate 秒(rate 缺省 1 时和原来逐位相同)
  return front.mediaTime + (warmExpectedDisplayTime - front.expectedDisplayTime) / 1000 * rate;
}

export function planSlots(input: SlotsInput): SlotsPlan {
  const { slots, shown, cur, next, t, playing, canWarm = true } = input;
  const load = slots.map((s) => s.clip);
  // 认槽位要 id **和** url 都相同:同一片段换档(`mediaTier.ts` 的 playbackUrl 换了地址)就是新的一段,
  // 得重新装、重新等出画(A1「换档 = 槽位级的换段」);只比 id 的话新地址永远装不进去
  const holding = (c: SlotClip) => load.findIndex((x) => x?.id === c.id && x?.url === c.url);
  const sameUrl = (url: string) => {
    const i = load.findIndex((c) => c?.url === url);
    return i < 0 ? null : i;
  };

  // ⓪ 换档(C6.6):显示着的槽位装的正是这一段的上一档、而且已经出过画 —— 上一档接着当 active
  //    (播放中继续走、暂停中停在原地),新档装进另一个槽位预热;新档对齐出画了(ready)才对调。
  //    这样换档时画面一直有上一档顶着,不冻、不跳,播放位置不变。
  if (cur && shown !== null && load[shown]?.id === cur.id && load[shown]?.url !== cur.url && slots[shown]?.ready) {
    const other = 1 - shown;
    const warmed = load[other]?.id === cur.id && load[other]?.url === cur.url;
    if (warmed && slots[other]?.ready) {
      // 对齐出画了:一次提交里对调,上一档这一拍起退下
      return { load, active: other, preload: null, shown: other, warm: null };
    }
    if (!warmed && !canWarm) return { load, active: shown, preload: null, shown, warm: null };
    load[other] = cur;
    return { load, active: shown, preload: null, shown, warm: other };
  }

  // ① 当前段放哪个槽位
  let active: number | null = null;
  if (cur) {
    active = holding(cur);
    if (active < 0) {
      if (!playing) {
        // 暂停时随手拖到哪算哪:只用正在显示的那个,和原来一个元素的行为一样。
        // 没显示着的就挑装着同一个文件的(不用重新加载),都没有就 0 号。
        // 例外:显示着的正是这一段的上一档(换档)—— 新档装进另一个,显示着的先顶着,出画了再换
        active = shown !== null && load[shown]?.id === cur.id ? 1 - shown : (shown ?? sameUrl(cur.url) ?? 0);
      } else {
        // 播放中却没提前装好:装进另一个,正在显示的那个先拿末帧顶着(见 ③)
        active = shown !== null ? 1 - shown : (sameUrl(cur.url) ?? 0);
      }
      load[active] = cur;
    }
  }

  // ② 这一帧显示哪个
  let show: number | null = null;
  if (cur && active !== null) {
    const ready = slots[active].clip?.id === cur.id && slots[active].clip?.url === cur.url && slots[active].ready;
    const held = shown !== null && shown !== active ? slots[shown].clip : null;
    if (ready) show = active;
    // 同一片段换档(同一个 id、换了地址):新档出画之前一直让上一档顶着,暂停、播放都一样 ——
    // A1「换档时画面不跳」。url 从不变的时候不会走到这里(同 id 同 url 的槽位 holding 已经认出来了)
    else if (held && held.id === cur.id) show = shown;
    else if (!playing || t - cur.start >= NOT_READY_GRACE_SEC) show = active;
    // 新的一段还没出画:首尾相接的话,让上一段停在最后一帧顶一下,比闪黑或闪一帧别处的旧画面好
    else if (held && Math.abs(cur.start - held.end) < TOUCH_SEC) show = shown;
    // 接不上(中间有空档、或者是跳过来的):和原来新建播放器一样先空着,等它出画
    else show = null;
  }

  // ③ 下一段提前装进另一个槽位 —— 只在播放时做。暂停时拖来拖去,预备槽位跟着来回 seek 只会让
  //    两个解码器一起推翻重来。正在顶班的那个不能拿去装,等新的一段出画再说
  let preload: number | null = null;
  if (playing && next && next.start > t && next.start - t <= PREROLL_SEC) {
    let p = holding(next);
    if (p < 0) p = active !== null ? 1 - active : (sameUrl(next.url) ?? 0);
    if (p !== active && p !== show) {
      load[p] = next;
      preload = p;
    }
  }

  return { load, active, preload, shown: show, warm: null };
}
