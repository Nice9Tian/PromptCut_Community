/**
 * 轨道流清单在内容库里按「8 段一桶」分份的规矩 —— **唯一出处**。写清单的一侧(渲染节点 `server/artifact-transfer.mjs` 的
 * `writeManifest`、浏览器节点 `src/editor/browserNodeHost.ts` 的 `putStreamManifest`、测试用的内存产物库)和查清单的一侧
 * (`createAssetSink` 的去重查找)都从这里算桶的范围,不各算各的。
 *
 * # 规矩
 *
 * 读流的一侧(`src/render/snapshotSource.ts` 的 `streamSpansInWindow`)按层表那一行的 `segmentsPerTask`(8)从第 0 段起每 8 段取一份清单,
 * 最后一份到**整条流的最后一段**为止:`0-7`、`8-15`、…、`56-63`、…、`120-124`。流任务的范围不一定落在桶上(motion 卡满密度至少 60 段
 * 一个任务、稀疏流整条流一个任务),所以写的一侧除了任务自己的键,另按这一规矩写每个桶:
 *
 *   - 桶的起点从 0 起每 `STREAM_BUCKET_SEGMENTS` 段一个;
 *   - 桶的终点 = min(起点 + 7, 整条流的最后一段)。**整条流的最后一段**由这条流的 `originFrame` / `lastFrame` 换算
 *     (`streamSegments.mjs` 的 `streamSegmentOf`),不能拿任务自己的 `range.to` 顶:任务 `[0, 59]` 不是流的末尾时,
 *     它的最后一个桶是 `56-63`(与任务 `[60, 124]` 写的同一个键,两边合并),不是 `56-59`。
 *   - 不知道整条流的最后一段(旧节点落盘的流清单、旧任务没带)时只好用任务的 `range.to`,与改之前一样。
 *
 * 纯函数,不依赖别的模块(只引分段换算);服务端与页面共用这一份。
 */
import { isStreamOrigin, streamSegmentOf } from "./streamSegments.mjs";

/**
 * 一个桶几个分段。与 `server/render-queue/constants.mjs` 的 `QUEUE_DEFAULTS.STREAM_SEGMENTS`、`src/online/pageStreamPlan.ts` 的
 * `PAGE_STREAM_SEGMENTS_PER_TASK`、层表里流那一行的 `segmentsPerTask` 同值
 */
export const STREAM_BUCKET_SEGMENTS = 8;

const isInt = (v) => Number.isInteger(v);

/**
 * 整条流的最后一段:由这条流自己的第一帧 `originFrame` 与最后一帧 `lastFrame`(项目帧号)换算。
 * `span` 可以是任务的 `input.stream`、清单的 `header`,或流库的 `stream.json`。缺一项、形状不对回 null(不猜)。
 */
export function streamLastSegmentOf(span) {
  const originFrame = span?.originFrame, lastFrame = span?.lastFrame;
  if (!isStreamOrigin(originFrame) || !isInt(lastFrame) || lastFrame < originFrame) return null;
  return streamSegmentOf(lastFrame, originFrame);
}

/**
 * 范围 `[from, to]` 碰到的桶:`[{ from, to }]`,按起点升序。`lastSegment` 是整条流的最后一段(`streamLastSegmentOf`);
 * 给 null、或比 `to` 还小(对不上)时按 `to` 截。写的一侧对其中与任务自己的范围不同的每个桶另写一份(相同的那个就是任务自己的键)。
 */
export function streamBucketRanges(from, to, lastSegment = null) {
  if (!isInt(from) || !isInt(to) || from < 0 || to < from) return [];
  const last = isInt(lastSegment) && lastSegment >= to ? lastSegment : to;
  const out = [];
  for (let b = Math.floor(from / STREAM_BUCKET_SEGMENTS) * STREAM_BUCKET_SEGMENTS; b <= to; b += STREAM_BUCKET_SEGMENTS) {
    out.push({ from: b, to: Math.min(last, b + STREAM_BUCKET_SEGMENTS - 1) });
  }
  return out;
}

/**
 * 一份流清单(`StreamResult`)切出落在桶 `bucket` 里的那几段:其余字段照抄,`range` 换成桶的范围,
 * `segments` 只留桶里的分段,`inits` 只留这些分段用到的开头文件。
 */
export function streamBucketManifest(manifest, bucket) {
  const segments = {}, inits = {};
  const segMap = manifest?.segments ?? {}, initMap = manifest?.inits ?? {};
  for (let n = bucket.from; n <= bucket.to; n++) {
    const seg = segMap[n] ?? segMap[String(n)];
    if (!seg) continue;
    segments[n] = seg;
    if (seg.init && initMap[seg.init]) inits[seg.init] = initMap[seg.init];
  }
  return { ...manifest, range: { from: bucket.from, to: bucket.to }, inits, segments };
}
