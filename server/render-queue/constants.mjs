/**
 * 渲染任务队列的调优常量（设计第 8 节 Q4 的基线值）。
 *
 * M1 / M2 只用基线值、只导出以后的环境变量名，不读环境变量：读环境变量是挂上文档服务（M5）的
 * 适配层的事，队列本体保持纯逻辑，测试靠 `createRenderQueue({ constants })` 覆盖。
 */

export const QUEUE_DEFAULTS = Object.freeze({
  LEASE_MS: 30_000, RENEW_INTERVAL_MS: 10_000, SWEEP_INTERVAL_MS: 5_000,
  RECONNECT_GRACE_MS: 10_000, STALL_MS: 120_000, MAX_ATTEMPTS: 3,
  DONE_TTL: 600_000, MAX_TASKS_PER_PROJECT: 5000,
  SNAPSHOT_SPAN: 60, STREAM_SEGMENTS: 8, PICK_K: 4,
  // 按节点指纹前置过滤的开关（契约 I.1）；false 时行为与加这一项之前完全相同，作对照组。唯一不是数的一项
  PREFILTER: true,
  // 一个扫描周期内 card-locked 拒绝超过这个数，这条连接之后的认领回 throttled，直到下一次 tick（I.5）
  THROTTLE_REJECTS: 20,
  // plan 就近认领的独占窗口（M6c X4）：带 requires.preferNode 的 plan 发布后这么久之内，只有那个节点能认领
  PLAN_PREFER_MS: 5_000,
});

/** 以后抽成环境变量时用的名字（设计第 8 节的表），键与 QUEUE_DEFAULTS 一一对应 */
export const QUEUE_ENV = Object.freeze({
  LEASE_MS: 'PROMPTCUT_QUEUE_LEASE_MS', RENEW_INTERVAL_MS: 'PROMPTCUT_QUEUE_RENEW_MS',
  SWEEP_INTERVAL_MS: 'PROMPTCUT_QUEUE_SWEEP_MS', RECONNECT_GRACE_MS: 'PROMPTCUT_QUEUE_GRACE_MS',
  STALL_MS: 'PROMPTCUT_QUEUE_STALL_MS', MAX_ATTEMPTS: 'PROMPTCUT_QUEUE_MAX_ATTEMPTS',
  DONE_TTL: 'PROMPTCUT_QUEUE_DONE_TTL_MS', MAX_TASKS_PER_PROJECT: 'PROMPTCUT_QUEUE_MAX_TASKS',
  SNAPSHOT_SPAN: 'PROMPTCUT_QUEUE_SNAPSHOT_SPAN', STREAM_SEGMENTS: 'PROMPTCUT_QUEUE_STREAM_SEGMENTS',
  PICK_K: 'PROMPTCUT_QUEUE_PICK_K',
  PREFILTER: 'PROMPTCUT_QUEUE_PREFILTER', THROTTLE_REJECTS: 'PROMPTCUT_QUEUE_THROTTLE_REJECTS',
  PLAN_PREFER_MS: 'PROMPTCUT_QUEUE_PLAN_PREFER_MS',
});

/**
 * 队列锁闲置多久切分方就可以接手（M7 契约 D2，第 13 节裁定）：严格超过这么久没有产出（认领、续约、完成），
 * 锁定方这张卡又还没做完，pc 与独立渲染主机切分时带 takeover 按自己的指纹重发（`render-node/local-node.mjs` 的
 * `idleLockTakeover`）。与本机锁库 `server/card-lock.mjs` 的 `CARD_LOCK_IDLE_MS` 同一个数（三级数字）；那边引了
 * 文件系统，节点侧不能引，所以在这里另记一份，单测核对两边相等。不是 QUEUE_DEFAULTS 的一项：队列本体不用它。
 */
export const LOCK_IDLE_TAKEOVER_MS = 30_000;

/**
 * 节点报「还在、在忙」（`node.active`，M7 D2 补充〔裁〕，`claude/queue-maint`）的间隔：队列在 `node.welcome` 里以
 * `activeIntervalMs` 告诉节点，节点忙着（生成别的卡的快照、后台舞台在测量或补跑）又没有这张卡的认领时按它报。
 * 必须明显小于 `LOCK_IDLE_TAKEOVER_MS`：两次之间锁的闲置最多长到这么久，远不到接手的门槛（三级数字，沿用续约间隔）。
 * 不是 QUEUE_DEFAULTS 的一项（那张表的键被契约 A.2 列死）。
 */
export const NODE_ACTIVE_INTERVAL_MS = 10_000;
