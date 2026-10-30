/**
 * 素材元素(`<video>` / `<audio>`)跟播放头对齐的执行面(E7 第 1 条)。
 *
 * 「这一帧该做什么」是纯函数,在 `mediaSync.ts`;这里只负责把元素的读数递过去,
 * 再把结果照着执行,并记住每个元素**最新的**目标(seek 落定、拖动节流到点时要用)。
 *
 * # 为什么在 `src/render/` 而不是 `src/editor/`
 *
 * 素材层要搬进舞台 iframe(E7):`VideoTrack` 在舞台里渲,它和 `MediaLayers`(主文档,
 * 只剩音频)共用这一份驱动。放在 `render/` 下两边都能 import,而舞台 bundle 不会因此
 * 带上编辑器模块 —— 这里一个 `src/editor/**` 都不 import。
 *
 * 音频路由(`audio/previewAudio.ts`)**不在这里**:它是编辑器主文档的事,舞台恒 `muted`。
 */
import { emphasisFilter } from "../kernel/emphasis";
import { clipFilterOpsAt, cssFilter, type FilterDef } from "../kernel/filters.mjs";
import type { TrackClip } from "../kernel/project";
import { mediaTimeAt } from "../kernel/clipTime.mjs";
import { planSync } from "./mediaSync";

/** 上一次由我们发起的纠偏 seek 的时刻,按元素记 */
export const lastSeekAt = new WeakMap<HTMLMediaElement, number>();

/** 一个元素眼下该对齐到哪儿 */
export interface Want {
  target: number;
  playing: boolean;
  volume: number;
  scrubbing: boolean;
  /** 基准播放速率 = 片段速度(`TrackClip.speed`,缺省 1);纠偏的 ±10% 在它上面浮动 */
  rate?: number;
}
/**
 * 每个元素**最新的**「想去哪」。seek 落定、拖动节流到点时拿它再判一次;
 * 没有条目 = 这个元素眼下没人驱动(备用槽位、顶班的末帧),落定了也不补。
 */
const wants = new WeakMap<HTMLMediaElement, Want>();
const retryTimers = new WeakMap<HTMLMediaElement, number>();
const hooked = new WeakSet<HTMLMediaElement>();

/**
 * 真墙钟。舞台文档里 `performance.now` 被 `stageClock` 换成了虚拟时间(恒等于舞台毫秒),
 * 拿它算 seek 冷却会得出「永远没过冷却」或「一直过了冷却」——素材层跟的是墙钟,不是虚拟时间。
 * `setTimeout` 同理:E4b 之后它是登记在虚拟时钟上的 fake timer,暂停态一辈子不响。
 */
const realNow = (): number => (window.__pcRealNow ?? performance.now.bind(performance))();
const realTimeout = (fn: () => void, ms: number): number =>
  (window.__pcRealSetTimeout ?? window.setTimeout.bind(window))(fn, ms);

/** 把一个 media 元素对齐到时间轴 */
export function syncMediaEl(el: HTMLMediaElement, want: Want) {
  const v = Math.max(0, Math.min(1, want.volume));
  if (el.volume !== v) el.volume = v;

  const plan = planSync({
    elTime: el.currentTime,
    seeking: el.seeking,
    paused: el.paused,
    ended: el.ended,
    target: want.target,
    baseRate: want.rate,
    playing: want.playing,
    scrubbing: want.scrubbing,
    now: realNow(),
    lastSeekAt: lastSeekAt.get(el) ?? 0,
  });

  if (plan.rate !== null && el.playbackRate !== plan.rate) el.playbackRate = plan.rate;
  if (plan.seekTo !== null) {
    el.currentTime = plan.seekTo;
    lastSeekAt.set(el, realNow());
  }
  if (plan.pause) el.pause();
  if (plan.play) el.play().catch(() => {});

  // 拖动时被节流压下的那次 seek 必须补:手停住以后不会再有新的渲染来触发同步
  window.clearTimeout(retryTimers.get(el));
  if (plan.retryInMs !== null) {
    retryTimers.set(el, realTimeout(() => {
      const w = wants.get(el);
      if (w) syncMediaEl(el, w);
    }, plan.retryInMs));
  }
}

/** 让一个元素跟着播放头走:记下最新目标,立刻判一次 */
export function driveMedia(el: HTMLMediaElement | null, want: Want) {
  if (!el) return;
  wants.set(el, want);
  if (!hooked.has(el)) {
    hooked.add(el);
    /*
     * seek 落定后拿最新目标再判一次。planSync 在 seeking 期间一律不下新指令(那时 currentTime
     * 读的是目标值,拿它算偏差会把刚发的 seek 推翻),代价是这期间来的新位置被丢掉 ——
     * 以前没有这一步,拖动的最后一下恰好落在 seek 中间,画面就永远停在旧的一帧。
     */
    el.addEventListener("seeked", () => {
      const w = wants.get(el);
      if (w) syncMediaEl(el, w);
    });
    /*
     * 元数据到了(换了 src、被 `load()` 重载、或元数据迟到)也拿最新目标再判一次。readyState 为 0 时设的
     * currentTime 只是「默认起播位置」,`load()` 之后留不留得住看浏览器;暂停中之后可能再没有渲染来调 driveMedia,
     * 不补这一下元素就停在 0(`docs/archive/agent-reports/AGENT-tier-reload-seek.md`)。浏览器已按默认起播位置 seek 过去时
     * 这里读到 seeking / 已对齐,什么都不做。
     */
    el.addEventListener("loadedmetadata", () => {
      const w = wants.get(el);
      if (w) syncMediaEl(el, w);
    });
  }
  syncMediaEl(el, want);
}

/** 这个元素眼下不跟播放头了(备用、顶班):停下,落定了也不再补 seek */
export function releaseMedia(el: HTMLMediaElement | null) {
  if (!el) return;
  wants.delete(el);
  window.clearTimeout(retryTimers.get(el));
  if (!el.paused) el.pause();
}

/** 播放头换算到这段素材上的时刻(`kernel/clipTime.mjs`,含片段速度) */
export function targetTimeOf(clip: TrackClip, t: number) {
  return mediaTimeAt(clip, t);
}

/**
 * 素材层元素上的 filter:先滤镜(kernel/filters.mjs,和导出、see_frames 同一份数值)、后强调的 drop-shadow ——
 * 影子是调过色的画面投下的,和导出链上「先滤镜、后强调」一个顺序。强调和舞台那边同一份计算(kernel/emphasis.ts)。
 * 元素在片段的框里、外面整体 transform 缩放,所以 blur 写的是框内像素(落到画布上要乘 frame.scale,导出那边 blurScale = p.scale 一致)。两样都没有就不写这个属性。
 */
export function filterOf(clip: TrackClip, filters: FilterDef[] | undefined, t: number): string | undefined {
  const ops = filters?.length ? clipFilterOpsAt({ filters }, clip, t) : null;
  const parts = [ops ? cssFilter(ops) : "", emphasisFilter(clip.emphasis) || ""].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}
