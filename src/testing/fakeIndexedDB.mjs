/**
 * 仅供测试:最小的内存版 IndexedDB(只实现 `src/online/l2.ts` 用到的那一些)。
 *
 * - `open(name, version)`:第一次(或版本升高)先 `onupgradeneeded` 再 `onsuccess`;
 * - `db.transaction(stores, mode).objectStore(name)`:`put` / `get` / `delete` / `getAll` / `openCursor`;
 * - 请求异步落定(微任务),事务在最后一个请求落定之后的下一个宏任务 `complete`;
 * - `tx.abort()`:回滚这个事务里做过的改动,触发 `onabort`;
 * - 注入配额错误:`factory.failPuts = n` —— 接下来 n 次 `put` 以 `QuotaExceededError` 失败(请求 `onerror` →
 *   冒到事务 `onerror` → 事务 `onabort`),与浏览器的顺序一致;`factory.failAll = true` 一直失败;
 * - `factory.log`:每个事务的 `{ mode, stores, ops: [{ store, op, key }], outcome }`,单测据此核对「一个删除事务」「另开写事务」。
 */

const clone = (v) => (v instanceof Uint8Array ? new Uint8Array(v) : v && typeof v === "object" ? structuredClone(v) : v);

class FakeRequest {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
}

class FakeStore {
  constructor(tx, name) { this.tx = tx; this.name = name; }
  get data() { return this.tx.db.stores.get(this.name).data; }
  get keyPath() { return this.tx.db.stores.get(this.name).keyPath; }
  _req(op, key, fn) {
    const r = new FakeRequest();
    const entry = { store: this.name, op, key };
    this.tx.ops.push(entry);
    this.tx._pending++;
    queueMicrotask(() => {
      if (this.tx._aborted) { this.tx._done(); return; }
      try {
        r.result = fn();
        r.onsuccess?.({ target: r });
      } catch (e) {
        r.error = e;
        entry.error = e.name;
        r.onerror?.({ target: r, preventDefault() {} });
        this.tx._requestFailed(r);
      }
      this.tx._done();
    });
    return r;
  }
  put(value) {
    if (this.tx.mode !== "readwrite") throw Object.assign(new Error("ReadOnlyError"), { name: "ReadOnlyError" });
    const key = value?.[this.keyPath];
    return this._req("put", key, () => {
      const f = this.tx.db.factory;
      if (f.failAll || f.failPuts > 0) {
        if (f.failPuts > 0) f.failPuts--;
        throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });
      }
      this.tx._undo(this.name, key);
      this.data.set(key, clone(value));
      return key;
    });
  }
  get(key) { return this._req("get", key, () => clone(this.data.get(key))); }
  delete(key) {
    if (this.tx.mode !== "readwrite") throw Object.assign(new Error("ReadOnlyError"), { name: "ReadOnlyError" });
    return this._req("delete", key, () => { this.tx._undo(this.name, key); this.data.delete(key); });
  }
  getAll() { return this._req("getAll", null, () => [...this.data.values()].map(clone)); }
  openCursor() {
    const keys = [...this.data.keys()].sort();
    const r = new FakeRequest();
    let i = 0;
    const tx = this.tx;
    const data = this.data;
    tx._pending++;
    const step = () => {
      queueMicrotask(() => {
        if (tx._aborted) { tx._done(); return; }
        if (i >= keys.length) { r.result = null; r.onsuccess?.({ target: r }); tx._done(); return; }
        const key = keys[i++];
        r.result = { key, primaryKey: key, value: clone(data.get(key)), continue: () => step() };
        r.onsuccess?.({ target: r });
      });
    };
    step();
    return r;
  }
}

class FakeTx {
  constructor(db, stores, mode) {
    this.db = db; this.stores = stores; this.mode = mode;
    this.ops = []; this._pending = 0; this._aborted = false; this._finished = false; this._undoLog = [];
    this.oncomplete = null; this.onerror = null; this.onabort = null; this.error = null;
    this.entry = { mode, stores: [...stores], ops: this.ops, outcome: "pending" };
    db.factory.log.push(this.entry);
    // 一个请求都没发的事务也要落定
    setTimeout(() => this._maybeComplete(), 0);
  }
  objectStore(name) {
    if (!this.stores.includes(name)) throw Object.assign(new Error(`NotFoundError: ${name}`), { name: "NotFoundError" });
    return new FakeStore(this, name);
  }
  _undo(store, key) {
    const data = this.db.stores.get(store).data;
    this._undoLog.push([store, key, data.has(key), clone(data.get(key))]);
  }
  _requestFailed(r) {
    this.error = r.error;
    this.onerror?.({ target: r });
    this.abort();
  }
  _done() {
    this._pending--;
    if (this._pending <= 0) setTimeout(() => this._maybeComplete(), 0);
  }
  _maybeComplete() {
    if (this._finished || this._aborted || this._pending > 0) return;
    this._finished = true;
    this.entry.outcome = "complete";
    this.oncomplete?.({ target: this });
  }
  abort() {
    if (this._finished) return;
    this._finished = true;
    this._aborted = true;
    for (const [store, key, had, value] of this._undoLog.reverse()) {
      const data = this.db.stores.get(store).data;
      if (had) data.set(key, value); else data.delete(key);
    }
    this.entry.outcome = "abort";
    setTimeout(() => this.onabort?.({ target: this }), 0);
  }
}

class FakeDb {
  constructor(factory, name) { this.factory = factory; this.name = name; this.stores = new Map(); this.version = 0; this.closed = false; }
  get objectStoreNames() { const names = [...this.stores.keys()]; return { contains: (n) => names.includes(n), length: names.length }; }
  createObjectStore(name, { keyPath }) { this.stores.set(name, { keyPath, data: new Map() }); return {}; }
  transaction(stores, mode = "readonly") {
    if (this.closed) throw Object.assign(new Error("InvalidStateError"), { name: "InvalidStateError" });
    const list = Array.isArray(stores) ? stores : [stores];
    for (const s of list) if (!this.stores.has(s)) throw Object.assign(new Error(`NotFoundError: ${s}`), { name: "NotFoundError" });
    return new FakeTx(this, list, mode);
  }
  close() { this.closed = true; }
}

export function createFakeIndexedDB() {
  const dbs = new Map();
  const factory = {
    log: [],
    failPuts: 0,
    failAll: false,
    open(name, version = 1) {
      const r = new FakeRequest();
      r.onupgradeneeded = null;
      r.onblocked = null;
      setTimeout(() => {
        let db = dbs.get(name);
        if (!db) { db = new FakeDb(factory, name); dbs.set(name, db); }
        db.closed = false;
        r.result = db;
        if (version > db.version) { db.version = version; r.onupgradeneeded?.({ target: r }); }
        r.onsuccess?.({ target: r });
      }, 0);
      return r;
    },
    /** 测试看:某个库某张表里的全部记录 */
    dump(name, store) { return [...(dbs.get(name)?.stores.get(store)?.data.values() ?? [])]; },
  };
  return factory;
}
