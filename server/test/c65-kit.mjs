/**
 * For testing only; production code must not reference this.
 *
 * Shared module for the first batch of C6.5 contract tests (c65-kernel, c65-docservice).
 * Based solely on `docs/plan/c65-design.md` Sections 2, 3, 4, 6, 7, 8, 10 and Section 11 V1~V8;
 * test authors did not look at the implementation.
 *
 * Function names, module paths, and message field names not hardcoded in the design doc are all
 * centralized in this file, so only this file needs changes when reconciling during integration.
 * Each assumption is marked as "Assumption A<n>", and listed with the same numbering in the
 * report `docs/archive/agent-reports/AGENT-c65-tests.md`.
 *
 *   A1  JSON path engine: `server/docservice/json-ops.mjs` exports `applyOps(doc, ops)` (Section 11
 *       of the design doc named the file, but not the function). On success, returns the new
 *       document (or modifies in place and returns undefined / the same object; both are
 *       accepted); on failure, throws an error where `err.reason ?? err.code` is `'bad-path'`,
 *       or returns `{ ok: false, reason }`.
 *   A2  Diff algorithm: `src/kernel/diffProject.ts` exports
 *       `diffProject(prev, next) → { ops, inverse }` (Section 2 of the design doc specified the
 *       name and return value).
 *   A3  Document service project module: still `projectModule({ store, now })` in
 *       `server/docservice/modules/project.mjs`, upgraded to handle `project.op`; storage continues
 *       to use `createMemoryStore` / `createFileStore({ dir })` from `store/index.mjs`.
 *   A4  `project.op` responses correspond by `opId` (both `project.op.ok` and `project.op.rejected`
 *       carry `opId`, Section 3 of design doc); `project.state` corresponds by `projectId`. The
 *       version number field is always named `rev` (original text in Section 3 of design doc),
 *       not the legacy `projectRev`.
 *   A5  The `entity` in overwrite notifications is a string path, such as `/tracks/@t1/clips/@c2`,
 *       `/meta`; `by` is the write identity (actor object, containing at least `userId` and
 *       `session`, with page connections additionally carrying `deviceId`).
 *   A6  Write identity = principal (`userId`, `deviceId`, `role`, `conversation`) + `session` in
 *       the message. The test's `authenticate` supplies principal based on query string
 *       `?user=&dev=&role=&conv=`.
 *   A7  Page sync: `src/store/docsync.ts` exports `createDocSync(options)`, see comments on
 *       `createPage` below.
 *   A8  Under file storage, the operation log is `<dir>/projects/<projectId>.ops.ndjson`
 *       (Section 3 of the design doc wrote `projects/<id>.ops.ndjson`, which is understood here as
 *       "under storage root directory").
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocService } from '../docservice/service.mjs';
import { wsClient, createTcpProxy, sleep, waitFor } from './fake-ws-kit.mjs';

export { sleep, waitFor };

// ================================================================== Loading modules under test (A1, A2, A3, A7)

/** A1 */
export async function loadJsonOps() {
  const mod = await import('../docservice/json-ops.mjs');
  assert.equal(typeof mod.applyOps, 'function', `json-ops.mjs must export applyOps; exports: ${Object.keys(mod).join(', ')}`);
  /**
   * Normalize to `{ ok: true, doc } | { ok: false, reason }`. Passes `doc` itself without copying
   * on behalf of the caller: atomicity test cases need to verify whether the original object was
   * mutated upon failure.
   */
  function apply(doc, ops) {
    let out;
    try {
      out = mod.applyOps(doc, ops);
    } catch (err) {
      // Integration reconciliation (A1): the engine internally calls format errors `bad-op`, but the
      // document service still returns `bad-path` externally (c65-ops-spec.md Section 2)
      const code = err?.reason ?? err?.code ?? String(err?.message ?? err);
      return { ok: false, reason: code === 'bad-op' ? 'bad-path' : code, error: err };
    }
    // Integration reconciliation (A1): actual `applyOps` returns `{ root, effects }`
    // (copy-on-write, does not mutate passed-in document)
    if (out && typeof out === 'object' && 'root' in out && Array.isArray(out.effects)) return { ok: true, doc: out.root };
    if (out && typeof out === 'object' && out.ok === false) return { ok: false, reason: out.reason ?? out.code };
    if (out && typeof out === 'object' && out.ok === true && 'doc' in out) return { ok: true, doc: out.doc };
    return { ok: true, doc: out === undefined ? doc : out };
  }
  /** Make a copy before applying; on failure, assert failure directly */
  function applyClone(doc, ops, what = 'applying ops') {
    const r = apply(structuredClone(doc), ops);
    assert.ok(r.ok, `${what} failed: ${r.reason}; ops=${JSON.stringify(ops).slice(0, 600)}`);
    return r.doc;
  }
  return { mod, apply, applyClone };
}

/** A2 */
export async function loadDiffProject() {
  const mod = await import('../../src/kernel/diffProject.ts');
  assert.equal(typeof mod.diffProject, 'function', `diffProject.ts must export diffProject; exports: ${Object.keys(mod).join(', ')}`);
  return mod.diffProject;
}

/** A3 */
export async function loadProjectModule() {
  const mod = await import('../docservice/modules/project.mjs');
  assert.equal(typeof mod.projectModule, 'function', `modules/project.mjs must export projectModule; exports: ${Object.keys(mod).join(', ')}`);
  const store = await import('../docservice/store/index.mjs');
  return { projectModule: mod.projectModule, createMemoryStore: store.createMemoryStore, createFileStore: store.createFileStore };
}

/**
 * A7. Integration reconciliation: the actual `docsync.ts` exports the `DocSync` class, with
 * transport handled via injection (`send` out, `receive` in, `connect` / `disconnect` to notify
 * connection state), without connecting to the network itself. Here, Node's global `WebSocket`
 * wraps it to produce the shape of Assumption A7's `createDocSync(options)`; it only adapts the
 * interface without changing behavior:
 *   - `submit(d, { coalesce })` → `ds.commit(page's current project, { mergeKey: coalesce })`
 *     (DocSync computes diff again itself);
 *   - `skipped[].by` in `undo()` / `redo()` is `{ actor, session }`, flattened into
 *     `{ ...actor, session }` (A5);
 *   - `saveWhenConfirmed(write)` → `write(project, rev)` after `ds.whenSettled()`;
 *   - `resolveOffline('replay' | 'discard')` → `ds.replayOffline()` / `ds.discardOffline()`;
 *   - when state changes to `paused`, invokes `onOfflineConflict(ds.pausedInfo)`; reconnects
 *     every 50 ms after disconnection.
 * Relative imports without extensions in `.ts` rely on resolution hooks from
 * `src/testing/registerTs.mjs` (same as unit tests under src).
 */
export async function loadDocSync() {
  await import('../../src/testing/registerTs.mjs');
  const mod = await import('../../src/store/docsync.ts');
  if (typeof mod.createDocSync === 'function') return mod.createDocSync;
  assert.equal(typeof mod.DocSync, 'function', `docsync.ts must export createDocSync or DocSync; exports: ${Object.keys(mod).join(', ')}`);
  return (options) => docSyncOverWebSocket(mod.DocSync, options);
}

function docSyncOverWebSocket(DocSync, o) {
  let ws = null;
  let isOpen = false;
  let closed = false;
  let retry = null;
  const ds = new DocSync(o.getProject?.() ?? {}, {
    projectId: o.projectId,
    session: o.session,
    send: (msg) => { if (ws && isOpen) ws.send(JSON.stringify(msg)); },
    now: o.now,
    saveBackup: (b) => o.backup?.(b),
  });
  ds.on('project', (p) => o.setProject(p));
  ds.on('status', (s) => { if (s === 'paused') o.onOfflineConflict?.(ds.pausedInfo); });

  const dial = () => {
    retry = null;
    if (closed) return;
    const sock = new WebSocket(o.url);
    ws = sock;
    let dropped = false;
    const drop = () => {
      if (dropped) return;
      dropped = true;
      if (ws === sock && isOpen) { isOpen = false; ds.disconnect(); }
      if (ws === sock && !closed && !retry) retry = setTimeout(dial, 50);
    };
    sock.addEventListener('open', () => { if (ws !== sock || closed) return; isOpen = true; ds.connect(); });
    sock.addEventListener('message', (e) => {
      if (ws !== sock) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      ds.receive(msg);
    });
    sock.addEventListener('close', drop);
    sock.addEventListener('error', drop);
  };

  const flatBy = (by) => (by && typeof by === 'object' ? { ...(by.actor && typeof by.actor === 'object' ? by.actor : {}), session: by.session ?? by.actor?.session } : by);
  const undoResult = (r) => (r ? { ...r, skipped: r.skipped.map((s) => ({ ...s, by: flatBy(s.by) })) } : { done: false, skipped: [], failed: [] });

  return {
    ds,
    open() { dial(); return Promise.resolve(); },
    submit(_d, opts) { ds.commit(o.getProject(), { mergeKey: opts?.coalesce }); },
    pendingCount: () => ds.unconfirmed,
    get connected() { return isOpen; },
    get rev() { return ds.rev; },
    resolveOffline(choice) {
      if (choice === 'replay') ds.replayOffline();
      else if (choice === 'discard') ds.discardOffline();
      else throw new Error(`unknown choice: ${choice}`);
      return Promise.resolve();
    },
    undo: () => Promise.resolve(undoResult(ds.undo())),
    redo: () => Promise.resolve(undoResult(ds.redo())),
    canUndo: () => ds.canUndo(),
    canRedo: () => ds.canRedo(),
    saveWhenConfirmed: (write) => ds.whenSettled().then(({ project, rev }) => write(project, rev)),
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      if (ws) ws.close();
      isOpen = false;
    },
  };
}

// ================================================================== Miscellaneous

export const T0 = 1_700_000_000_000;
export const MIN = 60_000;

/** Create temporary directory and delete it when the test case finishes */
export function tempDir(t, prefix = 'pc-c65-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Pseudo-random with fixed seed (mulberry32) */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
  return r;
}

let opSeq = 0;
export const newOpId = (tag = 'op') => `${tag}-${process.pid}-${Date.now().toString(36)}-${++opSeq}`;

/** Path segments (JSON Pointer, `~1` → `/`, `~0` → `~`) */
export function splitPath(path) {
  if (path === '') return [];
  assert.ok(path.startsWith('/'), `path must start with /: ${path}`);
  return path.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** String length in UTF-8 bytes */
export const bytesOf = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');

// ================================================================== Generate projects
// (shape follows Project in src/kernel/project.ts)

let clipSeq = 0;
const freshId = (prefix, r) => `${prefix}${++clipSeq}${r ? `-${r.int(1e6).toString(36)}` : ''}`;

function randScalar(r) {
  switch (r.int(6)) {
    case 0: return r.int(2000) - 1000;
    case 1: return Math.round(r.next() * 1e4) / 100;
    case 2: return r.chance(0.5);
    case 3: return null;
    case 4: return `s${r.int(1000)}`;
    default: return r.pick(['', '中文', 'a/b', 'x~y', ' 空格 ']);
  }
}

/** Arbitrary JSON value (bounded depth); arrays never have id (treated as a single value as a whole) */
function randValue(r, depth = 0) {
  const k = depth > 2 ? 0 : r.int(4);
  if (k === 0 || k === 1) return randScalar(r);
  if (k === 2) {
    const n = r.int(4);
    return Array.from({ length: n }, () => randValue(r, depth + 1));
  }
  const o = {};
  const n = r.int(4);
  for (let i = 0; i < n; i++) o[r.pick(['a', 'b', 'c', 'd/e', 'f~g', 'Medium'])] = randValue(r, depth + 1);
  return o;
}

export function makeClip(r, id = freshId('c', r)) {
  const clip = {
    id,
    start: Math.round(r.next() * 600) / 10,
    duration: 1 + r.int(10),
    cardId: r.pick(['title', 'lower-third', 'counter', undefined]),
    params: { text: `t${r.int(100)}`, size: r.int(80) },
  };
  if (clip.cardId === undefined) delete clip.cardId;
  if (r.chance(0.5)) clip.frame = { x: r.int(1920), y: r.int(1080), w: 400, h: 200 };
  if (r.chance(0.3)) clip.keyframes = [{ t: 0, v: 0 }, { t: 1, v: r.int(10) }]; // Array without id
  if (r.chance(0.2)) clip.filter = { id: `f${r.int(3)}`, values: { amount: r.next() } };
  return clip;
}

export function makeTrack(r, id = freshId('t', r), nClips = r.int(6)) {
  return { id, name: `Track ${id}`, clips: Array.from({ length: nClips }, () => makeClip(r)) };
}

/** A random project matching the Project shape */
export function makeProject(r, { tracks = 1 + r.int(4), clipsPerTrack } = {}) {
  const p = {
    version: 1,
    id: `p-${r.int(1e9).toString(36)}`,
    name: `Project ${r.int(100)}`,
    width: 1920,
    height: 1080,
    fps: r.pick([24, 25, 30, 60]),
    duration: 10 + r.int(100),
    themeId: r.pick(['midnight', 'paper']),
    media: Array.from({ length: r.int(4) }, () => ({ id: freshId('m', r), name: `Media${r.int(9)}.mp4`, kind: 'video', duration: r.int(60) })),
    tracks: Array.from({ length: tracks }, () => makeTrack(r, undefined, clipsPerTrack ?? r.int(6))),
    filters: Array.from({ length: r.int(3) }, (_, i) => ({ id: `f${i}`, name: `Filter ${i}`, params: { amount: r.next() } })),
    style: { 'a/b': 1, 'x~y': 'z', nested: { k: [1, 2, 3] } },
  };
  if (r.chance(0.5)) p.cuts = [{ id: 'cut-1', name: 'Cut 1' }, { id: 'cut-2', name: 'Cut 2', tracks: [makeTrack(r, undefined, 2)], duration: 20 }];
  if (r.chance(0.3)) p.camera3dFov = 45;
  return p;
}

/** Randomly mutate one place in an object (plain object keys: modify, delete, add; change type) */
function mutateObject(r, o, protect = []) {
  const keys = Object.keys(o).filter((k) => k !== 'id' && !protect.includes(k));
  const which = r.int(4);
  if (which === 0 && keys.length) { delete o[r.pick(keys)]; return; }
  if (which === 1 && keys.length) { o[r.pick(keys)] = randValue(r); return; }
  if (which === 2) { o[r.pick(['k1', 'k/2', 'k~3', '新键'])] = randValue(r); return; }
  if (keys.length) {
    const k = r.pick(keys);
    if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) mutateObject(r, o[k]);
    else o[k] = randValue(r);
  }
}

/**
 * Array whose elements are all objects with an id (empty arrays count too); random mutations
 * may replace clips with another value, after which it is no longer used as a clip table
 */
const isIdList = (a) => Array.isArray(a) && a.every((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string');

/** Random insert, delete, move, and id replacement on arrays with id */
function mutateIdArray(r, arr, make) {
  const k = r.int(5);
  if (k === 0 || arr.length === 0) { arr.splice(r.int(arr.length + 1), 0, make()); return; }
  if (k === 1) { arr.splice(r.int(arr.length), 1); return; }
  if (k === 2) { const [x] = arr.splice(r.int(arr.length), 1); arr.splice(r.int(arr.length + 1), 0, x); return; }
  if (k === 3) { const i = r.int(arr.length); arr[i] = make(); return; }
  mutateObject(r, arr[r.int(arr.length)]);
}

/** Randomly mutate 1~6 places on a copy of prev to produce next (prev untouched) */
export function mutateProject(r, prev) {
  const p = structuredClone(prev);
  const n = 1 + r.int(6);
  for (let i = 0; i < n; i++) {
    switch (r.int(9)) {
      case 0: mutateObject(r, p, ['tracks', 'media']); break;
      case 1: mutateIdArray(r, p.tracks, () => makeTrack(r)); break;
      case 2: case 3: case 4: {
        if (!p.tracks.length) { p.tracks.push(makeTrack(r)); break; }
        const t = r.pick(p.tracks);
        if (!isIdList(t.clips)) t.clips = [];
        mutateIdArray(r, t.clips, () => makeClip(r));
        break;
      }
      case 5: {
        // Move clip across tracks
        const from = p.tracks.find((t) => isIdList(t.clips) && t.clips.length);
        const to = p.tracks.length ? r.pick(p.tracks) : null;
        if (from && to && isIdList(to.clips)) {
          const [c] = from.clips.splice(r.int(from.clips.length), 1);
          to.clips.splice(r.int(to.clips.length + 1), 0, c);
        }
        break;
      }
      case 6: if (isIdList(p.media)) mutateIdArray(r, p.media, () => ({ id: freshId('m', r), name: 'n.mp4', kind: 'video' })); break;
      case 7: {
        const c = p.tracks.flatMap((t) => (isIdList(t.clips) ? t.clips : [])).find(() => r.chance(0.5));
        if (c) c.keyframes = Array.from({ length: r.int(4) }, (_, j) => ({ t: j, v: r.int(9) }));
        break;
      }
      default: p.fps = r.pick([24, 25, 30, 60]); p.name = `Project ${r.int(1000)}`;
    }
  }
  return p;
}

/** Small project with fixed shape: one track t1, clips c1..cN, frame.x = 10*i */
export function fixedProject({ clips = 3, tracks = 1 } = {}) {
  return {
    version: 1,
    id: 'p-fixed',
    name: 'Fixed project',
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 30,
    themeId: 'midnight',
    media: [],
    filters: [{ id: 'f1', name: 'Filter 1', params: { amount: 0.5 } }],
    tracks: Array.from({ length: tracks }, (_, ti) => ({
      id: `t${ti + 1}`,
      name: `Track ${ti + 1}`,
      clips: Array.from({ length: clips }, (_, i) => ({
        id: ti === 0 ? `c${i + 1}` : `t${ti + 1}c${i + 1}`,
        start: i * 3,
        duration: 3,
        cardId: 'title',
        params: { text: `clip ${i + 1}` },
        frame: { x: 10 * (i + 1), y: 0, w: 100, h: 100 },
      })),
    })),
  };
}

/** Find clip (inspects tracks only) */
export function clipOf(p, clipId) {
  for (const t of p?.tracks ?? []) for (const c of t.clips ?? []) if (c.id === clipId) return c;
  return undefined;
}

// ================================================================== Document service (A3, A4, A6)

/** A6: `?user=&dev=&role=&conv=` → principal */
export function authC65(req) {
  const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const user = q.get('user') ?? 'u-default';
  if (user === 'deny') return null;
  const p = { userId: user, tenantId: 't-c65' };
  if (q.get('dev')) p.deviceId = q.get('dev');
  if (q.get('role')) p.role = q.get('role');
  if (q.get('conv')) p.conversation = q.get('conv');
  return p;
}

/**
 * Start a standalone document service with the project module mounted (port 0, autoTick: false).
 * `clock.t` is the injected time; the 10 minutes for overwrite notifications are calculated from it.
 * → { service, port, url(who), connect(who), store, clock, cleanup }
 *   who = { user, dev, role, conv }
 */
export async function startProjectService({ store, clock = { t: T0 }, dir } = {}) {
  const { projectModule, createMemoryStore, createFileStore } = await loadProjectModule();
  const s = store ?? (dir ? createFileStore({ dir }) : createMemoryStore());
  const now = () => clock.t;
  const logs = [];
  const service = createDocService({
    log: (event, fields) => logs.push({ event, ...fields }),
    autoTick: false,
    authenticate: authC65,
    now,
    modules: [projectModule({ store: s, now })],
  });
  const { port } = await service.listen(0, '127.0.0.1');
  const clients = [];
  const query = (who = {}) => {
    const q = new URLSearchParams();
    q.set('user', who.user ?? 'u-default');
    if (who.dev) q.set('dev', who.dev);
    if (who.role) q.set('role', who.role);
    if (who.conv) q.set('conv', who.conv);
    return q.toString();
  };
  const url = (who, p = port) => `ws://127.0.0.1:${p}/?${query(who)}`;
  const connect = async (who) => {
    const c = wsClient(url(who));
    clients.push(c);
    await c.opened;
    return c;
  };
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    for (const c of clients) c.close();
    await service.close();
  };
  return { service, port, url, connect, store: s, clock, logs, cleanup };
}

export const byType = (type) => (m) => m?.type === type;
export const isOk = (m) => m?.type === 'project.op.ok';
export const isRejected = (m) => m?.type === 'project.op.rejected';

/** A4: Open project, wait for project.state */
export async function openProject(c, projectId, ms = 3000) {
  c.send({ type: 'project.open', projectId, reqId: `open-${newOpId()}` });
  const st = await c.next((m) => m?.type === 'project.state' && m.projectId === projectId, ms);
  return st;
}

/**
 * A4: Submit a batch of operations, wait for this batch's ok / rejected (matched by opId).
 * → The response message itself
 */
export async function submit(c, { projectId, ops, expectRev, session = 'sess-test', undoOf, opId = newOpId() }, ms = 3000) {
  const msg = { type: 'project.op', projectId, opId, session, ops };
  if (expectRev !== undefined) msg.expectRev = expectRev;
  if (undoOf !== undefined) msg.undoOf = undoOf;
  c.send(msg);
  return c.next((m) => (isOk(m) || isRejected(m)) && m.opId === opId, ms);
}

/** Write project in using root replacement; returns rev from ok */
export async function seedProject(env, projectId, project, who = { user: 'seeder', dev: 'dev-seed' }) {
  const c = await env.connect(who);
  await openProject(c, projectId);
  const r = await submit(c, { projectId, ops: [{ op: 'set', path: '', value: project }], session: 'seed' });
  assert.ok(isOk(r), `the root replacement seed should succeed: ${JSON.stringify(r)}`);
  c.close();
  return r.rev;
}

/** Reconnect, open, and read server's current { rev, project } */
export async function serverState(env, projectId) {
  const c = await env.connect({ user: 'reader', dev: 'dev-reader' });
  const st = await openProject(c, projectId);
  c.close();
  return { rev: st.rev, project: st.project, writers: st.writers };
}

/** A5: Whether by matches this write identity */
export function byIs(by, { user, session }) {
  return by && by.userId === user && (session === undefined || by.session === session);
}

// ================================================================== Page sync (A7)

/**
 * A7: Page sync instance. Assumed shape of `createDocSync(options)` is as follows (Sections 4, 6,
 * 8 of the design doc only described behavior):
 *
 *   options.url            WebSocket URL of document service (including query string; test's
 *                          authenticate uses it to determine principal)
 *   options.projectId
 *   options.session        Page session id (part of write identity, goes into every project.op)
 *   options.getProject()   Read the page's current project (the copy in store)
 *   options.setProject(p)  Replace the page's project with others' operations / rollbacks /
 *                          replays / undo results; **does not enter undo stack, does not send back**
 *                          (Section 4 "via set")
 *   options.now()          Clock (used for 300 ms debounce/merge of numeric inputs)
 *   options.backup(rec)    Store local backup (Section 3 "save one's own version of the entity as
 *                          a local backup first", Section 8 "backup before discarding");
 *                          rec has at least `entity` and `value` (when overwritten)
 *   options.onOfflineConflict(info)   Called when first offline replay is rejected and the whole
 *                          batch stops (Section 6)
 *
 *   sync.open() → Promise           Connect and open project; hand project over to setProject after
 *                                   receiving project.state
 *   sync.submit({ ops, inverse }, { coalesce? })   Local modification (core.ts setProject has
 *                                                  already committed locally and computed diff)
 *   sync.pendingCount() → number    Number of local submissions that have not yet received ok
 *                                   (including offline pending queue)
 *   sync.connected → boolean        Whether currently connected
 *   sync.rev → number               Last confirmed server version
 *   sync.resolveOffline('replay' | 'discard') → Promise
 *   sync.undo() / sync.redo() → Promise<{ skipped: [{ entity, by }] }>   Undo / redo (Section 8)
 *   sync.canUndo() / sync.canRedo() → boolean
 *   sync.saveWhenConfirmed(write) → Promise   Call write(project, rev) after all local operations
 *                                             are ok (Section 4 .proc)
 *   sync.close()
 *
 * Wrapper for testing: page store is just the single variable `page.project`; `page.edit(fn)` is
 * equivalent to core.ts setProject: copy, mutate, diffProject, apply locally, hand over to
 * sync.submit.
 */
export async function createPage(env, { projectId, user, dev = `dev-${user}`, session, via, now = () => env.clock.t, backups = [] }) {
  const createDocSync = await loadDocSync();
  const diffProject = await loadDiffProject();
  const page = { project: null, backups, conflicts: [], session, user };
  const port = via?.port ?? env.port;
  const sync = createDocSync({
    url: env.url({ user, dev }, port),
    projectId,
    session,
    getProject: () => page.project,
    setProject: (p) => { page.project = p; },
    now,
    backup: (rec) => { backups.push(structuredClone(rec)); },
    onOfflineConflict: (info) => { page.conflicts.push(info); },
  });
  page.sync = sync;
  await sync.open();
  await waitFor(() => page.project !== null && page.project !== undefined, 5000, `page ${session} gets the project`);

  /** Equivalent to core.ts setProject(next): apply locally first, then hand diff over to docsync */
  page.edit = (mutate, opts) => {
    const prev = page.project;
    const next = structuredClone(prev);
    mutate(next);
    const d = diffProject(prev, next);
    page.project = next;
    if (d.ops.length) sync.submit(d, opts);
    return d;
  };
  page.pending = () => sync.pendingCount();
  /** Wait until all local commits are confirmed */
  page.settled = (ms = 10_000) => waitFor(() => sync.pendingCount() === 0, ms, `all commits of page ${session} are acknowledged`);
  page.undo = () => sync.undo();
  page.redo = () => sync.redo();
  page.canUndo = () => sync.canUndo();
  page.canRedo = () => sync.canRedo();
  page.save = (write) => sync.saveWhenConfirmed(write);
  page.resolveOffline = (choice) => sync.resolveOffline(choice);
  page.close = () => sync.close();
  return page;
}

/**
 * Disconnectable channel: the page connects to the document service via a TCP proxy. `offline()`
 * closes existing connections and rejects new connections; `online()` allows them through.
 * Page sync must detect disconnections and reconnect on its own (Section 6, "Save locally as
 * usual when connection fails").
 */
export async function createLink(env) {
  const proxy = await createTcpProxy({ target: env.port });
  return {
    port: proxy.port,
    proxy,
    async offline(page) {
      proxy.mode = 'reject';
      proxy.cutAll();
      if (page) await waitFor(() => page.sync.connected === false, 5000, 'the page detects the disconnection');
      else await sleep(200);
    },
    online() { proxy.mode = 'pass'; },
    close: () => proxy.close(),
  };
}

/** Observer: a raw connection; opens project and collects project.ops (never commits, receives everyone's) */
export async function observer(env, projectId) {
  const c = await env.connect({ user: 'watcher', dev: 'dev-watch' });
  await openProject(c, projectId);
  return {
    c,
    ops: () => c.all.filter(byType('project.ops')),
    close: () => c.close(),
  };
}

/** Three copies are equal: first deepEqual (showing differences), then byte-by-byte */
export function assertSameBytes(a, b, what) {
  assert.deepEqual(a, b, `${what}: content differs`);
  assert.equal(JSON.stringify(a), JSON.stringify(b), `${what}: content is the same but the serialized bytes differ (key order is inconsistent)`);
}
