/**
 * 舞台源上的跨文档通道守卫:舞台文档与运行时起的声音线程都装同一份。
 *
 * 为什么要有:舞台是两个共用的跨源源,哪个项目打开就跑哪个项目的卡片代码。卡片参数里带着本项目的路径号
 * (`/media-s/<路径号>/media/<哈希>`,`docs/semantics/mechanism/platforms.md`「路径号按账号加项目固定」);
 * 浏览器把素材缓存一年,谁知道了路径号和哈希就能读到缓存里的素材。项目 A 的卡片(哪怕是没有恶意、只是图省事的卡)
 * 只要能把参数留在舞台源上「活过本文档」或「别的文档同时看得见」的地方,项目 B 的卡片就能拿到。
 * 舞台文档里的 `localStorage` 等由 `harden.ts` 的 `denyPersistentStorage` 收走;本文件管剩下的:
 *
 * - **后台线程**:不让卡片起后台线程(建卡守则本来就不许卡片用 `Worker`、`SharedWorker`)。
 *   全局的 `Worker` 与 `Worker.prototype.constructor` 一律换成锁死的抛错构造函数(卡片自己 `new Worker(...)`、
 *   拿 `Worker.prototype.constructor`、写 `class extends Worker` 都会当场抛错);`SharedWorker` 直接收走。
 *   舞台运行时自己的两个专用后台线程(GL 渲染线程 `spawnGlWorker`、声音线程 `spawnSoundWorker`)经本模块的
 *   `spawnRuntimeWorker` 用守卫安装前留在模块闭包里的原生构造函数起(不挂在 `window` 上,卡片运行在 `new Function` 里、
 *   不能静态引用运行时模块,拿不到);声音线程入口(`soundWorker.ts`)在载入任何卡片 `audio()` 代码之前同样装本守卫。
 *   因为不再把守卫源码拼在卡片经典脚本前面,原先「经典脚本开头的 `"use strict"` 失效」的残余问题也不再存在。
 * - **持久存储**(窗口与声音线程里同样有):IndexedDB、Cache Storage、旧式文件系统、`openDatabase`、`sharedStorage` 的全局入口沿原型链改成 `undefined`;
 *   另外把这些接口原型上的读写方法一律改成抛错或拒绝(纵深防御:万一有代码先于守卫拿到了 `indexedDB`、`caches`、
 *   `navigator.storage` 对象或开好的库,也开不了库、开不了事务、写不进缓存、打不开文件)。
 *   源私有文件系统、存储桶拒绝;`navigator.storage.persist()` 回 false;Service Worker 注册拒绝(内容安全策略本来也拦)。
 * - **同源实时通道**:`BroadcastChannel` 不给(发消息的原型方法也改成抛错);
 *   Web Locks 的锁名按本全局环境加一段随机前缀(`lockPrefix`),别的文档(别的项目)的锁既看不见(`query()` 只回本前缀的)、
 *   也抢不到、也占不住同名的。
 * - **`cookieStore` 写入**:`set`、`delete` 拒绝(舞台文档里 `harden.ts` 第 6 节已锁过的,这里认作已锁)。
 *
 * **自足的函数**:函数体里不引用本模块或别的模块里的任何名字,只用标准内置对象(并且能从字面量取的都从字面量取,
 * 要读的平台接口先核一遍有没有在守卫之前被可枚举或不可配置的属性遮住);单测在一个只带标准内置对象的 `vm` 环境里执行它的源码核这一点。
 */

export interface ScopeGuardConfig {
  /** Web Locks 锁名前缀:一个舞台文档(或声音线程)一份随机串 */
  lockPrefix: string;
  /**
   * 严格模式:守卫核对不过、或关键项没装上,就抛错。
   * 舞台文档里不设:核对不过、关键项没装上记进 `errors`,由舞台自检(`isolationCheck.ts`)判「加固没装上」、不执行用户卡。
   */
  strict?: boolean;
}

/** 关键项:这些没装上,严格模式下抛错、舞台自检判「加固没装上」(`errors` 里以「名字:」开头的项) */
export const SCOPE_GUARD_CRITICAL = ["integrity", "indexedDB", "caches", "BroadcastChannel", "SharedWorker", "Worker", "locks"] as const;

export interface ScopeGuardResult {
  /** 收走或改掉的入口(诊断) */
  denied: string[];
  /** 没装上的项(诊断) */
  errors: string[];
}

/**
 * 在一个全局对象(窗口或线程)上装守卫。同一个全局对象装两次不报错(第二次认作已锁)。
 * **自足**:见文件头;改这个函数时别引用函数体外的任何名字。
 */
export function guardStageScope(scope: object, config: ScopeGuardConfig): ScopeGuardResult {
  "use strict";
  const denied: string[] = [];
  const errors: string[] = [];
  const g = scope as Record<string, any>;
  /*
   * 0. 内置对象。能从字面量取的一律从字面量取,不读全局名字(防全局名字在守卫之前被遮住)。
   */
  const O = ({}).constructor as ObjectConstructor;
  const defineProperty = O.defineProperty;
  const getOwnPropertyDescriptor = O.getOwnPropertyDescriptor;
  const getPrototypeOf = O.getPrototypeOf;
  const hasOwn = O.prototype.hasOwnProperty;
  const ArrayC = ([] as unknown[]).constructor as ArrayConstructor;
  const Str = "".constructor as StringConstructor;
  let TypeErr = undefined as unknown as TypeErrorConstructor;
  try { defineProperty(1 as unknown as object, "x", {}); } catch (e) { TypeErr = (e as { constructor: TypeErrorConstructor }).constructor; }
  const P = (async () => undefined)().constructor as PromiseConstructor;
  const Sym = O(O.getOwnPropertySymbols(ArrayC.prototype)[0]).constructor as SymbolConstructor;
  // 没有字面量的两个:函数声明只能造出函数,还是对象就是原装的
  const shadowed: string[] = [];
  const R = typeof Reflect === "object" && Reflect !== null ? Reflect : null;
  const J = typeof JSON === "object" && JSON !== null ? JSON : null;
  if (!R) shadowed[shadowed.length] = "Reflect";
  if (!J) shadowed[shadowed.length] = "JSON";
  /*
   * 要读的平台接口:顶层函数声明把它换掉之后,全局上留下的是「可枚举、不可配置」的自有属性(规范 CreateGlobalFunctionBinding)。
   * 接口对象(构造函数)浏览器原装的一律不可枚举,所以接口对象只要可枚举就算被换过;全局属性与方法(`indexedDB` 等)原装的可枚举、可配置。
   * 本守卫与舞台加固自己锁的都不可枚举。
   */
  const IFACES = ["URL", "Blob", "Worker", "SharedWorker", "BroadcastChannel", "IDBFactory", "IDBDatabase", "CacheStorage", "Cache",
    "StorageManager", "StorageBucketManager", "FileSystemHandle", "FileSystemDirectoryHandle", "FileSystemFileHandle", "ServiceWorkerContainer",
    "CookieStore", "LockManager", "Lock"];
  const ATTRS = ["indexedDB", "caches", "webkitRequestFileSystem", "webkitRequestFileSystemSync", "webkitResolveLocalFileSystemURL",
    "webkitResolveLocalFileSystemSyncURL", "openDatabase", "openDatabaseSync", "sharedStorage"];
  for (let i = 0; i < IFACES.length + ATTRS.length; i++) {
    const iface = i < IFACES.length;
    const name = iface ? IFACES[i] : ATTRS[i - IFACES.length];
    const d = getOwnPropertyDescriptor(scope, name);
    if (d && d.enumerable && (iface || !d.configurable)) shadowed[shadowed.length] = name;
  }
  if (shadowed.length) {
    let names = "";
    for (let i = 0; i < shadowed.length; i++) names += (i ? "," : "") + shadowed[i];
    const what = "integrity:内置对象或平台接口在守卫之前被改过(" + names + ")";
    if (config.strict) throw new TypeErr("PromptCut 舞台:" + what);
    errors[errors.length] = what;
    return { denied, errors };
  }
  const apply = R!.apply;
  const promiseReject = P.reject;
  const promiseResolve = P.resolve;
  const promiseThen = P.prototype.then;
  const strIndexOf = Str.prototype.indexOf;
  const strSlice = Str.prototype.slice;
  const arraySlice = ArrayC.prototype.slice;
  const arrayPush = ArrayC.prototype.push;
  const MARK = Sym.for("promptcut.stageGuard");
  const prefix = Str(config.lockPrefix);

  // 与 `SCOPE_GUARD_CRITICAL` 同一份(守卫自足,不能引用外面的名字;单测核两边一致)
  const CRITICAL = ["integrity", "indexedDB", "caches", "BroadcastChannel", "SharedWorker", "Worker", "locks"];
  const fail = (what: string, e: unknown) => { errors.push(what + ":" + (e && (e as Error).message)); };
  const message = (what: string) => "PromptCut 舞台:" + what;
  const thrower = (what: string) => function () { throw new TypeErr(message(what)); };
  const rejecter = (what: string) => function () { return apply(promiseReject, P, [new TypeErr(message(what))]); };

  /** 全局入口沿原型链改成 `undefined`,锁死 */
  const removeGlobal = (key: string) => {
    try {
      let hit = false;
      for (let o: object | null = scope; o; o = getPrototypeOf(o)) {
        if (!apply(hasOwn, o, [key])) continue;
        defineProperty(o, key, { value: undefined, writable: false, configurable: false, enumerable: false });
        hit = true;
      }
      if (hit && !apply(hasOwn, scope, [key])) defineProperty(scope, key, { value: undefined, writable: false, configurable: false, enumerable: false });
      if (hit) denied.push(key);
    } catch (e) { fail(key, e); }
  };

  /** 把 `target[key]` 换成 `fn` 并锁死。已经锁过的(不可配置、不可写)认作已锁:守卫在任何卡片代码之前装,锁只可能是自己(或舞台加固)上的 */
  const replace = (target: object | null | undefined, key: string, fn: unknown, label: string): boolean => {
    if (!target) return false;
    try {
      const d = getOwnPropertyDescriptor(target, key);
      if (!d) return false;
      if (!d.configurable && !d.writable) { denied.push(label); return true; }
      if (typeof fn === "function") defineProperty(fn, MARK, { value: true });
      defineProperty(target, key, { value: fn, writable: false, configurable: false, enumerable: !!d.enumerable });
      denied.push(label);
      return true;
    } catch (e) { fail(label, e); return false; }
  };
  const protoOf = (name: string): object | null => {
    try { const C = g[name]; return C && typeof C === "function" && C.prototype ? C.prototype : null; } catch { return null; }
  };
  const neuter = (ctor: string, methods: string[], make: (what: string) => () => unknown, what: string) => {
    const proto = protoOf(ctor);
    if (!proto) return;
    for (let i = 0; i < methods.length; i++) {
      const d = getOwnPropertyDescriptor(proto, methods[i]);
      if (d && typeof d.value === "function") replace(proto, methods[i], make(what), ctor + "." + methods[i]);
    }
  };

  /* ---------- 1. 持久存储:先废原型上的读写方法(外链模块事先拿到的对象也用不了),再收全局入口 ---------- */
  const STORE = "不能用持久存储";
  neuter("IDBFactory", ["open", "deleteDatabase"], thrower, STORE);
  neuter("IDBFactory", ["databases"], rejecter, STORE);
  neuter("IDBDatabase", ["transaction", "createObjectStore", "deleteObjectStore"], thrower, STORE);
  neuter("CacheStorage", ["open", "has", "delete", "keys", "match"], rejecter, STORE);
  neuter("Cache", ["put", "add", "addAll", "match", "matchAll", "keys", "delete"], rejecter, STORE);
  neuter("StorageManager", ["getDirectory"], rejecter, STORE);
  neuter("StorageBucketManager", ["open", "keys", "delete"], rejecter, STORE);
  neuter("FileSystemHandle", ["remove", "move"], rejecter, STORE);
  neuter("FileSystemDirectoryHandle", ["getFileHandle", "getDirectoryHandle", "removeEntry", "resolve"], rejecter, STORE);
  neuter("FileSystemDirectoryHandle", ["entries", "keys", "values"], thrower, STORE);
  neuter("FileSystemFileHandle", ["getFile", "createWritable", "createSyncAccessHandle"], rejecter, STORE);
  {
    // 「这个源的存储别清」只是一个标志,但它跨文档、跨会话可读(`persisted()`),照浏览器拒绝时的样子回 false
    const proto = protoOf("StorageManager");
    if (proto && typeof getOwnPropertyDescriptor(proto, "persist")?.value === "function") {
      replace(proto, "persist", function persist() { return apply(promiseResolve, P, [false]); }, "StorageManager.persist");
    }
  }
  neuter("ServiceWorkerContainer", ["register"], rejecter, "不能注册 Service Worker");
  const GLOBALS = ["indexedDB", "caches", "webkitRequestFileSystem", "webkitRequestFileSystemSync", "webkitResolveLocalFileSystemURL",
    "webkitResolveLocalFileSystemSyncURL", "openDatabase", "openDatabaseSync", "sharedStorage"];
  for (let i = 0; i < GLOBALS.length; i++) removeGlobal(GLOBALS[i]);

  /* ---------- 2. 同源实时通道 ---------- */
  neuter("BroadcastChannel", ["postMessage"], thrower, "不能用 BroadcastChannel");
  removeGlobal("BroadcastChannel");
  removeGlobal("SharedWorker");

  /* ---------- 3. cookie 写入(Service Worker 与窗口里才有 cookieStore) ---------- */
  neuter("CookieStore", ["set", "delete"], rejecter, "不能写 cookie");

  /* ---------- 4. Web Locks:锁名按本文档加前缀 ---------- */
  try {
    const LM = protoOf("LockManager");
    const LockP = protoOf("Lock");
    const origRequest = LM ? getOwnPropertyDescriptor(LM, "request")?.value : undefined;
    const origQuery = LM ? getOwnPropertyDescriptor(LM, "query")?.value : undefined;
    const strip = (name: unknown): unknown => {
      const s = typeof name === "string" ? name : Str(name);
      return apply(strIndexOf, s, [prefix]) === 0 ? apply(strSlice, s, [prefix.length]) : s;
    };
    if (LM && typeof origRequest === "function") {
      replace(LM, "request", function request(this: unknown) {
        // eslint-disable-next-line prefer-rest-params
        const args = apply(arraySlice, arguments, []) as unknown[];
        if (args.length > 0) {
          const name = typeof args[0] === "string" ? args[0] : Str(args[0]);
          // 以 `-` 开头的是保留名:原样交给浏览器,让它照规矩报错
          if (apply(strIndexOf, name, ["-"]) !== 0) args[0] = prefix + name;
        }
        return apply(origRequest, this, args);
      }, "LockManager.request");
    }
    if (LM && typeof origQuery === "function") {
      replace(LM, "query", function query(this: unknown) {
        const only = (list: unknown) => {
          const out: unknown[] = [];
          const arr = list as { length: number; [i: number]: { name?: unknown; mode?: unknown; clientId?: unknown } } | null;
          if (!arr) return out;
          for (let i = 0; i < arr.length; i++) {
            const it = arr[i];
            if (!it || typeof it.name !== "string" || apply(strIndexOf, it.name, [prefix]) !== 0) continue;
            apply(arrayPush, out, [{ name: apply(strSlice, it.name, [prefix.length]), mode: it.mode, clientId: it.clientId }]);
          }
          return out;
        };
        return apply(promiseThen, apply(origQuery, this, []), [(snap: { held?: unknown; pending?: unknown } | null) => ({ held: only(snap && snap.held), pending: only(snap && snap.pending) })]);
      }, "LockManager.query");
    }
    const nameGet = LockP ? getOwnPropertyDescriptor(LockP, "name")?.get : undefined;
    if (LockP && nameGet) {
      const d = getOwnPropertyDescriptor(LockP, "name")!;
      if (d.configurable) {
        defineProperty(LockP, "name", { configurable: false, enumerable: !!d.enumerable, get(this: unknown) { return strip(apply(nameGet, this, [])); } });
        denied.push("Lock.name");
      }
    }
  } catch (e) { fail("locks", e); }

  /* ---------- 5. 后台线程:不给卡片起后台线程(舞台运行时自己的 GL / 声音线程经 `spawnRuntimeWorker` 起) ---------- */
  try {
    const OrigWorker = g.Worker as (Function & { prototype?: object }) | undefined;
    if (typeof OrigWorker === "function" && (OrigWorker as unknown as Record<symbol, unknown>)[MARK] === true) {
      denied.push("Worker"); // 这个全局对象已经装过(再装一遍不重复装)
    } else if (typeof OrigWorker === "function") {
      const GuardedWorker = thrower("不能起后台线程") as unknown as { prototype?: object };
      if (OrigWorker.prototype) {
        defineProperty(GuardedWorker, "prototype", { value: OrigWorker.prototype, writable: false });
        // 原型上的 constructor 指回守卫构造函数(不然 `Worker.prototype.constructor` 就拿回了原构造函数)
        defineProperty(OrigWorker.prototype, "constructor", { value: GuardedWorker, writable: false, configurable: false, enumerable: false });
      }
      defineProperty(GuardedWorker, MARK, { value: true });
      let hit = false;
      for (let o: object | null = scope; o; o = getPrototypeOf(o)) {
        if (!apply(hasOwn, o, ["Worker"])) continue;
        defineProperty(o, "Worker", { value: GuardedWorker, writable: false, configurable: false, enumerable: false });
        hit = true;
      }
      if (hit && !apply(hasOwn, scope, ["Worker"])) defineProperty(scope, "Worker", { value: GuardedWorker, writable: false, configurable: false, enumerable: false });
      if (hit) denied.push("Worker");
    }
  } catch (e) {
    // 锁不上就不给起线程(不能把错咽下去、留着原生的 Worker)
    fail("Worker", e);
    removeGlobal("Worker");
  }

  if (config.strict) {
    for (let i = 0; i < errors.length; i++) {
      for (let k = 0; k < CRITICAL.length; k++) {
        if (apply(strIndexOf, errors[i], [CRITICAL[k] + ":"]) === 0) throw new TypeErr(message("关键项没装上(" + errors[i] + ")"));
      }
    }
  }
  return { denied, errors };
}

interface RuntimeWorkerEnv {
  Worker: new (url: string, options?: WorkerOptions) => Worker;
  Blob: new (parts: BlobPart[], options?: BlobPropertyBag) => Blob;
  createObjectURL: (obj: Blob) => string;
}

const GUARD_MARK = Symbol.for("promptcut.stageGuard");
const runtimeWorkerEnvs = new WeakMap<object, RuntimeWorkerEnv>();

/** 在守卫替换全局 `Worker` 之前,把本全局对象的原生 `Worker` / `Blob` / `URL.createObjectURL` 留进模块闭包(不挂到 `window` 上) */
function captureRuntimeWorkerEnv(scope: object): void {
  if (runtimeWorkerEnvs.has(scope)) return;
  const g = scope as Record<string, unknown>;
  const W = g.Worker as RuntimeWorkerEnv["Worker"] | undefined;
  const B = g.Blob as RuntimeWorkerEnv["Blob"] | undefined;
  const U = g.URL as { createObjectURL?: (obj: Blob) => string } | undefined;
  if (typeof W !== "function" || (W as unknown as Record<symbol, unknown>)[GUARD_MARK] === true) return;
  if (typeof B !== "function" || typeof U?.createObjectURL !== "function") return;
  const wd = Object.getOwnPropertyDescriptor(scope, "Worker");
  if (wd?.enumerable) return;
  runtimeWorkerEnvs.set(scope, {
    Worker: W,
    Blob: B,
    createObjectURL: U.createObjectURL.bind(U),
  });
}

/**
 * 舞台运行时自己起专用后台线程(GL 渲染线程、声音线程):用守卫收走 `Worker` 之前留下的原生构造函数从 blob 引导脚本起。
 * 原生构造函数只留在模块闭包里,不挂到全局对象上,卡片代码(运行在 `new Function` 里,不能静态引用运行时模块)拿不到。
 */
export function spawnRuntimeWorker(scriptSource: string, options?: WorkerOptions, scope: object = globalThis): Worker {
  const g = scope as Record<string, unknown>;
  const env = runtimeWorkerEnvs.get(scope) ?? {
    Worker: g.Worker as RuntimeWorkerEnv["Worker"],
    Blob: g.Blob as RuntimeWorkerEnv["Blob"],
    createObjectURL: ((g.URL as { createObjectURL: (obj: Blob) => string }).createObjectURL).bind(g.URL),
  };
  const boot = new env.Blob([scriptSource], { type: "text/javascript" });
  const url = env.createObjectURL(boot);
  return options !== undefined ? new env.Worker(url, options) : new env.Worker(url);
}

/** 一个舞台文档(或声音线程)的锁名前缀:随机 128 位 */
export function newLockPrefix(): string {
  const bytes = new Uint8Array(16);
  try { crypto.getRandomValues(bytes); } catch { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return `pc-${hex}:`;
}

/**
 * 在舞台文档或声音线程上装守卫(装之前先把本全局对象的原生 `Worker` 留进模块闭包供运行时起专用线程)。
 *
 * `strict`:关键项没装上就抛错。声音线程入口传 true —— 那一侧没有舞台自检那样的兜底,
 * 抛错让整段线程脚本不执行、卡片 `audio()` 根本载不进来;舞台文档不传,由 `isolationCheck.ts` 按 `errors` 判「加固没装上」。
 */
export function installScopeGuard(scope: object, opts: { lockPrefix?: string; strict?: boolean } = {}): ScopeGuardResult {
  captureRuntimeWorkerEnv(scope);
  return guardStageScope(scope, { lockPrefix: opts.lockPrefix ?? newLockPrefix(), strict: opts.strict });
}
