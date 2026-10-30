/**
 * 跨源舞台文档的启动钩子(契约 `docs/plan/online-card-exec-contract.md` 第 3 节)。`online/boot.ts` 在别的模块求值之前调它:
 * 加固要排在任何卡片代码之前,自检越早开始越好(结果要等两次同源请求)。
 *
 * 只在**在线构建**、而且本文档是舞台入口 `stage.html` 时做事;桌面运行环境、编辑器页、同源单舞台(`/editor/?stage=1`)、导出页都原样不动。
 *
 * 舞台 → 父页的握手类消息 `pc-stage-isolation`(不是 `StageEvent`):
 *   - `{ report }`:自检结果。排在 `pc-stage-ready` **之后**发(`announceStageIsolation`),父页每次握手先清掉这一台旧的结果;
 *   - `{ breach }`:加固拦下了试图造子框架的代码(父页本次会话不再执行用户卡)。
 */
import { installStageHardening, type BreachKind, type HardenReport } from "./harden.ts";
import { runIsolationCheck, type IsolationReport } from "./isolationCheck.ts";
import { cardExecGate, markIsolatedStageDocument, noteBreach, setIsolationReport } from "./execGate.ts";

/** 舞台入口的文件名(在线构建的第二个入口;跨源舞台的 iframe 载它,同源单舞台仍载 `index.html`) */
export const STAGE_ENTRY_FILE = "stage.html";

export interface StageIsolationMessage {
  type: "pc-stage-isolation";
  report?: IsolationReport;
  breach?: BreachKind;
}

/** 本文档是不是舞台入口(按路径判:`…/stage.html`) */
export function isStageEntryPath(pathname: string): boolean {
  return pathname === `/${STAGE_ENTRY_FILE}` || pathname.endsWith(`/${STAGE_ENTRY_FILE}`);
}

let booted = false;
let harden: HardenReport | null = null;
let pending: Promise<IsolationReport> | null = null;

function post(msg: StageIsolationMessage): void {
  try { window.parent?.postMessage(msg, "*"); } catch { /* 父页不在了 */ }
}

/**
 * 装加固、起自检。`online`:`src/online/mode.ts` 的 `ONLINE`(调用方传,本文件不读编译期常量)。
 * 回是否做了事(不是舞台入口、不是在线构建回 false)。
 */
export function bootStageGuard({ online, base }: { online: boolean; base: string }): boolean {
  if (booted) return true;
  if (!online || typeof window === "undefined" || typeof location === "undefined") return false;
  // 探针与排障用的观察口(只读):在线构建的每个文档都有 —— 编辑器页、同源单舞台、导出页回 `not-stage`(不执行)
  (window as unknown as Record<string, unknown>).__pcCardExecGate = () => { const g = cardExecGate(); return { allowed: g.allowed, reason: g.reason }; };
  if (!isStageEntryPath(location.pathname)) return false;
  booted = true;
  markIsolatedStageDocument();
  harden = installStageHardening({ onBreach: (kind) => { noteBreach(); post({ type: "pc-stage-isolation", breach: kind }); } });
  pending = runIsolationCheck({ base, harden }).then((report) => {
    setIsolationReport(report);
    return report;
  });
  // 探针与排障用的观察口(只读)
  (window as unknown as Record<string, unknown>).__pcStageIsolation = () => ({ harden, report: latest });
  void pending.then((r) => { latest = r; });
  return true;
}
let latest: IsolationReport | null = null;

/** 本文档装了舞台加固、起了自检(只有在线构建的 stage.html 是;导出页据此判断值不值得等自检结果) */
export function stageGuardBooted(): boolean {
  return booted;
}

/**
 * 每次握手(`pc-stage-ready`)发出之后调:自检有结果了就发,没有就等它出来再发(舞台组件重挂会再握手一次,父页每次握手都清旧结果,所以每次都发)。
 * 不是跨源舞台的文档什么都不发(父页据此知道这一台没有隔离)。
 */
export function announceStageIsolation(): void {
  if (!booted || !pending) return;
  void pending.then((report) => post({ type: "pc-stage-isolation", report }));
}

/** 单测用 */
export function resetStageGuardForTest(): void {
  booted = false; harden = null; pending = null; latest = null;
}
