import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createAssetRevocationConsumer } from '../asset-store/project-revocations.mjs';
import { startAssetProjectFixture } from './fixtures/asset-project-service.mjs';
import { StreamStore, handleStreamRequest } from '../frame-stream.mjs';
import { createProjectAssetStores } from '../asset-store/project-stores.mjs';
import { projectFileAccepted, publicationMarker } from '../asset-store/project-io.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let n = 0; n < 100; n++) { if (fn()) return; await delay(10); } throw new Error('condition timeout'); }
test('真实HTTP finish后source尚未actualclose，持久撤销ACK必须等_destroy gate', { timeout: 10000 }, async t => {
  const bytes = Buffer.from('finished HTTP but open owned source'), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  let source, finishDestroy;
  const fixture = await startAssetProjectFixture({ wrapStore: (_project, _ns, store) => new Proxy(store, { get(target, key) {
    if (key === 'read') return async () => { source = new Readable({ read() { this.push(bytes); this.push(null); }, destroy(_error, cb) { finishDestroy = cb; } }); return source; };
    return target[key];
  } }) });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-close-boundary-')); t.after(async () => { finishDestroy?.(); await fixture.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const check = fixture.authority.checkAccess.bind(fixture.authority), callbacks = new Set(), events = [], acks = [];
  const raw = { checkAccess: check, subscribeRevocations: (_ctx, cb) => { callbacks.add(cb); return () => callbacks.delete(cb); }, eventsSince: async after => ({ events: events.filter(e => e.seq > after), headSeq: events.length }), ackAccessEvent: async (_id, _service, receipt) => { acks.push(receipt); } };
  const consumer = createAssetRevocationConsumer({ authority: raw, file: path.join(dir, 'cursor.json') }); await consumer.start(); t.after(() => consumer.close());
  fixture.authority.checkAccess = consumer.checkAccess.bind(consumer); fixture.authority.subscribeRevocations = consumer.subscribeRevocations.bind(consumer);
  const headers = { Authorization: 'Bearer A-rw', 'X-Media-Size': String(bytes.length), 'X-Media-Ext': 'wav' };
  await (await fetch(`${fixture.base}/api/asset/media/${hash}/0`, { method: 'PUT', headers, body: bytes })).arrayBuffer();
  await (await fetch(`${fixture.base}/api/asset/media/${hash}/complete`, { method: 'POST', headers })).arrayBuffer();
  const response = await fetch(`${fixture.base}/api/asset/media/${hash}`, { headers }); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await until(() => !!finishDestroy); assert.equal(source.closed, false); await delay(20);
  const event = { seq: 1, eventId: 'close-event', type: 'project-access-changed', reason: 'kick', projectId: 'A', accountIds: ['u-A'] }; events.push(event); for (const cb of callbacks) cb(event);
  const completion = consumer.sync(); await delay(30); assert.equal(acks.length, 0, 'HTTP finish不得提前解除仍持有source的订阅');
  finishDestroy(); await completion; assert.equal(source.closed, true); assert.equal(acks.length, 1); assert.equal(acks[0].complete, true); assert.equal(acks[0].closedStreams.length, 1);
});

test('真实media rename在途撤销：先等发布回退完成才收口，未授权新全件不得残留', { timeout: 10000 }, async t => {
  const fixture = await startAssetProjectFixture(); t.after(() => fixture.close());
  const bytes = Buffer.from('rename-boundary-content'), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const target = path.join(fixture.factory.project('A').dirs.media, `${hash}.wav`), originalRename = fs.rename;
  let entered = false, resume; const gate = new Promise(r => { resume = r; });
  fs.rename = async (from, to) => { const result = await originalRename(from, to); if (to === target) { entered = true; await gate; } return result; };
  t.after(() => { resume(); fs.rename = originalRename; });
  const pending = fetch(`${fixture.base}/api/media/upload/source.wav`, { method: 'POST', headers: { Authorization: 'Bearer A-rw' }, body: bytes }).catch(() => null);
  await until(() => entered);
  for (const url of [`/@media/${hash}`, `/api/asset/media/${hash}`, `/api/media/file?path=${encodeURIComponent(target)}`]) { const r = await fetch(fixture.base + url, { headers: { Authorization: 'Bearer A-rw' } }); await r.arrayBuffer(); assert.equal(r.status, 404, '尚未接受的rename不能通过实际读口可见'); }
  let revoked = false; const revocation = fixture.revoke('A').then(() => { revoked = true; }); await delay(30);
  assert.equal(revoked, false, 'ACK/关闭回调不能早于正在rename的产物收口');
  resume(); await pending; await revocation; await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('项目重启恢复未接受发布intent：删新全件/还原旧清单，不触B；坏跨项目路径拒', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-publish-recovery-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = createProjectAssetStores({ dir }), a = f.project('A'), b = f.project('B'); await fs.mkdir(a.dirs.media, { recursive: true }); await fs.mkdir(b.dirs.media, { recursive: true });
  const target = path.join(a.dirs.media, `${'9'.repeat(64)}.wav`), temp = path.join(a.dirs.media, '.owned.part'), backup = `${target}.known.backup`;
  await fs.writeFile(target, 'unaccepted'); await fs.writeFile(temp, 'pending'); await fs.writeFile(backup, 'accepted-old'); await fs.writeFile(path.join(b.dirs.media, 'keep.wav'), 'B-owned');
  await fs.writeFile(publicationMarker(target), JSON.stringify({ v: 1, target, temp, backup })); assert.equal(await projectFileAccepted(target), false);
  createProjectAssetStores({ dir }).project('A'); assert.equal(await fs.readFile(target, 'utf8'), 'accepted-old'); assert.equal(await projectFileAccepted(target), true); assert.equal(await fs.readFile(path.join(b.dirs.media, 'keep.wav'), 'utf8'), 'B-owned');
  await fs.writeFile(publicationMarker(target), JSON.stringify({ v: 1, target, temp, backup: null })); createProjectAssetStores({ dir }).project('A'); await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  await fs.writeFile(publicationMarker(target), JSON.stringify({ v: 1, target, temp, backup: path.join(b.dirs.media, 'keep.wav') })); assert.throws(() => createProjectAssetStores({ dir }).project('A'), /invalid-project-publication-path/); assert.equal(await fs.readFile(path.join(b.dirs.media, 'keep.wav'), 'utf8'), 'B-owned');
});

test('真实StreamStore.save在途撤销恢复旧清单和cache，不留晚发布的新manifest', { timeout: 10000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-stream-save-boundary-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let allowed = true; const ownership = { projectId: 'A', assert: async () => { if (!allowed) throw new Error('access-revoked'); } };
  const store = new StreamStore(dir, { ownership }), key = 'd'.repeat(64);
  const old = { streamKey: key, revision: 'accepted-old', segments: {}, inits: {} }; await store.save(old);
  const target = path.join(store.dir(key), 'stream.json'), originalRename = fs.rename; let entered = false, resume;
  const gate = new Promise(r => { resume = r; }); fs.rename = async (from, to) => { if (to === target && !entered) { entered = true; await gate; } return originalRename(from, to); };
  t.after(() => { resume(); fs.rename = originalRename; });
  const pending = store.save({ ...old, revision: 'unaccepted-new' }); pending.catch(() => {}); await until(() => entered); allowed = false; resume();
  await assert.rejects(pending, /access-revoked/); assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).revision, 'accepted-old'); assert.equal((await store.load(key)).revision, 'accepted-old');
});

test('真实frame异步FileHandle读取可撤销：HTTP close不跳过在途读fd与操作收口', { timeout: 10000 }, async t => {
  const fixture = await startAssetProjectFixture(); t.after(() => fixture.close());
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-stream-read-boundary-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let handle, entered = false, resume; const gate = new Promise(r => { resume = r; });
  const io = { ...fs, open: async (...args) => { handle = await fs.open(...args); const read = handle.readFile.bind(handle); handle.readFile = async options => { entered = true; await gate; return read(options); }; return handle; } };
  const store = new StreamStore(dir, { ownership: { projectId: 'A', assert: async () => {} }, projectAccess: fixture.projectAccess, io });
  const key = 'e'.repeat(64), id = 'f'.repeat(16); await fs.mkdir(store.dir(key), { recursive: true }); await fs.writeFile(store.initFile(key, id), 'actual-file-bytes');
  const server = http.createServer((req, res) => handleStreamRequest(store, req, res, req.url)); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { resume(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const response = fetch(`http://127.0.0.1:${server.address().port}/stream/${key}/init/${id}`, { headers: { Authorization: 'Bearer A-rw' } }).catch(() => null);
  await until(() => entered); let complete = false; const revoked = fixture.revoke('A').then(() => { complete = true; }); await delay(30); assert.equal(complete, false);
  resume(); await response; await revoked; assert.equal(handle.fd, -1);
});
