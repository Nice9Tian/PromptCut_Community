/**
 * 轨道流的分段换算 —— **唯一出处**。产流的一侧(预渲染进程、渲染服务、任务队列的切分与认领、浏览器节点、本页产流)和
 * 读流的一侧(舞台播放、父页选流平面、在线页面取清单和字节)都从这里算「这一帧在第几个分段、第几个样本」,不各算各的。
 *
 * # 规则(2026-10-13 用户定:`docs/plan/html-snapshot-removal-dryrun.md` 第 10.5 节)
 *
 * 分段从**这条流自己的第一帧**(`originFrame`,项目帧号)起每 `STREAM_SEGMENT_FRAMES` 帧一段,不再从项目的第 0 帧起:
 *
 *   - 单卡流:第一帧是片段在时间轴上的第一帧(卡的本地帧 0);
 *   - 组流:第一帧是成员里最早的那个第一帧;
 *   - 依赖下层的流:第一帧是目标卡的第一帧。
 *
 * 片段从第 100 帧开始:第 0 段是第 100～114 帧,第 1 段是第 115～129 帧……分段号恒从 0 起。
 * 最后一个分段到**这条流自己的最后一帧**为止(不是项目的最后一帧),可以不满 15 帧。
 * 早于第一帧的帧没有分段(`streamSegmentOf` 回负数,就绪区间里不会有它)。
 *
 * 所以「分段号、每段几帧」只由这条流有多少帧决定,和它摆在时间轴的哪里无关;它在时间轴上的位置只剩 `originFrame` 这一个数,
 * 由计划的一侧按当前项目给出(流的计划 → 就绪消息 / 层表的行 → 读的一侧)。
 *
 * 纯函数,不依赖别的模块;服务端与页面共用这一份。
 */

/** 一个分段的帧数(G2);`server/bakery/ffmpeg.mjs` 的 `STREAM_SEGMENT_FRAMES` 与它同值(守门单测核对) */
export const STREAM_SEGMENT_FRAMES = 15;

/** 能不能当一条流的第一帧:非负整数 */
export function isStreamOrigin(value) {
  return Number.isInteger(value) && value >= 0;
}

/** 项目帧号 → 这条流的分段号;早于第一帧的回负数 */
export function streamSegmentOf(frame, originFrame) {
  return Math.floor((frame - originFrame) / STREAM_SEGMENT_FRAMES);
}

/** 这个分段的第一帧(项目帧号) */
export function streamSegmentFirstFrame(segment, originFrame) {
  return originFrame + segment * STREAM_SEGMENT_FRAMES;
}

/** 这个分段的最后一帧(项目帧号),截到这条流自己的最后一帧 `lastFrame`;不给 `lastFrame` 就是满的一段 */
export function streamSegmentLastFrame(segment, originFrame, lastFrame = Infinity) {
  return Math.min(streamSegmentFirstFrame(segment, originFrame) + STREAM_SEGMENT_FRAMES - 1, lastFrame);
}

/** 这个分段有几帧(也就是它的样本数);整段都在流的最后一帧之后回 0 */
export function streamSegmentFrameCount(segment, originFrame, lastFrame = Infinity) {
  return Math.max(0, streamSegmentLastFrame(segment, originFrame, lastFrame) - streamSegmentFirstFrame(segment, originFrame) + 1);
}

/**
 * 这一帧所在分段的第一帧(项目帧号)。稀疏版每个分段只截这一张、其余帧重复它;最低一档
 * 不管那一段是稀疏还是满密度,都只解这一张来贴(`streamPlayer.ts` 的 `presentFirst`)。早于流的第一帧的帧回的也早于第一帧。
 */
export function streamFirstFrameOf(frame, originFrame) {
  return streamSegmentFirstFrame(streamSegmentOf(frame, originFrame), originFrame);
}

/** 这一帧在它所在分段里是第几个样本(0 起) */
export function streamSampleOf(frame, originFrame) {
  return frame - streamSegmentFirstFrame(streamSegmentOf(frame, originFrame), originFrame);
}

/**
 * 一条盖住项目帧 `firstFrame .. lastFrame` 的流怎么分段:`{ originFrame, firstSegment, lastSegment }`。
 * `firstSegment` 恒为 0(留着这个字段是因为流的计划、切分、推送都按「从 firstSegment 到 lastSegment」走)。
 */
export function streamSegmentSpan(firstFrame, lastFrame) {
  const originFrame = Math.max(0, Math.floor(Number(firstFrame) || 0));
  return { originFrame, firstSegment: 0, lastSegment: Math.max(0, streamSegmentOf(Math.max(originFrame, lastFrame), originFrame)) };
}
