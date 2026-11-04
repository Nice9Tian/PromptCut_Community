/**
 * What the local identity endpoint `/api/collaboration/*` looks like without closed source
 * extensions (as in the community edition):
 * Endpoints needed to open, refresh, and reopen LAN projects are all present; the host only binds
 * locally without starting background tasks, and move endpoints do not exist.
 * Tested on 2026-10-31, consequence of missing it: opening LAN collaboration errors out; after
 * refreshing, it is stuck forever on "Restoring original collaboration room".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { recoveryHttp } from '../recovery/http.mjs';
import { fileNameOf } from '../docservice/store/index.mjs';

const ROOM = 'sp_abcdefghijklmnopqrstuvwxyz';
const descriptor = { version: 1, roomId: ROOM, service: 'http://192.0.2.10:5190/docservice', where: 'lan' };
const record = { as: 'creator', username: 'alice', key: 'k'.repeat(43), candidate: { where: 'lan', projectId: ROOM, base: descriptor.service, name: 'Room', mode: 'free' } };

async function start(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-local-'));
  const closers = [];
  const handler = recoveryHttp({
    dir: path.join(root, 'vault'), dataDir: root,
    store: { peek: (id) => (id === ROOM ? { projectId: ROOM, name: 'Room', mode: 'free' } : null), list: () => [] },
    device: { deviceId: 'device-host', deviceName: 'Host' }, baseOf: () => 'http://127.0.0.1:5190/docservice',
    onClose: (fn) => closers.push(fn),
  });
  const server = http.createServer((req, res) => handler(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const fn of closers) fn();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const call = async (endpoint, fields = {}) => {
    const r = await fetch(`${base}/api/collaboration/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ descriptor, task: 'task-1', taskVersion: 1, ...fields }),
    });
    return { status: r.status, body: await r.json() };
  };
  return { root, call };
}

test('enable: records the identity, binds the host, and the host status is inactive (no background tasks)', async (t) => {
  const { call } = await start(t);
  assert.equal((await call('identity', { record, contentId: 'content-1' })).status, 200);
  assert.equal((await call('activate-host')).status, 200);
  assert.deepEqual((await call('host-state')).body, { ok: true, state: 'inactive' });
  assert.equal((await call('host-update')).status, 200);
  assert.equal((await call('cancel-host')).status, 200);
});

test('refresh: picks the original identity again, and the host gets its local address back', async (t) => {
  const { root, call } = await start(t);
  await call('identity', { record, contentId: 'content-1' });
  await call('activate-host');
  const selected = (await call('select', { contentId: 'content-1' })).body;
  assert.equal(selected.selected.username, 'alice');
  assert.deepEqual(selected.host, { deviceId: 'device-host' });
  assert.equal(selected.recoveryMove, null);

  assert.equal((await call('restore-host')).body.error, 'host-data-missing', 'not accepted when the project log is missing');
  const projects = path.join(root, 'tenants', ROOM, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, `${fileNameOf(ROOM)}.ops.ndjson`), '');
  const { candidate } = (await call('restore-host')).body;
  assert.equal(candidate.base, 'http://127.0.0.1:5190/docservice');
  assert.equal(candidate.originalHost, true);
});

test('offline edits and local settings can be saved and read back', async (t) => {
  const { call } = await start(t);
  assert.equal((await call('settings-write', { settings: { projectId: ROOM, creatorUsername: 'alice' } })).status, 200);
  assert.equal((await call('settings-read')).body.settings.creatorUsername, 'alice');
  const journal = { version: 1, projectId: ROOM, pending: [], project: { tracks: [] } };
  assert.equal((await call('journal', { contentId: 'content-1', journal })).status, 200);
  assert.deepEqual((await call('select', { contentId: 'content-1' })).body.journal, journal);
});

test('no identity is handed out after sign-out', async (t) => {
  const { call } = await start(t);
  await call('identity', { record, contentId: 'content-1' });
  assert.equal((await call('revoke')).status, 200);
  assert.equal((await call('select', { contentId: 'content-1' })).body.revoked, true);
});

test('without the extension there is no move endpoint', async (t) => {
  const { call } = await start(t);
  assert.equal((await call('move-hosted')).status, 404);
  assert.equal((await call('move-lan')).status, 404);
});
