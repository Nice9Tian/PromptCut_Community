/**
 * 舞台源跨文档通道守卫(`scopeGuard.ts`)与舞台文档自己的跨文档状态(`harden.ts` 的 `isolateWindowState`)。
 * 用仿浏览器的全局对象核逻辑;真实无头 Chrome 里的行为由 `scopeGuard.browser-check.mjs` 核(不进 npm test)。
 * 跑:node --test src/online/isolation/scopeGuard.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { guardStageScope, installScopeGuard, newLockPrefix, SCOPE_GUARD_CRITICAL, spawnRuntimeWorker } from "./scopeGuard.ts";
import { denyPersistentStorage, isolateWindowState } from "./harden.ts";

const PREFIX = "pc-0123456789abcdef0123456789abcdef:";

/** 仿浏览器的全局对象:Blob / URL / Worker / 存储 / 通道 / 锁,都可配置可写(和浏览器一样) */
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
  // 接口对象和浏览器里一样不可枚举(守卫据「可枚举」认出被顶层函数声明换过的接口对象)
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

test("OCS-H-11 守卫是自足的:源码拿出来在只带标准内置对象的环境里照样装得上", () => {
  const src = guardStageScope.toString();
  const { scope } = fakeScope();
  // 只给标准内置对象(vm 新环境)和仿全局对象:函数体引用了外面的名字就会 ReferenceError
  const ctx = vm.createContext({ fakeSelf: scope });
  const r = vm.runInContext(`(${src})(fakeSelf, ${JSON.stringify({ lockPrefix: PREFIX })})`, ctx);
  assert.equal(r.errors.length, 0, [...r.errors].join("; ")); // 别的环境里的数组:不用 deepEqual(原型不同)
  for (const k of ["Worker", "indexedDB", "BroadcastChannel", "SharedWorker", "LockManager.request", "CookieStore.set", "IDBFactory.open"]) assert.ok(r.denied.includes(k), k);
  assert.equal(scope.indexedDB, undefined);
  assert.throws(() => new scope.Worker("blob:fake/1"), /PromptCut 舞台:不能起后台线程/);
  assert.match(newLockPrefix(), /^pc-[0-9a-f]{32}:$/);
});

test("OCS-H-12 后台线程:卡片自己起后台线程一律拒绝(任何地址、构造函数绕路、子类都抛错);运行时专用线程经 spawnRuntimeWorker 照常起", () => {
  const { scope, spawned } = fakeScope();
  const OrigWorker = scope.Worker;
  const r = install(scope);
  assert.deepEqual(r.errors, []);
  const card = new scope.Blob(["postMessage(1)"]);
  const url = scope.URL.createObjectURL(card);

  // 卡片从任何地址、任何模块类型起 Worker 一律抛错
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
    assert.throws(() => new scope.Worker(u, opts), /PromptCut 舞台:不能起后台线程/, String(u));
  }
  assert.throws(() => scope.Worker(url), /PromptCut 舞台:不能起后台线程/);

  // 绕路:原构造函数拿不回来、换不掉;经 prototype.constructor、子类、Reflect.construct 同样拒绝
  assert.equal(scope.Worker.prototype.constructor, scope.Worker);
  assert.throws(() => new scope.Worker.prototype.constructor(url), /PromptCut 舞台:不能起后台线程/);
  assert.throws(() => Reflect.construct(scope.Worker, [url]), /PromptCut 舞台:不能起后台线程/);
  assert.throws(() => { OrigWorker.prototype.constructor = OrigWorker; }, TypeError);
  assert.equal(Reflect.set(scope, "Worker", OrigWorker), false);
  assert.throws(() => Object.defineProperty(scope, "Worker", { value: OrigWorker }), TypeError);
  class Sub extends scope.Worker {}
  assert.throws(() => new Sub(url), /PromptCut 舞台:不能起后台线程/);
  assert.equal(spawned.length, 0, "卡片的任何尝试都没起成线程");

  // 舞台运行时自己的 GL / 声音线程经模块闭包里的原生构造函数起
  const gl = spawnRuntimeWorker("importScripts('/glWorker.js');", undefined, scope);
  assert.ok(gl instanceof OrigWorker && gl instanceof scope.Worker);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].blob.parts, ["importScripts('/glWorker.js');"]);
  const snd = spawnRuntimeWorker("import '/soundWorker.ts';", { type: "module", name: "pc-card-sound" }, scope);
  assert.ok(snd instanceof OrigWorker);
  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned[1].opts, { type: "module", name: "pc-card-sound" });

  // 接线核对:GL 与声音线程经 spawnRuntimeWorker 起,声音线程入口同时装 denyPersistentStorage 与 installScopeGuard(并且按 strict 装:关键项没装上整段线程不执行)
  const glSpawnSrc = fs.readFileSync(new URL("../../render/gl/spawnWorker.ts", import.meta.url), "utf8");
  const sndSpawnSrc = fs.readFileSync(new URL("../cardRuntime/soundSpawn.ts", import.meta.url), "utf8");
  const sndWorkerSrc = fs.readFileSync(new URL("../cardRuntime/soundWorker.ts", import.meta.url), "utf8");
  assert.match(glSpawnSrc, /spawnRuntimeWorker\(/);
  assert.ok(!/new Worker\(/.test(glSpawnSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")), "spawnGlWorker 不直接调全局 new Worker");
  assert.match(sndSpawnSrc, /spawnRuntimeWorker\(/);
  assert.ok(!/new Worker\(/.test(sndSpawnSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")), "spawnSoundWorker 不直接调全局 new Worker");
  const dpsIdx = sndWorkerSrc.indexOf("denyPersistentStorage(self);");
  const sgIdx = sndWorkerSrc.indexOf("installScopeGuard(self, { strict: true });");
  const threadIdx = sndWorkerSrc.indexOf("createSoundThread(");
  assert.ok(dpsIdx > 0 && sgIdx > dpsIdx && threadIdx > sgIdx, "声音线程在建线程前先后装 denyPersistentStorage 与 installScopeGuard(strict)");
});

/**
 * 在仿全局环境里模拟「守卫安装前顶层声明或属性篡改」,核对守卫的内置对象提取与平台接口完整性检查。
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

test("OCS-H-17 守卫完整性核对:顶层声明遮住 self、JSON、平台接口都绕不过守卫;核对不过整段不执行", () => {
  // 对照:不遮,守卫装上、后续代码照常跑,Worker 被拒绝
  const ok = runGuardWithPreDecl("var probe = typeof indexedDB;");
  assert.equal(ok.error, null, String(ok.error));
  assert.equal(ok.ran, true);
  assert.equal(ok.scope.indexedDB, undefined);
  assert.equal(ok.scope.BroadcastChannel, undefined);
  assert.throws(() => new ok.scope.Worker("blob:fake/1"), /PromptCut 舞台:不能起后台线程/);

  // ① 遮住 self:守卫不读 self,照样装在真全局上
  const s = runGuardWithPreDecl("function self() {}\nvar probe = typeof indexedDB;");
  assert.equal(s.error, null, String(s.error));
  assert.equal(s.ran, true);
  assert.equal(s.scope.indexedDB, undefined, "遮住 self 也收走了 indexedDB");
  assert.equal(s.scope.caches, undefined);
  assert.equal(s.scope.BroadcastChannel, undefined);

  // ② 遮住 JSON / Reflect / 平台接口:核对不过,strict 下整段抛错不执行
  const j = runGuardWithPreDecl("function JSON() {}\nvar probe = 1;");
  assert.ok(j.error, "遮住 JSON:整段脚本抛错");
  assert.match(String(j.error && j.error.message), /PromptCut 舞台:integrity:.*JSON/);
  assert.equal(j.ran, false, "后续代码一句也没跑");
  for (const name of ["Reflect", "Blob", "URL", "Worker", "IDBFactory", "indexedDB", "BroadcastChannel", "LockManager"]) {
    const r = runGuardWithPreDecl(`function ${name}() {}\n`, name === "Reflect" ? [] : [name]);
    assert.ok(r.error && /integrity/.test(r.error.message), `遮住 ${name}:整段不执行(${r.error && r.error.message})`);
    assert.equal(r.ran, false, name);
  }
  // 顶层 let/const/class 同名:守卫一读就是暂时死区的 ReferenceError,同样整段不执行
  for (const decl of ["let Reflect = {};", "const JSON = {};"]) {
    const r = runGuardWithPreDecl(decl + "\n");
    assert.ok(r.error instanceof ReferenceError || r.error?.name === "ReferenceError", decl);
    assert.equal(r.ran, false, decl);
  }
  // 守卫不按名字读 Object(从字面量取):顶层 `class Object {}` 或遮住标准内置构造函数不影响守卫
  const cls = runGuardWithPreDecl("class Object {}\n");
  assert.equal(cls.error, null, String(cls.error));
  assert.equal(cls.ran, true);
  assert.equal(cls.scope.indexedDB, undefined);
  const lit = runGuardWithPreDecl("function Object() {}\nfunction String() {}\nfunction Symbol() {}\nfunction Promise() {}\nfunction TypeError() {}\nfunction Array() {}\nfunction Map() {}\n");
  assert.equal(lit.error, null, String(lit.error));
  assert.equal(lit.scope.indexedDB, undefined);
  assert.equal(lit.scope.BroadcastChannel, undefined);

  // 关键项清单:守卫里自带的一份与导出的一份一致
  const src = guardStageScope.toString();
  const m = /const CRITICAL = (\[[^\]]*\])/.exec(src);
  assert.ok(m, "守卫里有关键项清单");
  assert.deepEqual(JSON.parse(m[1]), [...SCOPE_GUARD_CRITICAL]);
});

test("OCS-H-18 锁 Worker 失败:不咽下去,把 Worker 收走;strict 下抛错;舞台文档里只记错(由自检判不执行)", () => {
  // 原型锁死:锁 Worker 那段的 defineProperty(prototype.constructor) 抛错
  const a = fakeScope();
  Object.freeze(a.scope.Worker.prototype);
  const r = install(a.scope);
  assert.ok(r.errors.some((e) => e.startsWith("Worker:")), r.errors.join("; "));
  assert.equal(a.scope.Worker, undefined, "Worker 收走了");
  const b = fakeScope();
  Object.freeze(b.scope.Worker.prototype);
  assert.throws(() => guardStageScope(b.scope, { lockPrefix: PREFIX, strict: true }), /关键项没装上\(Worker:/);
  // 舞台文档里(不 strict)核对不过:记一条 integrity,什么都不装
  const c = fakeScope();
  Object.defineProperty(c.scope, "Blob", { value: function Blob() {}, enumerable: true, configurable: false, writable: true });
  const rc = install(c.scope);
  assert.ok(rc.errors.some((e) => e.startsWith("integrity:")), rc.errors.join("; "));
});

test("OCS-H-13 持久存储与同源通道:全局入口没有,先拿到的对象也用不了;cookieStore 写拒绝;persist 回 false;装两次、再调 denyPersistentStorage 都不报错", async () => {
  const { scope } = fakeScope();
  const captured = { idb: scope.indexedDB, caches: scope.caches, storage: scope.navigator.storage, BC: scope.BroadcastChannel, db: new scope.IDBDatabase(), sw: scope.navigator.serviceWorker };
  const bc = new captured.BC("x");
  const r = install(scope);
  assert.deepEqual(r.errors, []);
  for (const k of ["indexedDB", "caches", "webkitRequestFileSystem", "sharedStorage", "BroadcastChannel", "SharedWorker"]) {
    assert.equal(scope[k], undefined, k);
    assert.equal(Reflect.set(scope, k, {}), false, k);
  }
  assert.throws(() => captured.idb.open("leak"), /持久存储/);
  assert.throws(() => captured.idb.deleteDatabase("leak"), /持久存储/);
  await assert.rejects(captured.idb.databases(), /持久存储/);
  assert.equal(captured.idb.cmp(1, 2), 0, "不相干的方法照旧");
  assert.throws(() => captured.db.transaction(["s"], "readwrite"), /持久存储/);
  await assert.rejects(captured.caches.open("c"), /持久存储/);
  await assert.rejects(new scope.Cache().put("k", "v"), /持久存储/);
  await assert.rejects(captured.storage.getDirectory(), /持久存储/);
  assert.equal(await captured.storage.persist(), false);
  assert.deepEqual(await captured.storage.estimate(), { quota: 1 });
  await assert.rejects(scope.navigator.storageBuckets.open("b"), /持久存储/);
  await assert.rejects(new scope.FileSystemFileHandle().createWritable(), /持久存储/);
  assert.throws(() => new scope.FileSystemDirectoryHandle().entries(), /持久存储/);
  await assert.rejects(captured.sw.register("/sw.js"), /Service Worker/);
  assert.throws(() => bc.postMessage("leak"), /BroadcastChannel/);
  await assert.rejects(scope.cookieStore.set("a", "b"), /cookie/);
  await assert.rejects(scope.cookieStore.delete("a"), /cookie/);
  assert.equal(await scope.cookieStore.get("a"), null);
  assert.throws(() => Object.defineProperty(scope.IDBFactory.prototype, "open", { value: () => "x" }), TypeError);

  // 再装一遍:不报错
  assert.deepEqual(install(scope).errors, []);
  // 声音线程:先后调 denyPersistentStorage 与 installScopeGuard 都不报错
  const d = denyPersistentStorage(scope);
  assert.deepEqual(d.errors, []);
  assert.ok(d.denied.includes("StorageManager.getDirectory"));

  // 舞台文档里 harden.ts 第 6 节先锁了 cookieStore:认作已锁、不报错
  const doc = fakeScope();
  Object.defineProperty(doc.scope.CookieStore.prototype, "set", { value: async () => { throw new TypeError("earlier lock"); }, writable: false, configurable: false });
  const r2 = install(doc.scope);
  assert.deepEqual(r2.errors, []);
  assert.ok(r2.denied.includes("CookieStore.set"));
});

test("OCS-H-14 锁名按文档加前缀:本文档照常用,别的文档的锁看不见", async () => {
  const { scope, lockCalls } = fakeScope();
  install(scope);
  const name = await scope.navigator.locks.request("sid-lock", (l) => l.name);
  assert.equal(lockCalls.at(-1), `${PREFIX}sid-lock`, "真实锁名带前缀");
  assert.equal(name, "sid-lock", "回调里看到的名字去掉了前缀");
  await scope.navigator.locks.request("opt", { ifAvailable: true }, () => {});
  assert.equal(lockCalls.at(-1), `${PREFIX}opt`);
  await scope.navigator.locks.request("-reserved", () => {});
  assert.equal(lockCalls.at(-1), "-reserved", "保留名原样交给浏览器报错");
  const q = await scope.navigator.locks.query();
  assert.deepEqual(q, { held: [{ name: "mine", mode: "exclusive", clientId: "c1" }], pending: [{ name: "waiting", mode: "exclusive", clientId: "c1" }] });
});

/** 仿窗口:`name` 是原型上的访问器(真实值在闭包里),有 History、navigation、事件监听 */
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

test("OCS-H-15 舞台文档自己的跨文档状态:window.name 清空并只在内存;会话历史只在内存、不走动;navigation 没有;storage 事件截住;地址上的 # 去掉", () => {
  const { w, real, listeners } = fakeWindow({ name: "leak-from-last-project", hash: "#leak" });
  const r = isolateWindowState(w);
  assert.deepEqual(r.errors, []);
  assert.equal(real.name, "", "真实的 window.name 清空了");
  assert.equal(w.name, "");
  w.name = "sid-of-this-project";
  assert.equal(w.name, "sid-of-this-project", "本文档里照常读写");
  assert.equal(real.name, "", "真实的 window.name 一直是空的");
  assert.throws(() => Object.defineProperty(w, "name", { get: () => real.name }), TypeError, "改不回来");

  assert.equal(real.url, "/editor/stage.html?stage=1", "载入时地址上的 # 去掉了");
  w.history.pushState({ sid: "x" }, "", "?sid=x#y");
  assert.deepEqual(w.history.state, { sid: "x" });
  assert.equal(real.state, null, "真实条目里没有状态");
  assert.equal(real.url, "/editor/stage.html?stage=1", "地址不改");
  w.history.replaceState({ sid: "z" }, "");
  assert.deepEqual(w.history.state, { sid: "z" });
  assert.throws(() => w.history.pushState(() => {}, ""), /could not be cloned/, "克隆不了照样抛错");
  w.history.back(); w.history.go(-2); w.history.forward();
  assert.equal(real.moves, 0, "不在会话历史里走动");
  assert.equal(w.navigation, undefined);
  assert.equal(Reflect.set(w, "navigation", {}), false);

  const storage = listeners.find((l) => l.type === "storage");
  assert.ok(storage && storage.capture === true, "捕获阶段监听 storage");
  let stopped = false;
  storage.fn({ stopImmediatePropagation: () => { stopped = true; } });
  assert.ok(stopped, "storage 事件不往下传");
});

test("OCS-H-16 接线:舞台加固装上通道守卫与本文档状态隔离(在 MutationObserver 兜底之前、任何卡片代码之前)", () => {
  const harden = fs.readFileSync(new URL("./harden.ts", import.meta.url), "utf8");
  const body = harden.slice(harden.indexOf("export function installStageHardening"));
  const scoped = body.indexOf("const scoped = installScopeGuard(w);");
  const own = body.indexOf("const own = isolateWindowState(w);");
  const storage = body.indexOf("const storage = denyPersistentStorage(w);");
  assert.ok(storage > 0 && scoped > storage && own > scoped, "6b 存储 → 6c 通道守卫 → 6d 本文档状态");
  assert.ok(own < body.indexOf("new w.MutationObserver"));
  assert.match(body, /scopeGuarded: \[\.\.\.scoped\.denied, \.\.\.own\.denied\]/);
  assert.equal(typeof installScopeGuard, "function");
});
