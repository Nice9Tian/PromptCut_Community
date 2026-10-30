/** 素材授权 adapter：唯一 doc authority 注入核验与持久撤销订阅；这里不生成账号/成员权限。 */
import { EventEmitter } from 'node:events';
const REQUEST = Symbol.for('promptcut.asset.request.v2');
export const assetContextOf = req => req?.[REQUEST] ?? null;
export function setAssetContext(req, context) { Object.defineProperty(req, REQUEST, { value: context, configurable: true }); }
export function assetAccessError(code = 'forbidden', status = 403) { return Object.assign(new Error(code), { code, status }); }
export function waitAssetWritable(stream) {
  if (stream.closed) return Promise.reject(assetAccessError('asset-response-closed', 503));
  return new Promise((resolve, reject) => {
    const clear = () => { stream.removeListener('drain', drain); stream.removeListener('close', close); stream.removeListener('error', error); };
    const drain = () => { clear(); resolve(); };
    const close = () => { clear(); reject(assetAccessError('asset-response-closed', 503)); };
    const error = failure => { clear(); reject(failure); };
    stream.once('drain', drain); stream.once('close', close); stream.once('error', error);
  });
}

/** principal 是已核验票据输出；projectId必须相同。每次调用 authority，不能用 TTL 缓存放宽撤销。 */
export async function authorizeAsset({ authority, principal, projectId, action, resource }) {
  if (!principal || principal.projectId !== projectId) throw assetAccessError('project-mismatch');
  if (typeof authority?.checkAccess !== 'function') throw assetAccessError('authority-unavailable', 503);
  let result;
  try { result = await authority.checkAccess({ principal, projectId, action, resource }); }
  catch (error) {
    if ([400, 401, 403, 404, 410].includes(error?.status)) throw error;
    throw assetAccessError('authority-unavailable', 503);
  }
  if (!result?.allowed) throw assetAccessError(result?.error ?? 'forbidden', result?.status ?? 403);
  return { ...result, principal, projectId, action, resource };
}

/**
 * openProjectStream({authority,principal,projectId,action,resource,close})
 * -> lease {signal,assert(),track(stream),release(),closed}
 * 注册在 recheck 之前，堵住 check -> open 的撤销缝；回调先同步 abort，再等待真实资源关闭，回调返回真实关闭完成；持久事件消费/ACK由注入的可信服务adapter处理，doc订阅本身不自动ACK。
 * authority.subscribeRevocations(context, async event=>...) 必须同步登记，返回 unsubscribe；服务启动 head 同步由 doc adapter 保证。
 */
export async function openProjectStream({ authority, principal, projectId, action = 'read', resource, close = () => {} }) {
  if (typeof authority?.subscribeRevocations !== 'function') throw assetAccessError('revocation-unavailable', 503);
  const context = { principal, projectId, action, resource, accountId: principal?.accountId, loginId: principal?.loginId, credentialId: principal?.credentialId };
  const relevant = event => {
    if (event?.projectId && event.projectId !== projectId) return false;
    if (event?.accountIds?.length && !event.accountIds.includes(principal?.accountId)) return false;
    if (event?.loginIds?.length && !event.loginIds.includes(principal?.loginId)) return false;
    if (event?.type && !['login-revoked', 'project-access-changed'].includes(event.type)) return false;
    return event?.reason !== 'unban';
  };
  return createAssetResourceLease({ context, check: () => authorizeAsset({ authority, ...context }),
    subscribe: callback => authority.subscribeRevocations(context, callback), relevant, close,
    fork: () => openProjectStream({ authority, ...context }) });
}

/** Generic actual-close ownership only; the supplied check remains the sole
 * authorization authority. Human leases keep synchronous abort by default.
 * Run leases may synchronously pause then independently recheck a committed
 * fence; they never await a consumer lock recursively inside that recheck. */
export async function createAssetResourceLease({ context = {}, check, subscribe, relevant = () => true,
  eventPolicy = 'abort', close = () => {}, fork, initialCheck = true } = {}) {
  if (typeof check !== 'function' || typeof subscribe !== 'function' || typeof relevant !== 'function' ||
      !['abort', 'recheck'].includes(eventPolicy)) throw assetAccessError('resource-lease-unconfigured', 503);
  const controller = new AbortController(), tracked = new Set();
  const flowing = new Set();
  let released = false, releasePromise, barrierError, closePromise = Promise.resolve(), paused = 0;
  let rechecks = Promise.resolve();
  const waitTracked = async () => { while (tracked.size) await Promise.all([...tracked].map(stream => new Promise(resolve => stream.once('close', resolve)))); };
  const abort = event => {
    if (controller.signal.aborted) return closePromise;
    if (!controller.signal.aborted) controller.abort(assetAccessError(event?.reason ?? 'access-revoked'));
    for (const stream of tracked) stream.destroy?.();
    closePromise = Promise.resolve().then(() => close(event)).then(waitTracked).then(() => { if (barrierError) throw barrierError; return { closed: true }; });
    return closePromise;
  };
  const revoke = event => {
    if (!relevant(event)) return;
    if (eventPolicy === 'abort' || event?.reason === 'revocation-unavailable') return abort(event);
    paused++; // Synchronous read/write barrier, before the first authority await.
    for (const stream of tracked) { if (stream.readableFlowing === true) flowing.add(stream); stream.pause?.(); }
    const pending = rechecks.catch(() => {}).then(async () => {
      try {
        const result = await check({ revalidating: true });
        if (result?.allowed !== true || controller.signal.aborted) throw assetAccessError('access-revoked');
        return { complete: true, retained: true, result };
      } catch { return { closing: abort(event) }; }
      finally {
        paused--;
        if (!paused && !controller.signal.aborted) { for (const stream of flowing) if (!stream.closed) stream.resume?.(); flowing.clear(); }
      }
    });
    // The decision gate must settle before waiting for tracked operations:
    // those operations may themselves be waiting in assert() at this gate.
    rechecks = pending; return pending.then(result => result.closing ?? result);
  };
  const unsubscribe = subscribe(revoke);
  const assert = async () => {
    if (released || controller.signal.aborted) throw assetAccessError('access-revoked');
    while (paused) await rechecks;
    if (released || controller.signal.aborted) throw assetAccessError('access-revoked');
    await check();
    while (paused) await rechecks;
    if (released || controller.signal.aborted) throw assetAccessError('access-revoked');
  };
  try { if (initialCheck) await assert(); } catch (error) { released = true; unsubscribe?.(); throw error; }
  return {
    ...context, signal: controller.signal, assert, revoke,
    failClose(error) { barrierError = error; },
    check, fork,
    track(stream) { if (!stream.closed) { tracked.add(stream); stream.once?.('close', () => tracked.delete(stream)); } if (controller.signal.aborted || released) { stream.destroy?.(); throw assetAccessError('access-revoked'); } return stream; },
    trackProcess(child) { let closed = false; child.once('close', () => { closed = true; }); this.track({ destroy: () => child.kill('SIGTERM'), once: child.once.bind(child), get closed() { return closed; } }); return child; },
    trackHandle(handle) {
      let closed = false; handle.once('close', () => { closed = true; });
      this.track({ destroy: () => { void handle.close().catch(() => {}); }, once: handle.once.bind(handle), get closed() { return closed; } });
      return handle;
    },
    hold() {
      const resource = new EventEmitter(); resource.closed = false; resource.destroy = () => {};
      try { this.track(resource); } catch (error) { resource.closed = true; resource.emit('close'); throw error; }
      return () => { if (!resource.closed) { resource.closed = true; resource.emit('close'); } };
    },
    run(task) { const finish = this.hold(); return Promise.resolve().then(task).finally(finish); },
    release() {
      if (!releasePromise) {
        released = true; // HTTP已结束：拒新动作，但仍拥有未actualclose的资源，继续接撤销。
        releasePromise = waitTracked().then(() => { if (!barrierError) unsubscribe?.(); });
      }
      return releasePromise;
    },
    get closed() { return Promise.all([closePromise, releasePromise ?? Promise.resolve()]); },
  };
}

/** 接线工厂；resolvePrincipal(req)由中央票据/账号模块提供，不接受调用者自报projectId。 */
export function createProjectAssetAccess({ authority, resolvePrincipal }) {
  if (typeof resolvePrincipal !== 'function') throw new TypeError('resolvePrincipal required');
  return {
    authority,
    async resolve(req, { action = 'read', resource, close } = {}) {
      const principal = await resolvePrincipal(req);
      if (!principal?.projectId) throw assetAccessError('unauthorized', 401);
      return openProjectStream({ authority, principal, projectId: principal.projectId, action, resource, close });
    },
  };
}

/** 同一项目每次请求的 BlobStore facade；底层 fs 在登记/收尾发布点再次核权。 */
export function authorizedAssetStore(store, lease) {
  if (!lease) return store;
  if (store.projectId !== lease.projectId) throw assetAccessError('project-mismatch');
  const guard = { beforeCommit: lease.assert, signal: lease.signal, track: stream => lease.track(stream) };
  return new Proxy(store, { get(target, key) {
    if (key === 'putChunk') return (hash, n, info, source) => lease.run(async () => { await lease.assert(); if (source?.destroy) lease.track(source); const value = await target.putChunk(hash, n, { ...info, ...guard }, source); await lease.assert(); return value; });
    if (key === 'complete') return hash => lease.run(async () => { await lease.assert(); return target.complete(hash, guard); });
    if (key === 'read') return (...args) => lease.run(async () => { await lease.assert(); const stream = await target.read(...args); if (stream) lease.track(stream); return stream; });
    if (['stat', 'chunks', 'list', 'usage', 'inventory'].includes(key)) return (...args) => lease.run(async () => { await lease.assert(); const value = await target[key](...args); await lease.assert(); return value; });
    return Reflect.get(target, key);
  } });
}
