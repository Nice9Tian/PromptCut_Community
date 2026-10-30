/**
 * 本机队列节点的认领闸:Agent 专用实例开着且空闲时多认领一项(`docs/semantics/mechanism/rendering.md`「Agent 优先只是插队」;
 * 起因见 `docs/archive/agent-reports/AGENT-query-render.md` 第 7 节第 2 条)。
 *
 * 本机节点 `maxConcurrent: 1`,`'queue'` lane 上同时排着两项的情况很少,Agent 专用实例空闲时从普通预渲染队列里接不到活。
 * 这里给节点会话一个 `claimLimit`:专用实例能接(`pipeline.agentSpareSlot()`)、`'queue'` 预渲染间手里正有一项时,
 * 上限多一格;多出的那一格只认领这样的任务:
 *
 *   - 快照细任务(`kind: 'snapshot'`)。plan 与轨道流不接:流用流预渲染间池(多认领一项等于多开一个流 Chrome),
 *     plan 要发布、等回包,不是「一项普通预渲染」;
 *   - 和手里在做的快照不是同一张卡(共享档按 `contentKey`,本地档按 `entryKey`,和管线里 `runQueueTask` 的 `tag`
 *     同一个口径:同一张卡 / 同一版整场景不在两个实例上同时渲)。同卡的任务到手也只能等前一项,不如留给别的节点。
 *
 * 为什么这样认领不会拿到做不完的活(租约、锁、上报):
 *
 *   - 多认领的那一项和普通认领一样由会话续约、由执行编排上报进度,管线里照旧经 `runQueueTask` 排进普通预渲染队列,
 *     由 `kickAgentIdle` 交给专用实例;专用实例在它到手前被 Agent 用上了,它就等 `'queue'` 预渲染间手里那一项做完
 *     (至多一项),不会无限挂着。
 *   - 不要求专用实例开着以外的任何实例:`'queue'` 预渲染间此刻就在做前一项(条件之一),所以这一项不会让管线新开 Chrome;
 *     专用实例没开时 `agentSpareSlot()` 为 false,不多认领 —— 不为接预渲染开新实例。
 *   - 卡片锁、结果上报走的都是原来那条执行路径,多认领只改「能持有几项」,不改任何一项怎么做。
 *
 * 纯逻辑,不开计时器。
 */

/** 快照任务按哪张卡(或哪一版整场景)互斥:同 `FramePipeline` 的 `tag` 口径。不是快照任务回 null */
export function snapshotConflictKey(task) {
  if (task?.kind !== 'snapshot') return null;
  const input = task.input && typeof task.input === 'object' ? task.input : {};
  if (typeof input.entryKey === 'string' && input.entryKey) return `scene:${input.entryKey}`;
  if (typeof input.contentKey === 'string' && input.contentKey) return `card:${input.contentKey}`;
  return null;
}

/**
 * @param {object} options
 * @param {any} options.pipeline  `FramePipeline`(只读 `agentSpareSlot()`、`queueRunning`)
 * @param {number} [options.base]  平时的上限(本机节点的 `maxConcurrent`),缺省 1
 */
export function createAgentSpareGate({ pipeline, base = 1 }) {
  /** 执行器手里正在做的快照任务:id → 互斥键 */
  const active = new Map();
  /** 多出的那一格此刻开不开 */
  const spare = () => {
    try { return pipeline?.agentSpareSlot?.() === true && !!pipeline.queueRunning; } catch { return false; }
  };
  return {
    /** 给节点会话的 `claimLimit` */
    claimLimit: () => base + (spare() ? 1 : 0),
    /** 给节点会话的 `canClaim`:平时的格子什么都接;多出的那一格只接上面说的那种快照任务 */
    canClaim: (task, { held = 0 } = {}) => {
      if (held < base) return true;
      const key = snapshotConflictKey(task);
      if (!key || !spare()) return false;
      for (const other of active.values()) if (other === key) return false;
      return true;
    },
    /** 包执行器:记下手里在做哪些快照任务(互斥键),做完摘掉 */
    wrap(executor) {
      return {
        ...executor,
        render: async (task, opts) => {
          const key = snapshotConflictKey(task);
          const id = typeof task?.id === 'string' ? task.id : null;
          if (key && id) active.set(id, key);
          try { return await executor.render(task, opts); }
          finally { if (key && id && active.get(id) === key) active.delete(id); }
        },
      };
    },
    /** 诊断 */
    describe: () => ({ spare: spare(), active: active.size }),
  };
}
