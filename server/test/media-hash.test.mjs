// 素材键(内容 sha256)、本地内容库、/@media 路由。跑法:
//   node --test server/test/media-hash.test.mjs
//
// 插件是 .ts,这里用 typescript 转译到临时目录再 import(和 collect-plugin.test 一个路数)。
// 路由单独导出成 mediaMiddleware,所以可以直接架在一个裸 http server 上验 206 / Content-Type。
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

// out/media 的位置由 PROMPTCUT_EXPORT_DIR 或 <root>/out 决定。这里要的是 <root>/out,
// 免得跑测试的机器上正好设了这个变量,把临时素材写进真的导出目录。
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

test('同样的内容,不同 mtime / 不同文件名 → 同一个键', async () => {
  const a = path.join(OUT, 'a.mp4');
  const b = path.join(OUT, 'b-renamed.mp4');
  fs.writeFileSync(a, BODY);
  fs.writeFileSync(b, BODY);
  // mtime 差一年:键是内容的,不看时间
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
  assert.equal(second.deduped, true, '第二次导入只认出是同一份,不再写一个新文件');
  // 内容库里只有一份文件(index.json 不算)
  const stored = fs.readdirSync(mediaDir).filter((n) => n.startsWith(BODY_HASH));
  assert.deepEqual(stored, [`${BODY_HASH}.mp4`]);
  // 中途的 .part 临时文件都清了
  assert.deepEqual(fs.readdirSync(mediaDir).filter((n) => n.endsWith('.part')), []);
});

test('/@media/<hash> 给对 Content-Type,并支持 Range', async () => {
  const res = await fetch(`${origin}/@media/${BODY_HASH}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4', '扩展名从入库时记下来,URL 里没有也认得出');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(Buffer.from(await res.arrayBuffer()).equals(BODY), true);

  const ranged = await fetch(`${origin}/@media/${BODY_HASH}`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 0-99/${BODY.length}`);
  assert.equal(ranged.headers.get('content-type'), 'video/mp4');
  const part = Buffer.from(await ranged.arrayBuffer());
  assert.equal(part.length, 100);
  assert.equal(part.equals(BODY.subarray(0, 100)), true);

  // 带扩展名的写法也认
  const withExt = await fetch(`${origin}/@media/${BODY_HASH}.mp4`);
  assert.equal(withExt.status, 200);
  assert.equal(withExt.headers.get('content-type'), 'video/mp4');

  // 大写 hex 也认(URL 里可能被别处规范化过)
  const upper = await fetch(`${origin}/@media/${BODY_HASH.toUpperCase()}`);
  assert.equal(upper.status, 200);
});

test('索引丢了还能按目录找回来', async () => {
  const index = path.join(mediaDir, 'index.json');
  assert.equal(fs.existsSync(index), true);
  const saved = fs.readFileSync(index);
  fs.rmSync(index);
  const fresh = await import(compile('server/vite-plugin-media.ts', 'media-2.mjs'));
  assert.equal(await fresh.resolveHashFile(projectRoot, BODY_HASH), path.join(mediaDir, `${BODY_HASH}.mp4`));
  fs.writeFileSync(index, saved);
});

test('索引跨插件重启还在:换一个模块实例(缓存是空的)照样读得出原文件名和大小', async () => {
  // 每次 compile 出来的都是一份全新的模块实例 —— 模块级的 indexCache 是空的,
  // 只能从磁盘上的 index.json 读回来,正好就是 dev server 重启后的情形。
  const fresh = await import(compile('server/vite-plugin-media.ts', 'media-3.mjs'));
  const index = await fresh.readMediaIndex(projectRoot);
  const entry = index[BODY_HASH];
  assert.ok(entry, '入库时写的那条索引要还在');
  assert.equal(entry.file, `${BODY_HASH}.mp4`);
  // 同一份内容被导入两次(a.mp4 / b-renamed.mp4),索引记的是最后一次的原名 ——
  // 键是内容的,名字只用来显示,后导入的那次刷新它没有坏处
  assert.equal(entry.name, 'b-renamed.mp4', '原文件名留着(列表上显示要用)');
  assert.equal(entry.ext, 'mp4');
  assert.equal(entry.size, BODY.length);
  assert.equal(entry.contentType, 'video/mp4');

  // 索引指到一个不按哈希命名的文件时也认 —— 这条路只有索引能走通,扫目录扫不出来
  fs.writeFileSync(path.join(mediaDir, 'collected-clip.mp4'), BODY);
  const alias = 'b'.repeat(64);
  const file = path.join(mediaDir, 'index.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.items[alias] = { file: 'collected-clip.mp4', name: 'collected-clip.mp4', ext: 'mp4', size: BODY.length, contentType: 'video/mp4' };
  fs.writeFileSync(file, JSON.stringify(raw));

  const later = await import(compile('server/vite-plugin-media.ts', 'media-4.mjs'));
  assert.equal(await later.resolveHashFile(projectRoot, alias), path.join(mediaDir, 'collected-clip.mp4'));
});

test('迁移期:按文件名还是取得到', async () => {
  fs.writeFileSync(path.join(mediaDir, 'legacy-clip.mp4'), BODY);
  const res = await fetch(`${origin}/@media/legacy-clip.mp4`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(Buffer.from(await res.arrayBuffer()).length, BODY.length);

  const ranged = await fetch(`${origin}/@media/legacy-clip.mp4`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 10-19/${BODY.length}`);
});

test('库里没有的哈希是 404,不会掉进文件名那条路', async () => {
  const missing = 'f'.repeat(64);
  const res = await fetch(`${origin}/@media/${missing}`);
  assert.equal(res.status, 404);
});

test('上传路由:边落盘边算哈希,回的就是内容键', async () => {
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

  // 同一份内容再传一次:还是那个键,库里还是一份
  const again = await (await fetch(`${origin}/api/media/upload/whatever.png`, { method: 'POST', body })).json();
  assert.equal(again.hash, data.hash);
  assert.equal(again.deduped, true);
});

test('adopt:素材收集下载好的文件就地补算内容键,不用再传一遍', async () => {
  // collect 落盘时用的是原文件名,没有哈希 —— 补算之后它才进得了 .procp、才跨机器去重
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
  assert.equal(fs.existsSync(collected), true, '原文件留在原处,collect 那一侧可能还按原名引用它');

  const back = await fetch(`${origin}/@media/${data.hash}`);
  assert.equal(back.headers.get('content-type'), 'video/mp4');
  assert.equal(Buffer.from(await back.arrayBuffer()).equals(body), true);

  // 素材目录外的路径一律拒绝(和 /api/media/file 同一道闸)
  const outside = await fetch(`${origin}/api/media/adopt?path=${encodeURIComponent(path.join(OUT, 'a.mp4'))}`, { method: 'POST' });
  assert.equal(outside.status, 403);
});

test('大文件导入期间主服务照样在 100 ms 内答别的请求', async () => {
  // A1 的验收条件是「导入 4 GB 视频主服务响应 ≤ 100 ms」。4 GB 在单测里跑不动,
  // 但要证的性质和体积无关:上传是**边落盘边 update sha256**,每块几十 KiB,
  // 事件循环上没有一个长任务 —— 整份读进内存再一次性 hash 才会卡住(那正是改掉的写法)。
  // 这里用 64 MiB 跑,期间每 5 ms 打一次别的路由,量最慢的一次。
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
  assert.ok(probes >= 3, `导入期间至少要打到几次别的路由(实际 ${probes} 次)`);
  assert.ok(worst < 100, `导入期间别的请求最慢 ${worst.toFixed(1)} ms,应当 < 100 ms`);
  fs.rmSync(path.join(mediaDir, `${stored.hash}.mp4`), { force: true });
});

test('/api/media/local 只报本地真有的哈希', async () => {
  const missing = 'a'.repeat(64);
  const res = await fetch(`${origin}/api/media/local?hashes=${BODY_HASH},${missing},not-a-hash`);
  const data = await res.json();
  assert.deepEqual(data.hashes, [BODY_HASH]);
});

test('HEAD 带 Content-Length 和 Last-Modified(帧管线给没有哈希的素材打戳用,server/media-stamp.mjs)', async () => {
  // 迁移期按文件名存的素材
  const name = 'legacy-clip.mp4';
  const file = path.join(mediaDir, name);
  fs.writeFileSync(file, BODY);
  const when = new Date('2026-09-20T08:00:00Z');
  fs.utimesSync(file, when, when);
  const head = await fetch(`${origin}/@media/${name}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(BODY.length));
  assert.equal(head.headers.get('last-modified'), when.toUTCString());
  assert.equal((await head.arrayBuffer()).byteLength, 0, 'HEAD 不带 body');
  // 老 .proc 的绝对路径:/api/media/file?path= 也答 HEAD(路径在素材目录里才放行)
  const byPath = await fetch(`${origin}/api/media/file?path=${encodeURIComponent(file)}`, { method: 'HEAD' });
  assert.equal(byPath.status, 200);
  assert.equal(byPath.headers.get('last-modified'), when.toUTCString());
  // GET 同样带 Last-Modified
  const get = await fetch(`${origin}/@media/${name}`);
  assert.equal(get.headers.get('last-modified'), when.toUTCString());
  await get.arrayBuffer();
});
