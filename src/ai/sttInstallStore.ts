import { useSyncExternalStore } from "react";

/**
 * 听写引擎安装任务的共享状态。
 *
 * 装引擎有两个入口 —— 启动时的缺依赖提示、AI 通过 MCP 调 stt_install ——
 * 而进度要显示在第三个地方(聊天窗口里的进度控件)。三边不在同一棵组件树上,
 * 所以放一个模块级的小 store,谁写谁读各管各的。
 */

export type InstallPhase = "starting" | "resolving" | "downloading" | "installing" | "done" | "failed";

export interface InstallJob {
  jobId: string;
  engine: string;
  phase: InstallPhase;
  /** 当前在处理哪个包 */
  currentPackage?: string;
  /** 当前这个包的下载进度(MB)。只有 pip 打出 "12.3/45.6 MB" 这类行时才有 */
  gotMB?: number;
  totalMB?: number;
  /** 已经开始下载过的包数量 */
  downloaded: number;
  /** pip 解完依赖后会一次列全要装的包,这个数到那时才知道 */
  packageCount?: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  logTail: string[];
}

const jobs = new Map<string, InstallJob>();
const listeners = new Set<() => void>();
let snapshot: InstallJob[] = [];

function emit() {
  // useSyncExternalStore 要求快照引用稳定,所以每次变更重建数组
  snapshot = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const getJobs = (): InstallJob[] => snapshot;
export const getJob = (jobId: string): InstallJob | undefined => jobs.get(jobId);
/** 正在跑的那个。同一时刻只允许一个安装,所以最多一个 */
export const runningJob = (): InstallJob | undefined =>
  snapshot.find((j) => j.phase !== "done" && j.phase !== "failed");

export function startJob(jobId: string, engine: string): InstallJob {
  const job: InstallJob = { jobId, engine, phase: "starting", downloaded: 0, startedAt: Date.now(), logTail: [] };
  jobs.set(jobId, job);
  emit();
  return job;
}

export function finishJob(jobId: string, ok: boolean, error?: string) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.phase = ok ? "done" : "failed";
  job.finishedAt = Date.now();
  if (error) job.error = error;
  emit();
}

const UNIT_MB: Record<string, number> = { kB: 1 / 1024, KB: 1 / 1024, MB: 1, GB: 1024 };

/**
 * 从一行 pip 输出里读出阶段。
 *
 * 只认 pip 真的会打出来的东西,不编百分比。要装多少个包在 pip 解完依赖之前
 * 谁也不知道(传递依赖),所以整体百分比没有诚实的算法;唯一有真分母的是
 * **当前这个文件**的下载字节数,pip 会打成 "12.3/45.6 MB"。
 * 「Installing collected packages」到「Successfully installed」之间 pip 一行不打,
 * 所以那一段只能是不确定态动画 —— 硬做成进度条就是个卡在 0% 的假条。
 */
export function feedLine(jobId: string, rawLine: string) {
  const job = jobs.get(jobId);
  if (!job) return;
  const line = rawLine.trim();
  if (!line) return;

  job.logTail.push(line);
  if (job.logTail.length > 60) job.logTail.shift();

  let m: RegExpMatchArray | null;
  if ((m = line.match(/^Collecting\s+([^\s=<>!~;]+)/))) {
    job.phase = "resolving";
    job.currentPackage = m[1];
    job.gotMB = job.totalMB = undefined;
    // 末尾的 (?=\s|$) 很关键:pip 解依赖时会先拉 "xxx.whl.metadata",
    // 那不是包体,漏了这个前瞻会把每个包数成两次。
  } else if ((m = line.match(/^\s*Downloading\s+([^\s/\\]+?)(?:-[\d][^\s]*?)?\.(?:whl|tar\.gz)(?=\s|$)/))) {
    job.phase = "downloading";
    job.currentPackage = m[1];
    job.downloaded += 1;
    job.gotMB = job.totalMB = undefined;
  } else if ((m = line.match(/([\d.]+)\s*\/\s*([\d.]+)\s*(kB|KB|MB|GB)/))) {
    // pip 的下载进度行,当前文件真实的已下载/总量
    const unit = UNIT_MB[m[3]] ?? 1;
    job.gotMB = parseFloat(m[1]) * unit;
    job.totalMB = parseFloat(m[2]) * unit;
    if (job.phase === "resolving") job.phase = "downloading";
  } else if ((m = line.match(/^Installing collected packages:\s*(.+)$/))) {
    job.phase = "installing";
    job.packageCount = m[1].split(",").filter((s) => s.trim()).length;
    job.currentPackage = undefined;
    job.gotMB = job.totalMB = undefined;
  } else if (line.startsWith("Successfully installed")) {
    job.phase = "installing";
    job.currentPackage = undefined;
  }

  emit();
}

/**
 * 0-1 的进度,**只在真的知道分母时**返回数字,其余返回 null 让界面走不确定态。
 * 下载阶段给的是当前这个文件的进度,不是整体进度 —— 界面上要如实标出来。
 */
export function fractionOf(job: InstallJob): number | null {
  if (job.phase === "done") return 1;
  if (job.phase === "downloading" && job.totalMB && job.gotMB !== undefined) {
    return Math.max(0, Math.min(1, job.gotMB / job.totalMB));
  }
  return null;
}

/** 给界面用的一句话说明,和进度条分开:说清现在到底在干什么 */
export function describe(job: InstallJob): string {
  switch (job.phase) {
    case "starting":
      return "正在启动安装…";
    case "resolving":
      return job.currentPackage ? `正在解析依赖:${job.currentPackage}` : "正在解析依赖…";
    case "downloading":
      return job.currentPackage
        ? `正在下载 ${job.currentPackage}${job.totalMB ? `(${job.totalMB.toFixed(1)} MB)` : ""}`
        : "正在下载…";
    case "installing":
      return job.packageCount ? `正在安装 ${job.packageCount} 个包…` : "正在安装…";
    case "done":
      return "安装完成";
    case "failed":
      return job.error || "安装失败";
  }
}

/**
 * 把一次 stt_install 工具调用对上它的安装任务。
 *
 * jobId 在工具的**返回值**里(stt_install 立刻返回 jobId 就走了),所以调用刚发出、
 * 结果还没回来的那一小会儿匹配不到 —— 这时退回「当前正在跑的那个安装」,
 * 因为同一时刻只允许一个安装。历史消息里的调用则靠 summary 里的 jobId 精确对上,
 * 这样翻旧对话时看到的是当时那次安装的最终状态,不会串到后来的新安装上。
 */
export function matchInstallJob(
  tool: { name: string; summary?: string; ok?: boolean },
  list: InstallJob[],
): InstallJob | undefined {
  // Claude Code 报上来的工具名带 mcp__promptcut__ 前缀,别家是裸名;两种都要认
  if (tool.name.replace(/^mcp__.+?__/, "") !== "stt_install") return undefined;
  const id = typeof tool.summary === "string" ? tool.summary.match(/install-[a-z-]+-[a-z0-9]+/i)?.[0] : undefined;
  if (id) return list.find((j) => j.jobId === id);
  if (tool.ok === undefined) return list.find((j) => j.phase !== "done" && j.phase !== "failed");
  return undefined;
}

export function useInstallJobs(): InstallJob[] {
  return useSyncExternalStore(subscribe, getJobs, () => snapshot);
}
