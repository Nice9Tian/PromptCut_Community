/**
 * remotion 式的框架：载入卡片时把文件顶层的对象整体锁成只读。
 *
 * 为什么要有它：remotion 式的卡，这一帧的画面只许由时间 t 和参数算出来。要把上一帧的东西带到下一帧，
 * 就得往某个活得比一帧长的地方写——卡片文件顶层的变量是最顺手的那个地方。建卡检查能看出直接写的
 * （`COUNTER.n += 1`），看不出绕一道的（`const c = COUNTER; c.n += 1`）。所以载入时把顶层的对象都冻住：
 * 不管从哪条路写进来，写的那一刻当场报错。只在模块载入时做一次，不是每帧。
 *
 * 谁调它：载入用户卡的两条路在卡片源码末尾接上一句调用（`../../online/cardRuntime/remotionLock.mjs` 生成）——
 * 桌面与渲染节点是开发服务器的转换钩子，在线页面是转译那一步。只接在「声明成 remotion 式、并且引用了本框架」
 * 的用户卡后面：框架出现之前建的卡不可能引用它，所以老卡一张都不会被锁。
 *
 * 锁什么、不锁什么：
 *   - 普通对象、数组：自己冻住，里面的值接着往下锁；
 *   - 函数：冻住函数对象本身（不许往函数上挂东西）；正则：冻住（`lastIndex` 不再能推进）；
 *   - Map、Set：把会改内容的方法换成一调就报错的，再冻住；
 *   - 别的模块导出的东西（React、框架自己、内置的共用常量）：不是这张卡的，不碰；
 *   - React 元素这类带 `$$typeof` 的：不碰（React 开发模式自己要往里记东西）；
 *   - 锁不住的（定长数组缓冲、DOM 节点、类的实例、Promise……）：载入时直接报错，说明是哪一个。
 */

/** 顶层的一个名字和取它的值的函数（用函数是因为名字可能只是类型，取不到就跳过） */
export type TopLevelEntry = readonly [name: string, get: () => unknown];

const isObjectLike = (v: unknown): v is object => (typeof v === "object" && v !== null) || typeof v === "function";

const isPlain = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** 别的模块的导出，连同它们下面一层：这些不是这张卡的对象，既不冻也不往里走 */
function foreignSet(foreign: readonly unknown[]): WeakSet<object> {
  const set = new WeakSet<object>();
  const addChildren = (v: object) => {
    let values: unknown[];
    try { values = Array.isArray(v) ? [...v] : Object.values(v); } catch { return; }
    for (const child of values) if (isObjectLike(child)) set.add(child);
  };
  for (const ns of foreign) {
    if (!isObjectLike(ns)) continue;
    set.add(ns);
    let names: (string | symbol)[];
    try { names = Reflect.ownKeys(ns); } catch { continue; }
    for (const name of names) {
      let value: unknown;
      try { value = (ns as Record<string | symbol, unknown>)[name]; } catch { continue; } // 环形导入里还没初始化的导出
      if (!isObjectLike(value)) continue;
      set.add(value);
      if (typeof value === "object" && (Array.isArray(value) || isPlain(value))) addChildren(value);
    }
  }
  return set;
}

const typeName = (v: object): string => {
  const tag = Object.prototype.toString.call(v).slice(8, -1);
  const ctor = (v as { constructor?: { name?: unknown } }).constructor?.name;
  return tag === "Object" && typeof ctor === "string" && ctor && ctor !== "Object" ? ctor : tag;
};

function refuse(file: string, path: string, what: string): never {
  throw new TypeError(`remotion 式的卡 ${file}：${what}。顶层的 ${path} 已经锁成只读——这一帧的画面只许用时间 t 和参数算出来，不能把东西存到下一帧。`);
}

const MAP_MUTATORS = ["set", "delete", "clear"] as const;
const SET_MUTATORS = ["add", "delete", "clear"] as const;

function lockCollection(target: object, methods: readonly string[], file: string, path: string): void {
  for (const m of methods) {
    Object.defineProperty(target, m, {
      value: () => refuse(file, path, `往顶层的 ${path} 里写（${m}）`),
      writable: false, enumerable: false, configurable: false,
    });
  }
}

function deepLock(value: unknown, path: string, file: string, foreign: WeakSet<object>, seen: WeakSet<object>, depth: number): void {
  if (!isObjectLike(value) || foreign.has(value) || seen.has(value)) return;
  seen.add(value);
  if (depth > 64) return;
  if (typeof value === "function") { Object.freeze(value); return; }
  if ("$$typeof" in value) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) deepLock(value[i], `${path}[${i}]`, file, foreign, seen, depth + 1);
    Object.freeze(value);
    return;
  }
  if (value instanceof Map) {
    for (const [k, v] of value) { deepLock(k, `${path} 的键`, file, foreign, seen, depth + 1); deepLock(v, `${path} 的值`, file, foreign, seen, depth + 1); }
    lockCollection(value, MAP_MUTATORS, file, path);
    Object.freeze(value);
    return;
  }
  if (value instanceof Set) {
    for (const v of value) deepLock(v, `${path} 的成员`, file, foreign, seen, depth + 1);
    lockCollection(value, SET_MUTATORS, file, path);
    Object.freeze(value);
    return;
  }
  if (value instanceof RegExp) { Object.freeze(value); return; }
  if (isPlain(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (d && "value" in d) deepLock(d.value, `${path}.${String(key)}`, file, foreign, seen, depth + 1);
    }
    Object.freeze(value);
    return;
  }
  throw new TypeError(`remotion 式的卡 ${file}：顶层的 ${path} 是 ${typeName(value)}，锁不成只读。卡片文件顶层只放数字、字符串、普通对象、数组和函数；别的东西放进函数里现算。`);
}

/**
 * 把一张卡文件顶层的东西锁成只读。载入时调一次。
 * @param file     卡片文件（报错里用）
 * @param entries  顶层的每个名字和取值函数
 * @param foreign  这张卡引用的模块（它们的导出不是这张卡的，不锁）
 */
export function lockTopLevel(file: string, entries: readonly TopLevelEntry[], foreign: readonly unknown[] = []): void {
  const skip = foreignSet(foreign);
  const seen = new WeakSet<object>();
  for (const [name, get] of entries) {
    let value: unknown;
    try { value = get(); } catch { continue; } // 只是类型的名字、还没初始化的名字：没有值可锁
    deepLock(value, name, file, skip, seen, 0);
  }
}
