/**
 * Stage-origin cross-document channel guard (`scopeGuard.ts`) and stage document's own
 * cross-document state (`isolateWindowState` in `harden.ts`).
 * Verifies logic with browser-like global object; behavior in real headless Chrome verified by
 * `scopeGuard.browser-check.mjs` (not in npm test).
 * Run: node --test src/online/isolation/scopeGuard.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { guardStageScope, installScopeGuard, newLockPrefix, SCOPE_GUARD_CRITICAL, spawnRuntimeWorker } from "./scopeGuard.ts";
import { denyPersistentStorage, isolateWindowState } from "./harden.ts";

const PREFIX = "pc-0123456789abcdef0123456789abcdef:";

/**
 * Browser-like global object: Blob / URL / Worker / storage / channel / lock, all configurable
 * and writable (same as browser)
 */
function fakeScope() {
  const scope = {};
  const registry = new Map();
  let n = 0;
  class Blob {
    constructor(parts = [], opts = {}) { this.parts = [...parts]; this.type = opts.type ?? ""; }
  }
  const URL = {
    createObjectURL(obj) { if (!(obj instanceof Blob)) throw new TypeError("not a blob"); const u = `blob:fake/${++n}`; registry.set(u, obj); return u; },
    revokeObjectURL(u) { registry.delete(String(u)); },
  };
  const spawned = [];
  class Worker { constructor(url, opts) { const blob = registry.get(String(url)); spawned.push({ url: String(url), opts, blob }); this.url = String(url); } }
  class IDBFactory { open() { return "opened"; } deleteDatabase() { return "deleted"; } async databases() { return ["db"]; } cmp() { return 0; } }
  class IDBDatabase { transaction() { return "tx"; } createObjectStore() { return "store"; } deleteObjectStore() {} }
  class CacheStorage { async open() { return "cache"; } async has() { return true; } async delete() { return true; } async keys() { return []; } async match() { return null; } }
  class Cache { async put() {} async add() {} async addAll() {} async match() {} async matchAll() {} async keys() {} async delete() {} }
  class StorageManager { async getDirectory() { return "opfs"; } async persist() { return true; } async persisted() { return true; } async estimate() { return { quota: 1 }; } }
  class StorageBucketManager { async open() { return "bucket"; } async keys() { return []; } async delete() {} }
  class FileSystemHandle { async remove() {} async move() {} }
  class FileSystemDirectoryHandle extends FileSystemHandle { async getFileHandle() {} async getDirectoryHandle() {} async removeEntry() {} async resolve() {} entries() {} keys() {} values() {} }
  class FileSystemFileHandle extends FileSystemHandle { async getFile() {} async createWritable() {} async createSyncAccessHandle() {} }
  class ServiceWorkerContainer { async register() { return "reg"; } async getRegistrations() { return []; } }
  class BroadcastChannel { constructor(name) { this.name = name; } postMessage(m) { return `sent:${m}`; } }
  class SharedWorker {}
  class CookieStore { async set() { return "set"; } async delete() { return "deleted"; } async get() { return null; } }
  const lockCalls = [];
  class Lock { constructor(name) { this._name = name; } get name() { return this._name; } }
  class LockManager {
    request(...args) { lockCalls.push(args[0]); const cb = args[args.length - 1]; return Promise.resolve(cb(new Lock(args[0]))); }
    async query() { return { held: [{ name: `${PREFIX}mine`, mode: "exclusive", clientId: "c1" }, { name: "pc-other:theirs", mode: "exclusive", clientId: "c2" }, { name: "raw", mode: "shared", clientId: "c3" }], pending: [{ name: `${PREFIX}waiting`, mode: "exclusive", clientId: "c1" }] }; }
  }
  // Interface objects are non-enumerable as in browsers (guard recognizes interface objects replaced
  // by top-level function declarations via "enumerable")
  const ifaces = {
    Blob, URL, Worker, IDBFactory, IDBDatabase, CacheStorage, Cache, StorageManager, StorageBucketManager, FileSystemHandle, FileSystemDirectoryHandle,
    FileSystemFileHandle, ServiceWorkerContainer, BroadcastChannel, SharedWorker, CookieStore, Lock, LockManager,
  };
  for (const [k, v] of Object.entries(ifaces)) Object.defineProperty(scope, k, { value: v, writable: true, configurable: true, enumerable: false });
  Object.assign(scope, {
    indexedDB: new IDBFactory(), caches: new CacheStorage(), webkitRequestFileSystem: () => {}, sharedStorage: {},
    navigator: { storage: new StorageManager(), storageBuckets: new StorageBucketManager(), locks: new LockManager(), serviceWorker: new ServiceWorkerContainer() },
    cookieStore: new CookieStore(),
  });
  return { scope, registry, spawned, lockCalls };
}

const install = (scope) => installScopeGuard(scope, { lockPrefix: PREFIX });

test("OCS-H-11 The guard is self-contained: the source can be taken out and still installs in an environment with only standard built-in objects", () => {
  const src = guardStageScope.toString();
  const { scope } = fakeScope();
  // Only standard built-ins (new vm context) and mock global provided: referencing outer names in
  // function body causes ReferenceError
  const ctx = vm.createContext({ fakeSelf: scope });
  const r = vm.runInContext(`(${src})(fakeSelf, ${JSON.stringify({ lockPrefix: PREFIX })})`, ctx);
  assert.equal(r.errors.length, 0, [...r.errors].join("; ")); // Array from another environment: do not use deepEqual (different prototype)
  for (const k of ["Worker", "indexedDB", "BroadcastChannel", "SharedWorker", "LockManager.request", "CookieStore.set", "IDBFactory.open"]) assert.ok(r.denied.includes(k), k);
  assert.equal(scope.indexedDB, undefined);
  assert.throws(() => new scope.Worker("blob:fake/1"), /PromptCut stage: cannot start a background thread/);
  assert.match(newLockPrefix(), /^pc-[0-9a-f]{32}:$/);
});

test("OCS-H-12 Background threads: any background thread started by a card is rejected (any address, constructor workaround or subclass throws); runtime-specific threads start as usual via spawnRuntimeWorker", () => {
  const { scope, spawned } = fakeScope();
  const OrigWorker = scope.Worker;
  const r = install(scope);
  assert.deepEqual(r.errors, []);
  const card = new scope.Blob(["postMessage(1)"]);
  const url = scope.URL.createObjectURL(card);

  // Cards spawning Worker from any URL or module type always throw
  for (const [u, opts] of [
    [url, undefined],
    [url, { name: "n", type: "classic" }],
    [url, { type: "module" }],
    [`${url}#frag`, undefined],
    ["/worker.js", undefined],
    ["https://x.test/w.js", undefined],
    ["data:text/javascript,1", undefined],
    ["blob:fake/999", undefined],
  ]) {
    assert.throws(() => new scope.Worker(u, opts), /PromptCut stage: cannot start a background thread/, String(u));
  }
  assert.throws(() => scope.Worker(url), /PromptCut stage: cannot start a background thread/);

  // Bypass: original constructor cannot be retrieved or replaced; prototype.constructor,
  // subclasses, Reflect.construct likewise rejected
  assert.equal(scope.Worker.prototype.constructor, scope.Worker);
  assert.throws(() => new scope.Worker.prototype.constructor(url), /PromptCut stage: cannot start a background thread/);
  assert.throws(() => Reflect.construct(scope.Worker, [url]), /PromptCut stage: cannot start a background thread/);
  assert.throws(() => { OrigWorker.prototype.constructor = OrigWorker; }, TypeError);
  assert.equal(Reflect.set(scope, "Worker", OrigWorker), false);
  assert.throws(() => Object.defineProperty(scope, "Worker", { value: OrigWorker }), TypeError);
  class Sub extends scope.Worker {}
  assert.throws(() => new Sub(url), /PromptCut stage: cannot start a background thread/);
  assert.equal(spawned.length, 0, "none of the card's attempts started a thread");

  // Stage runtime's own GL / sound threads spawn via native constructor in module closure
  const gl = spawnRuntimeWorker("importScripts('/glWorker.js');", undefined, scope);
  assert.ok(gl instanceof OrigWorker && gl instanceof scope.Worker);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].blob.parts, ["importScripts('/glWorker.js');"]);
  const snd = spawnRuntimeWorker("import '/soundWorker.ts';", { type: "module", name: "pc-card-sound" }, scope);
  assert.ok(snd instanceof OrigWorker);
  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned[1].opts, { type: "module", name: "pc-card-sound" });

  // Wiring check: GL and sound thread spawn via spawnRuntimeWorker; sound thread entry installs both
  // denyPersistentStorage and installScopeGuard (strictly: thread halts if critical items fail)
  const glSpawnSrc = fs.readFileSync(new URL("../../render/gl/spawnWorker.ts", import.meta.url), "utf8");
  const sndSpawnSrc = fs.readFileSync(new URL("../cardRuntime/soundSpawn.ts", import.meta.url), "utf8");
  const sndWorkerSrc = fs.readFileSync(new URL("../cardRuntime/soundWorker.ts", import.meta.url), "utf8");
  assert.match(glSpawnSrc, /spawnRuntimeWorker\(/);
  assert.ok(!/new Worker\(/.test(glSpawnSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")), "spawnGlWorker does not call the global new Worker directly");
  assert.match(sndSpawnSrc, /spawnRuntimeWorker\(/);
  assert.ok(!/new Worker\(/.test(sndSpawnSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")), "spawnSoundWorker does not call the global new Worker directly");
  const dpsIdx = sndWorkerSrc.indexOf("denyPersistentStorage(self);");
  const sgIdx = sndWorkerSrc.indexOf("installScopeGuard(self, { strict: true });");
  const threadIdx = sndWorkerSrc.indexOf("createSoundThread(");
  assert.ok(dpsIdx > 0 && sgIdx > dpsIdx && threadIdx > sgIdx, "before creating the thread, the sound thread installs denyPersistentStorage and then installScopeGuard(strict)");
});

/**
 * In a mock global environment, simulates "top-level declaration or property tampering before guard
 * installation", verifying the guard's built-in object extraction and platform interface integrity
 * checks.
 */
function runGuardWithPreDecl(cardDecl = "", declare = []) {
  const t = fakeScope();
  for (const name of declare) Object.defineProperty(t.scope, name, { value: function () {}, writable: true, enumerable: true, configurable: false });
  const src = guardStageScope.toString();
  const cfg = JSON.stringify({ lockPrefix: PREFIX, source: src, strict: true });
  const prelude = `;(${src})(this, ${cfg});\n`;
  const ctx = vm.createContext(t.scope);
  let error = null;
  try { vm.runInContext(prelude + cardDecl + "\n;globalThis.__ran = true;", ctx); } catch (e) { error = e; }
  return { ...t, error, ran: t.scope.__ran === true };
}

test("OCS-H-17 Guard integrity check: top-level declarations shadowing self, JSON or platform interfaces cannot bypass the guard; if the check fails, the whole script does not run", () => {
  // Control: no shadowing, guard installed, subsequent code runs normally, Worker is rejected
  const ok = runGuardWithPreDecl("var probe = typeof indexedDB;");
  assert.equal(ok.error, null, String(ok.error));
  assert.equal(ok.ran, true);
  assert.equal(ok.scope.indexedDB, undefined);
  assert.equal(ok.scope.BroadcastChannel, undefined);
  assert.throws(() => new ok.scope.Worker("blob:fake/1"), /PromptCut stage: cannot start a background thread/);

  // ① Shadow self: the guard does not read self, still installs on the real global
  const s = runGuardWithPreDecl("function self() {}\nvar probe = typeof indexedDB;");
  assert.equal(s.error, null, String(s.error));
  assert.equal(s.ran, true);
  assert.equal(s.scope.indexedDB, undefined, "shadowing self still withdrew indexedDB");
  assert.equal(s.scope.caches, undefined);
  assert.equal(s.scope.BroadcastChannel, undefined);

  // ② Shadow JSON / Reflect / platform interfaces: verification fails; under strict, the whole
  // block throws and does not execute
  const j = runGuardWithPreDecl("function JSON() {}\nvar probe = 1;");
  assert.ok(j.error, "shadowing JSON: the whole script throws");
  assert.match(String(j.error && j.error.message), /PromptCut stage:\s*integrity:.*JSON/);
  assert.equal(j.ran, false, "not a single line of the following code ran");
  for (const name of ["Reflect", "Blob", "URL", "Worker", "IDBFactory", "indexedDB", "BroadcastChannel", "LockManager"]) {
    const r = runGuardWithPreDecl(`function ${name}() {}\n`, name === "Reflect" ? [] : [name]);
    assert.ok(r.error && /integrity/.test(r.error.message), `shadowing ${name}: whole script does not run (${r.error && r.error.message})`);
    assert.equal(r.ran, false, name);
  }
  // Same name in top-level let/const/class: guard access hits temporal dead zone ReferenceError, skipping whole block
  for (const decl of ["let Reflect = {};", "const JSON = {};"]) {
    const r = runGuardWithPreDecl(decl + "\n");
    assert.ok(r.error instanceof ReferenceError || r.error?.name === "ReferenceError", decl);
    assert.equal(r.ran, false, decl);
  }
  // Guard does not read Object by name (obtained from literal): top-level `class Object {}` or
  // shadowing standard built-in constructors does not affect the guard
  const cls = runGuardWithPreDecl("class Object {}\n");
  assert.equal(cls.error, null, String(cls.error));
  assert.equal(cls.ran, true);
  assert.equal(cls.scope.indexedDB, undefined);
  const lit = runGuardWithPreDecl("function Object() {}\nfunction String() {}\nfunction Symbol() {}\nfunction Promise() {}\nfunction TypeError() {}\nfunction Array() {}\nfunction Map() {}\n");
  assert.equal(lit.error, null, String(lit.error));
  assert.equal(lit.scope.indexedDB, undefined);
  assert.equal(lit.scope.BroadcastChannel, undefined);

  // Key items manifest: the copy built into the guard matches the exported copy
  const src = guardStageScope.toString();
  const m = /const CRITICAL = (\[[^\]]*\])/.exec(src);
  assert.ok(m, "the guard contains a manifest of critical items");
  assert.deepEqual(JSON.parse(m[1]), [...SCOPE_GUARD_CRITICAL]);
});

test("OCS-H-18 Locking Worker fails: not swallowed, the Worker is withdrawn; throws under strict; in the stage document the error is only recorded (the self-check decides not to run)", () => {
  // Prototype locked: defineProperty(prototype.constructor) in the Worker-locking section throws
  const a = fakeScope();
  Object.freeze(a.scope.Worker.prototype);
  const r = install(a.scope);
  assert.ok(r.errors.some((e) => e.startsWith("Worker:")), r.errors.join("; "));
  assert.equal(a.scope.Worker, undefined, "Worker was withdrawn");
  const b = fakeScope();
  Object.freeze(b.scope.Worker.prototype);
  assert.throws(() => guardStageScope(b.scope, { lockPrefix: PREFIX, strict: true }), /critical items failed to install \(Worker:/);
  // Verification fails in stage document (non-strict): records an integrity entry and installs nothing
  const c = fakeScope();
  Object.defineProperty(c.scope, "Blob", { value: function Blob() {}, enumerable: true, configurable: false, writable: true });
  const rc = install(c.scope);
  assert.ok(rc.errors.some((e) => e.startsWith("integrity:")), rc.errors.join("; "));
});

test("OCS-H-13 Persistent storage and same-origin channels: no global entry points, and objects obtained earlier are unusable too; cookieStore writes are rejected; persist returns false; installing twice and calling denyPersistentStorage again both raise no error", async () => {
  const { scope } = fakeScope();
  const captured = { idb: scope.indexedDB, caches: scope.caches, storage: scope.navigator.storage, BC: scope.BroadcastChannel, db: new scope.IDBDatabase(), sw: scope.navigator.serviceWorker };
  const bc = new captured.BC("x");
  const r = install(scope);
  assert.deepEqual(r.errors, []);
  for (const k of ["indexedDB", "caches", "webkitRequestFileSystem", "sharedStorage", "BroadcastChannel", "SharedWorker"]) {
    assert.equal(scope[k], undefined, k);
    assert.equal(Reflect.set(scope, k, {}), false, k);
  }
  assert.throws(() => captured.idb.open("leak"), /persistent storage/);
  assert.throws(() => captured.idb.deleteDatabase("leak"), /persistent storage/);
  await assert.rejects(captured.idb.databases(), /persistent storage/);
  assert.equal(captured.idb.cmp(1, 2), 0, "unrelated methods stay as before");
  assert.throws(() => captured.db.transaction(["s"], "readwrite"), /persistent storage/);
  await assert.rejects(captured.caches.open("c"), /persistent storage/);
  await assert.rejects(new scope.Cache().put("k", "v"), /persistent storage/);
  await assert.rejects(captured.storage.getDirectory(), /persistent storage/);
  assert.equal(await captured.storage.persist(), false);
  assert.deepEqual(await captured.storage.estimate(), { quota: 1 });
  await assert.rejects(scope.navigator.storageBuckets.open("b"), /persistent storage/);
  await assert.rejects(new scope.FileSystemFileHandle().createWritable(), /persistent storage/);
  assert.throws(() => new scope.FileSystemDirectoryHandle().entries(), /persistent storage/);
  await assert.rejects(captured.sw.register("/sw.js"), /Service Worker/);
  assert.throws(() => bc.postMessage("leak"), /BroadcastChannel/);
  await assert.rejects(scope.cookieStore.set("a", "b"), /cookie/);
  await assert.rejects(scope.cookieStore.delete("a"), /cookie/);
  assert.equal(await scope.cookieStore.get("a"), null);
  assert.throws(() => Object.defineProperty(scope.IDBFactory.prototype, "open", { value: () => "x" }), TypeError);

  // Install again: does not throw
  assert.deepEqual(install(scope).errors, []);
  // Sound thread: calling denyPersistentStorage and installScopeGuard in sequence does not throw
  const d = denyPersistentStorage(scope);
  assert.deepEqual(d.errors, []);
  assert.ok(d.denied.includes("StorageManager.getDirectory"));

  // In stage document, harden.ts section 6 locked cookieStore first: treated as locked, does not throw
  const doc = fakeScope();
  Object.defineProperty(doc.scope.CookieStore.prototype, "set", { value: async () => { throw new TypeError("earlier lock"); }, writable: false, configurable: false });
  const r2 = install(doc.scope);
  assert.deepEqual(r2.errors, []);
  assert.ok(r2.denied.includes("CookieStore.set"));
});

test("OCS-H-14 Lock names are prefixed per document: this document uses them as usual, locks of other documents are invisible", async () => {
  const { scope, lockCalls } = fakeScope();
  install(scope);
  const name = await scope.navigator.locks.request("sid-lock", (l) => l.name);
  assert.equal(lockCalls.at(-1), `${PREFIX}sid-lock`, "the real lock name carries the prefix");
  assert.equal(name, "sid-lock", "the name seen in the callback has the prefix stripped");
  await scope.navigator.locks.request("opt", { ifAvailable: true }, () => {});
  assert.equal(lockCalls.at(-1), `${PREFIX}opt`);
  await scope.navigator.locks.request("-reserved", () => {});
  assert.equal(lockCalls.at(-1), "-reserved", "reserved names are passed to the browser as is so it reports the error");
  const q = await scope.navigator.locks.query();
  assert.deepEqual(q, { held: [{ name: "mine", mode: "exclusive", clientId: "c1" }], pending: [{ name: "waiting", mode: "exclusive", clientId: "c1" }] });
});

/** Mock window: `name` is a prototype accessor (value in closure); has History, navigation, event listeners */
function fakeWindow({ name = "", hash = "" } = {}) {
  const real = { name, state: null, url: `/editor/stage.html?stage=1${hash}`, moves: 0 };
  const proto = {};
  Object.defineProperty(proto, "name", { configurable: true, enumerable: true, get: () => real.name, set: (v) => { real.name = String(v); } });
  const w = Object.create(proto);
  class History {
    get state() { return real.state; }
    pushState(s, _u, url) { real.state = s; if (url !== undefined) real.url = url; }
    replaceState(s, _u, url) { real.state = s; if (url !== undefined) real.url = url; }
    back() { real.moves--; } forward() { real.moves++; } go(n) { real.moves += n; }
  }
  w.History = History;
  w.history = new History();
  Object.defineProperty(w, "navigation", { configurable: true, enumerable: true, get: () => ({ activation: { from: { url: "leak" } } }) });
  w.location = { get hash() { const i = real.url.indexOf("#"); return i >= 0 ? real.url.slice(i) : ""; }, pathname: "/editor/stage.html", search: "?stage=1" };
  const listeners = [];
  w.addEventListener = (type, fn, capture) => listeners.push({ type, fn, capture });
  w.structuredClone = structuredClone;
  return { w, real, listeners };
}

test("OCS-H-15 The stage document's own cross-document state: window.name is cleared and kept only in memory; session history is only in memory and does not navigate; navigation is absent; storage events are intercepted; the # in the address is removed", () => {
  const { w, real, listeners } = fakeWindow({ name: "leak-from-last-project", hash: "#leak" });
  const r = isolateWindowState(w);
  assert.deepEqual(r.errors, []);
  assert.equal(real.name, "", "the real window.name was cleared");
  assert.equal(w.name, "");
  w.name = "sid-of-this-project";
  assert.equal(w.name, "sid-of-this-project", "read and write as usual within this document");
  assert.equal(real.name, "", "the real window.name stays empty");
  assert.throws(() => Object.defineProperty(w, "name", { get: () => real.name }), TypeError, "cannot be restored");

  assert.equal(real.url, "/editor/stage.html?stage=1", "the # in the address was removed on load");
  w.history.pushState({ sid: "x" }, "", "?sid=x#y");
  assert.deepEqual(w.history.state, { sid: "x" });
  assert.equal(real.state, null, "the real entry holds no state");
  assert.equal(real.url, "/editor/stage.html?stage=1", "address unchanged");
  w.history.replaceState({ sid: "z" }, "");
  assert.deepEqual(w.history.state, { sid: "z" });
  assert.throws(() => w.history.pushState(() => {}, ""), /could not be cloned/, "still throws when it cannot be cloned");
  w.history.back(); w.history.go(-2); w.history.forward();
  assert.equal(real.moves, 0, "does not navigate through session history");
  assert.equal(w.navigation, undefined);
  assert.equal(Reflect.set(w, "navigation", {}), false);

  const storage = listeners.find((l) => l.type === "storage");
  assert.ok(storage && storage.capture === true, "listens for storage in the capture phase");
  let stopped = false;
  storage.fn({ stopImmediatePropagation: () => { stopped = true; } });
  assert.ok(stopped, "the storage event does not propagate further");
});

test("OCS-H-16 Wiring: stage hardening installs the channel guard and this-document state isolation (before the MutationObserver fallback, before any card code)", () => {
  const harden = fs.readFileSync(new URL("./harden.ts", import.meta.url), "utf8");
  const body = harden.slice(harden.indexOf("export function installStageHardening"));
  const scoped = body.indexOf("const scoped = installScopeGuard(w);");
  const own = body.indexOf("const own = isolateWindowState(w);");
  const storage = body.indexOf("const storage = denyPersistentStorage(w);");
  assert.ok(storage > 0 && scoped > storage && own > scoped, "6b storage → 6c channel guard → 6d this document's state");
  assert.ok(own < body.indexOf("new w.MutationObserver"));
  assert.match(body, /scopeGuarded: \[\.\.\.scoped\.denied, \.\.\.own\.denied\]/);
  assert.equal(typeof installScopeGuard, "function");
});
