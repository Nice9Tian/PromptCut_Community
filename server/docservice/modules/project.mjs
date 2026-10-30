/**
 * 项目模块：C6.5 的项目真身（设计稿 `docs/plan/c65-design.md` 第 2、3 节），以及保留兼容的
 * C6.3 项目版本（`docs/plan/docservice-contract.md` 第 1 节）与 M5b 项目快照（`docs/plan/render-queue-contract.md` J.1）。
 *
 * **项目真身**（C6.5）：文档服务持有每个项目的当前内容，各方手里的都是副本（语义
 * `docs/semantics/product/document-service.md`「职责」）。
 * - `project.open`：回 `project.state`（当前内容、版本号、最近写入者），并订阅 `project:<projectId>` 频道；
 *   内容大时先回不带内容的 `project.state`，再按积压节流分片发 `project.state.part`，最后 `project.state.end`。
 * - `project.op`：一批路径操作（`../json-ops.mjs`），整批原子生效、版本号加一，回 `project.op.ok`；
 *   频道上给除提交者以外的订阅者广播 `project.ops`。拒绝时回 `project.op.rejected`，理由是
 *   `stale`（带了 `expectRev` 而版本不符，附 `since`）、`bad-path`、`too-large`（ops 序列化后超过 256 KiB）、`forbidden`。
 * - 同一 `opId` 已落地过：直接回当初的 `rev`（带 `duplicate: true`），不再应用、不再广播；这一步先于 `expectRev` 检查。
 * - 覆盖通知：按「实体」（`json-ops.mjs` 的 `entitiesOf`，名字口径见 `PROJECT_ENTITY_NAMES`）记最近写入者；
 *   一次提交写到的实体，若最近写入者是另一个写入身份、且在 10 分钟内，覆盖方的 `ok` 带 `overwrote`，
 *   被覆盖方（它此刻在线的、以那个身份提交过的连接）先于 `project.ops` 单独收 `project.overwritten`。
 * - `project.follow { entity, on: false }`：这个写入身份对这个实体退出跟踪，之后别人覆盖它时不再收 `project.overwritten`。
 * - 写入身份 `actor` 取连接的 principal 加消息里的 `session`（`actor.mjs`），消息里自报的其它身份一律不认。
 * - 存储：每个项目一份快照（`writeBlob`，`projects/<编码>.state-<散列>.json`）加一条操作日志
 *   （stream `projects/<projectId>.ops`，每行一次提交）。每 200 次提交落一次快照，日志随之截断到快照之后
 *   （存储有 `rewrite` 时）；第一次用到某个项目时读快照再回放日志。
 * - 大的根替换：`project.upload` 分片传一个整份项目，`project.op` 里写 `{ op: 'set', path: '', upload: <uploadId> }`
 *   引用它；这样的提交广播时太大，广播成不带 `ops` 的 `project.ops { resync: true }`，订阅者重新 `project.open`。
 *
 * **与旧消息的关系**：版本号只有一个。项目还没有真身（从没收到过 `project.op`）时，`project.announce` 照 C6.3
 * 发号、记版本日志、广播 `project.rev`；一旦有了真身，**摘要以真身为准**：`announce` 不再发号，回当前版本号与
 * 真身的摘要（`sha256(JSON.stringify(真身))`，`changed: false`、`authoritative: true`、`matches` 表示报上来的摘要
 * 是否与真身相同）。M5b 快照照旧按版本登记的摘要校验；当前版本的摘要就是真身的摘要，所以当前版本的快照也能
 * 由真身直接发回（存储里没有那个文件时）。
 *
 * 快照（J.1）的其余细节不变：
 * - 上传的分片按 `(projectId, projectRev)` 汇在一起，可以乱序、可以重传、可以来自不同连接；
 *   摘要不符时已收的分片全部丢弃。未收齐的上传放在内存里，闲置太久或太多时丢掉最旧的（见 `SNAPSHOT_LIMITS`）。
 * - 取回时先核对文件内容的 sha256 等于这一版登记的摘要：Windows 文件名不分大小写，只差大小写的两个项目
 *   同一版会落进同一个文件，对不上就当没有（回 `missing`），不会把别的项目的内容发出去。
 * - 发回的分片按积压节流：核心的出站队列加底层积压超过上限（缺省 1 MiB）就以 1013 断开（H.2），整份一次发完会被断开。
 *   每发一片之前等这条连接的积压（`ctx.pendingBytes`）降到上限（`ctx.maxPendingBytes`）的一半以下（J.11）。
 *   同一条连接上的多次取回排队依次发，连接断开就停。`project.state` 的分片走同一条队列。
 */
import { createHash } from 'node:crypto';
import { createMemoryStore, fileNameOf } from '../store/index.mjs';
import { actorOf } from './actor.mjs';
import { applyOps, entitiesOf, normalizeEntity, parsePath, formatPath, idSegment, OpError } from '../json-ops.mjs';
import { canonical, digest as historyDigest, historyError } from './operation-history.mjs';
export const ROLLBACK_OP_PREFIX = 'logout-rollback:';
let customRollbackPolicy = null;
export function registerProjectRollbackPolicy(policy) {
  customRollbackPolicy = policy && typeof policy === 'object' ? policy : null;
}
export const isReservedOpId = opId =>
  customRollbackPolicy?.isReservedOpId
    ? customRollbackPolicy.isReservedOpId(opId)
    : typeof opId === 'string' && opId.startsWith(ROLLBACK_OP_PREFIX);
export const rollbackOpId = (eventId, attempt) =>
  customRollbackPolicy?.rollbackOpId
    ? customRollbackPolicy.rollbackOpId(eventId, attempt)
    : `${ROLLBACK_OP_PREFIX}${eventId}:${attempt}`;

/** 账号项目的一次提交从收到到回包超过这么久,记一行 `project.op.slow`(诊断;三级数字) */
export const SLOW_OP_MS = 5_000;

export const PROJECT_MODULE = 'project';

const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DIGEST_RE = /^[0-9a-f]{16,128}$/;
const TOKEN_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

/** 快照的上限（J.1）：每片 ≤ 512 KiB（UTF-8 字节）、最多 64 片；未收齐的上传最多留这么多份、闲置这么久 */
export const SNAPSHOT_LIMITS = Object.freeze({
  PART_BYTES: 512 * 1024,
  MAX_PARTS: 64,
  /** 发回时每片的上限（按 JSON 转义后的字节数），比上传的小，便于按节奏发 */
  OUT_PART_BYTES: 256 * 1024,
  MAX_PENDING_UPLOADS: 32,
  PENDING_IDLE_MS: 10 * 60_000,
});

/** 发回快照的节流（J.11）：积压没降到上限的一半以下时，隔 `pollMs` 再查 */
export const SNAPSHOT_PACE = Object.freeze({ pollMs: 20 });

/** 项目真身的上限与口径（C6.5 第 3 节） */
export const PROJECT_LIMITS = Object.freeze({
  /** 一次提交的 `ops` 序列化后的上限（UTF-8 字节） */
  MAX_OPS_BYTES: 256 * 1024,
  /** 每多少次提交落一次快照、截断日志 */
  SNAPSHOT_EVERY: 200,
  /** 覆盖通知的时间窗 */
  OVERWRITE_WINDOW_MS: 10 * 60_000,
  /** 为 `stale.since` 留的提交摘要条数 */
  HISTORY: 1000,
  /** 一次 `stale` 回包里 `since` 最多列多少次提交（多了只列最近的，`sinceComplete: false`） */
  SINCE_MAX: 200,
  /** 每条提交摘要最多列多少个路径 */
  PATHS_PER_COMMIT: 256,
  /** 幂等用：记住最近多少个 `opId` */
  OP_IDS: 5000,
  /** `project.state.writers` 最多列多少个实体 */
  WRITERS_IN_STATE: 200,
  /** 内容序列化后不超过这么多字节时，`project.state` 直接带内容；`project.ops` 超过它就改成 `resync` */
  INLINE_BYTES: 256 * 1024,
  /** 大的根替换：每片上限、最多片数、未用的上传最多留几份 */
  UPLOAD_PART_BYTES: 512 * 1024,
  UPLOAD_MAX_PARTS: 64,
  UPLOAD_MAX_PENDING: 8,
});

/**
 * 实体口径（`c65-ops-spec.md` 第 4 节）：从根开始成对的 `/<名>/@<id>`，第一对之后的名字只能是这几个。
 * 这是本模块唯一认识的项目结构，只用来划覆盖通知的粒度；可由组装层经 `entityNames` 换掉。
 */
export const PROJECT_ENTITY_NAMES = Object.freeze(['tracks', 'clips', 'transitions']);

/** 核心没给 `ctx.maxPendingBytes` 时按这个上限算（与核心的缺省值相同，H.2） */
const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;

const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class BadMessage extends Error {}
function bad(detail) { throw new BadMessage(detail); }

/** 业务错误：回 `error { reason }`，不算 bad-message */
class Refused extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}

function checkProjectId(v) {
  if (typeof v !== 'string' || !PROJECT_ID_RE.test(v)) bad('projectId 不合法');
  return v;
}

function checkDigest(v) {
  if (typeof v !== 'string' || !DIGEST_RE.test(v)) bad('digest 必须是 16～128 位小写十六进制');
  return v;
}

function checkRev(v) {
  if (!Number.isSafeInteger(v) || v < 1) bad('projectRev 必须是正整数');
  return v;
}

/** `session` 可选：没给（或 null）记为 null；给了就得是 1～128 个字符的字符串 */
function checkSession(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length < 1 || v.length > 128) bad('session 必须是 1～128 个字符的字符串');
  return v;
}

/** `opId`、`undoOf`、`uploadId`：1～128 个字符的字符串（不限字符集，客户端自己保证全局唯一） */
function checkToken(v, name) {
  if (typeof v !== 'string' || v.length < 1 || v.length > 128) bad(`${name} 必须是 1～128 个字符的字符串`);
  return v;
}

const streamOf = (projectId) => `projects/${projectId}`;
const opsStreamOf = (projectId) => `projects/${projectId}.ops`;
const channelOf = (projectId) => `project:${projectId}`;
/** 快照文件名（J.1）：projectId 按 C6.3 第 10 节第 10 条编码，`@<projectRev>.json` 原样 */
export const snapshotBlobName = (projectId, projectRev) => `projects/${fileNameOf(projectId)}@${projectRev}.json`;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 发给页面的写入身份与操作号里不带改密退出撤回的事件号（安全专审 Q5 / SEC-01：事件号是占号的凭据）。存储里照旧是全的。 */
const shownActor = (actor) => {
  if (!actor || typeof actor !== 'object' || actor.rollbackEventId === undefined) return actor;
  const { rollbackEventId: _event, ...rest } = actor;
  return { ...rest, rollback: true };
};
const shownOpId = (opId) => (isReservedOpId(opId) ? `${ROLLBACK_OP_PREFIX}${sha256(opId).slice(0, 24)}` : opId);

/**
 * 真身快照的文件名：编码后的 projectId 加它的散列前缀。Windows 文件名不分大小写，只差大小写的两个项目
 * 编码后会撞上，加上按原样算的散列就不会（M5b 快照靠读回时核对摘要，这里靠文件名）。
 */
export const stateBlobName = (projectId) => `projects/${fileNameOf(projectId)}.state-${sha256(projectId).slice(0, 16)}.json`;

/** 一个 UTF-16 码元在 JSON 字符串里转义后的 UTF-8 字节数；代理对整体算 4 */
function escapedWidth(text, i) {
  const c = text.charCodeAt(i);
  if (c === 0x22 || c === 0x5c) return [2, 1];
  if (c < 0x20) return [c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6, 1];
  if (c < 0x80) return [1, 1];
  if (c < 0x800) return [2, 1];
  if (c >= 0xd800 && c <= 0xdbff) {
    const d = text.charCodeAt(i + 1);
    return d >= 0xdc00 && d <= 0xdfff ? [4, 2] : [6, 1];
  }
  if (c >= 0xdc00 && c <= 0xdfff) return [6, 1];
  return [3, 1];
}

/** 按「JSON 转义后的 UTF-8 字节数 ≤ limit」切文本，不拆代理对；空文本也回一片 */
export function splitSnapshotText(text, limit) {
  const parts = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < text.length;) {
    const [w, step] = escapedWidth(text, i);
    if (bytes + w > limit && i > start) {
      parts.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += w;
    i += step;
  }
  if (start < text.length || parts.length === 0) parts.push(text.slice(start));
  return parts;
}

/** 写入身份的比较键：用户 + 设备 + 角色 + 对话 + 会话（语义「哪个用户的哪个页面，或哪个 Agent 的哪个对话」） */
export function identityOf(actor) {
  return JSON.stringify([actor?.userId ?? null, actor?.deviceId ?? null, actor?.role ?? null, actor?.conversation ?? null, actor?.session ?? null]);
}

/** 一批操作各自写到的位置（`insert` 是新元素的路径），规范写法、去重、保序；格式不对的操作跳过 */
function targetsOf(ops) {
  const out = new Set();
  for (const op of Array.isArray(ops) ? ops : []) {
    const segs = parsePath(op?.path);
    if (segs === null) continue;
    const path = formatPath(segs);
    out.add(op.op === 'insert' && isObj(op.value) && typeof op.value.id === 'string' ? `${path}/${idSegment(op.value.id)}` : path);
  }
  return [...out];
}

function capPaths(paths) {
  return paths.length > PROJECT_LIMITS.PATHS_PER_COMMIT ? paths.slice(0, PROJECT_LIMITS.PATHS_PER_COMMIT) : paths;
}

/**
 * @param {object} [options]
 * @param {{ append(stream: string, record: object): void, read(stream: string): object[],
 *   writeBlob?(name: string, text: string): void, readBlob?(name: string): string | null,
 *   rewrite?(stream: string, records: object[]): void }} [options.store]
 *   日志与快照存储（`../store/index.mjs`）；缺省用内存存储，不跨重启。没有 `writeBlob` / `readBlob` 的存储
 *   不支持快照（M5b 快照消息回 `unsupported`，真身只靠日志回放）；没有 `rewrite` 的不截断日志
 * @param {() => number} [options.now] 缺省用 `ctx.now()`
 * @param {number} [options.pollMs] 积压没降下来时隔多久再查，缺省 `SNAPSHOT_PACE.pollMs`（20 ms）
 * @param {number} [options.snapshotEvery] 每多少次提交落一次真身快照，缺省 200
 * @param {number} [options.maxOpsBytes] 一次提交的上限，缺省 256 KiB
 * @param {number} [options.overwriteWindowMs] 覆盖通知的时间窗，缺省 10 分钟
 * @param {string[] | null} [options.entityNames] 实体口径，缺省 `PROJECT_ENTITY_NAMES`
 */
export function projectModule({
  store = createMemoryStore(),
  now,
  pollMs = SNAPSHOT_PACE.pollMs,
  snapshotEvery = PROJECT_LIMITS.SNAPSHOT_EVERY,
  maxOpsBytes = PROJECT_LIMITS.MAX_OPS_BYTES,
  overwriteWindowMs = PROJECT_LIMITS.OVERWRITE_WINDOW_MS,
  entityNames = PROJECT_ENTITY_NAMES,
  operationCoordinator,
} = {}) {
  const entityOpts = { names: entityNames === null ? null : [...entityNames] };
  /**
   * projectId → 项目状态；第一次用到时从日志与快照恢复：
   * { projectRev, digest, at,                 C6.3：版本号（与真身共用）、最近一次 announce 的摘要、最近一次写入的时间
   *   hasBody, body, bodyDigest,              C6.5：有没有真身（收到过 project.op）、当前内容、{ rev, digest } 缓存
   *   writers: Map<entity, { actor, identity, at, rev }>, history: 提交摘要[], opIds: Map<opId, rev>, sinceSnapshot }
   */
  const projects = new Map();
  /** projectId → Map<rev, digest>：每一版登记的摘要，快照按它校验 */
  const revDigests = new Map();
  /** connId → principal */
  const principals = new Map();
  /** `${projectId}@${rev}` → { projectId, projectRev, digest, count, parts: Map<index, data>, bytes, touched } */
  const uploads = new Map();
  /** `${projectId}|${uploadId}` → { count, parts: Map, touched, value? }：大的根替换 */
  const bodyUploads = new Map();
  /** connId → { chain: Promise, alive: boolean }：分片发送队列（快照取回与 project.state 共用） */
  const senders = new Map();
  /** 写入身份 → 以它提交过的在线连接；connId → 它用过的写入身份 */
  const identityConns = new Map();
  const connIdentities = new Map();
  /** projectId → Map<identity, Set<entity>>：退出跟踪的 */
  const unfollowed = new Map();
  const stats = {
    snapshotsStored: 0, snapshotsServed: 0, digestMismatches: 0, uploadsEvicted: 0,
    commits: 0, rejected: 0, duplicates: 0, stateSnapshots: 0, overwrites: 0,
  };
  /** 最近一次拿到的上下文：事件模块借项目频道广播时用（`publishToProject`） */
  let lastCtx = null;

  const clock = (ctx) => (typeof now === 'function' ? now() : ctx.now());

  const snapshotOf = (projectId, st) => ({ v: 1, projectId, rev: st.projectRev, at: st.at, project: st.body,
    writers: [...st.writers].map(([entity, w]) => [entity, { actor: w.actor, at: w.at, rev: w.rev }]),
    history: st.history, opIds: [...st.opIds] });
  operationCoordinator?.bind({
    fenceRequested(fence, assertUnfenced) {
      for (const [connId, principal] of principals) {
        if (principal.projectId !== fence.projectId) continue;
        try { assertUnfenced({ projectId: fence.projectId, actor: principal }); }
        catch {
          lastCtx?.unsubscribe(connId, channelOf(fence.projectId));
          const sender = senders.get(connId); if (sender) sender.alive = false;
          lastCtx?.close(connId, 1008, 'operation-fenced');
        }
      }
    },
    read(projectId) {
      const st = stateOf(projectId);
      const raw = store.readBlob?.(stateBlobName(projectId));
      return { projectRev: st.projectRev, value: st.body, orderProjection: raw ? JSON.parse(raw).orderProjection : null };
    },
    /**
     * 改密退出撤回一个项目（`server/account/logout-rollback.mjs` 经 `doc-assembly.mjs` 叫进来）。在项目锁里按当时的内容算撤回
     * （`plan(内容)` 回 `{ ops, reverted, kept }`），有要撤的就作为一次补偿操作落地：写入身份是 `{ accountId, rollbackEventId }`，
     * 广播给订阅了这个项目的连接（各方照常应用），并给这个项目此刻在线的成员页面各发一条气泡 `shared.notice { event: 'content-rolled-back', name }`。
     * 不在线的不补：重启后认出已落地的同一次（`duplicate`）不再发。没有要撤的不落地、不发气泡。
     */
    async rollback({ projectId, eventId, accountId, attempt = 1, name = null, notify = true, plan }) {
      if (typeof plan !== 'function' || !Number.isSafeInteger(attempt) || attempt < 1) throw historyError('bad-rollback', 400);
      const opId = rollbackOpId(eventId, attempt);
      const actor = { userId: accountId, deviceId: null, role: 'system', conversation: null, session: null,
        identityVersion: 2, realm: 'account', accountId, rollbackEventId: eventId };
      let planned = null, notified = false;
      const out = await operationCoordinator.executeSystem({ projectId, principal: { kind: 'logout-rollback', eventId, accountId }, opId }, (binding) => {
        const st = stateOf(projectId);
        planned = plan(st.body);
        if (!planned.ops.length) return null;
        const applied = applyOps(st.body, planned.ops);
        const at = typeof now === 'function' ? now() : (lastCtx?.now?.() ?? Date.now());
        const record = { projectId, rev: st.projectRev + 1, opId, ops: planned.ops, actor, at, entities: entitiesOf(applied.effects, entityOpts) };
        const next = { ...st, writers: new Map(st.writers), history: [...st.history], opIds: new Map(st.opIds) };
        landCommit(next, record, applied.root);
        return { ...binding, projectId, opId, expectedRev: st.projectRev, actor, ops: planned.ops,
          beforeProjection: snapshotOf(projectId, st), projection: snapshotOf(projectId, next),
          result: { record, overwrote: [], victims: [], used: [], rollback: { eventId, reverted: planned.reverted, kept: planned.kept,
            remaining: planned.remaining ?? 0, overLimit: planned.overLimit ?? 0 } } };
      }, ({ operation, duplicate }) => {
        if (duplicate) return;
        const { record } = operation.result;
        stats.commits++;
        // 广播里不带事件号（安全专审 Q5）：成员只需知道是谁的撤回
        lastCtx?.publish(channelOf(projectId), { type: 'project.ops', projectId, rev: record.rev, opId: shownOpId(opId), ops: record.ops,
          actor: shownActor(record.actor), at: record.at });
        if (!notify) return; // 同一个项目分批撤时只在第一批发气泡
        for (const [connId, principal] of principals) {
          if (principal?.projectId !== projectId || principal.role !== 'page' || principal.scope === 'service' || typeof principal.service === 'string') continue;
          lastCtx?.send(connId, { type: 'shared.notice', event: 'content-rolled-back', projectId, name });
          notified = true;
        }
        log('project.rollback', { projectId, opId, reverted: operation.result.rollback.reverted.length, kept: operation.result.rollback.kept.length });
      });
      if (!out) return { state: 'done', opId: null, reverted: [], kept: planned?.kept ?? [], remaining: planned?.remaining ?? 0,
        overLimit: planned?.overLimit ?? 0, notified: false };
      if (out.cancelled) return { state: 'cancelled', opId };
      const result = out.operation.result.rollback;
      return { state: 'done', opId, reverted: result.reverted, kept: result.kept, remaining: result.remaining ?? 0, overLimit: result.overLimit ?? 0,
        notified, duplicate: out.duplicate };
    },
    materialize(operation, projection) {
      const { projectId } = operation;
      const expected = { ...operation.projection, orderProjection: { opId: operation.opId, requestId: operation.requestId,
        preparedDigest: operation.preparedDigest, witnessId: operation.witness.witnessId, orderSeq: operation.witness.orderSeq } };
      if (expected.projectId !== projectId || expected.rev !== operation.projectRev || historyDigest(expected.project) !== historyDigest(operation.after) ||
          canonical(operation.result.record.actor) !== canonical(operation.actor) || operation.result.record.opId !== operation.opId ||
          operation.result.record.rev !== operation.projectRev) throw historyError('needs-reconciliation');
      // Reload the real store, including a rename that succeeded just before a prior crash/error.
      projects.delete(projectId);
      const current = stateOf(projectId);
      const text = store.readBlob?.(stateBlobName(projectId));
      if (current.projectRev === operation.projectRev) {
        if (!text || canonical(JSON.parse(text)) !== canonical(expected)) throw historyError('needs-reconciliation');
      } else {
        if (current.projectRev !== operation.expectedRev || historyDigest(current.body) !== historyDigest(operation.before) ||
            canonical(snapshotOf(projectId, current)) !== canonical(operation.beforeProjection)) throw historyError('needs-reconciliation');
      }
      // Repeat durability completion even after a previous rename, never infer fsync from readback.
      projection.write(stateBlobName(projectId), expected);
      // Exact complete projection, including actor/rev/opId and all historical metadata.
      if (canonical(JSON.parse(store.readBlob(stateBlobName(projectId)))) !== canonical(expected)) throw historyError('needs-reconciliation');
      projects.delete(projectId);
      const landed = stateOf(projectId);
      if (landed.projectRev !== operation.projectRev || historyDigest(landed.body) !== historyDigest(operation.after)) throw historyError('needs-reconciliation');
    },
  });

  function log(event, fields) {
    try {
      lastCtx?.log(event, fields);
    } catch { /* 日志失败不影响业务 */ }
  }

  function pushHistory(st, entry) {
    st.history.push(entry);
    if (st.history.length > PROJECT_LIMITS.HISTORY) st.history.splice(0, st.history.length - PROJECT_LIMITS.HISTORY);
  }

  function rememberOpId(st, opId, rev) {
    st.opIds.set(opId, rev);
    if (st.opIds.size > PROJECT_LIMITS.OP_IDS) {
      const drop = st.opIds.size - PROJECT_LIMITS.OP_IDS;
      let n = 0;
      for (const key of st.opIds.keys()) {
        if (n >= drop) break;
        st.opIds.delete(key);
        n += 1;
      }
    }
  }

  function noteWriters(st, entities, actor, identity, at, rev) {
    for (const entity of entities) st.writers.set(entity, { actor, identity, at, rev });
  }

  /** 一条提交记录落到内存状态上（实时提交与回放共用） */
  function landCommit(st, rec, body) {
    st.body = body;
    st.hasBody = true;
    st.bodyDigest = null;
    st.projectRev = rec.rev;
    st.at = rec.at;
    const entities = Array.isArray(rec.entities) ? rec.entities : [];
    noteWriters(st, entities, rec.actor, identityOf(rec.actor), rec.at, rec.rev);
    const entry = { rev: rec.rev, opId: rec.opId, actor: rec.actor, at: rec.at, paths: capPaths(targetsOf(rec.ops)), entities };
    if (rec.undoOf !== undefined) entry.undoOf = rec.undoOf;
    pushHistory(st, entry);
    rememberOpId(st, rec.opId, rec.rev);
  }

  function stateOf(projectId) {
    let st = projects.get(projectId);
    if (st) return st;
    st = {
      projectRev: 0, digest: null, at: null,
      hasBody: false, body: null, bodyDigest: null,
      writers: new Map(), history: [], opIds: new Map(), sinceSnapshot: 0,
    };
    const revs = new Map();
    for (const rec of store.read(streamOf(projectId))) {
      // 同一个文件里可能混进只差大小写的项目（Windows 文件名不分大小写），按记录自己的键过滤
      if (rec.projectId !== projectId) continue;
      if (!Number.isSafeInteger(rec.rev) || rec.rev <= st.projectRev) continue;
      if (typeof rec.digest !== 'string') continue;
      st.projectRev = rec.rev;
      st.digest = rec.digest;
      st.at = Number.isFinite(rec.at) ? rec.at : null;
      revs.set(rec.rev, rec.digest);
      pushHistory(st, { rev: rec.rev, actor: rec.actor ?? null, at: st.at, paths: [], entities: [], announce: true });
    }

    // 真身：先读快照，再回放快照之后的日志
    let snapRev = 0;
    if (typeof store.readBlob === 'function') {
      let snap = null;
      try {
        const text = store.readBlob(stateBlobName(projectId));
        if (text !== null) snap = JSON.parse(text);
      } catch (err) {
        log('project.state-snapshot.bad', { projectId, message: String(err?.message ?? err) });
      }
      if (isObj(snap) && snap.projectId === projectId && Number.isSafeInteger(snap.rev) && snap.rev >= 1) {
        snapRev = snap.rev;
        st.hasBody = true;
        st.body = snap.project ?? null;
        st.projectRev = Math.max(st.projectRev, snap.rev);
        st.at = Number.isFinite(snap.at) ? snap.at : st.at;
        for (const [entity, w] of Array.isArray(snap.writers) ? snap.writers : []) {
          if (typeof entity === 'string' && isObj(w)) st.writers.set(entity, { ...w, identity: identityOf(w.actor) });
        }
        st.history = Array.isArray(snap.history) ? snap.history.slice(-PROJECT_LIMITS.HISTORY) : [];
        for (const [opId, rev] of Array.isArray(snap.opIds) ? snap.opIds : []) st.opIds.set(opId, rev);
      }
    }
    for (const rec of store.read(opsStreamOf(projectId))) {
      if (rec.projectId !== projectId || !Number.isSafeInteger(rec.rev) || rec.rev <= snapRev) continue;
      if (rec.rev <= st.projectRev && st.hasBody) continue;
      if (typeof rec.opId !== 'string' || !Array.isArray(rec.ops)) continue;
      let applied;
      try {
        applied = applyOps(st.body, rec.ops);
      } catch (err) {
        // 日志里的提交当初都落地过，回放不该失败；失败说明日志坏了，停在这里，别在错的内容上接着回放
        log('project.replay-failed', { projectId, rev: rec.rev, message: String(err?.message ?? err) });
        break;
      }
      if (rec.rev !== st.projectRev + 1) log('project.replay-gap', { projectId, expected: st.projectRev + 1, got: rec.rev });
      landCommit(st, rec, applied.root);
      st.sinceSnapshot += 1;
    }
    projects.set(projectId, st);
    revDigests.set(projectId, revs);
    return st;
  }

  /** 真身的摘要（按版本缓存）；同时登记成这一版的摘要，M5b 快照能按它校验 */
  function bodyDigestOf(projectId, st, text) {
    if (st.bodyDigest && st.bodyDigest.rev === st.projectRev) return st.bodyDigest.digest;
    const digest = sha256(text ?? JSON.stringify(st.body));
    st.bodyDigest = { rev: st.projectRev, digest };
    revDigests.get(projectId)?.set(st.projectRev, digest);
    return digest;
  }

  /** 这一版登记的摘要；没登记过回 undefined。有真身时当前版本的摘要就是真身的摘要 */
  function digestOfRev(projectId, rev) {
    const st = stateOf(projectId);
    const known = revDigests.get(projectId)?.get(rev);
    if (known !== undefined) return known;
    if (st.hasBody && rev === st.projectRev) return bodyDigestOf(projectId, st);
    return undefined;
  }

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  /** 时间窗内的最近写入者，按版本从新到旧，最多 `WRITERS_IN_STATE` 个 */
  function recentWriters(st, nowMs) {
    return [...st.writers.entries()]
      .filter(([, w]) => nowMs - w.at <= overwriteWindowMs)
      .sort((a, b) => b[1].rev - a[1].rev)
      .slice(0, PROJECT_LIMITS.WRITERS_IN_STATE)
      .map(([entity, w]) => ({ entity, actor: shownActor(w.actor), at: w.at, rev: w.rev }));
  }

  function open(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const st = stateOf(projectId);
    ctx.subscribe(connId, channelOf(projectId));
    const rev = st.projectRev;
    const head = {
      type: 'project.state', projectId, rev, projectRev: rev, digest: st.digest, at: st.at,
      hasBody: st.hasBody, writers: recentWriters(st, clock(ctx)),
    };
    if (!st.hasBody) {
      head.project = null;
      return reply(ctx, connId, head, reqId);
    }
    const text = JSON.stringify(st.body);
    const digest = bodyDigestOf(projectId, st, text);
    head.digest = digest;
    if (Buffer.byteLength(text, 'utf8') <= PROJECT_LIMITS.INLINE_BYTES) {
      head.project = st.body;
      return reply(ctx, connId, head, reqId);
    }
    // 大项目：先回不带内容的头，再分片（与 M5b 快照同一条节流队列）
    const withReq = (m) => (reqId === undefined ? m : { ...m, reqId });
    const parts = splitSnapshotText(text, partBytesOf(ctx));
    head.parts = parts.length;
    reply(ctx, connId, head, reqId);
    const messages = parts.map((data, index) => withReq({ type: 'project.state.part', projectId, rev, index, count: parts.length, data }));
    messages.push(withReq({ type: 'project.state.end', projectId, rev, digest }));
    enqueue(ctx, connId, messages, 'project.open');
  }

  function announce(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const digest = checkDigest(msg.digest);
    const session = checkSession(msg.session);
    const st = stateOf(projectId);
    if (st.hasBody) {
      // 有真身：摘要以真身为准，announce 不再发号（见文件头「与旧消息的关系」）
      const bodyDigest = bodyDigestOf(projectId, st);
      return reply(ctx, connId, {
        type: 'project.announced', projectId, projectRev: st.projectRev, changed: false,
        digest: bodyDigest, authoritative: true, matches: bodyDigest === digest,
      }, reqId);
    }
    if (st.digest === digest) {
      return reply(ctx, connId, { type: 'project.announced', projectId, projectRev: st.projectRev, changed: false }, reqId);
    }
    const principal = principals.get(connId);
    const actor = actorOf(principal, session);
    const at = clock(ctx);
    const rev = st.projectRev + 1;
    // 先落日志再改内存：落盘失败时状态不变，核心回 internal
    store.append(streamOf(projectId), { projectId, rev, digest, actor, at });
    st.projectRev = rev;
    st.digest = digest;
    st.at = at;
    revDigests.get(projectId).set(rev, digest);
    pushHistory(st, { rev, actor, at, paths: [], entities: [], announce: true });
    reply(ctx, connId, { type: 'project.announced', projectId, projectRev: rev, changed: true }, reqId);
    ctx.publish(channelOf(projectId), { type: 'project.rev', projectId, projectRev: rev, digest, actor, at }, { coalesceKey: `project-rev:${projectId}` });
  }

  function close(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    ctx.unsubscribe(connId, channelOf(projectId));
    reply(ctx, connId, { type: 'project.closed', projectId }, reqId);
  }

  // ---------- 真身：提交 ----------

  function trackIdentity(connId, identity) {
    let set = identityConns.get(identity);
    if (!set) identityConns.set(identity, (set = new Set()));
    set.add(connId);
    let mine = connIdentities.get(connId);
    if (!mine) connIdentities.set(connId, (mine = new Set()));
    mine.add(identity);
  }

  function isUnfollowed(projectId, identity, entity) {
    const set = unfollowed.get(projectId)?.get(identity);
    return !!set && (set.has(entity) || set.has('*'));
  }

  /** 把 `{ op: 'set', path: '', upload }` 换成上传好的内容；引用不到回 null 与原因 */
  function resolveUploads(projectId, ops) {
    let used = null;
    const out = ops.map((op) => {
      if (!isObj(op) || op.op !== 'set' || op.path !== '' || !Object.hasOwn(op, 'upload') || Object.hasOwn(op, 'value')) return op;
      const key = `${projectId}|${op.upload}`;
      const up = typeof op.upload === 'string' ? bodyUploads.get(key) : undefined;
      if (!up || !Object.hasOwn(up, 'value')) throw new OpError('bad-path', ops.indexOf(op), `上传 ${String(op.upload)} 不存在或没收齐`);
      (used ??= []).push(key);
      const { upload, ...rest } = op;
      return { ...rest, value: up.value };
    });
    return { ops: out, used };
  }

  /**
   * `stale` 回包里的 `expectRev`、`since`（期间别人的提交摘要）、`sinceComplete`。
   * 非账号路径与账号路径共用，模型读到的「你读到的是 rev X，现在是 rev Y，期间谁改了什么」都靠它。
   */
  function staleDetail(st, expectRev) {
    const later = st.history.filter((h) => h.rev > expectRev && h.rev <= st.projectRev);
    const covered = expectRev >= st.projectRev || (later.length > 0 && later[0].rev === expectRev + 1)
      || (later.length === 0 && st.projectRev === expectRev);
    const shown = later.slice(-PROJECT_LIMITS.SINCE_MAX);
    return {
      expectRev,
      since: shown.map((h) => {
        const s = { rev: h.rev, actor: shownActor(h.actor), paths: h.paths, entities: h.entities, at: h.at };
        if (h.opId !== undefined) s.opId = shownOpId(h.opId);
        if (h.undoOf !== undefined) s.undoOf = h.undoOf;
        if (h.announce) s.announce = true;
        return s;
      }),
      sinceComplete: covered && shown.length === later.length,
    };
  }

  function submit(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const opId = checkToken(msg.opId, 'opId');
    const session = checkSession(msg.session);
    const undoOf = msg.undoOf === undefined || msg.undoOf === null ? undefined : checkToken(msg.undoOf, 'undoOf');
    let expectRev;
    if (msg.expectRev !== undefined && msg.expectRev !== null) {
      if (!Number.isSafeInteger(msg.expectRev) || msg.expectRev < 0) bad('expectRev 必须是非负整数');
      expectRev = msg.expectRev;
    }
    const st = stateOf(projectId);
    const reject = (reason, extra = {}) => {
      stats.rejected += 1;
      reply(ctx, connId, { type: 'project.op.rejected', projectId, opId, reason, currentRev: st.projectRev, ...extra }, reqId);
    };

    const principal = principals.get(connId);
    if (principal?.role === 'render') return reject('forbidden', { detail: '渲染节点的连接不能改项目' });
    // 只读成员的云端 Agent 连接（principal 带 `access: 'r'`，`docs/plan/cloud-agent-contract.md` 第 4.6 节）；组装层的 gate 已经挡过一次
    if (principal?.access === 'r') return reject('forbidden', { detail: '只读的连接不能改项目' });

    const done = st.opIds.get(opId);
    if (done !== undefined) {
      stats.duplicates += 1;
      return reply(ctx, connId, { type: 'project.op.ok', projectId, opId, rev: done, overwrote: [], duplicate: true }, reqId);
    }

    if (!Array.isArray(msg.ops) || msg.ops.length === 0) return reject('bad-path', { detail: 'ops 必须是非空数组', index: -1 });
    if (Buffer.byteLength(JSON.stringify(msg.ops), 'utf8') > maxOpsBytes) {
      return reject('too-large', { detail: `ops 序列化后超过 ${maxOpsBytes} 字节` });
    }

    if (expectRev !== undefined && expectRev !== st.projectRev) {
      return reject('stale', staleDetail(st, expectRev));
    }

    let ops;
    let used;
    let applied;
    try {
      ({ ops, used } = resolveUploads(projectId, msg.ops));
      applied = applyOps(st.body, ops);
    } catch (err) {
      if (!(err instanceof OpError)) throw err;
      // 格式不对（bad-op）与走不通（bad-path）对提交者一样：整批不落地。对外理由只有四种，都记 bad-path
      return reject('bad-path', { detail: err.message, index: err.index });
    }

    const entities = entitiesOf(applied.effects, entityOpts);
    const actor = actorOf(principal, session);
    const identity = identityOf(actor);
    const at = clock(ctx);
    const rev = st.projectRev + 1;
    const record = { projectId, rev, opId, ops, actor, at, entities };
    if (undoOf !== undefined) record.undoOf = undoOf;
    // 先落日志再改内存：落盘失败时状态不变，核心回 internal
    store.append(opsStreamOf(projectId), record);
    for (const key of used ?? []) bodyUploads.delete(key);

    // 覆盖：写到的实体上一次是别的写入身份、且在时间窗内（先算，再记新的写入者）
    const overwrote = [];
    const victims = [];
    for (const entity of entities) {
      const prev = st.writers.get(entity);
      if (!prev || prev.identity === identity || at - prev.at > overwriteWindowMs) continue;
      overwrote.push({ entity, by: prev.actor, rev: prev.rev, at: prev.at });
      if (!isUnfollowed(projectId, prev.identity, entity)) victims.push({ identity: prev.identity, entity, writer: prev.actor });
    }
    landCommit(st, record, applied.root);
    st.sinceSnapshot += 1;
    stats.commits += 1;
    stats.overwrites += overwrote.length;
    trackIdentity(connId, identity);

    reply(ctx, connId, { type: 'project.op.ok', projectId, opId, rev, overwrote }, reqId);
    // 被覆盖方先收 overwritten，再收 ops：它要在应用新版本之前先把自己那一版存成本地备份。
    // `writer` 是被覆盖的那次写入的身份：一条连接上跑着多个会话（例：Agent 服务端的多个对话）时据此分给对应的会话；
    // 所以提交者自己的连接若也以被覆盖的身份提交过，照样收
    for (const v of victims) {
      for (const target of identityConns.get(v.identity) ?? []) {
        ctx.send(target, { type: 'project.overwritten', projectId, entity: v.entity, by: actor, writer: shownActor(v.writer), rev, at });
      }
    }
    const broadcast = { type: 'project.ops', projectId, rev, opId, ops, actor, at };
    if (undoOf !== undefined) broadcast.undoOf = undoOf;
    let out = broadcast;
    if (used && Buffer.byteLength(JSON.stringify(broadcast), 'utf8') > PROJECT_LIMITS.INLINE_BYTES) {
      out = { type: 'project.ops', projectId, rev, opId, actor, at, resync: true };
      if (undoOf !== undefined) out.undoOf = undoOf;
    }
    ctx.publish(channelOf(projectId), out, { except: connId });

    if (st.sinceSnapshot >= snapshotEvery) persistState(ctx, projectId, st);
  }

  async function submitAccount(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const opId = checkToken(msg.opId, 'opId');
    const session = checkSession(msg.session);
    const principal = principals.get(connId);
    const actor = actorOf(principal, session);
    if (!operationCoordinator) throw historyError('order-unavailable', 503);
    if (principal.role === 'render' || principal.access === 'r') throw historyError('operation-forbidden', 403);
    if (!Array.isArray(msg.ops) || !msg.ops.length) throw historyError('bad-path', 400);
    if (Buffer.byteLength(JSON.stringify(msg.ops)) > maxOpsBytes) throw historyError('too-large', 413);
    if (msg.expectRev != null && (!Number.isSafeInteger(msg.expectRev) || msg.expectRev < 0)) bad('expectRev 必须是非负整数');
    const undoOf = msg.undoOf == null ? null : checkToken(msg.undoOf, 'undoOf');
    const request = { opId, ops: msg.ops, expectRev: msg.expectRev ?? null, undoOf, session };
    /*
     * 慢提交的诊断(线上 2026-10-21:Agent 的 switch_cut 约 60 秒才落地,日志里看不出卡在哪;`docs/archive/agent-reports/AGENT-cut-stream-fix.md`
     * 缺陷 5):从收到到回包超过 `SLOW_OP_MS` 记一行 `project.op.slow`,分出排队(进有序提交之前:授权核对、项目锁)与落地(进锁之后)各多久。
     */
    const t0 = Date.now();
    let tPrepare = null, tCommitted = null;
    const slow = (outcome) => {
      const ms = Date.now() - t0;
      if (ms < SLOW_OP_MS) return;
      log('project.op.slow', { projectId, opId: String(opId).slice(0, 48), role: principal?.role ?? null, ms, outcome,
        queuedMs: tPrepare === null ? null : tPrepare - t0, landMs: tPrepare === null || tCommitted === null ? null : tCommitted - tPrepare });
    };
    return operationCoordinator.execute({ projectId, principal, actor, request }, (binding) => {
      tPrepare = Date.now();
      const st = stateOf(projectId);
      if (request.expectRev !== null && request.expectRev !== st.projectRev) throw historyError('stale');
      let ops, used, applied;
      try { ({ ops, used } = resolveUploads(projectId, msg.ops)); applied = applyOps(st.body, ops); }
      catch (error) { if (error instanceof OpError) throw historyError('bad-path', 400); throw error; }
      const entities = entitiesOf(applied.effects, entityOpts);
      const at = clock(ctx), rev = st.projectRev + 1, identity = identityOf(actor);
      const record = { projectId, rev, opId, ops, actor, at, entities, ...(undoOf ? { undoOf } : {}) };
      const overwrote = [], victims = [];
      for (const entity of entities) {
        const prev = st.writers.get(entity);
        if (!prev || prev.identity === identity || at - prev.at > overwriteWindowMs) continue;
        overwrote.push({ entity, by: prev.actor, rev: prev.rev, at: prev.at });
        if (!isUnfollowed(projectId, prev.identity, entity)) victims.push({ identity: prev.identity, entity, writer: prev.actor });
      }
      const next = { ...st, writers: new Map(st.writers), history: [...st.history], opIds: new Map(st.opIds) };
      landCommit(next, record, applied.root);
      return { ...binding, projectId, opId, expectedRev: st.projectRev, actor, ops,
        beforeProjection: snapshotOf(projectId, st), projection: snapshotOf(projectId, next), result: { record, overwrote, victims, used: used ?? [] } };
    }, result => {
      tCommitted = Date.now();
      const { operation, duplicate } = result;
      const { record, overwrote, victims, used } = operation.result;
      for (const key of used) bodyUploads.delete(key);
      trackIdentity(connId, identityOf(actor));
      reply(ctx, connId, { type: 'project.op.ok', projectId, opId, rev: record.rev, overwrote: duplicate ? [] : overwrote,
        ...(duplicate ? { duplicate: true } : {}), orderSeq: operation.witness.orderSeq }, reqId);
      if (duplicate) { stats.duplicates++; return; }
      stats.commits++; stats.overwrites += overwrote.length;
      for (const victim of victims) for (const target of identityConns.get(victim.identity) ?? []) {
        ctx.send(target, { type: 'project.overwritten', projectId, entity: victim.entity, by: record.actor,
          writer: shownActor(victim.writer), rev: record.rev, at: record.at });
      }
      const broadcast = { type: 'project.ops', projectId, rev: record.rev, opId, ops: record.ops, actor: record.actor, at: record.at,
        ...(record.undoOf ? { undoOf: record.undoOf } : {}) };
      if (used.length && Buffer.byteLength(JSON.stringify(broadcast)) > PROJECT_LIMITS.INLINE_BYTES) {
        delete broadcast.ops; broadcast.resync = true;
      }
      ctx.publish(channelOf(projectId), broadcast, { except: connId });
    }).then((out) => { slow('ok'); return out; }, (error) => { slow(String(error?.code ?? 'error').slice(0, 40)); throw error; });
  }

  /** 落一次真身快照，再把日志截断到快照之后（存储支持时）。出错只记日志：日志本身已经完整 */
  function persistState(ctx, projectId, st) {
    if (typeof store.writeBlob !== 'function') return;
    try {
      const nowMs = clock(ctx);
      const snap = {
        v: 1,
        projectId,
        rev: st.projectRev,
        at: st.at,
        project: st.body,
        writers: [...st.writers.entries()]
          .filter(([, w]) => nowMs - w.at <= overwriteWindowMs)
          .map(([entity, w]) => [entity, { actor: w.actor, at: w.at, rev: w.rev }]),
        history: st.history.slice(-PROJECT_LIMITS.HISTORY),
        opIds: [...st.opIds.entries()],
      };
      store.writeBlob(stateBlobName(projectId), JSON.stringify(snap));
      st.sinceSnapshot = 0;
      stats.stateSnapshots += 1;
      // 时间窗外的写入者用不上了，顺手丢掉
      for (const [entity, w] of st.writers) if (nowMs - w.at > overwriteWindowMs) st.writers.delete(entity);
      if (typeof store.rewrite === 'function') {
        const stream = opsStreamOf(projectId);
        // 只丢这个项目、快照已含的记录；同一个文件里别的项目（只差大小写）的记录原样留下
        const keep = store.read(stream).filter((r) => r.projectId !== projectId || !(Number.isSafeInteger(r.rev) && r.rev <= snap.rev));
        store.rewrite(stream, keep);
      }
      ctx.log('project.state-snapshot', { projectId, rev: snap.rev });
    } catch (err) {
      ctx.log('project.state-snapshot.failed', { projectId, message: String(err?.message ?? err) });
    }
  }

  function follow(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const session = checkSession(msg.session);
    if (typeof msg.entity !== 'string') bad('entity 必须是路径字符串');
    const entity = normalizeEntity(msg.entity, entityOpts);
    if (entity === null) bad('entity 必须是空串或以 / 开头的 JSON 指针');
    if (typeof msg.on !== 'boolean') bad('on 必须是布尔值');
    const identity = identityOf(actorOf(principals.get(connId), session));
    let byIdentity = unfollowed.get(projectId);
    if (!byIdentity) unfollowed.set(projectId, (byIdentity = new Map()));
    let set = byIdentity.get(identity);
    if (!set) byIdentity.set(identity, (set = new Set()));
    if (msg.on) set.delete(entity);
    else set.add(entity);
    if (set.size === 0) byIdentity.delete(identity);
    if (byIdentity.size === 0) unfollowed.delete(projectId);
    trackIdentity(connId, identity);
    reply(ctx, connId, { type: 'project.following', projectId, entity, on: msg.on }, reqId);
  }

  /** 大的根替换：分片收一个整份项目，收齐后解析好，等 `project.op` 引用 */
  function upload(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const uploadId = checkToken(msg.uploadId, 'uploadId');
    if (principals.get(connId)?.access === 'r') return reply(ctx, connId, { type: 'error', reason: 'forbidden', detail: '只读的连接不能上传项目' }, reqId);
    const { index, count, data } = msg;
    if (!Number.isSafeInteger(count) || count < 1 || count > PROJECT_LIMITS.UPLOAD_MAX_PARTS) bad(`count 必须是 1～${PROJECT_LIMITS.UPLOAD_MAX_PARTS} 的整数`);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) bad('index 必须是 0～count-1 的整数');
    if (typeof data !== 'string') bad('data 必须是字符串');
    if (Buffer.byteLength(data, 'utf8') > PROJECT_LIMITS.UPLOAD_PART_BYTES) bad(`每片不能超过 ${PROJECT_LIMITS.UPLOAD_PART_BYTES} 字节`);
    const key = `${projectId}|${uploadId}`;
    const nowMs = Date.now();
    let up = bodyUploads.get(key);
    if (up && (up.count !== count || Object.hasOwn(up, 'value'))) {
      bodyUploads.delete(key);
      up = undefined;
    }
    if (!up) bodyUploads.set(key, (up = { count, parts: new Map(), touched: nowMs }));
    up.parts.set(index, data);
    up.touched = nowMs;
    for (const [k, u] of bodyUploads) if (k !== key && nowMs - u.touched > SNAPSHOT_LIMITS.PENDING_IDLE_MS) bodyUploads.delete(k);
    while (bodyUploads.size > PROJECT_LIMITS.UPLOAD_MAX_PENDING) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, u] of bodyUploads) if (k !== key && u.touched < oldest) { oldest = u.touched; oldestKey = k; }
      if (oldestKey === null) break;
      bodyUploads.delete(oldestKey);
    }
    if (up.parts.size < count) {
      return reply(ctx, connId, { type: 'project.uploaded', projectId, uploadId, received: up.parts.size, count, complete: false }, reqId);
    }
    let text = '';
    for (let i = 0; i < count; i += 1) text += up.parts.get(i);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      bodyUploads.delete(key);
      bad('收齐的内容不是合法的 JSON');
    }
    if (!isObj(value)) {
      bodyUploads.delete(key);
      bad('收齐的内容必须是 JSON 对象');
    }
    up.parts.clear();
    up.value = value;
    reply(ctx, connId, { type: 'project.uploaded', projectId, uploadId, received: count, count, complete: true }, reqId);
  }

  // ---------- 快照：上传 ----------

  function requireBlobStore() {
    if (typeof store.writeBlob !== 'function' || typeof store.readBlob !== 'function') {
      throw new Refused('unsupported', '这个存储不支持项目快照');
    }
  }

  /** 丢掉闲置太久的上传；超过份数上限时丢最旧的 */
  function evictUploads(nowMs, keep) {
    for (const [key, up] of uploads) {
      if (key !== keep && nowMs - up.touched > SNAPSHOT_LIMITS.PENDING_IDLE_MS) {
        uploads.delete(key);
        stats.uploadsEvicted += 1;
      }
    }
    while (uploads.size > SNAPSHOT_LIMITS.MAX_PENDING_UPLOADS) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [key, up] of uploads) {
        if (key !== keep && up.touched < oldest) { oldest = up.touched; oldestKey = key; }
      }
      if (oldestKey === null) break;
      uploads.delete(oldestKey);
      stats.uploadsEvicted += 1;
    }
  }

  function snapshotPut(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const projectRev = checkRev(msg.projectRev);
    const digest = checkDigest(msg.digest);
    const { index, count, data } = msg;
    if (!Number.isSafeInteger(count) || count < 1 || count > SNAPSHOT_LIMITS.MAX_PARTS) bad(`count 必须是 1～${SNAPSHOT_LIMITS.MAX_PARTS} 的整数`);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) bad('index 必须是 0～count-1 的整数');
    if (typeof data !== 'string') bad('data 必须是字符串');
    if (Buffer.byteLength(data, 'utf8') > SNAPSHOT_LIMITS.PART_BYTES) bad(`每片不能超过 ${SNAPSHOT_LIMITS.PART_BYTES} 字节`);
    requireBlobStore();

    const key = `${projectId}@${projectRev}`;
    const announced = digestOfRev(projectId, projectRev);
    if (announced === undefined) {
      uploads.delete(key);
      throw new Refused('unknown-rev', `项目 ${projectId} 没有登记过版本 ${projectRev}`);
    }
    if (announced !== digest) {
      uploads.delete(key);
      stats.digestMismatches += 1;
      throw new Refused('digest-mismatch', '摘要与这一版登记的不一致');
    }

    const nowMs = Date.now();
    let up = uploads.get(key);
    // 分片数变了（发布方换了切法重传）：按新的切法从头收
    if (up && up.count !== count) {
      uploads.delete(key);
      up = undefined;
    }
    if (!up) {
      up = { projectId, projectRev, digest, count, parts: new Map(), touched: nowMs };
      uploads.set(key, up);
    }
    up.parts.set(index, data);
    up.touched = nowMs;
    evictUploads(nowMs, key);

    if (up.parts.size < up.count) {
      return reply(ctx, connId, { type: 'project.snapshot.stored', projectId, projectRev, received: up.parts.size, count, complete: false }, reqId);
    }

    uploads.delete(key);
    let text = '';
    for (let i = 0; i < up.count; i += 1) text += up.parts.get(i);
    if (sha256(text) !== digest) {
      stats.digestMismatches += 1;
      throw new Refused('digest-mismatch', '收齐后的内容与摘要不符');
    }
    store.writeBlob(snapshotBlobName(projectId, projectRev), text);
    stats.snapshotsStored += 1;
    ctx.log('project.snapshot.stored', { projectId, projectRev, bytes: Buffer.byteLength(text, 'utf8'), count });
    reply(ctx, connId, { type: 'project.snapshot.stored', projectId, projectRev, received: count, count, complete: true }, reqId);
  }

  // ---------- 分片发送（快照取回、project.state 共用） ----------

  const wait = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
  const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
  const maxPendingOf = (ctx) => (Number.isFinite(ctx.maxPendingBytes) && ctx.maxPendingBytes > 0 ? ctx.maxPendingBytes : DEFAULT_MAX_PENDING_BYTES);
  /** 每片不超过 256 KiB，也不超过积压上限的四分之一：节流线是上限的一半，发出一片后仍留余量 */
  const partBytesOf = (ctx) => Math.max(1024, Math.min(SNAPSHOT_LIMITS.OUT_PART_BYTES, Math.floor(maxPendingOf(ctx) / 4)));

  /**
   * 按积压节流，把一串消息发给一条连接（J.11）：每发一条之前，这条连接的积压（核心出站队列 + 底层缓冲，
   * `ctx.pendingBytes`）必须低于上限（`ctx.maxPendingBytes`）的一半，否则隔 `pollMs` 再查。
   * 每片 ≤ min(256 KiB, 上限的四分之一)，所以发出后积压不超过上限的四分之三，到不了 1013。连接断开或被核心关掉就停。
   * 核心没有这两个接口时（测试替身）按上限 1 MiB 算、积压当 0，每条之间只让一次事件循环。
   */
  async function stream(ctx, connId, sender, messages) {
    const limit = maxPendingOf(ctx);
    const pendingOf = typeof ctx.pendingBytes === 'function' ? (id) => ctx.pendingBytes(id) : () => 0;
    for (let i = 0; i < messages.length; i += 1) {
      if (!sender.alive) return;
      if (i > 0) await nextTurn();
      while (sender.alive && pendingOf(connId) >= limit / 2) await wait(pollMs);
      if (!sender.alive) return;
      if (ctx.send(connId, messages[i]) === false) return;
    }
  }

  /** 排进这条连接的发送队列（同一条连接上依次发，连接断开就停） */
  function enqueue(ctx, connId, messages, type) {
    let sender = senders.get(connId);
    if (!sender) senders.set(connId, (sender = { chain: Promise.resolve(), alive: true }));
    const s = sender;
    s.chain = s.chain
      .then(() => stream(ctx, connId, s, messages))
      .catch((err) => ctx.log('module.error', { module: PROJECT_MODULE, type, message: String(err?.message ?? err) }));
  }

  function snapshotGet(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const projectRev = checkRev(msg.projectRev);
    requireBlobStore();

    const withReq = (m) => (reqId === undefined ? m : { ...m, reqId });
    /*
     * 有真身的项目只给得出当前这一版(旧版本没有人上传过快照)。要的不是当前版本时,回包多带一项 `currentRev`:
     * 渲染节点据此改按当前版本核对手里的任务(内容没变的照做,内容已经换掉的作废),不把「项目往前走了」当成失败
     * (`docs/plan/render-queue-contract.md` J.15)。没有真身的项目不带这一项,行为同前。
     */
    const missing = () => {
      const st = stateOf(projectId);
      const message = { type: 'project.snapshot.part', projectId, projectRev, missing: true };
      if (st.hasBody && st.projectRev !== projectRev) message.currentRev = st.projectRev;
      reply(ctx, connId, message, reqId);
    };
    const digest = digestOfRev(projectId, projectRev);
    if (digest === undefined) return missing();
    let text = store.readBlob(snapshotBlobName(projectId, projectRev));
    if (text === null) {
      // 存储里没有这一版的文件，但它就是当前的真身：直接由真身发回
      const st = stateOf(projectId);
      if (!st.hasBody || projectRev !== st.projectRev) return missing();
      text = JSON.stringify(st.body);
    }
    if (sha256(text) !== digest) {
      ctx.log('project.snapshot.foreign', { projectId, projectRev });
      return missing();
    }

    const parts = splitSnapshotText(text, partBytesOf(ctx));
    const count = parts.length;
    const messages = parts.map((data, index) => withReq({ type: 'project.snapshot.part', projectId, projectRev, index, count, data }));
    messages.push(withReq({ type: 'project.snapshot.end', projectId, projectRev, digest }));
    stats.snapshotsServed += 1;
    enqueue(ctx, connId, messages, 'project.snapshot.get');
  }

  const HANDLERS = {
    'project.open': open,
    'project.announce': announce,
    'project.close': close,
    'project.op': submit,
    'project.follow': follow,
    'project.upload': upload,
    'project.snapshot.put': snapshotPut,
    'project.snapshot.get': snapshotGet,
  };

  return {
    name: PROJECT_MODULE,
    types: ['project.'],
    channels: ['project'],

    connect(ctx, connId, principal) {
      lastCtx = ctx;
      principals.set(connId, { ...principal });
    },

    disconnect(ctx, connId) {
      // 频道订阅由核心在断开时清掉
      principals.delete(connId);
      const sender = senders.get(connId);
      if (sender) {
        sender.alive = false;
        senders.delete(connId);
      }
      for (const identity of connIdentities.get(connId) ?? []) {
        const set = identityConns.get(identity);
        if (!set) continue;
        set.delete(connId);
        if (set.size === 0) identityConns.delete(identity);
      }
      connIdentities.delete(connId);
    },

    handle(ctx, connId, msg) {
      lastCtx = ctx;
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: '项目模块不支持这种消息' }, reqId);
      const principal = principals.get(connId);
      if (principal?.realm === 'account' || principal?.identityVersion === 2) {
        return Promise.resolve().then(async () => {
          if (msg.type === 'project.op') return submitAccount(ctx, connId, msg, reqId);
          const projectId = checkProjectId(msg.projectId);
          // Existing authority-gated readers remain usable before the owner mounts order.
          // A projection that already belongs to order can never be read without recovery.
          if (!operationCoordinator) {
            const text = store.readBlob?.(stateBlobName(projectId));
            if (text && JSON.parse(text).orderProjection) throw historyError('order-unavailable', 503);
            return fn(ctx, connId, msg, reqId);
          }
          return operationCoordinator.read(projectId, principal, () => {
            if (msg.type === 'project.announce' && !stateOf(projectId).hasBody) throw historyError('operation-required');
            return fn(ctx, connId, msg, reqId);
          }, ['project.upload', 'project.snapshot.put'].includes(msg.type) ? 'write' : 'read');
        }).catch(error => {
          const reason = error instanceof BadMessage ? 'bad-message' : error.code ?? 'operation-unavailable';
          if (msg.type === 'project.op') {
            stats.rejected++;
            // 过期（stale）是在授权通过、进了有序提交之后才判的：和非账号路径一样带上当前版本和期间的改动，模型据此重读。
            // 其它拒绝理由（没授权、顺序服务不可用……）不带版本号，不向没通过授权的连接透露项目的进度。
            const stale = reason === 'stale' && Number.isSafeInteger(msg.expectRev) && msg.expectRev >= 0 && PROJECT_ID_RE.test(String(msg.projectId))
              ? (() => { const st = stateOf(msg.projectId); return { currentRev: st.projectRev, ...staleDetail(st, msg.expectRev) }; })() : {};
            return reply(ctx, connId, { type: 'project.op.rejected', projectId: msg.projectId, opId: msg.opId, reason, ...stale }, reqId);
          }
          return reply(ctx, connId, { type: 'error', reason }, reqId);
        });
      }
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (err instanceof Refused) return reply(ctx, connId, { type: 'error', reason: err.reason, detail: err.message }, reqId);
        if (!(err instanceof BadMessage)) throw err;
        reply(ctx, connId, { type: 'error', reason: 'bad-message', detail: err.message }, reqId);
      }
    },

    describe() {
      return {
        projects: [...projects.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([projectId, st]) => ({ projectId, projectRev: st.projectRev, digest: st.digest, at: st.at, hasBody: st.hasBody })),
        snapshots: { ...stats, pendingUploads: uploads.size, bodyUploads: bodyUploads.size },
      };
    },

    /**
     * 借项目频道广播一条消息（C6.5 第 7 节：工具调用事件走项目频道）。给同一空间里的别的模块用，
     * 频道名与订阅都归本模块管。还没有任何连接进来过时回 0。
     * @param {string} projectId
     * @param {object} message
     * @param {{ except?: string }} [opts]
     */
    publishToProject(projectId, message, opts) {
      if (!lastCtx || typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return 0;
      return lastCtx.publish(channelOf(projectId), message, opts);
    },

    /** 当前版本号（别的模块与诊断用）；没见过的项目回 0 */
    revOf(projectId) {
      return PROJECT_ID_RE.test(projectId) ? stateOf(projectId).projectRev : 0;
    },
    /** Server-internal snapshot inspection; never expose the mutable cached body. */
    bodyOf(projectId) {
      if (!PROJECT_ID_RE.test(projectId)) return null;
      if (operationCoordinator && !operationCoordinator.isReady(projectId)) return null;
      const state = stateOf(projectId);
      return state.hasBody ? structuredClone(state.body) : null;
    },
  };
}

/** 别名：与其它工厂的命名习惯对齐 */
export const createProjectModule = projectModule;
export default projectModule;
