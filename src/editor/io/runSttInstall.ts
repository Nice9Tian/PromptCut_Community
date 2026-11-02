import { sttInstall } from "./stt";
import {
  startJob,
  feedLine,
  finishJob,
  runningJob,
  describe,
  type InstallJob,
} from "../../ai/sttInstallStore";
import { tr } from "../../i18n/index.ts";

/**
 * 启动一次听写引擎安装,并把进度喂进共享 store。
 *
 * 两个入口共用它 —— 启动时的缺依赖提示、AI 通过 MCP 调 stt_install ——
 * 这样不管从哪边发起,进度控件看到的状态和行为都一模一样。
 */
export interface StartedInstall {
  jobId: string;
  engine: string;
  /** 装完(或失败)时 resolve;调用方想等就等,不等也不影响 store 更新 */
  finished: Promise<{ ok: boolean; error?: string }>;
}

export function runSttInstall(engine = "faster-whisper"): StartedInstall {
  // 同一时刻只允许一个安装:pip 装到同一个 target 目录,两个并发会互相踩
  const already = runningJob();
  if (already) {
    throw new Error(tr("{0} is already being installed ({1}), wait for it to finish before installing again.", already.engine, describe(already)));
  }

  const jobId = `install-${engine}-${Date.now().toString(36)}`;
  const log: string[] = [];
  startJob(jobId, engine);

  const finished = sttInstall(engine, (line) => {
    log.push(line);
    if (log.length > 200) log.shift();
    feedLine(jobId, line);
  })
    .then((r) => {
      finishJob(jobId, r.ok, r.ok ? undefined : tr("pip exited with a non-zero code, see the log for details"));
      return { ok: r.ok, error: r.ok ? undefined : tr("pip exited with a non-zero code, see the log for details") };
    })
    .catch((e: unknown) => {
      const error = e instanceof Error ? e.message : String(e);
      finishJob(jobId, false, error);
      return { ok: false, error };
    });

  return { jobId, engine, finished };
}

export type { InstallJob };
