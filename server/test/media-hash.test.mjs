// Asset key (content sha256), local content store, /@media route. How to run:
//   node --test server/test/media-hash.test.mjs
//
// Plugin is .ts; transpiled here with typescript to a temp directory before import (same pattern
// as collect-plugin.test). Route is exported separately as mediaMiddleware, so it can be mounted
// directly on a bare http server to verify 206 / Content-Type.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-media-hash-'));

// Location of out/media is determined by PROMPTCUT_EXPORT_DIR or <root>/out. Here <root>/out is
// required, in case test machine happens to set this variable and writes temp assets into real
// export directory.
delete process.env.PROMPTCUT_EXPORT_DIR;
delete process.env.PROMPTCUT_MEDIA_DIR;

function compile(srcRel, outName) {
  const src = fs.readFileSync(path.join(ROOT, srcRel), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const file = path.join(OUT, outName);
  fs.writeFileSync(file, js);
  return pathToFileURL(file).href;
}

const media = await import(compile('server/vite-plugin-media.ts', 'media.mjs'));

const projectRoot = path.join(OUT, 'project');
const mediaDir = media.mediaDir(projectRoot);
fs.mkdirSync(mediaDir, { recursive: true });

const server = http.createServer((req, res) => {
  void media.mediaMiddleware(projectRoot)(req, res, () => { res.statusCode = 404; res.end('no route'); });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(OUT, { recursive: true, force: true }); });

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const BODY = Buffer.from('promptcut-media-fixture-'.repeat(64));
const BODY_HASH = sha256(BODY);

test('Same content, different mtime / different file name → same key', async () => {
  const a = path.join(OUT, 'a.mp4');
  const b = path.join(OUT, 'b-renamed.mp4');
  fs.writeFileSync(a, BODY);
  fs.writeFileSync(b, BODY);
  // mtime differs by a year: key is content-based, ignores timestamps
  const old = new Date(Date.now() - 365 * 24 * 3600 * 1000);
  fs.utimesSync(b, old, old);
  assert.notEqual(fs.statSync(a).mtimeMs, fs.statSync(b).mtimeMs);

  assert.equal(await media.hashFile(a), BODY_HASH);
  assert.equal(await media.hashFile(b), BODY_HASH);

  const first = await media.storeMediaStream(projectRoot, 'a.mp4', Readable.from(fs.createReadStream(a)));
  const second = await media.storeMediaStream(projectRoot, 'b-renamed.mp4', Readable.from(fs.createReadStream(b)));
  assert.equal(first.hash, BODY_HASH);
  assert.equal(second.hash, first.hash);
  assert.equal(first.url, `/@media/${BODY_HASH}`);
  assert.equal(second.deduped, true, 'The second import only recognizes it as the same one and does not write a new file');
  // Only one file in content store (index.json does not count)
  const stored = fs.readdirSync(mediaDir).filter((n) => n.startsWith(BODY_HASH));
  assert.deepEqual(stored, [`${BODY_HASH}.mp4`]);
  // Intermediate .part temp files are all cleared
  assert.deepEqual(fs.readdirSync(mediaDir).filter((n) => n.endsWith('.part')), []);
});

test('/@media/<hash> returns the correct Content-Type and supports Range', async () => {
  const res = await fetch(`${origin}/@media/${BODY_HASH}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4', 'The extension is recorded at ingest time, so it is recognized even if the URL has none');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(Buffer.from(await res.arrayBuffer()).equals(BODY), true);

  const ranged = await fetch(`${origin}/@media/${BODY_HASH}`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 0-99/${BODY.length}`);
  assert.equal(ranged.headers.get('content-type'), 'video/mp4');
  const part = Buffer.from(await ranged.arrayBuffer());
  assert.equal(part.length, 100);
  assert.equal(part.equals(BODY.subarray(0, 100)), true);

  // Formats with extensions are also recognized
  const withExt = await fetch(`${origin}/@media/${BODY_HASH}.mp4`);
  assert.equal(withExt.status, 200);
  assert.equal(withExt.headers.get('content-type'), 'video/mp4');

  // Uppercase hex is also accepted (may have been normalized elsewhere in the URL)
  const upper = await fetch(`${origin}/@media/${BODY_HASH.toUpperCase()}`);
  assert.equal(upper.status, 200);
});

test('If the index is lost it can still be recovered from the directory', async () => {
  const index = path.join(mediaDir, 'index.json');
  assert.equal(fs.existsSync(index), true);
  const saved = fs.readFileSync(index);
  fs.rmSync(index);
  const fresh = await import(compile('server/vite-plugin-media.ts', 'media-2.mjs'));
  assert.equal(await fresh.resolveHashFile(projectRoot, BODY_HASH), path.join(mediaDir, `${BODY_HASH}.mp4`));
  fs.writeFileSync(index, saved);
});

test('The index survives a plugin restart: with a fresh module instance (empty cache) the original file name and size can still be read', async () => {
  // Every compile produces a brand-new module instance: module-level indexCache is empty and can
  // only be read back from index.json on disk, exactly matching the scenario after dev server restart.
  const fresh = await import(compile('server/vite-plugin-media.ts', 'media-3.mjs'));
  const index = await fresh.readMediaIndex(projectRoot);
  const entry = index[BODY_HASH];
  assert.ok(entry, 'The index entry written at ingest time must still be there');
  assert.equal(entry.file, `${BODY_HASH}.mp4`);
  // Same content imported twice (a.mp4 / b-renamed.mp4), index records original name from last
  // time: key is content-based, name is only for display, no harm in refreshing it on subsequent import
  assert.equal(entry.name, 'b-renamed.mp4', 'The original file name is kept (needed for display in the list)');
  assert.equal(entry.ext, 'mp4');
  assert.equal(entry.size, BODY.length);
  assert.equal(entry.contentType, 'video/mp4');

  // Also accepted when index points to a file not named by hash: this path only works via index and
  // cannot be found by scanning directory
  fs.writeFileSync(path.join(mediaDir, 'collected-clip.mp4'), BODY);
  const alias = 'b'.repeat(64);
  const file = path.join(mediaDir, 'index.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.items[alias] = { file: 'collected-clip.mp4', name: 'collected-clip.mp4', ext: 'mp4', size: BODY.length, contentType: 'video/mp4' };
  fs.writeFileSync(file, JSON.stringify(raw));

  const later = await import(compile('server/vite-plugin-media.ts', 'media-4.mjs'));
  assert.equal(await later.resolveHashFile(projectRoot, alias), path.join(mediaDir, 'collected-clip.mp4'));
});

test('Migration period: lookup by file name still works', async () => {
  fs.writeFileSync(path.join(mediaDir, 'legacy-clip.mp4'), BODY);
  const res = await fetch(`${origin}/@media/legacy-clip.mp4`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(Buffer.from(await res.arrayBuffer()).length, BODY.length);

  const ranged = await fetch(`${origin}/@media/legacy-clip.mp4`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 10-19/${BODY.length}`);
});

test('A hash not in the store is 404 and does not fall into the file-name path', async () => {
  const missing = 'f'.repeat(64);
  const res = await fetch(`${origin}/@media/${missing}`);
  assert.equal(res.status, 404);
});

test('Upload route: the hash is computed while writing to disk, and what is returned is the content key', async () => {
  const body = Buffer.from('another-fixture-payload');
  const res = await fetch(`${origin}/api/media/upload/${encodeURIComponent('照片 1.PNG')}`, { method: 'POST', body });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.hash, sha256(body));
  assert.equal(data.ext, 'png');
  assert.equal(data.url, `/@media/${data.hash}`);
  assert.equal(data.bytes, body.length);

  const back = await fetch(`${origin}/@media/${data.hash}`);
  assert.equal(back.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await back.arrayBuffer()).equals(body), true);

  // Same content uploaded again: still the same key, still one copy in the store
  const again = await (await fetch(`${origin}/api/media/upload/whatever.png`, { method: 'POST', body })).json();
  assert.equal(again.hash, data.hash);
  assert.equal(again.deduped, true);
});

test('adopt: a file downloaded by media collection gets its content key computed in place, without uploading it again', async () => {
  // collect writes to disk using original filename without hash: only after backfilling can it
  // enter .procp and deduplicate across machines
  const collected = path.join(mediaDir, 'collected-by-agent.mp4');
  const body = Buffer.from('collected-fixture-'.repeat(50));
  fs.writeFileSync(collected, body);

  const res = await fetch(`${origin}/api/media/adopt?path=${encodeURIComponent(collected)}`, { method: 'POST' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.hash, sha256(body));
  assert.equal(data.url, `/@media/${data.hash}`);
  assert.equal(data.bytes, body.length);
  assert.equal(fs.existsSync(collected), true, 'The original file stays where it was, since the collect side may still reference it by its original name');

  const back = await fetch(`${origin}/@media/${data.hash}`);
  assert.equal(back.headers.get('content-type'), 'video/mp4');
  assert.equal(Buffer.from(await back.arrayBuffer()).equals(body), true);

  // Paths outside asset catalog are rejected unconditionally (same gate as /api/media/file)
  const outside = await fetch(`${origin}/api/media/adopt?path=${encodeURIComponent(path.join(OUT, 'a.mp4'))}`, { method: 'POST' });
  assert.equal(outside.status, 403);
});

test('During a large-file import the main service still answers other requests within 100 ms', async () => {
  // Acceptance criteria for A1 is "import 4 GB video main service response ≤ 100 ms". 4 GB cannot
  // run in unit tests, but the property to prove is independent of size: upload **updates sha256
  // while writing to disk**, tens of KiB per chunk, with no long tasks on the event loop: reading
  // everything into memory to hash all at once is what freezes (which was exactly the pattern
  // replaced). Tested with 64 MiB here, hitting other routes every 5 ms to measure the slowest one.
  const CHUNK = 64 * 1024;
  const TOTAL = 64 * 1024 * 1024;
  const block = Buffer.alloc(CHUNK, 7);
  let sent = 0;
  const body = new Readable({
    read() {
      if (sent >= TOTAL) return this.push(null);
      sent += CHUNK;
      this.push(block);
    },
  });

  let done = false;
  let worst = 0;
  let probes = 0;
  const poll = (async () => {
    while (!done) {
      const t0 = performance.now();
      await fetch(`${origin}/api/media/local?hashes=${BODY_HASH}`).then((r) => r.json());
      worst = Math.max(worst, performance.now() - t0);
      probes += 1;
      await new Promise((r) => setTimeout(r, 5));
    }
  })();

  const stored = await media.storeMediaStream(projectRoot, 'huge.mp4', body);
  done = true;
  await poll;

  assert.equal(stored.bytes, TOTAL);
  assert.match(stored.hash, /^[0-9a-f]{64}$/);
  assert.equal(stored.url, `/@media/${stored.hash}`);
  assert.ok(probes >= 3, `Other routes must be hit at least a few times during the import (actually ${probes})`);
  assert.ok(worst < 100, `The slowest other request during the import took ${worst.toFixed(1)} ms, should be < 100 ms`);
  fs.rmSync(path.join(mediaDir, `${stored.hash}.mp4`), { force: true });
});

test('/api/media/local reports only hashes that really exist locally', async () => {
  const missing = 'a'.repeat(64);
  const res = await fetch(`${origin}/api/media/local?hashes=${BODY_HASH},${missing},not-a-hash`);
  const data = await res.json();
  assert.deepEqual(data.hashes, [BODY_HASH]);
});

test('HEAD carries Content-Length and Last-Modified (used by the frame pipeline to stamp assets without a hash, server/media-stamp.mjs)', async () => {
  // Assets stored by filename during migration period
  const name = 'legacy-clip.mp4';
  const file = path.join(mediaDir, name);
  fs.writeFileSync(file, BODY);
  const when = new Date('2026-09-20T08:00:00Z');
  fs.utimesSync(file, when, when);
  const head = await fetch(`${origin}/@media/${name}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(BODY.length));
  assert.equal(head.headers.get('last-modified'), when.toUTCString());
  assert.equal((await head.arrayBuffer()).byteLength, 0, 'HEAD has no body');
  // Absolute path of legacy .proc: /api/media/file?path= also answers HEAD (only allowed if path is
  // in asset catalog)
  const byPath = await fetch(`${origin}/api/media/file?path=${encodeURIComponent(file)}`, { method: 'HEAD' });
  assert.equal(byPath.status, 200);
  assert.equal(byPath.headers.get('last-modified'), when.toUTCString());
  // GET also includes Last-Modified
  const get = await fetch(`${origin}/@media/${name}`);
  assert.equal(get.headers.get('last-modified'), when.toUTCString());
  await get.arrayBuffer();
});
