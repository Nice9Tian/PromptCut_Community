/**
 * 主体检测的前端胶水：查档位、起作业、轮询、把结果折成 Subjects。
 *
 * 检测跑在服务端（YuNet + RT-DETR，装了 full 档再加 Grounding DINO），这边只
 * 负责等和存。和运动追踪不同的是：结果**要写进项目文档**（MediaAsset.subjects）。
 * 采样时刻是按镜头算出来的、对同一段素材是稳定的，存下来下次就不用重跑；
 * 而追踪的查询点每次现指，存了只会让工程文件无限膨胀。
 */
import { readSseStream } from "../editor/io/stt";
import type { PerceptionMediaRef } from "./perceptionMedia";
import type { Subjects, SubjectSample } from "../kernel/project";

export interface SubjectJobState {
  status: "running" | "done" | "error";
  /** 作业跑完前是 undefined —— 哪一档由 Python 侧选，结果回来才知道 */
  engine?: "light" | "full";
  percent: number;
  message?: string;
  width?: number;
  height?: number;
  prompt?: string;
  samples?: SubjectSample[];
  /** 抽帧失败的采样个数。undefined = 服务端没报(老版本),和 0 不是一回事 */
  failedCount?: number;
  /** 本来要跑 full、中途退回 light 时是 "full" */
  fellBackFrom?: "full";
  fallbackReason?: string;
}

/**
 * 能跑到哪一档。
 *
 * **没有兜底档**：engine 为 null 就是真的检测不了（没装依赖或没有 Python），
 * 这一点和运动追踪不一样。调用方遇到 null 要退回「看图判断」，
 * 不要假装还有一个降级引擎在跑。
 */
export async function subjectStatus(): Promise<{
  ready: boolean;
  engine: "light" | "full" | null;
  reason?: string;
  detail?: unknown;
}> {
  const r = await fetch("/api/subject/status");
  if (!r.ok) throw new Error("查不到主体检测拓展的状态");
  return r.json();
}

/** 只发素材标识,服务端经素材服务取字节(见 perceptionMedia.ts) */
export async function startSubjectDetection(
  media: PerceptionMediaRef,
  times: number[],
  prompt?: string,
): Promise<string> {
  const r = await fetch("/api/subject/detect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId: media.id, media, times, ...(prompt ? { prompt } : null) }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "主体检测没能启动");
  return data.jobId as string;
}

export async function pollSubjectJob(jobId: string): Promise<SubjectJobState> {
  const r = await fetch(`/api/subject/job/${jobId}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "查不到这个主体检测作业");
  return data.job as SubjectJobState;
}

/** 取消一个跑着的作业。服务端会 taskkill /F /T 杀掉整棵进程树(python + 它起的 ffmpeg) */
export async function cancelSubjectJob(jobId: string): Promise<void> {
  await fetch(`/api/subject/job/${jobId}/cancel`, { method: "POST" }).catch(() => {});
}

/**
 * 等一个作业跑完。轮询间隔 1 秒 —— 一个采样是一次 ffmpeg seek 加一次前向，
 * light 档几十毫秒、full 档几百毫秒，二三十个采样通常几秒到十几秒。
 *
 * **必须有总时限**：这里以前是 `for(;;)` 死循环，Python 一旦卡住（ffmpeg 在坏文件上
 * 死等）作业永远停在 running，这个 Promise 就永远不 resolve，调用方的进度条转到天荒
 * 地老。默认 20 分钟 = 服务端上限（每帧 20 秒 × 200 帧最多 ~67 分钟）之下的一个
 * 现实数：full 档满配实测约 9 分钟，20 分钟已是两倍余量。超时就主动取消并抛错，
 * 让 subjectJobs 那边的 error 分支接住，list_shots 才能告诉模型「别再轮询了」。
 */
export async function waitForSubjects(
  jobId: string,
  onProgress?: (pct: number, engine: SubjectJobState["engine"]) => void,
  timeoutMs = 20 * 60 * 1000,
): Promise<Subjects> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) {
      await cancelSubjectJob(jobId);
      throw new Error(
        `主体检测超过 ${Math.round(timeoutMs / 60000)} 分钟还没跑完，已取消。`
        + "可以减少采样点（自己传 times），或先用 subject_status 确认档位——full 档比 light 慢一个数量级。",
      );
    }
    const job = await pollSubjectJob(jobId);
    onProgress?.(job.percent, job.engine);
    if (job.status === "error") throw new Error(job.message || "主体检测失败");
    if (job.status === "done") {
      return {
        // 跑完却没报 engine，只可能是 Python 侧的 result 事件缺字段。认成 light
        // 是**保守**的那一侧：调用方会据此知道「提示词没生效，只有 person/face」，
        // 反过来误标成 full 会让人以为按提示词找过目标了。
        engine: job.engine ?? "light",
        createdAt: new Date().toISOString(),
        prompt: job.prompt ?? "",
        width: job.width ?? 0,
        height: job.height ?? 0,
        samples: job.samples ?? [],
        // 服务端没报 failedCount 时(老版本 Python)自己数一遍,别留 undefined ——
        // 读取侧要拿它决定「这段结论是几个采样撑起来的」。
        failedCount: job.failedCount ?? (job.samples ?? []).filter((s) => s.failed).length,
        ...(job.fellBackFrom === "full"
          ? { fellBackFrom: "full" as const, fallbackReason: job.fallbackReason }
          : null),
      };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * 装主体检测的 light 档（onnxruntime，约 30 MB）。
 *
 * full 档（torch + transformers + 690 MB 的 Grounding DINO 权重）不走在线装，
 * 只随拓展库包发 —— 在线装那么大一坨，中断一次就得从头来。
 *
 * 流式读 pip 日志而不是等它跑完再回：中间一声不吭的话分不清是在装还是卡死了。
 */
export async function installSubject(
  onLog?: (line: string) => void,
): Promise<{ ok: boolean; needsModel: boolean; modelPath?: string; log: string[] }> {
  const res = await fetch("/api/subject/install", { method: "POST" });
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `/api/subject/install 返回 ${res.status}`);
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
      // 依赖装完了,但 YuNet / RT-DETR 的权重不在 requirements 里,只随拓展库包发。
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
      const full = detail ? `${msg}\n${detail}` : msg;
      log.push("[error] " + full);
      onLog?.("[error] " + full);
    }
  });
  return { ok, needsModel, modelPath, log };
}
