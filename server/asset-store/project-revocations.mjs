/** 可信 asset 服务事件消费者；doc 是权限权威。仅存连续 cursor 和已完成 receipt，绝不落 token/principal 引用。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assetAccessError } from './project-access.mjs';

export function createAssetRevocationConsumer({ authority, file, serviceId = 'asset', participants = [] }) {
  if (!file || serviceId !== 'asset') throw new TypeError('trusted asset consumer file/service required');
  for (const name of ['checkAccess', 'subscribeRevocations', 'eventsSince', 'ackAccessEvent']) if (typeof authority?.[name] !== 'function') throw new TypeError(`authority.${name} required`);
  if (!Array.isArray(participants) || participants.some(p => typeof p?.handleAccessEvent !== 'function' || typeof p?.unavailable !== 'function'))
    throw new TypeError('trusted resource participants required');
  let state = { v: 1, cursor: 0, pending: null }, chain = Promise.resolve(), ready = false, stopped = false, unsubscribe;
  const listeners = new Map(), deliveries = new Map();
  async function persist() {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(tmp, 'wx');
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(tmp, file); } catch (error) { await fs.rm(tmp, { force: true }); throw error; }
    if (process.platform !== 'win32') { const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  }
  function deliver(event) {
    if (deliveries.has(event.eventId)) return deliveries.get(event.eventId);
    // callback 同步执行到第一次 await；lease 在这里同步 abort/destroy，追齐持久日志不能延迟此 fence。
    const pending = [...listeners].map(([id, entry]) => {
      try { return Promise.resolve(entry.callback(event)).then(value => value?.closed ? id : null); }
      catch (error) { return Promise.reject(error); }
    });
    // The sole human ACK waits for run participants too. These hooks must
    // establish their pause synchronously and use independent doc rechecks;
    // calling this consumer.sync() from a hook would be a lock cycle.
    const additions = participants.map(p => {
      try { return Promise.resolve(p.handleAccessEvent(event)); }
      catch (error) { return Promise.reject(error); }
    });
    const done = Promise.all([Promise.all(pending), Promise.all(additions)]).then(([ids, receipts]) => {
      const result = { closedStreams: ids.filter(Boolean), stoppedRuns: [], rejectedCredentials: [] };
      for (const receipt of receipts) {
        if (receipt?.complete !== true || Object.keys(result).some(k => !Array.isArray(receipt[k]) || receipt[k].some(id => typeof id !== 'string' || !id)))
          throw assetAccessError('resource-closure-pending', 503);
        for (const k of Object.keys(result)) result[k].push(...receipt[k]);
      }
      for (const k of Object.keys(result)) result[k] = [...new Set(result[k])].sort();
      return result;
    });
    deliveries.set(event.eventId, done);
    void done.catch(() => { if (deliveries.get(event.eventId) === done) deliveries.delete(event.eventId); });
    return done;
  }
  async function ackPending() {
    if (!state.pending) return;
    await persist(); // 即使上次落盘失败后重试，也绝不把仅在 RAM 的 receipt 先 ACK。
    await authority.ackAccessEvent(state.pending.eventId, serviceId, state.pending.receipt);
    state = { v: 1, cursor: state.pending.receipt.cursor, pending: null };
    await persist();
  }
  async function drain() {
    if (stopped) throw assetAccessError('revocation-unavailable', 503);
    await ackPending();
    for (;;) {
      const page = await authority.eventsSince(state.cursor);
      if (!Number.isSafeInteger(page?.headSeq) || page.headSeq < state.cursor || !Array.isArray(page.events)) throw new Error('invalid-revocation-page');
      if (!page.events.length) {
        if (page.headSeq !== state.cursor) throw new Error('revocation-gap');
        ready = true;
        return state.cursor;
      }
      for (const event of page.events) {
        if (event.seq !== state.cursor + 1 || !event.eventId) throw new Error('revocation-gap');
        const resources = await deliver(event);
        state.pending = { eventId: event.eventId, receipt: { receiptId: crypto.randomUUID(), cursor: event.seq, complete: true, ...resources } };
        // 先持久已完成凭据再 ACK；ACK丢失/崩溃后重复完全相同 receipt，不虚构未关闭完成。
        await persist();
        await ackPending();
        deliveries.delete(event.eventId);
      }
    }
  }
  function sync() {
    const result = chain.catch(() => {}).then(drain);
    chain = result;
    return result.catch(async error => { ready = false; await Promise.all([
      ...[...listeners.values()].map(entry => entry.callback({ reason: 'revocation-unavailable' })),
      ...participants.map(p => p.unavailable(error)),
    ]); throw error; });
  }
  return {
    async start() {
      if (unsubscribe) throw new Error('consumer-already-started');
      try { const saved = JSON.parse(await fs.readFile(file, 'utf8')); if (saved.v !== 1 || !Number.isSafeInteger(saved.cursor) || saved.cursor < 0) throw new Error('invalid-revocation-state'); state = saved; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (state.pending && (state.pending.receipt?.complete !== true || state.pending.receipt.cursor !== state.cursor + 1 || !state.pending.eventId || !state.pending.receipt.receiptId)) throw new Error('invalid-revocation-state');
      unsubscribe = authority.subscribeRevocations({}, event => {
        // 不把异步通知当完整日志。闭流同步启动，随后从 cursor 连续重放补乱序/重复/丢失。
        if (event.seq > state.cursor) void deliver(event).catch(() => { ready = false; });
        void sync().catch(() => { ready = false; });
      });
      await sync();
    },
    sync,
    async checkAccess(request) {
      if (!unsubscribe || stopped) throw assetAccessError('revocation-unavailable', 503);
      await sync();
      const result = await authority.checkAccess(request);
      await sync();
      return result;
    },
    subscribeRevocations(context, callback) {
      if (!ready || stopped) throw assetAccessError('revocation-unavailable', 503);
      const id = crypto.randomUUID(); listeners.set(id, { context, callback });
      return () => listeners.delete(id);
    },
    async close() { stopped = true; ready = false; unsubscribe?.(); unsubscribe = null; await chain.catch(() => {}); await Promise.all([
      ...[...listeners.values()].map(entry => entry.callback({ reason: 'revocation-unavailable' })),
      ...participants.map(p => p.unavailable(assetAccessError('revocation-unavailable', 503))),
    ]); listeners.clear(); },
    get cursor() { return state.cursor; },
    get ready() { return ready; },
  };
}
