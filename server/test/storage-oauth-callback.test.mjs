/**
 * The authorization modal landing page `/oauth2callback` for A2 must be served by the asset
 * middleware itself (task brief `docs/plan/drive-connector-task.md`, section 6.5).
 * Run: npm test -- server/test/storage-oauth-callback.test.mjs
 *
 * # Why this test exists
 *
 * Hit this for real on 2026-10-24: the main middleware entry point has a prefix filter:
 * `if (!pathname.startsWith("/@media/") && !pathname.startsWith("/api/media/")) return next();`,
 * and `/oauth2callback` matches neither prefix, so it fell through to Vite's SPA fallback: the
 * entire editor was rendered inside the authorization modal, the auth code never returned to the
 * page that opened it, and A2 could not connect.
 *
 * At the time I only checked status code and `content-type` with curl, both 200 / text/html (same as
 * Vite's index.html), so it went unnoticed. **This test checks the body content**.
 *
 * This URL prefix cannot be changed: it must match the redirect URI registered in Google Console
 * verbatim.
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
// The landing page is provided by the cloud drive connector extension (under cloud/); community
// edition does not have it, middleware passes the request to the lower layer, which is right.
// Therefore, the three "serve landing page" tests only run when cloud/ exists, while "prefix filter
// blocks other URLs as usual" runs in both cases
const NO_CLOUD = fs.existsSync(path.join(ROOT, 'cloud')) ? false : 'No cloud/ directory in the current workspace (the community edition has no cloud drive connector)';
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-oauth-cb-'));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

// Same setup as media-serve-file.test.mjs: asset plugin is .ts, transpiled to a temp dir before import
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

const { mediaMiddleware, OAUTH_CALLBACK_PATH } = await import(compileTs(path.join(ROOT, 'server', 'vite-plugin-media.ts')));

/** Mount the middleware on a bare http server. `next()` returns 404: in real environments that is Vite's SPA fallback */
async function serve() {
  const mw = mediaMiddleware(OUT);
  const fellThrough = [];
  const server = http.createServer((req, res) => {
    void mw(req, res, () => {
      fellThrough.push(req.url);
      res.statusCode = 404;
      res.end('SPA fallback');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  return { base: `http://127.0.0.1:${server.address().port}`, fellThrough };
}

test('the landing page is served by the middleware itself and does not fall through to the SPA fallback', { skip: NO_CLOUD }, async () => {
  const { base, fellThrough } = await serve();
  const res = await fetch(`${base}${OAUTH_CALLBACK_PATH}?code=TESTCODE&state=S1`);
  assert.equal(res.status, 200);
  const body = await res.text();

  // Check body content, not just status code: Vite's index.html is also 200 / text/html
  assert.match(body, /promptcut-oauth/, 'it must carry an origin marker so that the page that opened it can tell who sent it');
  assert.ok(!/<div id="root"|@react-refresh|type="module"/.test(body), 'it should not be the editor\'s index.html');
  assert.deepEqual(fellThrough, [], 'must not fall through to the SPA fallback');
});

test('sent only to the same-origin opener; the authorization code does not go into the body', { skip: NO_CLOUD }, async () => {
  const { base } = await serve();
  const body = await (await fetch(`${base}${OAUTH_CALLBACK_PATH}?code=TESTCODE&state=S1`)).text();
  assert.match(body, /postMessage\(msg,\s*location\.origin\)/, 'must be restricted to the same origin, cannot use "*"');
  assert.ok(!body.includes('TESTCODE'), 'the authorization code is read only from location.search and never written into the body');
});

test('not cached: the authorization code is in the address bar', { skip: NO_CLOUD }, async () => {
  const { base } = await serve();
  const res = await fetch(`${base}${OAUTH_CALLBACK_PATH}?code=X`);
  assert.match(String(res.headers.get('cache-control') || ''), /no-store/);
});

test('prefix filtering still blocks other addresses', async () => {
  const { base, fellThrough } = await serve();
  const res = await fetch(`${base}/some/other/page`);
  assert.equal(res.status, 404);
  assert.deepEqual(fellThrough, ['/some/other/page'], 'unrelated addresses must still be passed on to the next middleware');
});
