// 预渲染进程读素材的地址(server/vision/ffmpeg-frames.ts):只经素材服务的 HTTP,
// 以及镜头拼图(/api/vision/sheet)按内容哈希做缓存键。跑法:node --test server/test/vision-media-source.test.mjs
//
// ffmpeg-frames 是 .ts,和 asset-service.test 一样用 typescript 转译到临时目录再 import。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ts = createRequire(import.meta.url)('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-vision-media-'));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

delete process.env.PROMPTCUT_EDITOR_URL;

function compile(srcRel, outName, replaces = []) {
  let src = fs.readFileSync(path.join(ROOT, srcRel), 'utf8');
  for (const [a, b] of replaces) {
    assert.ok(src.includes(a), `${srcRel} 里找不到 ${a}`);
    src = src.split(a).join(b);
  }
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const file = path.join(OUT, outName);
  fs.writeFileSync(file, js);
  return pathToFileURL(file).href;
}

compile('server/asset-client.ts', 'asset-client.mjs');
const frames = await import(compile('server/vision/ffmpeg-frames.ts', 'ffmpeg-frames.mjs', [
  ['from "../vision-compose.mjs"', `from "${pathToFileURL(path.join(ROOT, 'server', 'vision-compose.mjs')).href}"`],
  ['from "../asset-client"', 'from "./asset-client.mjs"'],
  ['from "../media-stamp.mjs"', `from "${pathToFileURL(path.join(ROOT, 'server', 'media-stamp.mjs')).href}"`],
]));

const h = 'ab'.repeat(32);
const o = 'http://127.0.0.1:5221';

test('mediaHashOf:m.hash 或 /@media/<hash>[.ext];没有哈希的返回 null', () => {
  assert.equal(frames.mediaHashOf({ hash: h.toUpperCase() }), h);
  assert.equal(frames.mediaHashOf({ url: `/@media/${h}` }), h);
  assert.equal(frames.mediaHashOf({ url: `/@media/${h}.mp4?x=1` }), h);
  assert.equal(frames.mediaHashOf({ url: '/@media/clip.mp4' }), null, '迁移期按文件名存的');
  assert.equal(frames.mediaHashOf({ url: `/api/media/file?path=C%3A%2F${h}.mp4` }), null, '老 .proc 的绝对路径不算');
  assert.equal(frames.mediaHashOf({ url: `/@media/${h}/pcm` }), null);
  assert.equal(frames.mediaHashOf({ hash: 'not-a-hash', url: '/@media/x.mp4' }), null);
  assert.equal(frames.mediaHashOf(null), null);
});

test('mediaSourceOf:一律是素材服务上的 HTTP 地址,不给磁盘路径', () => {
  assert.equal(frames.mediaSourceOf({ hash: h, path: 'C:\\x\\out\\media\\a.mp4' }, o), `${o}/@media/${h}`);
  assert.equal(frames.mediaSourceOf({ url: `/@media/${h}.mp4` }, o), `${o}/@media/${h}.mp4`);
  assert.equal(frames.mediaSourceOf({ url: '/@media/clip.mp4' }, o), `${o}/@media/clip.mp4`);
  // 老 .proc 的绝对路径:原样交给素材服务的 /api/media/file(那一侧按白名单判),不拼成 /@media/file
  const legacy = '/api/media/file?path=C%3A%2FUsers%2Fu%2FVideos%2FPromptCut%2Fmedia%2Fa.mp4';
  assert.equal(frames.mediaSourceOf({ url: legacy, path: 'C:/Users/u/Videos/PromptCut/media/a.mp4' }, o), `${o}${legacy}`);
  // 有哈希时哈希优先
  assert.equal(frames.mediaSourceOf({ hash: h, url: legacy }, o), `${o}/@media/${h}`);
  // 只有 path:只取最后一段文件名,指不到库外
  assert.equal(frames.mediaSourceOf({ path: 'C:\\Windows\\win.ini' }, o), `${o}/@media/win.ini`);
  assert.equal(frames.mediaSourceOf({ hash: h }, null), null, '素材服务不可达');
  assert.equal(frames.mediaSourceOf({ url: legacy }, null), null, '素材服务不可达');
});

test('ffmpeg-frames 不再读本地内容库的目录', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'vision', 'ffmpeg-frames.ts'), 'utf8');
  assert.ok(!/mediaDir|mediaFileOf|from "node:fs"/.test(src), '不 import mediaDir / node:fs,也没有 mediaFileOf');
  const routes = fs.readFileSync(path.join(ROOT, 'server', 'vision', 'routes.ts'), 'utf8');
  assert.ok(!/mediaFileOf/.test(routes), '/api/vision/sheet 不再按文件读素材');
});
