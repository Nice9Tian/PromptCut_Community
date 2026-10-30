/**
 * M8 探针连文档服务的角色（计划 `docs/plan/m8-plan.md` 第 2 节开头、第 4 节第 1 项）：
 *
 *   openConn({ url, projectId, username, password, as, role, tag })   以某个身份连上项目（会话层 `createDocEndpoint`）
 *   createProbeProject({ where, ws, lanBase, name })                  建探针用的自由进入共享项目（随机口令，只回给调用方）
 *   deleteProbeProject({ ws, projectId, creatorPassword })            经创建者操作 `delete` 删掉它
 *   startWatcher({ url, entry, projects, nodeId, fingerprint })       旁观节点：node.hello + queue.watch，只收不认领，记时间线
 *   startFakeNode({ url, entry, nodeId, fingerprint, taskMs, … })     假节点（`render-queue-e2e.mjs` 的写法）：睡 taskMs 就完成
 *   startFakePublisher({ url, entry, publisherId, tasks })            假发布方：发布、按 epoch 数 task.done、epoch 变了重发未完成的
 *   sharedEntry({ … })                                                一条共享项目配置（写文件给编辑器 / 主机用，或直接给上面几个）
 *
 * 旁观节点不带指纹时看得见全部任务（队列的指纹前置过滤对没带指纹的节点不生效，`server/render-queue/queue.mjs` envAllows）；
 * 带了指纹只看得见同指纹的。它的时间线（本机时钟）交给 `lib.mjs` 的 `summarizeTimeline`、`takeoverMs`。
 * 注意：队列对 `task.opened` / `task.taken` / `task.closed` 带合并键，慢连接上同一任务积压的变化只留最新一条（契约 G 节），
 * 所以时间线只作「至多」的证据（认领至多一次、没有被放回），不作「恰好」的证据；恰好一次以发布方数的 task.done 为准。
 *
 * 口令只在内存与调用方给的配置文件里，不进日志。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { deviceIdOf } from './lib.mjs';

let modsP = null;
/** 按需载入被测模块（参数不对时只打用法，不因模块缺失而崩） */
export function mods() {
  modsP ??= Promise.all([
    import('../../../server/auth/route.mjs'), import('../../../server/auth/client.mjs'), import('../../../server/auth/shared-config.mjs'),
    import('../../../server/render-node/session-link.mjs'), import('../../../server/render-node/local-node.mjs'),
    import('../../../server/test/fake-artifact-sink.mjs'), import('../../../server/test/fake-ws-kit.mjs'),
  ]).then(([route, client, shared, link, local, sink, kit]) => ({
    ...client, ...shared, ...link, wsBaseOf: route.wsBaseOf, createSharedProject: route.createSharedProject,
    createLocalNode: local.createLocalNode, createArtifactSink: sink.createArtifactSink, createSleepExecutor: kit.createSleepExecutor,
  }));
  return modsP;
}

/**
 * 一条共享项目配置（M6a 契约第 11 节的形状）。`file` 给了就写成文件（编辑器 / 主机的 `PROMPTCUT_SHARED_CONFIG`、`--config`）。
 * @returns {object} 配置项（含口令，调用方别打印）
 */
export function sharedEntry({ url, projectId, username, password, as = 'member', role = 'render', run, tag, file = null, deviceName = null }) {
  const entry = { url, projectId, username, deviceId: deviceIdOf(tag, run), deviceName: deviceName ?? `m8 ${tag} (probe)`, as, role, password };
  if (file) fs.writeFileSync(file, JSON.stringify([entry], null, 2));
  return entry;
}

/** 请求 / 回包按 reqId 配对 */
function rpcOn(ep, tag) {
  const waiting = new Map();
  let seq = 0;
  ep.onMessage((m) => {
    const w = m?.reqId !== undefined ? waiting.get(m.reqId) : undefined;
    if (!w) return;
    waiting.delete(m.reqId);
    clearTimeout(w.timer);
    w.resolve(m);
  });
  return (message, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const reqId = `m8-${tag}-${++seq}-${randomBytes(3).toString('hex')}`;
    const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error(`等 ${message.type} 的回包超时`)); }, timeoutMs);
    waiting.set(reqId, { resolve, timer });
    if (!ep.send({ ...message, reqId })) { waiting.delete(reqId); clearTimeout(timer); reject(new Error(`${message.type} 没发出去`)); }
  });
}

/**
 * 以某个身份连上项目（会话层，断了按会话接续）。
 * @param {{ entry: object, role?: string, tag: string, openTimeoutMs?: number, log?: Function }} o `entry` 是 sharedEntry 的返回值
 * @returns {Promise<{ ep, rpc, close: () => Promise<void> } | null>} 建不成会话回 null
 */
export async function openConn({ entry, role = entry.role, tag, openTimeoutMs = 20_000, log = () => {} }) {
  const M = await mods();
  const norm = M.normalizeEntry(entry);
  const ep = M.createDocEndpoint({ url: norm.url, protocols: M.sharedProtocols(norm, { role }), log: (event, fields) => log(`${tag}.${event}`, fields) });
  const rpc = rpcOn(ep, tag);
  const opened = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), openTimeoutMs);
    ep.onOpen(() => { clearTimeout(t); resolve(true); });
  });
  if (!opened) { try { ep.close(); } catch { /* 已关 */ } return null; }
  return { ep, rpc, close: () => closeEp(ep) };
}

/** 关一条连接：连着的等到 onClose（最多 3 s）。关闭握手没完成就退出进程，Windows 上 libuv 会断言崩掉 */
export function closeEp(ep) {
  return new Promise((resolve) => {
    if (!ep.connected) { try { ep.close(); } catch { /* 已关 */ } return resolve(); }
    const t = setTimeout(resolve, 3000);
    ep.onClose(() => { clearTimeout(t); resolve(); });
    try { ep.close(); } catch { clearTimeout(t); resolve(); }
  });
}

/**
 * 建探针用的自由进入共享项目。
 * @param {{ where: 'hosted' | 'lan', ws?: string, lanBase?: string, name: string }} o 放云端 / 本机替身给 `ws`（文档服务 ws 基址）；放本机给 `lanBase`
 * @returns {Promise<{ projectId, name, creatorPassword, projectPassword, base }>} 口令只回给调用方
 */
export async function createProbeProject({ where, ws, lanBase, name }) {
  const M = await mods();
  const creatorPassword = randomBytes(12).toString('base64url');
  const projectPassword = randomBytes(12).toString('base64url');
  const r = await M.createSharedProject({
    where, ...(where === 'hosted' ? { hostedUrl: ws } : { lanBase }), name, mode: 'free',
    creator: { username: 'creator', password: creatorPassword }, password: projectPassword,
  });
  return { projectId: r.projectId, name: r.name, base: r.base, creatorPassword, projectPassword };
}

/** 经创建者操作 `delete` 删掉项目；回 { deleted, error? } */
export async function deleteProbeProject({ ws, projectId, creatorPassword, run }) {
  const M = await mods();
  let conn = null;
  try {
    conn = await openConn({ entry: sharedEntry({ url: ws, projectId, username: 'creator', password: creatorPassword, as: 'creator', role: 'page', run, tag: 'creator-del' }), tag: 'creator-del' });
    if (!conn) throw new Error('连不上项目');
    const ch = await conn.rpc({ type: 'shared.challenge' });
    if (ch.type !== 'shared.challenge.ok') throw new Error(`challenge ${ch.reason ?? ch.type}`);
    const key = await M.deriveKey(creatorPassword, ch.salt, ch.kdf);
    const m = await M.adminProof({ key, projectId, username: 'creator', op: 'delete', nonce: ch.nonce });
    const r = await conn.rpc({ type: 'shared.admin', op: 'delete', proof: { nonce: ch.nonce, m } });
    return r.type === 'shared.admin.ok' ? { deleted: true } : { deleted: false, error: r.reason ?? r.type };
  } catch (error) {
    return { deleted: false, error: String(error?.message ?? error).slice(0, 200) };
  } finally {
    await conn?.close();
  }
}

/**
 * 旁观节点：以 `role: 'render'` 连项目，`node.hello`（profile pc）后 `queue.watch` 给定项目，只收不认领。
 * @param {{ entry: object, projects: string[], nodeId: string, fingerprint?: string | null, codeVersions?: string[], log?: Function }} o
 * @returns 句柄：`timeline`（Map：任务 id → [{ t, ev, version?, state? }]）、`events(id)`、`ids()`、`epochs`、`close()`
 */
export async function startWatcher({ entry, projects, nodeId, fingerprint = null, codeVersions = [], log = () => {} }) {
  const conn = await openConn({ entry, role: 'render', tag: 'watcher', log });
  if (!conn) throw new Error('旁观节点连不上项目');
  const timeline = new Map();
  const epochs = [];
  const push = (id, ev) => { if (!timeline.has(id)) timeline.set(id, []); timeline.get(id).push({ t: Date.now(), ...ev }); };
  conn.ep.onMessage((m) => {
    if (typeof m?.epoch === 'string' && !epochs.includes(m.epoch)) epochs.push(m.epoch);
    if (m?.type === 'task.taken' && typeof m.id === 'string') push(m.id, { ev: 'taken', version: m.version ?? null });
    else if (m?.type === 'task.opened' && typeof m.task?.id === 'string') push(m.task.id, { ev: 'opened', version: m.task.version ?? null });
    else if (m?.type === 'task.closed' && typeof m.id === 'string') push(m.id, { ev: 'closed', state: m.state ?? null });
    else if (m?.type === 'queue.snapshot') for (const t of m.tasks ?? []) if (t?.id) push(t.id, { ev: 'opened', version: t.version ?? null, snapshot: true });
  });
  const hello = async () => {
    const h = await conn.rpc({ type: 'node.hello', nodeId, profile: 'pc', ...(fingerprint ? { envFingerprint: fingerprint } : {}), codeVersions, capabilities: {}, maxConcurrent: 1 });
    const w = await conn.rpc({ type: 'queue.watch', projects });
    if (w.type !== 'queue.snapshot') throw new Error(`queue.watch 回 ${w.type} ${w.reason ?? ''}`);
    return { hello: h.type, watch: w.type };
  };
  const first = await hello();
  // 会话结束后重建（新会话）：重新报到、重新订阅；接续（同一会话）不用
  conn.ep.onOpen(() => { hello().catch((e) => log('watcher.rehello-failed', { message: String(e?.message ?? e) })); });
  return {
    timeline, epochs, first,
    events: (id) => timeline.get(id) ?? [],
    ids: () => [...timeline.keys()],
    stats: () => conn.ep.stats(),
    close: () => conn.close(),
  };
}

/**
 * 假节点：`createLocalNode` + 睡 taskMs 的执行器 + 内存产物库（`server/test/` 的假件，探针不是生产代码）。
 * @param {{ entry: object, nodeId: string, fingerprint?: string | null, profile?: string, taskMs?: number, maxConcurrent?: number, projects: string[], log?: Function, onMessage?: (m: object) => void, takeoverLocked?: boolean }} o
 *   `onMessage` 收这条连接上的每条业务消息（I1-X 数「收到别的项目的消息」用）；`takeoverLocked` 透传给 createLocalNode（K1 对照组）
 * @returns 句柄：`claimed`、`completed`（id 列表）、`lost`、`failed`、`stats()`、`stop()`
 */
export async function startFakeNode({ entry, nodeId, fingerprint = null, profile = 'host', taskMs = 200, maxConcurrent = 2, projects, log = () => {}, onMessage = null, takeoverLocked = false }) {
  const M = await mods();
  const norm = M.normalizeEntry(entry);
  const ep = M.createDocEndpoint({ url: norm.url, protocols: M.sharedProtocols(norm, { role: 'render' }), log: (event, fields) => log(`node.${event}`, fields) });
  const rec = { claimed: [], rejected: [], completed: [], dedup: [], lost: [], failed: [], opens: 0 };
  const node = M.createLocalNode({
    nodeId, node: { profile, ...(fingerprint ? { envFingerprint: fingerprint } : {}), codeVersions: [], capabilities: {} },
    endpoint: ep, now: Date.now, maxConcurrent, projects, takeoverLocked,
    executor: M.createSleepExecutor({ taskMs }), sink: M.createArtifactSink(),
    onEvent: (e) => {
      if (e.type === 'completed') rec.completed.push(e.id);
      else if (e.type === 'dedup') rec.dedup.push(e.id);
      else if (e.type === 'lost') rec.lost.push({ id: e.id, reason: e.reason ?? null, at: Date.now() });
      else if (e.type === 'failed') rec.failed.push({ id: e.id, error: String(e.error ?? '').slice(0, 200) });
    },
  });
  ep.onOpen(() => { rec.opens += 1; node.start(node.session.held().map(({ id, token }) => ({ id, token }))); });
  ep.onMessage((m) => {
    if (m?.type === 'task.claimed' && typeof m.id === 'string') rec.claimed.push(m.id);
    else if (m?.type === 'task.claim-rejected') rec.rejected.push({ id: m.id ?? null, reason: m.reason ?? null });
    if (onMessage) { try { onMessage(m); } catch { /* 调用方的计数出错不影响节点 */ } }
  });
  const timer = setInterval(() => { try { node.tick(); } catch (err) { log('node.tick-error', { message: String(err?.message ?? err) }); } }, 50);
  return {
    rec, claimed: rec.claimed, completed: rec.completed, dedup: rec.dedup, lost: rec.lost, failed: rec.failed, nodeId, fingerprint,
    held: () => node.session.held().map((h) => h.id),
    stats: () => ({ ...ep.stats(), claimed: rec.claimed.length, rejected: rec.rejected.length, completed: rec.completed.length, dedup: rec.dedup.length, lost: rec.lost.length, failed: rec.failed.length }),
    async stop() { clearInterval(timer); try { node.stop?.(); } catch { /* 已停 */ } await closeEp(ep); },
  };
}

/**
 * 假发布方：`publisher.hello` 后发布 tasks；数 task.done（按到达顺序记 { id, epoch, at }，重复的也记）；
 * 看到 epoch 变了、或会话重建，就把没完成的重新发布（发布是幂等的）。
 * @returns 句柄：`doneEvents`、`states`（id → 最终状态）、`whenAllDone(ms)`、`publishedAt`、`close()`
 */
export async function startFakePublisher({ entry, publisherId, tasks, log = () => {} }) {
  const M = await mods();
  const norm = M.normalizeEntry(entry);
  const ep = M.createDocEndpoint({ url: norm.url, protocols: M.sharedProtocols(norm, { role: 'page' }), log: (event, fields) => log(`publisher.${event}`, fields) });
  const ids = new Set(tasks.map((t) => t.id));
  const doneEvents = [];
  const states = new Map();
  const errors = [];
  let lastEpoch = null;
  let seq = 0;
  let publishedAt = null;
  let resolveAll;
  const allDone = new Promise((r) => { resolveAll = r; });
  const publishPending = (why) => {
    const pending = tasks.filter((t) => states.get(t.id) !== 'done');
    if (!pending.length) return;
    publishedAt ??= Date.now();
    ep.send({ type: 'task.publish', reqId: `pub-${++seq}`, tasks: pending });
    log('publisher.publish', { why, count: pending.length });
  };
  ep.onOpen(() => { ep.send({ type: 'publisher.hello', reqId: `hello-${++seq}`, publisherId }); publishPending('open'); });
  ep.onMessage((m) => {
    if (typeof m?.epoch === 'string' && m.epoch !== lastEpoch) {
      const changed = lastEpoch !== null;
      lastEpoch = m.epoch;
      if (changed) publishPending('epoch');
    }
    if (m?.type === 'task.published') for (const r of m.results ?? []) { if (r.error) errors.push(`publish ${r.id}: ${r.error}`); }
    else if (m?.type === 'task.done' && ids.has(m.id)) {
      doneEvents.push({ id: m.id, epoch: m.epoch ?? lastEpoch, at: Date.now() });
      states.set(m.id, 'done');
      if ([...ids].every((id) => states.get(id) === 'done')) resolveAll(true);
    } else if (m?.type === 'task.failed' && ids.has(m.id)) { states.set(m.id, 'failed'); errors.push(`task.failed ${m.id}: ${m.error}`); }
    else if (m?.type === 'error') errors.push(`error ${m.reason}: ${m.detail ?? ''}`);
  });
  return {
    doneEvents, states, errors,
    get publishedAt() { return publishedAt; },
    get epoch() { return lastEpoch; },
    /** 等全部完成；超时回 false。完成后再等 graceMs 收迟到的重复 done */
    async whenAllDone(ms, graceMs = 1500) {
      const ok = await Promise.race([allDone, new Promise((r) => setTimeout(() => r(false), ms))]);
      if (ok) await new Promise((r) => setTimeout(r, graceMs));
      return ok;
    },
    stats: () => ep.stats(),
    close: () => closeEp(ep),
  };
}
