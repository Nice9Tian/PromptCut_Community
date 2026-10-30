/**
 * A2 的授权弹窗落地页 `/oauth2callback` 必须由素材中间件自己发出来
 * (任务书 `docs/plan/drive-connector-task.md` 第 6.5 节)。
 * 跑:npm test -- server/test/storage-oauth-callback.test.mjs
 *
 * # 为什么要这条
 *
 * 2026-10-24 真踩过:中间件总入口有一行前缀过滤
 * `if (!pathname.startsWith("/@media/") && !pathname.startsWith("/api/media/")) return next();`,
 * `/oauth2callback` 两个前缀都不沾,于是被放给了 vite 的 SPA 兜底 —— 授权弹窗里渲染出整个编辑器,
 * 授权码永远回不到开它的那个页面,A2 连不上。
 *
 * 当时我只用 curl 核了状态码和 `content-type`,两样都是 200 / text/html(vite 的 index.html 也是),
 * 所以没看出来。**这条测试核的是正文**。
 *
 * 这个地址不能改前缀:它要和 Google 控制台里登记的重定向 URI 逐字一致。
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
// 落地页由网盘连接器的扩展提供（cloud/ 下）；社区版没有它，中间件把请求放给下一层，这正是对的。
// 所以「落地页发出来」那三条只在有 cloud/ 时跑，「前缀过滤照常挡住别的地址」两边都跑
const NO_CLOUD = fs.existsSync(path.join(ROOT, 'cloud')) ? false : '当前工作区无 cloud/ 目录（社区版没有网盘连接器）';
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-oauth-cb-'));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

// 和 media-serve-file.test.mjs 同一套:素材插件是 .ts,转译到临时目录再 import
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

/** 把中间件架在裸 http server 上。`next()` 回 404 —— 真实环境里那是 vite 的 SPA 兜底 */
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

test('落地页由中间件自己发,没有落到 SPA 兜底', { skip: NO_CLOUD }, async () => {
  const { base, fellThrough } = await serve();
  const res = await fetch(`${base}${OAUTH_CALLBACK_PATH}?code=TESTCODE&state=S1`);
  assert.equal(res.status, 200);
  const body = await res.text();

  // 核正文,不是只核状态码 —— vite 的 index.html 也是 200 / text/html
  assert.match(body, /promptcut-oauth/, '要带来源标记,开它的页面才分得清是谁发的');
  assert.ok(!/<div id="root"|@react-refresh|type="module"/.test(body), '不该是编辑器那张 index.html');
  assert.deepEqual(fellThrough, [], '不许落到 SPA 兜底');
});

test('只发给同源开启方,授权码不进正文', { skip: NO_CLOUD }, async () => {
  const { base } = await serve();
  const body = await (await fetch(`${base}${OAUTH_CALLBACK_PATH}?code=TESTCODE&state=S1`)).text();
  assert.match(body, /postMessage\(msg,\s*location\.origin\)/, '必须限定同源,不能用 "*"');
  assert.ok(!body.includes('TESTCODE'), '授权码只从 location.search 里读,不写进正文');
});

test('不缓存:授权码在地址栏里', { skip: NO_CLOUD }, async () => {
  const { base } = await serve();
  const res = await fetch(`${base}${OAUTH_CALLBACK_PATH}?code=X`);
  assert.match(String(res.headers.get('cache-control') || ''), /no-store/);
});

test('前缀过滤照常挡住别的地址', async () => {
  const { base, fellThrough } = await serve();
  const res = await fetch(`${base}/some/other/page`);
  assert.equal(res.status, 404);
  assert.deepEqual(fellThrough, ['/some/other/page'], '不相干的地址仍要放给下一个中间件');
});
