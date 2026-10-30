/** 舞台文档边界加固。只在跨源stage安装，不修改WebRTC或网络API，不强制Trusted Types。
 * frame/object插入保护和cookie只读保留；是否能执行由分源/响应头策略与票据交接决定。
 * 这些钩子不能证明或声称阻止外发；外链图片、字体、样式和脚本照常加载。
 */

import { installScopeGuard } from "./scopeGuard.ts";

/** 会开出新脚本环境的元素(小写本地名) */
export const FRAME_TAGS: readonly string[] = Object.freeze(["iframe", "frame", "frameset", "object", "embed", "portal", "fencedframe"]);

const FRAME_HTML = /<\s*(?:[A-Za-z_][\w.-]*:)?(?:iframe|frame|frameset|object|embed|portal|fencedframe)(?![\w-])/i;
const ENTITY_DECL = /<!ENTITY/i;

/** 一段 HTML / XML 串里有没有会造出子框架的标签(或能绕过字面检查的实体声明)。纯函数,单测逐条核 */
export function htmlHasFrame(html: unknown): boolean {
  const s = typeof html === "string" ? html : String(html ?? "");
  return FRAME_HTML.test(s) || ENTITY_DECL.test(s);
}

/** 一个元素名(可带前缀、大小写不限)是不是子框架类元素。纯函数 */
export function isFrameName(name: unknown): boolean {
  const s = String(name ?? "");
  const i = s.lastIndexOf(":");
  const local = (i >= 0 ? s.slice(i + 1) : s).toLowerCase().trim();
  for (let k = 0; k < FRAME_TAGS.length; k++) if (FRAME_TAGS[k] === local) return true;
  return false;
}

export interface HardenReport {
  installed: boolean;
  /** 兼容诊断字段；本版本不移除WebRTC。 */
  webrtcRemoved: boolean;
  /** 兼容诊断字段；本阶段不安装或要求Trusted Types策略。 */
  trustedTypes: "enforced" | "created" | "unsupported" | "failed";
  /** 装上的钩子数 */
  hooks: number;
  /** 没装上的项(诊断) */
  errors: string[];
  /** 收走的持久存储入口(`denyPersistentStorage`;诊断) */
  storageDenied?: string[];
  /** 跨文档通道守卫收走或改掉的入口(`scopeGuard.ts`;诊断) */
  scopeGuarded?: string[];
}

/* ------------------------------------------------------------------ *
 * 舞台源上的持久存储
 * ------------------------------------------------------------------ */

/**
 * 舞台源上唯一还写进真实 `localStorage` 的键:取档的「这台浏览器能不能放这份内容」(`render/playability.ts`)。
 * 键里只有浏览器主版本与内容哈希,值只有 `"0"` / `"1"`;别的键、别的值一律只留在本文档的内存里。
 */
export const STAGE_STORAGE_PASSTHROUGH_KEY = /^pc\.playable\.\d{1,6}:[0-9a-f]{64}$/;
const PASSTHROUGH_VALUE = /^[01]$/;

/** 只在本文档内存里的 `Storage`:卡片代码与运行时照常读写,文档一换就没了。真实存储只在闭包里,不对外给 */
function memoryStorage(real: Storage | null, passthrough: boolean): Storage {
  const map = new Map<string, string>();
  const pass = (k: string) => passthrough && real !== null && STAGE_STORAGE_PASSTHROUGH_KEY.test(k);
  const methods: Record<string, unknown> = {
    key(i: number) { const k = [...map.keys()][Number(i)]; return k === undefined ? null : k; },
    getItem(key: string) {
      const k = String(key);
      if (pass(k)) { try { const v = real!.getItem(k); return v !== null && PASSTHROUGH_VALUE.test(v) ? v : null; } catch { return null; } }
      return map.has(k) ? map.get(k)! : null;
    },
    setItem(key: string, value: string) {
      const k = String(key), v = String(value);
      if (pass(k)) { if (PASSTHROUGH_VALUE.test(v)) { try { real!.setItem(k, v); } catch { /* 写不进就算了 */ } } return; }
      map.set(k, v);
    },
    removeItem(key: string) { map.delete(String(key)); },
    clear() { map.clear(); },
  };
  // 方法与 length 锁死(别的代码换不掉,也就截不到运行时写的东西);对象本身不冻结:`localStorage.x = 1` 这种属性写法照常,只在内存
  const store = {};
  for (const [k, fn] of Object.entries(methods)) Object.defineProperty(store, k, { value: fn, writable: false, configurable: false, enumerable: false });
  Object.defineProperty(store, "length", { get: () => map.size, configurable: false, enumerable: false });
  return store as unknown as Storage;
}

/**
 * 收走舞台源上能「活过本文档」的存储,让同步来的卡片代码写进去的东西留不到下一个舞台文档
 * (`docs/semantics/mechanism/platforms.md`「路径号按账号加项目固定」:路径号与素材地址不得留在舞台源的任何存储里;
 * 卡片参数里带着 `/media-s/<路径号>/media/<哈希>`,卡片要是把参数存下来,换了项目的舞台就能拿它去读浏览器缓存)。
 *
 * - `localStorage`、`sessionStorage`:换成只在本文档内存里的一份(运行时与卡片照常能用,不报错);
 *   只有 `STAGE_STORAGE_PASSTHROUGH_KEY` 那种键、值为 `"0"`/`"1"` 的写进真实存储,而且列不出、删不掉真实存储里的键;
 * - `indexedDB`、`caches`、旧的 `webkitRequestFileSystem*`、`openDatabase`:沿原型链整条改成 `undefined`(锁死,改不回来);
 * - 源私有文件系统 `navigator.storage.getDirectory()`、存储桶 `navigator.storageBuckets.open()`:一律拒绝。
 *
 * 窗口与 Worker 的全局对象都能用(舞台文档、声音线程)。卡片代码自己起的 Worker、`BroadcastChannel` 等跨文档通道由
 * `scopeGuard.ts` 管(舞台加固第 6c 步与声音线程入口都装上,卡片自己起后台线程直接拒绝)。同一个全局对象先后装过两边不报错。
 * `cookie` 另在 `installStageHardening` 里只读。回收走了哪些、哪些没装上。
 */
export function denyPersistentStorage(scope: object, opts: { passthrough?: boolean } = {}): { denied: string[]; errors: string[] } {
  const denied: string[] = [];
  const errors: string[] = [];
  const g = scope as Record<string, unknown>;
  const lockAlongChain = (key: string, value: unknown): boolean => {
    let hit = false;
    for (let o: object | null = scope; o; o = Object.getPrototypeOf(o)) {
      if (!Object.prototype.hasOwnProperty.call(o, key)) continue;
      Object.defineProperty(o, key, { value, writable: false, configurable: false, enumerable: false });
      hit = true;
    }
    if (hit && !Object.prototype.hasOwnProperty.call(scope, key)) Object.defineProperty(scope, key, { value, writable: false, configurable: false, enumerable: false });
    return hit;
  };
  for (const key of ["localStorage", "sessionStorage"] as const) {
    try {
      if (!(key in g)) continue;
      let real: Storage | null = null;
      try { real = (g[key] as Storage | null | undefined) ?? null; } catch { real = null; }
      if (lockAlongChain(key, memoryStorage(real, key === "localStorage" && opts.passthrough !== false))) denied.push(key);
    } catch (e) { errors.push(`${key}:${(e as Error).message}`); }
  }
  for (const key of ["indexedDB", "caches", "webkitRequestFileSystem", "webkitRequestFileSystemSync", "webkitResolveLocalFileSystemURL", "webkitResolveLocalFileSystemSyncURL", "openDatabase", "openDatabaseSync"]) {
    try { if (lockAlongChain(key, undefined)) denied.push(key); } catch (e) { errors.push(`${key}:${(e as Error).message}`); }
  }
  const refuse = (ctor: string, method: string) => {
    try {
      const proto = (g[ctor] as { prototype?: object } | undefined)?.prototype;
      if (!proto || typeof (proto as Record<string, unknown>)[method] !== "function") return;
      // 线程里先装了 `scopeGuard.ts` 的引导(它排在任何卡片代码之前):已经锁死的认作已拒绝,不重复装、不报错
      const d = Object.getOwnPropertyDescriptor(proto, method);
      if (d && !d.configurable && !d.writable) { denied.push(`${ctor}.${method}`); return; }
      Object.defineProperty(proto, method, {
        value: function () { return Promise.reject(new TypeError("PromptCut 舞台:不能用持久存储")); },
        writable: false, configurable: false, enumerable: false,
      });
      denied.push(`${ctor}.${method}`);
    } catch (e) { errors.push(`${ctor}.${method}:${(e as Error).message}`); }
  };
  refuse("StorageManager", "getDirectory");
  refuse("StorageBucketManager", "open");
  return { denied, errors };
}

/**
 * 只属于舞台文档(窗口)的两样跨文档状态:
 *
 * - `window.name`:跟着浏览上下文走(原地换项目时 `Preview.tsx` 已重建 iframe 浏览上下文;同一个浏览上下文里重载时仍作为纵深防御):
 *   上一个项目的卡片写进去的东西下一个项目的卡片读得到。装加固时先清空真实的 `window.name`,
 *   之后的读写只在本文档内存里(真实的一直是空串)。
 * - `storage` 事件:同源别的文档写真实 `localStorage` 时本文档收得到(键与新旧值)。舞台源上写进真实存储的只有取档结论
 *   (键里是内容哈希),没有路径号;仍在捕获阶段最先截住、不往下传,别的文档在写什么一律看不到。
 * - 会话历史:`history.pushState` / `replaceState` 的状态只留在本文档内存里、不改地址(真实条目里一律是 null),
 *   `history.back` / `forward` / `go` 不动;Navigation API(`navigation`)整个不给 —— 它的 `activation.from`、`entries()`
 *   能读到同一个 iframe 里上一个文档的条目地址与状态。载入时地址带 `#…` 的(只可能是退回到上一个文档自己加的条目)先去掉。
 */
export function isolateWindowState(w: object): { denied: string[]; errors: string[] } {
  const denied: string[] = [];
  const errors: string[] = [];
  const g = w as Record<string, unknown> & { addEventListener?: (t: string, f: (e: Event) => void, c: boolean) => void };
  try {
    let d: PropertyDescriptor | undefined;
    for (let o: object | null = w; o && !d; o = Object.getPrototypeOf(o)) d = Object.getOwnPropertyDescriptor(o, "name");
    if (d?.get && d.set) {
      Reflect.apply(d.set, w, [""]);
      let mem = "";
      Object.defineProperty(w, "name", {
        configurable: false, enumerable: !!d.enumerable,
        get() { return mem; },
        set(v: unknown) { mem = `${v as string}`; },
      });
      denied.push("window.name");
    }
  } catch (e) { errors.push(`name:${(e as Error).message}`); }
  try {
    if (typeof g.addEventListener === "function") {
      g.addEventListener("storage", (e: Event) => { e.stopImmediatePropagation(); }, true);
      denied.push("storage-event");
    }
  } catch (e) { errors.push(`storage-event:${(e as Error).message}`); }
  // 会话历史:条目(地址、`history.state`、Navigation API 的状态)跟着 iframe 走,下一个文档能经 `navigation.activation.from`、
  // `navigation.entries()`、`history.back()` 读到上一个文档留下的条目
  try {
    const H = (g.History as { prototype?: object } | undefined)?.prototype as Record<string, unknown> | undefined;
    const hist = g.history as History | undefined;
    if (H && hist) {
      const realReplace = H.replaceState as (data: unknown, unused: string, url?: string | URL | null) => void;
      // 本文档载入时地址上带着 `#…`(只可能是退回到上一个文档自己加的条目;编辑页给的舞台地址没有):先去掉,卡片代码看不到
      try {
        const loc = g.location as Location | undefined;
        if (loc && loc.hash) Reflect.apply(realReplace, hist, [null, "", `${loc.pathname}${loc.search}`]);
      } catch { /* 去不掉就算了 */ }
      const clone = (g.structuredClone as ((v: unknown) => unknown) | undefined) ?? ((v: unknown) => v);
      let state: unknown = null;
      const lockH = (key: string, value: unknown) => {
        if (!Object.getOwnPropertyDescriptor(H, key)) return;
        Object.defineProperty(H, key, { value, writable: false, configurable: false, enumerable: true });
        denied.push(`History.${key}`);
      };
      // 状态只在本文档内存里(照浏览器的规矩先做结构化克隆,克隆不了照样抛错);地址不改,真实条目里一律是 null
      lockH("pushState", function pushState(data: unknown) { state = clone(data); });
      lockH("replaceState", function replaceState(data: unknown) { state = clone(data); });
      for (const k of ["back", "forward", "go"]) lockH(k, function () { /* 舞台不在会话历史里走动 */ });
      const sd = Object.getOwnPropertyDescriptor(H, "state");
      if (sd?.get) { Object.defineProperty(H, "state", { configurable: false, enumerable: !!sd.enumerable, get() { return state; } }); denied.push("History.state"); }
    }
  } catch (e) { errors.push(`history:${(e as Error).message}`); }
  try {
    let hit = false;
    for (let o: object | null = w; o; o = Object.getPrototypeOf(o)) {
      if (!Object.prototype.hasOwnProperty.call(o, "navigation")) continue;
      Object.defineProperty(o, "navigation", { value: undefined, writable: false, configurable: false, enumerable: false });
      hit = true;
    }
    if (hit) denied.push("navigation");
  } catch (e) { errors.push(`navigation:${(e as Error).message}`); }
  return { denied, errors };
}

export type BreachKind = "html" | "create" | "insert" | "observed" | "define";

let report: HardenReport | null = null;

/** 上一次安装的结果;没装过给 null */
export function hardenReport(): HardenReport | null {
  return report;
}

const BLOCKED = "PromptCut 舞台:不允许子框架类元素";

/**
 * 装加固。`onBreach`:有代码试图造子框架(被哪一层拦下的)—— 调用方据此向父页上报。同一个文档只装一次。
 */
export function installStageHardening(opts: { onBreach?: (kind: BreachKind) => void; win?: Window & typeof globalThis } = {}): HardenReport {
  if (report) return report;
  const w = (opts.win ?? window) as Window & typeof globalThis & Record<string, unknown>;
  const errors: string[] = [];
  let hooks = 0;

  /* ---------- 先把要用的内置方法取下来 ---------- */
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const strLower = String.prototype.toLowerCase;
  const strLastIndexOf = String.prototype.lastIndexOf;
  const strSlice = String.prototype.slice;
  const regexpExec = RegExp.prototype.exec;
  const NodeP = w.Node.prototype, ElementP = w.Element.prototype, DocumentP = w.Document.prototype, FragmentP = w.DocumentFragment.prototype;
  const getter = (proto: object, key: string) => getOwnPropertyDescriptor(proto, key)?.get as ((this: unknown) => unknown) | undefined;
  const nodeTypeOf = getter(NodeP, "nodeType")!;
  const localNameOf = getter(ElementP, "localName")!;
  const firstElementChildOfEl = getter(ElementP, "firstElementChild")!;
  const firstElementChildOfFrag = getter(FragmentP, "firstElementChild")!;
  const firstElementChildOfDoc = getter(DocumentP, "firstElementChild")!;
  const qsEl = ElementP.querySelector, qsFrag = FragmentP.querySelector, qsDoc = DocumentP.querySelector;
  const removeEl = ElementP.remove;
  const SELECTOR = FRAME_TAGS.join(",");
  // 自己的正则不经原型上的 exec(卡片代码改 `RegExp.prototype.exec` 不影响判定)


  let reporting = false;
  const breach = (kind: BreachKind) => {
    if (reporting) return;
    reporting = true;
    try { opts.onBreach?.(kind); } catch { /* 上报失败不影响拦截 */ } finally { reporting = false; }
  };

  const frameName = (name: unknown): boolean => {
    const s = typeof name === "string" ? name : `${name as string}`;
    const i = apply(strLastIndexOf, s, [":"]) as number;
    const local = apply(strLower, i >= 0 ? apply(strSlice, s, [i + 1]) : s, []) as string;
    for (let k = 0; k < FRAME_TAGS.length; k++) if (FRAME_TAGS[k] === local) return true;
    return false;
  };

  /** 这个节点自己是、或它的子树里有子框架类元素 */
  const carriesFrame = (node: unknown): boolean => {
    if (node === null || (typeof node !== "object" && typeof node !== "function")) return false;
    let type: unknown;
    try { type = apply(nodeTypeOf, node, []); } catch { return false; } // 不是节点:让原方法自己报错
    try {
      if (type === 1) {
        if (frameName(apply(localNameOf, node, []))) return true;
        return apply(firstElementChildOfEl, node, []) !== null && apply(qsEl, node, [SELECTOR]) !== null;
      }
      if (type === 11) return apply(firstElementChildOfFrag, node, []) !== null && apply(qsFrag, node, [SELECTOR]) !== null;
      if (type === 9) return apply(firstElementChildOfDoc, node, []) !== null && apply(qsDoc, node, [SELECTOR]) !== null;
    } catch { return true; } // 查不了就当有:宁可拦错
    return false;
  };

  const lock = (target: object, key: string, value: unknown) => {
    defineProperty(target, key, { value, writable: false, configurable: false, enumerable: false });
  };

  /* 不移除WebRTC，也不建立强制Trusted Types策略：卡片出口护栏本三个版本不做。 */
  const webrtcRemoved = false;
  const trustedTypes: HardenReport["trustedTypes"] = "unsupported";

  /* ---------- 3. 不给造子框架类元素 ---------- */
  const wrapCreate = (key: "createElement" | "createElementNS", nameIndex: number) => {
    try {
      const orig = DocumentP[key] as (...a: unknown[]) => unknown;
      lock(DocumentP, key, function (this: Document) {
        // eslint-disable-next-line prefer-rest-params
        const args = arguments;
        if (frameName(args[nameIndex])) { breach("create"); throw new TypeError(BLOCKED); }
        const opt = args[nameIndex + 1] as { is?: unknown } | string | undefined;
        if (opt && typeof opt === "object" && opt.is !== undefined && frameName(opt.is)) { breach("create"); throw new TypeError(BLOCKED); }
        return apply(orig, this, args as unknown as unknown[]);
      });
      hooks++;
    } catch (e) { errors.push(`${key}:${(e as Error).message}`); }
  };
  wrapCreate("createElement", 0);
  wrapCreate("createElementNS", 1);
  try {
    const CER = w.CustomElementRegistry.prototype;
    const orig = CER.define as (...a: unknown[]) => unknown;
    lock(CER, "define", function (this: CustomElementRegistry) {
      // eslint-disable-next-line prefer-rest-params
      const args = arguments;
      const o = args[2] as { extends?: unknown } | undefined;
      if (o && o.extends !== undefined && frameName(o.extends)) { breach("define"); throw new TypeError(BLOCKED); }
      return apply(orig, this, args as unknown as unknown[]);
    });
    hooks++;
  } catch (e) { errors.push(`customElements.define:${(e as Error).message}`); }

  /* ---------- 4. 插入入口 ---------- */
  /** `which`:第几个实参是要插进去的新节点;`"all"` = 每个实参都是(可变参数的那几个)。参照节点、被换下的旧节点不查 */
  const wrapInsert = (proto: object | undefined, key: string, which: number | "all" = "all") => {
    if (!proto) return;
    const d = getOwnPropertyDescriptor(proto, key);
    if (!d || typeof d.value !== "function") return; // 这个浏览器没有这个方法
    const orig = d.value as (...a: unknown[]) => unknown;
    try {
      lock(proto, key, function (this: unknown) {
        // eslint-disable-next-line prefer-rest-params
        const args = arguments;
        if (which === "all") { for (let i = 0; i < args.length; i++) if (carriesFrame(args[i])) { breach("insert"); throw new TypeError(BLOCKED); } }
        else if (carriesFrame(args[which])) { breach("insert"); throw new TypeError(BLOCKED); }
        return apply(orig, this, args as unknown as unknown[]);
      });
      hooks++;
    } catch (e) { errors.push(`${key}:${(e as Error).message}`); }
  };
  for (const k of ["appendChild", "insertBefore", "replaceChild"]) wrapInsert(NodeP, k, 0);
  for (const k of ["append", "prepend", "before", "after", "replaceWith", "replaceChildren"]) wrapInsert(ElementP, k);
  wrapInsert(ElementP, "insertAdjacentElement", 1);
  wrapInsert(ElementP, "moveBefore", 0);
  for (const k of ["append", "prepend", "replaceChildren"]) { wrapInsert(DocumentP, k); wrapInsert(FragmentP, k); }
  wrapInsert(DocumentP, "moveBefore", 0); wrapInsert(FragmentP, "moveBefore", 0);
  for (const k of ["before", "after", "replaceWith"]) { wrapInsert(w.CharacterData?.prototype, k); wrapInsert(w.DocumentType?.prototype, k); }
  for (const k of ["insertNode", "surroundContents"]) wrapInsert(w.Range?.prototype, k, 0);

  /* HTML解析的结构边界独立于Trusted Types；普通HTML/外链script/style不受影响。 */
  const checkHtml = (value: unknown) => {
    const text = typeof value === "string" ? value : String(value ?? "");
    if (apply(regexpExec, FRAME_HTML, [text]) || apply(regexpExec, ENTITY_DECL, [text])) {
      breach("html");
      throw new TypeError(BLOCKED);
    }
  };
  const wrapHtmlMethod = (proto: object | undefined, key: string, which: number | "all") => {
    if (!proto) return;
    const d = getOwnPropertyDescriptor(proto, key);
    if (typeof d?.value !== "function") return;
    try {
      const orig = d.value;
      lock(proto, key, function (this: unknown) {
        const args = arguments;
        if (which === "all") checkHtml(Array.from(args).join(""));
        else checkHtml(args[which]);
        return apply(orig, this, args as unknown as unknown[]);
      });
      hooks++;
    } catch (e) { errors.push(`${key}:${(e as Error).message}`); }
  };
  const wrapHtmlSetter = (proto: object | undefined, key: string) => {
    if (!proto) return;
    const d = getOwnPropertyDescriptor(proto, key);
    if (!d?.set) return;
    try {
      const set = d.set;
      defineProperty(proto, key, { ...d, configurable: false, set(this: unknown, value: unknown) { checkHtml(value); return apply(set, this, [value]); } });
      hooks++;
    } catch (e) { errors.push(`${key}:${(e as Error).message}`); }
  };
  for (const key of ["innerHTML", "outerHTML"]) wrapHtmlSetter(ElementP, key);
  wrapHtmlSetter(w.ShadowRoot?.prototype, "innerHTML");
  wrapHtmlMethod(ElementP, "insertAdjacentHTML", 1);
  for (const key of ["setHTML", "setHTMLUnsafe"]) { wrapHtmlMethod(ElementP, key, 0); wrapHtmlMethod(w.ShadowRoot?.prototype, key, 0); }
  for (const key of ["write", "writeln"]) wrapHtmlMethod(DocumentP, key, "all");
  wrapHtmlMethod(w.Range?.prototype, "createContextualFragment", 0);
  wrapHtmlMethod(w.DOMParser?.prototype, "parseFromString", 0);

  /* ---------- 5. 不经 Trusted Types 的解析入口 ---------- */
  try { defineProperty(w, "XSLTProcessor", { value: undefined, writable: false, configurable: false, enumerable: false }); hooks++; } catch (e) { errors.push(`XSLTProcessor:${(e as Error).message}`); }
  try {
    const XP = w.XMLHttpRequest.prototype;
    const rt = getOwnPropertyDescriptor(XP, "responseType");
    if (rt?.get && rt.set) {
      const get = rt.get, set = rt.set;
      defineProperty(XP, "responseType", {
        configurable: false, enumerable: rt.enumerable,
        get(this: XMLHttpRequest) { return apply(get, this, []); },
        set(this: XMLHttpRequest, v: unknown) {
          if ((apply(strLower, `${v as string}`, []) as string) === "document") throw new TypeError("PromptCut 舞台:不能以文档类型取回");
          apply(set, this, [v]);
        },
      });
      hooks++;
    }
    defineProperty(XP, "responseXML", { configurable: false, enumerable: true, get() { return null; } });
    hooks++;
  } catch (e) { errors.push(`XMLHttpRequest:${(e as Error).message}`); }
  try { lock(DocumentP, "execCommand", function () { return false; }); hooks++; } catch (e) { errors.push(`execCommand:${(e as Error).message}`); }

  /* ---------- 6. cookie 只读 ---------- */
  try {
    const cd = getOwnPropertyDescriptor(DocumentP, "cookie");
    if (cd?.get) {
      const get = cd.get;
      defineProperty(DocumentP, "cookie", { configurable: false, enumerable: cd.enumerable, get(this: Document) { return apply(get, this, []); }, set() { /* 舞台不写 cookie */ } });
      hooks++;
    }
    const CS = (w as unknown as { CookieStore?: { prototype: object } }).CookieStore?.prototype;
    if (CS) for (const k of ["set", "delete"]) {
      if (typeof (CS as Record<string, unknown>)[k] === "function") { lock(CS, k, function () { return Promise.reject(new TypeError("PromptCut 舞台:不能写 cookie")); }); hooks++; }
    }
  } catch (e) { errors.push(`cookie:${(e as Error).message}`); }

  /* ---------- 6b. 不给能活过本文档的存储(路径号与素材地址留不到下一个舞台文档) ---------- */
  const storage = denyPersistentStorage(w);
  hooks += storage.denied.length;
  for (const e of storage.errors) errors.push(`storage:${e}`);

  /* ---------- 6c. 跨文档通道:卡片起的后台线程、BroadcastChannel、SharedWorker、锁名、cookieStore 写入(`scopeGuard.ts`) ---------- */
  const scoped = installScopeGuard(w);
  hooks += scoped.denied.length;
  for (const e of scoped.errors) errors.push(`scope:${e}`);

  /* ---------- 6d. 本文档自己的 window.name、storage 事件 ---------- */
  const own = isolateWindowState(w);
  hooks += own.denied.length;
  for (const e of own.errors) errors.push(`window:${e}`);

  /* ---------- 7. 兜底:真出现了就摘掉并上报 ---------- */
  try {
    const sweep = (node: Node) => {
      let type: unknown;
      try { type = apply(nodeTypeOf, node, []); } catch { return; }
      if (type !== 1) return;
      const el = node as Element;
      const found: Element[] = [];
      if (frameName(apply(localNameOf, el, []))) found.push(el);
      else {
        const list = apply(ElementP.querySelectorAll, el, [SELECTOR]) as NodeListOf<Element>;
        for (let i = 0; i < list.length; i++) found.push(list[i]);
      }
      for (let i = 0; i < found.length; i++) { try { apply(removeEl, found[i], []); } catch { /* 已经不在了 */ } }
      if (found.length) breach("observed");
    };
    new w.MutationObserver((list) => {
      for (let i = 0; i < list.length; i++) {
        const added = list[i].addedNodes;
        for (let k = 0; k < added.length; k++) sweep(added[k]);
      }
    }).observe(w.document, { childList: true, subtree: true });
    hooks++;
  } catch (e) { errors.push(`MutationObserver:${(e as Error).message}`); }

  report = { installed: true, webrtcRemoved, trustedTypes, hooks, errors, storageDenied: storage.denied, scopeGuarded: [...scoped.denied, ...own.denied] };
  return report;
}

/** 单测用:忘掉「装过了」(不撤钩子) */
export function resetHardenReportForTest(): void {
  report = null;
}
