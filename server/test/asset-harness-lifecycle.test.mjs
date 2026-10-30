import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { createAssetHarness, ROOT } from './fake-asset-service.mjs';
import { createTierManager } from '../media-tiers.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function heldImport(t) {
  const harness = createAssetHarness();
  const srv = await harness.serve({ stores: 'default' });
  const media = await import(harness.compileTs(path.join(ROOT, 'server/vite-plugin-media.ts')));
  const holdDir = path.join(srv.root, 'owned-child-cwd');
  fs.mkdirSync(holdDir);
  const child = spawn(process.execPath, ['-e', `process.send('ready'); process.on('message', () => { process.disconnect(); });`],
    { cwd: holdDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let closed = false;
  const done = once(child, 'close').then(([code]) => { closed = true; assert.equal(code, 0); });
  const release = async () => { if (child.connected) child.send('release'); await done; };
  t.after(async () => { await release(); await harness.cleanup(); });
  await once(child, 'message');
  const entered = deferred(), idling = deferred();
  const manager = createTierManager({
    dir: media.mediaDir(srv.root),
    lib: { hashFile: media.hashFile, contentTypeForExt: media.contentTypeForExt },
    // A real owned process holds cwd until released. The manager remains inside its
    // asynchronous executable lookup; the subsequent real probe exits unsuccessfully.
    ffmpeg: async () => { entered.resolve(); await done; return process.execPath; },
  });
  const idle = manager.idle.bind(manager);
  manager.idle = () => { idling.resolve(); return idle(); };
  const registry = globalThis[Symbol.for('promptcut.media-tiers.services')] ??= new Map();
  registry.set(path.resolve(srv.root), Promise.resolve({ manager, queue: null }));
  const response = await fetch(`${srv.origin}/api/media/upload/held.mkv?tiers=1`, { method: 'POST', body: 'fake video bytes\r\n' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).tiers.original.length, 64);
  await entered.promise;
  return { harness, srv, manager, release, idling: idling.promise, closed: () => closed };
}

test('asset lifecycle negative: HTTP close alone leaves a real tier child and cannot remove its cwd', { skip: process.platform !== 'win32', timeout: 60_000 }, async t => {
  const f = await heldImport(t);
  await new Promise(resolve => { f.srv.server.closeAllConnections(); f.srv.server.close(resolve); });
  assert.equal(f.closed(), false);
  let error;
  const started = performance.now();
  try { fs.rmSync(path.dirname(f.srv.root), { recursive: true, force: true }); } catch (e) { error = e; }
  assert.equal(error?.code, 'EPERM', 'old cleanup must fail while its real child still owns cwd');
  t.diagnostic(JSON.stringify({ boundary: 'http-close', childClosed: f.closed(), cleanupError: error.code, rmMs: performance.now() - started }));
  await f.release();
  await f.manager.idle();
});

test('asset lifecycle: cleanup waits for tier child close and final persistence before deleting', { timeout: 30_000 }, async t => {
  const f = await heldImport(t);
  let settled = false;
  const cleanup = f.harness.cleanup().then(() => { settled = true; });
  await f.idling;
  assert.equal(settled, false);
  assert.equal(f.closed(), false);
  assert.equal(fs.existsSync(f.srv.root), true);
  await f.release();
  await cleanup;
  assert.equal(f.closed(), true);
  assert.equal(fs.existsSync(path.dirname(f.srv.root)), false);
  t.diagnostic(JSON.stringify({ boundary: 'cleanup-complete', childClosed: f.closed(), rootExists: false }));
});

test('asset lifecycle: response end does not substitute for the source stream close', { timeout: 30_000 }, async t => {
  const harness = createAssetHarness();
  const store = await harness.memoryStore();
  const destroying = deferred(), release = deferred();
  let stream;
  const hash = 'a'.repeat(64);
  const srv = await harness.serve({ stores: { media: store, snap: await harness.memoryStore(), px: await harness.memoryStore() } });
  t.after(async () => { release.resolve(); await harness.cleanup(); });
  // stat/read are the storage seam; HTTP and stream close below remain real.
  store.stat = async h => h === hash ? { size: 3, contentType: 'application/octet-stream' } : null;
  store.read = async () => {
    stream = new Readable({ read() { this.push(Buffer.from('abc')); this.push(null); }, destroy(error, cb) { destroying.resolve(); void release.promise.then(() => cb(error)); } });
    return stream;
  };
  const response = await fetch(`${srv.base}/media/${hash}`);
  assert.equal(await response.text(), 'abc');
  await destroying.promise;
  let settled = false;
  const cleanup = harness.cleanup().then(() => { settled = true; });
  await once(srv.server, 'close');
  assert.equal(stream.closed, false);
  assert.equal(settled, false);
  release.resolve();
  await cleanup;
  assert.equal(stream.closed, true);
});
