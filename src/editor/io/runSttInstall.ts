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
 * Start one speech-to-text engine install and feed its progress into the shared store.
 *
 * Two entry points share it: the missing-dependency prompt at startup, and the AI calling
 * stt_install through MCP. This way, whichever side starts it, the progress control sees exactly
 * the same state and behavior.
 */
export interface StartedInstall {
  jobId: string;
  engine: string;
  /** Resolves when the install finishes (or fails); the caller can wait if it wants, and not waiting does not affect store updates */
  finished: Promise<{ ok: boolean; error?: string }>;
}

export function runSttInstall(engine = "faster-whisper"): StartedInstall {
  // Only one install is allowed at a time: pip installs into the same target directory, and two concurrent ones would trample each other
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
