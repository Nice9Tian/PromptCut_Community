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
test('Normal reopen on an empty service does not initialize and does not send a snapshot root replacement', () => {
  const c = copy(createEmptyProject('file-snapshot')); c.ds.connect(); state(c.ds, null, 0);
  assert.equal(c.sent.some(m => m.type === 'project.op'), false); assert.equal(c.ds.confirmedProject, null);
  assert.equal(c.ds.project.name, 'file-snapshot');
});
test('Reopening from an old snapshot defers to the latest server state, the version continues, zero root replacements', () => {
  const file = createEmptyProject('old-file'), latest = { ...file, name: 'service-latest' };
  const c = copy(file); c.ds.connect(); state(c.ds, latest, 9);
  assert.equal(c.ds.project.name, 'service-latest'); assert.equal(c.ds.rev, 9);
  assert.equal(c.sent.some(m => m.type === 'project.op'), false);
});
test('Offline queue recovery across instances keeps the expected version; pauses when the remote has been edited, backs up before discarding', () => {
  const initial = createEmptyProject('base'); const c = copy(initial); c.ds.connect(); state(c.ds, initial, 4); c.ds.disconnect();
  c.ds.commit({ ...c.ds.project, name: 'offline-edit' }); const journal = JSON.parse(JSON.stringify(c.ds.recoveryJournal()));
  const reopened = copy(initial); reopened.ds.restoreJournal(journal); reopened.ds.connect(); state(reopened.ds, { ...initial, name: 'remote-edit' }, 5);
  const op = reopened.sent.find(m => m.type === 'project.op'); assert.equal(op.expectRev, 4);
  reopened.ds.receive({ type: 'project.op.rejected', projectId: 'room', opId: op.opId, reason: 'stale', currentRev: 5, since: [] });
  assert.equal(reopened.ds.status, 'paused'); assert.equal(reopened.ds.unconfirmed, 1);
  reopened.ds.discardOffline(); assert.equal(reopened.backups.length, 1); assert.equal(reopened.backups[0].project.name, 'offline-edit');
  assert.equal(reopened.ds.project.name, 'remote-edit');
});
test('New offline operations made while waiting for the identity read are chained with the old log, no edits lost', () => {
  const p = createEmptyProject('base'), before = copy(p); before.ds.connect(); state(before.ds, p, 3); before.ds.disconnect();
  before.ds.commit({ ...before.ds.project, name: 'earlier-offline' });
  const now = copy(p); now.ds.commit({ ...now.ds.project, width: 1600 }); now.ds.restoreJournal(before.ds.recoveryJournal());
  assert.equal(now.ds.project.name, 'earlier-offline'); assert.equal(now.ds.project.width, 1600); assert.equal(now.ds.unconfirmed, 2);
});
