import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mediaSourceOf } from '../bakery/media.mjs';

// ffmpeg asset reading rules during export: only recognize this export pass's own output directory,
// all others go via same-origin HTTP from the page (asset service); do not read local content
// store directories, do not recognize m.path (docs/semantics/product/asset-service.md "Responsibilities")
const pageUrl = 'http://127.0.0.1:5220/?export=1';
const hash = 'a'.repeat(64);

test('Media in the media library is served over HTTP from the page\'s own origin and is not read from files in the local content store', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bakery-media-'));
  try {
    // Even if this file actually exists in the local content store, it cannot be read directly
    const lib = path.join(outDir, '..', 'media');
    assert.equal(mediaSourceOf({ url: `/@media/${hash}`, path: path.join(lib, `${hash}.mp4`) }, { outDir, pageUrl }),
      `http://127.0.0.1:5220/@media/${hash}`);
    assert.equal(mediaSourceOf({ url: `/@media/${hash}.mp4` }, { outDir, pageUrl }), `http://127.0.0.1:5220/@media/${hash}.mp4`);
    assert.equal(mediaSourceOf({ url: '/api/media/file?path=C%3A%2Fx%2Fa.mp4' }, { outDir, pageUrl }),
      'http://127.0.0.1:5220/api/media/file?path=C%3A%2Fx%2Fa.mp4');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('Media with only a path and no url is no longer read by disk path', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bakery-media-'));
  try {
    const f = path.join(outDir, 'real.mp4');
    fs.writeFileSync(f, 'x');
    assert.equal(mediaSourceOf({ path: f }, { outDir, pageUrl }), null);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('At export, media uploaded by the browser is still read from this run\'s output directory, and anything outside it is rejected', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bakery-media-'));
  try {
    fs.mkdirSync(path.join(outDir, 'media'));
    const f = path.join(outDir, 'media', 'up.mp4');
    fs.writeFileSync(f, 'x');
    assert.equal(mediaSourceOf({ url: '/@export/job-1/media/up.mp4' }, { outDir, pageUrl }), f);
    // Anything exceeding output directory: fall back to same-origin HTTP, let routes on that side
    // decide whether to serve it, do not read from disk here
    const esc = mediaSourceOf({ url: '/@export/job-1/media/..%2F..%2Fsecret.txt' }, { outDir, pageUrl });
    assert.ok(esc === null || /^http:\/\/127\.0\.0\.1:5220\//.test(esc), String(esc));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('Cross-origin, blob and data addresses are all rejected', () => {
  const outDir = os.tmpdir();
  assert.equal(mediaSourceOf({ url: 'http://evil.example/a.mp4' }, { outDir, pageUrl }), null);
  assert.equal(mediaSourceOf({ url: 'file:///C:/Windows/win.ini' }, { outDir, pageUrl }), null);
  assert.equal(mediaSourceOf({ url: 'blob:http://127.0.0.1:5220/1' }, { outDir, pageUrl }), null);
  assert.equal(mediaSourceOf({ url: 'data:video/mp4;base64,AA' }, { outDir, pageUrl }), null);
  assert.equal(mediaSourceOf({}, { outDir, pageUrl }), null);
});
