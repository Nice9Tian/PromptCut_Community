/**
 * 运动追踪的前端胶水：起作业、轮询、拿轨迹。
 *
 * 两档都跑在服务端：装了拓展走 BootsTAPIR，没装走 numpy 的模板匹配兜底。
 * 这边只负责起作业、等结果、存结果。
 * 和镜头识别不同，轨迹**不写进项目文档**：查询点是用户每次现指的，同一段素材
 * 可以追很多组点，塞进 project 只会让工程文件无限膨胀。所以结果留在内存里，
 * 由 right/index.tsx 的 Map 持有，够 get_track 取一次就行。
 */

import { readSseStream } from "../editor/io/stt";
import type { PerceptionMediaRef } from "./perceptionMedia";

export interface TrackPoint {
  /** 用户指定的查询点 [帧号, x, y]，原始像素 */
  query: [number, number, number];
  /** 逐帧坐标，原始像素 */
  xy: [number, number][];
  /** 逐帧是否可见。被遮挡或移出画面为 false，此时 xy 是模型的猜测 */
  visible: boolean[];
  /**
   * 这个点压根没追成，兜底档才会给（纹理不够、贴太靠边）。
   * 给了 note 就说明整条 xy 都是占位，visible 也全是 false——别拿去绑卡片。
   */
  note?: string;
}

export interface TrackJobState {
  status: "running" | "done" | "error";
  /** 作业跑完前是 undefined —— 哪一档由 Python 侧选，结果回来才知道 */
  engine?: "bootstapir" | "template";
  percent: number;
  message?: string;
  width?: number;
  height?: number;
  frames?: number;
  points?: TrackPoint[];
}

export interface TrackResult {
  engine: "bootstapir" | "template";
  createdAt: string;
  width: number;
  height: number;
  frames: number;
  points: TrackPoint[];
}

/**
 * 能追到哪一档。
 *
 * ready 只说神经网络那档。**ready 为 false 不等于追不了**：没装拓展时还有
 * numpy 的模板匹配（engine = "template"），精度和鲁棒性差不少但能跑。
 * engine 为 null 才是真的两档都用不了（连 Python 都没有）。
 */
export async function trackStatus(): Promise<{
  ready: boolean;
  engine: "bootstapir" | "template" | null;
  reason?: string;
  detail?: unknown;
}> {
  const r = await fetch("/api/track/status");
  if (!r.ok) throw new Error("查不到运动追踪拓展的状态");
  return r.json();
}

/** 只发素材标识,服务端经素材服务取字节(见 perceptionMedia.ts) */
export async function startTracking(
  media: PerceptionMediaRef,
  points: number[][],
): Promise<string> {
  const r = await fetch("/api/track/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId: media.id, media, points }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "运动追踪没能启动");
  return data.jobId as string;
}

export async function pollTrackJob(jobId: string): Promise<TrackJobState> {
  const r = await fetch(`/api/track/job/${jobId}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "查不到这个追踪作业");
  return data.job as TrackJobState;
}

/**
 * 等一个作业跑完。轮询间隔 1 秒 —— 神经网络档 250 帧约 26 秒，
 * 兜底档同样帧数 1 秒出头，两档共用这一个节奏就够。
 */
export async function waitForTrack(
  jobId: string,
  onProgress?: (pct: number, engine: TrackResult["engine"] | undefined) => void,
): Promise<TrackResult> {
  for (;;) {
    const job = await pollTrackJob(jobId);
    onProgress?.(job.percent, job.engine);
    if (job.status === "error") throw new Error(job.message || "运动追踪失败");
    if (job.status === "done") {
      return {
        // 作业跑完却没报 engine，只可能是 Python 侧的 result 事件缺字段。
        // 认成 template 是**保守**的那一侧：调用方会据此提醒「这是降级结果，
        // 别太当真」，反过来误标成 bootstapir 会让人拿粗结果当准数据。
        engine: job.engine ?? "template",
        createdAt: new Date().toISOString(),
        width: job.width ?? 0,
        height: job.height ?? 0,
        frames: job.frames ?? 0,
        points: job.points ?? [],
      };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * 装运动追踪拓展（torch + BootsTAPIR 权重，接近 400 MB）。
 *
 * 流式读 pip 日志而不是等它跑完再回：这一步要好几分钟，中间一声不吭的话
 * 谁也说不清是在装还是卡死了。
 */
export async function installTrack(
  onLog?: (line: string) => void,
): Promise<{ ok: boolean; needsModel: boolean; modelPath?: string; log: string[] }> {
  const res = await fetch("/api/track/install", { method: "POST" });
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `/api/track/install 返回 ${res.status}`);
  }
  const log: string[] = [];
  let ok = true;
  let needsModel = false;
  let modelPath: string | undefined;
  await readSseStream(res.body, (ev) => {
    if (ev.event === "log") {
      const line = ev.line ?? ev.data ?? "";
      log.push(line);
      onLog?.(line);
    } else if (ev.event === "installed") {
      // 依赖装完了,但BootsTAPIR的权重不在 requirements 里,只随拓展库包发。
      // 这不是失败,是「还差一步」,得和真正的安装失败分开报。
      needsModel = !!ev.needsModel;
      // SttEvent 里的 model 是听写的模型名(string),和这里的对象同名不同型,
      // 就地窄化一下,不去动那个共用的事件类型
      modelPath = (ev as unknown as { model?: { path?: string } }).model?.path;
    } else if (ev.event === "error") {
      ok = false;
      // stderr 里才是有用的那句(pip 的真实报错、缺什么文件),message 往往只是
      // 「进程退出码 N」。只取 message 的话,用户看到的永远是一句没法照着做的话。
      const msg = ev.message ?? "安装失败";
      const detail = typeof ev.stderr === "string" ? ev.stderr.trim() : "";
      const full = detail ? `${msg}
${detail}` : msg;
      log.push("[error] " + full);
      onLog?.("[error] " + full);
    }
  });
  return { ok, needsModel, modelPath, log };
}
