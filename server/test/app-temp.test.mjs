// The app's own temporary directory (server/app-temp.mjs): one per user off Windows, so two users
// of the same machine never share `/tmp/promptcut`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appTempDir, ensureAppTempDir, sessionHistoryDir } from '../app-temp.mjs';
import { defaultPortFile } from '../agent/desktop-mcp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const posix = process.platform !== 'win32';

test('APPTMP-1 Windows keeps <tmp>/promptcut; elsewhere the name carries the user id', () => {
  assert.equal(appTempDir({ tmpdir: '/T', platform: 'win32', uid: undefined }), path.join('/T', 'promptcut'));
  assert.equal(appTempDir({ tmpdir: '/T', platform: 'win32', uid: 7 }), path.join('/T', 'promptcut'));
  assert.equal(appTempDir({ tmpdir: '/T', platform: 'linux', uid: 1004 }), path.join('/T', 'promptcut-1004'));
  assert.equal(appTempDir({ tmpdir: '/T', platform: 'darwin', uid: 501 }), path.join('/T', 'promptcut-501'));
  assert.equal(appTempDir({ tmpdir: '/T', platform: 'linux', uid: 0 }), path.join('/T', 'promptcut-0'), 'root is a user like any other');
  assert.notEqual(
    appTempDir({ tmpdir: '/T', platform: 'linux', uid: 1004 }),
    appTempDir({ tmpdir: '/T', platform: 'linux', uid: 1006 }),
    'two users of one machine get two directories',
  );
});

test('APPTMP-2 the session history and the port file are inside it', () => {
  const options = { tmpdir: '/T', platform: 'linux', uid: 1004 };
  assert.equal(sessionHistoryDir(options), path.join('/T', 'promptcut-1004', 'harness-sessions'));
  const tmp = path.join(os.tmpdir(), 'app-temp-test');
  assert.equal(defaultPortFile(tmp), path.join(appTempDir({ tmpdir: tmp }), 'port.json'));
});

test('APPTMP-3 ensureAppTempDir creates it for this user only, and is fine with finding it there', { skip: !posix && 'POSIX ownership and modes' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-temp-'));
  try {
    const dir = ensureAppTempDir({ tmpdir: tmp });
    assert.equal(dir, appTempDir({ tmpdir: tmp }));
    const st = fs.statSync(dir);
    assert.equal(st.uid, process.getuid());
    assert.equal(st.mode & 0o777, 0o700);
    assert.equal(ensureAppTempDir({ tmpdir: tmp }), dir, 'second call');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('APPTMP-4 a link or a file of that name is refused, not followed', { skip: !posix && 'POSIX ownership and modes' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-temp-'));
  try {
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, appTempDir({ tmpdir: tmp }));
    assert.throws(() => ensureAppTempDir({ tmpdir: tmp }), /not a directory owned by the current user/);
    assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was written through the link');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('APPTMP-5 nothing else under server/ builds <tmp>/promptcut by hand', () => {
  // The harness keeps its own default for when it is used without PromptCut (env-snapshot.mjs).
  const allowed = new Set(['server/app-temp.mjs', 'server/harness/env-snapshot.mjs']);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (!/\.(mjs|ts)$/.test(entry.name)) continue;
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (allowed.has(rel) || rel === 'server/test/app-temp.test.mjs') continue;
      if (/tmpdir\(\)\s*,\s*['"]promptcut['"]\s*[,)]/.test(fs.readFileSync(full, 'utf8'))) offenders.push(rel);
    }
  };
  walk(path.join(ROOT, 'server'));
  assert.deepEqual(offenders, [], 'use appTempDir() / ensureAppTempDir() from server/app-temp.mjs');
});
