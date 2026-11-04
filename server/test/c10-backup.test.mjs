/**
 * C10 offline backup (`docs/plan/c10-contract.md` section 10 "Local backup"; semantics
 * `product/platforms.md` "Online browser mode": browser locally only stores caches that can be
 * refetched).
 * Run: node --test server/test/c10-backup.test.mjs
 *
 *   C10-BK-01 Online page does not write to browser storage when receiving backups (discarded
 *             offline batches, overwritten entities): does not touch localStorage, sessionStorage,
 *             or IndexedDB at all, nor `POST /api/project-backups` to editor process;
 *   C10-BK-02 Backups remain in memory on this page, listable in order received;
 *   C10-BK-03 Offered for download after "discard": downloads a `.json` file containing that backup
 *             (kind, projectId, offline batches all present);
 *   C10-BK-04 Backup module source code contains no localStorage, sessionStorage, or indexedDB.
 *
 * See K10 in `c10-kit.mjs` for assumptions. Skip the entire suite when implementation is missing.
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

/** Install stubs for storage, fetch, and DOM download; return observations */
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
  assert.ok(save, `Assumption K10: no save found on the backup object (candidates ${BACKUP_METHODS.save.join(' / ')})`);
  assert.ok(m.list, `Assumption K10: no list found on the backup object (candidates ${BACKUP_METHODS.list.join(' / ')})`);
  assert.ok(m.download, `Assumption K10: no download found on the backup object (candidates ${BACKUP_METHODS.download.join(' / ')})`);
  const list = () => {
    const v = typeof sink[m.list] === 'function' ? sink[m.list]() : sink[m.list];
    return [...v];
  };
  /** Download the i-th copy, returning `{ filename, text }` (accepts both callback and DOM paths) */
  const download = async (i) => {
    const before = optionDownloads.length + spies.downloads.length;
    await sink[m.download](i);
    await new Promise((r) => setImmediate(r));
    if (optionDownloads.length + spies.downloads.length === before) {
      // Perhaps by backup itself rather than index
      await sink[m.download](list()[i]);
      await new Promise((r) => setImmediate(r));
    }
    const viaOpt = optionDownloads.at(-1);
    const viaDom = spies.downloads.at(-1);
    if (viaOpt) return { filename: viaOpt.filename, text: typeof viaOpt.text === 'string' ? viaOpt.text : await new Response(viaOpt.text).text() };
    if (viaDom) return { filename: viaDom.filename, text: viaDom.blob ? await viaDom.blob.text() : '' };
    throw new Error('Assumption K10: download neither called the download callback nor clicked through an <a download>');
  };
  return { save, list, download };
}

it('C10-BK-01 receiving a backup does not write browser storage and does not request the editor process', async () => {
  const spies = installSpies();
  const sink = await makeSink(spies);
  await sink.save(discard);
  await sink.save(overwritten);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(spies.writes, [], `Wrote browser storage: ${spies.writes.join(', ')}`);
  assert.deepEqual(spies.factory.opened, [], `Opened IndexedDB: ${spies.factory.opened.join(', ')}`);
  assert.deepEqual(spies.fetches, [], `Sent requests: ${JSON.stringify(spies.fetches)}`);
  assert.equal(spies.downloads.length, 0, 'A received backup is not downloaded automatically (a download is offered after "Discard", and the user clicks it)');
});

it('C10-BK-02 backups stay in this page\'s memory and can be listed in the order received', async () => {
  const spies = installSpies();
  const sink = await makeSink(spies);
  await sink.save(discard);
  await sink.save(overwritten);
  const items = sink.list().map((x) => x?.backup ?? x);
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'offline-discard');
  assert.equal(items[1].kind, 'overwritten');
});

it('C10-BK-03 after "Discard" a download is offered: a .json file whose content is that backup', async () => {
  const spies = installSpies();
  const sink = await makeSink(spies);
  await sink.save(discard);
  const { filename, text } = await sink.download(0);
  assert.match(filename, /\.json$/i, `Downloaded file name: ${filename}`);
  const body = JSON.parse(text);
  const got = body?.backup ?? body;
  assert.equal(got.kind, 'offline-discard');
  assert.equal(got.projectId, 'proj-c10');
  assert.deepEqual(got.batch, discard.batch);
  assert.deepEqual(spies.writes, [], 'Downloading does not write browser storage either');
});

it('C10-BK-04 localStorage, sessionStorage and indexedDB do not appear in the source of the backup module', () => {
  const src = fs.readFileSync(repoPath(gate.file), 'utf8');
  for (const word of ['localStorage', 'sessionStorage', 'indexedDB']) assert.equal(src.includes(word), false, `${word} appears in ${gate.file}`);
});
