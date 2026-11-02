/**
 * Stage document boundary hardening. Installed only on cross-origin stage, does not modify WebRTC
 * or network APIs, does not enforce Trusted Types.
 * Retains frame/object insertion protection and read-only cookies; execution capability is
 * determined by origin separation, response header policies, and ticket handoff.
 * These hooks cannot prove or claim to block outbound traffic; external images, fonts, styles,
 * and scripts load as usual.
 */

import { installScopeGuard } from "./scopeGuard.ts";

/** Elements that spawn a new script environment (lowercase local name) */
export const FRAME_TAGS: readonly string[] = Object.freeze(["iframe", "frame", "frameset", "object", "embed", "portal", "fencedframe"]);

const FRAME_HTML = /<\s*(?:[A-Za-z_][\w.-]*:)?(?:iframe|frame|frameset|object|embed|portal|fencedframe)(?![\w-])/i;
const ENTITY_DECL = /<!ENTITY/i;

/**
 * Whether an HTML/XML string contains tags that create subframes (or entity declarations that can
 * bypass literal checks). Pure function, verified item by item in unit tests.
 */
export function htmlHasFrame(html: unknown): boolean {
  const s = typeof html === "string" ? html : String(html ?? "");
  return FRAME_HTML.test(s) || ENTITY_DECL.test(s);
}

/** Whether an element name (optional prefix, case-insensitive) is a subframe element. Pure function */
export function isFrameName(name: unknown): boolean {
  const s = String(name ?? "");
  const i = s.lastIndexOf(":");
  const local = (i >= 0 ? s.slice(i + 1) : s).toLowerCase().trim();
  for (let k = 0; k < FRAME_TAGS.length; k++) if (FRAME_TAGS[k] === local) return true;
  return false;
}

export interface HardenReport {
  installed: boolean;
  /** Compatibility diagnostic field; this version does not remove WebRTC. */
  webrtcRemoved: boolean;
  /** Compatibility diagnostic field; this phase does not install or require Trusted Types policies. */
  trustedTypes: "enforced" | "created" | "unsupported" | "failed";
  /** Number of installed hooks */
  hooks: number;
  /** Items not installed (diagnostics) */
  errors: string[];
  /** Revoked persistent storage entry points (`denyPersistentStorage`; diagnostics) */
  storageDenied?: string[];
  /** Entry points revoked or modified by cross-document channel guard (`scopeGuard.ts`; diagnostics) */
  scopeGuarded?: string[];
}

/* ------------------------------------------------------------------ *
 * Persistent storage on the stage origin
 * ------------------------------------------------------------------ */

/**
 * The only key on the stage origin still written to real `localStorage`: tier selection's
 * "can this browser play this content" (`render/playability.ts`).
 * The key contains only browser major version and content hash; values are only `"0"` / `"1"`.
 * All other keys and values remain solely in this document's memory.
 */
export const STAGE_STORAGE_PASSTHROUGH_KEY = /^pc\.playable\.\d{1,6}:[0-9a-f]{64}$/;
const PASSTHROUGH_VALUE = /^[01]$/;

/**
 * In-memory `Storage` for this document only: card code and runtime read and write as usual,
 * discarded once the document changes. Real storage remains only in closure, not exposed externally.
 */
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
      if (pass(k)) { if (PASSTHROUGH_VALUE.test(v)) { try { real!.setItem(k, v); } catch { /* Ignore if write fails */ } } return; }
      map.set(k, v);
    },
    removeItem(key: string) { map.delete(String(key)); },
    clear() { map.clear(); },
  };
  // Methods and `length` are locked (other code cannot replace them, thus cannot intercept runtime
  // writes); the object itself is not frozen: property syntax like `localStorage.x = 1` works as
  // usual, in-memory only
  const store = {};
  for (const [k, fn] of Object.entries(methods)) Object.defineProperty(store, k, { value: fn, writable: false, configurable: false, enumerable: false });
  Object.defineProperty(store, "length", { get: () => map.size, configurable: false, enumerable: false });
  return store as unknown as Storage;
}

/**
 * Revokes storage on the stage origin that can "survive this document", ensuring data written by
 * synced card code cannot persist to the next stage document
 * (`docs/semantics/mechanism/platforms.md` "Path ID is fixed per account plus project": path ids
 * and asset URLs must not remain in any storage on the stage origin; card parameters carry
 * `/media-s/<path-id>/media/<hash>`, and if a card persists parameters, a stage switching projects
 * could use them to read browser cache).
 *
 * - `localStorage`, `sessionStorage`: replaced with an in-memory copy for this document only
 *   (runtime and cards work normally without errors); only keys like
 *   `STAGE_STORAGE_PASSTHROUGH_KEY` with values `"0"`/`"1"` are written to real storage, and keys
 *   in real storage cannot be enumerated or deleted;
 * - `indexedDB`, `caches`, legacy `webkitRequestFileSystem*`, `openDatabase`: set to `undefined`
 *   along the entire prototype chain (locked, cannot be reverted);
 * - Origin Private File System `navigator.storage.getDirectory()`, storage buckets
 *   `navigator.storageBuckets.open()`: always rejected.
 *
 * Works for both window and Worker global objects (stage document, sound thread). Cross-document
 * channels like card-spawned Workers and `BroadcastChannel` are handled by `scopeGuard.ts` (installed
 * in stage hardening step 6c and sound thread entry points; card-spawned background threads are
 * directly rejected). Installing on the same global object across both sides does not throw.
 * `cookie` is separately made read-only in `installStageHardening`. Returns which were revoked and
 * which were not installed.
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
      // Thread previously installed bootstrap for `scopeGuard.ts` (runs before any card code): already
      // locked items are treated as rejected, without re-installing or throwing
      const d = Object.getOwnPropertyDescriptor(proto, method);
      if (d && !d.configurable && !d.writable) { denied.push(`${ctor}.${method}`); return; }
      Object.defineProperty(proto, method, {
        value: function () { return Promise.reject(new TypeError("PromptCut stage: persistent storage is not allowed")); },
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
 * Two cross-document states specific to stage documents (windows):
 *
 * - `window.name`: follows the browsing context (when switching projects in place, `Preview.tsx`
 *   has already rebuilt the iframe browsing context; serves as defense in depth when reloaded in
 *   the same browsing context): data written by cards in a previous project could be read by cards
 *   in the next project. When installing hardening, first clear real `window.name`; subsequent
 *   reads and writes stay solely in this document's memory (real one is always an empty string).
 * - `storage` event: received by this document when other same-origin documents write to real
 *   `localStorage` (key, old and new values). The only thing written to real storage on the stage
 *   origin is tier selection conclusions (key contains content hash), without path ids; still
 *   intercepted first during capturing phase without propagating down, so writes by other documents
 *   cannot be seen at all.
 * - Session history: state for `history.pushState` / `replaceState` stays only in this document's
 *   memory without changing URL (real entries are always null); `history.back` / `forward` / `go`
 *   are untouched; Navigation API (`navigation`) is denied completely: its `activation.from` and
 *   `entries()` can read entry URLs and state from the previous document in the same iframe. Any
 *   `#…` in URL on load (can only come from navigating back to entries added by previous document)
 *   is stripped first.
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
  // Session history: entries (URL, `history.state`, Navigation API state) follow the iframe; the next
  // document can read entries left by the previous document via `navigation.activation.from`,
  // `navigation.entries()`, or `history.back()`
  try {
    const H = (g.History as { prototype?: object } | undefined)?.prototype as Record<string, unknown> | undefined;
    const hist = g.history as History | undefined;
    if (H && hist) {
      const realReplace = H.replaceState as (data: unknown, unused: string, url?: string | URL | null) => void;
      // URL carries `#…` when this document loads (can only be navigating back to an entry added by
      // the previous document; stage URL given by editor page does not have it): strip first so card
      // code cannot see it
      try {
        const loc = g.location as Location | undefined;
        if (loc && loc.hash) Reflect.apply(realReplace, hist, [null, "", `${loc.pathname}${loc.search}`]);
      } catch { /* Ignore if stripping fails */ }
      const clone = (g.structuredClone as ((v: unknown) => unknown) | undefined) ?? ((v: unknown) => v);
      let state: unknown = null;
      const lockH = (key: string, value: unknown) => {
        if (!Object.getOwnPropertyDescriptor(H, key)) return;
        Object.defineProperty(H, key, { value, writable: false, configurable: false, enumerable: true });
        denied.push(`History.${key}`);
      };
      // State stays only in this document's memory (structured clone performed first per browser rules;
      // throws if unclonable); URL unchanged, real entries are always null
      lockH("pushState", function pushState(data: unknown) { state = clone(data); });
      lockH("replaceState", function replaceState(data: unknown) { state = clone(data); });
      for (const k of ["back", "forward", "go"]) lockH(k, function () { /* Stage does not navigate through session history */ });
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

/** Result of previous installation; null if never installed */
export function hardenReport(): HardenReport | null {
  return report;
}

const BLOCKED = "PromptCut stage: subframe-type elements are not allowed";

/**
 * Install hardening. `onBreach`: code attempted to create subframes (which layer intercepted it):
 * caller reports to parent page accordingly. Installed only once per document.
 */
export function installStageHardening(opts: { onBreach?: (kind: BreachKind) => void; win?: Window & typeof globalThis } = {}): HardenReport {
  if (report) return report;
  const w = (opts.win ?? window) as Window & typeof globalThis & Record<string, unknown>;
  const errors: string[] = [];
  let hooks = 0;

  /* ---------- Fetch built-in methods to use first ---------- */
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
  // Own regex does not go through prototype exec (card code modifying `RegExp.prototype.exec`
  // does not affect checks)


  let reporting = false;
  const breach = (kind: BreachKind) => {
    if (reporting) return;
    reporting = true;
    try { opts.onBreach?.(kind); } catch { /* Reporting failure does not affect interception */ } finally { reporting = false; }
  };

  const frameName = (name: unknown): boolean => {
    const s = typeof name === "string" ? name : `${name as string}`;
    const i = apply(strLastIndexOf, s, [":"]) as number;
    const local = apply(strLower, i >= 0 ? apply(strSlice, s, [i + 1]) : s, []) as string;
    for (let k = 0; k < FRAME_TAGS.length; k++) if (FRAME_TAGS[k] === local) return true;
    return false;
  };

  /** This node itself is or its subtree contains a subframe-like element */
  const carriesFrame = (node: unknown): boolean => {
    if (node === null || (typeof node !== "object" && typeof node !== "function")) return false;
    let type: unknown;
    try { type = apply(nodeTypeOf, node, []); } catch { return false; } // Not a node: let original method throw its own error
    try {
      if (type === 1) {
        if (frameName(apply(localNameOf, node, []))) return true;
        return apply(firstElementChildOfEl, node, []) !== null && apply(qsEl, node, [SELECTOR]) !== null;
      }
      if (type === 11) return apply(firstElementChildOfFrag, node, []) !== null && apply(qsFrag, node, [SELECTOR]) !== null;
      if (type === 9) return apply(firstElementChildOfDoc, node, []) !== null && apply(qsDoc, node, [SELECTOR]) !== null;
    } catch { return true; } // Assume present if uncheckable: prefer false positives
    return false;
  };

  const lock = (target: object, key: string, value: unknown) => {
    defineProperty(target, key, { value, writable: false, configurable: false, enumerable: false });
  };

  /* Do not remove WebRTC, nor enforce Trusted Types policies: card egress guards are not done in
   * these three versions. */
  const webrtcRemoved = false;
  const trustedTypes: HardenReport["trustedTypes"] = "unsupported";

  /* ---------- 3. Disallow creating subframe elements ---------- */
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

  /* ---------- 4. Insertion entry points ---------- */
  /**
   * `which`: which argument index is the new node to insert; `"all"` = every argument (variadic
   * ones). Reference nodes and replaced old nodes are not checked.
   */
  const wrapInsert = (proto: object | undefined, key: string, which: number | "all" = "all") => {
    if (!proto) return;
    const d = getOwnPropertyDescriptor(proto, key);
    if (!d || typeof d.value !== "function") return; // This browser does not have this method
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

  /* Structural boundaries of HTML parsing are independent of Trusted Types; regular HTML and external
   * script/style are unaffected. */
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

  /* ---------- 5. Parsing entry points bypassing Trusted Types ---------- */
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
          if ((apply(strLower, `${v as string}`, []) as string) === "document") throw new TypeError("PromptCut stage: cannot be retrieved as a document type");
          apply(set, this, [v]);
        },
      });
      hooks++;
    }
    defineProperty(XP, "responseXML", { configurable: false, enumerable: true, get() { return null; } });
    hooks++;
  } catch (e) { errors.push(`XMLHttpRequest:${(e as Error).message}`); }
  try { lock(DocumentP, "execCommand", function () { return false; }); hooks++; } catch (e) { errors.push(`execCommand:${(e as Error).message}`); }

  /* ---------- 6. Read-only cookies ---------- */
  try {
    const cd = getOwnPropertyDescriptor(DocumentP, "cookie");
    if (cd?.get) {
      const get = cd.get;
      defineProperty(DocumentP, "cookie", { configurable: false, enumerable: cd.enumerable, get(this: Document) { return apply(get, this, []); }, set() { /* Stage does not write cookies */ } });
      hooks++;
    }
    const CS = (w as unknown as { CookieStore?: { prototype: object } }).CookieStore?.prototype;
    if (CS) for (const k of ["set", "delete"]) {
      if (typeof (CS as Record<string, unknown>)[k] === "function") { lock(CS, k, function () { return Promise.reject(new TypeError("PromptCut stage: cannot write cookie")); }); hooks++; }
    }
  } catch (e) { errors.push(`cookie:${(e as Error).message}`); }

  /* ---------- 6b. Disallow storage surviving this document (path id and asset URL do not persist to next stage document) ---------- */
  const storage = denyPersistentStorage(w);
  hooks += storage.denied.length;
  for (const e of storage.errors) errors.push(`storage:${e}`);

  /* ---------- 6c. Cross-document channels: card-spawned background threads, BroadcastChannel, SharedWorker, lock names, cookieStore writes (`scopeGuard.ts`) ---------- */
  const scoped = installScopeGuard(w);
  hooks += scoped.denied.length;
  for (const e of scoped.errors) errors.push(`scope:${e}`);

  /* ---------- 6d. This document's own window.name and storage events ---------- */
  const own = isolateWindowState(w);
  hooks += own.denied.length;
  for (const e of own.errors) errors.push(`window:${e}`);

  /* ---------- 7. Fallback: remove and report if one actually appears ---------- */
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
      for (let i = 0; i < found.length; i++) { try { apply(removeEl, found[i], []); } catch { /* Already gone */ } }
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

/** For unit tests: forget "already installed" (does not remove hooks) */
export function resetHardenReportForTest(): void {
  report = null;
}
