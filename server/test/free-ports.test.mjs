// Where the tests record which ports they picked (server/test/free-ports.mjs): one directory for
// every user of the machine, because two users draw from the same ports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claimDirFor, freePorts } from './free-ports.mjs';

const posix = process.platform !== 'win32';
const root = posix && process.getuid() === 0;
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'free-ports-test-'));

test('PORTS-1 the shared directory is created writable for every user, sticky like /tmp', { skip: !posix && 'POSIX modes' }, () => {
  const tmp = scratch();
  try {
    const shared = path.join(tmp, 'claims');
    assert.equal(claimDirFor({ shared }), shared);
    assert.equal(fs.statSync(shared).mode & 0o1777, 0o1777);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('PORTS-2 a directory an older checkout left closed is opened up by its owner', { skip: !posix && 'POSIX modes' }, () => {
  const tmp = scratch();
  try {
    const shared = path.join(tmp, 'claims');
    fs.mkdirSync(shared, { mode: 0o775 });
    fs.chmodSync(shared, 0o775);
    assert.equal(claimDirFor({ shared }), shared);
    assert.equal(fs.statSync(shared).mode & 0o1777, 0o1777);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('PORTS-3 someone else\'s closed directory: fall back to a directory of one\'s own, and leave theirs alone', { skip: (!posix && 'POSIX modes') || (root && 'root can write anywhere') }, () => {
  const tmp = scratch();
  try {
    const shared = path.join(tmp, 'claims');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o555);
    const other = process.getuid() + 1; // the caller is "another user": the directory is not theirs to chmod
    const dir = claimDirFor({ shared, uid: other });
    assert.equal(dir, `${shared}-${other}`);
    assert.ok(fs.statSync(dir).isDirectory());
    assert.equal(fs.statSync(shared).mode & 0o1777, 0o555, 'not theirs: untouched');
  } finally {
    try { fs.chmodSync(path.join(tmp, 'claims'), 0o755); } catch { /* already gone */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('PORTS-4 Windows keeps the one directory under %TEMP%', () => {
  const tmp = scratch();
  try {
    const shared = path.join(tmp, 'claims');
    assert.equal(claimDirFor({ shared, platform: 'win32', uid: undefined }), shared);
    assert.ok(fs.statSync(shared).isDirectory());
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('PORTS-5 freePorts still hands out distinct ports', async () => {
  const ports = await freePorts(3);
  assert.equal(new Set(ports).size, 3);
  for (const port of ports) assert.ok(port >= 20000 && port < 49152, String(port));
});
