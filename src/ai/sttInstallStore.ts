import { useSyncExternalStore } from "react";
import { tr } from "../i18n/index.ts";

/**
 * Shared state of the speech-to-text engine install job.
 *
 * Installing the engine has two entry points (the missing-dependency prompt at startup, and the AI
 * calling stt_install through MCP), while progress has to be shown in a third place (the progress
 * control in the chat window). The three are not in the same component tree, so a small
 * module-level store is used, where whoever writes and whoever reads each do their own thing.
 */

export type InstallPhase = "starting" | "resolving" | "downloading" | "installing" | "done" | "failed";

export interface InstallJob {
  jobId: string;
  engine: string;
  phase: InstallPhase;
  /** Which package is currently being processed */
  currentPackage?: string;
  /** Download progress of the current package (MB). Present only when pip prints a line like "12.3/45.6 MB" */
  gotMB?: number;
  totalMB?: number;
  /** Number of packages whose download has started */
  downloaded: number;
  /**
   * After pip resolves the dependencies it lists all the packages to install at once; this number is
   * only known at that point
   */
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
  // useSyncExternalStore requires a stable snapshot reference, so the array is rebuilt on every change
  snapshot = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const getJobs = (): InstallJob[] => snapshot;
export const getJob = (jobId: string): InstallJob | undefined => jobs.get(jobId);
/** The one that is running. Only one install is allowed at a time, so there is at most one */
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
 * Reads the stage from one line of pip output.
 *
 * Only what pip really prints is recognized; no percentages are invented. How many packages will be
 * installed is unknown to anyone before pip finishes resolving dependencies (transitive
 * dependencies), so there is no honest algorithm for an overall percentage; the only thing with a
 * real denominator is the download byte count of **the current file**, which pip prints as
 * "12.3/45.6 MB".
 * Between "Installing collected packages" and "Successfully installed" pip prints nothing, so that
 * stretch can only be an indeterminate animation; forcing it into a progress bar would give a fake
 * bar stuck at 0%.
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
    // The trailing (?=\s|$) is crucial: while resolving dependencies pip first fetches "xxx.whl.metadata",
    // which is not the package body, and without this lookahead every package would be counted twice.
  } else if ((m = line.match(/^\s*Downloading\s+([^\s/\\]+?)(?:-[\d][^\s]*?)?\.(?:whl|tar\.gz)(?=\s|$)/))) {
    job.phase = "downloading";
    job.currentPackage = m[1];
    job.downloaded += 1;
    job.gotMB = job.totalMB = undefined;
  } else if ((m = line.match(/([\d.]+)\s*\/\s*([\d.]+)\s*(kB|KB|MB|GB)/))) {
    // pip's download progress line: the real downloaded / total size of the current file
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
 * Progress from 0 to 1; **it returns a number only when the denominator is really known**, and
 * otherwise returns null so the UI goes into the indeterminate state.
 * During the download stage it gives the progress of the current file, not the overall progress, and
 * the UI must label that truthfully.
 */
export function fractionOf(job: InstallJob): number | null {
  if (job.phase === "done") return 1;
  if (job.phase === "downloading" && job.totalMB && job.gotMB !== undefined) {
    return Math.max(0, Math.min(1, job.gotMB / job.totalMB));
  }
  return null;
}

/**
 * A one-sentence description for the UI, separate from the progress bar: it says clearly what is
 * actually going on right now
 */
export function describe(job: InstallJob): string {
  switch (job.phase) {
    case "starting":
      return tr("Starting installation…");
    case "resolving":
      return job.currentPackage ? tr("Resolving dependencies: {0}", job.currentPackage) : tr("Resolving dependencies…");
    case "downloading":
      return job.currentPackage
        ? tr("Downloading {0}{1}", job.currentPackage, job.totalMB ? ` (${job.totalMB.toFixed(1)} MB)` : "")
        : tr("Downloading…");
    case "installing":
      return job.packageCount ? tr("Installing {0} packages…", job.packageCount) : tr("Installing…");
    case "done":
      return tr("Installation complete");
    case "failed":
      return job.error || tr("Install failed");
  }
}

/**
 * Matches a stt_install tool call to its install job.
 *
 * The jobId is in the tool's **return value** (stt_install returns the jobId immediately and is
 * done), so in the short moment right after the call is sent and before the result comes back there
 * is nothing to match; at that point it falls back to "the install currently running", because only
 * one install is allowed at a time. A call in a historical message is matched exactly by the jobId in
 * its summary, so that when browsing an old chat you see the final state of the install from back
 * then, and it does not get mixed up with a later new install.
 */
export function matchInstallJob(
  tool: { name: string; summary?: string; ok?: boolean },
  list: InstallJob[],
): InstallJob | undefined {
  // Tool names reported by Claude Code carry the mcp__promptcut__ prefix, while other providers use
  // the bare name; both must be recognized
  if (tool.name.replace(/^mcp__.+?__/, "") !== "stt_install") return undefined;
  const id = typeof tool.summary === "string" ? tool.summary.match(/install-[a-z-]+-[a-z0-9]+/i)?.[0] : undefined;
  if (id) return list.find((j) => j.jobId === id);
  if (tool.ok === undefined) return list.find((j) => j.phase !== "done" && j.phase !== "failed");
  return undefined;
}

export function useInstallJobs(): InstallJob[] {
  return useSyncExternalStore(subscribe, getJobs, () => snapshot);
}
