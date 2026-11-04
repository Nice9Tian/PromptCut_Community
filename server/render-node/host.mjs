/**
 * Node arrangement for standalone render hosts (M6b, contract `docs/plan/render-host-contract.md`
 * sections 2 and 3).
 *
 * A standalone render host is a device that only opens `render` connections: one connection and
 * one node (`profile: 'host'`) per shared project in configuration, with all nodes sharing the same
 * prerender executor and total concurrency capped at `maxConcurrent` (defaults to 1, cap is 4).
 *
 *   parseHostConfig(raw)  Normalizes config (M6a shape: single entry or array), extracts
 *                         `maxConcurrent` (throws bad-host-config if invalid)
 *   loadHostConfig(env)   Reads file pointed to by `PROMPTCUT_SHARED_CONFIG`, then passes through
 *                         parseHostConfig
 *   createRenderHost(…)   Calls `connect(entry)` once per config entry to get { endpoint, executor,
 *                         sink }, spawns `createLocalNode` (`profile: 'host'`) on each connection,
 *                         driven by caller calling `tick()` on each tick
 *
 * # Total concurrency
 *
 * Each node's session only tracks its own held count, so an extra global gate is added: each node's
 * `isIdle()` returns "held count across all nodes + in-flight claims < maxConcurrent". In-flight
 * claims are tracked in wrapped `send` (recorded when sending `task.claim`, cleared when receiving
 * `task.claimed` / `task.claim-rejected` with matching id, `error` without reqId, re-checking in, or
 * disconnecting), matching in-flight rules in `session.mjs`. `tick()` advances nodes sequentially
 * in order, `send` is synchronous, and claims just issued by the previous node are already counted
 * during the next node's idle check, so held + in-flight never exceeds the cap at any moment.
 *
 * # Idle claims (contract `render-queue-contract.md` A.12 [ruling])
 *
 * In the prerender pipeline shared by all nodes, snapshots and `plan` use the same serial lane (doing
 * only one thing at a time). When concurrency cap is 2, claiming two snapshot clips at once forces
 * the second clip to queue in the lane: frame count does not advance and work count does not advance
 * either; queuing longer than STALL_MS causes the queue to treat it as frozen and reclaim it
 * (M8 C1). Therefore, when the executor provides `laneOf`, an extra gate is added: tasks needing a
 * serial lane are claimed only when that lane is idle (executor reports `laneBusy() === 0`), no node
 * holds a task on the same lane that has not yet reached push (`local.occupying()`), and there are no
 * in-flight claims on the same lane. Pushing artifacts does not occupy the lane: while the previous
 * clip is pushing, the next clip can still be claimed and rendered. If the executor does not provide
 * `laneOf` (test double), this gate is omitted and behavior remains as before.
 *
 * # Only claim `plan` with clip manifests
 *
 * Node-side filtering in `filter.mjs` rule 6: nodes with `profile: 'host'` skip `plan` without clip
 * manifests (from desktop publishers) directly without issuing claims (contract sections 3 and 4);
 * such `plan` is left to the publisher's own nodes. The host claims `plan` with clip manifests as
 * usual (manifest plans from online pages, prerender retry plans from legacy pages), splitting and
 * publishing fine-grained tasks using its own fingerprint (C10 contract section 18 item 9,
 * modifying M6c X4). The host itself does not publish `plan`.
 *
 * # Which tasks are visible (M6c X3)
 *
 * The queue only returns project summary `queue.summary` in response to `watch: 'all'` for host,
 * without sending single-task deltas. Upon receiving the summary, the node session (`followSummary`
 * in `session.mjs`) switches to watching projects with active work in the summary, then receives
 * their snapshots and deltas, claiming as usual; active work in new projects appears in the summary
 * after at most one scan cycle. In diagnostics, `nodes()`'s `watching` is the projects currently being
 * watched by sessions.
 *
 * # Idle gate
 *
 * The host has no pages and no playback: claims as long as the global gate has an open slot
 * (contract section 3 "Idle gate"), ignoring the executor's `isIdle`.
 *
 * # Shutdown
 *
 * `shutdown(reason)`: each node calls `yieldAll(reason)` (all held tasks issue `task.release`, and
 * in-flight claims are released upon arrival), then `stop()`; caller then closes connections. When
 * receiving `task.release`, the queue immediately returns tasks to `open` without waiting for the
 * disconnect grace period.
 *
 * # Adding and removing projects at runtime (host's render node, `docs/plan/hosted-render-contract.md` sections 2, 4, 7.1)
 *
 * When `dynamic: true`, `entries` may be empty, and caller later uses `add(entry)` /
 * `remove(projectId, { drain })`:
 *   - `add`: connects (`connect`) and starts nodes along the same path as construction; if the same
 *     `projectId` already exists, only its `members` are updated;
 *   - `remove(projectId)`: yields held claims for this project (`task.release`), stops the node,
 *     and calls `close()` provided during connection;
 *   - `remove(projectId, { drain: true })`: stops claiming new tasks, stopping and closing only after
 *     finishing held ones (both held and in-flight are cleared);
 *   - `setPaused(true)`: all nodes stop claiming new tasks, continuing with held ones (backpressure);
 *   - **Artifact capacity limit reached**: when a task fails with `service-quota` (asset service returns
 *     507, `artifact-transfer.mjs`), all nodes pause claiming for `QUOTA_PAUSE_MS` (10 minutes) and
 *     emit a `quota-paused` event; `quotaPausedUntil` is queryable. That task is a non-retryable
 *     failure;
 *   - **Round-robin across projects** (0.7.19 multi-project mode, semantics in `product/rendering.md`
 *     "Two modes of render service"; `./multi-queue.mjs`): on each tick, advances according to
 *     "longest since last turn first", giving global gate slots to it first; once a project issues a
 *     claim, it moves to the end of the line. The former "projects with online members first"
 *     conflicted with multi-project mode's "round-robin across projects within the same category"
 *     and has been removed; `members` / `setMembers` are still recorded (visible in diagnostics)
 *     without affecting priority.
 * When `dynamic` is omitted, these methods are still present and behave identically to before
 * (members table is just those entries from construction).
 *
 * # Per-project "hold without claiming" (user card isolation for host render service, `docs/plan/hosted-render-contract.md` section 7.5)
 *
 * Connecting (return value of `connect`) can optionally provide two additional items:
 *   - `hold()`: when returning true, this project **claims no tasks at all** (connections, checking
 *     in, and watching the queue proceed as usual). Resident worker processes hold projects with
 *     `card-source` in the content store like this: they execute no code brought by projects,
 *     delegating such projects entirely to isolated worker processes; isolated worker processes
 *     also hold like this before card sync reconciliation finishes;
 *   - `cards()`: returns `{ state: 'unknown' | 'none' | 'some', count }`, passed into diagnostics as is.
 * For projects with `hold`, diagnostics also has `pending` (number of tasks visible right now that
 * could be claimed if switched to a worker process carrying card code: environment fingerprint,
 * code version, and capabilities are evaluated using this node, except card code identity is ignored
 * and `userCards` is treated as true) and `pendingKey` (digest of this batch of task ids; changing
 * indicates new tasks arrived).
 * `setLimit(n)`: caps concurrency to n at runtime (0 to `maxConcurrent`; while isolated worker
 * processes run, the management process throttles resident workers down so their combined total does
 * not exceed the cap).
 * When neither is provided, behavior is identical to before across the board.
 *
 * # Per-project "whether to produce track streams" ("generate track streams" in host render service, `docs/plan/hosted-render-contract.md` section 3.1; task brief "Jia-3")
 *
 * When a config entry (`entry` in `add(entry)`) carries a boolean `streams`, this project is managed by it:
 *   - `streams: false`: **does not claim any track stream tasks for this project** (neither sparse
 *     streams nor full-density streams; snapshot tasks and plan tasks proceed as usual; connection
 *     stays intact, and stream tasks already claimed in hand are finished rather than released);
 *     `pending` / `claimable` in diagnostics also do not count stream tasks (otherwise the
 *     management process would spawn isolated worker processes for stream tasks that nobody would
 *     execute);
 *   - `streams: true`: claims as usual.
 * This is keyed by **the project this connection belongs to**, without checking `source.projectId`
 * written in tasks. `setStreams(projectId, bool)` modifies this at runtime (`reconcileHostProjects`
 * updates it according to the manifest on each reconciliation); the third argument to
 * `connect(entry, index, live)` passes `live.streams()` (read on demand), which caller passes to this
 * project's executor (determining whether to output its own share of streams when splitting manifest
 * plans). When a config entry lacks `streams` (ordinary standalone render host), it is not managed per
 * project, `live.streams()` returns null, and behavior is identical to before across the board.
 *
 * Except for `loadHostConfig` reading the configuration file once (via `../auth/shared-config.mjs`),
 * this module starts no timers and does not touch the network:
 * endpoints, executors, and artifact stores are all injected by the caller (in the prerender
 * process, this is `startHostNode` in `vite-plugin-frames.ts`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalNode, idleLockTakeover } from './local-node.mjs';
import { createRotation, orderByPolicy } from './multi-queue.mjs';
import { checkClaimable } from './filter.mjs';
import { isExportFramesTask } from './export-plan.mjs';
import { normalizeEntry, SHARED_CONFIG_ENV } from '../auth/shared-config.mjs';
import { localDeviceInfo } from '../auth/device.mjs';

/** Upper limit on total host concurrency (contract section 2) */
export const HOST_MAX_CONCURRENT = 4;
/** Environment variable overriding concurrency in configuration (`cloud/scripts/render-host.mjs --max-concurrent`) */
export const HOST_CONCURRENCY_ENV = 'PROMPTCUT_HOST_MAX_CONCURRENT';
/** Same capabilities as PC nodes (contract section 3 `node.hello`) */
export const HOST_CAPABILITIES = Object.freeze({ userCards: true, graphCards: false });
/**
 * How long to pause claiming after artifact capacity limit is reached
 * (task fails with `service-quota`) (`docs/plan/hosted-render-contract.md` section 6)
 */
export const QUOTA_PAUSE_MS = 10 * 60_000;

/**
 * Capability bits reported by host render service worker processes
 * (`docs/plan/hosted-render-contract.md` sections 5 and 7.5), centralized in this one place:
 *   - `userCards`: Only worker processes with card sync enabled report true. Resident workers
 *     never sync cards for any project (they do not execute code brought by projects) and report
 *     false, not claiming tasks requiring user cards; worker processes isolated per project
 *     (Approach A) have sync enabled and report true;
 *   - `graphCards`: false. After Stage 2 (online execution of user cards and media effect cards)
 *     merges, the lead session will align this bit;
 *   - Remaining capability bits (`streams`, `transcode`) follow measured values from the
 *     prerender pipeline, not modified here.
 * @param {object} base Measured capabilities from the prerender pipeline (`nodeCapabilities`)
 * @param {{ cardSync: boolean }} o Whether card sync is enabled for this worker process
 *
 * Media effect cards are written as they are: host render nodes **do not render media effect
 * cards right now**. In the prerender pipeline, PC nodes and standalone render hosts both
 * report `graphCards: false` (`nodeCapabilities` in `vite-plugin-frames.ts`), and tasks with
 * `requires.graphCards: true` written during splitting are claimed by nobody: this is an existing
 * rule, not a restriction on the host side; isolated worker processes report false accordingly.
 * If standalone render hosts can render media effect cards someday, just update this single place.
 */
export function hostedRenderCapabilities(base, { cardSync }) {
  return { ...base, userCards: cardSync === true, graphCards: false };
}

function badHost(detail) {
  const err = new Error(`Standalone render host config: ${detail}`);
  err.code = 'bad-host-config';
  return err;
}

/**
 * Validates concurrency (contract section 2; integration ruling 2026-09-26, contract section 6):
 * omitted (undefined / null) defaults to 1; integers 1 to 4 are accepted as is; everything else
 * is a configuration error `code: 'bad-host-config'`: values exceeding 4 throw an error without
 * truncation; 0, negative numbers, decimals, and strings all throw errors.
 */
export function hostMaxConcurrent(value) {
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw badHost('maxConcurrent must be an integer from 1 to 4');
  if (value > HOST_MAX_CONCURRENT) throw badHost(`maxConcurrent limit is ${HOST_MAX_CONCURRENT} (got ${value})`);
  return value;
}

/**
 * Parses host config (after JSON.parse of file content): single entry or array (M6a contract
 * section 11); for normalization of each entry see `normalizeEntry` (missing fields, invalid format,
 * or empty array throws `code: 'bad-shared-config'`, error message excludes passphrase and K).
 * Hosts only open `render` connections: if an entry specifies `role` other than `render`,
 * throws `bad-host-config`.
 * `maxConcurrent` may be written on any entry; takes the maximum across entries, defaulting to 1;
 * an invalid value on any entry (including exceeding 4) throws `bad-host-config`.
 * @param {unknown} raw
 * @param {{ device?: { deviceId: string, deviceName: string } }} [options] Default device info
 *   (same as second param of `normalizeEntry`)
 * @returns {{ entries: object[], maxConcurrent: number }}
 */
export function parseHostConfig(raw, { device } = {}) {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) {
    const err = new Error(`${SHARED_CONFIG_ENV}: config is an empty array`);
    err.code = 'bad-shared-config';
    throw err;
  }
  const entries = list.map((item) => (device ? normalizeEntry(item, device) : normalizeEntry(item)));
  for (const [i, item] of list.entries()) {
    if (item.role !== undefined && item.role !== 'render') throw badHost(`Item ${i}: role must be 'render' (the host only opens render connections)`);
  }
  const given = list.filter((item) => item.maxConcurrent !== undefined && item.maxConcurrent !== null).map((item) => hostMaxConcurrent(item.maxConcurrent));
  return { entries, maxConcurrent: given.length ? Math.max(...given) : 1 };
}

/**
 * Reads host config: file pointed to by `PROMPTCUT_SHARED_CONFIG`, content described in `parseHostConfig`;
 * unreadable or non-JSON throws `bad-shared-config`.
 * `PROMPTCUT_HOST_MAX_CONCURRENT` (`render-host --max-concurrent`) takes precedence if set, likewise
 * requiring an integer from 1 to 4, otherwise `bad-host-config`.
 * Returns null if environment variable is not set.
 * @returns {null | { entries: object[], maxConcurrent: number }}
 */
export function loadHostConfig(env = process.env) {
  const file = env[SHARED_CONFIG_ENV];
  if (!file) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    const e = new Error(`${SHARED_CONFIG_ENV}: cannot read config file (${err?.code ?? 'bad-json'})`);
    e.code = 'bad-shared-config';
    throw e;
  }
  const parsed = parseHostConfig(raw, { device: localDeviceInfo(env) });
  const override = env[HOST_CONCURRENCY_ENV];
  if (override !== undefined && override !== '') {
    if (!/^\d+$/.test(String(override))) throw badHost(`${HOST_CONCURRENCY_ENV} must be an integer from 1 to 4`);
    parsed.maxConcurrent = hostMaxConcurrent(Number(override));
  }
  return parsed;
}

/**
 * `superseded`: count of tasks where executor deemed content superseded by newer version
 * and reported to queue for invalidation (`render-queue-contract.md` J.15), not counted toward `failed`
 */
/**
 * `completed` / `dedup` only count **fine-grained tasks**: those delivered after rendering and
 * those delivered via deduplication because they already exist in the artifact store. `plans` counts
 * finished plan tasks (split and published fine-grained tasks; host render nodes take this path when
 * claiming plans with clip manifests). For a node that only split plans while fine-grained tasks were
 * all delivered via deduplication, `completed` is 0; inspect `plans` and `dedup`.
 */
const emptyStats = () => ({ claimed: 0, completed: 0, dedup: 0, plans: 0, failed: 0, superseded: 0, lost: 0, discarded: 0, released: 0 });

/**
 * @param {object} options
 * @param {object[]} options.entries  Normalized config entries (`loadHostConfig().entries`),
 *   each must have `projectId`; may be empty when `dynamic`
 * @param {boolean} [options.dynamic]  Allows empty `entries`; projects are added/removed at runtime
 *   via `add` / `remove`
 * @param {(entry: object, index: number, live: { streams: () => boolean | null }) => { endpoint: object, executor: object, sink: object, close?: () => void }} options.connect
 *   Called once per entry (for third parameter see "Per-project whether to produce track streams"
 *   at file header): `render` connection to that project's document service (`createWsEndpoint`
 *   shape; attaches `onOpen` / `onClose` if present, treats as connected otherwise), plus
 *   executor and artifact store used by this project
 * @param {(entry: object, index: number) => string} options.nodeIdOf  Id for each node
 * @param {string} options.envFingerprint
 * @param {string} options.codeVersion  A host instance only has one code version (contract section 3 [ruling])
 * @param {number} [options.maxConcurrent]  Total concurrency, defaults to 1, cap is 4
 * @param {object} [options.capabilities]  Defaults to `HOST_CAPABILITIES`
 * @param {Record<string, string[]>} [options.cardSourceVersions]  Card code identities present on
 *   this machine right now (contract B.2; c66-host-cards: filters task `requires.cardSources`
 *   against it; does not claim if this machine lacks the code). Can be an on-demand view
 *   (`view` in `card-code.mjs`), read on each tick during claiming; defaults to empty (only
 *   claims tasks not requiring card code)
 * @param {() => number} options.now
 * @param {() => number} [options.random]
 * @param {object} [options.constants]
 * @param {(event: object) => void} [options.onEvent]  Events from local-node, with additional `projectId` and `index`
 */
export function createRenderHost({
  entries,
  connect,
  nodeIdOf,
  envFingerprint,
  codeVersion,
  maxConcurrent = 1,
  capabilities = HOST_CAPABILITIES,
  cardSourceVersions,
  now,
  random,
  constants,
  onEvent = () => {},
  dynamic = false,
}) {
  if (!Array.isArray(entries) || (entries.length === 0 && !dynamic)) throw new TypeError('createRenderHost: entries needs at least one item');
  if (typeof connect !== 'function') throw new TypeError('createRenderHost: connect must be a function');
  const cap = hostMaxConcurrent(maxConcurrent);
  let version = codeVersion;
  let stopped = false;
  let started = false;
  let paused = false;
  let quotaUntil = 0;
  let nextIndex = 0;
  /** Concurrency cap at runtime (`setLimit`), not exceeding `cap` */
  let limit = cap;
  /**
   * Accounting for round-robin across projects (multi-project mode; stream-producing category):
   * tracked by number assigned at connection time; removed projects are forgotten
   */
  const rotation = createRotation();

  const emit = (event) => { try { onEvent(event); } catch { /* Errors in diagnostic callbacks do not affect nodes */ } };

  /** Prefix of task id is kind (`snapshot:` / `stream:` / `plan:`) */
  const kindOfId = (id) => (typeof id === 'string' ? id.slice(0, id.indexOf(':')) : null);

  /** Idle claims (see file header): whether serial lane needed by this task is currently free */
  function laneFree(m, task) {
    const ex = m.executor;
    if (typeof ex?.laneOf !== 'function') return true;
    const lane = ex.laneOf(task);
    if (lane === null || lane === undefined) return true;
    if (typeof ex.laneBusy === 'function' && ex.laneBusy() > 0) return false;
    for (const x of members) {
      const laneOfX = (t) => (typeof x.executor?.laneOf === 'function' ? x.executor.laneOf(t) : null);
      if (x.inflight !== null && laneOfX({ kind: kindOfId(x.inflight) }) === lane) return false;
      for (const run of x.local?.occupying?.() ?? []) if (laneOfX(run) === lane) return false;
    }
    return true;
  }

  /** `streams` in config entry: managed per project only if boolean; other values (omitted) are null */
  const streamsOf = (entry) => (typeof entry?.streams === 'boolean' ? entry.streams : null);
  /**
   * Whether this task for this project passes the "generate track streams" gate: when disabled
   * (m.streams === false), host render nodes produce no track streams at all (neither sparse streams
   * nor full-density streams; leaving only Agent frame inspection see_frames/get_gif/get_layout).
   * When enabled, both sparse and full-density streams are produced.
   */
  // Per-frame bitmap tasks dedicated to export (`../export-frames.mjs`; also a stream task kind)
  // are not track streams and are not governed by this setting: projects with this disabled can still export
  const streamsPass = (m, task) => task?.kind !== 'stream' || m.streams !== false || isExportFramesTask(task);

  /** Whether this project is currently held without claiming (see file header); treated as held if indeterminate */
  const held = (m) => {
    if (!m.hold) return false;
    try { return m.hold() !== false; } catch { return true; }
  };

  /**
   * In held projects, tasks that could be claimed if switched to a worker process carrying card code:
   * filtered by this node's environment fingerprint, code version, and capabilities, except card code
   * identity (`requires.cardSources`) is ignored and `userCards` is treated as true. Returns
   * `{ pending, pendingKey, claimable }` (`claimable` is the count claimable right now based on card
   * code actually present on this node).
   */
  function pendingOf(m) {
    let tasks = [];
    try { tasks = m.local?.session.known?.() ?? []; } catch { tasks = []; }
    const node = { nodeId: m.nodeId, profile: 'host', envFingerprint, codeVersions: [version], capabilities: { ...capabilities, userCards: true }, maxConcurrent: cap };
    const mine = { ...node, capabilities, ...(cardSourceVersions ? { cardSourceVersions } : {}) };
    const ids = [];
    let claimable = 0;
    for (const task of tasks) {
      // This project produces no track streams: nobody will execute its stream tasks,
      // so they do not count as "pending" (see file header)
      if (!streamsPass(m, task)) continue;
      const { cardSources: _ignored, ...requires } = task?.requires ?? {};
      if (checkClaimable({ ...task, requires }, node).ok) ids.push(String(task.id));
      // Calculated from card code actually present on this node: claimable right now
      // (isolated workers use this to determine if work remains)
      if (checkClaimable(task, mine).ok) claimable += 1;
    }
    ids.sort();
    return { pending: ids.length, pendingKey: ids.length ? createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16) : '', claimable };
  }

  /** Held count across all nodes + in-flight claims */
  const busy = () => members.reduce((n, m) => n + (m.local ? m.local.session.held().length : 0) + (m.inflight !== null ? 1 : 0), 0);

  /**
   * @type {any[]} Existing projects; appended via `add` and removed via `remove` at runtime.
   * `index` is the number assigned at connection time and not reused after removal
   */
  const members = [];
  function wire(entry) {
    const index = nextIndex++;
    /**
     * Whether this project produces track streams (`null` means not managed per project);
     * initialized before connection, passing on-demand reader during connection
     */
    const live = { streams: streamsOf(entry) };
    const wired = connect(entry, index, { streams: () => live.streams });
    const endpoint = wired?.endpoint;
    if (!endpoint || typeof endpoint.send !== 'function' || typeof endpoint.onMessage !== 'function') {
      throw new TypeError(`createRenderHost: endpoint of item ${index} is invalid`);
    }
    const m = {
      index,
      projectId: entry.projectId ?? null,
      nodeId: nodeIdOf ? nodeIdOf(entry, index) : `host-${index}`,
      endpoint,
      executor: wired.executor,
      sink: wired.sink,
      local: null,
      inflight: null,
      started: false,
      stats: emptyStats(),
      seen: new Set(),
      close: typeof wired.close === 'function' ? wired.close : null,
      hold: typeof wired.hold === 'function' ? wired.hold : null,
      cards: typeof wired.cards === 'function' ? wired.cards : null,
      prefer: entry.members === true,
      draining: false,
      removed: false,
      get streams() { return live.streams; },
      set streams(value) { live.streams = value; },
    };
    // Wrap send: record in-flight claims and releases
    m.ep = {
      send(message) {
        if (message?.type === 'task.claim') m.inflight = message.id;
        else if (message?.type === 'node.hello') m.inflight = null;
        else if (message?.type === 'task.release') m.stats.released++;
        return endpoint.send(message);
      },
      onMessage: (handler) => endpoint.onMessage(handler),
    };
    endpoint.onMessage((message) => {
      switch (message?.type) {
        case 'task.claimed':
          m.stats.claimed++;
          if (m.inflight === message.id) m.inflight = null;
          break;
        case 'task.claim-rejected':
          if (m.inflight === message.id) m.inflight = null;
          break;
        case 'error':
          if (message.reqId === undefined) m.inflight = null;
          break;
        case 'task.opened':
          if (message.task?.id != null) m.seen.add(message.task.id);
          break;
        case 'queue.snapshot':
          for (const task of message.tasks ?? []) if (task?.id != null) m.seen.add(task.id);
          break;
        default:
          break;
      }
    });
    if (typeof endpoint.onOpen === 'function') endpoint.onOpen(() => open(m));
    if (typeof endpoint.onClose === 'function') endpoint.onClose(() => { m.started = false; m.inflight = null; });
    members.push(m);
    return m;
  }
  for (const entry of entries) wire(entry);

  /** Removes a project: stops node, removes from members list, and calls close provided during connection */
  function detach(m, reason) {
    if (m.removed) return;
    m.removed = true;
    try { m.local?.stop(); } catch { /* Stopped */ }
    m.started = false;
    const i = members.indexOf(m);
    if (i >= 0) members.splice(i, 1);
    rotation.forget(String(m.index));
    try { m.close?.(); } catch { /* Closed */ }
    emit({ type: 'project-removed', projectId: m.projectId, index: m.index, reason });
  }

  function build(m) {
    m.local?.stop();
    m.local = createLocalNode({
      nodeId: m.nodeId,
      node: { profile: 'host', envFingerprint, codeVersions: [version], capabilities, maxConcurrent: cap, ...(cardSourceVersions ? { cardSourceVersions } : {}) },
      endpoint: m.ep,
      now,
      ...(random ? { random } : {}),
      ...(constants ? { constants } : {}),
      isIdle: () => !paused && now() >= quotaUntil && !m.draining && busy() < limit && !held(m),
      canClaim: (task) => streamsPass(m, task) && laneFree(m, task),
      maxConcurrent: cap,
      codeVersion: version,
      executor: m.executor,
      sink: m.sink,
      // M7 D2: when queue lock holder is idle for strictly over 30 s and this card is unfinished,
      // split with takeover to take over the whole card using this host's fingerprint
      takeoverLocked: idleLockTakeover,
      onEvent: (event) => {
        const type = event?.type;
        if (type === 'completed') m.stats.completed++;
        else if (type === 'dedup') m.stats.dedup++;
        else if (type === 'plan-split') m.stats.plans++;
        else if (type === 'failed') {
          m.stats.failed++;
          if (event.error === 'service-quota') {
            quotaUntil = now() + QUOTA_PAUSE_MS;
            emit({ type: 'quota-paused', until: quotaUntil, id: event.id, projectId: m.projectId, index: m.index });
          }
        }
        else if (type === 'superseded') m.stats.superseded++;
        else if (type === 'lost') m.stats.lost++;
        else if (type === 'discarded') m.stats.discarded++;
        emit({ ...event, projectId: m.projectId, index: m.index });
      },
    });
  }

  /** Checks in upon (re)connection, resuming claims still held by this instance (G.7 standard convention) */
  function open(m) {
    if (stopped || !m.local || m.removed) return;
    m.inflight = null;
    m.local.start(m.local.session.held().map(({ id, token }) => ({ id, token })));
    m.started = true;
  }

  return {
    /**
     * Starts all nodes; already connected ones (or those without connection state, such as in-process
     * loopback) check in immediately
     */
    start() {
      stopped = false;
      started = true;
      for (const m of members) {
        build(m);
        if (m.endpoint.connected === true || (typeof m.endpoint.onOpen !== 'function' && m.endpoint.closed !== true)) open(m);
      }
    },
    /**
     * One tick: renews leases and claims for each node. Round-robin across projects: advances
     * the project longest since last turn first (granting global gate slots to it first); a project
     * that issued claims on this tick moves to the end of the line; draining projects are removed
     * once completed
     */
    tick() {
      if (stopped) return;
      const order = orderByPolicy(members.map((m) => ({ m, projectId: String(m.index), kind: 'stream', seq: m.index })), rotation).map((x) => x.m);
      for (const m of order) {
        if (m.removed) continue;
        const before = m.inflight;
        if (m.started && m.local) m.local.tick();
        if (m.inflight !== null && m.inflight !== before) rotation.served('stream', String(m.index));
        if (m.draining && m.inflight === null && (m.local ? m.local.session.held().length : 0) === 0 && (m.local?.running?.().length ?? 0) === 0) detach(m, 'drained');
      }
    },
    /**
     * Add a project at runtime (`entry.projectId` is required; `entry.members` indicates members are
     * currently online). If already present, only update `members` and cancel draining.
     * Returns true = newly added.
     */
    add(entry) {
      if (stopped && started) return false;
      const existing = members.find((m) => m.projectId === entry?.projectId);
      if (existing) {
        existing.prefer = entry.members === true;
        existing.draining = false;
        if (streamsOf(entry) !== null) existing.streams = entry.streams;
        return false;
      }
      const m = wire(entry);
      if (started) {
        build(m);
        if (m.endpoint.connected === true || (typeof m.endpoint.onOpen !== 'function' && m.endpoint.closed !== true)) open(m);
      }
      return true;
    },
    /**
     * Remove a project at runtime. Default: release its held claims (`task.release`) and stop and close
     * immediately; `drain: true`: stop claiming new tasks, finish held tasks before stopping and closing.
     * Returns number of released claims (0 when draining); returns -1 if project does not exist.
     */
    remove(projectId, { drain = false, reason = 'removed' } = {}) {
      const m = members.find((x) => x.projectId === projectId);
      if (!m) return -1;
      if (drain) {
        m.draining = true;
        return 0;
      }
      let released = 0;
      try { released = m.local?.yieldAll(reason) ?? 0; } catch { /* Connection broken: queue reclaims on disconnect */ }
      detach(m, reason);
      return released;
    },
    /** Whether this project currently has members online (prioritized if any) */
    setMembers(projectId, online) {
      const m = members.find((x) => x.projectId === projectId);
      if (m) m.prefer = online === true;
    },
    /**
     * Whether this project produces track streams (see file header): accepts booleans only; changing to
     * not producing does not release held claims, but stops claiming new stream tasks
     */
    setStreams(projectId, value) {
      const m = members.find((x) => x.projectId === projectId);
      if (m && typeof value === 'boolean') m.streams = value;
    },
    /** Backpressure: pause claiming new tasks, continue working on held tasks */
    setPaused(value) { paused = value === true; },
    get paused() { return paused; },
    /**
     * Throttle concurrency to n (0-maxConcurrent) at runtime; restore to maxConcurrent if not an
     * integer in this range. Continue working on existing held tasks
     */
    setLimit(n) { limit = Number.isInteger(n) && n >= 0 && n <= cap ? n : cap; },
    get limit() { return limit; },
    /**
     * Millisecond timestamp until which claiming is paused due to output capacity limit; returns null
     * if not paused
     */
    get quotaPausedUntil() { return now() < quotaUntil ? quotaUntil : null; },
    /** The projectId of existing projects (including those draining) */
    projects: () => members.map((m) => m.projectId),
    /** Code version changed: release all claims and check in again with the new version */
    setCodeVersion(next) {
      if (next === version) return false;
      version = next;
      for (const m of members) {
        try { m.local?.yieldAll('code-changed'); } catch { /* Connection broken */ }
        build(m);
        if (m.started) { m.started = false; open(m); }
      }
      return true;
    },
    /** Exit: release all claims and stop node. Returns number of released claims */
    shutdown(reason = 'shutdown') {
      let released = 0;
      for (const m of members) {
        try { released += m.local?.yieldAll(reason) ?? 0; } catch { /* Connection broken: queue reclaims on disconnect */ }
        try { m.local?.stop(); } catch { /* Stopped */ }
        m.started = false;
      }
      stopped = true;
      return released;
    },
    /** Executions not yet settled (wait for them to finalize after `shutdown`) */
    async settled() { await Promise.all(members.map((m) => m.local?.settled())); },
    running: () => members.flatMap((m) => m.local?.running() ?? []),
    busy,
    get maxConcurrent() { return cap; },
    get codeVersion() { return version; },
    /** Section 3 "Diagnostics" of the contract: each item in `nodes` represents one node */
    nodes() {
      return members.map((m) => ({
        projectId: m.projectId,
        index: m.index,
        prefer: m.prefer,
        draining: m.draining,
        nodeId: m.nodeId,
        connected: m.endpoint.connected === true || (m.endpoint.connected === undefined && m.endpoint.closed !== true),
        claimed: m.stats.claimed,
        completed: m.stats.completed,
        dedup: m.stats.dedup,
        plans: m.stats.plans,
        failed: m.stats.failed,
        superseded: m.stats.superseded,
        lost: m.stats.lost,
        discarded: m.stats.discarded,
        released: m.stats.released,
        seen: m.seen.size,
        watching: m.local?.session.watching?.() ?? [],
        held: m.local ? m.local.session.held().map(({ id }) => id) : [],
        running: m.local ? m.local.running() : [],
        ...(m.streams !== null ? { streams: m.streams } : {}),
        ...(m.hold ? { hold: held(m), ...pendingOf(m) } : {}),
        ...(m.cards ? { cards: (() => { try { return m.cards(); } catch { return { state: 'unknown', count: 0 }; } })() } : {}),
        ...(typeof m.endpoint.stats === 'function' ? { transport: m.endpoint.stats() } : {}),
      }));
    },
  };
}

/**
 * CLI arguments for `cloud/scripts/render-host.mjs` (section 2 of the contract); placed here
 * because `server/**` cannot import `scripts/` (needed for unit tests)
 */
export function renderHostArgs(argv) {
  const opts = { port: 5400, config: null, data: null, maxConcurrent: null, streams: false, verbose: false, cwd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--port') opts.port = Number(next());
    else if (a === '--config') opts.config = next();
    else if (a === '--data') opts.data = next();
    else if (a === '--max-concurrent') opts.maxConcurrent = Number(next());
    else if (a === '--streams') opts.streams = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--cwd') opts.cwd = next();
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65533) throw new Error('--port is invalid');
  if (opts.maxConcurrent !== null && !(Number.isInteger(opts.maxConcurrent) && opts.maxConcurrent >= 1 && opts.maxConcurrent <= 4)) {
    throw new Error('--max-concurrent must be an integer from 1 to 4');
  }
  return opts;
}

/**
 * Environment variables set by `cloud/scripts/render-host.mjs` for the editor child process
 * (section 2 of the contract)
 */
export function renderHostEnv(base, { config, data, streams, maxConcurrent }) {
  const env = { ...base };
  for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_HEADLESS', 'PROMPTCUT_PUSH', 'PROMPTCUT_ROLE']) delete env[key];
  const tmp = path.join(data, 'tmp');
  // Broker mode (host render node): no config file; requests project manifest and tickets from
  // the manager process (`PROMPTCUT_RENDER_BROKER`)
  if (config) env.PROMPTCUT_SHARED_CONFIG = path.resolve(config);
  else delete env.PROMPTCUT_SHARED_CONFIG;
  Object.assign(env, {
    PROMPTCUT_QUEUE_NODE: '1',
    PROMPTCUT_NODE_PROFILE: 'host',
    PROMPTCUT_STREAMS: streams ? '1' : '0',
    PROMPTCUT_EXPORT_DIR: data,
    PROMPTCUT_DATA_DIR: path.join(data, 'data'),
    TEMP: tmp, TMP: tmp, TMPDIR: tmp,
  });
  if (maxConcurrent !== null && maxConcurrent !== undefined) env.PROMPTCUT_HOST_MAX_CONCURRENT = String(maxConcurrent);
  else delete env.PROMPTCUT_HOST_MAX_CONCURRENT;
  return env;
}

/**
 * Two environment variables for broker mode (`docs/plan/hosted-render-contract.md` section 7.1):
 * the manager process's local broker port and the passphrase for this startup
 */
export const BROKER_URL_ENV = 'PROMPTCUT_RENDER_BROKER';
export const BROKER_KEY_ENV = 'PROMPTCUT_RENDER_BROKER_KEY';

/**
 * Broker mode client: worker process asks the manager process "which projects to connect to right
 * now" and for connection tickets. The worker process holds no service private key or project
 * passphrases.
 *   projects() → { docUrl, paused, projects: [{ projectId, members, drain, nodeId }] }
 *   ticket(projectId) → connection ticket (string); throws on failure
 * @param {{ url: string, key: string, fetch?: typeof globalThis.fetch, timeoutMs?: number }} options
 */
export function createBrokerClient({ url, key, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  const base = String(url).replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  async function call(pathname, init = {}) {
    const res = await fetchImpl(`${base}${pathname}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => null);
    if (res.status !== 200 || !body || body.ok !== true) {
      const err = new Error(`Render proxy port ${pathname}:${res.status} ${body?.error ?? ''}`.trim());
      err.code = body?.error ?? `http-${res.status}`;
      throw err;
    }
    return body;
  }
  return {
    projects: () => call('/projects'),
    async ticket(projectId) { return (await call('/ticket', { method: 'POST', body: JSON.stringify({ projectId }) })).ticket; },
    /**
     * Worker process reports its diagnostics to manager process (so it need not query worker process
     * back)
     */
    report: (body) => call('/report', { method: 'POST', body: JSON.stringify(body) }).catch(() => null),
  };
}

/**
 * Reconcile against manifest from broker endpoint: `add` items to add, `remove` items not in
 * manifest, drain items marked with `drain`, updating `members`, `streams` (whether this project
 * produces track streams), and `paused` accordingly.
 * Pure arrangement, touches no network; returns `{ added, removed, drained }` (projectId lists).
 * @param {ReturnType<typeof createRenderHost>} host
 * @param {{ paused?: boolean, projects: { projectId: string, members?: boolean, drain?: boolean }[] }} listing
 * @param {(item: object) => object} entryOf  manifest item → config entry for `add`
 */
export function reconcileHostProjects(host, listing, entryOf) {
  const want = new Map((listing?.projects ?? []).map((p) => [p.projectId, p]));
  const out = { added: [], removed: [], drained: [] };
  host.setPaused(listing?.paused === true);
  // If manifest omits `limit` (older manager processes, test doubles), do not throttle: restore to
  // maxConcurrent
  host.setLimit?.(Number.isInteger(listing?.limit) ? listing.limit : null);
  for (const projectId of host.projects()) {
    if (want.has(projectId)) continue;
    host.remove(projectId, { reason: 'not-listed' });
    out.removed.push(projectId);
  }
  for (const [projectId, item] of want) {
    if (item.drain === true) {
      if (host.remove(projectId, { drain: true }) === 0) out.drained.push(projectId);
      continue;
    }
    // Projects already present: `add` updates `members` and `streams` from this config entry (when the
    // creator toggles "generate track streams" and the manifest changes, this catches up within one tick)
    if (host.add(entryOf(item))) out.added.push(projectId);
    else host.setMembers(projectId, item.members === true);
  }
  return out;
}

/**
 * Media fallback (J.6) picks tickets by base URL: asset tickets are only valid on the asset
 * service that issued them; when projects joined by a host belong to different asset services,
 * reading fallback from a host requires the ticket of that host's project (legacy fix from M6b
 * integration: previously only first project's ticket was used, causing 401 on the second).
 * Handed to `setMediaFallbackTicket` in `asset-client.ts`, called on each fallback base URL attempt.
 * @param {Array<{ base: () => string | null, ticket: () => Promise<string | null> }>} records
 *   One item per project, in config order
 * @returns {(base: string) => Promise<string | null> | null}
 *   Returns null if base URL belongs to no project (without ticket)
 */
export function fallbackTicketFor(records) {
  const norm = (b) => String(b ?? '').trim().replace(/\/+$/, '');
  return (base) => {
    const want = norm(base);
    const rec = records.find((r) => {
      const b = r.base();
      return !!b && norm(b) === want;
    });
    return rec ? rec.ticket() : null;
  };
}
