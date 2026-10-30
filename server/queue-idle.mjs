/**
 * 本机队列节点的闲时门槛(M6c X5,`docs/plan/m6c-contract.md`;语义 `product/platforms.md`「节点只在闲时认领」)。
 *
 * M5b 的门槛是执行器的 `isIdle()`:要等 preload 到 `ready`(还要流不在忙),本机节点起步偏晚。现在改为:
 * 执行器有空位(持有 + 在飞 < maxConcurrent,由节点会话自己守),并且**最近 500 ms 没有交互帧请求**,
 * 就可以认领细任务。preload 还在跑、流还在产都不挡。
 *
 * 交互帧请求(拖动、播放)从这几处来:
 *   - 路由记下的:`/api/frames/see`(`user` lane,旧预览拖动取帧)、`/api/frames/playback`(旧预览播放时钟)——
 *     调用方经 `note()` 或 `lastInteractionAt()` 告诉门槛;
 *   - 管线身上的:旧预览热池在播(`playback.playing`)、后台让路租约在期或正在让路(编辑器进程播放时借走预渲染间);
 *   - 镜像插件报的播放头(`pipeline.playhead()`,页面拖动、播放时上报):在播且 5 秒内有过音讯,或者 500 ms 内动过。
 *
 * 用户播放或拖动时照语义让路:**不认领新的,手里在做的做完**(调用方不再因为忙而 `yieldAll`)。
 *
 * 纯逻辑,不开计时器;时钟可注入。
 */

/** 最近这么久内有过交互帧请求就不认领新任务 */
export const INTERACTION_QUIET_MS = 500;
/** 播放头报「在播」之后多久没再报就不算在播了(同 `FramePipeline.streamBusy`:播放中页面每 2 秒发一条保活,有缺口时另按 100 ms 节流报) */
export const PLAYING_STALE_MS = 5_000;

/**
 * 管线身上此刻有没有交互:回原因字符串,没有回 null。
 * @param {any} pipeline  `FramePipeline`(只读 closed、playback、backgroundYielding、backgroundLeaseUntil、playhead())
 */
export function interactionReason(pipeline, at, { quietMs = INTERACTION_QUIET_MS } = {}) {
  if (!pipeline) return null;
  if (pipeline.closed) return 'closed';
  if (pipeline.playback?.playing) return 'playback';
  if (pipeline.backgroundYielding || Number(pipeline.backgroundLeaseUntil) > at) return 'yield';
  let head = null;
  try { head = typeof pipeline.playhead === 'function' ? pipeline.playhead() : null; } catch { head = null; }
  const headAt = Number(head?.at);
  if (Number.isFinite(headAt)) {
    if (head.playing && at - headAt < PLAYING_STALE_MS) return 'playing';
    if (at - headAt < quietMs) return 'scrub';
  }
  return null;
}

/**
 * @param {object} [options]
 * @param {any} [options.pipeline]                     管线(可缺省:只看 note / lastInteractionAt)
 * @param {() => number} [options.now]
 * @param {number} [options.quietMs]
 * @param {() => number} [options.lastInteractionAt]  外面记的最近一次交互帧请求时刻(路由里记的)
 */
export function createQueueIdleGate({ pipeline = null, now = Date.now, quietMs = INTERACTION_QUIET_MS, lastInteractionAt = () => -Infinity } = {}) {
  let noted = -Infinity;
  const latest = () => {
    const outside = Number(lastInteractionAt());
    return Math.max(noted, Number.isFinite(outside) ? outside : -Infinity);
  };
  /** 此刻不能认领的原因;能认领回 null */
  const reason = (at = now()) => {
    if (at - latest() < quietMs) return 'interaction';
    return interactionReason(pipeline, at, { quietMs });
  };
  return {
    /** 记一次交互帧请求(拖动取帧、播放时钟) */
    note(at = now()) { if (at > noted) noted = at; },
    /** 能不能认领新任务 */
    idle: (at = now()) => reason(at) === null,
    reason,
    get lastInteractionAt() { return latest(); },
  };
}
