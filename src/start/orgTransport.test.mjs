/**
 * Account client connected as sync engine transport (`src/start/orgTransport.ts`).
 * Run: npm test -- src/start/orgTransport.test.mjs
 *
 *   TRN-01 Server has no such route (404 / 405 / 501, no-route, org-unavailable) translated into
 *     OrgUnsupportedError; other errors thrown as is
 *   TRN-02 Conflict and success results passed to engine as is; client not ready throws regular
 *     error (engine treats as pending sync)
 *   TRN-03 Connect to engine: old server 404 → UI state unsupported, do not throw; network error →
 *     pending
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountOrgTransport, isUnsupported } from './orgTransport.ts';
import { OrgUnsupportedError, createOrgSync } from './orgSync.ts';
import { emptyOrg } from './vibeOrg.ts';

const failure = (status, code) => Object.assign(new Error(code), { status, code });
const org = (o = {}) => ({ v: 1, realm: 'cloud', groups: [], projects: [], chats: [], ...o });

test('TRN-01 a missing route is translated to OrgUnsupportedError; other errors are rethrown as is', async () => {
  for (const e of [failure(404, 'account-protocol'), failure(404, 'no-route'), failure(405, 'x'), failure(501, 'x'), failure(503, 'org-unavailable'), failure(200, 'no-route')])
    assert.equal(isUnsupported(e), true, `${e.status} ${e.code}`);
  for (const e of [failure(0, 'network'), failure(503, 'authority-unavailable'), failure(401, 'login-required'), failure(500, 'x'), new Error('boom'), null, 'str'])
    assert.equal(isUnsupported(e), false);

  const t = accountOrgTransport(() => ({
    getStartOrg: async () => { throw failure(404, 'no-route'); },
    putStartOrg: async () => { throw failure(0, 'network'); },
  }));
  await assert.rejects(t.get(), (e) => e instanceof OrgUnsupportedError);
  await assert.rejects(t.put(0, emptyOrg('cloud')), (e) => !(e instanceof OrgUnsupportedError) && e.code === 'network');
});

test('TRN-02 conflicts and successes are passed to the engine as is; a client that is not ready throws a plain error', async () => {
  const conflict = { conflict: true, version: 5, org: org({ groups: [{ id: 'g', name: 'x' }] }) };
  const ok = { conflict: false, version: 6, org: org() };
  let next = conflict;
  const t = accountOrgTransport(() => ({ getStartOrg: async () => ({ version: 5, org: conflict.org }), putStartOrg: async () => next }));
  assert.deepEqual(await t.put(1, emptyOrg('cloud')), conflict);
  next = ok;
  assert.deepEqual(await t.put(5, emptyOrg('cloud')), ok);
  assert.deepEqual(await t.get(), { version: 5, org: conflict.org });
  const none = accountOrgTransport(() => null);
  await assert.rejects(none.get(), (e) => !(e instanceof OrgUnsupportedError));
});

test('TRN-03 wired to the engine: old server 404 → unsupported, no throw; network error → pending', async () => {
  const run = async (error) => {
    const statuses = [];
    const sync = createOrgSync({
      transport: accountOrgTransport(() => ({ getStartOrg: async () => { throw error; }, putStartOrg: async () => { throw error; } })),
      getOrg: () => emptyOrg('cloud'), applyOrg() {}, loadMeta: () => null, saveMeta() {}, onStatus: (s) => statuses.push(s),
      schedule: () => () => {},
    });
    await sync.refresh();
    return sync.status();
  };
  assert.equal(await run(failure(404, 'account-protocol')), 'unsupported');
  assert.equal(await run(failure(0, 'network')), 'pending');
});
