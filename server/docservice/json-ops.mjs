/**
 * 通用 JSON 路径操作引擎（C6.5 设计稿 `docs/plan/c65-design.md` 第 2 节；精确语义见 `docs/plan/c65-ops-spec.md`
 * 与报告 `docs/archive/agent-reports/AGENT-c65-docservice.md`）。
 *
 * 文档服务是通用的 JSON 分发中心，不认识任何业务结构：本文件只认 JSON 的对象、数组、标量，
 * 以及「数组里带 `id` 的对象按 `@<id>` 寻址」这一条通用约定。只用语言内置能力，不引用任何其它文件。
 *
 * - 路径：JSON 指针（RFC 6901，`~0` = `~`、`~1` = `/`），空串是根。数组里的元素只能按 `@<id>` 寻址，不认下标。
 * - 四种操作：`set`、`remove`、`insert`、`move`（见 `applyOps`）。
 * - 一批操作原子生效：`applyOps` 按写时复制做，旧的根一个字节都不改；任何一条失败就整批作废、抛错。
 * - 实体：`entityOf` 把路径归到从根开始、成对的 `/<名>/@<id>` 的最长前缀上（第一对之后的名字可以限定在
 *   `names` 里），一对都没有的按顶层键各归一个 `<metaEntity>/<顶层键>`（如 `/meta/fps`）；`entitiesOf` 按 `applyOps` 给的效果算出一批操作写到的实体
 *   （`set` 按新旧值的实际差别算）。哪些名字能往下延伸由调用方给，本文件不认识任何具体名字。
 */

export const OP_NAMES = Object.freeze(['set', 'remove', 'insert', 'move']);

/**
 * 实体的缺省口径：`names` 为 null 时第一对之后的名字不限；取不到任何一对的按顶层键各算一个实体
 * `/meta/<顶层键>`（`/fps` → `/meta/fps`，`/style/x` → `/meta/style`；2026-09-26 集成裁定：别人改了 fps
 * 不该让我撤不回自己改的 name）；根替换的路径 `""` 由 `entityOf` 记为 `*`（所有实体）。
 */
export const ENTITY_DEFAULTS = Object.freeze({ names: null, metaEntity: '/meta', rootEntity: '*' });

/**
 * 引擎的错误：
 * - `bad-op`：操作本身的格式不对（操作名、路径语法、缺 `value`、`index` 不是非负整数……），与文档内容无关；
 * - `bad-path`：格式对，但对着当前文档走不通（父级不存在、下标寻址、`insert` 的 `id` 已存在……）。
 * `index` 是出错的那条操作在批里的下标（整个 `ops` 不是数组时是 -1）。
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

// ---------------------------------------------------------------- 路径

function unescapeToken(raw) {
  if (!raw.includes('~')) return raw;
  if (/~[^01]|~$/.test(raw)) return null;
  return raw.replace(/~1/g, '/').replace(/~0/g, '~');
}

const escapeToken = (text) => text.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * 拆路径：空串 → []；否则必须以 `/` 开头。每段 `{ text, id }`：`text` 是反转义后的键；
 * 以 `@` 开头的段 `id` 是去掉 `@` 的部分（落在数组上时按它找元素），否则 `id` 为 null。
 * 落在对象上时，`@` 开头的段仍按字面键处理。语法不对（含 `@` 后面是空的）回 null。
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

/** 段列表 → 路径（规范写法） */
export function formatPath(segs) {
  return segs.map((s) => `/${escapeToken(s.text)}`).join('');
}

/** 一个 `id` 在路径里的段：`@<id>`（转义后） */
export const idSegment = (id) => `@${escapeToken(String(id))}`;

/** 数组元素是否就是 `@<id>` 指的那个：普通对象、`id` 是字符串且全等 */
const matchesId = (el, id) => isObj(el) && el.id === id;

function findById(arr, id) {
  for (let i = 0; i < arr.length; i += 1) if (matchesId(arr[i], id)) return i;
  return -1;
}

/** 带 id 的数组：每个元素都是普通对象、都有非空字符串 `id`、`id` 互不相同（空数组也算） */
export function isIdArray(arr) {
  if (!Array.isArray(arr)) return false;
  const seen = new Set();
  for (const el of arr) {
    if (!isObj(el) || !isIdValue(el.id) || seen.has(el.id)) return false;
    seen.add(el.id);
  }
  return true;
}

// ---------------------------------------------------------------- 校验（与文档无关）

/**
 * 只看操作本身的格式，不看文档。不对就抛 `OpError('bad-op')`。返回每条的已解析路径。
 * @param {unknown} ops
 */
export function checkOps(ops) {
  if (!Array.isArray(ops)) throw new OpError('bad-op', -1, 'ops 必须是数组');
  const parsed = [];
  ops.forEach((op, i) => {
    if (!isObj(op)) throw new OpError('bad-op', i, '每条操作必须是对象');
    if (!OP_NAMES.includes(op.op)) throw new OpError('bad-op', i, `op 只能是 ${OP_NAMES.join(' / ')}`);
    const segs = parsePath(op.path);
    if (segs === null) throw new OpError('bad-op', i, 'path 必须是空串或以 / 开头的 JSON 指针');
    switch (op.op) {
      case 'set':
        if (!Object.hasOwn(op, 'value') || op.value === undefined) throw new OpError('bad-op', i, 'set 缺少 value');
        if (segs.length === 0 && !isObj(op.value)) throw new OpError('bad-op', i, '根替换的 value 必须是普通对象');
        break;
      case 'remove':
        if (segs.length === 0) throw new OpError('bad-op', i, '不能 remove 根');
        break;
      case 'insert':
        if (!isObj(op.value) || !isIdValue(op.value.id)) throw new OpError('bad-op', i, 'insert 的 value 必须是带非空字符串 id 的对象');
        if (!isIndex(op.index)) throw new OpError('bad-op', i, 'insert 的 index 必须是非负整数');
        break;
      case 'move':
        if (segs.length === 0 || segs[segs.length - 1].id === null) throw new OpError('bad-op', i, 'move 的 path 必须以 @<id> 结尾');
        if (!isIndex(op.index)) throw new OpError('bad-op', i, 'move 的 index 必须是非负整数');
        break;
      default:
        break;
    }
    parsed.push(segs);
  });
  return parsed;
}

// ---------------------------------------------------------------- 应用

/** 给对象设一个键：`__proto__` 走 defineProperty，免得改到原型 */
function putKey(obj, key, value) {
  if (key === '__proto__') Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
  else obj[key] = value;
}

/**
 * 按顺序应用一批操作，返回新的根和每条的效果；**不改动传入的根**（写时复制：只复制路径上经过的容器，
 * 同一批里已经复制过的不再复制；`value` 原样放进去，不深拷贝）。任何一条失败抛 `OpError`，调用方丢掉整批即可。
 *
 * 语义：
 * - `set`：路径为空串时替换整个根（`value` 必须是普通对象）。否则逐级走下去：对象里缺的键（以及根本身缺失）
 *   连同缺的父级对象一起建成 `{}`（新键追加在末尾，已有的键原位替换、位置不变）；数组里找不到 `@id`、
 *   中途碰到标量或 null、在数组上用非 `@id` 段，都是 `bad-path`。末段落在数组上时原位替换那个元素，
 *   新值必须是 `id` 相同的普通对象，否则 `bad-path`。
 * - `remove`：父级必须存在（否则 `bad-path`）；目标不存在时什么都不做（效果记 `noop: true`）。落在数组上时末段必须是 `@id`。
 * - `insert`：`path` 指向数组本身，必须是已存在的带 id 的数组（`isIdArray`，否则 `bad-path`）；`value.id`
 *   已在数组里是 `bad-path`；插到 `min(index, 长度)` 处。
 * - `move`：`path` 指向数组里的元素，那个数组必须存在（否则 `bad-path`）；元素不存在时什么都不做（`noop: true`）。
 *   先拿出来，再插到 `min(index, 拿出后的长度)` 处。
 *
 * @param {unknown} root 当前的根（undefined / null 表示还没有内容）
 * @param {Array<object>} ops
 * @returns {{ root: unknown, effects: Array<{ op: string, path: string, target: string, noop: boolean, before?: unknown, after?: unknown }> }}
 *   `path` 是规范写法；`target` 是这条操作写到的位置（`insert` 是新元素的路径）；`set` 另带写之前与之后的值
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

  /** 根变成自己的可写副本；`create` 为真时根缺失（undefined / null）就建成 `{}` */
  function ownRoot(i, create) {
    if (!isContainer(state.root)) {
      const missing = state.root === undefined || state.root === null;
      if (!create || !missing) throw new OpError('bad-path', i, missing ? '文档还没有内容' : '根不是对象或数组');
      state.root = {};
      owned.add(state.root);
      return state.root;
    }
    state.root = own(state.root);
    return state.root;
  }

  /**
   * 从根走到 `segs` 指的容器，沿途复制成可写的，返回它。
   * `create`：对象里缺的键建成 `{}`（只有 set 用）。走不通抛 `bad-path`。
   */
  function descend(i, segs, create) {
    let node = ownRoot(i, create);
    for (let k = 0; k < segs.length; k += 1) {
      const seg = segs[k];
      if (Array.isArray(node)) {
        if (seg.id === null) throw new OpError('bad-path', i, `数组只能按 @<id> 寻址：${formatPath(segs.slice(0, k + 1))}`);
        const at = findById(node, seg.id);
        if (at < 0) throw new OpError('bad-path', i, `找不到 ${formatPath(segs.slice(0, k + 1))}`);
        const copy = own(node[at]);
        node[at] = copy;
        node = copy;
        continue;
      }
      if (!Object.hasOwn(node, seg.text)) {
        if (!create) throw new OpError('bad-path', i, `找不到 ${formatPath(segs.slice(0, k + 1))}`);
        const fresh = {};
        owned.add(fresh);
        putKey(node, seg.text, fresh);
        node = fresh;
        continue;
      }
      const child = node[seg.text];
      if (!isContainer(child)) throw new OpError('bad-path', i, `${formatPath(segs.slice(0, k + 1))} 不是对象或数组`);
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
          if (last.id === null) throw new OpError('bad-path', i, `数组只能按 @<id> 寻址：${path}`);
          const at = findById(parent, last.id);
          if (at < 0) throw new OpError('bad-path', i, `找不到 ${path}（set 不在数组里建元素，用 insert）`);
          if (!matchesId(op.value, last.id)) throw new OpError('bad-path', i, `${path} 的新值必须是 id 相同的对象`);
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
          if (last.id === null) throw new OpError('bad-path', i, `数组只能按 @<id> 寻址：${path}`);
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
        if (!Array.isArray(arr)) throw new OpError('bad-path', i, `${path} 不是数组`);
        if (!isIdArray(arr)) throw new OpError('bad-path', i, `${path} 不是带 id 的数组`);
        const { id } = op.value;
        if (findById(arr, id) >= 0) throw new OpError('bad-path', i, `${path} 里已经有 id ${id}`);
        arr.splice(Math.min(op.index, arr.length), 0, op.value);
        effects.push({ op: 'insert', path, target: `${path}/${idSegment(id)}`, noop: false });
        return;
      }
      case 'move': {
        const arr = descend(i, segs.slice(0, -1), false);
        if (!Array.isArray(arr)) throw new OpError('bad-path', i, `${formatPath(segs.slice(0, -1))} 不是数组`);
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
        throw new OpError('bad-op', i, '未知操作');
    }
  });
  return { root: state.root, effects };
}

// ---------------------------------------------------------------- 比较与实体

/** 两个 JSON 值是否相同（对象不看键序，数组看顺序） */
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

/** 第 k 对（从 0 起）的名字段能不能算进实体 */
const nameOk = (seg, k, names) => seg.id === null && (k === 0 || names === null || names.has(seg.text));

/** 段列表 → 从根开始成对的 `/<名>/@<id>` 能取到的段数（偶数） */
function pairPrefix(segs, names) {
  let cut = 0;
  for (let k = 0; k + 1 < segs.length; k += 2) {
    if (!nameOk(segs[k], k / 2, names) || segs[k + 1].id === null) break;
    cut = k + 2;
  }
  return cut;
}

/** 段列表 → 它所属的实体；一对都取不到时是 `<metaEntity>/<顶层键>`；空（根）是 `rootEntity` */
function entityOfSegs(segs, o) {
  if (segs.length === 0) return o.rootEntity;
  const cut = pairPrefix(segs, o.names);
  return cut === 0 ? `${o.metaEntity}/${escapeToken(segs[0].text)}` : formatPath(segs.slice(0, cut));
}

/** 再往下走一段，实体还可能变长吗：`segs` 本身是完整的成对前缀，或是成对前缀加一个合格的名字段 */
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
 * 路径所属的实体：从根开始取成对的 `/<名>/@<id>` 的最长前缀；第一对的名字不限，之后每一对的名字要在 `names` 里
 * （`names` 为 null 时不限）。一对都取不到的按顶层键归 `<metaEntity>/<顶层键>`（缺省 `/meta/<键>`）；根（`""`）是 `rootEntity`（缺省 `*`）。
 * 本函数不看文档：名字位置上以 `@` 开头的段不算名字。路径语法不对回 null。
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
 * 把「实体名或路径」归一成实体（`project.follow` 用）：已经是实体名的原样返回——根 `*`、
 * 顶层键的 `<metaEntity>/<键>`（它不是那个值的路径，再按路径归一会变成 `/meta/meta`）；其余按路径算 `entityOf`。
 * 不合法回 null。
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
 * 新旧两个值之间有差别的实体，加进 `out`。`segs` 是这两个值所在的路径。
 * - 实体已经不会再变长（`canExtend` 为假）：整个比一次，不同就记当前路径所属的实体；
 * - 对象逐键比；只在一边有的键，按「那个键的路径」记；
 * - 数组里带 id 的元素按 id 配对：只在一边有的元素按它自己的路径记，两边都有的往下比；
 *   共同元素的相对顺序变了，或不带 id 的元素有差别，按数组本身的路径记；
 * - 类型不同、标量不同，按当前路径记。
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
 * 一批操作写到的实体（按首次出现的顺序去重）。`effects` 是 `applyOps` 的返回值里的那个。
 * - `set`：按新旧值的实际差别算（值没变就不算写到）；整个根替换也照此逐实体算，不记 `*`；
 * - `remove`、`move`：真的删了、挪了才算，算到目标路径所属的实体；
 * - `insert`：算到新元素所属的实体。
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
