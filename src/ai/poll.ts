/**
 * 页面里后台轮询的小工具(对话列表、删除通知、删到一半接着办用)。没有 React，Node 里有单测(`poll.test.mjs`)。
 *
 * 规矩(2026-10-13 审查)：
 *   - 同时只有一次在途：上一次没回来，不发下一次；
 *   - 失败退避：连续失败一次翻一倍，封顶 `maxMs`；成功就回到 `baseMs`；
 *   - 登录失效(`run` 回 `"stop"`)就停，不再来；
 *   - 页面不可见就不排下一次，回到可见时(`kick()`)立刻来一次再接着排。
 */
export interface Poller {
  start(): void;
  stop(): void;
  /** 立刻来一次(回到前台、页面里有人动了对话时)；在途或已停就什么都不做 */
  kick(): void;
  describe(): { running: boolean; inflight: boolean; failures: number; nextDelayMs: number; stopped: boolean };
}

export function createPoller(o: {
  /** 返回 `"stop"` 表示不用再来了(登录失效)；抛错算失败，退避 */
  run: () => Promise<"stop" | void>;
  baseMs: number;
  maxMs?: number;
  visible?: () => boolean;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}): Poller {
  const maxMs = o.maxMs ?? 60_000;
  const visible = o.visible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
  const schedule = o.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = o.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let started = false, stopped = false, inflight = false, failures = 0;
  const delay = () => Math.min(maxMs, o.baseMs * 2 ** Math.min(failures, 16));

  function arm() {
    if (!started || stopped || inflight || timer !== null || !visible()) return;
    timer = schedule(() => { timer = null; void tick(); }, delay());
  }
  async function tick() {
    if (!started || stopped || inflight) return;
    if (!visible()) return; // 不可见：不排下一次，kick() 回来再说
    inflight = true;
    try {
      const out = await o.run();
      if (out === "stop") { stopped = true; return; }
      failures = 0;
    } catch {
      failures += 1;
    } finally {
      inflight = false;
    }
    arm();
  }
  return {
    start() { if (started) return; started = true; stopped = false; void tick(); },
    stop() { stopped = true; started = false; if (timer !== null) { cancel(timer); timer = null; } },
    kick() { if (!started || stopped || inflight) return; if (timer !== null) { cancel(timer); timer = null; } void tick(); },
    describe: () => ({ running: started && !stopped, inflight, failures, nextDelayMs: delay(), stopped }),
  };
}
