/**
 * `LazyFrameStore.readSpill`：文件被占用之类的暂时性读错误要退避重试、不删文件；
 * 只有内容解不开或文件已经没了才按「缓存坏了」处理。
 * 跑：npm test
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LazyFrameStore, SPILL_READ_RETRIES, spillBackoffMs } from '../frame-archive.mjs';

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-spill-retry-'));
  const store = new LazyFrameStore([], { spillDir: dir });
  try { return fn(store); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const codeError = (code) => Object.assign(new Error(`${code}: fake`), { code });

/** 让 fs.readFileSync 对 spill 文件前 n 次抛 code，之后照常读；返回计数器 */
function failFirst(file, n, code) {
  const real = fs.readFileSync;
  const counter = { calls: 0 };
  mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (p === file) {
      counter.calls++;
      if (counter.calls <= n) throw codeError(code);
    }
    return real.call(this, p, ...rest);
  });
  return counter;
}

test('前两次读抛 EBUSY：重试后读到内容，文件还在', () => withStore((store) => {
  assert.equal(store.writeSpill(7, '<div>七</div>'), true);
  const file = store.spillPath(7);
  const counter = failFirst(file, 2, 'EBUSY');
  try {
    assert.equal(store.readSpill(7), '<div>七</div>');
  } finally { mock.restoreAll(); }
  assert.equal(counter.calls, 3);
  assert.ok(fs.existsSync(file), '文件被删了');
  // 经 get() 走同一条路
  failFirst(file, 1, 'EPERM');
  try { assert.equal(store.get(7), '<div>七</div>'); } finally { mock.restoreAll(); }
  assert.ok(fs.existsSync(file));
}));

for (const code of ['EPERM', 'EACCES', 'EMFILE']) {
  test(`${code} 一直不消失：试满次数后返回 undefined，文件还在`, () => withStore((store) => {
    store.writeSpill(3, 'x');
    const file = store.spillPath(3);
    const counter = failFirst(file, Infinity, code);
    try { assert.equal(store.readSpill(3), undefined); } finally { mock.restoreAll(); }
    assert.equal(counter.calls, 1 + SPILL_READ_RETRIES);
    assert.ok(fs.existsSync(file), '文件被删了');
    assert.equal(store.readSpill(3), 'x', '占用解除后能读到');
  }));
}

test('退避间隔在 20～200 ms 之间', () => {
  for (let i = 0; i < SPILL_READ_RETRIES; i++) {
    const ms = spillBackoffMs(i);
    assert.ok(ms >= 20 && ms <= 200, `第 ${i} 次 ${ms} ms`);
  }
});

test('内容解不开：照原逻辑删掉文件、返回 undefined，不重试', () => withStore((store) => {
  fs.mkdirSync(store.spillDir, { recursive: true });
  const file = store.spillPath(5);
  fs.writeFileSync(file, 'not gzip');
  const counter = failFirst(file, 0, 'EBUSY');
  try { assert.equal(store.readSpill(5), undefined); } finally { mock.restoreAll(); }
  assert.equal(counter.calls, 1);
  assert.equal(fs.existsSync(file), false);
}));

test('文件不在（ENOENT）：返回 undefined，不重试', () => withStore((store) => {
  const file = store.spillPath(9);
  const counter = failFirst(file, 0, 'EBUSY');
  try { assert.equal(store.readSpill(9), undefined); } finally { mock.restoreAll(); }
  assert.equal(counter.calls, 1);
}));

test('其它读错误（EISDIR）：不删、不重试', () => withStore((store) => {
  store.writeSpill(4, 'y');
  const file = store.spillPath(4);
  const counter = failFirst(file, Infinity, 'EISDIR');
  try { assert.equal(store.readSpill(4), undefined); } finally { mock.restoreAll(); }
  assert.equal(counter.calls, 1);
  assert.ok(fs.existsSync(file));
}));
