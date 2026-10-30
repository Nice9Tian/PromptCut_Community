/**
 * 单舞台「停下追当前一帧」(语义 `product/rendering.md`「停下就精确」、`product/platforms.md`「在线浏览器」的「停下」与
 * 「最低一档」;机制 `mechanism/rendering.md`「界限搜索与成本记录」的「停下追一帧」):只有一个舞台(舞台闸门第一级、
 * 最低一档、握手失败退回单舞台)时没有后台舞台可以追到精确再互换,暂停、点击或拖动松开、播放到头时就在可见舞台里
 * 把当前这一帧的所有卡活渲一次,重卡也画。
 *
 * - 画出来之前各层照兜底顺序显示(有轨道流贴流,没有就是占位符),画好一层替换一层;
 * - **不设时限**(2026-10-07 用户定,最低一档「停下以后……渲好一层替换一层,不设时限」):一直画到全部画好,
 *   或被新的跳转 / 播放 / 换项目打断为止。`timeoutMs` 只留给测试与诊断(给了正数才按它截);
 * - 推帧卡按从入点追到当前帧算;
 * - 本页跑不了的用户卡、素材效果卡不追(`localOnlyClipIds`):有这一帧的预渲染结果就照贴,没有就是沙漏、等渲染节点
 *   (2026-10-21 用户定:没有「本地 PC 辅助渲染」的提示);
 * - 下一次播放回到播放时的样子(最低一档只贴预渲染结果)。
 *
 * 这里只放纯的部分(排序、驱动、结果形状),舞台一侧的画法在 `StageView` 的 `settleLayers`。
 * 不引 editor,Node 单测直接载入。
 */

/** 给了时限时的上界(父页传进来的值夹在这里;不给 = 不设时限) */
export const SETTLE_MAX_MS = 60_000;
/** 不设时限时父页等回包的上限(活着的窗口原地重载会丢回包,不能永远挂着;舞台那边照画不误) */
export const SETTLE_RPC_CAP_MS = 10 * 60_000;

/** 一张卡怎么追:直接定位(一次提交就画好)、从入点逐帧推、这台设备渲染不了(不追) */
export type SettleKind = "direct" | "catchup" | "unsupported";

export interface SettleItem {
  clipId: string;
  kind: SettleKind;
  /** 推帧卡要从入点推多少帧(直接定位的是 0) */
  frames: number;
}

/** 一次停下追一帧的结果(舞台 RPC `settleLayers` 的回包,父页记进诊断) */
export interface SettleResult {
  /** false:被新的跳转 / 播放 / 换项目打断了,或者舞台做不了(`reason`) */
  ok: boolean;
  reason?: "superseded" | "role" | "no-project" | "rpc";
  sec: number;
  /** 这一次的时限;null = 不设时限 */
  timeoutMs: number | null;
  /** 从开始追到收尾的墙钟 */
  ms: number;
  /** 画好的层,和它画好时离开始多久 */
  drawn: { clipId: string; ms: number }[];
  /** 给了时限时到时限还没画好、维持兜底的层;被打断时还没画的层也记在这里 */
  timedOut: string[];
  /** 不追的层(本页跑不了的用户卡、素材效果卡:贴着预渲染结果,没有就是沙漏) */
  skipped: string[];
}

/** 父页给的时限:不是正数(含不给)就是不设时限(null),超过上界夹到上界 */
export function clampSettleTimeout(ms: unknown): number | null {
  if (ms === null || ms === undefined) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(SETTLE_MAX_MS, Math.floor(n));
}

/**
 * 这张卡怎么追。`unsupported`(本页跑不了的用户卡、素材效果卡)不追;`direct` 帧模式或者播放头就在入点上的,一次提交就画好;
 * 其余从入点逐帧推到当前帧。
 */
export function settleKindOf(o: { unsupported: boolean; frameMode: string | undefined; mountFrame: number; targetFrame: number }): SettleItem["kind"] {
  if (o.unsupported) return "unsupported";
  if (o.frameMode === "direct" || o.targetFrame <= o.mountFrame) return "direct";
  return "catchup";
}

/**
 * 追的先后:直接定位的先(一次提交就画好),推帧卡按要推的帧数从少到多 —— 先画好的层尽量多、尽早替换上去。
 * 同样的按 clipId 定序。`unsupported` 的不进队列,单列出来。
 */
export function orderSettle(items: readonly SettleItem[]): { queue: SettleItem[]; skipped: string[] } {
  const queue = items.filter((it) => it.kind !== "unsupported");
  const skipped = items.filter((it) => it.kind === "unsupported").map((it) => it.clipId).sort();
  const rank = (it: SettleItem) => (it.kind === "direct" ? 0 : 1);
  queue.sort((a, b) => rank(a) - rank(b) || a.frames - b.frames || (a.clipId < b.clipId ? -1 : a.clipId > b.clipId ? 1 : 0));
  return { queue, skipped };
}

/** 画一层的结果:画好了、到时限了、被打断了 */
export type DrawOutcome = "drawn" | "timeout" | "aborted";

/**
 * 按 `orderSettle` 的先后一层层画。不设时限时 `deadline` 是 `Infinity`,画到全部画好或被打断;给了时限时
 * (`draw` 自己也看 `deadline`,推帧推到一半到时限就回 `timeout`)到时限还没开始画的层一并记进 `timedOut`。
 * 被打断(`aborted()` 或 `draw` 回 `aborted`)时回 `ok: false`,没画的层同样记进 `timedOut`(舞台一侧它们本来就还盖着)。
 */
export async function runSettle(o: {
  sec: number;
  items: readonly SettleItem[];
  /** 不给 / null = 不设时限 */
  timeoutMs?: number | null;
  now: () => number;
  draw: (item: SettleItem, deadline: number) => Promise<DrawOutcome>;
  aborted?: () => boolean;
}): Promise<SettleResult> {
  const started = o.now();
  const timeoutMs = clampSettleTimeout(o.timeoutMs);
  const deadline = timeoutMs === null ? Infinity : started + timeoutMs;
  const { queue, skipped } = orderSettle(o.items);
  const drawn: SettleResult["drawn"] = [];
  const timedOut: string[] = [];
  const finish = (ok: boolean, rest: SettleItem[] = []): SettleResult => {
    for (const it of rest) timedOut.push(it.clipId);
    return { ok, ...(ok ? {} : { reason: "superseded" as const }), sec: o.sec, timeoutMs, ms: o.now() - started, drawn, timedOut, skipped };
  };
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (o.aborted?.()) return finish(false, queue.slice(i));
    if (o.now() >= deadline) return finish(true, queue.slice(i));
    const outcome = await o.draw(item, deadline);
    if (outcome === "drawn") drawn.push({ clipId: item.clipId, ms: o.now() - started });
    else if (outcome === "timeout") timedOut.push(item.clipId);
    else return finish(false, queue.slice(i));
  }
  return finish(true);
}
