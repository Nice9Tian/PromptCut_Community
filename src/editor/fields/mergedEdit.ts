/**
 * 编辑面板里「连续的一串改动只算一步」的小工具(`NumberField` / `RangeField` / 参数名上的拖动微调共用)。
 *
 * 撤销栈的合并走 store 现成的 mergeKey(`src/store/core.ts` 的 `setProject`、`docsync.ts` 的 `commit`):
 * 同一个 key、合并窗口内的连续修改并进撤销栈上的同一步。这里只负责
 *   - 给每一次拖动发一个独一份的 key(`newGestureKey`),窗口取无穷(只认 key、不看时间);
 *   - 步进(方向键、上下箭头)用一个较宽的滚动窗口(`STEP_BURST_MS`),连按并成一步;
 *   - 拖动中途的提交限速(`createLatestThrottle`),免得每次指针移动都往文档服务发一条提交。
 */
import { withMerge } from "../../store/project";

/** 一次拖动里最多每隔这么久提交一次(松手时一定补交最后一个值) */
export const GESTURE_COMMIT_INTERVAL_MS = 50;
/** 连续步进:两次步进相隔不超过这么久就并成一步撤销(以最近一次为准往后滚) */
export const STEP_BURST_MS = 1000;
/** 一次拖动:只认 key,不看时间 */
export const GESTURE_WINDOW_MS = Infinity;

let seq = 0;
/** 每次拖动取一个独一份的 key,下一次拖动不会并进上一次 */
export function newGestureKey(tag: string): string {
  return `${tag}#${++seq}`;
}

/** 在 `fn` 里发生的项目修改都并进同一个撤销步 */
export function commitMerged<T>(key: string, windowMs: number, fn: () => T): T {
  return withMerge({ key, windowMs }, fn);
}

export interface ThrottleEnv {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

const realEnv: ThrottleEnv = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/**
 * 只留最新值的限速:第一个值立刻交,之后的值最快每 `intervalMs` 交一次(中间的被后来的顶掉);
 * `flush()` 把还没交的最新值马上交出去(松手时调),`cancel()` 丢掉没交的。
 */
export function createLatestThrottle<T>(apply: (v: T) => void, intervalMs: number, env: ThrottleEnv = realEnv) {
  let last = -Infinity;
  let pending: { v: T } | null = null;
  let timer: unknown = null;
  const run = () => {
    timer = null;
    if (!pending) return;
    const { v } = pending;
    pending = null;
    last = env.now();
    apply(v);
  };
  return {
    push(v: T) {
      pending = { v };
      if (timer !== null) return;
      const wait = last + intervalMs - env.now();
      if (wait <= 0) run();
      else timer = env.setTimeout(run, wait);
    },
    flush() {
      if (timer !== null) { env.clearTimeout(timer); timer = null; }
      run();
    },
    cancel() {
      if (timer !== null) { env.clearTimeout(timer); timer = null; }
      pending = null;
    },
  };
}
