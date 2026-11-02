import { QUEUE_DEFAULTS } from '../render-queue/constants.mjs';
import { filterClaimable } from './filter.mjs';
import { pickCandidate } from './pick.mjs';

/**
 * Session state machine for render nodes (task brief M2 "Node Session State Machine", contract B.5).
 *
 * Only handles the protocol layer: local view (which `open` tasks are visible), claiming, lease
 * renewal, yielding, releasing, and lost claims. Transport (`send`), clock (`now`), idle criterion
 * (`isIdle`), and random source are all injected by the caller; no timers are started here, and
 * the caller invokes `tick()` periodically. Actual work is started by the caller in `onTask` and
 * stopped in `onLost`.
 *
 * # Claim throttling
 *
 * At most one claim is in flight at any time, and at most one claim is sent per `tick`; no more
 * claims once held count + in-flight count reaches `maxConcurrent`. In-flight claims are cleared
 * upon receiving `task.claimed` / `task.claim-rejected` (or `error`, or re-`start`). After the queue
 * returns `claim-rejected { reason: 'throttled' }` (contract I.6), no new claims are initiated
 * within one `SWEEP_INTERVAL_MS`; lease renewal continues as normal. When returning `preferred`
 * (M6c X4: `plan` is still within the publisher's exclusive window), this candidate remains in the
 * view and is deferred until after the response's `retryInMs`.
 *
 * # Reentrancy
 *
 * The caller can connect `send` directly to the in-process queue's `handle` and synchronously pass
 * queue responses back to `receive` (this is how in-process debugging is wired). Therefore, here we
 * **update local state first, then `send`**: for example, mark in-flight before sending a claim;
 * otherwise, a synchronously returned `task.claimed` clears in-flight first and then gets marked
 * again, causing the node to never claim again.
 *
 * # Work counter step (contract A.12 [ruling])
 *
 * Each held task tracks an additional work counter `step` (initially absent): every time execution
 * arrangement advances a step (stage switch, batch emit, finishing a chunk), call `advance(id)` to
 * increment by one, without sending a separate message; the next `progress` or tick-based lease
 * renewal includes it (`task.progress { done, step }`). The queue also resets the stall timer when
 * seeing step change, so stages where frame counts remain unchanged (pushing artifacts, switching
 * stages) are not treated as frozen; if the executor genuinely freezes, step stops advancing and
 * is reclaimed due to stalling as usual. Lease renewal itself does not increment step.
 *
 * # Lost claim notified only once
 *
 * After `node.welcome.lost`, the queue will still send an extra `task.lease-lost` for the same id;
 * since the held task has already been removed, that message is ignored. A `task.lease-lost` whose
 * token does not match the locally held token (a late message from an old claim, where this id has
 * already been re-claimed) is likewise ignored.
 */

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Device rank: desktop app (3) > host render service supporting streams (2) > browser / other (1) */
export function deviceRank(node) {
  if (!node) return 0;
  if (node.profile === 'pc') return 3;
  if (node.profile === 'host') {
    return node.capabilities?.streams ? 2 : 1;
  }
  if (node.profile === 'browser') return 1;
  return 1;
}

/** Holder rank of in-flight stream task: use if provided by queue; convert from profile if only profile is given; return null if neither (not treated as preemptible) */
function holderRankOf(item) {
  if (Number.isInteger(item?.holderRank)) return item.holderRank;
  return item?.holderProfile === 'pc' ? 3 : item?.holderProfile === 'host' ? 2 : item?.holderProfile === 'browser' ? 1 : null;
}

/**
 * Task view for preemption evaluation: all ids starting with `stream:` are stream tasks,
 * supplemented with `kind: 'stream'`; project id is normalized to `source.projectId` (diagnostic-shape
 * tasks only have top-level `projectId`). This allows `canClaim` (the hosted node's per-project
 * "generate track streams" toggle) to recognize it as a stream task and know which project it belongs
 * to. Returns null if absent
 */
function streamTaskView(task, id) {
  if (!task || typeof task !== 'object') return null;
  const projectId = task.source?.projectId ?? task.projectId ?? null;
  return { ...task, id: task.id ?? id, kind: 'stream', source: { ...(task.source ?? {}), projectId } };
}

export function createNodeSession({
  nodeId,
  node,
  send,
  now,
  random = Math.random,
  isIdle = () => true,
  maxConcurrent = 1,
  constants = {},
  projects = 'all',
  onTask = () => {},
  onLost = () => {},
  // Whether this task can start right now (contract A.12 [ruling]: standalone render host only claims
  // snapshots when prerender is idle, see host.mjs); defaults to always yes.
  // The second parameter `{ held }` is the current held count: used to distinguish when the extra
  // slot granted by the claim gate (next item) only accepts specific tasks
  canClaim = () => true,
  // Maximum number of items held at this moment (claim gate, `mechanism/rendering.md` "Agent priority
  // is only queue jumping"): defaults to `maxConcurrent`.
  // Local node grants `maxConcurrent + 1` when Agent dedicated instance is running and idle,
  // claiming an extra item for it (`vite-plugin-frames.ts`).
  // `node.hello` still reports `maxConcurrent`
  claimLimit = null,
}) {
  const settings = { ...QUEUE_DEFAULTS, ...constants };
  /** Open tasks seen locally: id → TaskView */
  let open = new Map();
  /** In-flight stream tasks (claimed by others): id → { id, version, holderProfile, holderRank, density, task } (`task` checks preemption, see `streamTaskView`) */
  let inFlightStreams = new Map();
  /** Held claims: id → { id, token, lastSentAt, done, step, projectId } */
  const holds = new Map();
  /** In-flight claim: { id, projectId } | null */
  let inflight = null;
  /** Claim still in flight during `yieldAll`: if returned as `task.claimed`, release immediately without starting work */
  let yielding = null;
  let lastProjectId = null;
  let epoch = null;
  /** After throttled by queue (`claim-rejected { reason: 'throttled' }`, contract I.6), no new claims initiated before this time; renewals continue */
  let throttledUntil = -Infinity;
  /**
   * Candidates deferred until a certain timestamp: id → local time (M6c X4). When `plan` is answered
   * with `preferred` inside the publisher's exclusive window, the candidate stays in the view and is
   * deferred until after the window expires (queue's `retryInMs` is converted using local clock,
   * immune to cross-machine clock skew).
   */
  const deferred = new Map();
  /** Node description for node-side filtering: adds `nodeId` (compared against local tier capability gate `requires.localMedia`, M6c X2) */
  const filterNode = () => (node?.nodeId != null ? node : { ...node, nodeId });
  /** Projects watched by summary (M6c X3, only present when host uses `'all'`); null = no specific projects watched yet */
  let watching = null;

  const dropHold = (id, reason) => {
    if (!holds.delete(id)) return;
    onLost(id, reason);
  };

  function start(resume = []) {
    const entries = (resume ?? [])
      .filter(entry => entry && entry.id != null)
      .map(({ id, token }) => ({ id, token }));
    const resuming = new Set(entries.map(entry => entry.id));
    // For held items not included, queue abandons them directly as not-resumed; stop work here first
    for (const id of [...holds.keys()]) if (!resuming.has(id)) dropHold(id, 'not-resumed');
    const at = now();
    for (const { id, token } of entries) {
      const hold = holds.get(id);
      if (hold) hold.token = token;
      else holds.set(id, { id, token, lastSentAt: at, done: null, step: null, projectId: null });
    }
    // In-flight claims and local view on old connection invalidated: no responses will arrive, wait for queue.snapshot
    open = new Map();
    inFlightStreams.clear();
    inflight = null;
    yielding = null;
    // Throttling is tied to queue's connection; new connection does not inherit old connection backoff (contract I.10, Item 6)
    throttledUntil = -Infinity;
    deferred.clear();
    watching = null;
    send({
      type: 'node.hello', nodeId, profile: node?.profile, envFingerprint: node?.envFingerprint,
      capabilities: node?.capabilities, codeVersions: node?.codeVersions, maxConcurrent, resume: entries,
      ...(node?.planOnly !== undefined ? { planOnly: Boolean(node.planOnly) } : {}),
      ...(node?.projectStreams ? { projectStreams: node.projectStreams } : {}),
      ...(node?.streams !== undefined ? { streams: node.streams } : {}),
    });
    send({ type: 'queue.watch', projects });
  }

  function onClaimed(message) {
    const { id, token } = message;
    if (inflight?.id === id) inflight = null;
    const task = message.task ?? open.get(id) ?? null;
    open.delete(id);
    inFlightStreams.delete(id);
    if (yielding && yielding.id === id) {
      const { reason } = yielding;
      yielding = null;
      send({ type: 'task.release', id, token, reason });
      return;
    }
    const existing = holds.get(id);
    if (existing) { existing.token = token; return; }
    const projectId = task?.source?.projectId ?? null;
    holds.set(id, { id, token, lastSentAt: now(), done: null, step: null, projectId });
    if (projectId != null) lastProjectId = projectId;
    // M7 D1: plan's claim response carries fingerprints of online browser-only nodes belonging to the
    // same user, passed as-is to arrangement (splitter uses this to produce a separate copy for cards
    // runnable by browsers)
    // Chunk N: extra `browserCardEnvFingerprints` (fingerprints of the same batch of nodes executing
    // user cards and media effect cards) is likewise passed as-is, included only when present (old
    // shape remains unchanged)
    const ctx = { token };
    if (Array.isArray(message.browserFingerprints)) ctx.browserFingerprints = [...message.browserFingerprints];
    if (Array.isArray(message.browserCardEnvFingerprints)) ctx.browserCardEnvFingerprints = [...message.browserCardEnvFingerprints];
    onTask(task, ctx);
  }

  function onRejected(message) {
    const { id, reason } = message;
    if (inflight?.id === id) inflight = null;
    if (yielding?.id === id) yielding = null;
    if (reason === 'throttled') {
      // Contract I.6: Too many lock contentions on this connection during this sweep interval; queue
      // returns throttled for all requests until next sweep. Back off for one sweep interval;
      // Candidate is not deleted from local view, the task itself is unchanged and can be claimed as
      // usual afterwards
      throttledUntil = now() + settings.SWEEP_INTERVAL_MS;
      return;
    }
    if (reason === 'stale') {
      const task = open.get(id);
      if (task && Number.isInteger(message.version)) open.set(id, { ...task, version: message.version });
      const streamItem = inFlightStreams.get(id);
      if (streamItem && Number.isInteger(message.version)) streamItem.version = message.version;
      return;
    }
    if (reason === 'preferred' || reason === 'retry-backoff') {
      // M6c X4: plan is still in publisher exclusive window. Candidate kept, deferred past window; any matching pc can claim after
      const wait = Number(message.retryInMs);
      deferred.set(id, now() + (Number.isFinite(wait) && wait >= 0 ? wait : settings.SWEEP_INTERVAL_MS));
      const task = open.get(id);
      if (task && Number.isInteger(message.version)) open.set(id, { ...task, version: message.version });
      return;
    }
    // taken / gone / forbidden / card-locked / fingerprint-mismatch (contract I.10, Item 4) /
    // local-media (M6c X2) / plan-profile (M6c X4; starting from C10 contract Section 18, Item 9 only
    // returned for plans without clip manifest and browser-only) (and unrecognized reasons): no longer
    // considered in this round.
    // card-locked (contract F.2): this card's lock belongs to another fingerprint, this node's
    // fingerprint cannot process it; discard candidate as taken, without retrying; task remains open
    // in queue and only returns to view when queue sends task.opened / queue.snapshot again
    open.delete(id);
    inFlightStreams.delete(id);
  }

  /**
   * M6c X3: The queue responds to host's `watch: 'all'` only with project summary `queue.summary`,
   * without sending single-task deltas. Host session checks in as usual and then watches `'all'`;
   * upon receiving the summary, it switches to watching those projects that have open tasks in the
   * summary (merged with already-watched projects still listed in the summary): the queue responds
   * with `queue.snapshot` for these projects (replacing the local view entirely), after which it
   * receives their deltas; non-empty project lists do not stop summaries, so when a new project has
   * work, the next summary will bring it up. Only switch watch when a new project appears; do not
   * narrow when a project finishes, avoiding repeated resending of snapshots.
   * For other profiles, or when caller supplies a specific project list, summaries are completely
   * ignored (`'all'` for pc already receives full data).
   */
  function followSummary(message) {
    if (projects !== 'all' || node?.profile !== 'host') return;
    const listed = new Set();
    const want = new Set();
    for (const p of Array.isArray(message.projects) ? message.projects : []) {
      if (typeof p?.projectId !== 'string' || p.projectId === '') continue;
      listed.add(p.projectId);
      if (Number(p.open) > 0) want.add(p.projectId);
    }
    const current = watching ?? new Set();
    if ([...want].every(id => current.has(id))) return;
    const next = [...new Set([...want, ...[...current].filter(id => listed.has(id))])].sort();
    watching = new Set(next);
    send({ type: 'queue.watch', projects: next });
  }

  function receive(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'queue.summary':
        followSummary(message);
        break;
      case 'node.welcome': {
        epoch = message.epoch ?? epoch;
        for (const id of message.lost ?? []) dropHold(id, 'lost');
        // Resumed claims renew lease immediately: renewals during disconnection may be lost, little lease time may remain
        const due = now() - settings.RENEW_INTERVAL_MS;
        for (const id of message.resumed ?? []) {
          const hold = holds.get(id);
          if (hold) hold.lastSentAt = Math.min(hold.lastSentAt, due);
        }
        break;
      }
      case 'queue.snapshot': {
        const before = open;
        const beforeStreams = inFlightStreams;
        open = new Map((message.tasks ?? []).filter(task => task?.id != null).map(task => [task.id, task]));
        inFlightStreams = new Map();
        if (Array.isArray(message.claimedStreams)) {
          for (const s of message.claimedStreams) {
            if (typeof s?.id !== 'string' || !s.id.startsWith('stream:')) continue;
            inFlightStreams.set(s.id, {
              id: s.id,
              version: Number.isInteger(s.version) ? s.version : 1,
              holderProfile: s.holderProfile ?? null,
              holderRank: holderRankOf(s),
              density: s.density ?? (s.id.endsWith(':sparse') ? 'sparse' : null),
              // Locally seen full task (in open before claim, recorded in last snapshot) takes precedence; queue only gives minimal view for preemption
              task: streamTaskView(before.get(s.id) ?? open.get(s.id) ?? beforeStreams.get(s.id)?.task ?? s.task, s.id),
            });
          }
        }
        break;
      }
      case 'task.opened':
        if (message.task?.id != null) {
          open.set(message.task.id, message.task);
          inFlightStreams.delete(message.task.id);
        }
        break;
      case 'task.taken': {
        const existingTask = open.get(message.id) ?? inFlightStreams.get(message.id)?.task ?? message.task ?? null;
        open.delete(message.id);
        if (typeof message.id === 'string' && message.id.startsWith('stream:')) {
          inFlightStreams.set(message.id, {
            id: message.id,
            version: Number.isInteger(message.version) ? message.version : 1,
            holderProfile: message.holderProfile ?? null,
            holderRank: holderRankOf(message),
            density: message.density ?? (message.id.endsWith(':sparse') ? 'sparse' : null),
            task: streamTaskView(existingTask, message.id),
          });
        }
        break;
      }
      case 'task.closed':
        // Includes `state: 'hidden'` (contract I.6): the queue's fingerprint pre-filter no longer lets
        // this node see it, removed like other closed ones
        open.delete(message.id);
        inFlightStreams.delete(message.id);
        break;
      case 'task.claimed':
        onClaimed(message);
        break;
      case 'task.claim-rejected':
        onRejected(message);
        break;
      case 'task.lease-lost': {
        const hold = holds.get(message.id);
        if (!hold) break;
        if (Number.isFinite(message.token) && message.token !== hold.token) break;
        dropHold(message.id, message.reason ?? 'lost');
        break;
      }
      case 'error':
        // Claims do not carry reqId, so responses cannot be matched to which request they belong; if the
        // in-flight claim is this one, if not cleared the node will never claim again.
        // Those with reqId are responses to other requests (content store, publish, etc.) on the same
        // connection, not claims, so do not clear (contract I.10 item 5)
        if (message.reqId === undefined) inflight = null;
        break;
      default:
        break;
    }
  }

  function tick() {
    const at = now();
    for (const hold of [...holds.values()]) {
      if (holds.get(hold.id) !== hold || at - hold.lastSentAt < settings.RENEW_INTERVAL_MS) continue;
      hold.lastSentAt = at;
      send(progressMessage(hold));
    }
    let limit = maxConcurrent;
    if (typeof claimLimit === 'function') {
      try { const n = Number(claimLimit()); limit = Number.isInteger(n) && n >= 0 ? n : maxConcurrent; } catch { limit = maxConcurrent; }
    }
    if (inflight || !isIdle() || holds.size >= limit || at < throttledUntil) return;
    const held = holds.size;
    for (const [id, until] of deferred) if (until <= at || !open.has(id)) deferred.delete(id);
    const candidates = filterClaimable(known0().filter(task => !holds.has(task.id) && !deferred.has(task.id)), filterNode())
      .filter(task => { try { return canClaim(task, { held }) !== false; } catch { return false; } });
    const task = pickCandidate(candidates, { k: settings.PICK_K, random, lastProjectId });
    if (task) {
      inflight = { id: task.id, projectId: task.source?.projectId ?? null };
      try {
        send({ type: 'task.claim', id: task.id, expectVersion: task.version });
      } catch (error) {
        if (inflight?.id === task.id) inflight = null;
        throw error;
      }
      return;
    }
    // When there are no open candidate tasks: more capable devices can preempt stream tasks running on
    // weaker devices (desktop app > hosted service > browser)
    const fn = filterNode();
    const canDoStreams = fn?.capabilities?.streams === true || (fn?.capabilities?.streams === undefined && fn?.capabilities?.transcode === true);
    const myRank = canDoStreams ? deviceRank(fn) : 0;
    if (myRank > 1 && !fn.planOnly && inFlightStreams.size > 0) {
      const candidates = [];
      for (const item of inFlightStreams.values()) {
        if (holds.has(item.id) || deferred.has(item.id)) continue;
        if (!Number.isInteger(item.holderRank) || item.holderRank >= myRank) continue;
        // Must have a complete task view, and pass filterClaimable and canClaim checks
        if (!item.task) continue;
        if (!filterClaimable([item.task], fn).length) continue;
        try {
          if (canClaim(item.task, { held }) === false) continue;
        } catch { continue; }
        candidates.push(item);
      }
      if (candidates.length > 0) {
        // If there are multiple preemptible tasks, prioritize preempting sparse stream tasks (sparse
        // before full density)
        candidates.sort((a, b) => {
          const aSparse = a.density === 'sparse' ? 1 : 0;
          const bSparse = b.density === 'sparse' ? 1 : 0;
          if (aSparse !== bSparse) return bSparse - aSparse;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        const target = candidates[0];
        inflight = { id: target.id, projectId: target.task?.source?.projectId ?? null };
        try {
          send({ type: 'task.claim', id: target.id, expectVersion: target.version });
        } catch (error) {
          if (inflight?.id === target.id) inflight = null;
          throw error;
        }
      }
    }
  }

  /** Message for lease renewal / progress report: only included when step is present (messages without it are verbatim identical to before) */
  function progressMessage(hold) {
    const msg = { type: 'task.progress', id: hold.id, token: hold.token, done: hold.done ?? null };
    if (hold.step !== null && hold.step !== undefined) msg.step = hold.step;
    return msg;
  }

  function progress(id, done) {
    const hold = holds.get(id);
    if (!hold) return false;
    hold.done = done;
    hold.lastSentAt = now();
    send(progressMessage(hold));
    return true;
  }

  /** Work advanced by one step (see file header "work count step"): recorded only, not sent */
  function advance(id) {
    const hold = holds.get(id);
    if (!hold) return false;
    hold.step = (hold.step ?? 0) + 1;
    return true;
  }

  function complete(id, result) {
    const hold = holds.get(id);
    if (!hold) return false;
    holds.delete(id);
    send(result === undefined ? { type: 'task.complete', id, token: hold.token } : { type: 'task.complete', id, token: hold.token, result });
    return true;
  }

  function fail(id, error, retryable = true) {
    const hold = holds.get(id);
    if (!hold) return false;
    holds.delete(id);
    send(error === undefined
      ? { type: 'task.fail', id, token: hold.token, retryable }
      : { type: 'task.fail', id, token: hold.token, error, retryable });
    return true;
  }

  function yieldAll(reason = 'busy') {
    const released = [...holds.values()];
    holds.clear();
    if (inflight) yielding = { id: inflight.id, reason };
    for (const hold of released) send({ type: 'task.release', id: hold.id, token: hold.token, reason });
    return released.length;
  }

  const known0 = () => [...open.values()].sort(byId);

  return {
    start,
    receive,
    tick,
    progress,
    advance,
    complete,
    fail,
    yieldAll,
    held: () => [...holds.values()].sort(byId).map(({ id, token, lastSentAt }) => ({ id, token, lastSentAt })),
    known: () => known0().map(task => ({ ...task })),
    inFlightStreams: () => [...inFlightStreams.values()],
    /** Projects watched by host by digest (M6c X3), ascending; empty array if none */
    watching: () => (watching ? [...watching] : []),
    get epoch() { return epoch; },
  };
}
