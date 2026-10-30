/**
 * 镜头切换识别的前端胶水：起作业、轮询、把结果写进 store。
 *
 * 检测跑在服务端（TransNetV2 或 scdet 兜底），这边只负责等和存。
 */
import { readSseStream } from "../editor/io/stt";
import type { PerceptionMediaRef } from "./perceptionMedia";
import type { Shots } from "../kernel/project";

export interface ShotsJobState {
  status: "running" | "done" | "error";
  engine: "transnetv2" | "scdet";
  percent: number;
  message?: string;
  transitions?: Shots["transitions"];
  shots?: Shots["shots"];
}

/** 拓展装没装。没装也能用，只是退回 scdet、认不出溶解。 */
export async function shotsStatus(): Promise<{ ready: boolean; engine: string; detail?: unknown }> {
  const r = await fetch("/api/shots/status");
  if (!r.ok) throw new Error("查不到镜头识别拓展的状态");
  return r.json();
}

/** 只发素材标识,服务端经素材服务取字节(见 perceptionMedia.ts) */
export async function startShotDetection(media: PerceptionMediaRef): Promise<string> {
  const r = await fetch("/api/shots/detect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId: media.id, media }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "镜头识别没能启动");
  return data.jobId as string;
}

export async function pollShotJob(jobId: string): Promise<ShotsJobState> {
  const r = await fetch(`/api/shots/job/${jobId}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "查不到这个检测作业");
  return data.job as ShotsJobState;
}

/** 等一个作业跑完。检测 5 分钟素材约 36 秒，所以轮询间隔给 1 秒。 */
export async function waitForShots(jobId: string, onProgress?: (pct: number, engine: string) => void): Promise<Shots> {
  for (;;) {
    const job = await pollShotJob(jobId);
    onProgress?.(job.percent, job.engine);
    if (job.status === "error") throw new Error(job.message || "镜头识别失败");
    if (job.status === "done") {
      return {
        engine: job.engine,
        createdAt: new Date().toISOString(),
        transitions: job.transitions ?? [],
        shots: job.shots ?? [],
      };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * 装镜头识别拓展（onnxruntime + TransNetV2 权重）。
 *
 * 服务端的 `/api/shots/install` 一直都在，缺的只是这个客户端函数 —— 于是
 * 开始页那张卡只能干看着状态、没有安装入口。和 installTrack 一样流式读
 * pip 日志：这一步要等好几十秒，中间不出声的话分不清是在装还是卡死了。
 */
export async function installShots(
  onLog?: (line: string) => void,
): Promise<{ ok: boolean; needsModel: boolean; modelPath?: string; log: string[] }> {
  const res = await fetch("/api/shots/install", { method: "POST" });
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `/api/shots/install 返回 ${res.status}`);
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
      // 依赖装完了,但TransNetV2的权重不在 requirements 里,只随拓展库包发。
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
