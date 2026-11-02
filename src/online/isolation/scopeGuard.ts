/**
 * Cross-document channel guards on the stage origin: both stage documents and sound threads spawned
 * by the runtime install the same copy.
 *
 * Why this is needed: the stage uses two shared cross-origin origins, running whichever project's
 * card code is opened. Card parameters carry the path id of the current project
 * (`/media-s/<path-id>/media/<hash>`, `docs/semantics/mechanism/platforms.md` "path id is fixed per
 * account plus project"); browsers cache assets for one year, so anyone knowing the path id and
 * hash can read cached assets. As long as project A's cards (even non-malicious cards just cutting
 * corners) can leave parameters on the stage origin where they "survive this document" or are
 * "concurrently visible to other documents", project B's cards can retrieve them.
 * `localStorage` and others in stage documents are revoked by `denyPersistentStorage` in `harden.ts`;
 * this file handles the rest:
 *
 * - **Background threads**: prevent cards from spawning background threads (card authoring rules
 *   already forbid cards from using `Worker` or `SharedWorker`).
 *   Global `Worker` and `Worker.prototype.constructor` are all replaced with locked error-throwing
 *   constructors (when cards call `new Worker(...)`, access `Worker.prototype.constructor`, or
 *   declare `class extends Worker`, they throw immediately); `SharedWorker` is directly revoked.
 *   The stage runtime's own two dedicated background threads (GL render thread `spawnGlWorker`,
 *   sound thread `spawnSoundWorker`) are spawned via `spawnRuntimeWorker` in this module using native
 *   constructors preserved in module closures before guard installation (not attached to `window`;
 *   cards run in `new Function` and cannot statically import runtime modules, so they cannot obtain
 *   them); the sound thread entry (`soundWorker.ts`) also installs this guard before loading any
 *   card `audio()` code.
 *   Because guard source is no longer prepended before card classic scripts, the residual issue where
 *   `"use strict"` at the start of classic scripts was invalidated no longer exists.
 * - **Persistent storage** (present in both windows and sound threads): global entry points for
 *   IndexedDB, Cache Storage, legacy file systems, `openDatabase`, and `sharedStorage` are changed to
 *   `undefined` along the prototype chain;
 *   additionally, read and write methods on prototypes of these interfaces are all changed to throw
 *   or reject (defense in depth: even if code acquired `indexedDB`, `caches`, `navigator.storage`
 *   objects, or opened databases prior to the guard, it cannot open databases, start transactions,
 *   write to cache, or open files).
 *   Origin Private File System and storage buckets reject; `navigator.storage.persist()` returns
 *   false; Service Worker registration rejects (Content Security Policy blocks it as well).
 * - **Same-origin real-time channels**: `BroadcastChannel` is denied (prototype methods for sending
 *   messages are also changed to throw);
 *   Web Locks lock names add a random prefix (`lockPrefix`) based on this global environment; locks
 *   from other documents (other projects) cannot be seen (`query()` only returns those with this
 *   prefix), contested, or held under the same name.
 * - **`cookieStore` writes**: `set` and `delete` reject (those already locked in section 6 of
 *   `harden.ts` in stage documents are recognized as locked here).
 *
 * **Self-contained function**: the function body references no identifiers from this module or other
 * modules, using only standard built-in objects (and accessing everything from literals whenever
 * possible; platform interfaces to be read are checked first to ensure they are not shadowed by
 * enumerable or non-configurable properties prior to the guard); unit tests execute its source code
 * in a `vm` environment containing only standard built-ins to verify this.
 */

export interface ScopeGuardConfig {
  /** Web Locks lock name prefix: one random string per stage document (or sound thread) */
  lockPrefix: string;
  /**
   * Strict mode: throws if guard checks fail or critical items are not installed.
   * Not set in stage documents: failed checks and uninstalled critical items are recorded into
   * `errors`, and stage self-check (`isolationCheck.ts`) determines "hardening not installed",
   * preventing user cards from executing.
   */
  strict?: boolean;
}

/**
 * Critical items: if not installed, throws in strict mode and stage self-check rules "hardening
 * not installed" (items in `errors` starting with "name:").
 */
export const SCOPE_GUARD_CRITICAL = ["integrity", "indexedDB", "caches", "BroadcastChannel", "SharedWorker", "Worker", "locks"] as const;

export interface ScopeGuardResult {
  /** Revoked or modified entry points (diagnostics) */
  denied: string[];
  /** Items not installed (diagnostics) */
  errors: string[];
}

/**
 * Installs guard on a global object (window or thread). Installing twice on the same global
 * object does not throw (the second time is recognized as locked).
 * **Self-contained**: see file header; do not reference any names outside the function body when
 * modifying this function.
 */
export function guardStageScope(scope: object, config: ScopeGuardConfig): ScopeGuardResult {
  "use strict";
  const denied: string[] = [];
  const errors: string[] = [];
  const g = scope as Record<string, any>;
  /*
   * 0. Built-in objects. Obtain from literals whenever possible without reading global names
   * (preventing global names from being shadowed prior to the guard).
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
  // Two without literals: function declarations can only create functions; if still an object, it is native
  const shadowed: string[] = [];
  const R = typeof Reflect === "object" && Reflect !== null ? Reflect : null;
  const J = typeof JSON === "object" && JSON !== null ? JSON : null;
  if (!R) shadowed[shadowed.length] = "Reflect";
  if (!J) shadowed[shadowed.length] = "JSON";
  /*
   * Platform interfaces to read: after top-level function declarations replace them, what remains on
   * the global object are "enumerable, non-configurable" own properties (spec CreateGlobalFunctionBinding).
   * Interface objects (constructors) native to the browser are always non-enumerable, so an interface
   * object is considered replaced if enumerable; global properties and methods (`indexedDB` etc.) are
   * natively enumerable and configurable. Those locked by this guard and stage hardening are non-enumerable.
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
    const what = "integrity: built-in objects or platform APIs were modified before the guard (" + names + ")";
    if (config.strict) throw new TypeErr("PromptCut stage: " + what);
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

  // Same as `SCOPE_GUARD_CRITICAL` (guard is self-contained and cannot reference external names;
  // unit tests verify both match)
  const CRITICAL = ["integrity", "indexedDB", "caches", "BroadcastChannel", "SharedWorker", "Worker", "locks"];
  const fail = (what: string, e: unknown) => { errors.push(what + ":" + (e && (e as Error).message)); };
  const message = (what: string) => "PromptCut stage: " + what;
  const thrower = (what: string) => function () { throw new TypeErr(message(what)); };
  const rejecter = (what: string) => function () { return apply(promiseReject, P, [new TypeErr(message(what))]); };

  /** Global entry points changed to `undefined` along prototype chain, locked */
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

  /**
   * Replaces `target[key]` with `fn` and locks it. Already locked items (non-configurable,
   * non-writable) are recognized as locked: guard is installed before any card code, so locks can
   * only be from itself (or stage hardening).
   */
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

  /* ---------- 1. Persistent storage: first disable prototype read/write methods (objects obtained in advance by external modules won't work either), then revoke global entry points ---------- */
  const STORE = "cannot use persistent storage";
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
    // "Do not clear storage for this origin" is only a flag, but it is readable across documents
    // and sessions (`persisted()`); return false matching browser rejection behavior
    const proto = protoOf("StorageManager");
    if (proto && typeof getOwnPropertyDescriptor(proto, "persist")?.value === "function") {
      replace(proto, "persist", function persist() { return apply(promiseResolve, P, [false]); }, "StorageManager.persist");
    }
  }
  neuter("ServiceWorkerContainer", ["register"], rejecter, "cannot register a Service Worker");
  const GLOBALS = ["indexedDB", "caches", "webkitRequestFileSystem", "webkitRequestFileSystemSync", "webkitResolveLocalFileSystemURL",
    "webkitResolveLocalFileSystemSyncURL", "openDatabase", "openDatabaseSync", "sharedStorage"];
  for (let i = 0; i < GLOBALS.length; i++) removeGlobal(GLOBALS[i]);

  /* ---------- 2. Same-origin real-time channels ---------- */
  neuter("BroadcastChannel", ["postMessage"], thrower, "cannot use BroadcastChannel");
  removeGlobal("BroadcastChannel");
  removeGlobal("SharedWorker");

  /* ---------- 3. cookie writes (cookieStore only exists in Service Worker and windows) ---------- */
  neuter("CookieStore", ["set", "delete"], rejecter, "cannot write cookies");

  /* ---------- 4. Web Locks: lock names prefixed per this document ---------- */
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
          // Names starting with `-` are reserved: pass through to the browser to throw errors per spec
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

  /* ---------- 5. Background threads: disallow cards from spawning background threads (stage runtime spawns its own GL / sound threads via `spawnRuntimeWorker`) ---------- */
  try {
    const OrigWorker = g.Worker as (Function & { prototype?: object }) | undefined;
    if (typeof OrigWorker === "function" && (OrigWorker as unknown as Record<symbol, unknown>)[MARK] === true) {
      denied.push("Worker"); // This global object is already installed (re-installing does not repeat)
    } else if (typeof OrigWorker === "function") {
      const GuardedWorker = thrower("cannot start a background thread") as unknown as { prototype?: object };
      if (OrigWorker.prototype) {
        defineProperty(GuardedWorker, "prototype", { value: OrigWorker.prototype, writable: false });
        // Prototype constructor points back to guard constructor (otherwise
        // `Worker.prototype.constructor` recovers original constructor)
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
    // Disallow thread spawning if locking fails (cannot swallow errors and leave native Worker)
    fail("Worker", e);
    removeGlobal("Worker");
  }

  if (config.strict) {
    for (let i = 0; i < errors.length; i++) {
      for (let k = 0; k < CRITICAL.length; k++) {
        if (apply(strIndexOf, errors[i], [CRITICAL[k] + ":"]) === 0) throw new TypeErr(message("critical items failed to install (" + errors[i] + ")"));
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

/**
 * Retain this global object's native `Worker` / `Blob` / `URL.createObjectURL` in module closure
 * before guard replaces global `Worker` (not attached to `window`).
 */
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
 * Stage runtime spawns its dedicated background threads (GL render thread, sound thread): uses the
 * native constructor preserved before the guard revokes `Worker` to spawn from a blob bootstrap script.
 * Native constructors remain only in module closures and are not attached to global objects; card
 * code (running in `new Function`, unable to statically import runtime modules) cannot access them.
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

/** Lock name prefix for a stage document (or sound thread): random 128 bits */
export function newLockPrefix(): string {
  const bytes = new Uint8Array(16);
  try { crypto.getRandomValues(bytes); } catch { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return `pc-${hex}:`;
}

/**
 * Installs guard on a stage document or sound thread (preserves native `Worker` of this global
 * object into module closure before installation for runtime to spawn dedicated threads).
 *
 * `strict`: throws if critical items fail to install. Sound thread entry passes true: that side
 * lacks fallback like stage self-check, so throwing prevents the entire thread script from
 * executing, ensuring card `audio()` is not loaded at all; stage documents omit it, with
 * `isolationCheck.ts` ruling "hardening not installed" based on `errors`.
 */
export function installScopeGuard(scope: object, opts: { lockPrefix?: string; strict?: boolean } = {}): ScopeGuardResult {
  captureRuntimeWorkerEnv(scope);
  return guardStageScope(scope, { lockPrefix: opts.lockPrefix ?? newLockPrefix(), strict: opts.strict });
}
