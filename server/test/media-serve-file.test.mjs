/**
 * `/@media` route serves files (`serveFile` in `server/vite-plugin-media.ts`): if file disappears
 * between "getting size" and "starting read", it must not crash the entire editor process (previously
 * read stream error was unhandled, process exited, subsequent requests on page all Failed to fetch).
 * Run: npm test -- server/test/media-serve-file.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ts = createRequire(import.meta.url)('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-serve-file-'));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

const compiled = new Map();
function resolveRel(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.mjs')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}
function compileTs(absFile) {
  if (compiled.has(absFile)) return compiled.get(absFile);
  const outFile = path.join(OUT, `${path.relative(ROOT, absFile).split(path.sep).join('__').replace(/\.ts$/, '')}.mjs`);
  const url = pathToFileURL(outFile).href;
  compiled.set(absFile, url);
  let src = fs.readFileSync(absFile, 'utf8');
  const rewrite = (spec) => { const hit = resolveRel(absFile, spec); return !hit ? spec : hit.endsWith('.ts') ? compileTs(hit) : pathToFileURL(hit).href; };
  for (const re of [/(\bfrom\s*)(["'])(\.\.?\/[^"']+)\2/g, /(\bimport\s*\(\s*)(["'])(\.\.?\/[^"']+)\2/g, /(\bimport\s+)(["'])(\.\.?\/[^"']+)\2/g]) {
    src = src.replace(re, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
  }
  fs.writeFileSync(outFile, ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText);
  return url;
}
const { serveFile } = await import(compileTs(path.join(ROOT, 'server', 'vite-plugin-media.ts')));

/**
 * Start a service that only serves this file; `beforeBody` is called when response headers
 * are written (after getting size, before reading starts)
 */
async function serve(file, beforeBody) {
  const server = http.createServer((req, res) => {
    if (beforeBody) {
      const writeHead = res.writeHead.bind(res);
      res.writeHead = (...a) => { const r = writeHead(...a); beforeBody(); return r; };
    }
    void serveFile(file, req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  return `http://127.0.0.1:${server.address().port}/`;
}
const bytes = Buffer.alloc(300_000, 7);
const fresh = (name) => { const f = path.join(OUT, name); fs.writeFileSync(f, bytes); return f; };

test('SF1 file does not exist: answers 404 without throwing', async () => {
  const r = await fetch(await serve(path.join(OUT, 'nope.wav')));
  assert.equal(r.status, 404);
});

test('SF2 file deleted after its size is fetched and before reading starts: the process does not crash, and this response is still read to the end', async () => {
  const file = fresh('gone-200.wav');
  const uncaught = [];
  const onErr = (e) => uncaught.push(e);
  process.on('uncaughtException', onErr);
  try {
    const r = await fetch(await serve(file, () => fs.rmSync(file, { force: true })));
    assert.equal(r.status, 200);
    const got = Buffer.from(await r.arrayBuffer());
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(uncaught, [], 'An error from the read stream must not surface as an uncaught exception');
    assert.equal(got.length, bytes.length);
    assert.equal(fs.existsSync(file), false);
  } finally { process.off('uncaughtException', onErr); }
});

test('SF3 same for Range requests: the process does not crash after the file is deleted, and the byte count of the range is right', async () => {
  const file = fresh('gone-206.wav');
  const uncaught = [];
  const onErr = (e) => uncaught.push(e);
  process.on('uncaughtException', onErr);
  try {
    const r = await fetch(await serve(file, () => fs.rmSync(file, { force: true })), { headers: { Range: 'bytes=100-1099' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes 100-1099/${bytes.length}`);
    const got = Buffer.from(await r.arrayBuffer());
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(uncaught, []);
    assert.equal(got.length, 1000);
  } finally { process.off('uncaughtException', onErr); }
});

test('SF4 HEAD and out-of-range Range leave no open handle (the file can be deleted afterwards)', async () => {
  const file = fresh('head.wav');
  const url = await serve(file);
  const h = await fetch(url, { method: 'HEAD' });
  assert.equal(h.status, 200);
  assert.equal(h.headers.get('content-length'), String(bytes.length));
  const bad = await fetch(url, { headers: { Range: `bytes=${bytes.length + 5}-` } });
  assert.equal(bad.status, 416);
  await bad.arrayBuffer();
  fs.rmSync(file);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await fetch(url)).status, 404);
});
