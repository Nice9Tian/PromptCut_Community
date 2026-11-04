// Address for prerender process reading assets (server/vision/ffmpeg-frames.ts): only via asset
// service HTTP, and shot sheet (/api/vision/sheet) uses content hash as cache key.
// Run: node --test server/test/vision-media-source.test.mjs
//
// ffmpeg-frames is .ts; like asset-service.test, transpile with typescript to temporary directory
// before import.
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
    assert.ok(src.includes(a), `Could not find ${a} in ${srcRel}`);
    src = src.split(a).join(b);
  }
  // server/i18n.mjs is not copied into the scratch folder: point the import back at the real file
  src = src.replace(/from (['"])(?:\.\.?\/)+i18n\.mjs\1/g, (_m, q) => `from ${q}${pathToFileURL(path.join(ROOT, 'server', 'i18n.mjs')).href}${q}`);
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

test('mediaHashOf: m.hash or /@media/<hash>[.ext]; returns null when there is no hash', () => {
  assert.equal(frames.mediaHashOf({ hash: h.toUpperCase() }), h);
  assert.equal(frames.mediaHashOf({ url: `/@media/${h}` }), h);
  assert.equal(frames.mediaHashOf({ url: `/@media/${h}.mp4?x=1` }), h);
  assert.equal(frames.mediaHashOf({ url: '/@media/clip.mp4' }), null, 'Stored by file name during the migration period');
  assert.equal(frames.mediaHashOf({ url: `/api/media/file?path=C%3A%2F${h}.mp4` }), null, 'Absolute paths from old .proc files do not count');
  assert.equal(frames.mediaHashOf({ url: `/@media/${h}/pcm` }), null);
  assert.equal(frames.mediaHashOf({ hash: 'not-a-hash', url: '/@media/x.mp4' }), null);
  assert.equal(frames.mediaHashOf(null), null);
});

test('mediaSourceOf: always an HTTP address on the asset service, never a disk path', () => {
  assert.equal(frames.mediaSourceOf({ hash: h, path: 'C:\\x\\out\\media\\a.mp4' }, o), `${o}/@media/${h}`);
  assert.equal(frames.mediaSourceOf({ url: `/@media/${h}.mp4` }, o), `${o}/@media/${h}.mp4`);
  assert.equal(frames.mediaSourceOf({ url: '/@media/clip.mp4' }, o), `${o}/@media/clip.mp4`);
  // Absolute path of legacy .proc: handed as-is to asset service /api/media/file
  // (checked against allowlist on that side), not concatenated into /@media/file
  const legacy = '/api/media/file?path=C%3A%2FUsers%2Fu%2FVideos%2FPromptCut%2Fmedia%2Fa.mp4';
  assert.equal(frames.mediaSourceOf({ url: legacy, path: 'C:/Users/u/Videos/PromptCut/media/a.mp4' }, o), `${o}${legacy}`);
  // Hash takes precedence when present
  assert.equal(frames.mediaSourceOf({ hash: h, url: legacy }, o), `${o}/@media/${h}`);
  // Only path: take only the last segment filename, cannot point outside the store
  assert.equal(frames.mediaSourceOf({ path: 'C:\\Windows\\win.ini' }, o), `${o}/@media/win.ini`);
  assert.equal(frames.mediaSourceOf({ hash: h }, null), null, 'asset service unreachable');
  assert.equal(frames.mediaSourceOf({ url: legacy }, null), null, 'asset service unreachable');
});

test('ffmpeg-frames no longer reads the local content store\'s directory', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'vision', 'ffmpeg-frames.ts'), 'utf8');
  assert.ok(!/mediaDir|mediaFileOf|from "node:fs"/.test(src), 'Does not import mediaDir / node:fs, and has no mediaFileOf');
  const routes = fs.readFileSync(path.join(ROOT, 'server', 'vision', 'routes.ts'), 'utf8');
  assert.ok(!/mediaFileOf/.test(routes), '/api/vision/sheet no longer reads media by file');
});
