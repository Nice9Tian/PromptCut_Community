/**
 * `LazyFrameStore.readSpill`: temporary read errors like file being busy should back off and retry
 * without deleting the file; only treat as "cache corrupted" if contents cannot be unpacked or file
 * is already gone.
 * Run: npm test
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

/**
 * Makes fs.readFileSync throw code for the first n times on spill files, then reads normally;
 * returns counter
 */
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

test('the first two reads throw EBUSY: after retrying, the content is read and the file is still there', () => withStore((store) => {
  assert.equal(store.writeSpill(7, '<div>seven</div>'), true);
  const file = store.spillPath(7);
  const counter = failFirst(file, 2, 'EBUSY');
  try {
    assert.equal(store.readSpill(7), '<div>seven</div>');
  } finally { mock.restoreAll(); }
  assert.equal(counter.calls, 3);
  assert.ok(fs.existsSync(file), 'the file was deleted');
  // Takes the same path via get()
  failFirst(file, 1, 'EPERM');
  try { assert.equal(store.get(7), '<div>seven</div>'); } finally { mock.restoreAll(); }
  assert.ok(fs.existsSync(file));
}));

for (const code of ['EPERM', 'EACCES', 'EMFILE']) {
  test(`${code} never goes away: after the retries are used up it returns undefined and the file is still there`, () => withStore((store) => {
    store.writeSpill(3, 'x');
    const file = store.spillPath(3);
    const counter = failFirst(file, Infinity, code);
    try { assert.equal(store.readSpill(3), undefined); } finally { mock.restoreAll(); }
    assert.equal(counter.calls, 1 + SPILL_READ_RETRIES);
    assert.ok(fs.existsSync(file), 'the file was deleted');
    assert.equal(store.readSpill(3), 'x', 'can be read once the file is no longer in use');
  }));
}

test('backoff interval is between 20 and 200 ms', () => {
  for (let i = 0; i < SPILL_READ_RETRIES; i++) {
    const ms = spillBackoffMs(i);
    assert.ok(ms >= 20 && ms <= 200, `attempt ${i}: ${ms} ms`);
  }
});

test('content cannot be decoded: delete the file as in the original logic, return undefined, and do not retry', () => withStore((store) => {
  fs.mkdirSync(store.spillDir, { recursive: true });
  const file = store.spillPath(5);
  fs.writeFileSync(file, 'not gzip');
  const counter = failFirst(file, 0, 'EBUSY');
  try { assert.equal(store.readSpill(5), undefined); } finally { mock.restoreAll(); }
  assert.equal(counter.calls, 1);
  assert.equal(fs.existsSync(file), false);
}));

test('file is missing (ENOENT): returns undefined, no retry', () => withStore((store) => {
  const file = store.spillPath(9);
  const counter = failFirst(file, 0, 'EBUSY');
  try { assert.equal(store.readSpill(9), undefined); } finally { mock.restoreAll(); }
  assert.equal(counter.calls, 1);
}));

test('other read errors (EISDIR): not deleted, no retry', () => withStore((store) => {
  store.writeSpill(4, 'y');
  const file = store.spillPath(4);
  const counter = failFirst(file, Infinity, 'EISDIR');
  try { assert.equal(store.readSpill(4), undefined); } finally { mock.restoreAll(); }
  assert.equal(counter.calls, 1);
  assert.ok(fs.existsSync(file));
}));
