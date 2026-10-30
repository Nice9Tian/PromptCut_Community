/**
 * 项目的路径操作:算差异(diffProject)与应用(applyOps)。
 *
 * 规范在 docs/plan/c65-ops-spec.md,文档服务那边的通用 JSON 引擎照同一页实现,两边必须
 * 逐条一致 —— 同一串操作在两边要得到逐字节相同的结果(含键的顺序)。改这里的语义先改那一页。
 *
 * 纯函数、确定性,不认识项目的业务结构:只认「带 id 的数组」这一条通用规则。
 */

export type PathOp =
  | { op: "set"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "insert"; path: string; index: number; value: unknown }
  | { op: "move"; path: string; index: number };

export interface ProjectDiff {
  ops: PathOp[];
  /** 把 next 变回 prev 的操作,撤销用 */
  inverse: PathOp[];
}

export type ApplyResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "bad-path"; index: number; detail: string };

/** 单次差异超过这么多条就改成一条根替换 */
export const MAX_DIFF_OPS = 500;

type Obj = Record<string, unknown>;

function isPlainObject(v: unknown): v is Obj {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** 带 id 的数组:每个元素都是普通对象、有非空字符串 id、id 互不相同。空数组也算 */
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

/* ---------------- 路径编码 ---------------- */

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

/** 路径拆成还原过的段;"" 是根,返回 []。格式不对(不以 / 开头、~ 后面不是 0 或 1)返回 null */
export function parsePath(path: string): string[] | null {
  if (path === "") return [];
  if (typeof path !== "string" || path[0] !== "/") return null;
  if (/~[^01]|~$/.test(path)) return null;
  const segs = path.slice(1).split("/").map(unescapeSegment);
  // 只有一个 @ 的段不合法(落在对象上也不认),与文档服务的引擎一致
  if (segs.some((seg) => seg === "@")) return null;
  return segs;
}

/* ---------------- 深相等 ---------------- */

/** 结构相等(对象不看键的顺序;undefined 的键当不存在) */
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

/* ---------------- 差异 ---------------- */

class TooMany extends Error {}

interface DiffCtx {
  ops: PathOp[];
  /** 与 ops 一一对应,每条是「把这条之后的状态变回这条之前」的操作;最后整体倒序 */
  inv: PathOp[];
  limit: number;
}

function push(ctx: DiffCtx, op: PathOp, inv: PathOp) {
  ctx.ops.push(op);
  ctx.inv.push(inv);
  if (ctx.ops.length > ctx.limit) throw new TooMany();
}

const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

/** 写键。`__proto__` 走 defineProperty,免得改到原型上 */
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
    // 相同(含同一个对象)的键不拼路径 —— 深拷贝过的大项目里这是大头
    if (a === b) continue;
    diffValue(a, b, keyPath(path, k), ctx);
  }
}

/** 最长递增子序列,返回被选中的下标集合(下标指 seq 的位置) */
function lisIndices(seq: number[]): Set<number> {
  const tails: number[] = []; // tails[len-1] = 以它结尾的下标
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

  // 1. 删掉消失的元素(从后往前,记下的下标就是删之前它所在的位置)
  const work: string[] = prev.map((e) => e.id as string);
  for (let i = work.length - 1; i >= 0; i--) {
    const id = work[i];
    if (nextIndex.has(id)) continue;
    const p = idPath(path, id);
    push(ctx, { op: "remove", path: p }, { op: "insert", path, index: i, value: prevById.get(id) });
    work.splice(i, 1);
  }

  // 2. 排位:不在最长保序子序列里的旧元素各挪一次,新元素各插一次,按 next 的顺序处理
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

  // 3. 两边都有的元素逐个递归。身份不同但内容一样的元素(整份深拷贝过的项目里几乎全是)
  //    先用 noOpsBetween 廉价地排除掉,不拼路径、不建索引
  for (const e of next) {
    const id = e.id as string;
    const before = prevById.get(id);
    if (before !== undefined && before !== e && !noOpsBetween(before, e)) diffValue(before, e, idPath(path, id), ctx);
  }
}

/*
 * noOpsBetween(prev, next) 为 true 时,diffValue(prev, next) 保证一条操作也不出。
 * 它逐分支照着 diffValue / diffObject / diffIdArray 的判断走,只是不拼路径、不记操作、
 * 遇到第一处会出操作的地方就返回 false。拿不准的情形一律返回 false(交给 diffValue 照常算),
 * 所以用它跳过只会少做无用功,不会改变输出。
 */
function noOpsBetween(prev: unknown, next: unknown): boolean {
  if (prev === next) return true;
  // 不都是对象:diffValue 落到 deepEqual,两者不 === 时 deepEqual 必为 false
  if (typeof prev !== "object" || typeof next !== "object" || prev === null || next === null) return false;
  // 一边数组一边不是:diffValue 落到 deepEqual,必为 false
  if (Array.isArray(prev)) return Array.isArray(next) && noOpsArray(prev, next);
  if (Array.isArray(next)) return false;
  if (isPlainObject(prev) && isPlainObject(next)) return noOpsObject(prev, next);
  // 其余(至少一边是非普通对象):diffValue 用 deepEqual 判
  return deepEqual(prev, next);
}

/** 与 diffObject 的两个循环一一对应:第一个循环出 remove,第二个出 set 或递归 */
function noOpsObject(prev: Obj, next: Obj): boolean {
  // 快路:两边自有可枚举键逐位相同(深拷贝、{ ...o, k: v } 都保持键序)。这时 has(o, k) 就是 o[k] !== undefined,
  // 两个循环合成一个,也省掉在另一个对象上逐键 hasOwnProperty(for-in 里对别的对象查键是这里的大头)
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
      if (a === undefined || b === undefined) return false; // 一边有值一边没有:remove 或 set
      if (!noOpsBetween(a, b)) return false;
    }
    return true;
  }
  // 键不同或键序不同:照 diffObject 原样走两遍
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
  // 长度不同:两边都是带 id 的数组时必有 insert / remove;否则 deepEqual 为 false
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    // prev 的元素不全是带非空字符串 id 的普通对象:prev 不是带 id 的数组,diffValue 用 deepEqual 判
    if (!isPlainObject(a) || typeof a.id !== "string" || a.id === "") return deepEqual(prev, next);
    // 两边 id 逐位相同才可能没有操作;不同的情形(换序、换元素、next 不是带 id 的数组)交给 diffValue
    const b = next[i];
    if (!isPlainObject(b) || b.id !== a.id) return false;
  }
  // 若两边都是带 id 的数组:id 顺序完全相同,diffIdArray 不删不挪不插,只逐个递归。
  // 先逐个比(有一个会出操作就返回 false —— 返回 false 总是安全的),都没有操作再确认 id 不重复
  for (let i = 0; i < next.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a !== b && !noOpsBetween(a, b)) return false;
  }
  // id 有重复:两边都不是带 id 的数组,diffValue 用 deepEqual 判
  return isIdArray(prev) || deepEqual(prev, next);
}

/**
 * 算 prev → next 的路径操作和逆操作。确定性:同样的输入永远同样的输出。
 * 单次超过 MAX_DIFF_OPS 条时退化成一条根替换。
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

/* ---------------- 应用 ---------------- */

class BadPath extends Error {}

function fail(detail: string): never {
  throw new BadPath(detail);
}

/**
 * 写时复制:同一次 applyOps 里新建的节点记在 owned 里,之后可以原地改;
 * 没碰过的子树与原对象共享,原对象一概不动。
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
  if (seg[0] !== "@" || seg.length < 2) fail(`数组段必须是 @<id>:${seg}`);
  return seg.slice(1);
}

/**
 * 从根走到 segs 所指节点的父级,沿途复制,返回可原地改的父节点和最后一段。
 * createMissing:对象上缺的键建成 {}(只有 set 用)。
 */
function walkToParent(root: unknown, segs: string[], cow: Cow, createMissing: boolean): { root: unknown; parent: unknown; last: string } {
  if (root === null || typeof root !== "object") fail("根不是对象");
  const newRoot = cow.own(root as object);
  let node: unknown = newRoot;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (Array.isArray(node)) {
      const idx = findById(node, arrayIdOf(seg));
      if (idx < 0) fail(`找不到元素:${seg}`);
      const child = node[idx];
      if (child === null || typeof child !== "object") fail(`途经的值不是对象:${seg}`);
      const copy = cow.own(child as object);
      node[idx] = copy;
      node = copy;
    } else if (isPlainObject(node)) {
      let child = has(node, seg) ? node[seg] : undefined;
      if (child === undefined) {
        if (!createMissing) fail(`路径不存在:${seg}`);
        child = {};
        cow.owned.add(child as object);
        setKey(node, seg, child);
        node = child;
        continue;
      }
      if (child === null || typeof child !== "object") fail(`途经的值不是对象:${seg}`);
      const copy = cow.own(child as object);
      setKey(node, seg, copy);
      node = copy;
    } else {
      fail(`途经的值不是对象:${seg}`);
    }
  }
  return { root: newRoot, parent: node, last: segs[segs.length - 1] };
}

function validIndex(i: unknown): i is number {
  return typeof i === "number" && Number.isSafeInteger(i) && i >= 0;
}

/**
 * 只读地走到父级(不复制),规则与 walkToParent(createMissing = false)相同:走不通就 bad-path。
 * remove / move 先用它判断目标在不在 —— 不在就是空操作,原对象原样返回,不白复制一路。
 */
function peekParent(root: unknown, segs: string[]): unknown {
  if (root === null || typeof root !== "object") fail("根不是对象");
  let node: unknown = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (Array.isArray(node)) {
      const idx = findById(node, arrayIdOf(seg));
      if (idx < 0) fail(`找不到元素:${seg}`);
      node = node[idx];
    } else if (isPlainObject(node)) {
      if (!has(node, seg)) fail(`路径不存在:${seg}`);
      node = node[seg];
    } else fail(`途经的值不是对象:${seg}`);
    if (node === null || typeof node !== "object") fail(`途经的值不是对象:${seg}`);
  }
  return node;
}

/** 操作本身的格式(不看文档);不对返回原因 */
function formatError(op: PathOp): string | null {
  if (!isPlainObject(op)) return "每条操作必须是对象";
  if (op.op !== "set" && op.op !== "remove" && op.op !== "insert" && op.op !== "move") return `不认识的操作:${String((op as { op?: unknown }).op)}`;
  const segs = typeof op.path === "string" ? parsePath(op.path) : null;
  if (!segs) return `路径格式不对:${String(op.path)}`;
  switch (op.op) {
    case "set":
      if (!Object.prototype.hasOwnProperty.call(op, "value") || op.value === undefined) return "set 缺 value";
      if (segs.length === 0 && !isPlainObject(op.value)) return "根替换的值必须是对象";
      return null;
    case "remove":
      return segs.length === 0 ? "不能删根" : null;
    case "insert":
      if (!isPlainObject(op.value) || typeof op.value.id !== "string" || op.value.id === "") return "insert 的 value 必须是带非空字符串 id 的对象";
      return validIndex(op.index) ? null : "index 必须是非负整数";
    case "move":
      if (segs.length === 0 || segs[segs.length - 1][0] !== "@") return "move 的 path 必须以 @<id> 结尾";
      return validIndex(op.index) ? null : "index 必须是非负整数";
  }
}

function applyOne(root: unknown, op: PathOp, cow: Cow): unknown {
  if (!op || typeof op !== "object" || typeof (op as { path?: unknown }).path !== "string") fail("操作缺 path");
  const segs = parsePath(op.path);
  if (!segs) fail(`路径格式不对:${op.path}`);
  switch (op.op) {
    case "set": {
      if (!("value" in op) || op.value === undefined) fail("set 缺 value");
      if (segs.length === 0) {
        if (!isPlainObject(op.value)) fail("根替换的值必须是对象");
        return op.value;
      }
      // 还没有真身(根缺失)时从 {} 建起
      const { root: r, parent, last } = walkToParent(root ?? {}, segs, cow, true);
      if (Array.isArray(parent)) {
        const id = arrayIdOf(last);
        const idx = findById(parent, id);
        if (idx < 0) fail(`找不到元素:${last}`);
        if (!isPlainObject(op.value) || op.value.id !== id) fail("替换数组元素时 value.id 必须等于路径里的 id");
        parent[idx] = op.value;
      } else if (isPlainObject(parent)) {
        setKey(parent, last, op.value);
      } else fail("父级不是对象");
      return r;
    }
    case "remove": {
      if (segs.length === 0) fail("不能删根");
      // 父级必须在;目标不在是空操作(两人同时删同一个片段,后到的那批照常落地)
      const last = segs[segs.length - 1];
      const peek = peekParent(root, segs);
      if (Array.isArray(peek)) {
        if (findById(peek, arrayIdOf(last)) < 0) return root;
      } else if (isPlainObject(peek)) {
        if (!has(peek, last)) return root;
      } else fail("父级不是对象");
      const { root: r, parent } = walkToParent(root, segs, cow, false);
      if (Array.isArray(parent)) parent.splice(findById(parent, arrayIdOf(last)), 1);
      else delete (parent as Obj)[last];
      return r;
    }
    case "insert": {
      if (!validIndex(op.index)) fail("index 必须是非负整数");
      const v = op.value;
      if (!isPlainObject(v) || typeof v.id !== "string" || v.id === "") fail("insert 的 value 必须是带非空字符串 id 的对象");
      // 目标是数组本身(数组总是挂在对象的某个键上):走到它的父级,再把数组也复制出来
      if (segs.length === 0) fail("根不是数组");
      const { root: r, parent, last } = walkToParent(root, segs, cow, false);
      if (!isPlainObject(parent)) fail("insert 的目标不是数组");
      const cur = has(parent, last) ? parent[last] : undefined;
      if (!Array.isArray(cur) || !isIdArray(cur)) fail("insert 的目标不是带 id 的数组");
      if (findById(cur, v.id as string) >= 0) fail(`id 已存在:${v.id}`);
      const a = cow.own(cur);
      setKey(parent, last, a);
      a.splice(Math.min(op.index, a.length), 0, v);
      return r;
    }
    case "move": {
      if (!validIndex(op.index)) fail("index 必须是非负整数");
      if (segs.length === 0) fail("不能挪根");
      const last = segs[segs.length - 1];
      const id = arrayIdOf(last);
      // 所在的数组必须在;元素不在是空操作
      const peek = peekParent(root, segs);
      if (!Array.isArray(peek)) fail("move 的目标不在数组里");
      if (findById(peek, id) < 0) return root;
      const { root: r, parent } = walkToParent(root, segs, cow, false);
      const arr = parent as unknown[];
      const [el] = arr.splice(findById(arr, id), 1);
      arr.splice(Math.min(op.index, arr.length), 0, el);
      return r;
    }
    default:
      fail(`不认识的操作:${(op as { op?: unknown }).op}`);
  }
}

/**
 * 按顺序应用一串路径操作。原子:任何一条失败都返回 bad-path,原对象不变。
 * 没碰过的子树与输入共享(不深拷贝),所以输入必须当不可变对象用。
 */
export function applyOps<T>(doc: T, ops: readonly PathOp[]): ApplyResult<T> {
  if (!Array.isArray(ops)) return { ok: false, code: "bad-path", index: -1, detail: "ops 必须是数组" };
  // 先整批查格式(与文档无关),再逐条应用 —— 与文档服务的引擎一样,失败下标先报格式错的那条
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

/** 取路径上的值;取不到返回 undefined */
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

/* ---------------- 实体 ---------------- */

/** 嵌套实体只认这几个集合名(第一层不限):序列里的片段、剪辑里的序列与转场 */
const NESTED_ENTITY = new Set(["tracks", "clips", "transitions"]);

/** 所有实体 */
export const ALL_ENTITIES = "*";
/**
 * 取不到任何一对 `/<名>/@<id>` 的路径按顶层键各算一个实体 `/meta/<顶层键>`(`/fps` → `/meta/fps`,
 * `/style/x` → `/meta/style`)。2026-09-26 集成裁定:别人改了 fps 不该让我撤不回自己改的 name。
 */
export const META_ENTITY = "/meta";

/** 一条路径归哪个实体(规范第 4 节) */
export function entityOfPath(path: string): string {
  if (path === "") return ALL_ENTITIES;
  const segs = parsePath(path);
  if (!segs || segs.length === 0) return ALL_ENTITIES;
  let end = 0;
  // 名字段不能以 @ 开头(文档服务的引擎把 @ 开头的段当 id 段),第一对之后的名字只认 NESTED_ENTITY
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
 * 实体 → 它的值在项目里的路径(覆盖备份取值用):`*` 是根 `""`;`/meta/<键>` 是 `/<键>`;
 * 其余实体本身就是路径。
 */
export function entityValuePath(entity: string): string {
  if (entity === ALL_ENTITIES) return "";
  const prefix = `${META_ENTITY}/`;
  if (entity.startsWith(prefix) && entity.indexOf("/", prefix.length) < 0) return "/" + entity.slice(prefix.length);
  return entity;
}

/** 一条操作写到的实体(insert 按插进去的那个元素算) */
export function entityOfOp(op: PathOp): string {
  if (op.op === "insert" && isPlainObject(op.value) && typeof op.value.id === "string") {
    return entityOfPath(idPath(op.path, op.value.id));
  }
  return entityOfPath(op.path);
}

/** 一串操作写到的实体,按首次出现的顺序去重 */
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

/** 两个实体是否算写到同一处 */
export function entitiesOverlap(a: string, b: string): boolean {
  return a === b || a === ALL_ENTITIES || b === ALL_ENTITIES;
}
