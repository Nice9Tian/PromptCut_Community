/**
 * Project path operations: compute diffs (diffProject) and apply them (applyOps).
 *
 * The spec is in docs/plan/c65-ops-spec.md, and the generic JSON engine in the document service
 * is implemented against the same page. Both sides must match item by item: the same sequence
 * of operations must produce byte-for-byte identical results on both sides (including key order).
 * To change semantics here, update that page first.
 *
 * Pure function, deterministic, unaware of the project's business structure: only recognizes
 * the single generic rule of "arrays with ids".
 */

export type PathOp =
  | { op: "set"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "insert"; path: string; index: number; value: unknown }
  | { op: "move"; path: string; index: number };

export interface ProjectDiff {
  ops: PathOp[];
  /** Operations to turn next back into prev, used for undo */
  inverse: PathOp[];
}

export type ApplyResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "bad-path"; index: number; detail: string };

/** If a single diff exceeds this many operations, convert it into a single root replacement */
export const MAX_DIFF_OPS = 500;

type Obj = Record<string, unknown>;

function isPlainObject(v: unknown): v is Obj {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Array with ids: each element is a plain object with a unique non-empty string id. Empty arrays also count */
export function isIdArray(a: unknown): a is Obj[] {
  if (!Array.isArray(a)) return false;
  if (a.length === 0) return true;
  const seen = new Set<string>();
  for (const e of a) {
    if (!isPlainObject(e)) return false;
    const id = e.id;
    if (typeof id !== "string" || id === "" || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/* ---------------- Path encoding ---------------- */

export function escapeSegment(s: string): string {
  if (s.indexOf("~") < 0 && s.indexOf("/") < 0) return s;
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapeSegment(s: string): string {
  return s.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function keyPath(base: string, key: string): string {
  return `${base}/${escapeSegment(key)}`;
}

export function idPath(base: string, id: string): string {
  return `${base}/@${escapeSegment(id)}`;
}

/** Splits path into decoded segments; "" is the root, returning []. Invalid format (does not start with /, or ~ is not followed by 0 or 1) returns null */
export function parsePath(path: string): string[] | null {
  if (path === "") return [];
  if (typeof path !== "string" || path[0] !== "/") return null;
  if (/~[^01]|~$/.test(path)) return null;
  const segs = path.slice(1).split("/").map(unescapeSegment);
  // A segment with only @ is invalid (rejected even on an object), matching the document service engine
  if (segs.some((seg) => seg === "@")) return null;
  return segs;
}

/* ---------------- Deep equality ---------------- */

/** Structural equality (objects ignore key order; undefined keys treated as nonexistent) */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Obj;
  const bo = b as Obj;
  let na = 0;
  for (const k in ao) {
    if (!Object.prototype.hasOwnProperty.call(ao, k) || ao[k] === undefined) continue;
    na++;
    if (!Object.prototype.hasOwnProperty.call(bo, k) || !deepEqual(ao[k], bo[k])) return false;
  }
  let nb = 0;
  for (const k in bo) {
    if (Object.prototype.hasOwnProperty.call(bo, k) && bo[k] !== undefined) nb++;
  }
  return na === nb;
}

/* ---------------- Diff ---------------- */

class TooMany extends Error {}

interface DiffCtx {
  ops: PathOp[];
  /** Corresponds 1:1 with ops, each reverses the state after it to before it; finally reversed as a whole */
  inv: PathOp[];
  limit: number;
}

function push(ctx: DiffCtx, op: PathOp, inv: PathOp) {
  ctx.ops.push(op);
  ctx.inv.push(inv);
  if (ctx.ops.length > ctx.limit) throw new TooMany();
}

const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

/** Set key. `__proto__` uses defineProperty to avoid modifying the prototype */
function setKey(o: Obj, k: string, v: unknown) {
  if (k === "__proto__") Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
}

function diffValue(prev: unknown, next: unknown, path: string, ctx: DiffCtx) {
  if (prev === next) return;
  if (isPlainObject(prev) && isPlainObject(next)) {
    diffObject(prev, next, path, ctx);
    return;
  }
  if (Array.isArray(prev) && Array.isArray(next) && isIdArray(prev) && isIdArray(next)) {
    diffIdArray(prev, next, path, ctx);
    return;
  }
  if (deepEqual(prev, next)) return;
  push(ctx, { op: "set", path, value: next }, { op: "set", path, value: prev });
}

function diffObject(prev: Obj, next: Obj, path: string, ctx: DiffCtx) {
  for (const k in prev) {
    if (!has(prev, k)) continue;
    if (!has(next, k)) {
      const p = keyPath(path, k);
      push(ctx, { op: "remove", path: p }, { op: "set", path: p, value: prev[k] });
    }
  }
  for (const k in next) {
    if (!has(next, k)) continue;
    const b = next[k];
    if (!has(prev, k)) {
      const p = keyPath(path, k);
      push(ctx, { op: "set", path: p, value: b }, { op: "remove", path: p });
      continue;
    }
    const a = prev[k];
    // Keys with identical values (including same object) skip path building: this is the bulk in
    // deep-copied large projects
    if (a === b) continue;
    diffValue(a, b, keyPath(path, k), ctx);
  }
}

/** Longest increasing subsequence; returns the set of selected indices (indices refer to positions in seq) */
function lisIndices(seq: number[]): Set<number> {
  const tails: number[] = []; // tails[len-1] = index ending with it
  const prevIdx = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prevIdx[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Set<number>();
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) {
    out.add(k);
    k = prevIdx[k];
  }
  return out;
}

function diffIdArray(prev: Obj[], next: Obj[], path: string, ctx: DiffCtx) {
  const nextIndex = new Map<string, number>();
  for (let i = 0; i < next.length; i++) nextIndex.set(next[i].id as string, i);
  const prevById = new Map<string, Obj>();
  for (const e of prev) prevById.set(e.id as string, e);

  // 1. Delete removed elements (back-to-front; the recorded index is its position before deletion)
  const work: string[] = prev.map((e) => e.id as string);
  for (let i = work.length - 1; i >= 0; i--) {
    const id = work[i];
    if (nextIndex.has(id)) continue;
    const p = idPath(path, id);
    push(ctx, { op: "remove", path: p }, { op: "insert", path, index: i, value: prevById.get(id) });
    work.splice(i, 1);
  }

  // 2. Ordering: move old elements not in the longest order-preserving subsequence once,
  //    insert new elements once, in next's order
  const targets = work.map((id) => nextIndex.get(id)!);
  const keepPos = lisIndices(targets);
  const stable = new Set<string>();
  for (const pos of keepPos) stable.add(work[pos]);
  if (!(stable.size === work.length && work.length === next.length)) {
    for (let t = 0; t < next.length; t++) {
      const id = next[t].id as string;
      if (stable.has(id)) continue;
      const at = t === 0 ? 0 : work.indexOf(next[t - 1].id as string) + 1;
      if (prevById.has(id)) {
        const from = work.indexOf(id);
        work.splice(from, 1);
        const to = from < at ? at - 1 : at;
        work.splice(to, 0, id);
        if (to !== from) {
          const p = idPath(path, id);
          push(ctx, { op: "move", path: p, index: to }, { op: "move", path: p, index: from });
        }
      } else {
        work.splice(at, 0, id);
        push(ctx, { op: "insert", path, index: at, value: next[t] }, { op: "remove", path: idPath(path, id) });
      }
      stable.add(id);
    }
  }

  // 3. Recurse element-by-element for elements present on both sides. Elements with different identities
  //    but identical content (almost all of them in a fully deep-copied project) are cheaply ruled out
  //    first with noOpsBetween, without building paths or indexing
  for (const e of next) {
    const id = e.id as string;
    const before = prevById.get(id);
    if (before !== undefined && before !== e && !noOpsBetween(before, e)) diffValue(before, e, idPath(path, id), ctx);
  }
}

/*
 * When noOpsBetween(prev, next) is true, diffValue(prev, next) is guaranteed to yield zero operations.
 * It follows the branch checks of diffValue / diffObject / diffIdArray, but without building paths or
 * recording operations, returning false at the first place that would produce an operation. Any
 * uncertain case returns false (leaving diffValue to compute normally), so skipping with it only avoids
 * useless work and never changes the output.
 */
function noOpsBetween(prev: unknown, next: unknown): boolean {
  if (prev === next) return true;
  // Not both objects: diffValue falls back to deepEqual; when they are not ===, deepEqual is definitely false
  if (typeof prev !== "object" || typeof next !== "object" || prev === null || next === null) return false;
  // One is an array and the other is not: diffValue falls back to deepEqual, which is guaranteed to be false
  if (Array.isArray(prev)) return Array.isArray(next) && noOpsArray(prev, next);
  if (Array.isArray(next)) return false;
  if (isPlainObject(prev) && isPlainObject(next)) return noOpsObject(prev, next);
  // Otherwise (at least one side is a non-plain object): diffValue checks with deepEqual
  return deepEqual(prev, next);
}

/** Corresponds 1:1 with the two loops in diffObject: the first emits remove, the second emits set or recurses */
function noOpsObject(prev: Obj, next: Obj): boolean {
  // Fast path: own enumerable keys on both sides match order-for-order (deep copies and { ...o, k: v }
  // both preserve key order). Here has(o, k) is simply o[k] !== undefined, combining two loops into
  // one and avoiding key-by-key hasOwnProperty on the other object (checking keys on other objects in
  // for-in is the main bottleneck here)
  const ka = Object.keys(prev);
  const kb = Object.keys(next);
  let sameKeys = ka.length === kb.length;
  for (let i = 0; sameKeys && i < ka.length; i++) if (ka[i] !== kb[i]) sameKeys = false;
  if (sameKeys) {
    for (let i = 0; i < ka.length; i++) {
      const k = ka[i];
      const a = prev[k];
      const b = next[k];
      if (a === b) continue;
      if (a === undefined || b === undefined) return false; // Present on one side but not the other: remove or set
      if (!noOpsBetween(a, b)) return false;
    }
    return true;
  }
  // Different keys or different key order: run both passes as in diffObject
  for (const k in prev) {
    if (has(prev, k) && !has(next, k)) return false;
  }
  for (const k in next) {
    if (!has(next, k)) continue;
    if (!has(prev, k)) return false;
    const a = prev[k];
    const b = next[k];
    if (a !== b && !noOpsBetween(a, b)) return false;
  }
  return true;
}

function noOpsArray(prev: unknown[], next: unknown[]): boolean {
  // Different lengths: when both sides are arrays with ids, insert / remove is guaranteed;
  // otherwise deepEqual is false
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    // Not all elements in prev are plain objects with non-empty string ids: prev is not an array
    // with ids, diffValue checks with deepEqual
    if (!isPlainObject(a) || typeof a.id !== "string" || a.id === "") return deepEqual(prev, next);
    // Only when ids on both sides match element-by-element can there be no operations; differing
    // cases (reordered, changed elements, next is not an array with ids) are left to diffValue
    const b = next[i];
    if (!isPlainObject(b) || b.id !== a.id) return false;
  }
  // If both sides are arrays with ids: with identical id order, diffIdArray does not delete, move, or
  // insert, only recursing element by element. Compare one by one first (returns false if any produces
  // operations: returning false is always safe); if none produce operations, verify ids are unique
  for (let i = 0; i < next.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a !== b && !noOpsBetween(a, b)) return false;
  }
  // Duplicate ids: neither side is an array with ids, diffValue checks with deepEqual
  return isIdArray(prev) || deepEqual(prev, next);
}

/**
 * Computes path operations and inverse operations for prev → next. Deterministic: identical
 * inputs always produce identical outputs. Degenerates into a single root replacement when
 * exceeding MAX_DIFF_OPS operations in a single diff.
 */
export function diffProject<T>(prev: T, next: T, opts: { limit?: number } = {}): ProjectDiff {
  const limit = opts.limit ?? MAX_DIFF_OPS;
  const ctx: DiffCtx = { ops: [], inv: [], limit };
  try {
    diffValue(prev, next, "", ctx);
  } catch (e) {
    if (!(e instanceof TooMany)) throw e;
    return {
      ops: [{ op: "set", path: "", value: next }],
      inverse: [{ op: "set", path: "", value: prev }],
    };
  }
  return { ops: ctx.ops, inverse: ctx.inv.reverse() };
}

/* ---------------- Apply ---------------- */

class BadPath extends Error {}

function fail(detail: string): never {
  throw new BadPath(detail);
}

/**
 * Copy-on-write: nodes newly created within the same applyOps call are tracked in owned and can
 * subsequently be modified in place; untouched subtrees are shared with the original object,
 * and the original object is never mutated.
 */
class Cow {
  owned = new Set<object>();
  own<T extends object>(node: T): T {
    if (this.owned.has(node)) return node;
    const copy = (Array.isArray(node) ? node.slice() : { ...node }) as T;
    this.owned.add(copy);
    return copy;
  }
}

function findById(arr: unknown[], id: string): number {
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (isPlainObject(e) && e.id === id) return i;
  }
  return -1;
}

function arrayIdOf(seg: string): string {
  if (seg[0] !== "@" || seg.length < 2) fail(`Array segment must be @<id>:${seg}`);
  return seg.slice(1);
}

/**
 * Walks from root to the parent of the node referenced by segs, copying along the way,
 * returning the mutable parent node and the last segment.
 * createMissing: missing keys on objects are created as {} (only used by set).
 */
function walkToParent(root: unknown, segs: string[], cow: Cow, createMissing: boolean): { root: unknown; parent: unknown; last: string } {
  if (root === null || typeof root !== "object") fail("Root is not an object");
  const newRoot = cow.own(root as object);
  let node: unknown = newRoot;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (Array.isArray(node)) {
      const idx = findById(node, arrayIdOf(seg));
      if (idx < 0) fail(`Element not found: ${seg}`);
      const child = node[idx];
      if (child === null || typeof child !== "object") fail(`Intermediate value is not an object: ${seg}`);
      const copy = cow.own(child as object);
      node[idx] = copy;
      node = copy;
    } else if (isPlainObject(node)) {
      let child = has(node, seg) ? node[seg] : undefined;
      if (child === undefined) {
        if (!createMissing) fail(`Path does not exist: ${seg}`);
        child = {};
        cow.owned.add(child as object);
        setKey(node, seg, child);
        node = child;
        continue;
      }
      if (child === null || typeof child !== "object") fail(`Intermediate value is not an object: ${seg}`);
      const copy = cow.own(child as object);
      setKey(node, seg, copy);
      node = copy;
    } else {
      fail(`Intermediate value is not an object: ${seg}`);
    }
  }
  return { root: newRoot, parent: node, last: segs[segs.length - 1] };
}

function validIndex(i: unknown): i is number {
  return typeof i === "number" && Number.isSafeInteger(i) && i >= 0;
}

/**
 * Walks read-only to parent (without copying), following the same rules as
 * walkToParent(createMissing = false): returns bad-path if unreachable.
 * remove / move uses it first to check whether the target exists: if absent, it is a no-op,
 * returning the original object as-is without wastefully copying along the way.
 */
function peekParent(root: unknown, segs: string[]): unknown {
  if (root === null || typeof root !== "object") fail("Root is not an object");
  let node: unknown = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (Array.isArray(node)) {
      const idx = findById(node, arrayIdOf(seg));
      if (idx < 0) fail(`Element not found: ${seg}`);
      node = node[idx];
    } else if (isPlainObject(node)) {
      if (!has(node, seg)) fail(`Path does not exist: ${seg}`);
      node = node[seg];
    } else fail(`Intermediate value is not an object: ${seg}`);
    if (node === null || typeof node !== "object") fail(`Intermediate value is not an object: ${seg}`);
  }
  return node;
}

/** Format of the operation itself (without inspecting document); returns reason if invalid */
function formatError(op: PathOp): string | null {
  if (!isPlainObject(op)) return "Each operation must be an object";
  if (op.op !== "set" && op.op !== "remove" && op.op !== "insert" && op.op !== "move") return `Unknown operation: ${String((op as { op?: unknown }).op)}`;
  const segs = typeof op.path === "string" ? parsePath(op.path) : null;
  if (!segs) return `Invalid path format: ${String(op.path)}`;
  switch (op.op) {
    case "set":
      if (!Object.prototype.hasOwnProperty.call(op, "value") || op.value === undefined) return "set is missing value";
      if (segs.length === 0 && !isPlainObject(op.value)) return "Value replacing the root must be an object";
      return null;
    case "remove":
      return segs.length === 0 ? "Cannot delete the root" : null;
    case "insert":
      if (!isPlainObject(op.value) || typeof op.value.id !== "string" || op.value.id === "") return "The value of insert must be an object with a non-empty string id";
      return validIndex(op.index) ? null : "index must be a non-negative integer";
    case "move":
      if (segs.length === 0 || segs[segs.length - 1][0] !== "@") return "move path must end with @<id>";
      return validIndex(op.index) ? null : "index must be a non-negative integer";
  }
}

function applyOne(root: unknown, op: PathOp, cow: Cow): unknown {
  if (!op || typeof op !== "object" || typeof (op as { path?: unknown }).path !== "string") fail("Operation is missing path");
  const segs = parsePath(op.path);
  if (!segs) fail(`Invalid path format: ${op.path}`);
  switch (op.op) {
    case "set": {
      if (!("value" in op) || op.value === undefined) fail("set is missing value");
      if (segs.length === 0) {
        if (!isPlainObject(op.value)) fail("Value replacing the root must be an object");
        return op.value;
      }
      // When no instance exists yet (root missing), build from {}
      const { root: r, parent, last } = walkToParent(root ?? {}, segs, cow, true);
      if (Array.isArray(parent)) {
        const id = arrayIdOf(last);
        const idx = findById(parent, id);
        if (idx < 0) fail(`Element not found: ${last}`);
        if (!isPlainObject(op.value) || op.value.id !== id) fail("When replacing an array element, value.id must equal the id in the path");
        parent[idx] = op.value;
      } else if (isPlainObject(parent)) {
        setKey(parent, last, op.value);
      } else fail("Parent is not an object");
      return r;
    }
    case "remove": {
      if (segs.length === 0) fail("Cannot delete the root");
      // Parent must exist; absent target is a no-op (two users delete the same clip simultaneously,
      // and the later batch lands normally)
      const last = segs[segs.length - 1];
      const peek = peekParent(root, segs);
      if (Array.isArray(peek)) {
        if (findById(peek, arrayIdOf(last)) < 0) return root;
      } else if (isPlainObject(peek)) {
        if (!has(peek, last)) return root;
      } else fail("Parent is not an object");
      const { root: r, parent } = walkToParent(root, segs, cow, false);
      if (Array.isArray(parent)) parent.splice(findById(parent, arrayIdOf(last)), 1);
      else delete (parent as Obj)[last];
      return r;
    }
    case "insert": {
      if (!validIndex(op.index)) fail("index must be a non-negative integer");
      const v = op.value;
      if (!isPlainObject(v) || typeof v.id !== "string" || v.id === "") fail("The value of insert must be an object with a non-empty string id");
      // Target is array itself (arrays are always attached to some key on an object): walk to its parent,
      // then copy out the array as well
      if (segs.length === 0) fail("Root is not an array");
      const { root: r, parent, last } = walkToParent(root, segs, cow, false);
      if (!isPlainObject(parent)) fail("The target of insert is not an array");
      const cur = has(parent, last) ? parent[last] : undefined;
      if (!Array.isArray(cur) || !isIdArray(cur)) fail("The target of insert is not an array with ids");
      if (findById(cur, v.id as string) >= 0) fail(`id already exists: ${v.id}`);
      const a = cow.own(cur);
      setKey(parent, last, a);
      a.splice(Math.min(op.index, a.length), 0, v);
      return r;
    }
    case "move": {
      if (!validIndex(op.index)) fail("index must be a non-negative integer");
      if (segs.length === 0) fail("Cannot move the root");
      const last = segs[segs.length - 1];
      const id = arrayIdOf(last);
      // Containing array must exist; absent element is a no-op
      const peek = peekParent(root, segs);
      if (!Array.isArray(peek)) fail("The target of move is not in the array");
      if (findById(peek, id) < 0) return root;
      const { root: r, parent } = walkToParent(root, segs, cow, false);
      const arr = parent as unknown[];
      const [el] = arr.splice(findById(arr, id), 1);
      arr.splice(Math.min(op.index, arr.length), 0, el);
      return r;
    }
    default:
      fail(`Unknown operation: ${(op as { op?: unknown }).op}`);
  }
}

/**
 * Applies a sequence of path operations in order. Atomic: if any operation fails, returns
 * bad-path and leaves the original object unchanged. Untouched subtrees are shared with input
 * (no deep copy), so input must be treated as an immutable object.
 */
export function applyOps<T>(doc: T, ops: readonly PathOp[]): ApplyResult<T> {
  if (!Array.isArray(ops)) return { ok: false, code: "bad-path", index: -1, detail: "ops must be an array" };
  // Check format for entire batch first (independent of document), then apply operation by
  // operation: like the document service engine, failure index reports format error first
  for (let i = 0; i < ops.length; i++) {
    const err = formatError(ops[i]);
    if (err) return { ok: false, code: "bad-path", index: i, detail: err };
  }
  const cow = new Cow();
  let cur: unknown = doc;
  for (let i = 0; i < ops.length; i++) {
    try {
      cur = applyOne(cur, ops[i], cow);
    } catch (e) {
      if (e instanceof BadPath) return { ok: false, code: "bad-path", index: i, detail: e.message };
      throw e;
    }
  }
  return { ok: true, value: cur as T };
}

/** Retrieves value at path; returns undefined if not found */
export function getAt(doc: unknown, path: string): unknown {
  const segs = parsePath(path);
  if (!segs) return undefined;
  let node: unknown = doc;
  for (const seg of segs) {
    if (Array.isArray(node)) {
      if (seg[0] !== "@") return undefined;
      const idx = findById(node, seg.slice(1));
      if (idx < 0) return undefined;
      node = node[idx];
    } else if (isPlainObject(node)) {
      if (!has(node, seg)) return undefined;
      node = node[seg];
    } else return undefined;
  }
  return node;
}

/* ---------------- Entity ---------------- */

/** Nested entities only recognize these collection names (first level unrestricted): clips in tracks, tracks and transitions in cuts */
const NESTED_ENTITY = new Set(["tracks", "clips", "transitions"]);

/** All entities */
export const ALL_ENTITIES = "*";
/**
 * Paths without any `/<name>/@<id>` pair count as one entity `/meta/<top-level-key>` per top-level
 * key (`/fps` → `/meta/fps`, `/style/x` → `/meta/style`). Integration ruling, 2026-09-26: someone else
 * changing fps should not prevent me from undoing my own changes to name.
 */
export const META_ENTITY = "/meta";

/** Which entity a path belongs to (spec section 4) */
export function entityOfPath(path: string): string {
  if (path === "") return ALL_ENTITIES;
  const segs = parsePath(path);
  if (!segs || segs.length === 0) return ALL_ENTITIES;
  let end = 0;
  // Name segment cannot start with @ (document service engine treats segments starting with @ as id
  // segments); names after first pair only recognize NESTED_ENTITY
  while (
    end + 1 < segs.length &&
    segs[end][0] !== "@" &&
    segs[end + 1][0] === "@" &&
    (end === 0 || NESTED_ENTITY.has(segs[end]))
  ) end += 2;
  if (end === 0) return `${META_ENTITY}/${escapeSegment(segs[0])}`;
  return "/" + segs.slice(0, end).map(escapeSegment).join("/");
}

/**
 * Entity → path of its value in the project (used to retrieve values for overlay backup):
 * `*` is root `""`; `/meta/<key>` is `/<key>`; other entities are paths themselves.
 */
export function entityValuePath(entity: string): string {
  if (entity === ALL_ENTITIES) return "";
  const prefix = `${META_ENTITY}/`;
  if (entity.startsWith(prefix) && entity.indexOf("/", prefix.length) < 0) return "/" + entity.slice(prefix.length);
  return entity;
}

/** Entity written by an operation (insert counts as the inserted element) */
export function entityOfOp(op: PathOp): string {
  if (op.op === "insert" && isPlainObject(op.value) && typeof op.value.id === "string") {
    return entityOfPath(idPath(op.path, op.value.id));
  }
  return entityOfPath(op.path);
}

/** Entities written by a sequence of operations, deduplicated by order of first appearance */
export function entitiesOf(ops: readonly PathOp[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const op of ops) {
    const e = entityOfOp(op);
    if (!seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

/** Whether two entities count as writing to the same location */
export function entitiesOverlap(a: string, b: string): boolean {
  return a === b || a === ALL_ENTITIES || b === ALL_ENTITIES;
}
