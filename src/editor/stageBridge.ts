import type { Project } from "../kernel/project";
import { changedClips, isEmptyPatch } from "../render/changedClips.mjs";
// Explicit .ts suffix: `stageEventRole` is a runtime value, and the unit test imports this module directly in node (see stageBridge.test.mjs)
import { stageEventRole, type HostCapabilities, type StageEvent, type StageRole, type StageRpcClient } from "../render/stageRpc.ts";

/**
 * The registry in the main document for "which iframe is the stage right now" (E0 / E1 / D4,
 * page side).
 *
 * It used to be a getter on the main window (fetching the stage api inside the iframe), which the
 * positioning tool in the right rail used to measure contentBox. Now the stage speaks only through
 * postMessage RPC, and the main document holds only an RPC client. Each time Preview swaps in a
 * different iframe it registers a new client here, and the right rail always gets the latest one.
 *
 * Two positions (**roles, not instances**: the iframe's `id=A` / `id=B` are only instance names,
 * the role is set by `setRole`, and a K5 swap puts the same iframe into the other position):
 *   - `front`: the visible player stage (drag / pause / hit testing).
 *   - `back`: the background stage (probe / rerun / page-side measurement). The legacy single
 *     stage does not have it; when `back` is empty, `front` stands in for it (D4: "measure on it
 *     first; after E1 switch to back and the single-flight queue").
 *
 * There are only two ways to push a project, **and both keep a "last pushed project" baseline per
 * iframe** (per client, not per position; when K5 swaps, the same iframe moves to the other
 * position and the baseline follows it):
 *   - `syncProject(role, project)`: when an incremental update is possible, send the two-level diff
 *     of changedClips (the stage keeps references of unchanged clips when merging); with no
 *     baseline, send the whole project + reset; if it is the same object reference as the
 *     baseline, send nothing.
 *   - `pushProject(role, project, { reset })`: with `reset`, always reload the whole project. The
 *     probe's shrunken project, the whole-scene rerun on the K5 second path, and the D4 page-side
 *     measurement all go through it. **Sending `setProject` directly bypasses the baseline**, so a
 *     later `syncProject(backRole(), …)` silently sends nothing because it "is unchanged compared
 *     with the baseline", and `back` stays stuck on the shrunken project (the pitfall named in E0).
 * Both ways share the `send` below, so the same project is never pushed twice.
 */
interface Slot {
  client: StageRpcClient | null;
  /** Host capability table reported by the stage at handshake (J4). The `device` string of K1 needs `compact` / `offscreenGl` */
  caps: HostCapabilities | null;
  /** Promise that "a client now exists" at this position (whenStageReady); replaced by a new one when the client changes */
  ready: { promise: Promise<StageRpcClient>; resolve: (c: StageRpcClient) => void; settled: boolean };
  /** Unsubscribe function for events sent by the client at this position */
  off: (() => void) | null;
}

function pendingReady(): Slot["ready"] {
  let resolve!: (c: StageRpcClient) => void;
  const promise = new Promise<StageRpcClient>((r) => { resolve = r; });
  return { promise, resolve, settled: false };
}

const newSlot = (): Slot => ({ client: null, caps: null, ready: pendingReady(), off: null });

const slots: Record<StageRole, Slot> = { front: newSlot(), back: newSlot() };

/**
 * One per client (= one handshake of one iframe): the project last pushed to it successfully (the
 * baseline for incremental diffs), and the serial chain of pushes (when two pushes interleave, the
 * later one waits for the earlier one to settle before diffing).
 *
 * **Keyed by client, not by position** (root cause A): when the K5 second-path catch-up run starts,
 * `back` receives the project as of that moment, and edits the user makes to the timeline during the
 * run are pushed only to the `front` of the time. After the swap the new `front` still holds the old
 * project. Previously the baseline was keyed by position and, on swap, recorded with `markPushed` as
 * "the latest project right now"; after that `syncProject` sent nothing because the baselines were
 * equal, and deleted clips stayed on the stage forever. An iframe reload creates a new client, so this
 * record naturally becomes void.
 */
interface Pushed {
  project: Project | null;
  chain: Promise<void>;
}
let pushedBy = new WeakMap<StageRpcClient, Pushed>();
function pushedOf(client: StageRpcClient): Pushed {
  let p = pushedBy.get(client);
  if (!p) { p = { project: null, chain: Promise.resolve() }; pushedBy.set(client, p); }
  return p;
}

/** Event subscribers (fed only after filtering by role) */
const eventListeners = new Set<(e: StageEvent, role: StageRole) => void>();

/** Optional hook run before a full project reset push so local mirror state aligns before the stage requests `/@media/<hash>` */
let beforeFullProjectPush: ((project: Project) => Promise<void>) | null = null;

export function setBeforeFullStagePush(fn: ((project: Project) => Promise<void>) | null): void {
  beforeFullProjectPush = fn;
}

/**
 * Register / unregister a stage client. When replacing an iframe, register the new one first and then
 * dispose the old one; the baseline is replaced together with the client.
 *
 * Event forwarding is hooked up here too: **only here do we know both "which client" and "what role
 * it has right now"**, and the `event.source` filter needs both (last item of E0). The `createStageRpc`
 * layer only handles the first half of the problem.
 */
export function setStageClient(role: StageRole, client: StageRpcClient | null, caps: HostCapabilities | null = null): void {
  const slot = slots[role];
  if (slot.client === client) return;
  slot.off?.();
  slot.off = null;
  slot.client = client;
  slot.caps = caps;
  if (!client) {
    // This position is now empty: the next whenStageReady has to wait for the new one
    if (slot.ready.settled) slot.ready = pendingReady();
    return;
  }
  slot.off = client.onEvent((e) => {
    /*
     * Role filter: `frame` / `ended` / `settled` / `demote` are accepted only from the current `front`,
     * `mediaReady` / `probe` / `probe-frame` only from the current `back`, and the rest are dropped.
     * On the beat of a swap both stages may post (the old front stops only after finishing this beat);
     * without the filter the tick would be duplicated.
     */
    if (stageEventRole(e.type) !== role && !(role === "front" && backRole() === "front")) return;
    // The client was replaced while the event was queued: this one belongs to the previous iframe, so it doesn't count
    if (slots[role].client !== client) return;
    for (const l of eventListeners) l(e, role);
  });
  // One that has already resolved (the previous client) cannot resolve again: make a new Promise and resolve it with the new client
  if (slot.ready.settled) slot.ready = pendingReady();
  slot.ready.settled = true;
  slot.ready.resolve(client);
}

/**
 * The iframe was unloaded: detach its client **no matter which position it is in** (after a K5 swap,
 * A is not necessarily still `front`).
 *
 * The consequence of not detaching has been observed: `frontStage()` only looks at `disposed`, and
 * nobody disposes the client of an unloaded iframe, so it keeps being handed out as the visible stage
 * -- on the 3D tab, `play()` is sent into a window that is already closed and never gets a reply.
 */
export function releaseStageClient(client: StageRpcClient): void {
  for (const role of ["front", "back"] as const) if (slots[role].client === client) setStageClient(role, null);
}

/**
 * Subscribe to stage events (seven kinds, already filtered by the `event.source` role rules). Returns
 * an unsubscribe function.
 *
 * R2 only builds the skeleton: `play` / `pause` still return `unsupported` (K4 is R5's job), so
 * `frame` / `ended` / `settled` never arrive at this step; the consumers of `probe` / `probe-frame` /
 * `demote` are R4's probe and K6's downgrade. **The protocol surface and the filter are in place
 * here, so R5 / R4 don't need to touch them again when they plug in consumers.**
 */
export function onStageEvent(listener: (e: StageEvent, role: StageRole) => void): () => void {
  eventListeners.add(listener);
  return () => { eventListeners.delete(listener); };
}

export function frontStage(): StageRpcClient | null {
  const c = slots.front.client;
  return c && !c.disposed ? c : null;
}

/** Which position the background stage is in right now (the legacy single stage has no back, so it is front); pushing a project must pick the baseline by it */
export function backRole(): StageRole {
  const b = slots.back.client;
  return b && !b.disposed ? "back" : "front";
}

/** The background stage; the legacy single stage has none, so fall back to the visible stage */
export function backStage(): StageRpcClient | null {
  const b = slots.back.client;
  if (b && !b.disposed) return b;
  return frontStage();
}

/**
 * Wait until this position has a stage client (E1). **A replaced client means a new Promise** --
 * a caller holding the old Promise still gets the old client and does not jump to the new iframe
 * out of nowhere; a call made afterwards gets the new client. R4's `ProbeGate` relies on it to know
 * that the background stage is ready.
 *
 * It waits only for "there is a client", not for "the role has been set": the role is sent by Preview
 * right after the handshake, and each queued job (stageJobs) sends a `setRole` itself before it
 * starts.
 */
export function whenStageReady(role: StageRole): Promise<StageRpcClient> {
  return slots[role].ready.promise;
}

/**
 * The host capability table that the stage at this position reported in its handshake (J4).
 *
 * K1's `device` string needs `compact` / `offscreenGl`, and they must match what was detected on
 * **the stage side** -- the offline probe takes exactly this copy from the stage's `pc-stage-ready`.
 * If the main document probed again itself, that would be a second implementation and would quietly
 * drift (for example, the main document and the iframe report different `deviceMemory`).
 * Before the handshake it returns `null`, and callers fall back to conservative values.
 */
export function stageCapabilities(role: StageRole): HostCapabilities | null {
  return slots[role].caps ?? slots.front.caps;
}

/**
 * K5's role swap: the clients at the two positions are exchanged, and **the baseline follows the
 * client** (see `pushedBy` above). After the swap the caller must push `syncProject` once more to the
 * new `front` -- what it holds is the copy from when the catch-up run started, and the edits made
 * during the run are applied incrementally (`swapAndDress` in `stageSwap.ts`).
 */
export function swapStageClients(
  front: { client: StageRpcClient | null; caps?: HostCapabilities | null },
  back: { client: StageRpcClient | null; caps?: HostCapabilities | null },
): void {
  // Detach both first, then register: one client is never attached at two positions at the same moment (the event filter judges by "the client at the position")
  setStageClient("front", null);
  setStageClient("back", null);
  setStageClient("front", front.client, front.caps ?? null);
  setStageClient("back", back.client, back.caps ?? null);
}

/**
 * The part shared by the two push entry points: serialization + baseline upkeep, both attached to the
 * client at this position **at the moment of initiation**. Once delivered, it is recorded on that
 * client, no matter which position it is moved to afterwards.
 */
function send(role: StageRole, project: Project, force: boolean): Promise<void> {
  const targetRole = role === "back" && backRole() === "front" ? "front" : role;
  const client = slots[targetRole].client;
  if (!client || client.disposed) return Promise.resolve();
  const mine = pushedOf(client);
  const run = async () => {
    if (client.disposed) return;
    if (!force && mine.project === project) return;
    const patch = force ? null : changedClips(mine.project, project);
    if (patch && mine.project && isEmptyPatch(patch)) {
      mine.project = project;
      return;
    }
    if (!patch || patch.kind === "full") {
      if (beforeFullProjectPush) {
        try { await beforeFullProjectPush(project); } catch { /* Mirror failure must not block stage preview */ }
        if (client.disposed) return;
      }
      await client.setProject(project, { reset: true });
    } else {
      await client.setProject(patch);
    }
    mine.project = project;
  };
  const next = mine.chain.then(run, run);
  mine.chain = next.catch(() => {});
  return next;
}

/**
 * Sync the project to a stage. When it returns, the stage has received and applied it.
 * If the baseline is the same (the same object reference), nothing is sent.
 */
export function syncProject(role: StageRole, project: Project): Promise<void> {
  return send(role, project, false);
}

/**
 * Switch the project and update the baseline (E0 / E1). `reset: true` always reloads the whole copy
 * (used for the probe's shrunken project, K5's second-path whole-scene catch-up run, and D4's
 * page-side measurement); without `reset` it goes incremental, like `syncProject`.
 */
export function pushProject(role: StageRole, project: Project, opts: { reset?: boolean } = {}): Promise<void> {
  return send(role, project, !!opts.reset);
}

/** For tests / debugging: which stage was pushed which project */
export function pushedProject(role: StageRole): Project | null {
  const targetRole = role === "back" && backRole() === "front" ? "front" : role;
  const client = slots[targetRole].client;
  return client ? pushedBy.get(client)?.project ?? null : null;
}

/**
 * Directly record the baseline of the client at a position as this project. **Use only when you know
 * for sure that the stage holds exactly this copy.**
 * K5's swap **no longer** uses it (root cause A: on swap the new `front` holds the copy from when the
 * catch-up run started, not the latest project right now); it goes through `swapStageClients`
 * instead -- the baseline follows the client anyway.
 */
export function markPushed(role: StageRole, project: Project | null): void {
  const targetRole = role === "back" && backRole() === "front" ? "front" : role;
  const client = slots[targetRole].client;
  if (client) pushedOf(client).project = project;
}

/** For tests: restore the registry to its just-loaded state */
export function resetStageBridge(): void {
  for (const role of ["front", "back"] as StageRole[]) {
    slots[role].off?.();
    slots[role] = newSlot();
  }
  pushedBy = new WeakMap();
  eventListeners.clear();
  beforeFullProjectPush = null;
}
