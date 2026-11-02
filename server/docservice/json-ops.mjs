/**
 * Generic JSON path operation engine (C6.5 design draft `docs/plan/c65-design.md` Section 2; exact
 * semantics in `docs/plan/c65-ops-spec.md` and report
 * `docs/archive/agent-reports/AGENT-c65-docservice.md`).
 *
 * The document service is a generic JSON distribution hub and knows no business structures: this
 * file only recognizes JSON objects, arrays, and scalars, plus the generic convention that "objects
 * with `id` in an array are addressed by `@<id>`". Uses only built-in language capabilities and
 * imports no other files.
 *
 * - Path: JSON Pointer (RFC 6901, `~0` = `~`, `~1` = `/`), empty string is the root. Elements in
 *   an array can only be addressed by `@<id>`; indices are not recognized.
 * - Four operations: `set`, `remove`, `insert`, `move` (see `applyOps`).
 * - Operations in a batch take effect atomically: `applyOps` works via copy-on-write, not modifying
 *   a single byte of the old root; if any one fails, the entire batch is invalidated and throws.
 * - Entity: `entityOf` maps a path to the longest prefix of paired `/<name>/@<id>` starting from
 *   the root (names after the first pair can be restricted to `names`); paths with zero pairs are
 *   mapped by top-level key to `<metaEntity>/<top-level key>` (e.g. `/meta/fps`); `entitiesOf`
 *   calculates the entities written by a batch of operations from the effects given by `applyOps`
 *   (`set` is calculated from the actual difference between old and new values). Which names can
 *   extend further is provided by the caller; this file knows no specific names.
 */

export const OP_NAMES = Object.freeze(['set', 'remove', 'insert', 'move']);

/**
 * Default entity criteria: when `names` is null, names after the first pair are unrestricted;
 * if no pairs can be matched, each top-level key counts as an entity `/meta/<top-level key>`
 * (`/fps` → `/meta/fps`, `/style/x` → `/meta/style`; integration ruling 2026-09-26: someone else
 * changing fps should not prevent me from reverting the name I changed); the root replacement path
 * `""` is recorded by `entityOf` as `*` (all entities).
 */
export const ENTITY_DEFAULTS = Object.freeze({ names: null, metaEntity: '/meta', rootEntity: '*' });

/**
 * Engine errors:
 * - `bad-op`: The format of the operation itself is invalid (operation name, path syntax, missing
 *   `value`, `index` is not a non-negative integer…), independent of document content;
 * - `bad-path`: Format is valid, but cannot be traversed against the current document (parent does
 *   not exist, index addressing, `insert` `id` already exists…).
 * `index` is the index of the failing operation in the batch (-1 when the entire `ops` is not an
 * array).
 */
export class OpError extends Error {
  constructor(code, index, detail) {
    super(detail);
    this.code = code;
    this.index = index;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isContainer = (v) => v !== null && typeof v === 'object';
const isIdValue = (v) => typeof v === 'string' && v !== '';
const isIndex = (v) => Number.isSafeInteger(v) && v >= 0;

// ---------------------------------------------------------------- Path

function unescapeToken(raw) {
  if (!raw.includes('~')) return raw;
  if (/~[^01]|~$/.test(raw)) return null;
  return raw.replace(/~1/g, '/').replace(/~0/g, '~');
}

const escapeToken = (text) => text.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Split path: empty string → []; otherwise must start with `/`. Each segment `{ text, id }`:
 * `text` is the unescaped key; for segments starting with `@`, `id` is the part with `@` removed
 * (used to find elements when falling on an array); otherwise `id` is null. When falling on an
 * object, segments starting with `@` are still treated as literal keys. Returns null if syntax is
 * invalid (including empty string after `@`).
 */
export function parsePath(path) {
  if (typeof path !== 'string') return null;
  if (path === '') return [];
  if (path[0] !== '/') return null;
  const out = [];
  for (const raw of path.slice(1).split('/')) {
    const text = unescapeToken(raw);
    if (text === null) return null;
    const id = text.startsWith('@') ? text.slice(1) : null;
    if (id === '') return null;
    out.push({ text, id });
  }
  return out;
}

/** Segment list → path (canonical form) */
export function formatPath(segs) {
  return segs.map((s) => `/${escapeToken(s.text)}`).join('');
}

/** A segment for an `id` in a path: `@<id>` (escaped) */
export const idSegment = (id) => `@${escapeToken(String(id))}`;

/**
 * Whether an array element is the one referred to by `@<id>`: plain object, `id` is string and
 * strictly equal
 */
const matchesId = (el, id) => isObj(el) && el.id === id;

function findById(arr, id) {
  for (let i = 0; i < arr.length; i += 1) if (matchesId(arr[i], id)) return i;
  return -1;
}

/**
 * Array with IDs: every element is a plain object, has a non-empty string `id`, and all `id`s are
 * distinct (empty array also counts)
 */
export function isIdArray(arr) {
  if (!Array.isArray(arr)) return false;
  const seen = new Set();
  for (const el of arr) {
    if (!isObj(el) || !isIdValue(el.id) || seen.has(el.id)) return false;
    seen.add(el.id);
  }
  return true;
}

// ---------------------------------------------------------------- Validation (document-independent)

/**
 * Checks only the format of the operation itself, without inspecting the document. Throws
 * `OpError('bad-op')` if invalid. Returns the parsed path for each operation.
 * @param {unknown} ops
 */
export function checkOps(ops) {
  if (!Array.isArray(ops)) throw new OpError('bad-op', -1, 'ops must be an array');
  const parsed = [];
  ops.forEach((op, i) => {
    if (!isObj(op)) throw new OpError('bad-op', i, 'Each operation must be an object');
    if (!OP_NAMES.includes(op.op)) throw new OpError('bad-op', i, `op must be one of ${OP_NAMES.join(' / ')}`);
    const segs = parsePath(op.path);
    if (segs === null) throw new OpError('bad-op', i, 'path must be an empty string or a JSON pointer starting with /');
    switch (op.op) {
      case 'set':
        if (!Object.hasOwn(op, 'value') || op.value === undefined) throw new OpError('bad-op', i, 'set is missing value');
        if (segs.length === 0 && !isObj(op.value)) throw new OpError('bad-op', i, 'The value of a root replacement must be a plain object');
        break;
      case 'remove':
        if (segs.length === 0) throw new OpError('bad-op', i, 'Cannot remove the root');
        break;
      case 'insert':
        if (!isObj(op.value) || !isIdValue(op.value.id)) throw new OpError('bad-op', i, 'The value of insert must be an object with a non-empty string id');
        if (!isIndex(op.index)) throw new OpError('bad-op', i, 'The index of insert must be a non-negative integer');
        break;
      case 'move':
        if (segs.length === 0 || segs[segs.length - 1].id === null) throw new OpError('bad-op', i, 'move path must end with @<id>');
        if (!isIndex(op.index)) throw new OpError('bad-op', i, 'move index must be a non-negative integer');
        break;
      default:
        break;
    }
    parsed.push(segs);
  });
  return parsed;
}

// ---------------------------------------------------------------- Apply

/** Set a key on an object: `__proto__` uses defineProperty to avoid modifying the prototype */
function putKey(obj, key, value) {
  if (key === '__proto__') Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
  else obj[key] = value;
}

/**
 * Applies a batch of operations in order, returning the new root and effects of each operation;
 * **does not modify the passed-in root** (copy-on-write: only copies containers along the path,
 * containers already copied in the same batch are not copied again; `value` is put in as-is without
 * deep copying). If any operation fails, throws `OpError`; the caller can simply discard the whole
 * batch.
 *
 * Semantics:
 * - `set`: When path is an empty string, replaces the entire root (`value` must be a plain object).
 *   Otherwise traverses level by level: missing keys in objects (and missing root itself) together
 *   with missing parent objects are created as `{}` (new keys appended to the end, existing keys
 *   replaced in-place without changing position); not finding `@id` in an array, encountering a
 *   scalar or null midway, or using a non-`@id` segment on an array are all `bad-path`. When the
 *   last segment falls on an array, replaces that element in-place; the new value must be a plain
 *   object with the same `id`, otherwise `bad-path`.
 * - `remove`: The parent must exist (otherwise `bad-path`); if the target does not exist, does
 *   nothing (effect recorded as `noop: true`). When falling on an array, the last segment must be
 *   `@id`.
 * - `insert`: `path` points to the array itself, which must be an existing array with IDs
 *   (`isIdArray`, otherwise `bad-path`); `value.id` already existing in the array is `bad-path`;
 *   inserts at `min(index, length)`.
 * - `move`: `path` points to an element in an array; that array must exist (otherwise `bad-path`);
 *   if the element does not exist, does nothing (`noop: true`). Removes it first, then inserts at
 *   `min(index, length after removal)`.
 *
 * @param {unknown} root Current root (undefined / null indicates no content yet)
 * @param {Array<object>} ops
 * @returns {{ root: unknown, effects: Array<{ op: string, path: string, target: string, noop: boolean, before?: unknown, after?: unknown }> }}
 *   `path` is the canonical form; `target` is the location written by this operation (`insert` is
 *   the path of the new element); `set` also includes values before and after writing
 */
export function applyOps(root, ops) {
  const parsed = checkOps(ops);
  const owned = new WeakSet();
  const state = { root };

  const own = (node) => {
    if (owned.has(node)) return node;
    const copy = Array.isArray(node) ? node.slice() : { ...node };
    owned.add(copy);
    return copy;
  };

  /**
   * Root becomes a writable copy of itself; when `create` is truthy and root is missing
   * (undefined / null), creates `{}`
   */
  function ownRoot(i, create) {
    if (!isContainer(state.root)) {
      const missing = state.root === undefined || state.root === null;
      if (!create || !missing) throw new OpError('bad-path', i, missing ? 'The document has no content yet' : 'The root is not an object or array');
      state.root = {};
      owned.add(state.root);
      return state.root;
    }
    state.root = own(state.root);
    return state.root;
  }

  /**
   * Traverse from root to the container pointed to by `segs`, copying along the path to make it
   * writable, and return it.
   * `create`: missing keys in objects are created as `{}` (used only by set). Throws `bad-path` if
   * path cannot be traversed.
   */
  function descend(i, segs, create) {
    let node = ownRoot(i, create);
    for (let k = 0; k < segs.length; k += 1) {
      const seg = segs[k];
      if (Array.isArray(node)) {
        if (seg.id === null) throw new OpError('bad-path', i, `Arrays can only be addressed by @<id>: ${formatPath(segs.slice(0, k + 1))}`);
        const at = findById(node, seg.id);
        if (at < 0) throw new OpError('bad-path', i, `Cannot find ${formatPath(segs.slice(0, k + 1))}`);
        const copy = own(node[at]);
        node[at] = copy;
        node = copy;
        continue;
      }
      if (!Object.hasOwn(node, seg.text)) {
        if (!create) throw new OpError('bad-path', i, `Cannot find ${formatPath(segs.slice(0, k + 1))}`);
        const fresh = {};
        owned.add(fresh);
        putKey(node, seg.text, fresh);
        node = fresh;
        continue;
      }
      const child = node[seg.text];
      if (!isContainer(child)) throw new OpError('bad-path', i, `${formatPath(segs.slice(0, k + 1))} is not an object or array`);
      const copy = own(child);
      putKey(node, seg.text, copy);
      node = copy;
    }
    return node;
  }

  const effects = [];
  ops.forEach((op, i) => {
    const segs = parsed[i];
    const path = formatPath(segs);
    switch (op.op) {
      case 'set': {
        if (segs.length === 0) {
          effects.push({ op: 'set', path, target: path, noop: false, before: state.root, after: op.value });
          state.root = op.value;
          return;
        }
        const parent = descend(i, segs.slice(0, -1), true);
        const last = segs[segs.length - 1];
        if (Array.isArray(parent)) {
          if (last.id === null) throw new OpError('bad-path', i, `Arrays can only be addressed by @<id>: ${path}`);
          const at = findById(parent, last.id);
          if (at < 0) throw new OpError('bad-path', i, `Cannot find ${path} (set does not create elements in an array, use insert)`);
          if (!matchesId(op.value, last.id)) throw new OpError('bad-path', i, `The new value of ${path} must be an object with the same id`);
          effects.push({ op: 'set', path, target: path, noop: false, before: parent[at], after: op.value });
          parent[at] = op.value;
          return;
        }
        const before = Object.hasOwn(parent, last.text) ? parent[last.text] : undefined;
        effects.push({ op: 'set', path, target: path, noop: false, before, after: op.value });
        putKey(parent, last.text, op.value);
        return;
      }
      case 'remove': {
        const parent = descend(i, segs.slice(0, -1), false);
        const last = segs[segs.length - 1];
        if (Array.isArray(parent)) {
          if (last.id === null) throw new OpError('bad-path', i, `Arrays can only be addressed by @<id>: ${path}`);
          const at = findById(parent, last.id);
          if (at >= 0) parent.splice(at, 1);
          effects.push({ op: 'remove', path, target: path, noop: at < 0 });
          return;
        }
        const has = Object.hasOwn(parent, last.text);
        if (has) delete parent[last.text];
        effects.push({ op: 'remove', path, target: path, noop: !has });
        return;
      }
      case 'insert': {
        const arr = descend(i, segs, false);
        if (!Array.isArray(arr)) throw new OpError('bad-path', i, `${path} is not an array`);
        if (!isIdArray(arr)) throw new OpError('bad-path', i, `${path} is not an array with ids`);
        const { id } = op.value;
        if (findById(arr, id) >= 0) throw new OpError('bad-path', i, `${path} already contains id ${id}`);
        arr.splice(Math.min(op.index, arr.length), 0, op.value);
        effects.push({ op: 'insert', path, target: `${path}/${idSegment(id)}`, noop: false });
        return;
      }
      case 'move': {
        const arr = descend(i, segs.slice(0, -1), false);
        if (!Array.isArray(arr)) throw new OpError('bad-path', i, `${formatPath(segs.slice(0, -1))} is not an array`);
        const at = findById(arr, segs[segs.length - 1].id);
        if (at < 0) {
          effects.push({ op: 'move', path, target: path, noop: true });
          return;
        }
        const [el] = arr.splice(at, 1);
        arr.splice(Math.min(op.index, arr.length), 0, el);
        effects.push({ op: 'move', path, target: path, noop: false });
        return;
      }
      default:
        throw new OpError('bad-op', i, 'Unknown operation');
    }
  });
  return { root: state.root, effects };
}

// ---------------------------------------------------------------- Comparison and entities

/** Whether two JSON values are equal (objects ignore key order, arrays check order) */
export function jsonEqual(a, b) {
  if (a === b) return true;
  if (!isContainer(a) || !isContainer(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k) || !jsonEqual(a[k], b[k])) return false;
  }
  return true;
}

/** Whether the name segment of the k-th pair (0-based) can be counted toward the entity */
const nameOk = (seg, k, names) => seg.id === null && (k === 0 || names === null || names.has(seg.text));

/**
 * Segment list → number of matched segments (even) in paired `/<name>/@<id>` starting from root
 */
function pairPrefix(segs, names) {
  let cut = 0;
  for (let k = 0; k + 1 < segs.length; k += 2) {
    if (!nameOk(segs[k], k / 2, names) || segs[k + 1].id === null) break;
    cut = k + 2;
  }
  return cut;
}

/**
 * Segment list → entity it belongs to; when no pair can be matched, it is
 * `<metaEntity>/<top-level key>`; empty (root) is `rootEntity`
 */
function entityOfSegs(segs, o) {
  if (segs.length === 0) return o.rootEntity;
  const cut = pairPrefix(segs, o.names);
  return cut === 0 ? `${o.metaEntity}/${escapeToken(segs[0].text)}` : formatPath(segs.slice(0, cut));
}

/**
 * If traversing one segment further, could the entity still lengthen: `segs` itself is a complete
 * paired prefix, or a paired prefix plus an eligible name segment
 */
function canExtend(segs, names) {
  const cut = pairPrefix(segs, names);
  if (cut === segs.length) return true;
  return cut === segs.length - 1 && nameOk(segs[cut], cut / 2, names);
}

function entityOptions(o = {}) {
  let names = null;
  if (Array.isArray(o?.names)) names = new Set(o.names);
  else if (o?.names instanceof Set) names = o.names;
  return {
    names,
    metaEntity: typeof o?.metaEntity === 'string' ? o.metaEntity : ENTITY_DEFAULTS.metaEntity,
    rootEntity: typeof o?.rootEntity === 'string' ? o.rootEntity : ENTITY_DEFAULTS.rootEntity,
  };
}

/**
 * The entity a path belongs to: takes the longest prefix of paired `/<name>/@<id>` starting from
 * the root; the name of the first pair is unrestricted, and names of subsequent pairs must be in
 * `names` (unrestricted when `names` is null). Paths matching zero pairs are mapped by top-level key
 * to `<metaEntity>/<top-level key>` (default `/meta/<key>`); root (`""`) is `rootEntity` (default
 * `*`).
 * This function does not inspect the document: segments starting with `@` in name positions do not
 * count as names. Returns null on invalid path syntax.
 * @param {string} path
 * @param {{ names?: string[] | Set<string> | null, metaEntity?: string, rootEntity?: string }} [options]
 */
export function entityOf(path, options) {
  const segs = parsePath(path);
  if (segs === null) return null;
  const o = entityOptions(options);
  if (segs.length === 0) return o.rootEntity;
  return entityOfSegs(segs, o);
}

/**
 * Normalizes "entity name or path" into an entity (used by `project.follow`): returns existing
 * entity names as-is: root `*`, `<metaEntity>/<key>` for top-level keys (it is not the path to that
 * value; normalizing it as a path would turn it into `/meta/meta`); others compute `entityOf` by
 * path. Returns null if invalid.
 * @param {string} entityOrPath
 * @param {{ names?: string[] | Set<string> | null, metaEntity?: string, rootEntity?: string }} [options]
 */
export function normalizeEntity(entityOrPath, options) {
  const o = entityOptions(options);
  if (entityOrPath === o.rootEntity) return o.rootEntity;
  const segs = parsePath(entityOrPath);
  if (segs === null) return null;
  const meta = parsePath(o.metaEntity);
  if (meta && meta.length === 1 && segs.length === 2 && segs[0].text === meta[0].text) return formatPath(segs);
  return entityOfSegs(segs, o);
}

/**
 * Adds entities with differences between old and new values to `out`. `segs` is the path where the
 * two values reside.
 * - Entity can no longer lengthen (`canExtend` is false): compares once as a whole; if different,
 *   records the entity the current path belongs to;
 * - Objects are compared key by key; keys present on only one side are recorded under "that key's
 *   path";
 * - Elements with IDs in arrays are paired by id: elements present on only one side are recorded
 *   under their own path; those present on both sides are compared recursively; if relative order
 *   of common elements changed, or elements without IDs differ, recorded under the array's own path;
 * - Different types or different scalars are recorded under the current path.
 */
function diffEntities(a, b, segs, o, out) {
  if (a === b) return;
  const mark = (s) => out.add(entityOfSegs(s, o));
  if (!canExtend(segs, o.names)) {
    if (!jsonEqual(a, b)) mark(segs);
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const child = [...segs, { text: k, id: k.startsWith('@') && k.length > 1 ? k.slice(1) : null }];
      const ha = Object.hasOwn(a, k);
      const hb = Object.hasOwn(b, k);
      if (ha && hb) diffEntities(a[k], b[k], child, o, out);
      else mark(child);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const ida = new Map();
    const idb = new Map();
    const plainA = [];
    const plainB = [];
    for (const el of a) {
      if (isObj(el) && isIdValue(el.id) && !ida.has(el.id)) ida.set(el.id, el);
      else plainA.push(el);
    }
    for (const el of b) {
      if (isObj(el) && isIdValue(el.id) && !idb.has(el.id)) idb.set(el.id, el);
      else plainB.push(el);
    }
    let containerChanged = !jsonEqual(plainA, plainB);
    const commonA = [...ida.keys()].filter((id) => idb.has(id));
    const commonB = [...idb.keys()].filter((id) => ida.has(id));
    if (commonA.some((id, i) => commonB[i] !== id)) containerChanged = true;
    for (const [id, el] of ida) {
      const child = [...segs, { text: `@${id}`, id }];
      if (idb.has(id)) diffEntities(el, idb.get(id), child, o, out);
      else mark(child);
    }
    for (const id of idb.keys()) if (!ida.has(id)) mark([...segs, { text: `@${id}`, id }]);
    if (containerChanged) mark(segs);
    return;
  }
  if (!jsonEqual(a, b)) mark(segs);
}

/**
 * Entities written by a batch of operations (deduplicated in order of first appearance). `effects`
 * is the one from the return value of `applyOps`.
 * - `set`: Calculated from the actual difference between old and new values (not counted as written
 *   if the value did not change); full root replacement is also calculated entity-by-entity this
 *   way, without recording `*`;
 * - `remove`, `move`: Only counted if actually deleted or moved, attributed to the entity the target
 *   path belongs to;
 * - `insert`: Attributed to the entity the new element belongs to.
 * @param {Array<object>} effects
 * @param {{ names?: string[] | Set<string> | null, metaEntity?: string }} [options]
 */
export function entitiesOf(effects, options) {
  const o = entityOptions(options);
  const out = new Set();
  for (const e of effects) {
    if (e.noop) continue;
    const segs = parsePath(e.target);
    if (e.op === 'set') diffEntities(e.before, e.after, segs, o, out);
    else out.add(entityOfSegs(segs, o));
  }
  return [...out];
}
