/**
 * Queue ordering in multi-project mode (semantics `docs/semantics/product/rendering.md` "Two Modes
 * of Render Service": multi-project mode; mechanism `docs/semantics/mechanism/rendering.md`
 * "Implementation of Multi-Project Mode").
 *
 * Each request only records "which project, which class, when it arrived", queued into the same
 * queue, with three rules for dequeuing order:
 *
 *   1. **Viewing frames precedes stream production**: All requests in `look` class are ordered
 *      ahead of `stream` class (class priority is defined by `classes`, default `['look', 'stream']`);
 *   2. **Projects rotate within the same class**: Dequeued by rotating across projects within the
 *      same class: the project in this class that has gone the longest without a turn goes first
 *      (those never served go by arrival order of their head request), and once a project serves a
 *      request it moves to the end of this class;
 *   3. **First-come first-served within the same project**: Requests within the same class and project
 *      follow arrival order (`seq`).
 *
 * No project is allowed to monopolize: rotation is counted by "one request", not by "a period of
 * time" or "a round of chat", so as long as other projects have requests queued, the next goes to them.
 *
 * This file only governs ordering; it does not know worker processes or send requests. Used in
 * three places:
 *   - Viewing frame requests in host render service (`server/hosted-render/look.mjs`, `look` class);
 *   - Which project an isolated worker process in host render service should mount
 *     (`server/hosted-render/isolation.mjs`: `look` class demands first, followed by `stream`
 *     class projects);
 *   - Order of task claims across projects on standalone render hosts
 *     (`server/render-node/host.mjs`, `stream` class).
 *
 * Pure JS, only uses built-in objects; `seq` is provided by caller (registration order); if
 * omitted, assigned automatically by insertion order.
 */

/** Default class priority: viewing frames precedes stream production */
export const MULTI_QUEUE_CLASSES = Object.freeze(['look', 'stream']);

/**
 * Rotation bookkeeping: which turn each project in each class was last dequeued. Smaller numbers
 * mean longer without a turn; those never served have no record (ranked ahead of all previously
 * served).
 * Only counts turns, not timestamps: ordering is independent of clocks, no need to adjust time
 * in unit tests.
 */
export function createRotation() {
  /** kind → Map(projectId → turn count) */
  const served = new Map();
  let tick = 0;
  return {
    /** This project just served a request in this class: move to the end of this class */
    served(kind, projectId) {
      if (!served.has(kind)) served.set(kind, new Map());
      tick += 1;
      served.get(kind).set(projectId, tick);
      return tick;
    },
    /** Which turn this project was last dequeued in this class; returns null if none */
    lastServed(kind, projectId) { return served.get(kind)?.get(projectId) ?? null; },
    /** Project is gone (detached, deleted): clear its bookkeeping */
    forget(projectId) { for (const m of served.values()) m.delete(projectId); },
    /** For diagnostics: `{ kind: { projectId: n } }` */
    snapshot() {
      const out = {};
      for (const [kind, m] of served) out[kind] = Object.fromEntries(m);
      return out;
    },
  };
}

/**
 * Determines dequeuing order according to the three rules (does not mutate arguments).
 * @template {{ projectId: string, kind?: string, seq: number }} T
 * @param {T[]} items Queued requests; `kind` not in `classes` are ordered after all classes
 * @param {{ lastServed(kind: string, projectId: string): number | null }} rotation
 * @param {readonly string[]} [classes]
 * @returns {T[]}
 */
export function orderByPolicy(items, rotation, classes = MULTI_QUEUE_CLASSES) {
  const classIndex = (kind) => { const i = classes.indexOf(kind); return i < 0 ? classes.length : i; };
  /** Class id → (project → requests of this project in this class, earlier arrivals first) */
  const byClass = new Map();
  for (const item of items ?? []) {
    if (!item || typeof item.projectId !== 'string') continue;
    const c = classIndex(item.kind);
    if (!byClass.has(c)) byClass.set(c, new Map());
    const projects = byClass.get(c);
    if (!projects.has(item.projectId)) projects.set(item.projectId, []);
    projects.get(item.projectId).push(item);
  }
  const out = [];
  for (const c of [...byClass.keys()].sort((a, b) => a - b)) {
    const kind = c < classes.length ? classes[c] : null;
    const projects = byClass.get(c);
    for (const list of projects.values()) list.sort((a, b) => a.seq - b.seq);
    // Rotation order in this class: longest without a turn goes first (never served goes earliest,
    // ordered among themselves by head request arrival)
    const turn = [...projects.entries()].map(([projectId, list]) => ({ projectId, list, last: kind === null ? null : rotation.lastServed(kind, projectId), head: list[0].seq }));
    turn.sort((a, b) => {
      if (a.last !== b.last) {
        if (a.last === null) return -1;
        if (b.last === null) return 1;
        return a.last - b.last;
      }
      if (a.head !== b.head) return a.head - b.head;
      return a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0;
    });
    // One per round: each project moves to the end after serving one, so the overall order interleaves
    // by round
    const depth = Math.max(...turn.map((t) => t.list.length));
    for (let r = 0; r < depth; r += 1) for (const t of turn) if (r < t.list.length) out.push(t.list[r]);
  }
  return out;
}

/**
 * A queue with bookkeeping: register, remove, view order, take next.
 * @param {object} [o]
 * @param {readonly string[]} [o.classes]
 */
export function createMultiQueue({ classes = MULTI_QUEUE_CLASSES } = {}) {
  const rotation = createRotation();
  /** id → { id, projectId, kind, seq, ... } */
  const items = new Map();
  let nextSeq = 1;
  return {
    rotation,
    /**
     * Registers a request. Re-registering the same `id` returns the original item. If `seq` is
     * omitted, it is assigned by registration order.
     * @param {{ id: string, projectId: string, kind: string, seq?: number }} item
     */
    add(item) {
      if (items.has(item.id)) return items.get(item.id);
      const seq = Number.isFinite(item.seq) ? item.seq : nextSeq;
      nextSeq = Math.max(nextSeq, seq + 1);
      const entry = { ...item, seq };
      items.set(item.id, entry);
      return entry;
    },
    remove(id) { return items.delete(id); },
    has(id) { return items.has(id); },
    get size() { return items.size; },
    /** Current dequeuing order (without taking items) */
    order() { return orderByPolicy([...items.values()], rotation, classes); },
    /**
     * Finds the first runnable item in order (`canRun` returns true); if found, takes it, records
     * bookkeeping (moving this project to the end of this class), and returns it; returns null if
     * none are runnable.
     * Earlier items that cannot run right now do not block later runnable items.
     */
    take(canRun = () => true) {
      for (const item of this.order()) {
        let ok = false;
        try { ok = canRun(item) === true; } catch { ok = false; }
        if (!ok) continue;
        items.delete(item.id);
        rotation.served(item.kind, item.projectId);
        return item;
      }
      return null;
    },
  };
}
