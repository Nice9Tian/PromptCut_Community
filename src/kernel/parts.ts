import type { ClipFrame, Control, PartInstance } from "./types";
import type { PartDef } from "./partTypes";
import { frameBox, resolveFrame, type Box, type Size } from "./layout.ts";

/**
 * Part instance tree for composite cards: pure functions, does not touch the store.
 *
 *   - Add, delete, edit, and move all return a **new tree** (original tree unchanged); the store
 *     saves it directly;
 *   - Validation and writing are separate: validatePartTree inspects the entire tree first; if any
 *     part is invalid, the tree is not written;
 *   - World coordinates are composed level-by-level from parent boxes (partWorldBox), **storing
 *     only local boxes**, following the same principle as card-level frames;
 *   - Timing (partsTiming) is calculated from each instance's enterMs + the part's own settleMs,
 *     for envelope and code page display.
 *
 * The parts registry is passed in by the caller (lookup) for unit testing in Node without React.
 */

export type PartLookup = (id: string) => PartDef<any> | undefined;

export function newPartInstanceId(): string {
  return "p" + Math.random().toString(36).slice(2, 8);
}

/** Find an instance in the tree, along with its parent array and index (needed for add/delete/move) */
export function findPart(tree: PartInstance[], id: string): { node: PartInstance; parent: PartInstance[]; index: number; parentId: string | null } | null {
  const walk = (list: PartInstance[], parentId: string | null): ReturnType<typeof findPart> => {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.id === id) return { node: n, parent: list, index: i, parentId };
      if (n.children?.length) {
        const hit = walk(n.children, n.id);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(tree, null);
}

export function flattenParts(tree: PartInstance[]): PartInstance[] {
  const out: PartInstance[] = [];
  const walk = (list: PartInstance[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/* ---------------- Validation ---------------- */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/**
 * Allowed keys for a part's frame.
 *
 * **Deliberately excludes rotateX / rotateY / translateZ**: part-level 3D cannot be handled by
 * rendering right now; allowing them grants a fake capability. CSS `perspective` only affects
 * direct children; the chain is `AnimClock(perspective) → card div → part div`. Passing it down
 * to the part layer relies on the card div's preserve-3d, which is only written when the **card's
 * own frame** is 3D. Measured bounding box height for a part with rotateY(40°):
 *   card div without preserve-3d (normal when card is 2D) 300.00: pure affine skew, no foreshortening
 *   card div with preserve-3d                             336.44: true perspective
 * And even if the card is placed in space, if this card has fade in/out / emphasis, Stage writes
 * opacity / filter onto the same div, resetting perspective to zero (measured returning to 300.00).
 *
 * Three situations yield three results, for the same reason the media layer is rejected by
 * reject3dOnMedia: better to fail immediately than let the Agent think it worked. If 3D is needed,
 * position the entire card (3D parameters of set_position). The clip-level list in
 * kernel/envelope.ts **includes** 3D; rendering at that level is correct.
 */
const FRAME_KEYS = new Set(["x", "y", "w", "h", "anchor", "scale", "rotate"]);
const PART_3D_KEYS = ["rotateX", "rotateY", "translateZ"];

/**
 * Maximum instances per tree. MCP passes arbitrary JSON; without a limit, tens of thousands of
 * nodes could be inserted at once.
 */
export const MAX_PART_NODES = 200;

export function validatePartFrame(raw: unknown, where: string): ClipFrame | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (!isObj(raw)) throw new Error(`frame of ${where} must be an object or null (null = fill the parent frame)`);
  for (const k of Object.keys(raw)) {
    if (FRAME_KEYS.has(k)) continue;
    if (PART_3D_KEYS.includes(k)) {
      throw new Error(
        `frame of ${where} does not support ${k} yet: 3D can only be applied to the whole card (rotateX / rotateY / translateZ of set_position),` +
        `the part layer has no perspective, so setting it only gives an affine skew, and if the card has a fade in/out or emphasis, even the skew will look different.` +
        ` To make this part 3D, make it a separate card and position that.`,
      );
    }
    throw new Error(`frame of ${where} does not recognize "${k}", only x / y / w / h / anchor / scale / rotate`);
  }
  if (!isNum(raw.x) || !isNum(raw.y)) throw new Error(`frame.x / frame.y of ${where} must be numbers (the anchor position within the parent frame)`);
  for (const k of ["w", "h", "scale", "rotate"] as const) if (raw[k] !== undefined && !isNum(raw[k])) throw new Error(`frame.${k} of ${where} must be a number`);
  for (const k of ["w", "h", "scale"] as const) if (raw[k] !== undefined && (raw[k] as number) <= 0) throw new Error(`frame.${k} of ${where} must be greater than 0`);
  if (raw.anchor !== undefined) {
    const a = raw.anchor;
    if (!Array.isArray(a) || a.length !== 2 || !isNum(a[0]) || !isNum(a[1])) throw new Error(`frame.anchor of ${where} must be two numbers [ax, ay], 0~1`);
  }
  // Reconstruct object: fixed key order without extra fields, so write-back comparisons won't treat
  // different key ordering as a mutation
  const f = raw as Record<string, unknown>;
  return {
    x: f.x as number,
    y: f.y as number,
    ...(f.w !== undefined ? { w: f.w as number } : {}),
    ...(f.h !== undefined ? { h: f.h as number } : {}),
    ...(f.anchor !== undefined ? { anchor: [(f.anchor as number[])[0], (f.anchor as number[])[1]] as [number, number] } : {}),
    ...(f.scale !== undefined ? { scale: f.scale as number } : {}),
    ...(f.rotate !== undefined ? { rotate: f.rotate as number } : {}),
    // This is **explicit reconstruction**: whatever is allowed above must be kept here, otherwise
    // "validation passes, value silently dropped" occurs. The three 3D items were rejected above, so
    // they shouldn't be here either: viewing both places together makes this clear.
  };
}

function describeControl(c: Control): string {
  const bits = [`${c.key}(${c.label},${c.type}`];
  if (c.type === "select") bits.push(`values ${c.options.map((o) => o.value).join("/")}`);
  if (c.required) bits.push("required");
  return bits.join(",") + ")";
}

/**
 * Part parameters: key must exist, select must be in options, number must be numeric, required
 * cannot be empty. Returns full parameters merged with defaults.
 */
export function validatePartParams(def: PartDef<any>, patch: Record<string, unknown> | undefined, existing?: Record<string, unknown>): Record<string, unknown> {
  const known = new Map(def.controls.map((c) => [c.key, c]));
  const problems: string[] = [];
  for (const [key, value] of Object.entries(patch || {})) {
    const control = known.get(key);
    if (!control) {
      problems.push(`Parameter "${key}" is not a parameter of part ${def.id}. It accepts: ${def.controls.map(describeControl).join(", ")}`);
      continue;
    }
    if (control.type === "number" && typeof value !== "number") problems.push(`Parameter "${key}" needs a number, got ${JSON.stringify(value)}`);
    if (control.type === "select" && !control.options.some((o) => o.value === value)) problems.push(`Parameter "${key}" can only be ${control.options.map((o) => o.value).join(" / ")}, got ${JSON.stringify(value)}`);
  }
  const merged = { ...def.defaults, ...(existing || {}), ...(patch || {}) };
  for (const c of def.controls) {
    const v = merged[c.key];
    const filled = v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
    if (c.required && !filled) problems.push(`"${c.key}" (${c.label}) of part ${def.id} is required and cannot be empty. ${c.hint ?? ""}`);
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return merged;
}

/**
 * Entire tree: unique instance ids, partId exists, valid params, valid frame, non-negative enterMs,
 * and nesting depth at most 4 levels.
 */
export function validatePartTree(tree: unknown, lookup: PartLookup): PartInstance[] {
  if (!Array.isArray(tree)) throw new Error("parts must be an array");
  const ids = new Set<string>();
  let count = 0;
  const walk = (list: unknown[], depth: number, path: string): PartInstance[] =>
    list.map((raw, i) => {
      const where = `${path}[${i}]`;
      if (!isObj(raw)) throw new Error(`${where} must be an object { id, partId, params, frame?, enterMs?, children? }`);
      if (++count > MAX_PART_NODES) throw new Error(`A part tree can have at most ${MAX_PART_NODES} instances`);
      const id = raw.id;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error(`${where}.id must be a short string (letters, digits, - _)`);
      if (ids.has(id)) throw new Error(`Duplicate part instance id "${id}"`);
      ids.add(id);
      if (typeof raw.partId !== "string") throw new Error(`${where}.partId must be a part id (from list_parts)`);
      const def = lookup(raw.partId);
      if (!def) throw new Error(`No part with id "${raw.partId}", see list_parts for the available ones`);
      if (raw.params !== undefined && !isObj(raw.params)) throw new Error(`${where}.params must be an object`);
      const params = validatePartParams(def, raw.params as Record<string, unknown> | undefined);
      const frame = validatePartFrame(raw.frame, where);
      if (raw.enterMs !== undefined && (!isNum(raw.enterMs) || (raw.enterMs as number) < 0)) throw new Error(`${where}.enterMs must be a non-negative number of milliseconds`);
      if (raw.label !== undefined && typeof raw.label !== "string") throw new Error(`${where}.label must be a string`);
      if (depth >= 4 && Array.isArray(raw.children) && raw.children.length) throw new Error("A part tree can be nested at most 4 levels deep");
      if (raw.children !== undefined && !Array.isArray(raw.children)) throw new Error(`${where}.children must be an array`);
      const children = Array.isArray(raw.children) && raw.children.length ? walk(raw.children, depth + 1, `${where}.children`) : undefined;
      return {
        id,
        partId: raw.partId,
        params,
        ...(frame ? { frame } : {}),
        ...(isNum(raw.enterMs) && raw.enterMs > 0 ? { enterMs: raw.enterMs } : {}),
        ...(typeof raw.label === "string" && raw.label ? { label: raw.label } : {}),
        ...(children ? { children } : {}),
      };
    });
  return walk(tree, 0, "parts");
}

/* ---------------- Add, delete, edit, move (returns new tree) ---------------- */

function cloneTree(tree: PartInstance[]): PartInstance[] {
  return JSON.parse(JSON.stringify(tree));
}

export interface NewPartSpec {
  partId: string;
  params?: Record<string, unknown>;
  frame?: ClipFrame | null;
  enterMs?: number;
  label?: string;
  id?: string;
}

/**
 * Add an instance. Omitted parentId = add to root; omitted index = append to end; omitted frame =
 * part's defaultFrame.
 */
export function addPart(tree: PartInstance[], spec: NewPartSpec, lookup: PartLookup, at?: { parentId?: string | null; index?: number }): { tree: PartInstance[]; node: PartInstance } {
  const def = lookup(spec.partId);
  if (!def) throw new Error(`No part with id "${spec.partId}", see list_parts for the available ones`);
  const id = spec.id ?? newPartInstanceId();
  if (findPart(tree, id)) throw new Error(`Part instance id "${id}" already exists`);
  if (flattenParts(tree).length >= MAX_PART_NODES) throw new Error(`A part tree can have at most ${MAX_PART_NODES} instances`);
  const params = validatePartParams(def, spec.params);
  const frame = spec.frame === undefined ? (def.defaultFrame ? { ...def.defaultFrame } : undefined) : validatePartFrame(spec.frame, `part ${id}`);
  if (spec.enterMs !== undefined && (!isNum(spec.enterMs) || spec.enterMs < 0)) throw new Error("enterMs must be a non-negative number of milliseconds");
  const node: PartInstance = {
    id,
    partId: spec.partId,
    params,
    ...(frame ? { frame } : {}),
    ...(spec.enterMs ? { enterMs: spec.enterMs } : {}),
    ...(spec.label ? { label: spec.label } : {}),
  };
  const next = cloneTree(tree);
  let list = next;
  if (at?.parentId) {
    const hit = findPart(next, at.parentId);
    if (!hit) throw new Error(`Parent part ${at.parentId} not found`);
    hit.node.children ??= [];
    list = hit.node.children;
  }
  const index = at?.index === undefined ? list.length : Math.max(0, Math.min(list.length, at.index | 0));
  list.splice(index, 0, node);
  return { tree: next, node };
}

export function removePart(tree: PartInstance[], id: string): PartInstance[] {
  const next = cloneTree(tree);
  const hit = findPart(next, id);
  if (!hit) throw new Error(`Part instance ${id} not found`);
  hit.parent.splice(hit.index, 1);
  return next;
}

export interface PartPatch {
  params?: Record<string, unknown>;
  /** null = clear frame (fills parent box) */
  frame?: ClipFrame | null;
  enterMs?: number;
  label?: string;
}

/**
 * Update params / frame / timing. Params are sparsely merged; provided frame replaces entirely
 * (pass null to clear).
 */
export function updatePart(tree: PartInstance[], id: string, patch: PartPatch, lookup: PartLookup): { tree: PartInstance[]; node: PartInstance } {
  const next = cloneTree(tree);
  const hit = findPart(next, id);
  if (!hit) throw new Error(`Part instance ${id} not found`);
  const def = lookup(hit.node.partId);
  if (!def) throw new Error(`Part ${hit.node.partId} no longer exists`);
  if (patch.params !== undefined) {
    if (!isObj(patch.params)) throw new Error("params must be an object");
    hit.node.params = validatePartParams(def, patch.params, hit.node.params);
  }
  if (patch.frame !== undefined) {
    const f = validatePartFrame(patch.frame, `part ${id}`);
    if (f) hit.node.frame = f;
    else delete hit.node.frame;
  }
  if (patch.enterMs !== undefined) {
    if (!isNum(patch.enterMs) || patch.enterMs < 0) throw new Error("enterMs must be a non-negative number of milliseconds");
    if (patch.enterMs > 0) hit.node.enterMs = patch.enterMs;
    else delete hit.node.enterMs;
  }
  if (patch.label !== undefined) {
    if (patch.label) hit.node.label = String(patch.label);
    else delete hit.node.label;
  }
  return { tree: next, node: hit.node };
}

/** Move to another parent / position. parentId null = root; cannot move into its own subtree */
export function movePart(tree: PartInstance[], id: string, to: { parentId?: string | null; index?: number }): PartInstance[] {
  const next = cloneTree(tree);
  const hit = findPart(next, id);
  if (!hit) throw new Error(`Part instance ${id} not found`);
  if (to.parentId && (to.parentId === id || findPart(hit.node.children ?? [], to.parentId))) throw new Error("Cannot move a part into its own subtree");
  const [node] = hit.parent.splice(hit.index, 1);
  let list = next;
  if (to.parentId) {
    const p = findPart(next, to.parentId);
    if (!p) throw new Error(`Parent part ${to.parentId} not found`);
    p.node.children ??= [];
    list = p.node.children;
  }
  const index = to.index === undefined ? list.length : Math.max(0, Math.min(list.length, to.index | 0));
  list.splice(index, 0, node);
  return next;
}

/* ---------------- Coordinates and timing ---------------- */

export interface PartPlacement {
  /** Instance box rectangle in parent coordinate space (before scaling) */
  local: Box;
  /**
   * Absolute frame rectangle (composed level-by-level from parent boxes and scales; rotation
   * excluded, as documented).
   */
  world: Box;
  /** Cumulative scale */
  scale: number;
}

/**
 * Compose each instance's screen position level by level. parent is the composite card canvas
 * rectangle on screen (the clip's world box) and its cumulative scale. Each instance's box is
 * relative to its parent box (the root instance's parent box is the canvas); a child instance's
 * parent box is its parent instance's box.
 */
export function placeParts(tree: PartInstance[], canvas: { box: Box; scale: number }): Map<string, PartPlacement> {
  const out = new Map<string, PartPlacement>();
  const walk = (list: PartInstance[], parentBox: Box, parentScale: number) => {
    for (const n of list) {
      const size: Size = { width: parentBox.width / parentScale, height: parentBox.height / parentScale };
      const local = frameBox(n.frame, size);
      const f = resolveFrame(n.frame, size);
      const scale = parentScale * f.scale;
      const world: Box = {
        left: parentBox.left + local.left * parentScale,
        top: parentBox.top + local.top * parentScale,
        width: local.width * scale,
        height: local.height * scale,
      };
      // Scale around anchor: distribute the gain / loss from scaling across the anchor point
      if (f.scale !== 1) {
        const dw = local.width * parentScale * (f.scale - 1);
        const dh = local.height * parentScale * (f.scale - 1);
        world.left -= dw * f.anchor[0];
        world.top -= dh * f.anchor[1];
      }
      out.set(n.id, { local, world, scale });
      if (n.children?.length) walk(n.children, world, scale);
    }
  };
  walk(tree, canvas.box, canvas.scale);
  return out;
}

export interface PartTimingEntry {
  enterMs: number;
  settleMs: number;
  after: "hold" | "loop" | "evolve";
}

/** Each instance's entrance / settle (relative to clip start), plus whole-tree settle and "after" */
export function partsTiming(tree: PartInstance[], lookup: PartLookup): { settleMs: number; after: "hold" | "loop" | "evolve"; parts: Map<string, PartTimingEntry> } {
  const parts = new Map<string, PartTimingEntry>();
  let settleMs = 0;
  let after: "hold" | "loop" | "evolve" = "hold";
  const walk = (list: PartInstance[], base: number) => {
    for (const n of list) {
      const def = lookup(n.partId);
      const enter = base + (n.enterMs ?? 0);
      let own = 0;
      try { own = def?.settleMs ? def.settleMs({ ...def.defaults, ...n.params }) : 0; } catch { own = 0; }
      const settle = enter + (Number.isFinite(own) ? own : 0);
      const a = def?.after ?? "hold";
      parts.set(n.id, { enterMs: enter, settleMs: settle, after: a });
      settleMs = Math.max(settleMs, settle);
      if (a === "evolve" || (a === "loop" && after !== "evolve")) after = a;
      if (n.children?.length) walk(n.children, enter);
    }
  };
  walk(tree, 0);
  return { settleMs, after, parts };
}
