import test from 'node:test';
import assert from 'node:assert/strict';
import { mountSelection } from '../docservice/modules/selection.mjs';

const principal = { role: 'page', tenantId: 'project-capture', projectId: 'project-capture', accountId: 'account-a',
  loginId: 'login-a', credentialId: 'credential-a', loginGeneration: 1, accountName: 'Trusted name' };
function fixture(check = async () => ({ allowed: true, projectId: principal.projectId, accountId: principal.accountId })) {
  const replies = [], ctx = { send: (_id, message) => replies.push(message) };
  const mod = mountSelection({ project: { bodyOf: () => ({}), revOf: () => 1 }, checkAccess: check,
    authorizeQuery: async () => { throw Error('not a run query'); }, now: () => 100 });
  const set = async (id = 'conn-a', value = { clipIds: ['clip-a'] }, revision = 1) => {
    await mod.handle(ctx, id, { type: 'selection.set', projectId: principal.projectId, pageId: 'page-a', revision, selection: value });
    assert.equal(replies.at(-1).type, 'selection.ok');
  };
  mod.connect(ctx, 'conn-a', principal);
  return { mod, ctx, set, capture: () => mod.captureSnapshot({ principal, projectId: principal.projectId, pageId: 'page-a' }) };
}
test('capture takes the real live selection and returns an independent sent snapshot, including empty selection', async () => {
  const f = fixture(); await f.set(); const snapshot = await f.capture();
  assert.deepEqual(snapshot, { source: 'sent-snapshot', projectId: principal.projectId, accountId: principal.accountId,
    pageId: 'page-a', selection: { clipIds: ['clip-a'] }, sentAt: 100 });
  snapshot.selection.clipIds.push('forged'); assert.deepEqual((await f.capture()).selection.clipIds, ['clip-a']);
  await f.set('conn-a', { clipIds: [] }, 2); assert.deepEqual((await f.capture()).selection, { clipIds: [] });
});
test('capture rejects body snapshot/name and every mismatched credential identity', async () => {
  const f = fixture(); await f.set();
  for (const extra of [{ selection: { clipIds: ['forged'] } }, { username: 'forged' }])
    await assert.rejects(f.mod.captureSnapshot({ principal, projectId: principal.projectId, pageId: 'page-a', ...extra }), /invalid-authority-claim/);
  for (const [field, value] of Object.entries({ accountId: 'other', loginId: 'other', credentialId: 'other', loginGeneration: 2 }))
    await assert.rejects(f.mod.captureSnapshot({ principal: { ...principal, [field]: value }, projectId: principal.projectId, pageId: 'page-a' }),
      /principal-mismatch|selection-page-unavailable/);
  await assert.rejects(f.mod.captureSnapshot({ principal, projectId: 'other-project', pageId: 'page-a' }), /forbidden/);
});
test('offline, synthetic and ambiguous page references cannot supply a sent snapshot', async () => {
  const f = fixture(); await assert.rejects(f.capture(), /selection-page-unavailable/);
  await f.set(); f.mod.connect(f.ctx, 'conn-b', principal); await f.set('conn-b');
  await assert.rejects(f.capture(), /selection-page-unavailable/);
  f.mod.disconnect(f.ctx, 'conn-b'); f.mod.disconnect(f.ctx, 'conn-a');
  await assert.rejects(f.capture(), /selection-page-unavailable/);
});
test('a selection revision that changes during live revalidation is rejected rather than substituted', async () => {
  let calls = 0, release, entered;
  const barrier = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
  let paused = false;
  const f = fixture(async () => { if (paused && ++calls === 2) { entered(); await barrier; }
    return { allowed: true, accountId: principal.accountId, projectId: principal.projectId }; });
  await f.set(); paused = true;
  const pending = f.capture(); await reached; paused = false; await f.set('conn-a', { clipIds: ['new'] }, 2); release();
  await assert.rejects(pending, /selection-page-changed/);
});
test('credential revocation during capture is rechecked and a blocked record is never captured', async () => {
  let revoked = false;
  const f = fixture(async () => { if (revoked) throw Object.assign(Error('credential-revoked'), { status: 403 });
    return { allowed: true, accountId: principal.accountId, projectId: principal.projectId }; });
  await f.set(); revoked = true; await assert.rejects(f.capture(), /credential-revoked/);
  revoked = false; f.mod.revoke({ projectId: principal.projectId, accountId: principal.accountId });
  await assert.rejects(f.capture(), /selection-page-unavailable/);
});
test('access token renewal rotating credentialId on the same loginId and loginGeneration preserves live page capture', async () => {
  let activeCredentialId = 'credential-a';
  const f = fixture(async ({ principal: p }) => ({ allowed: true, projectId: p.projectId, accountId: p.accountId, credentialId: activeCredentialId }));
  await f.set();
  activeCredentialId = 'credential-renewed';
  const snapshot = await f.mod.captureSnapshot({
    principal: { ...principal, credentialId: 'credential-renewed' },
    projectId: principal.projectId,
    pageId: 'page-a',
  });
  assert.deepEqual(snapshot.selection, { clipIds: ['clip-a'] });
});

