/**
 * 逐帧导出续签只读票据(C10 契约第 12 节、第 18 节第 5 条)。
 *
 * 在线页面的逐帧导出(c10a 契约第 11.1 节)可能比只读票据的时限(15 分钟)还长。导出途中按时限**提前**续签,
 * 不中断、不出错:
 *
 *   - `start()` 取第一张(回 Promise);`ticket()` 同步回当前这一张(导出页每一帧装素材时读);`stop()` 收摊;
 *   - 每张票据在剩下三分之一寿命时续签(与页面的 `assetTicketSource` 同一个时点);
 *   - 续签失败不换掉旧的(旧的还没过期就照用),在过期之前再试:每隔 `RENEW_RETRY_MS`、且不晚于过期前 `RENEW_MARGIN_MS`;
 *   - 取票复用页面已有的 `assetTicketSource`(`src/editor/media/assetTiers.ts`),由调用方经 `fetchTicket` 注入。
 *
 * 用全局 `setTimeout`(单测用 `mock.timers` 推时间)。
 */

export interface TicketInfo { ticket: string; exp: number }

/** 剩下寿命的这个比例时续签 */
export const RENEW_AT_REMAINING = 1 / 3;
/** 续签失败后多久再试 */
export const RENEW_RETRY_MS = 5_000;
/** 最晚在过期前这么久再试一次 */
export const RENEW_MARGIN_MS = 1_000;

export interface TicketRenewer {
  start(): Promise<string | null>;
  ticket(): string | null;
  stop(): void;
  /** 探针看:续签过几次、失败几次、当前这张哪一刻过期 */
  stats(): { renewals: number; failures: number; exp: number | null };
}

export function createTicketRenewer({ fetchTicket, now = Date.now }: { fetchTicket: () => Promise<TicketInfo | null>; now?: () => number }): TicketRenewer {
  let cur: TicketInfo | null = null;
  let issuedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let renewals = 0;
  let failures = 0;

  const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const at = (ms: number, fn: () => void) => {
    clear();
    if (stopped) return;
    timer = setTimeout(() => { timer = null; fn(); }, Math.max(0, ms));
  };

  /** 下一次续签的时刻:剩下三分之一寿命时 */
  const scheduleRenew = () => {
    if (!cur) return;
    const life = Math.max(0, cur.exp - issuedAt);
    const renewAt = cur.exp - life * RENEW_AT_REMAINING;
    at(renewAt - now(), () => { void renew(); });
  };

  /** 续签失败:过期之前再试(不晚于过期前 RENEW_MARGIN_MS) */
  const scheduleRetry = () => {
    const left = cur ? cur.exp - now() : 0;
    const wait = cur && left > RENEW_MARGIN_MS ? Math.min(RENEW_RETRY_MS, left - RENEW_MARGIN_MS) : RENEW_RETRY_MS;
    at(wait, () => { void renew(); });
  };

  const accept = (t: TicketInfo | null): boolean => {
    if (!t || typeof t.ticket !== "string" || !t.ticket || !Number.isFinite(t.exp)) return false;
    // 取回来的还是同一张(来源还在用缓存):不算续上,稍后再试
    if (cur && t.ticket === cur.ticket && t.exp <= cur.exp) return false;
    cur = { ticket: t.ticket, exp: t.exp };
    issuedAt = now();
    return true;
  };

  const renew = async () => {
    if (stopped) return;
    let t: TicketInfo | null = null;
    try { t = await fetchTicket(); } catch { t = null; }
    if (stopped) return;
    if (accept(t)) { renewals++; scheduleRenew(); }
    else { failures++; scheduleRetry(); }
  };

  return {
    async start() {
      stopped = false;
      let t: TicketInfo | null = null;
      try { t = await fetchTicket(); } catch { t = null; }
      if (stopped) return null;
      if (accept(t)) scheduleRenew();
      else { failures++; scheduleRetry(); }
      return cur?.ticket ?? null;
    },
    ticket: () => cur?.ticket ?? null,
    stop() { stopped = true; clear(); },
    stats: () => ({ renewals, failures, exp: cur?.exp ?? null }),
  };
}

/** 素材地址里的只读票据(`?t=` / `&t=`)换成这一张;没带票据的原样 */
export function withTicket(url: string, ticket: string | null): string {
  if (!ticket || !url) return url;
  const m = /([?&])t=[^&#]*/.exec(url);
  if (!m) return url;
  return url.slice(0, m.index) + `${m[1]}t=${encodeURIComponent(ticket)}` + url.slice(m.index + m[0].length);
}
