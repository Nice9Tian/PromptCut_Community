import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createAssetRevocationConsumer } from '../asset-store/project-revocations.mjs';
import { openProjectStream, authorizeAsset } from '../asset-store/project-access.mjs';

function provider() {
  const events = [], acks = [], callbacks = new Set(); let failAck = false, allowed = true;
  return { events, acks,
    checkAccess: async () => { if (!allowed) throw Object.assign(new Error('login-revoked'), { status: 401 }); return { allowed: true }; },
    subscribeRevocations(_context, cb) { callbacks.add(cb); return () => callbacks.delete(cb); },
    eventsSince: async after => ({ events: events.filter(e => e.seq > after).slice(0, 2), headSeq: events.length }),
    async ackAccessEvent(id, service, receipt) { assert.equal(service, 'asset'); assert.equal(receipt.complete, true); acks.push({ id, receipt: structuredClone(receipt) }); if (failAck) throw new Error('lost-ack'); },
    failAck(value) { failAck = value; }, deny() { allowed = false; },
    append(type, fields = {}, notify = true) { const e = { seq: events.length + 1, eventId: `ev-${events.length + 1}`, type, ...fields }; events.push(e); if (notify) for (const cb of callbacks) cb(e); return e; },
  };
}
async function fixture(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-events-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return path.join(dir, 'cursor.json'); }
const principal = { projectId: 'A', accountId: 'alice', loginId: 'old-login', authorizationId: 'RAM-only-ref' };

test('asset durable cursor 分页追齐、丢通知重放，非撤销/其它项目/账号/登录不关错流', async t => {
  const raw = provider(), file = await fixture(t);
  raw.append('project-created', {}, false); raw.append('member-joined', {}, false); raw.append('project-access-changed', { reason: 'unban', projectId: 'A' }, false);
  const consumer = createAssetRevocationConsumer({ authority: raw, file }); await consumer.start(); t.after(() => consumer.close());
  assert.equal(consumer.cursor, 3);
  const lease = await openProjectStream({ authority: consumer, principal, projectId: 'A' }); const stream = lease.track(new Readable({ read() {} }));
  raw.append('login-revoked', { accountIds: ['alice'], loginIds: ['other-login'] }, false);
  raw.append('project-access-changed', { reason: 'kick', projectId: 'B', accountIds: ['alice'] }, false);
  raw.append('project-access-changed', { reason: 'kick', projectId: 'A', accountIds: ['bob'] }, false);
  await consumer.sync(); assert.equal(consumer.cursor, 6); assert.equal(stream.destroyed, false);
  raw.append('login-revoked', { accountIds: ['alice'], loginIds: ['old-login'] }, false);
  await consumer.sync(); assert.equal(stream.closed, true); assert.equal(consumer.cursor, 7);
  assert.equal(raw.acks.at(-1).receipt.closedStreams.length, 1);
  const disk = await fs.readFile(file, 'utf8'); assert.equal(/RAM-only-ref|old-login|alice/.test(disk), false);
  lease.release();
});

test('通知立即fence但ACK等待真实close；丢ACK重启同receipt幂等重发，不复活凭证', async t => {
  const raw = provider(), file = await fixture(t); const consumer = createAssetRevocationConsumer({ authority: raw, file }); await consumer.start();
  let finishClose; const close = new Promise(resolve => { finishClose = resolve; });
  const lease = await openProjectStream({ authority: consumer, principal, projectId: 'A', close: () => close });
  const stream = lease.track(new Readable({ read() {} })); raw.failAck(true); raw.deny();
  raw.append('login-revoked', { accountIds: ['alice'], loginIds: ['old-login'] });
  assert.equal(lease.signal.aborted, true); assert.equal(stream.destroyed, true); assert.equal(raw.acks.length, 0);
  finishClose(); await assert.rejects(consumer.sync(), /lost-ack/);
  const persisted = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(persisted.pending.receipt.complete, true); assert.equal(stream.closed, true);
  lease.release(); await consumer.close(); raw.failAck(false);
  const restarted = createAssetRevocationConsumer({ authority: raw, file }); await restarted.start(); t.after(() => restarted.close());
  assert.equal(restarted.cursor, 1); assert.deepEqual(raw.acks.at(-1).receipt, persisted.pending.receipt);
  await assert.rejects(authorizeAsset({ authority: restarted, principal, projectId: 'A', action: 'read' }), { status: 401 });
});

test('连续序列缺口及损坏cursor fail closed；停服务关闭现有流', async t => {
  const raw = provider(), file = await fixture(t); raw.eventsSince = async () => ({ events: [], headSeq: 2 });
  const c = createAssetRevocationConsumer({ authority: raw, file }); await assert.rejects(c.start(), /revocation-gap/); assert.equal(c.ready, false); await c.close();
  await fs.writeFile(file, '{"v":1,"cursor":-1}'); await assert.rejects(createAssetRevocationConsumer({ authority: provider(), file }).start(), /invalid-revocation-state/);
  await fs.rm(file); const healthy = createAssetRevocationConsumer({ authority: provider(), file }); await healthy.start();
  const lease = await openProjectStream({ authority: healthy, principal, projectId: 'A' }); const stream = lease.track(new Readable({ read() {} }));
  await healthy.close(); assert.equal(stream.closed, true); await assert.rejects(lease.assert(), /access-revoked/); lease.release();
});
