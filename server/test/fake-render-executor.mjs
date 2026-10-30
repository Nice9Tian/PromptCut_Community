/**
 * 仅供测试与进程内集成，生产代码不得引用。
 *
 * 可编排的假执行器（契约 `docs/plan/render-queue-contract.md` D.1 的 `executor`、D.3），外加它用的假时钟。
 *
 *   executor.plan(planTask, { signal })               → Promise<PlanContext>（测试给定）
 *   executor.render(task, { signal, progress })       → Promise<artifacts>
 *
 * 所有等待都按注入的假时钟推进，不用真实计时器：`createTimerClock` 的 `sleep(ms, signal)` 在测试调
 * `advance` / `set` 把时钟推过到期时刻时兑现；`signal` 中止时立即以 `AbortError` 拒绝。
 *
 * 一个执行器由多个节点共用：`forNode(nodeId)` 给出绑定了节点身份的 D.1 接口，调用记录里带 `nodeId`，
 * 编排规则也可以按节点区分。编排（`on(match, behavior)`，按添加顺序取第一条匹配且还有次数的规则）：
 *
 *   match     任务 id（字符串）| RegExp（对 id）| (task, { nodeId, call }) => boolean（call 是这个 id 第几次 render，从 1 起）
 *   behavior  {
 *     durationMs,          耗时（缺省按构造参数，1000）
 *     progressEveryMs,     进度步长：每隔这么久报一次进度（缺省 250），报的是已做完的帧数
 *     fail: { retryable = true, message = 'render-failed', afterMs },   到时抛错；retryable === false 时错误带 retryable: false
 *     hang: true | { afterProgress: n },   卡死：先报 n 次进度（缺省 0），然后永不返回、也不再报进度，
 *                                          而且不理会中止——直到测试调 release()，那时照常返回产物（「迟到的结果」）
 *     times,               这条规则用几次（缺省不限）
 *   }
 *
 * 没有规则匹配时按缺省耗时、缺省步长正常完成。
 */

/** 测试的起始时刻（与 fake-render-queue-env.mjs 的 T0 相同，不从 0 起）。 */
export const T0 = 1_000_000;

function abortError(signal) {
  const reason = signal?.reason;
  const error = new Error(`aborted${reason instanceof Error ? `：${reason.message}` : ''}`);
  error.name = 'AbortError';
  return error;
}

/**
 * 带定时器的假时钟：`now()`、`advance(ms)`、`set(t)`、`sleep(ms, signal)`。
 * 推进时钟时按到期先后兑现到期的 `sleep`（兑现后的续体在微任务里跑，测试要让出一次事件循环才看得到）。
 */
export function createTimerClock(start = T0) {
  let t = start;
  let seq = 0;
  let timers = [];

  function fireDue() {
    timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    while (timers.length > 0 && timers[0].at <= t) {
      const timer = timers.shift();
      timer.cleanup();
      timer.resolve();
    }
  }

  return {
    now: () => t,
    advance(ms) { t += ms; fireDue(); return t; },
    set(v) { t = v; fireDue(); return t; },
    sleep(ms, signal) {
      if (signal?.aborted) return Promise.reject(abortError(signal));
      if (!(ms > 0)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = { at: t + ms, seq: seq++, resolve, cleanup: () => {} };
        if (signal) {
          const onAbort = () => {
            timers = timers.filter(x => x !== timer);
            reject(abortError(signal));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          timer.cleanup = () => signal.removeEventListener('abort', onAbort);
        }
        timers.push(timer);
      });
    },
    /** 还没到期的 sleep 个数 */
    pendingTimers: () => timers.length,
  };
}

/** 任务的帧数：快照是本地帧数，轨道流每段 15 帧（设计第 2 节）。 */
function framesOf(task) {
  const r = task?.range;
  if (!r) return 1;
  const n = r.to - r.from + 1;
  return task.kind === 'stream' ? n * 15 : n;
}

function matches(match, task, info) {
  if (typeof match === 'string') return task?.id === match;
  if (match instanceof RegExp) return match.test(task?.id ?? '');
  if (typeof match === 'function') return !!match(task, info);
  return false;
}

export function createFakeExecutor({
  clock,
  planContext,
  planMs = 200,
  durationMs = 1_000,
  progressEveryMs = 250,
} = {}) {
  if (!clock || typeof clock.sleep !== 'function') throw new TypeError('createFakeExecutor：clock 须是 createTimerClock() 的实例');
  const rules = [];
  const calls = [];
  const hung = [];
  const errors = [];
  let seq = 0;

  function behaviorFor(task, info) {
    for (const rule of rules) {
      if (rule.remaining <= 0 || !matches(rule.match, task, info)) continue;
      rule.remaining -= 1;
      rule.hits += 1;
      return rule.behavior;
    }
    return {};
  }

  function track(call, signal) {
    if (!signal) return;
    if (signal.aborted) call.abortSeen = true;
    else signal.addEventListener('abort', () => { call.abortSeen = true; }, { once: true });
  }

  function bind(nodeId) {
    async function plan(planTask, { signal } = {}) {
      const call = { seq: seq++, kind: 'plan', nodeId, id: planTask?.id, startedAt: clock.now(), endedAt: null, state: 'running', abortSeen: false, progress: [] };
      calls.push(call);
      track(call, signal);
      try {
        await clock.sleep(planMs, signal);
        const ctx = typeof planContext === 'function' ? planContext(planTask, { nodeId }) : planContext;
        call.state = 'ok';
        return ctx;
      } catch (error) {
        call.state = signal?.aborted ? 'aborted' : 'failed';
        throw error;
      } finally {
        call.endedAt = clock.now();
      }
    }

    async function render(task, { signal, progress } = {}) {
      const nth = calls.filter(c => c.kind === 'render' && c.id === task?.id).length + 1;
      const call = { seq: seq++, kind: 'render', nodeId, id: task?.id, startedAt: clock.now(), endedAt: null, state: 'running', abortSeen: false, late: false, progress: [] };
      calls.push(call);
      track(call, signal);
      const b = behaviorFor(task, { nodeId, call: nth });
      const total = framesOf(task);
      const duration = b.durationMs ?? durationMs;
      const every = Math.max(1, b.progressEveryMs ?? progressEveryMs);
      const report = done => {
        call.progress.push(done);
        try {
          progress?.(done);
        } catch (error) {
          errors.push(error);
          throw error;
        }
      };
      const artifacts = () => ({
        taskId: task.id, nodeId, kind: task.kind,
        from: task.range?.from ?? null, to: task.range?.to ?? null, frames: total,
      });
      try {
        if (b.hang) {
          const k = b.hang === true ? 0 : (b.hang.afterProgress ?? 0);
          for (let i = 1; i <= k; i++) {
            await clock.sleep(every, signal);
            report(Math.min(total, i));
          }
          // 卡死：不报进度，也不理会中止，直到测试 release()
          call.state = 'hung';
          await new Promise(resolve => hung.push({ call, resolve }));
          call.late = true;
          call.state = 'ok';
          return artifacts();
        }
        const end = b.fail ? (b.fail.afterMs ?? duration) : duration;
        let elapsed = 0;
        while (elapsed < end) {
          const step = Math.min(every, end - elapsed);
          await clock.sleep(step, signal);
          elapsed += step;
          if (!b.fail || elapsed < end) report(Math.min(total, Math.floor((total * elapsed) / duration)));
        }
        if (b.fail) {
          const error = new Error(b.fail.message ?? 'render-failed');
          if (b.fail.retryable === false) error.retryable = false;
          throw error;
        }
        call.state = 'ok';
        return artifacts();
      } catch (error) {
        call.state = signal?.aborted ? 'aborted' : 'failed';
        throw error;
      } finally {
        call.endedAt = clock.now();
      }
    }

    return { plan, render };
  }

  return {
    /** 绑定节点身份的 D.1 执行器接口 */
    forNode: bind,
    /** 加一条编排规则，返回规则本身（`hits` 记命中次数） */
    on(match, behavior = {}) {
      const rule = { match, behavior, remaining: behavior.times ?? Infinity, hits: 0 };
      rules.push(rule);
      return rule;
    },
    /** 放开卡死的调用（可按 `id` / `nodeId` 筛），它们随后照常返回产物。返回放开的个数。 */
    release({ id, nodeId } = {}) {
      let n = 0;
      for (let i = hung.length - 1; i >= 0; i--) {
        const { call, resolve } = hung[i];
        if ((id !== undefined && call.id !== id) || (nodeId !== undefined && call.nodeId !== nodeId)) continue;
        hung.splice(i, 1);
        resolve();
        n += 1;
      }
      return n;
    },
    /** 调用记录（可按 kind / id / nodeId 筛），按开始先后 */
    calls({ kind, id, nodeId } = {}) {
      return calls.filter(c => (kind === undefined || c.kind === kind) && (id === undefined || c.id === id)
        && (nodeId === undefined || c.nodeId === nodeId)).map(c => ({ ...c, progress: [...c.progress] }));
    },
    renderCount: id => calls.filter(c => c.kind === 'render' && c.id === id).length,
    /** 此刻卡着的调用 */
    hung: () => hung.map(h => ({ ...h.call, progress: [...h.call.progress] })),
    /** progress 回调抛出的异常 */
    errors: () => errors.slice(),
  };
}
