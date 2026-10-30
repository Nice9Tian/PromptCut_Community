/**
 * 按时刻求一条绑定轨迹的当前位移。
 *
 * 舞台和导出都走这一个函数：导出是逐帧离线渲染的，预览是实时的，两边算出
 * 不同的位置会让导出的成品和预览对不上，而那种偏差很难查——看上去两边都
 * "在动"，只是不一样。
 */
import type { ClipMotion } from "./types";
import { mediaSpanOf, mediaTimeAt, timelineSpanOf } from "./clipTime.mjs";

export interface BuildMotionInput {
  /** 轨迹：逐帧的**素材原始像素**坐标，覆盖整段素材 */
  xy: [number, number][];
  visible: boolean[];
  /** 素材的原始尺寸和时长 */
  media: { id: string; width: number; height: number; duration: number };
  /** 舞台尺寸 */
  stage: { width: number; height: number };
  /** 卡片段在时间轴上的区间（秒） */
  card: { start: number; end: number };
  /** 提供画面的那个素材段：它在时间轴上的起点，它从素材第几秒开始播，以及片段速度（缺省 1，见 kernel/clipTime.mjs） */
  clipOfMedia: { start: number; mediaOffset: number; speed?: number };
  pointIndex: number;
  whenHidden: "hold" | "hide";
}

export interface BuildMotionResult {
  motion: ClipMotion;
  /** 给调用方（和 AI）看的摘要，不进项目文档 */
  summary: {
    frames: number;
    visibleFrames: number;
    /** 位移范围（舞台像素），用来判断这条绑定是不是白绑 */
    rangeX: number;
    rangeY: number;
  };
}

/**
 * 把一条追踪轨迹算成某个卡片段的跟随数据。
 *
 * 三件事在这里一次算清，播放时就不用再管：
 *
 * 1. **时间对齐**。卡片段和素材段是时间轴上两段独立的东西，卡片可能只压在
 *    素材的中间一小截，素材自己还可能带 mediaOffset。轨迹按素材帧号索引，
 *    不对齐的话卡片会跟着「另一个时刻」的目标走——那种错位看起来像是追歪了，
 *    很难想到是时间对不上。
 * 2. **坐标换算**。轨迹是素材原始像素，舞台是项目像素，视频层按 cover 铺满。
 *    只取位移的话居中裁切的偏移正好抵消，剩下一个 max 缩放。
 * 3. **锚点归零**。存位移而不是绝对位置，卡片才能留在设计时摆的地方。
 *    锚点取切片里**第一个可见帧**：如果卡片正好从目标被挡的时刻开始，
 *    拿那一帧的外推坐标当锚点会让整条轨迹整体偏移。
 */
export function buildClipMotion(input: BuildMotionInput): BuildMotionResult {
  const { xy, visible, media, stage, card, clipOfMedia, pointIndex, whenHidden } = input;
  const total = xy.length;
  if (total === 0) throw new Error("这条轨迹是空的");
  if (!(media.duration > 0)) throw new Error(`素材 ${media.id} 没有时长，无法把轨迹对到时间轴上`);
  if (!(media.width > 0) || !(media.height > 0)) {
    throw new Error(`素材 ${media.id} 没有分辨率，无法把轨迹换算到画面坐标`);
  }

  const frameStep = media.duration / total;
  // 卡片起点那一刻，画面正在播素材的第几秒（含片段速度，kernel/clipTime.mjs）
  const mediaTimeAtStart = mediaTimeAt(clipOfMedia, card.start);
  const i0 = Math.max(0, Math.min(total - 1, Math.round(mediaTimeAtStart / frameStep)));
  // 卡片这段时长覆盖多少素材：变速段按倍率折算（缺省 1 时 × 1 逐位不变）
  const need = Math.ceil(mediaSpanOf(clipOfMedia, card.end - card.start) / frameStep) + 1;
  const i1 = Math.min(total, i0 + Math.max(need, 1));

  const sliceXy = xy.slice(i0, i1);
  const sliceVis = visible.slice(i0, i1);
  if (sliceXy.length === 0) throw new Error("卡片段落在这条轨迹的范围之外");

  const scale = Math.max(stage.width / media.width, stage.height / media.height);
  const anchorIdx = Math.max(0, sliceVis.findIndex(Boolean));
  const [ax, ay] = sliceXy[anchorIdx];

  const r1 = (v: number) => Math.round(v * 10) / 10; // 存到 0.1 像素，够用且省一半体积
  const offsets = sliceXy.map(([x, y]) => [r1((x - ax) * scale), r1((y - ay) * scale)] as [number, number]);

  const xs = offsets.map((o) => o[0]);
  const ys = offsets.map((o) => o[1]);
  return {
    motion: {
      mediaId: media.id,
      pointIndex,
      offsets,
      visible: sliceVis,
      // 存的是时间轴上相邻两点隔几秒（播放时按卡片本地时间 / frameStep 取点）：变速段素材步长除以倍率
      frameStep: timelineSpanOf(clipOfMedia, frameStep),
      whenHidden,
    },
    summary: {
      frames: offsets.length,
      visibleFrames: sliceVis.filter(Boolean).length,
      rangeX: r1(Math.max(...xs) - Math.min(...xs)),
      rangeY: r1(Math.max(...ys) - Math.min(...ys)),
    },
  };
}

export interface MotionAt {
  dx: number;
  dy: number;
  /** 该时刻目标是否可见。whenHidden 为 hide 时调用方据此跳过渲染 */
  visible: boolean;
}

/**
 * @param local clip 内部的秒数（t - clip.start）
 */
export function motionAt(motion: ClipMotion, local: number): MotionAt {
  const { offsets, visible, frameStep, whenHidden } = motion;
  const n = offsets.length;
  if (n === 0) return { dx: 0, dy: 0, visible: true };

  const pos = local / (frameStep || 1 / 30);
  // 夹在两端而不是让它跑出去：clip 比轨迹长的时候，超出的部分停在最后一帧，
  // 总比突然跳回原点或者外推到画面外要好。
  const i0 = Math.max(0, Math.min(n - 1, Math.floor(pos)));
  const i1 = Math.max(0, Math.min(n - 1, i0 + 1));
  const f = i0 === i1 ? 0 : Math.max(0, Math.min(1, pos - i0));

  const seen = !!visible[i0];
  if (!seen && whenHidden === "hold") {
    // 停在最后一次看见的位置。往回找而不是用当前帧的外推值——外推值是猜的，
    // 猜错时卡片会朝着目标本来没去的方向漂走，比停住难看得多。
    for (let k = i0; k >= 0; k--) {
      if (visible[k]) return { dx: offsets[k][0], dy: offsets[k][1], visible: false };
    }
    return { dx: 0, dy: 0, visible: false };
  }

  // 两帧之间线性插值：素材 25fps、项目 30fps 这种情况下不插值会一顿一顿的
  const a = offsets[i0];
  const b = offsets[i1];
  return {
    dx: a[0] + (b[0] - a[0]) * f,
    dy: a[1] + (b[1] - a[1]) * f,
    visible: seen,
  };
}
