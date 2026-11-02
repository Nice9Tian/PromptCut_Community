/**
 * Wait by **real time** in the export page.
 *
 * The export page installs an export clock (`src/kernel/exportClock.ts`, `pinEntropy.ts`):
 * `performance.now()` and `Date.now()` are pinned to current export frame milliseconds;
 * initialized to 0 upon project load, no longer advancing. Loops using them to measure elapsed wait
 * time never reach timeout: on 2026-10-16, `576ad0a3` wrote this in two places in export page init;
 * when execution gate is not open (desktop runtime environment and dev server export page have no
 * stage self-check, gate stays `checking`), browser export never returns
 * (`docs/reports/AGENT-browser-export-hang.md`). All timed waits in the export page must use this.
 */

type RealClockHost = { __pcRealDateNow?: () => number };

/** Real wall-clock milliseconds: the copy saved before export clock took over `Date` (`__pcRealDateNow` in `pinEntropy.ts`), or `Date.now()` when not taken over */
export function realNow(): number {
  const real = (globalThis as RealClockHost).__pcRealDateNow;
  return typeof real === "function" ? real() : Date.now();
}

export interface WaitRealOptions {
  /** Interval between checks (milliseconds) */
  tickMs?: number;
  /** Clock measuring time (defaults to `realNow`; injected in unit tests) */
  now?: () => number;
  /** Sleep helper (defaults to `setTimeout`; injected in unit tests) */
  sleep?: (ms: number) => Promise<void>;
}

/** Waits for `ok()` to become true, up to `ms` real milliseconds; returns `true` if satisfied, `false` if timed out before becoming true */
export async function waitReal(ok: () => boolean, ms: number, o: WaitRealOptions = {}): Promise<boolean> {
  const now = o.now ?? realNow;
  const tick = o.tickMs ?? 20;
  const sleep = o.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)));
  const t0 = now();
  for (;;) {
    if (ok()) return true;
    if (now() - t0 >= ms) return false;
    await sleep(tick);
  }
}
