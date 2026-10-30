/**
 * 登记在虚拟时钟上的 `setTimeout` / `setInterval`(E4b)。
 *
 * 舞台把四种计时方式全部接管:`performance.now` / `requestAnimationFrame` 在
 * `stageClock.ts`,`Date.now()` / 无参 `new Date()` 在 `kernel/pinEntropy.ts`,
 * 这一份管剩下的两样。卡片用 `setInterval` 每 100 ms 推一格的打字机、用 `setTimeout`
 * 排下一步的动画,在虚拟时间下必须跟着舞台的拍子走 —— 不然探针量到的是一张按墙钟乱跑的卡,
 * 补跑出来的状态和导出对不上。
 *
 * 这里不碰 `window`,只做记账:**什么时候结算由时钟说了算**(`stageClock` 的 `tick` 每拍调
 * 一次 `settle(now)`),所以它可以脱离浏览器单测。
 *
 * # 两条规矩
 *
 *  1. **跳转不结算**(`clock.set` 的拨钟、`maxCatchUp` 削起点):调 `shift(delta)` 把每个挂起
 *     定时器的到期时刻整体平移,剩余时间保持 —— 相当于跳过的那段时间里时钟停了。不这么做的话
 *     `setTime` 远跳一次会一口气跑几百个 `setInterval` 回调。
 *  2. **id 空间和真定时器分开**:虚拟 id 从 `VIRTUAL_TIMER_BASE` 起。舞台自身的墙钟定时器
 *     (RPC 超时、`.pc-awaiting` 的 500 ms 兜底、素材层)走 `__pcRealSetTimeout`,拿到的是真 id,
 *     清理时调的却是被接管后的 `clearTimeout` —— 靠这条边界把两边分得开。
 */

/** 虚拟定时器 id 的起点。小于它的一律是真定时器的 id */
export const VIRTUAL_TIMER_BASE = 1_000_000_000;

/** 一次结算里最多触发多少个回调。防的是「回调里又登记一个 0 毫秒定时器」这种自喂循环 */
export const MAX_FIRES_PER_SETTLE = 10_000;

interface VirtualTimer {
  id: number;
  cb: (...args: unknown[]) => void;
  args: unknown[];
  /** 到期的虚拟毫秒 */
  due: number;
  /** null = 一次性;否则是重复周期 */
  interval: number | null;
  /** 登记序号:同一 `due` 下按它排先后 */
  seq: number;
}

export interface VirtualTimers {
  /** 登记一个。`repeat` = `setInterval`。handler 不是函数(字符串 eval 那一套)时回 0、不登记 */
  set(handler: unknown, ms: unknown, args: unknown[], repeat: boolean, now: number): number;
  /** 摘掉。回 `false` 表示这不是虚拟 id —— 调用方该把它转交给真的那份 */
  clear(id: unknown): boolean;
  /** 结算到 `now` 为止到期的定时器,返回触发了几次 */
  settle(now: number): number;
  /** 跳转:每个挂起定时器的到期时刻整体平移 `delta`,剩余时间保持 */
  shift(delta: number): void;
  /** 眼下还挂着几个 */
  size(): number;
}

export function createVirtualTimers(): VirtualTimers {
  const timers = new Map<number, VirtualTimer>();
  let nextId = VIRTUAL_TIMER_BASE;
  let seq = 0;

  return {
    set(handler, ms, args, repeat, now) {
      if (typeof handler !== "function") return 0;
      const delay = Math.max(0, Number(ms) || 0);
      const id = nextId++;
      timers.set(id, {
        id,
        cb: handler as (...a: unknown[]) => void,
        args,
        due: now + delay,
        interval: repeat ? delay : null,
        seq: seq++,
      });
      return id;
    },
    clear(id) {
      if (typeof id !== "number" || id < VIRTUAL_TIMER_BASE) return false;
      timers.delete(id);
      return true;
    },
    settle(now) {
      /*
       * 本次结算**开始之后**新登记的一次性定时器一律推到下一拍(`seq >= limit`),哪怕它已经到期 ——
       * 不然 `setTimeout(loop, 0)` 这种自喂循环会在一拍里无限跑。`setInterval` 重排时沿用原 `seq`,
       * 所以它照样能在同一拍里追齐(一拍跨过好几个周期时)。
       */
      const limit = seq;
      let fired = 0;
      while (fired < MAX_FIRES_PER_SETTLE) {
        let best: VirtualTimer | null = null;
        for (const t of timers.values()) {
          if (t.due > now || t.seq >= limit) continue;
          if (!best || t.due < best.due || (t.due === best.due && t.seq < best.seq)) best = t;
        }
        if (!best) return fired;
        if (best.interval === null) timers.delete(best.id);
        // 周期 0 会让「追齐」变成死循环,按浏览器的老规矩当 1 毫秒
        else best.due += Math.max(1, best.interval);
        fired++;
        try {
          best.cb(...best.args);
        } catch (err) {
          console.error("[stageClock] 定时器回调抛错", err);
        }
      }
      console.warn("[stageClock] 一拍内定时器触发次数到顶,剩下的推到下一拍");
      return fired;
    },
    shift(delta) {
      if (!delta) return;
      for (const t of timers.values()) t.due += delta;
    },
    size: () => timers.size,
  };
}
