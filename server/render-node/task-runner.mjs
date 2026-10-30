/**
 * 细任务的执行编排(M7 契约 D11 (a):从 `local-node.mjs` 抽出来的同构模块,桌面与页面的纯浏览器节点共用)。
 *
 * 不引任何模块:不引 `split.mjs`、队列本体、`fingerprint.mjs`,没有 `node:` 内置模块,不开计时器、不读环境变量,
 * 所以能原样进页面构建。切分(`plan` 任务)不在这里:桌面的 `local-node.mjs` 经 `executePlan` 注入;
 * 纯浏览器不认领 plan(设计 4.3 规则 6),页面不给 `executePlan`,真收到 plan 就按不可重试失败处理。
 *
 * # 认领到一个细任务之后(与 M3 起 local-node 的做法相同,契约 D.2)
 *
 *   开工先同步报一次进度 0:队列的停滞规则只在 done !== null 时生效,执行器卡死又从不报进度时也回收得到。
 *   sink.has 为真就直接 complete(dedup,带 sink.resultFor 的清单);否则 executor.render → sink.put →
 *   收全才 complete(带 put 回的清单),没收全 fail(可重试)。sink 收到的 ref 带任务的 input 与 requires(契约 J.3)。
 *   出错 fail,`error.retryable === false` 才不可重试。
 *   执行器抛的错带 `superseded === true`(这份内容已被新版本取代,`render-queue-contract.md` J.15):同样发 `task.fail`,
 *   但 error 固定为 `'superseded'`、不可重试(队列按这个 error 认作废),诊断事件是 `superseded` 而不是 `failed`。
 *
 * # 「仍持有」与迟到的结果
 *
 * 每个认领开一次「执行」(run),带自己的令牌和 AbortController。执行里每个 await 落定后,往队列发任何消息之前
 * 都要重新判一次仍持有:没有 stop、本次执行没被中止、在跑表里的仍是这一次执行,且 `session.held()` 里有同 id、
 * 同令牌的持有。判完到发消息之间不 await。判不过就丢弃结果、报 `discarded`,不发任何消息;已经推到产物库的产物
 * 不回收(按内容寻址,下一个认领者查 `has` 会直接完成)。
 *
 * 对注入接口的每次等待都和中止信号赛跑(`untilAborted`):执行器或产物库不理会中止、一直不返回,这次执行也会在
 * 中止时落定(`settled()` 不会被卡死的执行器拖住),之后它再返回什么都被丢弃。
 *
 * # 阶段与收尾事件的诊断(`docs/archive/agent-reports/AGENT-stall-phases.md`)
 *
 * 每次执行记它此刻在哪个阶段:`dedup`(`sink.has`)、`manifest`(`sink.resultFor`)、`render`(`executor.render`)、
 * `push`(`sink.put`)、`plan`(切分)。执行器与产物库可以经多给的回调报细一层的位置(执行器的第二个参数里
 * `phase(name, fields)`;产物库 `put` 的第二个参数里 `report({ stage, blocks, pushed, bytes })`),不用也照常工作。
 * `lost`、`discarded`、`failed`、`completed`、`dedup` 事件带上:阶段 `phase` 与细分 `detail`、帧数 `done`、
 * 距上次帧数变化 `sinceDoneMs`、距认领 `sinceClaimMs`、在这一阶段多久 `phaseMs`;推送阶段另带
 * `push: { blocks, pushed, bytes, ms }`。时刻由注入的 `now` 取(缺省 `Date.now`),不开计时器。
 *
 * # 工作计数(契约 A.12〔裁〕)
 *
 * 换阶段、执行器报一步(出一批帧、换一个细分位置)、产物库每推完一块,都调一次会话的 `advance(id)`(会话没有这个方法就不调):
 * 队列按它判「还在报进度」,推产物、渲完收尾这些帧数不变的阶段不再被当成卡死。执行器或产物库真卡死时这些回调都不来,
 * 计数不动,照旧在 STALL_MS 后按停滞收回(I8)。
 * `occupying()` 列出还没走到推送的执行(`{ id, kind, phase }`):独立渲染主机据此只在预渲染间空着时认领(`host.mjs`)。
 *
 * @typedef {object} TaskRunner
 * @property {(task: object, ctx: { token: number, browserFingerprints?: string[], browserCardEnvFingerprints?: string[] }) => void} onTask  会话的 onTask
 * @property {(id: string, reason: string) => void} onLost   会话的 onLost
 * @property {(run: object) => boolean} holding
 * @property {(reason: string) => void} abortAll
 * @property {(reason?: string) => void} stop       停手:此后不再往队列发任何消息
 * @property {() => void} resume                    `stop` 之后重新开始(local-node 的 start)
 * @property {() => boolean} stopped
 * @property {(id: string) => number | null} tokenOf   跑表里这个 id 的令牌(接续判断用)
 * @property {() => string[]} running
 * @property {() => { id: string, kind: string, phase: string }[]} occupying   还没走到推送的执行
 * @property {() => Promise<void>} settled
 */

/** 中止时抛出的标记:赛跑输给中止信号,不是执行器自己的错误。 */
export const ABORTED = Symbol('aborted');

/** 等 promise 落定,或者等到中止信号,先到先算。信号已经中止就立即拒绝。 */
export function untilAborted(work, signal) {
  if (signal.aborted) return Promise.reject(ABORTED);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // 执行器可能同步抛出,也可能返回非 Promise 的值:统一包成 Promise
  const settled = new Promise(resolve => resolve(work()));
  return Promise.race([settled, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** sink 回的清单 → 可展开进 `complete` 结果的对象;不是普通对象(null、缺省、数组)就什么都不加。 */
export function resultFields(result) {
  return result != null && typeof result === 'object' && !Array.isArray(result) ? result : {};
}

/**
 * @param {object} options
 * @param {string} options.nodeId
 * @param {() => { held(): { id: string, token: number }[], progress(id: string, done: number): boolean,
 *   complete(id: string, result?: object): boolean, fail(id: string, error?: string, retryable?: boolean): boolean }} options.session
 *   会话的取值函数(会话要 onTask / onLost,所以 runner 先建、会话后建)
 * @param {{ render: (task: object, opts: { signal: AbortSignal, progress: (done: number) => void }) => Promise<unknown> }} options.executor
 * @param {{ has: Function, put: Function, resultFor?: Function }} options.sink
 * @param {(event: object) => void} [options.emit]   诊断事件(调用方负责吞掉它自己的异常)
 * @param {() => number} [options.now]   诊断用的时钟(缺省 `Date.now`)
 * @param {(run: object, task: object, ctx: object) => Promise<void>} [options.executePlan]
 *   plan 任务怎么做(桌面给);它抛出的错误按细任务的规矩 fail。不给时 plan 按不可重试失败处理
 * @returns {TaskRunner}
 */
export function createTaskRunner({ nodeId, session, executor, sink, emit = () => {}, executePlan = null, now = Date.now }) {
  /** 在跑表:id → 当前这一次执行 { id, token, kind, controller }。中止即移出 */
  const active = new Map();
  /** 还没落定的执行(含已中止、还在收尾的),供 `settled()` 等 */
  const pending = new Set();
  let stopped = false;

  function abortRun(run, reason) {
    if (active.get(run.id) === run) active.delete(run.id);
    run.controller.abort(reason);
  }

  function abortAll(reason) {
    for (const run of [...active.values()]) abortRun(run, reason);
  }

  const clock = () => {
    try { const t = now(); return Number.isFinite(t) ? t : Date.now(); } catch { return Date.now(); }
  };

  /** 工作推进了一步(见文件头「工作计数」):仍持有才记 */
  function touch(run) {
    if (!holding(run)) return;
    try { session().advance?.(run.id); } catch { /* 会话坏了:续约照样会失败,由队列按租约收回 */ }
  }

  /**
   * 进入一个阶段(诊断);细一层的位置清空。换阶段也算工作推进了一步,并且当场报一次进度(带新的计数):
   * 下一步若卡死,停滞计时从这一刻算起,不用等下一次续约(I8 的收回时刻不因计数推迟)。
   */
  function enter(run, phase) {
    run.phase = phase;
    run.phaseAt = clock();
    run.detail = null;
    touch(run);
    if (!holding(run)) return;
    try { session().progress(run.id, run.done); } catch { /* 连接坏了:由执行里的异常处理或队列的租约收尾 */ }
  }

  /** 执行器、产物库报的细一层位置(诊断):只留名字和数字字段 */
  function note(run, name, fields) {
    if (typeof name !== 'string' || !name) return;
    const detail = { name: name.slice(0, 40) };
    if (fields && typeof fields === 'object') {
      for (const [k, v] of Object.entries(fields)) if (typeof v === 'number' && Number.isFinite(v)) detail[k.slice(0, 24)] = v;
    }
    run.detail = detail;
    touch(run);
  }

  /** 事件里带的执行诊断(见文件头) */
  function info(run) {
    const t = clock();
    const out = {
      phase: run.phase, done: run.done,
      sinceDoneMs: Math.max(0, t - run.doneAt), sinceClaimMs: Math.max(0, t - run.claimedAt), phaseMs: Math.max(0, t - run.phaseAt),
    };
    if (run.detail) out.detail = { ...run.detail };
    if (run.push) {
      const { blocks, pushed, bytes, startedAt, endedAt } = run.push;
      out.push = { blocks, pushed, bytes, ms: Math.max(0, (endedAt ?? t) - startedAt) };
    }
    return out;
  }

  /** 产物库 `put` 的进度回调:推送开始时给总块数,每推完一块给已推块数 */
  function pushReport(run) {
    return (update) => {
      if (!update || typeof update !== 'object' || !run.push || run.controller.signal.aborted) return;
      const before = run.push.pushed;
      for (const k of ['blocks', 'pushed', 'bytes']) if (Number.isFinite(update[k])) run.push[k] = update[k];
      if (typeof update.stage === 'string') note(run, update.stage);
      else if (run.push.pushed !== before) touch(run);
    };
  }

  /** 仍持有:见文件头。同步判定,判完到发消息之间不能 await。 */
  function holding(run) {
    if (stopped || run.controller.signal.aborted || active.get(run.id) !== run) return false;
    return session().held().some(hold => hold.id === run.id && hold.token === run.token);
  }

  function onTask(task, ctx = {}) {
    const id = task?.id;
    if (id == null) return;
    // 同一 id 还挂着旧的执行:它的持有已经没了(否则会话不会再调 onTask),先中止
    const previous = active.get(id);
    if (previous) abortRun(previous, 'reclaimed');
    const at = clock();
    const run = {
      id, token: ctx.token, kind: task.kind, controller: new AbortController(),
      // 诊断(见文件头「阶段与收尾事件的诊断」)
      claimedAt: at, phase: 'start', phaseAt: at, detail: null, done: 0, doneAt: at, push: null,
    };
    active.set(id, run);
    // 开工先报一次进度 0(契约 D.2〔裁〕)
    try {
      session().progress(id, 0);
    } catch {
      // 连接已坏:后面的发送同样会失败,由执行里的异常处理收尾
    }
    const done = execute(run, task, ctx).then(() => {
      if (active.get(id) === run) active.delete(id);
      pending.delete(done);
    });
    pending.add(done);
  }

  function onLost(id, reason) {
    const run = active.get(id);
    const diag = run ? info(run) : {};
    if (run) abortRun(run, reason);
    emit({ type: 'lost', id, reason, ...diag });
  }

  /** 一次执行。从不拒绝:所有异常都在这里收掉。 */
  async function execute(run, task, ctx) {
    const { id } = run;
    const { signal } = run.controller;
    const discard = () => {
      const why = signal.reason;
      emit({ type: 'discarded', id, ...(typeof why === 'string' && why ? { reason: why } : {}), ...info(run) });
    };
    try {
      if (task.kind === 'plan') {
        enter(run, 'plan');
        if (typeof executePlan !== 'function') {
          throw Object.assign(new Error('这个节点不切分 plan 任务'), { retryable: false });
        }
        await executePlan(run, task, ctx);
        return;
      }

      const { resultKey, kind, range } = task;
      // input / requires 原样带上:本地档的落盘键要用 input.entryKey、input.contentKey、
      // requires.envFingerprint,canvasHeavy 取 input.canvasHeavy(C6.2 第 11 节第 2、3 条,J.3)
      const ref = { resultKey, kind, tier: task.tier ?? null, range, input: task.input, requires: task.requires };
      const ranges = [[range?.from, range?.to]];

      enter(run, 'dedup');
      // 产物库查的时候可能顺手把本机已有、素材服务上缺的块补推(AGENT-sink-has):每处理完一块也算工作推进了一步
      const dedupReport = (update) => {
        if (signal.aborted || !update || typeof update !== 'object') return;
        if (typeof update.stage === 'string') note(run, update.stage);
        else if (Number.isFinite(update.pushed)) note(run, run.detail?.name ?? 'dedup', { blocks: update.blocks, pushed: update.pushed });
      };
      const have = await untilAborted(() => sink.has({ ...ref }, { signal, report: dedupReport }), signal);
      if (!holding(run)) return discard();
      if (have === true) {
        // 去重完成也带清单,订阅方才拉得到(C6.4 第 3 节);sink 没有 resultFor 时照旧(D.2)
        // resultFor 抛错算「没有清单」:照旧以去重方式完成,不让任务失败(契约 J.10)
        let manifest = null;
        if (typeof sink.resultFor === 'function') {
          enter(run, 'manifest');
          try {
            manifest = await untilAborted(() => sink.resultFor({ ...ref }), signal);
          } catch (error) {
            if (error === ABORTED) throw error;
            manifest = null;
          }
          if (!holding(run)) return discard();
        }
        session().complete(id, { ranges, dedup: true, ...resultFields(manifest) });
        emit({ type: 'dedup', id, ...info(run) });
        return;
      }

      const progress = done => {
        if (signal.aborted) return;
        if (done !== run.done) { run.done = done; run.doneAt = clock(); }
        touch(run);
        if (holding(run)) session().progress(id, done);
      };
      // 执行器报细一层的位置(诊断,可以不调)
      const phase = (name, fields) => { if (!signal.aborted) note(run, name, fields); };
      enter(run, 'render');
      const artifacts = await untilAborted(() => executor.render(task, { signal, progress, phase }), signal);
      if (!holding(run)) return discard();

      enter(run, 'push');
      run.push = { blocks: null, pushed: 0, bytes: null, startedAt: clock(), endedAt: null };
      const report = pushReport(run);
      const r = await untilAborted(
        () => sink.put({ ...ref, artifacts, meta: { taskId: id, nodeId, token: run.token } }, { signal, report }),
        signal,
      );
      run.push.endedAt = clock();
      if (!holding(run)) return discard();
      if (r?.complete !== true) {
        session().fail(id, 'sink-incomplete', true);
        // 产物库说了为什么没收全(缺帧、缺小尺寸、推送出错)就一并记下;报给队列的 error 仍是 sink-incomplete
        const why = typeof r?.reason === 'string' && r.reason ? { why: r.reason.slice(0, 300) } : {};
        emit({ type: 'failed', id, error: 'sink-incomplete', retryable: true, ...why, ...info(run) });
        return;
      }
      // put 回的清单(C6.2 第 3 节)展开进 task.done 的 result(J.3)
      session().complete(id, { ranges, ...resultFields(r.result) });
      emit({ type: 'completed', id, ...info(run) });
    } catch (error) {
      if (error === ABORTED || !holding(run)) return discard();
      // 这份内容已被新版本取代(执行器判的,契约 J.15):报给队列作废(error 固定为 'superseded'、不可重试),不算失败
      if (error?.superseded === true) {
        try {
          session().fail(id, 'superseded', false);
        } catch {
          // 连接已坏:同下,队列会按租约或断开回收
        }
        emit({ type: 'superseded', id, ...(typeof error.detail === 'string' && error.detail ? { why: error.detail.slice(0, 300) } : {}), ...info(run) });
        return;
      }
      const message = String(error?.message ?? error);
      const retryable = error?.retryable !== false;
      try {
        session().fail(id, message, retryable);
      } catch {
        // 连发失败都做不到(连接已坏):持有已经从会话里移除,队列会按租约或断开回收
      }
      emit({ type: 'failed', id, error: message, retryable, ...info(run) });
    }
  }

  return {
    onTask,
    onLost,
    holding,
    abortAll,
    stop(reason = 'stopped') {
      stopped = true;
      abortAll(reason);
    },
    resume() { stopped = false; },
    stopped: () => stopped,
    tokenOf: id => active.get(id)?.token ?? null,
    running: () => [...active.keys()].sort(),
    /** 还没走到推送的执行(见文件头「工作计数」) */
    occupying: () => [...active.values()].filter(run => run.phase !== 'push').map(({ id, kind, phase }) => ({ id, kind, phase })),
    settled: async () => { await Promise.all([...pending]); },
  };
}
