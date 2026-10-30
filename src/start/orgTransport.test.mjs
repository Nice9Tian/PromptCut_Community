/**
 * 账号客户端接成同步引擎的传输(`src/start/orgTransport.ts`)。跑:npm test -- src/start/orgTransport.test.mjs
 *
 *   TRN-01 服务端没有这条路由(404 / 405 / 501、no-route、org-unavailable)翻成 OrgUnsupportedError;别的错误原样抛
 *   TRN-02 冲突和成功的结果原样交给引擎;客户端还没就绪抛普通错误(引擎当待同步)
 *   TRN-03 接上引擎:老服务端 404 → 界面状态 unsupported、不抛;网络错 → pending
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountOrgTransport, isUnsupported } from './orgTransport.ts';
import { OrgUnsupportedError, createOrgSync } from './orgSync.ts';
import { emptyOrg } from './vibeOrg.ts';

const failure = (status, code) => Object.assign(new Error(code), { status, code });
const org = (o = {}) => ({ v: 1, realm: 'cloud', groups: [], projects: [], chats: [], ...o });

test('TRN-01 没有这条路由翻成 OrgUnsupportedError;别的错误原样抛', async () => {
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

test('TRN-02 冲突和成功原样交给引擎;客户端没就绪抛普通错误', async () => {
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

test('TRN-03 接上引擎:老服务端 404 → unsupported、不抛;网络错 → pending', async () => {
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
