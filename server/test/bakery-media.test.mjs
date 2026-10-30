import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mediaSourceOf } from '../bakery/media.mjs';

// 导出时 ffmpeg 读素材的规则:只认这一趟导出自己的产物目录,其余一律经页面同源的 HTTP(素材服务),
// 不读本地内容库的目录、不认 m.path(docs/semantics/product/asset-service.md「职责」)
const pageUrl = 'http://127.0.0.1:5220/?export=1';
const hash = 'a'.repeat(64);

test('素材库里的素材走页面同源的 HTTP,不落到本地内容库的文件', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bakery-media-'));
  try {
    // 就算本地内容库里真有这个文件,也不能直接读
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

test('只有 path 没有 url 的素材不再按磁盘路径读', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bakery-media-'));
  try {
    const f = path.join(outDir, 'real.mp4');
    fs.writeFileSync(f, 'x');
    assert.equal(mediaSourceOf({ path: f }, { outDir, pageUrl }), null);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('导出时浏览器上传的素材仍从这一趟的产物目录读,越界的不认', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bakery-media-'));
  try {
    fs.mkdirSync(path.join(outDir, 'media'));
    const f = path.join(outDir, 'media', 'up.mp4');
    fs.writeFileSync(f, 'x');
    assert.equal(mediaSourceOf({ url: '/@export/job-1/media/up.mp4' }, { outDir, pageUrl }), f);
    // 越出产物目录的:退回同源 HTTP,由那一侧的路由决定给不给,不在这里读盘
    const esc = mediaSourceOf({ url: '/@export/job-1/media/..%2F..%2Fsecret.txt' }, { outDir, pageUrl });
    assert.ok(esc === null || /^http:\/\/127\.0\.0\.1:5220\//.test(esc), String(esc));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('不同源、blob、data 地址一律不认', () => {
  const outDir = os.tmpdir();
  assert.equal(mediaSourceOf({ url: 'http://evil.example/a.mp4' }, { outDir, pageUrl }), null);
  assert.equal(mediaSourceOf({ url: 'file:///C:/Windows/win.ini' }, { outDir, pageUrl }), null);
  assert.equal(mediaSourceOf({ url: 'blob:http://127.0.0.1:5220/1' }, { outDir, pageUrl }), null);
  assert.equal(mediaSourceOf({ url: 'data:video/mp4;base64,AA' }, { outDir, pageUrl }), null);
  assert.equal(mediaSourceOf({}, { outDir, pageUrl }), null);
});
