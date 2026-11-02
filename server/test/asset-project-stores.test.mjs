import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createProjectAssetStores, projectScopeOfRoot } from '../asset-store/project-stores.mjs';
import { authorizeAsset, openProjectStream } from '../asset-store/project-access.mjs';

const bytes = Buffer.from('same bytes independently supplied by each project');
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
async function put(store) { await store.putChunk(hash, 0, { size: bytes.length, ext: 'wav' }, Readable.from([bytes])); assert.equal((await store.complete(hash)).status, 'ok'); }

for (const kind of ['memory', 'fs']) test(`project ${kind} store isolates media/snap/px, keeps the same hash independent, and deletes only the specified project`, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-project-stores-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const factory = createProjectAssetStores({ dir, kind });
  const a = factory.project('A'), b = factory.project('B');
  assert.notEqual(a.root, b.root);
  assert.equal(projectScopeOfRoot(a.root).projectId, 'A');
  for (const ns of ['media', 'snap', 'px']) {
    await put(a.stores[ns]);
    assert.equal(await b.stores[ns].stat(hash), null);
    assert.equal((await b.stores[ns].chunks(hash)).size, null);
    assert.equal((await b.stores[ns].complete(hash)).status, 'unknown');
    await put(b.stores[ns]);
    assert.equal((await b.stores[ns].stat(hash)).size, bytes.length);
  }
  await factory.removeProject('A');
  assert.throws(() => factory.store('A', 'media'), /project-gone/);
  for (const ns of ['media', 'snap', 'px']) assert.equal((await b.stores[ns].stat(hash)).size, bytes.length);
});
test('projectId path traversal and case are each encoded, no paths outside the store, illegal namespace rejected', () => {
  const f = createProjectAssetStores({ dir: os.tmpdir(), kind: 'memory' });
  assert.equal(path.dirname(f.project('../../outside').root), path.join(os.tmpdir(), 'projects'));
  assert.notEqual(f.project('A').root, f.project('a').root);
  assert.throws(() => f.project(''), /invalid-project-id/);
  assert.throws(() => f.store('A', '..'), /invalid-namespace/);
});
test('authorization asks the authority every time; it cannot self-report another project/account or pass with only a runGrant', async () => {
  let calls = 0;
  const authority = { checkAccess: async ({ principal }) => { calls++; return { allowed: principal.authorizationId === 'doc-opaque' }; } };
  const principal = { projectId: 'A', accountId: 'u', authorizationId: 'doc-opaque' };
  for (let i = 0; i < 2; i++) await authorizeAsset({ authority, principal, projectId: 'A', action: 'read' });
  assert.equal(calls, 2);
  await assert.rejects(authorizeAsset({ authority, principal, projectId: 'B', action: 'read' }), /project-mismatch/);
  await assert.rejects(authorizeAsset({ authority, principal: { projectId: 'A', runGrantId: 'claimed' }, projectId: 'A', action: 'write' }), /forbidden/);
  await assert.rejects(authorizeAsset({ principal, projectId: 'A', action: 'read' }), /authority-unavailable/);
});
test('subscribe first, then verify; revocation synchronously rejects new reads and waits for the real ongoing stream close', async () => {
  let callback, subscribed = false, allowed = true;
  const authority = {
    checkAccess: async () => { assert.equal(subscribed, true); return { allowed }; },
    subscribeRevocations: (_context, cb) => { subscribed = true; callback = cb; return () => { subscribed = false; }; },
  };
  const lease = await openProjectStream({ authority, principal: { projectId: 'A' }, projectId: 'A' });
  const stream = new Readable({ read() {} });
  lease.track(stream);
  allowed = false;
  const ack = callback({ reason: 'kicked' });
  assert.equal(lease.signal.aborted, true);
  await assert.rejects(lease.assert(), /access-revoked/);
  await ack;
  assert.equal(stream.closed, true);
  await lease.release();
  assert.equal(subscribed, false);
});
test('revocation while check is waiting must not slip through open', async () => {
  let callback, resolve;
  const authority = { subscribeRevocations: (_c, cb) => { callback = cb; return () => {}; }, checkAccess: () => new Promise(r => { resolve = r; }) };
  const pending = openProjectStream({ authority, principal: { projectId: 'A' }, projectId: 'A' });
  await callback({ reason: 'delete' });
  resolve({ allowed: true });
  await assert.rejects(pending, /access-revoked/);
});
