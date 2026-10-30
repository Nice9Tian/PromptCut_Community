/**
 * 导出页里按**真时间**等。
 *
 * 导出页装了导出时钟(`src/kernel/exportClock.ts`、`pinEntropy.ts`):`performance.now()` 与 `Date.now()` 都被钉在当前导出帧的毫秒数上,
 * 项目一载入就是 0,不再走动。拿它们算「等了多久」的循环永远到不了时限 —— 2026-10-16 的 `576ad0a3` 在导出页的初始化里就这样写了两处,
 * 执行闸门没开(桌面运行环境、开发服务器上的导出页没有舞台自检,闸门一直是 `checking`)时浏览器导出永远不返回
 * (`docs/reports/AGENT-browser-export-hang.md`)。导出页里凡是要设时限的等待一律走这里。
 */

type RealClockHost = { __pcRealDateNow?: () => number };

/** 真墙钟毫秒:导出时钟接管 `Date` 之前存下的那份(`pinEntropy.ts` 的 `__pcRealDateNow`),没接管时就是 `Date.now()` */
export function realNow(): number {
  const real = (globalThis as RealClockHost).__pcRealDateNow;
  return typeof real === "function" ? real() : Date.now();
}

export interface WaitRealOptions {
  /** 每隔多久再看一次(毫秒) */
  tickMs?: number;
  /** 量时间的钟(缺省 `realNow`;单测注入) */
  now?: () => number;
  /** 睡一会儿(缺省 `setTimeout`;单测注入) */
  sleep?: (ms: number) => Promise<void>;
}

/** 等 `ok()` 成立,最多等 `ms` 真毫秒;回 `true` = 等到了,`false` = 到时限还没成立 */
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
