/**
 * Render queue core: pure in-memory state machine for the pull-based task queue hosted by the
 * document service (design sections 3, 4, 5).
 *
 * Only two inputs: "a connection sends a message" (handle) and "the clock advances to a tick"
 * (tick); only one output: "send a message to a connection" (send). Transport, authentication,
 * and artifact storage are all external to the interface, so no timers are started, no environment
 * variables are read, and no I/O is performed here; the clock is injected by the caller.
 *
 * Both handle and tick are synchronous steps that never yield the event loop during execution
 * nor invoke caller callbacks (except send): "compare-and-lock" during claim relies on this
 * (design 4.2). Each step finishes modifying state before sending outbound messages, so outbound
 * send errors leave no half-modified state behind.
 *
 * Contracts: `docs/plan/render-queue-contract.md` section A; per-card fingerprint locks
 * (lock table, card.lock, claim step 3a, takeover) see F.1; node-fingerprint prefiltering,
 * targeted deltas on lock changes, and rejection rate-limiting see section I (switch PREFILTER).
 *
 * M6c (`docs/plan/m6c-contract.md`):
 * - X2 Local tier capability gate: tasks with `requires.localMedia = <nodeId>` are only assigned
 *   to that node: other nodes cannot see them in prefiltering (PREFILTER); on claim, other nodes
 *   receive `local-media` (regardless of switch, a correctness gate like card-locked).
 * - X3 `watch: 'all'` tightened: `browser` returns `error { reason: 'forbidden' }`; `host` only
 *   receives project summary `queue.summary` (shape matches contract H.3) and not single-task
 *   deltas; `pc` as before. See onWatch.
 * - X4 plan affinity claim: a plan with `requires.preferNode` can only be claimed by that node
 *   within `PLAN_PREFER_MS` after publish; others receive `preferred` (with `retryInMs`); after the
 *   window expires, any pc with a matching fingerprint can claim it. `browser` claiming a plan
 *   always returns `plan-profile`; `host` claiming a plan without a clip manifest returns
 *   `plan-profile` (C10 contract section 18 item 9: host can claim plans with manifests). If
 *   preferNode disconnects, the window ends immediately and is not restored on reconnect
 *   (integration ruling, see detachNode).
 *
 * M7 (`docs/plan/m7-contract.md` section 13 ruling):
 * - D1 plan's `task.claimed` includes `browserFingerprints`: fingerprints of pure browser nodes
 *   that are online for this project, belong to the same user as the plan, and watch this project
 *   (see browserFingerprintsFor); the splitter uses this to emit an additional copy for cards the
 *   browser can do; upon locking at claim (as well as locking via card.lock or claiming with the
 *   same fingerprint), incomplete tasks with the same lock key, different fingerprint, and
 *   `input.dual` true are invalidated (superseded, see supersedeDual). Invalidated task records do
 *   not block republishing (treated as nonexistent).
 * - D2 Lock idle takeover: card-locked publish responses and claim responses include `lockIdleMs`
 *   (current time minus locking party's last output) and `lockedByProfile`; publish responses also
 *   include `lockUndone` (number of unfinished tasks for this card by the locking party); when a
 *   node with a different fingerprint publishes against the lock (neither merge nor creation is
 *   rejected), the response likewise carries these three items (without lockedBy), so the splitter
 *   can judge whether to take over (M7-A10); renewing also refreshes the lock. "Output" only counts
 *   claim, renewal, completion, and card.lock, not publish (`producedAt`; `touchedAt` per F.1 still
 *   governs reclamation).
 * - D9 nodeId bound to userId: while the node record exists, another userId checking in with the
 *   same nodeId receives forbidden.
 * - D10 `node.welcome` returns this node's `envFingerprint` (browser fingerprint is computed and
 *   passed in by document service module from raw value reported by page).
 *
 * Online execution of user cards and media effect cards (chunk N,
 * `docs/plan/online-card-exec-contract.md` section 7):
 * - Pure browser nodes also have `cardEnvFingerprint` (three environment items plus online card
 *   runtime version, likewise computed and passed in by document service), returned by
 *   `node.welcome`; other profiles and browsers that did not report runtime version lack this
 *   property.
 * - For tasks where `requires.userCards` / `requires.graphCards` is true, browser nodes compare
 *   prefiltering, claim fingerprint checks, and lock idleness checks against `cardEnvFingerprint`;
 *   browsers lacking this property never match such tasks (invisible, claim blocked). Built-in card
 *   tasks and other profiles remain unchanged verbatim.
 * - plan's claim response also carries `browserCardEnvFingerprints` (`cardEnvFingerprint` of
 *   browser nodes that are online for this project, belong to same user, and watch it), by which
 *   the splitter verifies that a node indeed exists for the "cards runnable on this page"
 *   self-reported by the page.
 *
 * M7 D2 supplement [ruling] (`claude/queue-maint`, `REPORT-M7.md` section 11 line 1 "page being
 * merely busy also triggers D2 takeover"):
 * - `node.welcome` includes `activeIntervalMs` (`NODE_ACTIVE_INTERVAL_MS`): notifies the node that
 *   this queue recognizes `node.active`;
 * - `node.active { busy? }`: node is still present and busy (page is generating snapshots for other
 *   cards, background stage is measuring or catch-up running), no response sent, only records
 *   `activeAt`;
 * - Lock records the node `nodeId` that last produced for it (claim, renew, complete). `lockIdleMs`
 *   in response changes to "current time minus locking party's last output or busy report": when
 *   that node is **currently connected**, fingerprint unchanged, and has reported `node.active`,
 *   the later of its `activeAt` and `producedAt` is taken; when disconnected (including grace
 *   period), never reported (legacy page), or stopped reporting busy, only `producedAt` remains,
 *   matching prior behavior. Splitter logic (`idleLockTakeover`) requires no change.
 */
import { randomUUID } from 'node:crypto';
import { QUEUE_DEFAULTS, NODE_ACTIVE_INTERVAL_MS } from './constants.mjs';
import { makeMessage, parseInbound, lockKeyOf, priorityBand, prioritySummaryValue, isListPlan, NODE_TYPES, PUBLISHER_TYPES } from './messages.mjs';

function resolveConstants(overrides) {
  const out = { ...QUEUE_DEFAULTS };
  if (overrides === undefined || overrides === null) return Object.freeze(out);
  if (typeof overrides !== 'object') throw new TypeError('createRenderQueue: constants must be an object');
  for (const key of Object.keys(QUEUE_DEFAULTS)) {
    const v = overrides[key];
    if (v === undefined) continue;
    if (typeof QUEUE_DEFAULTS[key] === 'boolean') {
      // Switch (PREFILTER, contract I.1) only accepts boolean
      if (typeof v !== 'boolean') throw new TypeError(`createRenderQueue: constants.${key} must be a boolean`);
    } else if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`createRenderQueue: constants.${key} must be a finite number`);
    out[key] = v;
  }
  return Object.freeze(out);
}

export function createRenderQueue(options = {}) {
  const { now, send } = options;
  if (typeof now !== 'function') throw new TypeError('createRenderQueue: now must be a function');
  if (typeof send !== 'function') throw new TypeError('createRenderQueue: send must be a function');
  if (options.epoch !== undefined && typeof options.epoch !== 'string') throw new TypeError('createRenderQueue: epoch must be a string');
  const C = resolveConstants(options.constants);
  // New instance = new epoch: after document service restarts, parties rely on it to recognize that
  // legacy claims are invalidated (design section 5)
  const epoch = options.epoch ?? randomUUID();

  /**
   * Connection: connId → { connId, principal, nodeId, publisherId, watch, cardLockedRejects }.
   * Use object itself rather than connId to identify "same connection": connId may be reused by a
   * new connection, whereas claims record the connection at that time.
   */
  const conns = new Map();
  /**
   * Node identity (across connections): nodeId → { nodeId, userId, profile, envFingerprint,
   * capabilities, codeVersions, maxConcurrent, conn, disconnectedAt, activeAt, activeBusy }
   * (userId: M7 D9; activeAt / activeBusy: M7 D2 addition, timestamp of the last `node.active`
   * and what it was busy with, null if never reported)
   */
  const nodes = new Map();
  /** Publisher identity (across connections): publisherId → { publisherId, conn, disconnectedAt } */
  const publishers = new Map();
  /** Task table: id → task (see describe and viewOf for fields) */
  const tasks = new Map();
  /** Number of open + claimed tasks per project, used for MAX_TASKS_PER_PROJECT; done / failed not counted (P10) */
  const activeByProject = new Map();
  /**
   * Per-card fingerprint lock (F.1): lockKey → { envFingerprint,
   * source: 'claim' | 'lock' | 'takeover', since, touchedAt, producedAt, profile, nodeId }.
   * `producedAt` and `profile` (M7 D2): timestamp and profile of the locking party's last production
   * (claim, renewal, completion, card.lock); `lockIdleMs` / `lockedByProfile` in the response are
   * computed from them; `nodeId` (M7 D2 addition): node that last produced for it via claim,
   * renewal, or completion; when it is currently connected and reporting busy (`node.active`),
   * the lock is not considered idle (see lockLastActive). None of the three enter describe().
   * Under the same lock, only results from one environment are produced and delivered, so
   * consecutive frames pasted on the page do not mix environments (Design 2.1 "Who sets fingerprints").
   * In memory only, invalidated with epoch just like the task table: locks start empty in a new instance.
   */
  const locks = new Map();

  /** Timestamp for this step: clock is read once per entry point; all timestamps in the same step are consistent */
  let at = 0;

  // ---------- Send messages ----------

  function emit(conn, type, fields, reqId) {
    const msg = makeMessage(epoch, type, fields, reqId);
    // A transport error on a connection should not bring down the queue: state has already been modified,
    // here only this single message is dropped
    try { send(conn.connId, msg); } catch { /* Leave it to the transport layer to handle */ }
  }

  const isLive = (conn) => conn !== null && conns.get(conn.connId) === conn;

  /** Which node this connection currently represents (no longer represents it once replaced by a new connection with the same nodeId) */
  function nodeOf(conn) {
    if (conn.nodeId === null) return null;
    const node = nodes.get(conn.nodeId);
    return node && node.conn === conn ? node : null;
  }
  function publisherOf(conn) {
    if (conn.publisherId === null) return null;
    const pub = publishers.get(conn.publisherId);
    return pub && pub.conn === conn ? pub : null;
  }

  /**
   * Visibility (A.9): sent only to node connections that watched this project; browser-only nodes
   * see only their own tasks (Q2), this boundary is guarded here, not relying on nodes to filter
   * themselves.
   * When PREFILTER is on, add fingerprint pre-filtering (I.2, see envAllows).
   */
  function canSee(conn, task) {
    if (conn.watch === null) return false;
    const node = nodeOf(conn);
    if (!node) return false;
    if (conn.watch !== 'all' && !conn.watch.has(task.source.projectId)) return false;
    if (node.profile === 'browser' && task.source.userId !== conn.principal.userId) return false;
    if (C.PREFILTER && (!envAllows(node, task) || !localMediaAllows(node, task))) return false;
    return true;
  }

  /** Only a non-empty string counts as having a fingerprint; empty string, null, or missing are treated as absent */
  const fingerprintOf = (v) => (typeof v === 'string' && v !== '' ? v : null);

  /** Whether the task needs to execute user card or media effect card code in the node (`requires.userCards` / `requires.graphCards`) */
  const runsCardCode = (task) => !!task?.requires && typeof task.requires === 'object' && (task.requires.userCards === true || task.requires.graphCards === true);
  /**
   * Environment fingerprint used when this node claims this task (Block N,
   * `docs/plan/online-card-exec-contract.md` section 7 item 4).
   * Browser-only nodes execute tasks for user cards and media effect cards using `cardEnvFingerprint`
   * (three environment values plus online card runtime version); all others use `envFingerprint`,
   * leaving built-in card tasks and other profiles completely unchanged. When a browser node lacks
   * `cardEnvFingerprint` (did not report a runtime version, old page), tasks for user cards and media
   * effect cards will never match it (`NO_CARD_RUNTIME` does not equal any fingerprint): invisible,
   * and claims are blocked by fingerprint: pages that have not declared ability to execute these cards
   * will not receive their tasks (on the same machine its `envFingerprint` is identical to the desktop
   * copy; without blocking, it would see the desktop copy).
   */
  const NO_CARD_RUNTIME = '<no-card-runtime>';
  function nodeFpFor(node, task) {
    if (node?.profile === 'browser' && runsCardCode(task)) return fingerprintOf(node.cardEnvFingerprint) ?? NO_CARD_RUNTIME;
    return fingerprintOf(node?.envFingerprint);
  }
  /** Only a non-empty string counts as provided; localMedia (X2) and preferNode (X4) in requires are both read this way */
  const requiredOf = (task, name) => {
    const v = task.requires ? task.requires[name] : undefined;
    return typeof v === 'string' && v !== '' ? v : null;
  };

  /**
   * Local tier capability gate (M6c X2): when task inputs contain assets without content hashes,
   * the splitter writes `requires.localMedia = <publisher nodeId>`, as those assets exist only on
   * the publisher's local machine and other nodes cannot get them. Only this node can see and claim them.
   * Tasks without this field are unaffected.
   */
  function localMediaAllows(node, task) {
    const owner = requiredOf(task, 'localMedia');
    return owner === null || owner === node.nodeId;
  }

  /**
   * Whether plan checks fingerprints (M6c X4): plans with `requires.preferNode` (sent this way by
   * publishers since M6c) are given to "any pc matching fingerprint" after the window expires,
   * so check; legacy shapes without it do not check per I.10 item 7 (whoever claims it, their
   * fingerprint is the fingerprint for this revision). Fine-grained tasks always check.
   */
  const checksFingerprint = (task) => task.kind !== 'plan' || requiredOf(task, 'preferNode') !== null;

  /**
   * Fingerprint pre-filtering (I.2, semantics mechanism/document-service.md "Fingerprint pre-filtering
   * (special case)"): tasks whose environment does not match, or whose card is already locked by another
   * environment, are not sent to this node. Otherwise, once a lock changes, nodes with mismatching
   * fingerprints would rush to claim and all get rejected with card-locked (lock storm).
   * When a node carries no fingerprint, neither rule takes effect, same as before adding filtering;
   * capability filtering is still handled by nodes themselves.
   */
  function envAllows(node, task) {
    const nodeFp = nodeFpFor(node, task);
    if (nodeFp === null) return true;
    // 1. Fingerprint matches: does not take effect when task carries no fingerprint. Plans without
    //    preferNode are ignored, consistent with node-side filter.mjs rule 1:
    //    plan produces no results; whoever claims it, their fingerprint is the fingerprint for this
    //    revision; plans with preferNode require matching fingerprints (X4)
    if (checksFingerprint(task)) {
      const taskFp = fingerprintOf(task.requires ? task.requires.envFingerprint : undefined);
      if (taskFp !== null && taskFp !== nodeFp) return false;
    }
    // 2. Not locked by another environment: only inspects tasks participating in locks (having both
    //    lock key and lock fingerprint, F.1), matching the determination in claim step 3a
    const id = lockIdOf(task);
    const lock = id ? locks.get(id.key) : undefined;
    return !lock || lock.envFingerprint === nodeFp;
  }

  /**
   * Tasks newly created by this task.publish (I.3): their task.opened is sent at the end of this step
   * according to final visibility; lock-change targeted deltas no longer handle them, preventing
   * the same node from receiving two task.opened messages. Non-null only during onPublish execution.
   */
  let freshTasks = null;

  /**
   * Targeted deltas for lock changes (I.3): mutate changes the fingerprint of the lock for key
   * in the lock table (new creation, takeover transfer). For each open task under this lock key,
   * compare whether each connection can see it before and after the change: visible → invisible
   * sends task.closed { state: 'hidden', reason: 'card-locked' }, invisible → visible sends
   * task.opened; unchanged sends nothing.
   * State is modified right here; the returned function sends outbound messages later (returns
   * null if nothing to send), allowing caller to prioritize its own response.
   * When PREFILTER is disabled, visibility is independent of locks and only mutate is performed.
   */
  function changeLock(key, mutate, except = null) {
    if (!C.PREFILTER) { mutate(); return null; }
    const affected = [];
    for (const task of tasks.values()) {
      if (task.state !== 'open' || task === except || (freshTasks && freshTasks.has(task))) continue;
      const id = lockIdOf(task);
      if (id && id.key === key) affected.push(task);
    }
    if (affected.length === 0) { mutate(); return null; }
    const watchers = [...conns.values()].filter((conn) => conn.watch !== null && nodeOf(conn));
    const before = affected.map((task) => new Set(watchers.filter((conn) => canSee(conn, task))));
    mutate();
    const out = [];
    affected.forEach((task, i) => {
      let view = null;
      for (const conn of watchers) {
        const was = before[i].has(conn);
        const will = canSee(conn, task);
        if (was && !will) out.push([conn, 'task.closed', { id: task.id, state: 'hidden', reason: 'card-locked' }]);
        else if (!was && will) out.push([conn, 'task.opened', { task: view ??= viewOf(task) }]);
      }
    });
    return out.length === 0 ? null : () => { for (const [conn, type, fields] of out) emit(conn, type, fields); };
  }

  function broadcast(task, type, fields, exceptConn = null) {
    for (const conn of conns.values()) {
      if (conn !== exceptConn && canSee(conn, task)) emit(conn, type, fields);
    }
  }

  // ---------- Task table ----------

  const isActive = (state) => state === 'open' || state === 'claimed';

  function countActive(projectId, delta) {
    const n = (activeByProject.get(projectId) ?? 0) + delta;
    if (n > 0) activeByProject.set(projectId, n);
    else activeByProject.delete(projectId);
  }

  /** Sole state transition entry point: version increments by exactly one per transition (A.7), also maintaining the pending count per project */
  function transition(task, state) {
    const was = isActive(task.state);
    const will = isActive(state);
    if (was !== will) countActive(task.source.projectId, will ? 1 : -1);
    task.state = state;
    task.version += 1;
  }

  function removeTask(task) {
    if (isActive(task.state)) countActive(task.source.projectId, -1);
    tasks.delete(task.id);
  }

  /**
   * Tasks in outbound messages (A.4 TaskView): excludes claim, subscribers; deep copy is done by
   * makeMessage. Previous abandon reason `lastError` is included only when present (Contract A.12
   * [ruling]: broadcasts when released back to open after reclaim or failure reveal why; legacy nodes
   * do not recognize this field and operate normally).
   */
  function viewOf(task) {
    const v = { id: task.id, kind: task.kind };
    if (task.kind === 'snapshot') v.tier = task.tier;
    Object.assign(v, {
      resultKey: task.resultKey, range: task.range, source: task.source,
      input: task.input, weight: task.weight, requires: task.requires, priority: task.priority,
      state: task.state, version: task.version, attempts: task.attempts,
    });
    if (typeof task.lastError === 'string' && task.lastError) v.lastError = task.lastError;
    return v;
  }

  /**
   * Project summary (M6c X3; shape follows `queue.summary` in Contract H.3): one entry per project
   * with open or claimed tasks, sorted by projectId ascending. `topPriority` is the highest priority
   * among open tasks, null if no open tasks; `openByFingerprint` groups and counts open tasks
   * by `requires.envFingerprint`, recording tasks without fingerprints under `''`, keys sorted ascending.
   */
  function summaryOf() {
    const byProject = new Map();
    for (const t of tasks.values()) {
      if (!isActive(t.state)) continue;
      const projectId = t.source.projectId;
      let p = byProject.get(projectId);
      if (!p) {
        p = { projectId, open: 0, claimed: 0, topPriority: null, fps: new Map() };
        byProject.set(projectId, p);
      }
      if (t.state === 'claimed') { p.claimed += 1; continue; }
      p.open += 1;
      // c10a Contract section 17: `priority` can be 'normal' / 'backfill'; summary only compares numbers (prerender retry tier counts as -1)
      const value = prioritySummaryValue(t.priority);
      if (p.topPriority === null || value > p.topPriority) p.topPriority = value;
      const fp = t.requires && typeof t.requires.envFingerprint === 'string' ? t.requires.envFingerprint : '';
      p.fps.set(fp, (p.fps.get(fp) ?? 0) + 1);
    }
    const byKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    return [...byProject.values()]
      .sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0))
      .map((p) => ({
        projectId: p.projectId, open: p.open, claimed: p.claimed, topPriority: p.topPriority,
        openByFingerprint: Object.fromEntries([...p.fps.entries()].sort(byKey)),
      }));
  }

  function doneFields(task) {
    return {
      id: task.id, resultKey: task.resultKey,
      projectId: task.source.projectId, projectRev: task.source.projectRev, result: task.result,
    };
  }

  /** Send a message to each current subscriber of the task; skip if subscriber is disconnected (A.7.4) */
  function notifySubscribers(task, type, fields) {
    for (const publisherId of task.subscribers) {
      const pub = publishers.get(publisherId);
      if (pub && pub.conn) emit(pub.conn, type, fields);
    }
  }

  /**
   * "Abandon" (A.7.6): shared by task.fail and various reclaims in tick. Modifies state first,
   * then outbound notify is sent via returned function, allowing caller to prioritize its own
   * response. Returns handled state: open / failed / removed.
   */
  function abandon(task, { lastError, retryable = true }) {
    const failedNodeId = task.claim?.nodeId ?? null;
    task.attempts += 1;
    task.claim = null;
    task.lastError = lastError;
    if (!retryable || task.attempts >= C.MAX_ATTEMPTS) {
      transition(task, 'failed');
      task.finishedAt = at;
      return {
        state: 'failed',
        notify() {
          notifySubscribers(task, 'task.failed', { id: task.id, error: task.lastError });
          broadcast(task, 'task.closed', { id: task.id, state: 'failed' });
        },
      };
    }
    transition(task, 'open');
    // Give another eligible node the first chance after a retryable failure.
    // The former owner can try again after one sweep if no peer takes it.
    task.retryNodeId = lastError === 'sink-incomplete' ? failedNodeId : null;
    task.retryAfter = task.retryNodeId ? at + C.SWEEP_INTERVAL_MS : null;
    if (task.subscribers.size === 0) {
      // Tasks nobody wants are deleted directly upon returning to open: keeping them would only result in wasted duplicate work
      removeTask(task);
      return { state: 'removed', notify: () => broadcast(task, 'task.closed', { id: task.id, state: 'removed' }) };
    }
    const view = viewOf(task);
    return { state: 'open', notify: () => broadcast(task, 'task.opened', { task: view }) };
  }

  /**
   * Reclaims in tick: abandon, and notify original claimant (if its connection is still alive).
   * The reason in `lease-lost` is the reclaim reason (`lease-expired` / `stalled` / `disconnected`,
   * Contract A.12 [ruling]; previously always `expired`).
   */
  function reclaim(task, lastError) {
    const { conn, token } = task.claim;
    const out = abandon(task, { lastError });
    if (isLive(conn)) emit(conn, 'task.lease-lost', { id: task.id, token, reason: lastError });
    out.notify();
  }

  // ---------- Per-card fingerprint lock (F.1) ----------

  /** Lock identity of a task: lock key + lock fingerprint (`requires.envFingerprint`). Missing either excludes it from locking and lock effects */
  function lockIdOf(task) {
    const key = lockKeyOf(task);
    const fp = task.requires ? task.requires.envFingerprint : undefined;
    return key !== null && typeof fp === 'string' && fp !== '' ? { key, fp } : null;
  }

  function setLock(key, envFingerprint, source, profile = null, nodeId = null) {
    locks.set(key, { envFingerprint, source, since: at, touchedAt: at, producedAt: at, profile, nodeId });
  }

  /**
   * Locking party produced again (M7 D2): claim, renewal, completion, and card.lock all count;
   * publish does not count, only refreshing touchedAt (F.1). Those produced via nodes (claim,
   * renewal, completion) additionally record that node (M7 D2 addition); card.lock does not go
   * through a node, leaving the previously recorded node unchanged.
   */
  function produced(lock, profile = null, nodeId = null) {
    lock.touchedAt = at;
    lock.producedAt = at;
    if (profile !== null) lock.profile = profile;
    if (nodeId !== null) lock.nodeId = nodeId;
  }

  /**
   * Timestamp when locking party was last "present" (M7 D2 addition [ruling]): the later of last
   * production and the last busy report (`node.active`) from the node that last produced for it.
   * Reporting busy counts only if that node is currently connected (`conn` present, not counted during
   * grace period after disconnect) and its fingerprint is still the lock's fingerprint: departed pages
   * (disconnected, reclaimed due to timeout) and legacy pages that never reported busy only look at
   * production, same as before the change.
   */
  function lockLastActive(lock) {
    let last = lock.producedAt;
    const owner = lock.nodeId != null ? nodes.get(lock.nodeId) : undefined;
    if (owner && owner.conn !== null && isLive(owner.conn) && (owner.envFingerprint === lock.envFingerprint || owner.cardEnvFingerprint === lock.envFingerprint)
      && typeof owner.activeAt === 'number' && owner.activeAt > last) last = owner.activeAt;
    return last;
  }

  /**
   * Describes a lock in the response (M7 D2): `lockedBy`, `lockIdleMs` (now minus last production),
   * `lockedByProfile`; publish responses additionally include `lockUndone`: number of unfinished tasks
   * for this card by the locking party (same lock key, lock fingerprint, not done, not superseded).
   * The splitter determines whether to take over based on this: takes over only when idle for more than
   * 30 s and there are still unfinished tasks (semantics "frames are still missing, while the locking
   * party has not produced for some time").
   */
  function lockInfo(key, lock, { undone = false } = {}) {
    const out = { lockedBy: lock.envFingerprint, lockIdleMs: Math.max(0, at - lockLastActive(lock)), lockedByProfile: lock.profile ?? null };
    if (undone) {
      let n = 0;
      for (const t of tasks.values()) {
        if (t.state === 'done' || t.lastError === 'superseded') continue;
        const id = lockIdOf(t);
        if (id && id.key === key && id.fp === lock.envFingerprint) n += 1;
      }
      out.lockUndone = n;
    }
    return out;
  }

  /**
   * After lock creation, same-fingerprint claim, or card.lock (M7 D1): tasks with the same lock key,
   * different fingerprint, `input.dual` truthy, and not yet finished (open / claimed) are the extra
   * copies created by the splitter for "first claimer wins card"; this card already belongs to fp,
   * and none of them can be claimed anymore, so all are superseded, following takeoverLock finalization:
   * attempts not incremented, claimants receive lease-lost, subscribers receive task.failed, visible
   * nodes receive task.closed. Tasks without dual remain untouched.
   * State is modified first, then outbound messages are sent via returned function (returns null if
   * nothing to send).
   */
  function supersedeDual(key, fp) {
    const superseded = [];
    for (const task of tasks.values()) {
      if (!isActive(task.state) || task.input?.dual !== true) continue;
      const id = lockIdOf(task);
      if (!id || id.key !== key || id.fp === fp) continue;
      const claim = task.claim;
      transition(task, 'failed');
      task.finishedAt = at;
      task.lastError = 'superseded';
      task.claim = null;
      superseded.push({ task, claim });
    }
    if (superseded.length === 0) return null;
    return () => {
      for (const { task, claim } of superseded) {
        if (claim && isLive(claim.conn)) emit(claim.conn, 'task.lease-lost', { id: task.id, token: claim.token, reason: 'superseded' });
        notifySubscribers(task, 'task.failed', { id: task.id, error: 'superseded' });
        broadcast(task, 'task.closed', { id: task.id, state: 'failed' });
      }
    };
  }

  /**
   * Superseded tasks: results from this environment were abandoned at that time; when the lock returns
   * to its fingerprint (or with takeover), it should be republishable, so treat it as non-existent
   * during publish.
   */
  const isSuperseded = (task) => task.state === 'failed' && task.lastError === 'superseded';

  /** Maximum number of fingerprints from browser-only nodes that a plan can carry (M7 D1) */
  const MAX_BROWSER_FINGERPRINTS = 4;

  /**
   * M7 D1: which browser fingerprints the splitter claiming this plan should generate an extra copy
   * for. Rules: nodes currently online on the document service (with connection), profile is browser,
   * carrying a fingerprint, connection's userId equals plan's `source.userId` (browser-only nodes can
   * only claim own tasks, fine-grained tasks inherit plan's userId), and watching this project;
   * fingerprints deduplicated, sorted ascending, at most MAX_BROWSER_FINGERPRINTS. If no such nodes exist,
   * returns an empty array, and the splitter generates only its own copy.
   */
  function browserFingerprintsFor(task, field = 'envFingerprint') {
    const out = new Set();
    for (const node of nodes.values()) {
      const conn = node.conn;
      if (node.profile !== 'browser' || !conn || !isLive(conn)) continue;
      const fp = fingerprintOf(node[field]);
      if (fp === null || conn.principal.userId !== task.source.userId) continue;
      if (!(conn.watch instanceof Set) || !conn.watch.has(task.source.projectId)) continue;
      out.add(fp);
    }
    return [...out].sort().slice(0, MAX_BROWSER_FINGERPRINTS);
  }

  /**
   * Takeover: lock transfers to fp; unfinished tasks (open / claimed) with the original fingerprint
   * are all superseded, directly entering failed (lastError 'superseded').
   * attempts not incremented, no retry: not because it cannot be done, but because results from this
   * environment are no longer wanted; retrying would only be blocked by the lock again.
   * Those in done remain untouched: already produced results are content-addressed, and retention
   * is governed by TTL.
   * State is modified first, then outbound messages are sent via returned function, allowing caller
   * to prioritize its own response.
   */
  function takeoverLock(key, fp, profile = null) {
    // Send targeted deltas for lock transfer first (I.3): open tasks with original fingerprint still
    // exist at this point, nodes that can see them receive hidden; subsequently they are superseded,
    // task.closed { state: 'failed' } is sent according to updated visibility, so these nodes will not
    // receive a second message
    const lockNotify = changeLock(key, () => setLock(key, fp, 'takeover', profile));
    const superseded = [];
    for (const task of tasks.values()) {
      if (!isActive(task.state)) continue;
      const id = lockIdOf(task);
      if (!id || id.key !== key || id.fp === fp) continue;
      const claim = task.claim;
      transition(task, 'failed');
      task.finishedAt = at;
      task.lastError = 'superseded';
      task.claim = null;
      superseded.push({ task, claim });
    }
    return () => {
      if (lockNotify) lockNotify();
      for (const { task, claim } of superseded) {
        // Tell original claimant first that its token has been invalidated, then notify subscribers and watchers
        if (claim && isLive(claim.conn)) emit(claim.conn, 'task.lease-lost', { id: task.id, token: claim.token, reason: 'superseded' });
        notifySubscribers(task, 'task.failed', { id: task.id, error: 'superseded' });
        broadcast(task, 'task.closed', { id: task.id, state: 'failed' });
      }
    };
  }

  /**
   * During publish, if this task is newly created, whether lock rejects its creation (F.7 item 1):
   * has lock key and lock fingerprint, lock is on another fingerprint, and takeover is not included,
   * returns the fingerprint on the lock, otherwise null. Even if created nobody could claim it,
   * remaining open indefinitely, and the page would never see task.done; rejecting and returning
   * lockedBy lets the splitter know to republish with the locking party's fingerprint or explicitly
   * take over.
   */
  function lockRefusal(input) {
    if (input.takeover) return null;
    const id = lockIdOf(input);
    const lock = id ? locks.get(id.key) : undefined;
    return lock && lock.envFingerprint !== id.fp ? { key: id.key, lock } : null;
  }

  /**
   * Inspect lock during publish (F.1 "Publish" table, F.7 item 2). Returns the fingerprint when lock
   * is on another fingerprint and not taken over (lockedBy in response), otherwise null;
   * in this case only merging existing tasks with the same id remains, as new ones were already
   * rejected in the lockRefusal step.
   * When there is no lock and no takeover, do not create a lock: who actually produces first is
   * decided by the first claim; merely publishing does not count.
   */
  function lockOnPublish(task, takeover, after, node) {
    const profile = node?.profile ?? null;
    const id = lockIdOf(task);
    if (!id) return null;
    const lock = locks.get(id.key);
    if (!lock) {
      // Taking over when there is no lock still supersedes unfinished tasks with different fingerprints
      // (F.7 item 2): when two nodes split almost simultaneously, tasks from the party that published first
      // but has not been claimed yet will not be left as dead tasks that nobody can claim
      if (takeover) after.push(takeoverLock(id.key, id.fp, profile));
      return null;
    }
    if (lock.envFingerprint === id.fp) {
      // Publishing only refreshes touchedAt (F.1), not counted as production (lockIdleMs in M7 D2 does not reset to zero)
      lock.touchedAt = at;
      // M7-A10 (found by acceptance probe): when a splitting node generates keys based on locks from
      // another environment (it already knows from the local lock store that this card is locked elsewhere),
      // publishing is not rejected, so it never receives the lock's idle status and never takes over.
      // Therefore, when the publisher is a node with a different fingerprint, the response also carries
      // the lock description (without lockedBy: the lock is on this copy's fingerprint), and the splitter
      // decides whether to take over per D2
      const nodeFp = fingerprintOf(node?.envFingerprint);
      if (nodeFp !== null && nodeFp !== lock.envFingerprint) {
        const { lockIdleMs, lockedByProfile, lockUndone } = lockInfo(id.key, lock, { undone: true });
        return { lockIdleMs, lockedByProfile, lockUndone };
      }
      return null;
    }
    if (takeover) {
      after.push(takeoverLock(id.key, id.fp, profile));
      return null;
    }
    // Existing tasks are merged as usual, except claims will be rejected (card-locked) before
    // lock changes; response carries lock description (M7 D2)
    return lockInfo(id.key, lock, { undone: true });
  }

  // ---------- Identity ----------

  /** This connection no longer represents its original node: that node is now considered disconnected, awaiting grace period */
  function detachNode(conn) {
    const node = nodeOf(conn);
    if (node) {
      node.conn = null; node.disconnectedAt = at;
      // M6c X4 (integration ruling): when preferNode disconnects, its exclusive window ends immediately
      // and does not recover upon reconnect: other pcs can claim this plan right away
      for (const task of tasks.values()) {
        if (task.kind === 'plan' && task.state === 'open' && requiredOf(task, 'preferNode') === node.nodeId) task.preferEnded = true;
      }
    }
    conn.nodeId = null;
    unwatch(conn);
  }
  /** This connection no longer watches anything: single-task deltas and summaries (X3) are stopped together */
  function unwatch(conn) {
    conn.watch = null;
    conn.summary = false;
    conn.lastSummary = null;
  }
  function detachPublisher(conn) {
    const pub = publisherOf(conn);
    if (pub) { pub.conn = null; pub.disconnectedAt = at; }
    conn.publisherId = null;
  }

  // ---------- Inbound messages ----------

  function onNodeHello(conn, body, reqId) {
    const { nodeId } = body;
    // M7 D9: nodeId is bound to the userId that first checked it in (while node record exists).
    // Another user checking in with the same nodeId would bump that node's connection and
    // resume its claims; all such attempts are rejected; original identity of this connection remains unchanged
    const bound = nodes.get(nodeId);
    if (bound && bound.userId !== conn.principal.userId) {
      emit(conn, 'error', { reason: 'forbidden', detail: 'This nodeId belongs to another user' }, reqId);
      return;
    }
    if (conn.nodeId !== null && conn.nodeId !== nodeId) detachNode(conn);
    let node = nodes.get(nodeId);
    if (node) {
      // A new connection with the same identity replaces the old connection: old connection no longer
      // represents this node thereafter, nor receives broadcasts
      if (node.conn && node.conn !== conn) { node.conn.nodeId = null; unwatch(node.conn); }
    } else {
      node = { nodeId, userId: conn.principal.userId, activeAt: null, activeBusy: null };
      nodes.set(nodeId, node);
    }
    Object.assign(node, {
      profile: body.profile, envFingerprint: body.envFingerprint, capabilities: body.capabilities,
      // Block N: fingerprint used by browser-only nodes to execute user cards and media effect cards
      // (calculated by document service based on runtime version reported by page and passed in);
      // no other profiles have it
      cardEnvFingerprint: body.profile === 'browser' ? (body.cardEnvFingerprint ?? null) : null,
      codeVersions: body.codeVersions, maxConcurrent: body.maxConcurrent,
      conn, disconnectedAt: null,
    });
    conn.nodeId = nodeId;
    // X3: when the same connection checks in again with a different profile, original full watch
    // is kept only for pc; summary is kept only for host
    if (conn.watch === 'all' && body.profile !== 'pc') conn.watch = null;
    if (conn.summary && body.profile !== 'host') { conn.summary = false; conn.lastSummary = null; }

    // resume: handled the same way regardless of whether this nodeId has a record (A.9)
    const resumed = [];
    const lost = [];
    const seen = new Set();
    for (const { id, token } of body.resume) {
      if (seen.has(id)) continue;
      seen.add(id);
      const task = tasks.get(id);
      if (task && task.state === 'claimed' && task.claim.nodeId === nodeId && task.claim.token === token) {
        task.claim.conn = conn;   // Resume: leaseUntil and token remain unchanged
        resumed.push(id);
        continue;
      }
      let reason = 'token';
      if (!task) reason = 'epoch';                                             // Task not found in this instance: likely because document service was restarted
      else if (task.state === 'claimed' && task.claim.nodeId !== nodeId) reason = 'not-owner';   // C4: Tokens only recognize the node that claimed them
      lost.push({ id, token, reason });
    }

    // Drop all claims under this node that could not be resumed: the node itself no longer recognizes
    // them, and keeping them would only wait until the lease expires
    const resumedSet = new Set(resumed);
    const dropped = [];
    for (const task of tasks.values()) {
      if (task.state === 'claimed' && task.claim.nodeId === nodeId && !resumedSet.has(task.id)) dropped.push(task);
    }
    const outs = dropped.map((task) => abandon(task, { lastError: 'not-resumed' }));

    // activeIntervalMs (M7 D2 supplement): this queue recognizes `node.active`, which nodes report at
    // this interval when busy; legacy queues omit it, so nodes do not send it
    emit(conn, 'node.welcome', {
      nodeId, envFingerprint: node.envFingerprint ?? null, resumed, lost: lost.map((l) => l.id), activeIntervalMs: NODE_ACTIVE_INTERVAL_MS,
      // This queue recognizes sparse stream tasks (id ending with `:sparse`, `taskIdOf` in `messages.mjs`):
      // splitters only split sparse stream tasks when seeing this entry;
      // legacy queues omit it, so splitters only split full density ones (legacy queues do not
      // recognize this format when validating ids, and sending it causes the whole batch to be rejected)
      sparseStreams: true,
      // Chunk N: browser nodes have an additional fingerprint for user cards and media effect cards;
      // other nodes and browsers that did not report runtime versions omit this entry (old shape unchanged)
      ...(node.profile === 'browser' && fingerprintOf(node.cardEnvFingerprint) !== null ? { cardEnvFingerprint: node.cardEnvFingerprint } : {}),
    }, reqId);
    for (const l of lost) emit(conn, 'task.lease-lost', l);
    for (const out of outs) out.notify();
  }

  function onPublisherHello(conn, body, reqId) {
    const { publisherId } = body;
    if (conn.publisherId !== null && conn.publisherId !== publisherId) detachPublisher(conn);
    let pub = publishers.get(publisherId);
    if (pub) {
      if (pub.conn && pub.conn !== conn) pub.conn.publisherId = null;
    } else {
      pub = { publisherId };
      publishers.set(publisherId, pub);
    }
    // Reconnect: all subscriptions are retained (F7.4)
    pub.conn = conn;
    pub.disconnectedAt = null;
    conn.publisherId = publisherId;
    emit(conn, 'publisher.welcome', { publisherId }, reqId);
  }

  /**
   * `queue.watch` (A.6; M6c X3 tightened `'all'`):
   * - `browser` using `'all'`: returns `error { reason: 'forbidden' }`, original watch unchanged
   *   (pure browsers only see their own tasks; full view would leak others' projects);
   * - `host` using `'all'`: only receives project summaries: returns one `queue.summary`, and
   *   thereafter only sends another when the summary changes at each tick (at most one per cycle),
   *   receiving no single-task deltas;
   * - `host` using a project list: receives deltas and `queue.snapshot` for these projects as usual;
   *   a non-empty list does not affect summaries (hosts rely on summaries to know which projects have
   *   work, then watch those projects, `render-node/host.mjs`), while an empty list stops even the
   *   summary (sent on its behalf by the document service module when switching to channel summaries);
   * - `pc` as before: local nodes rely on the full view.
   */
  function onWatch(conn, body, reqId) {
    const node = nodeOf(conn);
    if (body.projects === 'all' && node.profile === 'browser') {
      emit(conn, 'error', { reason: 'forbidden', detail: "A browser-only node cannot watch 'all'; list your own projects" }, reqId);
      return;
    }
    if (body.projects === 'all' && node.profile === 'host') {
      conn.watch = new Set();
      conn.summary = true;
      const projects = summaryOf();
      conn.lastSummary = JSON.stringify(projects);
      emit(conn, 'queue.summary', { at, projects }, reqId);
      return;
    }
    if (body.projects !== 'all' && body.projects.length === 0) { conn.summary = false; conn.lastSummary = null; }
    conn.watch = body.projects === 'all' ? 'all' : new Set(body.projects);
    const visible = [...tasks.values()]
      .filter((t) => t.state === 'open' && canSee(conn, t))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(viewOf);
    emit(conn, 'queue.snapshot', { tasks: visible }, reqId);
  }

  /**
   * Inheritance for derived tasks (A.4 last paragraph, design section 3): a fine-grained task's
   * userId belongs to the plan task that produced it, not the splitter node's, otherwise the pure
   * browser user boundary (Q2) would be overridden by the splitter node's identity; subscribers are
   * merged with the plan's subscribers, so once a page subscribes to the plan it can receive
   * task.done for fine-grained tasks, and splitter node disconnections will not cause fine-grained
   * tasks to be deleted due to having no subscribers.
   * Inherited only when "the plan is currently claimed by this node on the publishing connection":
   * others cannot obtain this identity. If conditions are not met, do not inherit, without error.
   */
  function planParentOf(conn, derivedFrom) {
    if (derivedFrom === null) return null;
    const plan = tasks.get(derivedFrom);
    const node = nodeOf(conn);
    if (!plan || plan.kind !== 'plan' || plan.state !== 'claimed' || !node) return null;
    return plan.claim.nodeId === node.nodeId ? plan : null;
  }

  const ttlPassed = (task) => (task.state === 'done' || task.state === 'failed') && at - task.finishedAt > C.DONE_TTL;

  function onPublish(conn, body, reqId) {
    freshTasks = new Set();
    try { publishAll(conn, body, reqId); } finally { freshTasks = null; }
  }

  function publishAll(conn, body, reqId) {
    const publisherId = conn.publisherId;
    const results = [];
    const after = [];
    for (const input of body.tasks) {
      let task = tasks.get(input.id);
      // done / failed past TTL are treated as no longer existing, without waiting for the next tick
      // to republish (C1);
      // The same applies to superseded ones (M7 D1, D2): must be rebuildable when the lock returns to
      // its fingerprint, or when the splitter takes over with takeover
      if (task && (ttlPassed(task) || isSuperseded(task))) { removeTask(task); task = undefined; }
      let result;
      if (!task) {
        if ((activeByProject.get(input.source.projectId) ?? 0) >= C.MAX_TASKS_PER_PROJECT) {
          // If no task was created, leave the lock untouched: if takeover still proceeds with takeover,
          // tasks under the old fingerprint are invalidated without new tasks to replace them
          results.push({ id: input.id, error: 'limit' });
          continue;
        }
        // Do not create cards locked by other environments (F.7 item 1); like limit, only affects this item
        const refusal = lockRefusal(input);
        if (refusal !== null) {
          results.push({ id: input.id, error: 'card-locked', ...lockInfo(refusal.key, refusal.lock, { undone: true }) });
          continue;
        }
        // User and tenant only recognize connection credentials; self-reported publisher values were
        // already discarded during validation (A.4, P7);
        // Derived tasks are an exception: inherit the identity and subscribers of their plan task
        const parent = planParentOf(conn, input.source.derivedFrom);
        task = {
          id: input.id, kind: input.kind, tier: input.tier, resultKey: input.resultKey, range: input.range,
          source: {
            projectId: input.source.projectId, projectRev: input.source.projectRev,
            derivedFrom: input.source.derivedFrom,
            userId: parent ? parent.source.userId : conn.principal.userId,
            tenantId: parent ? parent.source.tenantId : conn.principal.tenantId,
            publisher: { id: publisherId }, publishedAt: at,
          },
          input: input.input, weight: input.weight, requires: input.requires, priority: input.priority,
          state: 'open', version: 1, attempts: 0, lastError: null,
          claim: null, finishedAt: null, result: null,
          subscribers: new Set([publisherId, ...(parent ? parent.subscribers : [])]),
        };
        tasks.set(task.id, task);
        freshTasks.add(task);
        countActive(task.source.projectId, 1);
        result = { id: task.id, state: 'open', version: 1, created: true };
        const t = task;
        const view = viewOf(t);
        after.push(() => broadcast(t, 'task.opened', { task: view }));
      } else {
        result = mergeExisting(conn, task, input, after);
      }
      // Check locks after original processing (F.1); lock identity is taken from tasks in the table,
      // which is the same copy looked up in claim step 3a
      const locked = lockOnPublish(task, input.takeover, after, nodeOf(conn));
      if (locked !== null) Object.assign(result, locked);
      // M7 D1: The merged copy is dual, and this card is already locked to another fingerprint: the other
      // copy already got the card, no one can claim this copy, invalidate just as when creating locks
      if (locked?.lockedBy && !result.error && isActive(task.state) && task.input?.dual === true) {
        const notify = supersedeDual(lockIdOf(task).key, locked.lockedBy);
        if (notify) after.push(notify);
        Object.assign(result, { state: task.state, version: task.version });
      }
      results.push(result);
    }
    emit(conn, 'task.published', { results }, reqId);
    for (const fn of after) fn();
  }

  /**
   * Task with identical id already exists at publish time (last three rows of table A.7.1, and
   * inheritance merge in A.4 last paragraph); return the response for this item
   */
  function mergeExisting(conn, task, input, after) {
    if (isActive(task.state)) {
      task.subscribers.add(conn.publisherId);
      /*
       * Priority upgrade (semantics mechanism/document-service.md "Priority", c10a contract section 17):
       * do not start another if a task already exists for the same result key;
       * if existing is backfill and this publish is normal, upgrade to normal (take priority from this
       * publish, including the integer rank).
       * Not a state transition, version unchanged; for tasks still open, resend a task.opened, and the
       * priority in the node view is updated accordingly.
       */
      if (priorityBand(task.priority) === 'backfill' && priorityBand(input.priority) === 'normal') {
        task.priority = input.priority;
        if (task.state === 'open') {
          const view = viewOf(task);
          after.push(() => broadcast(task, 'task.opened', { task: view }));
        }
      }
      /*
       * M7 D1 (detected by acceptance probe): the splitter previously created this copy as a single copy
       * (the revision before the page checked in), and this revision sent it as a dual copy:
       * it now has another copy, add `dual` so it gets invalidated when creating locks, rather than
       * lingering as a dead task that no one can claim. Replace with a new object, do not mutate in place.
       */
      if (input.input?.dual === true && task.input?.dual !== true) {
        task.input = { ...task.input, dual: true };
        // Same as priority upgrade: for tasks still open, resend a task.opened, and input in the view
        // of nodes (and observers) that can see it is updated accordingly
        if (task.state === 'open') {
          const view = viewOf(task);
          after.push(() => { if (task.state === 'open') broadcast(task, 'task.opened', { task: view }); });
        }
      }
    } else if (task.state === 'done') {
      const fields = doneFields(task);
      after.push(() => emit(conn, 'task.done', fields));
    }
    // failed (not past TTL): do not reopen, only state in the response (C1)

    // Existing tasks are also merged with plan subscribers (A.4 last paragraph, M3 ruling): result keys
    // of the shared tier are project-independent; fine-grained tasks split in this revision were often
    // created by the previous revision or another project, and if not merged, the page cannot receive
    // their results.
    // Identity unchanged; for tasks already done / already failed, send a supplementary notification
    // to each newly merged subscriber.
    const parent = planParentOf(conn, input.source.derivedFrom);
    if (parent) {
      const joined = [...parent.subscribers].filter((id) => !task.subscribers.has(id));
      for (const id of joined) task.subscribers.add(id);
      if (task.state === 'done' || task.state === 'failed') {
        const type = task.state === 'done' ? 'task.done' : 'task.failed';
        const fields = task.state === 'done' ? doneFields(task) : { id: task.id, error: task.lastError };
        after.push(() => {
          for (const id of joined) {
            const pub = publishers.get(id);
            // This connection has already received a task.done per A.7.1; do not send duplicates
            if (pub && pub.conn && !(type === 'task.done' && pub.conn === conn)) emit(pub.conn, type, fields);
          }
        });
      }
    }
    return { id: task.id, state: task.state, version: task.version, created: false };
  }

  function onUnsubscribe(conn, body, reqId) {
    const publisherId = conn.publisherId;
    let targets;
    if (body.ids) {
      targets = [...new Set(body.ids)].map((id) => tasks.get(id)).filter(Boolean);
    } else {
      targets = [...tasks.values()].filter((t) => t.source.projectId === body.projectId
        && (body.projectRev === null || t.source.projectRev === body.projectRev));
    }
    const ids = [];
    const removed = [];
    for (const task of targets) {
      if (!task.subscribers.delete(publisherId)) continue;
      ids.push(task.id);
      // Delete unwanted open tasks; let claimed ones finish (results are addressed by content key and
      // might still be useful for other versions); do not notify upon completion
      if (task.subscribers.size === 0 && task.state === 'open') {
        removeTask(task);
        removed.push(task);
      }
    }
    emit(conn, 'task.unsubscribed', { ids }, reqId);
    for (const task of removed) broadcast(task, 'task.closed', { id: task.id, state: 'removed' });
  }

  function onClaim(conn, body, reqId) {
    const node = nodeOf(conn);
    const { id, expectVersion } = body;
    // Throttling (I.5): for connections whose card-locked rejections exceeded THROTTLE_REJECTS this
    // cycle, ignore tasks and leave all states unchanged until the next tick. Nodes repeatedly
    // hitting locks despite prefiltering are likely not claiming by visibility; do not let them drag
    // the queue into a lock storm
    if (C.PREFILTER && conn.cardLockedRejects > C.THROTTLE_REJECTS) {
      return emit(conn, 'task.claim-rejected', { id, reason: 'throttled' }, reqId);
    }
    const task = tasks.get(id);
    // Order of design 4.2, completed synchronously in one step
    if (!task) return emit(conn, 'task.claim-rejected', { id, reason: 'gone' }, reqId);
    if (node.profile === 'browser' && task.source.userId !== conn.principal.userId) {
      // Without state / version: do not even show task status to pure browsers for others' tasks
      return emit(conn, 'task.claim-rejected', { id, reason: 'forbidden' }, reqId);
    }
    // X4: plan is only for pc. Standalone hosts do not plan for any page, and pure browsers lack
    // Chrome and card-cache (rule 6 of filter.mjs also blocks on the node side).
    // C10 contract section 18 item 9 [ruling] modification to X4: plans with a clip manifest
    // (manifest plans for online pages, prerender retry plans for legacy pages) can also be claimed
    // by host, split by the claiming node using its own fingerprint; desktop plans without a manifest
    // are still only for pc. Pure browsers never claim plan
    if (task.kind === 'plan' && (node.profile === 'browser' || (node.profile === 'host' && !isListPlan(task)))) {
      return emit(conn, 'task.claim-rejected', { id, reason: 'plan-profile' }, reqId);
    }
    if (task.state !== 'open') {
      return emit(conn, 'task.claim-rejected', { id, reason: 'taken', state: task.state, version: task.version }, reqId);
    }
    if (task.retryNodeId === node.nodeId && at < task.retryAfter) {
      return emit(conn, 'task.claim-rejected', {
        id, reason: 'retry-backoff', state: 'open', version: task.version, retryInMs: task.retryAfter - at,
      }, reqId);
    }
    // X4: plan claimed nearby. For a plan where the publisher specifies preferNode (its own node),
    // it is only given to that node within PLAN_PREFER_MS after publishing;
    // window expiration is judged using strictly greater than per A.8 criteria. Return retryInMs,
    // and the node session defers this candidate until after the window instead of discarding it
    if (task.kind === 'plan') {
      const prefer = requiredOf(task, 'preferNode');
      const until = task.source.publishedAt + C.PLAN_PREFER_MS;
      // If preferNode was disconnected (`preferEnded`, marked in detachNode), the window ends
      // (integration ruling)
      if (prefer !== null && prefer !== node.nodeId && at <= until && task.preferEnded !== true) {
        return emit(conn, 'task.claim-rejected', {
          id, reason: 'preferred', state: 'open', version: task.version, preferNode: prefer, retryInMs: until - at + 1,
        }, reqId);
      }
    }
    // Fingerprint mismatch (I.10 item 4, semantics "also do not let it claim"): if filtering is enabled
    // and both node and task have fingerprints that differ, reject; counted toward throttle count like
    // card-locked. Placed after taken and before 3a: nodes whose environment was already mismatched
    // need not know who holds the lock on this card.
    // Plans without preferNode are not checked (same as envAllows); checked if present (X4 "pc with
    // matching fingerprint")
    if (C.PREFILTER && checksFingerprint(task)) {
      const nodeFp = nodeFpFor(node, task);
      const taskFp = fingerprintOf(task.requires ? task.requires.envFingerprint : undefined);
      if (nodeFp !== null && taskFp !== null && nodeFp !== taskFp) {
        conn.cardLockedRejects += 1;
        return emit(conn, 'task.claim-rejected', { id, reason: 'fingerprint-mismatch', state: 'open', version: task.version }, reqId);
      }
    }
    // X2: Input contains assets present only on publisher's local machine; only that node can claim.
    // Ignores PREFILTER: this is a correctness gate, same as 3a;
    // counted toward throttle count (nodes attempting to claim despite prefiltering are likely not
    // claiming by visibility)
    if (!localMediaAllows(node, task)) {
      conn.cardLockedRejects += 1;
      return emit(conn, 'task.claim-rejected', {
        id, reason: 'local-media', state: 'open', version: task.version, localMedia: requiredOf(task, 'localMedia'),
      }, reqId);
    }
    // 3a (F.1): This result for this card is already locked by another environment; frames produced
    // by this task's fingerprint cannot be mixed in.
    // Placed before stale: if the lock does not change, retrying with a new version number is useless
    // for the node, so let it drop this candidate earlier
    const lockId = lockIdOf(task);
    const lock = lockId ? locks.get(lockId.key) : undefined;
    if (lock && lock.envFingerprint !== lockId.fp) {
      // Counts are recorded in both modes (diagnostics for describe; control group needs rejection count);
      // throttled based on this only when PREFILTER is enabled (I.5)
      conn.cardLockedRejects += 1;
      const { lockedBy, lockIdleMs, lockedByProfile } = lockInfo(lockId.key, lock);
      return emit(conn, 'task.claim-rejected', {
        id, reason: 'card-locked', state: 'open', version: task.version, lockedBy, lockIdleMs, lockedByProfile,
      }, reqId);
    }
    if (expectVersion !== task.version) {
      return emit(conn, 'task.claim-rejected', { id, reason: 'stale', state: 'open', version: task.version }, reqId);
    }
    // The first claim is the first actual start of production: if unlocked, lock here with the task's
    // fingerprint (design 2.1 "who sets the fingerprint").
    // Newly created locks make open tasks for the same card with other fingerprints invisible to
    // corresponding nodes, revoking them in a targeted manner (I.3); the claimed task itself does
    // not count
    let lockNotify = null;
    let dualNotify = null;
    if (lockId) {
      if (lock) produced(lock, node.profile, node.nodeId);
      else lockNotify = changeLock(lockId.key, () => setLock(lockId.key, lockId.fp, 'claim', node.profile, node.nodeId), task);
      // M7 D1: This card belongs to this fingerprint, invalidate the splitter's extra copy (dual)
      dualNotify = supersedeDual(lockId.key, lockId.fp);
    }
    transition(task, 'claimed');
    task.retryNodeId = null;
    task.retryAfter = null;
    task.claim = {
      nodeId: node.nodeId, conn, token: task.version, claimedAt: at,
      leaseUntil: at + C.LEASE_MS, progress: { done: null, step: null, changedAt: at },
    };
    const claimed = { id, token: task.claim.token, version: task.version, leaseUntil: task.claim.leaseUntil, task: viewOf(task) };
    // M7 D1: The claim response for plan includes fingerprints of online pure browser nodes for the
    // same user in this project; the splitter uses this to produce an extra copy for cards the browser
    // can do
    if (task.kind === 'plan') {
      const browserFingerprints = browserFingerprintsFor(task);
      if (browserFingerprints.length > 0) claimed.browserFingerprints = browserFingerprints;
      // Chunk N: fingerprint (`cardEnvFingerprint`) for user cards and media effect cards from the same
      // node. The splitter only produces the browser copy of user cards and media effect cards for
      // fingerprints where "the document service confirmed such an online node exists"
      const browserCardEnvFingerprints = browserFingerprintsFor(task, 'cardEnvFingerprint');
      if (browserCardEnvFingerprints.length > 0) claimed.browserCardEnvFingerprints = browserCardEnvFingerprints;
    }
    emit(conn, 'task.claimed', claimed, reqId);
    broadcast(task, 'task.taken', { id, version: task.version }, conn);
    if (lockNotify) lockNotify();
    if (dualNotify) dualNotify();
  }

  /**
   * Token fence (design 4.2): considered held only if the task exists, is claimed, the token
   * matches, and the message sender is the current claimer.
   * Otherwise returns lease-lost without changing state: after a lease is revoked, the original
   * node cannot change task state even if it finishes.
   */
  function heldTask(conn, body, reqId) {
    const task = tasks.get(body.id);
    if (task && task.state === 'claimed' && task.claim.token === body.token && task.claim.nodeId === conn.nodeId) return task;
    emit(conn, 'task.lease-lost', { id: body.id, token: body.token, reason: 'token' }, reqId);
    return null;
  }

  function onProgress(conn, body, reqId) {
    const task = heldTask(conn, body, reqId);
    if (!task) return;
    const claim = task.claim;
    claim.leaseUntil = at + C.LEASE_MS;
    // Stall timer only restarts when progress changes: nodes with active heartbeats that make no
    // progress are still reclaimed for stalling (F3.1).
    // "Progress" refers to frame count done, plus the work count step reported by the node
    // (also changes when pushing chunks or switching phases, contract A.12 [ruling]); legacy nodes
    // without step only look at done
    const stepChanged = body.step !== null && body.step !== claim.progress.step;
    if (body.done !== claim.progress.done || stepChanged) {
      claim.progress = { done: body.done, step: body.step ?? claim.progress.step, changedAt: at };
    }
    // M7 D2: Lease renewal also counts as the locking party still producing (a heavy card segment
    // takes over ten seconds in the browser and should not be classified as idle while producing)
    const lockId = lockIdOf(task);
    const lock = lockId ? locks.get(lockId.key) : undefined;
    if (lock && lock.envFingerprint === lockId.fp) produced(lock, nodeOf(conn)?.profile ?? null, conn.nodeId);
    emit(conn, 'task.renewed', { id: task.id, token: claim.token, leaseUntil: claim.leaseUntil }, reqId);
  }

  function onComplete(conn, body, reqId) {
    const task = heldTask(conn, body, reqId);
    if (!task) return;
    transition(task, 'done');
    task.claim = null;
    task.finishedAt = at;
    task.result = body.result;
    // Someone is still producing under the lock: refresh touchedAt so item 5 scan in tick does not
    // reclaim it
    const lockId = lockIdOf(task);
    const lock = lockId ? locks.get(lockId.key) : undefined;
    if (lock) {
      lock.touchedAt = at;
      if (lock.envFingerprint === lockId.fp) produced(lock, nodeOf(conn)?.profile ?? null, conn.nodeId);
    }
    emit(conn, 'task.completed', { id: task.id }, reqId);
    // Do not send any task.done when there are no subscribers (F7.2)
    notifySubscribers(task, 'task.done', doneFields(task));
    broadcast(task, 'task.closed', { id: task.id, state: 'done' });
  }

  function onRelease(conn, body, reqId) {
    const task = heldTask(conn, body, reqId);
    if (!task) return;
    // Proactive release is yielding, not inability to perform: attempts is not incremented (C2)
    transition(task, 'open');
    task.claim = null;
    // Unwanted tasks are likewise deleted directly upon release (last item of A.7.6); otherwise they
    // linger in open with nobody cleaning them up
    const orphan = task.subscribers.size === 0;
    if (orphan) removeTask(task);
    emit(conn, 'task.released', { id: task.id }, reqId);
    if (orphan) broadcast(task, 'task.closed', { id: task.id, state: 'removed' });
    else broadcast(task, 'task.opened', { task: viewOf(task) });
  }

  function onFail(conn, body, reqId) {
    const task = heldTask(conn, body, reqId);
    if (!task) return;
    const out = abandon(task, { lastError: body.error ?? 'failed', retryable: body.retryable });
    emit(conn, 'task.fail-ack', { id: task.id, state: out.state }, reqId);
    out.notify();
  }

  /**
   * `card.lock` (F.1): the publisher (the party storing measured page frames into the library)
   * directly requests or takes over a lock without going through tasks.
   * Under the same lock, only results from one environment are delivered, so requests with a
   * different fingerprint without takeover only return "not acquired", leaving the lock unchanged.
   */
  function onCardLock(conn, body, reqId) {
    const key = lockKeyOf({ kind: body.kind, input: { contentKey: body.contentKey } });
    const fp = body.envFingerprint;
    const lock = locks.get(key);
    let notify = null;
    let dualNotify = null;
    if (!lock) notify = changeLock(key, () => setLock(key, fp, 'lock'));
    else if (lock.envFingerprint === fp) produced(lock);
    else if (body.takeover) notify = takeoverLock(key, fp);
    const held = locks.get(key).envFingerprint;
    // M7 D1: Once locked, invalidate the other copy (dual); upon takeover, takeoverLock already
    // invalidated those with different fingerprints
    if (held === fp) dualNotify = supersedeDual(key, fp);
    emit(conn, 'card.locked', { lockKey: key, envFingerprint: held, granted: held === fp }, reqId);
    if (notify) notify();
    if (dualNotify) dualNotify();
  }

  /**
   * `node.active` (M7 D2 supplement [ruling]): node is still present and busy. Only records timestamp
   * and what it is busy with; does not respond, does not modify tasks or locks;
   * see lockLastActive for how lock idleness is calculated. Messages are frequent (one every 10 s
   * for each busy page), so even reqId is not returned.
   */
  function onNodeActive(conn, body) {
    const node = nodeOf(conn);
    node.activeAt = at;
    node.activeBusy = body.busy ?? null;
  }

  const HANDLERS = new Map([
    ['node.hello', onNodeHello],
    ['publisher.hello', onPublisherHello],
    ['queue.watch', onWatch],
    ['task.publish', onPublish],
    ['task.unsubscribe', onUnsubscribe],
    ['card.lock', onCardLock],
    ['task.claim', onClaim],
    ['task.progress', onProgress],
    ['task.complete', onComplete],
    ['task.release', onRelease],
    ['task.fail', onFail],
    ['node.active', onNodeActive],
  ]);

  // ---------- External interface ----------

  function connect(connId, principal) {
    if (principal === null || typeof principal !== 'object' || typeof principal.userId !== 'string') {
      throw new TypeError('connect: principal.userId must be a string');
    }
    at = now();
    // Repeated connect for the same connId: handle the old one as disconnected first
    if (conns.has(connId)) disconnect(connId);
    conns.set(connId, {
      connId,
      principal: { userId: principal.userId, tenantId: typeof principal.tenantId === 'string' ? principal.tenantId : null },
      nodeId: null, publisherId: null, watch: null,
      summary: false, lastSummary: null,   // X3: host's watch 'all' only receives summaries; the last sent summary (JSON) is only resent when changed
      cardLockedRejects: 0,   // Rejection counts for card-locked and fingerprint-mismatch received during this scan cycle, reset to zero on tick (I.5, I.10 item 4)
    });
  }

  function disconnect(connId) {
    const conn = conns.get(connId);
    if (!conn) return;
    at = now();
    // Leave claims and subscriptions untouched; wait for the grace scan in tick (A.9)
    detachNode(conn);
    detachPublisher(conn);
    conns.delete(connId);
  }

  function handle(connId, message) {
    const conn = conns.get(connId);
    if (!conn) return;
    at = now();
    const parsed = parseInbound(message);
    if (!parsed.ok) {
      emit(conn, 'error', { reason: 'bad-message', detail: parsed.detail }, parsed.reqId);
      return;
    }
    const { type, reqId, body } = parsed;
    if ((NODE_TYPES.has(type) && !nodeOf(conn)) || (PUBLISHER_TYPES.has(type) && !publisherOf(conn))) {
      emit(conn, 'error', { reason: 'not-registered' }, reqId);
      return;
    }
    HANDLERS.get(type)(conn, body, reqId);
  }

  /**
   * Called after clock advance: four scans for lease, stall, grace, and TTL, in that order, with
   * comparisons all strictly greater than (A.8);
   * followed by item 5, reclaiming unused per-card fingerprint locks (F.1).
   */
  function tick() {
    at = now();
    const alive = (task) => tasks.get(task.id) === task;

    for (const task of [...tasks.values()]) {
      if (alive(task) && task.state === 'claimed' && at > task.claim.leaseUntil) reclaim(task, 'lease-expired');
    }
    for (const task of [...tasks.values()]) {
      if (!alive(task) || task.state !== 'claimed') continue;
      const { progress } = task.claim;
      // Those that never reported progress are governed only by lease (F3.3)
      if (progress.done !== null && at - progress.changedAt > C.STALL_MS) reclaim(task, 'stalled');
    }
    for (const node of [...nodes.values()]) {
      if (node.conn !== null || at - node.disconnectedAt <= C.RECONNECT_GRACE_MS) continue;
      for (const task of [...tasks.values()]) {
        if (alive(task) && task.state === 'claimed' && task.claim.nodeId === node.nodeId) reclaim(task, 'disconnected');
      }
      nodes.delete(node.nodeId);
    }
    for (const pub of [...publishers.values()]) {
      if (pub.conn !== null || at - pub.disconnectedAt <= C.RECONNECT_GRACE_MS) continue;
      // C5: Remove its subscriptions after grace expires; delete open tasks that become unwanted, and
      // let claimed ones finish
      for (const task of [...tasks.values()]) {
        if (!task.subscribers.delete(pub.publisherId)) continue;
        if (task.subscribers.size === 0 && task.state === 'open') {
          removeTask(task);
          broadcast(task, 'task.closed', { id: task.id, state: 'removed' });
        }
      }
      publishers.delete(pub.publisherId);
    }
    for (const task of [...tasks.values()]) {
      if (ttlPassed(task)) removeTask(task);   // C1: done / failed are kept for DONE_TTL; deletion sends no message
    }
    // Item 5 (F.1): locks are deleted only when no task references them and they have been idle for
    // more than DONE_TTL. Placed after TTL, so tasks deleted due to expiration no longer count as
    // references.
    // Comparisons use strictly greater than, same as the first four items (F.7 item 3)
    if (locks.size > 0) {
      const referenced = new Set();
      for (const task of tasks.values()) {
        const key = lockKeyOf(task);
        if (key !== null) referenced.add(key);
      }
      // Deleted locks are no longer referenced by any task, meaning no open task visibility changes,
      // so no targeted delta needs to be sent (I.3)
      for (const [key, lock] of locks) {
        if (!referenced.has(key) && at - lock.touchedAt > C.DONE_TTL) locks.delete(key);
      }
    }
    // New scan cycle: card-locked rejection count for each connection is reset to zero, lifting
    // throttling (I.5)
    for (const conn of conns.values()) conn.cardLockedRejects = 0;
    // Item 6 (M6c X3): for host connections receiving only summaries, send only when the summary
    // differs from the last sent to it, hence at most one per scan cycle
    let projects = null;
    let json = null;
    for (const conn of conns.values()) {
      if (!conn.summary || !nodeOf(conn)) continue;
      if (projects === null) { projects = summaryOf(); json = JSON.stringify(projects); }
      if (json === conn.lastSummary) continue;
      conn.lastSummary = json;
      emit(conn, 'queue.summary', { at, projects });
    }
  }

  function describe() {
    const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const claimsByNode = new Map();
    for (const t of tasks.values()) if (t.state === 'claimed') claimsByNode.set(t.claim.nodeId, (claimsByNode.get(t.claim.nodeId) ?? 0) + 1);
    const out = {
      epoch,
      prefilter: C.PREFILTER,   // I.7
      tasks: [...tasks.values()].sort((a, b) => byId(a.id, b.id)).map((t) => ({
        id: t.id, projectId: t.source.projectId, state: t.state, version: t.version,
        attempts: t.attempts, lastError: t.lastError,
        claim: t.claim && {
          nodeId: t.claim.nodeId, token: t.claim.token, leaseUntil: t.claim.leaseUntil,
          progress: { done: t.claim.progress.done, changedAt: t.claim.progress.changedAt,
            ...(t.claim.progress.step !== null ? { step: t.claim.progress.step } : {}) },
        },
        subscribers: [...t.subscribers].sort(byId),
        finishedAt: t.finishedAt,
      })),
      nodes: [...nodes.values()].sort((a, b) => byId(a.nodeId, b.nodeId)).map((n) => {
        // I.7: Number of card-locked rejections this cycle for this node's current connection, and
        // whether it is currently throttled; disconnected nodes record 0 / false
        const rejects = n.conn !== null ? n.conn.cardLockedRejects : 0;
        return {
          nodeId: n.nodeId, profile: n.profile, connected: n.conn !== null, disconnectedAt: n.disconnectedAt,
          cardLockedRejects: rejects, throttled: C.PREFILTER && rejects > C.THROTTLE_REJECTS,
          // M7 section 7 diagnostics: node user (with device), fingerprint, number of claims held at this
          // moment; tickets and the like never appear
          userId: n.userId ?? null, envFingerprint: n.envFingerprint ?? null, claims: claimsByNode.get(n.nodeId) ?? 0,
          ...(fingerprintOf(n.cardEnvFingerprint) !== null ? { cardEnvFingerprint: n.cardEnvFingerprint } : {}),
          // M7 D2 supplement: only nodes that reported node.active have these two items (describe shape
          // unchanged for legacy nodes)
          ...(typeof n.activeAt === 'number' ? { activeAt: n.activeAt, activeBusy: n.activeBusy ?? null } : {}),
        };
      }),
      publishers: [...publishers.values()].sort((a, b) => byId(a.publisherId, b.publisherId)).map((p) => ({
        publisherId: p.publisherId, connected: p.conn !== null, disconnectedAt: p.disconnectedAt,
      })),
      locks: [...locks.entries()].sort((a, b) => byId(a[0], b[0])).map(([lockKey, l]) => ({
        lockKey, envFingerprint: l.envFingerprint, source: l.source, since: l.since, touchedAt: l.touchedAt,
      })),
    };
    return structuredClone(out);
  }

  /**
   * M7 D9: Which userId this nodeId is currently bound to (returns null if node record is absent).
   * Queried before document service module check-in to avoid recording rejected connections as nodes
   */
  function nodeUserOf(nodeId) {
    return nodes.get(nodeId)?.userId ?? null;
  }

  /**
   * Minimal task view needed to determine whether an in-flight stream task can be preempted
   * (for more capable nodes; document service module hooked onto `queue.snapshot` / `task.taken`):
   * the items checked by node-side filtering (`filter.mjs`) and `canClaim` (hosted nodes check the
   * project's "generate track stream" toggle, while export bitmap is outside its scope):
   * kind, version, project, heaviness, `requires`, density in `input`, and export bitmap flag.
   * Omits claim token, subscribers, publisher user, content key, and input details.
   */
  function preemptViewOf(task) {
    const input = {};
    if (task.input?.density === 'sparse') input.density = 'sparse';
    if (task.input?.exportFrames === true) input.exportFrames = true;
    return {
      id: task.id, kind: task.kind, version: task.version,
      source: { projectId: task.source.projectId },
      weight: { class: task.weight?.class ?? 'medium' },
      requires: structuredClone(task.requires ?? {}),
      input,
    };
  }

  /**
   * Stream tasks currently claimed that are visible to this connection (optionally only inspecting
   * `id`): `[{ task: minimal view, holderNodeId }]`, in ascending order of id.
   * Visibility follows the same logic as open tasks (`canSee`: watched this project, fingerprint
   * prefiltering); pure browsers do not preempt others and always return empty.
   * `holderNodeId` is only used by the document service module to compute the holder's device tier
   * and is not sent externally.
   */
  function claimedStreamsFor(connId, id = null) {
    const conn = conns.get(connId);
    if (!conn) return [];
    const node = nodeOf(conn);
    if (!node || node.profile === 'browser') return [];
    const pick = id === null ? [...tasks.values()] : [tasks.get(id)].filter(Boolean);
    return pick
      .filter((t) => t.kind === 'stream' && t.state === 'claimed' && t.claim && canSee(conn, t))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((t) => ({ task: preemptViewOf(t), holderNodeId: t.claim.nodeId }));
  }

  return Object.freeze({
    connect, disconnect, handle, tick, describe, nodeUserOf, claimedStreamsFor,
    get epoch() { return epoch; },
  });
}
