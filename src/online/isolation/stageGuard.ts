/**
 * Boot hook for cross-origin stage documents (contract `docs/plan/online-card-exec-contract.md`
 * section 3). `online/boot.ts` calls it before other modules evaluate: hardening must precede any
 * card code, and self-check should start as early as possible (results require waiting for two
 * same-origin requests).
 *
 * Only performs work during **online builds** and when this document is the stage entry `stage.html`;
 * desktop runtime environments, editor pages, same-origin single stages (`/editor/?stage=1`), and
 * export pages remain untouched.
 *
 * Handshake messages from stage → parent page: `pc-stage-isolation` (not `StageEvent`):
 *   - `{ report }`: self-check results. Sent **after** `pc-stage-ready` (`announceStageIsolation`);
 *     parent page clears stale results for this stage on each handshake;
 *   - `{ breach }`: hardening blocked code attempting to create subframes (parent page will not
 *     execute user cards for this session).
 */
import { installStageHardening, type BreachKind, type HardenReport } from "./harden.ts";
import { runIsolationCheck, type IsolationReport } from "./isolationCheck.ts";
import { cardExecGate, markIsolatedStageDocument, noteBreach, setIsolationReport } from "./execGate.ts";

/** Stage entrypoint filename (second entrypoint of online build; cross-origin stage iframe loads it, same-origin single stage still loads `index.html`) */
export const STAGE_ENTRY_FILE = "stage.html";

export interface StageIsolationMessage {
  type: "pc-stage-isolation";
  report?: IsolationReport;
  breach?: BreachKind;
}

/** Whether this document is the stage entrypoint (determined by path: `…/stage.html`) */
export function isStageEntryPath(pathname: string): boolean {
  return pathname === `/${STAGE_ENTRY_FILE}` || pathname.endsWith(`/${STAGE_ENTRY_FILE}`);
}

let booted = false;
let harden: HardenReport | null = null;
let pending: Promise<IsolationReport> | null = null;

function post(msg: StageIsolationMessage): void {
  try { window.parent?.postMessage(msg, "*"); } catch { /* Parent page is gone */ }
}

/**
 * Install hardening and start self-check. `online`: `ONLINE` from `src/online/mode.ts` (passed by caller;
 * this file does not read compile-time constants).
 * Returns whether any action was taken (returns false if not a stage entrypoint or not an online build).
 */
export function bootStageGuard({ online, base }: { online: boolean; base: string }): boolean {
  if (booted) return true;
  if (!online || typeof window === "undefined" || typeof location === "undefined") return false;
  // Probe and troubleshooting inspection port (read-only): in every online build document; editor page, same-origin single stage, and export page return `not-stage` (not executed)
  (window as unknown as Record<string, unknown>).__pcCardExecGate = () => { const g = cardExecGate(); return { allowed: g.allowed, reason: g.reason }; };
  if (!isStageEntryPath(location.pathname)) return false;
  booted = true;
  markIsolatedStageDocument();
  harden = installStageHardening({ onBreach: (kind) => { noteBreach(); post({ type: "pc-stage-isolation", breach: kind }); } });
  pending = runIsolationCheck({ base, harden }).then((report) => {
    setIsolationReport(report);
    return report;
  });
  // Inspection port for probes and troubleshooting (read-only)
  (window as unknown as Record<string, unknown>).__pcStageIsolation = () => ({ harden, report: latest });
  void pending.then((r) => { latest = r; });
  return true;
}
let latest: IsolationReport | null = null;

/** Document has stage hardening and self-check installed (only stage.html in online build; export page uses this to decide if waiting for self-check results is worthwhile) */
export function stageGuardBooted(): boolean {
  return booted;
}

/**
 * Called after every handshake (`pc-stage-ready`) is sent: sends immediately if self-check has
 * results, otherwise waits for results before sending (stage component remount triggers another
 * handshake, and parent page clears old results on each handshake, so send every time).
 * Documents that are not cross-origin stages send nothing (parent page infers no isolation on this host).
 */
export function announceStageIsolation(): void {
  if (!booted || !pending) return;
  void pending.then((report) => post({ type: "pc-stage-isolation", report }));
}

/** For unit tests */
export function resetStageGuardForTest(): void {
  booted = false; harden = null; pending = null; latest = null;
}
