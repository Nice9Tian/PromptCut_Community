/**
 * Claim gate for local queue nodes: claims one extra item when the Agent dedicated instance is
 * running and idle (`docs/semantics/mechanism/rendering.md` "Agent priority is only queue jumping";
 * for the origin, see section 7, item 2 of `docs/archive/agent-reports/AGENT-query-render.md`).
 *
 * Local nodes have `maxConcurrent: 1`, and having two items queued simultaneously on the `'queue'`
 * lane is rare, so the Agent dedicated instance cannot pick up work from the regular prerender
 * queue when idle. Here we give the node session a `claimLimit`: when the dedicated instance can
 * accept work (`pipeline.agentSpareSlot()`) and the `'queue'` prerender room currently holds an
 * item, the limit is increased by one slot; that extra slot only claims tasks such as:
 *
 *   - Snapshot fine-grained tasks (`kind: 'snapshot'`). plan and track streams are not accepted:
 *     streams use the stream prerender room pool (claiming one extra item equals opening one more
 *     stream Chrome), and plan must be published and wait for responses, which is not "a regular
 *     prerender";
 *   - Not the same card as the snapshot currently in hand (shared tier by `contentKey`, local tier
 *     by `entryKey`, using the same criteria as `tag` in `runQueueTask` within the pipeline: the
 *     same card / the same version of the whole scene is not rendered concurrently on two
 *     instances). Tasks for the same card can only wait for the previous item anyway once received,
 *     so it is better to leave them to other nodes.
 *
 * Why claiming this way will not pick up work that cannot be finished (leases, locks, reporting):
 *
 *   - Just like regular claims, the extra claimed item is renewed by the session and its progress
 *     is reported by the execution arrangement; it is queued into the regular prerender queue via
 *     `runQueueTask` as usual in the pipeline, and handed to the dedicated instance by
 *     `kickAgentIdle`. If the dedicated instance is taken by the Agent before it arrives, it
 *     simply waits for the item in the `'queue'` prerender room to finish (at most one item) and
 *     will not hang indefinitely.
 *   - Does not require any instance other than the running dedicated instance: the `'queue'`
 *     prerender room is currently working on the previous item (one of the conditions), so this
 *     item will not cause the pipeline to launch a new Chrome; when the dedicated instance is not
 *     running, `agentSpareSlot()` is false and no extra item is claimed: do not launch new
 *     instances just to accept prerenders.
 *   - Card locks and result reporting follow the original execution path; claiming extra only
 *     changes "how many items can be held" and does not change how any item is executed.
 *
 * Pure logic, starts no timers.
 */

/** Which card (or which version of the whole scene) the snapshot task is mutually exclusive by: same criteria as `FramePipeline`'s `tag`. Returns null if not a snapshot task */
export function snapshotConflictKey(task) {
  if (task?.kind !== 'snapshot') return null;
  const input = task.input && typeof task.input === 'object' ? task.input : {};
  if (typeof input.entryKey === 'string' && input.entryKey) return `scene:${input.entryKey}`;
  if (typeof input.contentKey === 'string' && input.contentKey) return `card:${input.contentKey}`;
  return null;
}

/**
 * @param {object} options
 * @param {any} options.pipeline  `FramePipeline` (only reads `agentSpareSlot()`, `queueRunning`)
 * @param {number} [options.base]  Normal upper limit (`maxConcurrent` of the local node), default 1
 */
export function createAgentSpareGate({ pipeline, base = 1 }) {
  /** Snapshot tasks currently held by the executor: id → mutex key */
  const active = new Map();
  /** Whether the extra slot is currently open */
  const spare = () => {
    try { return pipeline?.agentSpareSlot?.() === true && !!pipeline.queueRunning; } catch { return false; }
  };
  return {
    /** `claimLimit` for the node session */
    claimLimit: () => base + (spare() ? 1 : 0),
    /** `canClaim` for the node session: regular slots accept anything; the extra slot only accepts the snapshot tasks described above */
    canClaim: (task, { held = 0 } = {}) => {
      if (held < base) return true;
      const key = snapshotConflictKey(task);
      if (!key || !spare()) return false;
      for (const other of active.values()) if (other === key) return false;
      return true;
    },
    /** Wraps the executor: records which snapshot tasks (mutex keys) are currently in progress, and removes them when finished */
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
    /** Diagnostics */
    describe: () => ({ spare: spare(), active: active.size }),
  };
}
