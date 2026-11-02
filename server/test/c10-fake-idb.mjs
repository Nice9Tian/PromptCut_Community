/**
 * For test use only; production code must not reference this.
 *
 * Minimal in-memory IndexedDB stub (for C10 contract tests, `docs/plan/c10-contract.md` section 4).
 * The repository does not have `fake-indexeddb`, and per the task brief no new dependencies are
 * introduced, so a subset sufficient for L2 is written here:
 *
 * - `IDBFactory.open / deleteDatabase / databases`, version upgrades go through `onupgradeneeded`
 *   (with a `versionchange` transaction);
 * - Database: `objectStoreNames`, `createObjectStore / deleteObjectStore` (upgrade transactions
 *   only), `transaction(names, mode)`, `close`;
 * - Store:
 *   `put / add / get / getAll / getAllKeys / getKey / delete / clear / count / openCursor / openKeyCursor / createIndex / index`,
 *   inline keys (`keyPath`, string or string array), out-of-line keys, `autoIncrement`;
 * - Index: `get / getAll / getAllKeys / count / openCursor / openKeyCursor` (computed on the fly
 *   from current data);
 * - Cursor: `continue / advance / delete / update`;
 * - `IDBKeyRange.only / lowerBound / upperBound / bound`;
 * - Transaction: requests execute sequentially in subsequent macrotasks (`setImmediate`); during
 *   the success callback and its microtasks the transaction remains active, committing
 *   (`complete`) afterward if no new requests are queued; on request error, `error` is first
 *   dispatched to the request, and if not `preventDefault`ed bubbles to the transaction's `error`,
 *   then aborts the transaction (`abort`, where `tx.error` is that error), rolling back writes.
 *   Events support both `onxxx` and `addEventListener`.
 *
 * # Quotas (section 4 "Write encounters QuotaExceededError")
 *
 * `new FakeIDBFactory({ quotaBytes, quotaMode })`:
 * - `quotaBytes`: upper limit on total record bytes across all databases (values and keys computed
 *   via `sizeOf`, byte classes via `byteLength` / `size`), unlimited by default;
 * - `quotaMode: 'request'`: the write request that exceeds the quota fails immediately (request
 *   `error` → transaction `error` → transaction `abort`);
 *   `quotaMode: 'abort'`: requests succeed as usual, but on commit the entire transaction is
 *   aborted, dispatching only the transaction's `abort` (`tx.error` is `QuotaExceededError`)
 *   without dispatching any `error` events. Both genuinely exist (Chrome often exhibits the
 *   latter); the contract requires handling both `error` and `abort`.
 * - `factory.forceQuota = true`: from then on, all transactions containing writes (`put` / `add` /
 *   `update`) fail with a quota error (deletions still succeed), used to simulate "still fails after
 *   cleanup".
 *
 * # Observability
 *
 * `factory.log`: one `{ id, db, mode, stores, ops: [{ op, store, key, bytes }], outcome, error }`
 * per transaction, where `outcome` is `complete` / `abort`; `factory.usage()` current byte count;
 * `factory.dbNames()`; `factory.storeNamesOf(db)`.
 *
 * Byte-like values (`ArrayBuffer`, TypedArray, `DataView`, `Blob`) are stored by reference without
 * copying: tests use views of different lengths on the same buffer to create tens of MiB of
 * "chunks" without actually consuming that much memory. Other values are deep-cloned with
 * `structuredClone` (embedded byte-like objects are likewise kept by reference).
 */

const MiB = 1024 * 1024;

export class FakeDOMException extends Error {
  constructor(message, name) {
    super(message);
    this.name = name;
  }
}
const domError = (name, message = name) => {
  try {
    return new DOMException(message, name);
  } catch {
    return new FakeDOMException(message, name);
  }
};

/* ------------------------------------------------------------------ Events */

class Target {
  constructor() {
    this._listeners = new Map();
  }
  addEventListener(type, fn) {
    if (typeof fn !== 'function' && !(fn && typeof fn.handleEvent === 'function')) return;
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  /** Dispatches an event: `on<type>` first, then listeners; callback errors do not affect dispatch (reported only, matching browser behavior) */
  _fire(event) {
    event.currentTarget = this;
    const handler = this[`on${event.type}`];
    const call = (fn) => {
      if (event._stopImmediate) return;
      try {
        if (typeof fn === 'function') fn.call(this, event);
        else fn.handleEvent(event);
      } catch (err) {
        queueMicrotask(() => { throw err; });
      }
    };
    if (typeof handler === 'function') call(handler);
    for (const fn of [...(this._listeners.get(event.type) ?? [])]) call(fn);
  }
}

class FakeEvent {
  constructor(type, target, extra = {}) {
    this.type = type;
    this.target = target;
    this.currentTarget = target;
    this.defaultPrevented = false;
    this._stopImmediate = false;
    this._stopped = false;
    Object.assign(this, extra);
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stopped = true; }
  stopImmediatePropagation() { this._stopped = true; this._stopImmediate = true; }
}

/* ------------------------------------------------------------------ Keys */

const typeRank = (k) => {
  if (typeof k === 'number') return 1;
  if (k instanceof Date) return 2;
  if (typeof k === 'string') return 3;
  if (k instanceof ArrayBuffer || ArrayBuffer.isView(k)) return 4;
  if (Array.isArray(k)) return 5;
  return 0;
};

export function validKey(k) {
  const r = typeRank(k);
  if (r === 0) return false;
  if (r === 1) return !Number.isNaN(k);
  if (r === 2) return !Number.isNaN(k.getTime());
  if (r === 5) return k.every(validKey);
  return true;
}

const bytesOfKey = (k) => (k instanceof ArrayBuffer ? new Uint8Array(k) : new Uint8Array(k.buffer, k.byteOffset, k.byteLength));

export function cmp(a, b) {
  const ra = typeRank(a), rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra === 1) return a < b ? -1 : a > b ? 1 : 0;
  if (ra === 2) return cmp(a.getTime(), b.getTime());
  if (ra === 3) return a < b ? -1 : a > b ? 1 : 0;
  if (ra === 4) {
    const x = bytesOfKey(a), y = bytesOfKey(b);
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
  }
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmp(a[i], b[i]);
    if (c) return c;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export class FakeIDBKeyRange {
  constructor(lower, upper, lowerOpen, upperOpen) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = !!lowerOpen;
    this.upperOpen = !!upperOpen;
  }
  static only(v) { return new FakeIDBKeyRange(v, v, false, false); }
  static lowerBound(v, open) { return new FakeIDBKeyRange(v, undefined, open, true); }
  static upperBound(v, open) { return new FakeIDBKeyRange(undefined, v, true, open); }
  static bound(l, u, lo, uo) {
    if (cmp(l, u) > 0) throw domError('DataError');
    return new FakeIDBKeyRange(l, u, lo, uo);
  }
  includes(k) {
    if (this.lower !== undefined) {
      const c = cmp(k, this.lower);
      if (c < 0 || (c === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const c = cmp(k, this.upper);
      if (c > 0 || (c === 0 && this.upperOpen)) return false;
    }
    return true;
  }
}

const toRange = (q) => {
  if (q === undefined || q === null) return null;
  if (q instanceof FakeIDBKeyRange) return q;
  if (q && typeof q === 'object' && 'lower' in q && 'upper' in q && typeof q.includes === 'function') return q;
  if (!validKey(q)) throw domError('DataError', `Not a valid key: ${String(q)}`);
  return FakeIDBKeyRange.only(q);
};

/* ------------------------------------------------------------------ Values */

const isBytes = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v) || (typeof Blob !== 'undefined' && v instanceof Blob);

/** Deep copy, byte classes by reference (see file header) */
function cloneValue(v, seen = new Map()) {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'function' || typeof v === 'symbol') throw domError('DataCloneError');
    return v;
  }
  if (isBytes(v)) return v;
  if (seen.has(v)) return seen.get(v);
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof Map) {
    const out = new Map();
    seen.set(v, out);
    for (const [k, x] of v) out.set(cloneValue(k, seen), cloneValue(x, seen));
    return out;
  }
  if (v instanceof Set) {
    const out = new Set();
    seen.set(v, out);
    for (const x of v) out.add(cloneValue(x, seen));
    return out;
  }
  if (Array.isArray(v)) {
    const out = [];
    seen.set(v, out);
    for (const x of v) out.push(cloneValue(x, seen));
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    // Other class instances (such as Error) are passed to structuredClone; it throws DataCloneError for unrecognized ones
    try { return structuredClone(v); } catch { throw domError('DataCloneError'); }
  }
  const out = {};
  seen.set(v, out);
  for (const k of Object.keys(v)) {
    if (typeof v[k] === 'function') throw domError('DataCloneError');
    out[k] = cloneValue(v[k], seen);
  }
  return out;
}

/** Bytes occupied by a record (for quota and observability; an approximation is fine, byte classes take their actual length) */
export function sizeOf(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'string') return v.length * 2;
  if (typeof v === 'number') return 8;
  if (typeof v === 'boolean') return 4;
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v.size;
  if (v instanceof Date) return 8;
  if (Array.isArray(v)) return v.reduce((s, x) => s + sizeOf(x), 0);
  if (v instanceof Map) { let s = 0; for (const [k, x] of v) s += sizeOf(k) + sizeOf(x); return s; }
  if (v instanceof Set) { let s = 0; for (const x of v) s += sizeOf(x); return s; }
  if (typeof v === 'object') { let s = 0; for (const k of Object.keys(v)) s += k.length * 2 + sizeOf(v[k]); return s; }
  return 0;
}

function extractKey(value, keyPath) {
  if (Array.isArray(keyPath)) return keyPath.map((p) => extractKey(value, p));
  if (keyPath === '') return value;
  let cur = value;
  for (const part of String(keyPath).split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function injectKey(value, keyPath, key) {
  const parts = String(keyPath).split('.');
  let cur = value;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in cur)) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = key;
}

/* ------------------------------------------------------------------ Lists */

class StringList {
  constructor(names) {
    this._names = [...names].sort();
    this.length = this._names.length;
    this._names.forEach((n, i) => { this[i] = n; });
  }
  contains(n) { return this._names.includes(n); }
  item(i) { return this._names[i] ?? null; }
  [Symbol.iterator]() { return this._names[Symbol.iterator](); }
}

/* ------------------------------------------------------------------ Requests */

class FakeIDBRequest extends Target {
  constructor(source, transaction) {
    super();
    this.source = source;
    this.transaction = transaction;
    this.readyState = 'pending';
    this._result = undefined;
    this._error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
  get result() {
    if (this.readyState !== 'done') throw domError('InvalidStateError', 'The request has not completed yet');
    return this._result;
  }
  get error() {
    if (this.readyState !== 'done') throw domError('InvalidStateError', 'The request has not completed yet');
    return this._error;
  }
}

class FakeIDBOpenDBRequest extends FakeIDBRequest {
  constructor() {
    super(null, null);
    this.onupgradeneeded = null;
    this.onblocked = null;
  }
}

/* ------------------------------------------------------------------ Data */

/** Real database data: name → { keyPath, autoIncrement, next, records: Map<serialKey, { key, value }>, indexes: Map } */
class DbData {
  constructor(name) {
    this.name = name;
    this.version = 0;
    this.stores = new Map();
    this.connections = new Set();
  }
}

const serial = (k) => {
  const r = typeRank(k);
  if (r === 4) return `b:${Buffer.from(bytesOfKey(k)).toString('hex')}`;
  if (r === 5) return `a:[${k.map(serial).join(',')}]`;
  if (r === 2) return `d:${k.getTime()}`;
  return `${r}:${String(k)}`;
};

function sortedRecords(store) {
  return [...store.records.values()].sort((a, b) => cmp(a.key, b.key));
}

/* ------------------------------------------------------------------ Transactions */

let txSeq = 0;

class FakeIDBTransaction extends Target {
  constructor(db, names, mode) {
    super();
    this.db = db;
    this.mode = mode;
    this._names = names;
    this.objectStoreNames = new StringList(names);
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._queue = [];
    this._active = true;
    this._state = 'active'; // active → committing → finished
    this._undo = new Map(); // `${store}\u0000${serial}` → { store, sk, prev }
    this._storeUndo = null; // Rollback for creating and deleting stores in upgrade transactions
    this._log = { id: ++txSeq, db: db.name, mode, stores: [...names].sort(), ops: [], outcome: null, error: null };
    db._factory.log.push(this._log);
    this._requestError = null;
    // Once the task creating the transaction (along with its microtasks) ends, the transaction becomes inactive; if no requests were queued, it commits immediately
    setImmediate(() => { this._active = false; this._pump(); });
  }

  objectStore(name) {
    if (this._state === 'finished') throw domError('InvalidStateError', 'The transaction has finished');
    if (!this._names.includes(name)) throw domError('NotFoundError', `No object store ${name} in the transaction`);
    return new FakeIDBObjectStore(this, name);
  }

  abort() {
    if (this._state === 'finished') throw domError('InvalidStateError', 'The transaction has finished');
    this._abort(domError('AbortError', 'abort() was called'), true);
  }

  commit() { this._active = false; this._pump(); }

  _data(name) {
    const s = this.db._data.stores.get(name);
    if (!s) throw domError('NotFoundError', `No object store ${name}`);
    return s;
  }

  _assertWritable() {
    if (this.mode === 'readonly') throw domError('ReadOnlyError', 'A read-only transaction cannot write');
  }

  _assertActive() {
    if (this._state === 'finished' || !this._active) throw domError('TransactionInactiveError', 'The transaction is not active (requests can only be issued in the tick where the transaction was created or in the callback of the previous request)');
  }

  /** Queues a request; `run()` returns the result or throws a DOMException */
  _request(source, run) {
    this._assertActive();
    const req = new FakeIDBRequest(source, this);
    this._queue.push({ req, run });
    return req;
  }

  _remember(storeName, sk) {
    const id = `${storeName}\u0000${sk}`;
    if (this._undo.has(id)) return;
    const store = this._data(storeName);
    this._undo.set(id, { storeName, sk, prev: store.records.get(sk) });
  }

  _pump() {
    if (this._state !== 'active' || this._active || this._running) return;
    const next = this._queue.shift();
    if (!next) return this._commit();
    this._running = true;
    let result, error = null;
    try {
      result = next.run();
    } catch (err) {
      error = err;
    }
    const { req } = next;
    req.readyState = 'done';
    if (error) {
      req._error = error;
      req._result = undefined;
      this._active = true;
      const ev = new FakeEvent('error', req);
      req._fire(ev);
      // Bubbles to transaction and database
      if (!ev._stopped) this._fire(Object.assign(ev, { currentTarget: this }));
      if (!ev._stopped) this.db._fire(Object.assign(ev, { currentTarget: this.db }));
      this._running = false;
      if (!ev.defaultPrevented) {
        setImmediate(() => { this._active = false; this._abort(error, false); });
        return;
      }
    } else {
      req._result = result;
      this._active = true;
      req._fire(new FakeEvent('success', req));
      this._running = false;
    }
    // The transaction becomes inactive only after microtasks queued in the callback finish, then the next request runs
    setImmediate(() => { this._active = false; this._pump(); });
  }

  _commit() {
    if (this._state !== 'active') return;
    this._state = 'committing';
    const factory = this.db._factory;
    const wrote = this._log.ops.some((o) => o.op === 'put' || o.op === 'add' || o.op === 'update');
    if (wrote && (factory.forceQuota || (factory.quotaMode === 'abort' && factory.usage() > factory.quotaBytes))) {
      this._state = 'active';
      this._abort(domError('QuotaExceededError', 'Quota exceeded (at commit)'), false, { silentError: true });
      return;
    }
    this._state = 'finished';
    this._log.outcome = 'complete';
    this._fire(new FakeEvent('complete', this));
  }

  /** Abort: roll back, record error, dispatch abort (when a request error bubbles up, the transaction's error event has already been dispatched) */
  _abort(error, byUser, { silentError = false } = {}) {
    if (this._state === 'finished') return;
    this._state = 'finished';
    this._active = false;
    for (const { storeName, sk, prev } of [...this._undo.values()].reverse()) {
      const store = this.db._data.stores.get(storeName);
      if (!store) continue;
      if (prev === undefined) store.records.delete(sk);
      else store.records.set(sk, prev);
    }
    if (this._storeUndo) this._storeUndo();
    this.error = byUser ? null : error;
    this._log.outcome = 'abort';
    this._log.error = error?.name ?? String(error);
    // Unexecuted requests all fail with AbortError (no longer bubble)
    for (const { req } of this._queue.splice(0)) {
      req.readyState = 'done';
      req._error = domError('AbortError', 'The transaction was aborted');
      req._fire(new FakeEvent('error', req));
    }
    void silentError;
    this._fire(new FakeEvent('abort', this));
    this.db._fire(new FakeEvent('abort', this));
    if (this._onFinishAbort) this._onFinishAbort();
  }
}

/* ------------------------------------------------------------------ Cursors */

class FakeIDBCursor {
  constructor(tx, source, req, { range, direction = 'next', keyOnly = false, index = null }) {
    this._tx = tx;
    this.source = source;
    this.request = req;
    this.direction = direction;
    this._range = range;
    this._keyOnly = keyOnly;
    this._index = index; // { keyPath, multiEntry }
    this._pos = undefined; // [key, primaryKey]
    this.key = undefined;
    this.primaryKey = undefined;
    this._value = undefined;
    this._gotValue = false;
  }
  get value() { return this._keyOnly ? undefined : this._value; }

  _entries() {
    const store = this._tx._data(this.source._storeName);
    let rows;
    if (this._index) {
      rows = [];
      for (const rec of store.records.values()) {
        const ik = extractKey(rec.value, this._index.keyPath);
        const keys = this._index.multiEntry && Array.isArray(ik) ? ik : [ik];
        for (const k of keys) if (validKey(k)) rows.push({ key: k, primaryKey: rec.key, value: rec.value });
      }
      rows.sort((a, b) => cmp(a.key, b.key) || cmp(a.primaryKey, b.primaryKey));
    } else {
      rows = sortedRecords(store).map((r) => ({ key: r.key, primaryKey: r.key, value: r.value }));
    }
    if (this._range) rows = rows.filter((r) => this._range.includes(r.key));
    if (this.direction.startsWith('prev')) rows.reverse();
    if (this.direction.endsWith('unique')) {
      const seen = new Set();
      rows = rows.filter((r) => { const s = serial(r.key); if (seen.has(s)) return false; seen.add(s); return true; });
    }
    return rows;
  }

  /** Finds the next entry after the current position (optional target key); returns null when reaching the end */
  _step(target, count = 1) {
    const rows = this._entries();
    const fwd = !this.direction.startsWith('prev');
    let i = 0;
    if (this._pos) {
      const [k, pk] = this._pos;
      i = rows.findIndex((r) => {
        const c = cmp(r.key, k) || (this._index ? cmp(r.primaryKey, pk) : 0);
        return fwd ? c > 0 : c < 0;
      });
      if (i < 0) return null;
    }
    if (target !== undefined) {
      i = rows.findIndex((r, j) => j >= i && (fwd ? cmp(r.key, target) >= 0 : cmp(r.key, target) <= 0));
      if (i < 0) return null;
    }
    i += count - 1;
    return rows[i] ?? null;
  }

  _land(row) {
    if (!row) {
      this._pos = null;
      return null;
    }
    this._pos = [row.key, row.primaryKey];
    this.key = row.key;
    this.primaryKey = row.primaryKey;
    this._value = cloneValue(row.value);
    return this;
  }

  continue(key) {
    if (key !== undefined && !validKey(key)) throw domError('DataError');
    this._tx._assertActive();
    this._again(() => this._land(this._step(key)));
  }

  advance(n) {
    if (!(n > 0)) throw new TypeError('advance requires a positive integer');
    this._tx._assertActive();
    this._again(() => this._land(this._step(undefined, n)));
  }

  _again(run) {
    const req = this.request;
    req.readyState = 'pending';
    this._tx._queue.push({ req, run });
  }

  delete() {
    this._tx._assertWritable();
    return this.source.delete(this.primaryKey);
  }

  update(value) {
    this._tx._assertWritable();
    if (this._index) {
      const store = new FakeIDBObjectStore(this._tx, this.source._storeName);
      return store._write(value, store._keyPath() ? undefined : this.primaryKey, 'update', this.primaryKey);
    }
    return this.source._write(value, this.source._keyPath() ? undefined : this.primaryKey, 'update', this.primaryKey);
  }
}

/* ------------------------------------------------------------------ Stores and indexes */

class FakeIDBObjectStore {
  constructor(tx, name) {
    this.transaction = tx;
    this.name = name;
    this._storeName = name;
  }
  get keyPath() { return this.transaction._data(this.name).keyPath; }
  get autoIncrement() { return this.transaction._data(this.name).autoIncrement; }
  get indexNames() { return new StringList(this.transaction._data(this.name).indexes.keys()); }
  _keyPath() { return this.transaction._data(this.name).keyPath; }

  _write(value, key, op, expectKey) {
    const tx = this.transaction;
    tx._assertActive();
    tx._assertWritable();
    const store = tx._data(this.name);
    let v = cloneValue(value);
    let k;
    if (store.keyPath !== null && store.keyPath !== undefined) {
      if (key !== undefined) throw domError('DataError', 'An object store with in-line keys cannot also be given a key');
      k = extractKey(v, store.keyPath);
      if (k === undefined && store.autoIncrement) k = null;
    } else {
      k = key;
      if (k === undefined && !store.autoIncrement) throw domError('DataError', 'An object store with out-of-line keys requires a key');
    }
    if (k !== null && k !== undefined && !validKey(k)) throw domError('DataError', `Not a valid key: ${String(k)}`);
    if (expectKey !== undefined && cmp(k, expectKey) !== 0) throw domError('DataError', 'update cannot change the primary key');
    const bytes = sizeOf(v) + (k === null || k === undefined ? 8 : sizeOf(k));
    return tx._request(this, () => {
      let kk = k;
      if (kk === null || kk === undefined) {
        kk = store.next++;
        if (store.keyPath) injectKey(v, store.keyPath, kk);
      } else if (typeof kk === 'number' && store.autoIncrement && kk >= store.next) {
        store.next = Math.floor(kk) + 1;
      }
      const sk = serial(kk);
      if (op === 'add' && store.records.has(sk)) throw domError('ConstraintError', `Key already exists: ${String(kk)}`);
      for (const [iname, idx] of store.indexes) {
        if (!idx.unique) continue;
        const ik = extractKey(v, idx.keyPath);
        if (!validKey(ik)) continue;
        for (const [osk, rec] of store.records) {
          if (osk === sk) continue;
          const ok = extractKey(rec.value, idx.keyPath);
          if (validKey(ok) && cmp(ok, ik) === 0) throw domError('ConstraintError', `Unique constraint on index ${iname}`);
        }
      }
      const factory = tx.db._factory;
      tx._log.ops.push({ op, store: this.name, key: kk, bytes });
      const prevRec = store.records.get(sk);
      const after = factory.usage() - (prevRec ? prevRec.bytes : 0) + bytes;
      if (factory.quotaMode === 'request' && (factory.forceQuota || after > factory.quotaBytes)) {
        throw domError('QuotaExceededError', 'Quota exceeded');
      }
      tx._remember(this.name, sk);
      store.records.set(sk, { key: kk, value: v, bytes });
      return kk;
    });
  }

  put(value, key) { return this._write(value, key, 'put'); }
  add(value, key) { return this._write(value, key, 'add'); }

  get(query) {
    const range = toRange(query);
    return this.transaction._request(this, () => {
      const rec = sortedRecords(this.transaction._data(this.name)).find((r) => range.includes(r.key));
      return rec ? cloneValue(rec.value) : undefined;
    });
  }

  getKey(query) {
    const range = toRange(query);
    return this.transaction._request(this, () => sortedRecords(this.transaction._data(this.name)).find((r) => range.includes(r.key))?.key);
  }

  getAll(query, count) {
    const range = toRange(query);
    return this.transaction._request(this, () => {
      let rows = sortedRecords(this.transaction._data(this.name));
      if (range) rows = rows.filter((r) => range.includes(r.key));
      if (count > 0) rows = rows.slice(0, count);
      return rows.map((r) => cloneValue(r.value));
    });
  }

  getAllKeys(query, count) {
    const range = toRange(query);
    return this.transaction._request(this, () => {
      let rows = sortedRecords(this.transaction._data(this.name));
      if (range) rows = rows.filter((r) => range.includes(r.key));
      if (count > 0) rows = rows.slice(0, count);
      return rows.map((r) => r.key);
    });
  }

  count(query) {
    const range = toRange(query);
    return this.transaction._request(this, () => {
      const rows = sortedRecords(this.transaction._data(this.name));
      return range ? rows.filter((r) => range.includes(r.key)).length : rows.length;
    });
  }

  delete(query) {
    const tx = this.transaction;
    tx._assertActive();
    tx._assertWritable();
    const range = toRange(query);
    return tx._request(this, () => {
      const store = tx._data(this.name);
      for (const [sk, rec] of [...store.records]) {
        if (!range.includes(rec.key)) continue;
        tx._remember(this.name, sk);
        tx._log.ops.push({ op: 'delete', store: this.name, key: rec.key, bytes: rec.bytes });
        store.records.delete(sk);
      }
      return undefined;
    });
  }

  clear() {
    const tx = this.transaction;
    tx._assertActive();
    tx._assertWritable();
    return tx._request(this, () => {
      const store = tx._data(this.name);
      for (const [sk, rec] of [...store.records]) {
        tx._remember(this.name, sk);
        tx._log.ops.push({ op: 'delete', store: this.name, key: rec.key, bytes: rec.bytes });
        store.records.delete(sk);
      }
      return undefined;
    });
  }

  _cursor(query, direction, keyOnly, index) {
    const tx = this.transaction;
    tx._assertActive();
    const range = toRange(query);
    const req = new FakeIDBRequest(this, tx);
    const cursor = new FakeIDBCursor(tx, this, req, { range, direction, keyOnly, index });
    tx._queue.push({ req, run: () => cursor._land(cursor._step()) });
    return req;
  }

  openCursor(query, direction) { return this._cursor(query, direction, false, null); }
  openKeyCursor(query, direction) { return this._cursor(query, direction, true, null); }

  createIndex(name, keyPath, { unique = false, multiEntry = false } = {}) {
    const tx = this.transaction;
    if (tx.mode !== 'versionchange') throw domError('InvalidStateError', 'Indexes can only be created in an upgrade transaction');
    const store = tx._data(this.name);
    if (store.indexes.has(name)) throw domError('ConstraintError', `Index ${name} already exists`);
    store.indexes.set(name, { keyPath, unique, multiEntry });
    return this.index(name);
  }

  deleteIndex(name) {
    const tx = this.transaction;
    if (tx.mode !== 'versionchange') throw domError('InvalidStateError');
    tx._data(this.name).indexes.delete(name);
  }

  index(name) {
    const idx = this.transaction._data(this.name).indexes.get(name);
    if (!idx) throw domError('NotFoundError', `No index ${name}`);
    return new FakeIDBIndex(this, name, idx);
  }
}

class FakeIDBIndex {
  constructor(store, name, def) {
    this.objectStore = store;
    this.name = name;
    this.keyPath = def.keyPath;
    this.unique = def.unique;
    this.multiEntry = def.multiEntry;
    this._def = def;
  }
  _rows(range) {
    const store = this.objectStore.transaction._data(this.objectStore.name);
    const rows = [];
    for (const rec of store.records.values()) {
      const ik = extractKey(rec.value, this.keyPath);
      const keys = this.multiEntry && Array.isArray(ik) ? ik : [ik];
      for (const k of keys) if (validKey(k) && (!range || range.includes(k))) rows.push({ key: k, primaryKey: rec.key, value: rec.value });
    }
    return rows.sort((a, b) => cmp(a.key, b.key) || cmp(a.primaryKey, b.primaryKey));
  }
  get(query) {
    const range = toRange(query);
    return this.objectStore.transaction._request(this, () => { const r = this._rows(range)[0]; return r ? cloneValue(r.value) : undefined; });
  }
  getKey(query) {
    const range = toRange(query);
    return this.objectStore.transaction._request(this, () => this._rows(range)[0]?.primaryKey);
  }
  getAll(query, count) {
    const range = toRange(query);
    return this.objectStore.transaction._request(this, () => { let r = this._rows(range); if (count > 0) r = r.slice(0, count); return r.map((x) => cloneValue(x.value)); });
  }
  getAllKeys(query, count) {
    const range = toRange(query);
    return this.objectStore.transaction._request(this, () => { let r = this._rows(range); if (count > 0) r = r.slice(0, count); return r.map((x) => x.primaryKey); });
  }
  count(query) {
    const range = toRange(query);
    return this.objectStore.transaction._request(this, () => this._rows(range).length);
  }
  openCursor(query, direction) { return this.objectStore._cursor(query, direction, false, this._def); }
  openKeyCursor(query, direction) { return this.objectStore._cursor(query, direction, true, this._def); }
}

/* ------------------------------------------------------------------ Databases */

class FakeIDBDatabase extends Target {
  constructor(factory, data) {
    super();
    this._factory = factory;
    this._data = data;
    this.name = data.name;
    this.version = data.version;
    this._closed = false;
    this._upgradeTx = null;
    this.onversionchange = null;
    this.onclose = null;
    this.onabort = null;
    this.onerror = null;
    data.connections.add(this);
  }
  get objectStoreNames() { return new StringList(this._data.stores.keys()); }

  createObjectStore(name, { keyPath = null, autoIncrement = false } = {}) {
    const tx = this._upgradeTx;
    if (!tx || tx._state === 'finished') throw domError('InvalidStateError', 'Object stores can only be created in an upgrade transaction');
    if (this._data.stores.has(name)) throw domError('ConstraintError', `Object store ${name} already exists`);
    if (autoIncrement && (keyPath === '' || Array.isArray(keyPath))) throw domError('InvalidAccessError');
    this._data.stores.set(name, { keyPath, autoIncrement, next: 1, records: new Map(), indexes: new Map() });
    tx._names = [...this._data.stores.keys()];
    tx.objectStoreNames = new StringList(tx._names);
    return new FakeIDBObjectStore(tx, name);
  }

  deleteObjectStore(name) {
    const tx = this._upgradeTx;
    if (!tx || tx._state === 'finished') throw domError('InvalidStateError', 'Object stores can only be deleted in an upgrade transaction');
    if (!this._data.stores.has(name)) throw domError('NotFoundError', `No object store ${name}`);
    this._data.stores.delete(name);
    tx._names = [...this._data.stores.keys()];
    tx.objectStoreNames = new StringList(tx._names);
  }

  transaction(names, mode = 'readonly', _opts) {
    if (this._closed) throw domError('InvalidStateError', 'Connection closed');
    if (this._upgradeTx && this._upgradeTx._state !== 'finished') throw domError('InvalidStateError', 'The upgrade transaction is still running');
    const list = typeof names === 'string' ? [names] : [...names];
    if (!list.length) throw domError('InvalidAccessError', 'A transaction needs at least one object store');
    for (const n of list) if (!this._data.stores.has(n)) throw domError('NotFoundError', `No object store ${n}`);
    if (mode !== 'readonly' && mode !== 'readwrite') throw new TypeError(`Invalid transaction mode: ${mode}`);
    return new FakeIDBTransaction(this, [...new Set(list)], mode);
  }

  close() {
    this._closed = true;
    this._data.connections.delete(this);
  }
}

/* ------------------------------------------------------------------ Factory */

export class FakeIDBFactory {
  constructor({ quotaBytes = Infinity, quotaMode = 'request' } = {}) {
    this.quotaBytes = quotaBytes;
    this.quotaMode = quotaMode;
    this.forceQuota = false;
    this.log = [];
    this._dbs = new Map();
    this.opened = [];
  }

  usage() {
    let s = 0;
    for (const db of this._dbs.values()) for (const store of db.stores.values()) for (const rec of store.records.values()) s += rec.bytes;
    return s;
  }

  dbNames() { return [...this._dbs.keys()].sort(); }
  storeNamesOf(name) { return [...(this._dbs.get(name)?.stores.keys() ?? [])].sort(); }
  /** All records in a store (for observability, bypasses transactions) */
  records(dbName, storeName) {
    const store = this._dbs.get(dbName)?.stores.get(storeName);
    return store ? sortedRecords(store).map((r) => ({ key: r.key, value: r.value, bytes: r.bytes })) : [];
  }

  cmp(a, b) { return cmp(a, b); }

  open(name, version) {
    if (version !== undefined && !(Number.isInteger(version) && version >= 1)) throw new TypeError('The version must be a positive integer');
    const req = new FakeIDBOpenDBRequest();
    this.opened.push(name);
    setImmediate(() => {
      let data = this._dbs.get(name);
      const fresh = !data;
      if (!data) {
        data = new DbData(name);
        this._dbs.set(name, data);
      }
      const want = version ?? Math.max(1, data.version);
      if (want < data.version) {
        if (fresh) this._dbs.delete(name);
        req.readyState = 'done';
        req._error = domError('VersionError', `Requested version ${want} is lower than the existing ${data.version}`);
        req._fire(new FakeEvent('error', req));
        return;
      }
      if (want > data.version) {
        for (const c of [...data.connections]) c._fire(new FakeEvent('versionchange', c, { oldVersion: data.version, newVersion: want }));
        const oldVersion = data.version;
        const snapshot = new Map([...data.stores].map(([n, s]) => [n, s]));
        data.version = want;
        const db = new FakeIDBDatabase(this, data);
        const tx = new FakeIDBTransaction(db, [...data.stores.keys()], 'versionchange');
        tx._storeUndo = () => { data.stores = snapshot; data.version = oldVersion; };
        db._upgradeTx = tx;
        req.transaction = tx;
        req.readyState = 'done';
        req._result = db;
        tx._onFinishAbort = () => {
          db.close();
          if (fresh) this._dbs.delete(name);
          req.transaction = null;
          req._result = undefined;
          req._error = domError('AbortError', 'The upgrade transaction was aborted');
          req._fire(new FakeEvent('error', req));
        };
        tx.addEventListener('complete', () => {
          db._upgradeTx = null;
          req.transaction = null;
          db.version = data.version;
          req._fire(new FakeEvent('success', req));
        });
        req._fire(new FakeEvent('upgradeneeded', req, { oldVersion, newVersion: want }));
        return;
      }
      const db = new FakeIDBDatabase(this, data);
      req.readyState = 'done';
      req._result = db;
      req._fire(new FakeEvent('success', req));
    });
    return req;
  }

  deleteDatabase(name) {
    const req = new FakeIDBOpenDBRequest();
    setImmediate(() => {
      const data = this._dbs.get(name);
      const oldVersion = data?.version ?? 0;
      if (data) for (const c of [...data.connections]) c._fire(new FakeEvent('versionchange', c, { oldVersion, newVersion: null }));
      this._dbs.delete(name);
      req.readyState = 'done';
      req._result = undefined;
      req._fire(new FakeEvent('success', req, { oldVersion, newVersion: null }));
    });
    return req;
  }

  async databases() {
    return [...this._dbs.values()].map((d) => ({ name: d.name, version: d.version }));
  }
}

/** Installs stubs onto globals (`indexedDB`, `IDBKeyRange`), returning a restore function */
export function installFakeIndexedDB(factory) {
  const keys = ['indexedDB', 'IDBKeyRange'];
  const saved = keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: FakeIDBKeyRange, configurable: true, writable: true });
  return () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  };
}

export { MiB };
