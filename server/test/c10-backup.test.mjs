/**
 * C10 离线备份（`docs/plan/c10-contract.md` 第 10 节「本地备份」；语义 `product/platforms.md`「在线浏览器模式」：
 * 浏览器本地只放能重新拉回的缓存）。
 * 跑：node --test server/test/c10-backup.test.mjs
 *
 *   C10-BK-01 在线页面收到备份（被丢弃的离线批次、被覆盖的实体）时不写浏览器存储：localStorage、sessionStorage、
 *             IndexedDB 一样都不碰，也不向编辑器进程 `POST /api/project-backups`；
 *   C10-BK-02 备份留在本页内存里，按收到的顺序列得出来；
 *   C10-BK-03 「丢弃」后给下载：下载的是 `.json` 文件，内容是那一份备份（kind、projectId、离线批次都在）；
 *   C10-BK-04 备份模块的源码里不出现 localStorage、sessionStorage、indexedDB。
 *
 * 假设见 `c10-kit.mjs` 的 K10。实现不在时整组 skip。
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FakeIDBFactory, installFakeIndexedDB } from './c10-fake-idb.mjs';
import { backupGate, importRepo, pickMethod, stubGlobal, repoPath, BACKUP_METHODS } from './c10-kit.mjs';

const gate = backupGate();
const it = (name, fn) => test(name, { skip: gate.ok ? false : gate.reason }, fn);

const restores = [];
afterEach(() => { while (restores.length) restores.pop()(); });

function spyStorage(name, writes) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { writes.push(`${name}.setItem(${k})`); map.set(k, String(v)); },
    removeItem: (k) => { writes.push(`${name}.removeItem(${k})`); map.delete(k); },
    clear: () => { writes.push(`${name}.clear()`); map.clear(); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

/** 装上存储、fetch、DOM 下载的桩；回观测 */
function installSpies() {
  const writes = [];
  const fetches = [];
  const downloads = [];
  const factory = new FakeIDBFactory();
  restores.push(installFakeIndexedDB(factory));
  restores.push(stubGlobal('localStorage', spyStorage('localStorage', writes)));
  restores.push(stubGlobal('sessionStorage', spyStorage('sessionStorage', writes)));
  restores.push(stubGlobal('fetch', async (url, init) => { fetches.push({ url: String(url), method: init?.method ?? 'GET' }); return new Response('{}'); }));
  const blobs = new Map();
  let seq = 0;
  const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { const u = `blob:c10-${++seq}`; blobs.set(u, blob); return u; };
  URL.revokeObjectURL = () => {};
  restores.push(() => { URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke; });
  const anchor = () => {
    const a = { href: '', download: '', style: {}, rel: '', setAttribute(k, v) { this[k] = v; }, remove() {}, dispatchEvent() { this.click(); return true; } };
    a.click = () => { downloads.push({ filename: a.download, blob: blobs.get(a.href), href: a.href }); };
    return a;
  };
  const doc = {
    createElement: (tag) => (String(tag).toLowerCase() === 'a' ? anchor() : { style: {}, setAttribute() {}, appendChild() {}, remove() {} }),
    body: { appendChild() {}, removeChild() {} },
    documentElement: { appendChild() {}, removeChild() {} },
  };
  restores.push(stubGlobal('document', doc));
  return { writes, fetches, downloads, factory };
}

const discard = {
  kind: 'offline-discard', projectId: 'proj-c10', baseRev: 7,
  batch: [{ opId: 'op-1', ops: [{ op: 'set', path: ['name'], value: 'x' }] }],
  project: { version: 1, name: 'x', tracks: [] }, at: 1_700_000_000_000,
};
const overwritten = { kind: 'overwritten', projectId: 'proj-c10', entity: 'clip:c1', by: { userId: 'u1' }, rev: 9, value: { start: 1 }, at: 1_700_000_001_000 };

async function makeSink(spies) {
  const mod = await importRepo(gate.file);
  const optionDownloads = [];
  const sink = mod[gate.name]({ download: (filename, text) => optionDownloads.push({ filename, text }) });
  const m = {};
  for (const [k, names] of Object.entries(BACKUP_METHODS)) m[k] = pickMethod(sink, names);
  const save = m.save ? (b) => sink[m.save](b) : (typeof sink === 'function' ? sink : null);
  assert.ok(save, `假设 K10：备份对象上找不到 save（候选 ${BACKUP_METHODS.save.join(' / ')}）`);
  assert.ok(m.list, `假设 K10：备份对象上找不到 list（候选 ${BACKUP_METHODS.list.join(' / ')}）`);
  assert.ok(m.download, `假设 K10：备份对象上找不到 download（候选 ${BACKUP_METHODS.download.join(' / ')}）`);
  const list = () => {
    const v = typeof sink[m.list] === 'function' ? sink[m.list]() : sink[m.list];
    return [...v];
  };
  /** 下载第 i 份，回 `{ filename, text }`（回调或 DOM 两条路都认） */
  const download = async (i) => {
    const before = optionDownloads.length + spies.downloads.length;
    await sink[m.download](i);
    await new Promise((r) => setImmediate(r));
    if (optionDownloads.length + spies.downloads.length === before) {
      // 也许按备份本身而不是下标
      await sink[m.download](list()[i]);
      await new Promise((r) => setImmediate(r));
    }
    const viaOpt = optionDownloads.at(-1);
    const viaDom = spies.downloads.at(-1);
    if (viaOpt) return { filename: viaOpt.filename, text: typeof viaOpt.text === 'string' ? viaOpt.text : await new Response(viaOpt.text).text() };
    if (viaDom) return { filename: viaDom.filename, text: viaDom.blob ? await viaDom.blob.text() : '' };
    throw new Error('假设 K10：download 既没调 download 回调，也没经 <a download> 点下去');
  };
  return { save, list, download };
}

it('C10-BK-01 收到备份时不写浏览器存储、不请求编辑器进程', async () => {
  const spies = installSpies();
  const sink = await makeSink(spies);
  await sink.save(discard);
  await sink.save(overwritten);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(spies.writes, [], `写了浏览器存储：${spies.writes.join(', ')}`);
  assert.deepEqual(spies.factory.opened, [], `打开了 IndexedDB：${spies.factory.opened.join(', ')}`);
  assert.deepEqual(spies.fetches, [], `发了请求：${JSON.stringify(spies.fetches)}`);
  assert.equal(spies.downloads.length, 0, '收到备份时不自动下载（「丢弃」后给下载，由用户点）');
});

it('C10-BK-02 备份留在本页内存里，按收到的顺序列得出来', async () => {
  const spies = installSpies();
  const sink = await makeSink(spies);
  await sink.save(discard);
  await sink.save(overwritten);
  const items = sink.list().map((x) => x?.backup ?? x);
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'offline-discard');
  assert.equal(items[1].kind, 'overwritten');
});

it('C10-BK-03 「丢弃」后给下载：.json 文件，内容是那一份备份', async () => {
  const spies = installSpies();
  const sink = await makeSink(spies);
  await sink.save(discard);
  const { filename, text } = await sink.download(0);
  assert.match(filename, /\.json$/i, `下载的文件名：${filename}`);
  const body = JSON.parse(text);
  const got = body?.backup ?? body;
  assert.equal(got.kind, 'offline-discard');
  assert.equal(got.projectId, 'proj-c10');
  assert.deepEqual(got.batch, discard.batch);
  assert.deepEqual(spies.writes, [], '下载也不写浏览器存储');
});

it('C10-BK-04 备份模块的源码里不出现 localStorage、sessionStorage、indexedDB', () => {
  const src = fs.readFileSync(repoPath(gate.file), 'utf8');
  for (const word of ['localStorage', 'sessionStorage', 'indexedDB']) assert.equal(src.includes(word), false, `${gate.file} 里出现了 ${word}`);
});
