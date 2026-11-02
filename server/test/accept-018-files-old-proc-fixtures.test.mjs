/**
 * Self-check for `accept-018-files-old-proc-fixtures.mjs` (synthetic legacy file matrix): samples
 * can be created, and existing read code on main can understand them: association resolution,
 * asset reference retention, and hashes of unpacked .procp stored into the content store match
 * sample declarations (what is missing is missing).
 * This is not a converter test (converter does not exist yet, see 2.1-8); it only ensures the
 * samples themselves are correct when used as input in the future.
 *
 * Run: npm test -- server/test/accept-018-files-old-proc-fixtures.test.mjs
 */
import { srcUrl } from '../../src/testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildOldProcMatrix, MEDIA, OLD_ROOM_ID, OLD_SERVICE } from './accept-018-files-old-proc-fixtures.mjs';

const proc = await import(srcUrl('editor/io/proc.ts'));
const procp = await import(srcUrl('editor/io/procp.ts'));
const assoc = await import(srcUrl('editor/sync/recoveryAssociation.ts'));

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

test('ACC018-OLD-1 every sample in the matrix can be understood by the existing reading code: association, media references, script', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-accept-018-old-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const m = await buildOldProcMatrix(dir);
  for (const key of ['hostedPlain', 'lanPlain', 'barePlain', 'bareLegacyJson']) {
    const warn = console.warn; console.warn = () => {};
    let p; try { p = proc.loadProc(fs.readFileSync(m.files[key], 'utf8')); } finally { console.warn = warn; }
    assert.equal(p.name, key);
    assert.deepEqual(p.media.map(x => x.hash), MEDIA.map(x => x.hash), `${key}: media references (hashes) unchanged`);
    const taken = assoc.takeLoadedAssociation(p);
    const want = m.expect[key].association;
    if (want === null) assert.equal(taken, null, `${key}: no association`);
    else assert.deepEqual(taken, { version: 1, roomId: OLD_ROOM_ID, service: OLD_SERVICE, where: want }, `${key}: association parsed`);
    assoc.setAssociation(null);
  }
});

test('ACC018-OLD-2 the three .procp samples: the hashes stored after unpacking are exactly those carried in the package; missing media references remain in the arrangement (not dropped)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-accept-018-old-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const m = await buildOldProcMatrix(dir);
  const store = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('/api/media/upload/')) {
      const bytes = Buffer.from(await new Response(init.body).arrayBuffer()); const hash = sha(bytes);
      const deduped = store.has(hash); store.set(hash, bytes);
      return new Response(JSON.stringify({ ok: true, hash, deduped }), { status: 200 });
    }
    if (u.startsWith('/api/media/have') || u.includes('exists')) return new Response(JSON.stringify({ ok: true, have: [] }), { status: 200 });
    return new Response(null, { status: 404 });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  for (const key of ['hostedAllMedia', 'hostedPartialMedia', 'hostedNoMedia']) {
    store.clear();
    const bytes = fs.readFileSync(m.files[key]);
    const { procText, landed } = await procp.unpackProcp(new Blob([bytes]));
    const want = m.expect[key];
    assert.deepEqual([...landed].sort(), [...want.packedHashes].sort(), `${key}: stored hashes = those carried in the package`);
    for (const h of want.absentHashes ?? []) assert.equal(store.has(h), false, `${key}: ${h.slice(0, 8)}, which is not in the package, does not appear out of thin air`);
    const p = proc.loadProc(procText);
    assert.deepEqual(p.media.map(x => x.hash), MEDIA.map(x => x.hash), `${key}: every media reference in the arrangement (missing ones included) is still there`);
    assoc.setAssociation(null);
  }
});
