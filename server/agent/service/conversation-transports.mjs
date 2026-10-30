import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { accountError, digestOf } from './run-asset-client.mjs';

const fail = code => { throw accountError(503, code); };
/** Actual HTTP ownership, including authentication and pending doc calls. Only
 * this process's objects are closed. A close request is not a close receipt. */
export function createConversationTransports({ instanceIdentity, onClosed = async () => {} } = {}) {
  if (typeof instanceIdentity !== 'function' || typeof onClosed !== 'function') fail('read-transport-configuration');
  const context = new AsyncLocalStorage(), entries = new Map(), closed = new Map();
  let connected = false, stopped = false;
  function begin(req, res) {
    const instance = instanceIdentity();
    if (stopped || !connected || !instance) fail('read-control-unavailable');
    const requestId = `http-read_${randomUUID()}`, readHandleId = `read_${digestOf({ instanceId: instance.instanceId, requestId })}`;
    let resolveClosed;
    const entry = { requestId, readHandleId, instance, req, res, socket: req.socket, revoked: false,
      accepted: false, attempted: false, pending: new Set(), responseClosed: false, socketClosed: false,
      closed: new Promise(resolve => { resolveClosed = resolve; }) };
    const finish = () => {
      if (!entry.responseClosed || !entry.socketClosed || entry.pending.size || entry.finished) return;
      entry.finished = true; entries.delete(readHandleId); closed.set(readHandleId, entry);
      resolveClosed({ readHandleId });
      if (entry.attempted) void onClosed(readHandleId).catch(() => {});
    };
    entry.finish = finish;
    entry.revoke = () => {
      entry.revoked = true;
      for (const call of entry.pending) call.abort();
      res.destroy(); req.socket.destroy();
      // destroy() schedules close; it does not satisfy either observed flag.
    };
    res.once('close', () => { entry.responseClosed = true; finish(); });
    req.socket.once('close', () => { entry.socketClosed = true; finish(); });
    res.setHeader('Connection', 'close');
    for (const name of ['write', 'end']) {
      const original = res[name];
      res[name] = function (...args) {
        // There is no await between checking this local fence and enqueueing.
        if (entry.revoked || !connected || (!entry.accepted && res.statusCode < 400)) {
          entry.revoke(); return name === 'write' ? false : res;
        }
        return original.apply(this, args);
      };
    }
    entries.set(readHandleId, entry);
    return entry;
  }
  function track(entry, promise, abort) {
    if (!entry || entry.revoked || !connected) { abort(); fail('read-transport-revoked'); }
    const call = { abort }; entry.pending.add(call);
    // Attach both handlers immediately, including when the caller is revoked.
    void promise.then(() => { entry.pending.delete(call); entry.finish(); }, () => { entry.pending.delete(call); entry.finish(); });
    return promise;
  }
  async function read(call) {
    const entry = context.getStore();
    if (!entry || entry.revoked || !connected) fail('read-transport-revoked');
    entry.attempted = true;
    const controller = new AbortController();
    const result = await track(entry, Promise.resolve().then(() => call({ requestId: entry.requestId,
      readHandleId: entry.readHandleId, signal: controller.signal })), () => controller.abort());
    if (entry.revoked || !connected) fail('read-transport-revoked');
    if (result?.readHandle?.readHandleId !== entry.readHandleId || result.readHandle.instanceId !== entry.instance.instanceId ||
        result.readHandle.instanceGeneration !== entry.instance.instanceGeneration) fail('read-handle-protocol');
    entry.accepted = true;
    return result.value;
  }
  function fence(readHandleIds) {
    // Install every matching barrier synchronously before awaiting any close.
    const targets = readHandleIds.map(id => entries.get(id) ?? closed.get(id));
    for (const entry of targets) if (entry && !entry.finished) entry.revoke();
    return (async () => {
      if (targets.some(value => !value)) fail('read-resource-unknown');
      await Promise.all(targets.map(entry => entry.closed));
      return { closedReadHandleIds: [...readHandleIds] };
    })();
  }
  function disconnect() {
    connected = false;
    for (const entry of [...entries.values()]) entry.revoke();
    return Promise.all([...entries.values()].map(entry => entry.closed));
  }
  const dispatch = callback => {
    const entry = context.getStore();
    if (!entry) return callback();
    return track(entry, Promise.resolve().then(callback), () => {});
  };
  return { read, fence, disconnect, dispatch, current: () => context.getStore(),
    run(req, res, callback) { const entry = begin(req, res); return context.run(entry, () => dispatch(callback)); },
    ready() { if (!stopped) connected = true; },
    hasClosed: id => closed.has(id),
    async close() { stopped = true; await disconnect(); context.disable(); },
    describe: () => ({ connected, open: entries.size, closed: closed.size }) };
}
