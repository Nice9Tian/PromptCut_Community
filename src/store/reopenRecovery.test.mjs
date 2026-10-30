import { srcUrl } from '../testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { DocSync } = await import(srcUrl('store/docsync.ts'));
const { createEmptyProject } = await import(srcUrl('kernel/project.ts'));
function copy(initial, extra = {}) {
  const sent = [], backups = [];
  const ds = new DocSync(initial, { projectId: 'room', session: 'reopen-page', initialize: false, send: m => sent.push(m), saveBackup: b => backups.push(b), ...extra });
  return { ds, sent, backups };
}
const state = (ds, project, rev) => ds.receive({ type: 'project.state', projectId: 'room', project, rev });
test('正常重入遇到空服务不初始化，不发送快照根替换', () => {
  const c = copy(createEmptyProject('file-snapshot')); c.ds.connect(); state(c.ds, null, 0);
  assert.equal(c.sent.some(m => m.type === 'project.op'), false); assert.equal(c.ds.confirmedProject, null);
  assert.equal(c.ds.project.name, 'file-snapshot');
});
test('旧快照重入以服务端最新状态为准，版本继续，零根替换', () => {
  const file = createEmptyProject('old-file'), latest = { ...file, name: 'service-latest' };
  const c = copy(file); c.ds.connect(); state(c.ds, latest, 9);
  assert.equal(c.ds.project.name, 'service-latest'); assert.equal(c.ds.rev, 9);
  assert.equal(c.sent.some(m => m.type === 'project.op'), false);
});
test('离线队列跨实例恢复保留期望版本；远端已编辑时暂停，丢弃前备份', () => {
  const initial = createEmptyProject('base'); const c = copy(initial); c.ds.connect(); state(c.ds, initial, 4); c.ds.disconnect();
  c.ds.commit({ ...c.ds.project, name: 'offline-edit' }); const journal = JSON.parse(JSON.stringify(c.ds.recoveryJournal()));
  const reopened = copy(initial); reopened.ds.restoreJournal(journal); reopened.ds.connect(); state(reopened.ds, { ...initial, name: 'remote-edit' }, 5);
  const op = reopened.sent.find(m => m.type === 'project.op'); assert.equal(op.expectRev, 4);
  reopened.ds.receive({ type: 'project.op.rejected', projectId: 'room', opId: op.opId, reason: 'stale', currentRev: 5, since: [] });
  assert.equal(reopened.ds.status, 'paused'); assert.equal(reopened.ds.unconfirmed, 1);
  reopened.ds.discardOffline(); assert.equal(reopened.backups.length, 1); assert.equal(reopened.backups[0].project.name, 'offline-edit');
  assert.equal(reopened.ds.project.name, 'remote-edit');
});
test('等待身份读取期间的新离线操作与旧日志接续，不丢编辑', () => {
  const p = createEmptyProject('base'), before = copy(p); before.ds.connect(); state(before.ds, p, 3); before.ds.disconnect();
  before.ds.commit({ ...before.ds.project, name: 'earlier-offline' });
  const now = copy(p); now.ds.commit({ ...now.ds.project, width: 1600 }); now.ds.restoreJournal(before.ds.recoveryJournal());
  assert.equal(now.ds.project.name, 'earlier-offline'); assert.equal(now.ds.project.width, 1600); assert.equal(now.ds.unconfirmed, 2);
});
