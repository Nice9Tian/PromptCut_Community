/**
 * 仅供测试，生产代码不得引用。
 *
 * C6.5 第一批（c65-kernel、c65-docservice）契约测试的公共件。依据只有 `docs/plan/c65-design.md`
 * 第 2、3、4、6、7、8、10 节与第 11 节 V1～V8；测试方没看实现。
 *
 * 设计稿没写死的函数名、模块路径、消息字段名全部集中在本文件，集成时对账只改这里。
 * 每一处假设用「假设 A<n>」标出，报告 `docs/archive/agent-reports/AGENT-c65-tests.md` 按同样的编号列出。
 *
 *   A1  JSON 路径引擎：`server/docservice/json-ops.mjs` 导出 `applyOps(doc, ops)`（设计稿第 11 节点名了文件，没点名函数）。
 *       成功返回新文档（或原地改后返回 undefined / 同一对象，都认）；失败抛错，`err.reason ?? err.code` 为
 *       `'bad-path'`，或返回 `{ ok: false, reason }`。
 *   A2  差异算法：`src/kernel/diffProject.ts` 导出 `diffProject(prev, next) → { ops, inverse }`（设计稿第 2 节写了名字与返回值）。
 *   A3  文档服务项目模块：仍是 `server/docservice/modules/project.mjs` 的 `projectModule({ store, now })`，
 *       升级后接 `project.op`；存储沿用 `store/index.mjs` 的 `createMemoryStore` / `createFileStore({ dir })`。
 *   A4  `project.op` 的回包按 `opId` 对应（`project.op.ok` / `project.op.rejected` 都带 `opId`，设计稿第 3 节）；
 *       `project.state` 按 `projectId` 对应。版本号字段一律叫 `rev`（设计稿第 3 节原文），不是旧的 `projectRev`。
 *   A5  覆盖通知的 `entity` 是字符串路径，如 `/tracks/@t1/clips/@c2`、`/meta`；`by` 是写入身份（actor 对象，
 *       至少带 `userId` 与 `session`，页面连接另带 `deviceId`）。
 *   A6  写入身份 = principal（`userId`、`deviceId`、`role`、`conversation`）+ 消息里的 `session`。测试的 `authenticate`
 *       按查询串 `?user=&dev=&role=&conv=` 给 principal。
 *   A7  页面同步：`src/store/docsync.ts` 导出 `createDocSync(options)`，见下文 `createPage` 的注释。
 *   A8  文件存储下，操作日志是 `<dir>/projects/<projectId>.ops.ndjson`（设计稿第 3 节写的是
 *       `projects/<id>.ops.ndjson`，这里按「存储根目录下」理解）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocService } from '../docservice/service.mjs';
import { wsClient, createTcpProxy, sleep, waitFor } from './fake-ws-kit.mjs';

export { sleep, waitFor };

// ================================================================== 被测模块的载入（A1、A2、A3、A7）

/** A1 */
export async function loadJsonOps() {
  const mod = await import('../docservice/json-ops.mjs');
  assert.equal(typeof mod.applyOps, 'function', `json-ops.mjs 要导出 applyOps；导出：${Object.keys(mod).join(', ')}`);
  /**
   * 规整成 `{ ok: true, doc } | { ok: false, reason }`。传进去的就是 `doc` 本身，不替调用方复制：
   * 原子性用例要看失败后原对象有没有被改。
   */
  function apply(doc, ops) {
    let out;
    try {
      out = mod.applyOps(doc, ops);
    } catch (err) {
      // 集成对账（A1）：引擎内部把格式错叫 `bad-op`，文档服务对外同样回 `bad-path`（c65-ops-spec.md 第 2 节）
      const code = err?.reason ?? err?.code ?? String(err?.message ?? err);
      return { ok: false, reason: code === 'bad-op' ? 'bad-path' : code, error: err };
    }
    // 集成对账（A1）：实际的 `applyOps` 返回 `{ root, effects }`（写时复制，不改传入的文档）
    if (out && typeof out === 'object' && 'root' in out && Array.isArray(out.effects)) return { ok: true, doc: out.root };
    if (out && typeof out === 'object' && out.ok === false) return { ok: false, reason: out.reason ?? out.code };
    if (out && typeof out === 'object' && out.ok === true && 'doc' in out) return { ok: true, doc: out.doc };
    return { ok: true, doc: out === undefined ? doc : out };
  }
  /** 复制一份再应用；失败直接断言失败 */
  function applyClone(doc, ops, what = '应用操作') {
    const r = apply(structuredClone(doc), ops);
    assert.ok(r.ok, `${what}失败：${r.reason}；ops=${JSON.stringify(ops).slice(0, 600)}`);
    return r.doc;
  }
  return { mod, apply, applyClone };
}

/** A2 */
export async function loadDiffProject() {
  const mod = await import('../../src/kernel/diffProject.ts');
  assert.equal(typeof mod.diffProject, 'function', `diffProject.ts 要导出 diffProject；导出：${Object.keys(mod).join(', ')}`);
  return mod.diffProject;
}

/** A3 */
export async function loadProjectModule() {
  const mod = await import('../docservice/modules/project.mjs');
  assert.equal(typeof mod.projectModule, 'function', `modules/project.mjs 要导出 projectModule；导出：${Object.keys(mod).join(', ')}`);
  const store = await import('../docservice/store/index.mjs');
  return { projectModule: mod.projectModule, createMemoryStore: store.createMemoryStore, createFileStore: store.createFileStore };
}

/**
 * A7。集成对账：实际的 `docsync.ts` 导出 `DocSync` 类，传输靠注入（`send` 出、`receive` 进、
 * `connect` / `disconnect` 告诉它连接状态），不自己连网。这里用 Node 的全局 `WebSocket` 包一层，
 * 做出假设 A7 的 `createDocSync(options)` 形状；只翻译接口，不改行为：
 *   - `submit(d, { coalesce })` → `ds.commit(页面当前的项目, { mergeKey: coalesce })`（DocSync 自己再算一遍差异）；
 *   - `undo()` / `redo()` 的 `skipped[].by` 是 `{ actor, session }`，摊平成 `{ ...actor, session }`（A5）；
 *   - `saveWhenConfirmed(write)` → `ds.whenSettled()` 之后 `write(project, rev)`；
 *   - `resolveOffline('replay' | 'discard')` → `ds.replayOffline()` / `ds.discardOffline()`；
 *   - 状态变成 `paused` 时调 `onOfflineConflict(ds.pausedInfo)`；断线后每 50 ms 重连一次。
 * `.ts` 里没写扩展名的相对 import 靠 `src/testing/registerTs.mjs` 的解析钩子（与 src 下的单测相同）。
 */
export async function loadDocSync() {
  await import('../../src/testing/registerTs.mjs');
  const mod = await import('../../src/store/docsync.ts');
  if (typeof mod.createDocSync === 'function') return mod.createDocSync;
  assert.equal(typeof mod.DocSync, 'function', `docsync.ts 要导出 createDocSync 或 DocSync；导出：${Object.keys(mod).join(', ')}`);
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
      else throw new Error(`不认识的选择：${choice}`);
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

// ================================================================== 杂项

export const T0 = 1_700_000_000_000;
export const MIN = 60_000;

/** 建临时目录，用例结束时删掉 */
export function tempDir(t, prefix = 'pc-c65-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 固定种子的伪随机（mulberry32） */
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

/** 路径分段（JSON 指针，`~1` → `/`，`~0` → `~`） */
export function splitPath(path) {
  if (path === '') return [];
  assert.ok(path.startsWith('/'), `路径要以 / 开头：${path}`);
  return path.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** 字符串按 UTF-8 字节数 */
export const bytesOf = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');

// ================================================================== 造项目（形状照 src/kernel/project.ts 的 Project）

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

/** 任意 JSON 值（深度有限）；数组一律不带 id（整体当一个值） */
function randValue(r, depth = 0) {
  const k = depth > 2 ? 0 : r.int(4);
  if (k === 0 || k === 1) return randScalar(r);
  if (k === 2) {
    const n = r.int(4);
    return Array.from({ length: n }, () => randValue(r, depth + 1));
  }
  const o = {};
  const n = r.int(4);
  for (let i = 0; i < n; i++) o[r.pick(['a', 'b', 'c', 'd/e', 'f~g', '中'])] = randValue(r, depth + 1);
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
  if (r.chance(0.3)) clip.keyframes = [{ t: 0, v: 0 }, { t: 1, v: r.int(10) }]; // 没有 id 的数组
  if (r.chance(0.2)) clip.filter = { id: `f${r.int(3)}`, values: { amount: r.next() } };
  return clip;
}

export function makeTrack(r, id = freshId('t', r), nClips = r.int(6)) {
  return { id, name: `序列 ${id}`, clips: Array.from({ length: nClips }, () => makeClip(r)) };
}

/** 一个 Project 形状的随机项目 */
export function makeProject(r, { tracks = 1 + r.int(4), clipsPerTrack } = {}) {
  const p = {
    version: 1,
    id: `p-${r.int(1e9).toString(36)}`,
    name: `项目 ${r.int(100)}`,
    width: 1920,
    height: 1080,
    fps: r.pick([24, 25, 30, 60]),
    duration: 10 + r.int(100),
    themeId: r.pick(['midnight', 'paper']),
    media: Array.from({ length: r.int(4) }, () => ({ id: freshId('m', r), name: `素材${r.int(9)}.mp4`, kind: 'video', duration: r.int(60) })),
    tracks: Array.from({ length: tracks }, () => makeTrack(r, undefined, clipsPerTrack ?? r.int(6))),
    filters: Array.from({ length: r.int(3) }, (_, i) => ({ id: `f${i}`, name: `滤镜 ${i}`, params: { amount: r.next() } })),
    style: { 'a/b': 1, 'x~y': 'z', nested: { k: [1, 2, 3] } },
  };
  if (r.chance(0.5)) p.cuts = [{ id: 'cut-1', name: '剪辑 1' }, { id: 'cut-2', name: '剪辑 2', tracks: [makeTrack(r, undefined, 2)], duration: 20 }];
  if (r.chance(0.3)) p.camera3dFov = 45;
  return p;
}

/** 对一个对象随机改一处（普通对象的键：改、删、加；换类型） */
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

/** 元素全是带 id 的对象的数组（空数组也算）；随机改动可能把 clips 换成别的值，之后就不再当片段表用 */
const isIdList = (a) => Array.isArray(a) && a.every((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string');

/** 带 id 的数组上的随机插、删、挪、换 id */
function mutateIdArray(r, arr, make) {
  const k = r.int(5);
  if (k === 0 || arr.length === 0) { arr.splice(r.int(arr.length + 1), 0, make()); return; }
  if (k === 1) { arr.splice(r.int(arr.length), 1); return; }
  if (k === 2) { const [x] = arr.splice(r.int(arr.length), 1); arr.splice(r.int(arr.length + 1), 0, x); return; }
  if (k === 3) { const i = r.int(arr.length); arr[i] = make(); return; }
  mutateObject(r, arr[r.int(arr.length)]);
}

/** 在 prev 的副本上随机改 1～6 处，得到 next（prev 不动） */
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
        // 片段跨序列挪
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
      default: p.fps = r.pick([24, 25, 30, 60]); p.name = `项目 ${r.int(1000)}`;
    }
  }
  return p;
}

/** 固定形状的小项目：一条序列 t1，片段 c1..cN，frame.x = 10*i */
export function fixedProject({ clips = 3, tracks = 1 } = {}) {
  return {
    version: 1,
    id: 'p-fixed',
    name: '固定项目',
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 30,
    themeId: 'midnight',
    media: [],
    filters: [{ id: 'f1', name: '滤镜 1', params: { amount: 0.5 } }],
    tracks: Array.from({ length: tracks }, (_, ti) => ({
      id: `t${ti + 1}`,
      name: `序列 ${ti + 1}`,
      clips: Array.from({ length: clips }, (_, i) => ({
        id: ti === 0 ? `c${i + 1}` : `t${ti + 1}c${i + 1}`,
        start: i * 3,
        duration: 3,
        cardId: 'title',
        params: { text: `片段 ${i + 1}` },
        frame: { x: 10 * (i + 1), y: 0, w: 100, h: 100 },
      })),
    })),
  };
}

/** 找片段（只看 tracks） */
export function clipOf(p, clipId) {
  for (const t of p?.tracks ?? []) for (const c of t.clips ?? []) if (c.id === clipId) return c;
  return undefined;
}

// ================================================================== 文档服务（A3、A4、A6）

/** A6：`?user=&dev=&role=&conv=` → principal */
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
 * 起一个挂着项目模块的独立文档服务（端口 0、autoTick: false）。
 * `clock.t` 是注入的时间，覆盖通知的 10 分钟按它算。
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

/** A4：打开项目，等 project.state */
export async function openProject(c, projectId, ms = 3000) {
  c.send({ type: 'project.open', projectId, reqId: `open-${newOpId()}` });
  const st = await c.next((m) => m?.type === 'project.state' && m.projectId === projectId, ms);
  return st;
}

/**
 * A4：提交一批操作，等本批的 ok / rejected（按 opId 对应）。
 * → 回包消息本身
 */
export async function submit(c, { projectId, ops, expectRev, session = 'sess-test', undoOf, opId = newOpId() }, ms = 3000) {
  const msg = { type: 'project.op', projectId, opId, session, ops };
  if (expectRev !== undefined) msg.expectRev = expectRev;
  if (undoOf !== undefined) msg.undoOf = undoOf;
  c.send(msg);
  return c.next((m) => (isOk(m) || isRejected(m)) && m.opId === opId, ms);
}

/** 用根替换把 project 写进去；回 ok 的 rev */
export async function seedProject(env, projectId, project, who = { user: 'seeder', dev: 'dev-seed' }) {
  const c = await env.connect(who);
  await openProject(c, projectId);
  const r = await submit(c, { projectId, ops: [{ op: 'set', path: '', value: project }], session: 'seed' });
  assert.ok(isOk(r), `根替换种子应成功：${JSON.stringify(r)}`);
  c.close();
  return r.rev;
}

/** 重新连一条、打开，读服务端当前的 { rev, project } */
export async function serverState(env, projectId) {
  const c = await env.connect({ user: 'reader', dev: 'dev-reader' });
  const st = await openProject(c, projectId);
  c.close();
  return { rev: st.rev, project: st.project, writers: st.writers };
}

/** A5：by 是否是这个写入身份 */
export function byIs(by, { user, session }) {
  return by && by.userId === user && (session === undefined || by.session === session);
}

// ================================================================== 页面同步（A7）

/**
 * A7：页面同步实例。假设 `createDocSync(options)` 的形状如下（设计稿第 4、6、8 节只写了行为）：
 *
 *   options.url            文档服务的 WebSocket 地址（含查询串，测试的 authenticate 按它定 principal）
 *   options.projectId
 *   options.session        页面会话 id（写入身份的一部分，进每条 project.op）
 *   options.getProject()   读页面当前的项目（store 里的那份）
 *   options.setProject(p)  用别人的操作 / 回滚 / 重放 / 撤销结果换掉页面的项目；**不进撤销栈、不回发**（第 4 节「走 set」）
 *   options.now()          时钟（数字框 300 ms 合并按它算）
 *   options.backup(rec)    存本地备份（第 3 节「先把自己那一版的该实体存成本地备份」、第 8 节「丢弃前先备份」）；
 *                          rec 至少带 `entity` 与 `value`（覆盖时）
 *   options.onOfflineConflict(info)   离线重放第一条被拒、整批停下时调（第 6 节）
 *
 *   sync.open() → Promise           连上并打开项目，拿到 project.state 后把项目交给 setProject
 *   sync.submit({ ops, inverse }, { coalesce? })   本地改动（core.ts 的 setProject 已先本地落地、算好 diff）
 *   sync.pendingCount() → number    还没拿到 ok 的本地提交数（含离线待发队列）
 *   sync.connected → boolean        当前是否连着
 *   sync.rev → number               最后确认的服务端版本
 *   sync.resolveOffline('replay' | 'discard') → Promise
 *   sync.undo() / sync.redo() → Promise<{ skipped: [{ entity, by }] }>   撤销 / 重做（第 8 节）
 *   sync.canUndo() / sync.canRedo() → boolean
 *   sync.saveWhenConfirmed(write) → Promise   所有本地操作都 ok 之后调 write(project, rev)（第 4 节 .proc）
 *   sync.close()
 *
 * 测试用的包装：页面的 store 就是 `page.project` 这一个变量；`page.edit(fn)` 相当于 core.ts 的 setProject：
 * 复制、改、diffProject、本地落地、交给 sync.submit。
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
  await waitFor(() => page.project !== null && page.project !== undefined, 5000, `页面 ${session} 拿到项目`);

  /** 相当于 core.ts 的 setProject(next)：本地先落地，再把差异交给 docsync */
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
  /** 等本地提交全部确认 */
  page.settled = (ms = 10_000) => waitFor(() => sync.pendingCount() === 0, ms, `页面 ${session} 的提交全部确认`);
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
 * 可断网的通道：页面经 TCP 代理连文档服务。`offline()` 断掉现有连接并拒绝新连接；`online()` 放行。
 * 页面同步要自己发现断线、自己重连（第 6 节「连不上时照常本地落地」）。
 */
export async function createLink(env) {
  const proxy = await createTcpProxy({ target: env.port });
  return {
    port: proxy.port,
    proxy,
    async offline(page) {
      proxy.mode = 'reject';
      proxy.cutAll();
      if (page) await waitFor(() => page.sync.connected === false, 5000, '页面发现断线');
      else await sleep(200);
    },
    online() { proxy.mode = 'pass'; },
    close: () => proxy.close(),
  };
}

/** 观察者：一条原始连接，打开项目后收集 project.ops（它自己不提交，所以收得到所有人的） */
export async function observer(env, projectId) {
  const c = await env.connect({ user: 'watcher', dev: 'dev-watch' });
  await openProject(c, projectId);
  return {
    c,
    ops: () => c.all.filter(byType('project.ops')),
    close: () => c.close(),
  };
}

/** 三份相等：先 deepEqual（给出差在哪），再逐字节 */
export function assertSameBytes(a, b, what) {
  assert.deepEqual(a, b, `${what}：内容不同`);
  assert.equal(JSON.stringify(a), JSON.stringify(b), `${what}：内容相同但序列化后字节不同（键序不一致）`);
}
