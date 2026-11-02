/**
 * C10 reserved interface L5: asset service merge distribution (`docs/plan/c10-contract.md` Section
 * 11; semantics `mechanism/platforms.md` "reserved interface").
 * Run: node --test server/test/c10-merge-501.test.mjs
 *
 *   C10-MG-01 `POST merge/<projectId>/<sharedKey>` returns 501;
 *   C10-MG-02 Placeholder only, does not parse projectId: returns 501 for any projectId, does not
 *             return 400 / 404;
 *   C10-MG-03 Placeholder does not affect existing routes: `GET media/<hash>` as before (returns
 *             404 if nonexistent).
 *
 * Asset service starts on `listen(0)` after translation via `loadAsset()` from `auth-kit.mjs`,
 * in-memory storage, loopback origin.
 * Assumptions see K11 in `c10-kit.mjs`. Skip entire group when gate is closed.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeGate, MERGE_PATH } from './c10-kit.mjs';

const gate = mergeGate();
const it = (name, fn) => test(name, { skip: gate.ok ? false : gate.reason }, fn);

let base = null;
const cleanups = [];
after(() => { for (const f of cleanups.splice(0)) f(); });
async function serve() {
  if (base) return base;
  const { loadAsset } = await import('./auth-kit.mjs');
  const { asset, store } = await loadAsset();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-c10-merge-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const media = store.createBlobStore({ kind: 'memory', chunkSize: 8 * 1024 * 1024 });
  const mw = asset.assetServiceMiddleware(root, { stores: { media }, tickets: null });
  const server = http.createServer((req, res) => { void mw(req, res, () => { res.statusCode = 404; res.end('no route'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.unshift(() => server.close());
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

const KEY = 'a'.repeat(64);

it('C10-MG-01 POST merge/<projectId>/<shared key> returns 501', async () => {
  const b = await serve();
  const r = await fetch(`${b}${MERGE_PATH('proj-c10', KEY)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 501, await r.text());
});

it('C10-MG-02 projectId is not parsed: any value returns 501', async () => {
  const b = await serve();
  for (const pid of ['x', 'Project_With-Odd.chars', '00000000-0000-0000-0000-000000000000', encodeURIComponent('名字 带空格')]) {
    const r = await fetch(`${b}${MERGE_PATH(pid, KEY)}`, { method: 'POST' });
    assert.equal(r.status, 501, `projectId ${pid}: ${r.status} ${await r.text()}`);
  }
});

it('C10-MG-03 the placeholder does not affect existing routes: GET media/<hash> works as before', async () => {
  const b = await serve();
  const r = await fetch(`${b}/api/asset/media/${'b'.repeat(64)}`);
  assert.equal(r.status, 404, await r.text());
});
