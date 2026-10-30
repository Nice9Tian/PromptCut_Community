/**
 * 浏览器离开确认（`SyncOverlays.tsx` 挂的 `beforeunload`）的一次放行。
 * 用户已经在页面里明确确认过要离开（新版本提示条的「仍要刷新」，`UpdateNotice.tsx`），紧接着的这一次刷新不再让浏览器再问一遍。
 * 只放行一次，且只在几秒内有效：刷新没发生时，之后正常关页面、跳走照旧提醒。
 */

/** 放行的有效期：点完到浏览器发出 `beforeunload` 只隔一瞬，几秒足够 */
const ALLOW_MS = 3000;

let allowUntil = 0;

/** 下一次离开不弹浏览器的离开确认（用户已在页面里确认过） */
export function allowNextLeave(now = Date.now()): void {
  allowUntil = now + ALLOW_MS;
}

/** `beforeunload` 里调：这一次是否已放行；调一次就用掉 */
export function takeLeaveAllowance(now = Date.now()): boolean {
  const ok = now < allowUntil;
  allowUntil = 0;
  return ok;
}
