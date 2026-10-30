/**
 * 页面一侧的在场状态(计划 docs/plan/agent-workflow-plan.md A3 第二阶段;文档服务一侧 server/docservice/modules/presence.mjs)。
 *
 * - **发**:这个页面「正在编辑」的片段(A2 的汇总,src/editor/userEditing.ts)经它自己的文档服务连接 `presence.set`,
 *   同一项目的别的成员(他们的编辑器进程、他们的 Agent)就知道「用户 <成员>正在编辑」。在线页面(浏览器模式,没有本机
 *   编辑器进程)也走这条。不进项目历史,带过期时间(15 秒,页面非空时每 5 秒续一次)。
 * - **收**:别的成员那边的 Agent 声明的范围(`kind: 'agent'`),AI 栏上列出来(RemoteAgentsStrip)。
 * - **收**:云端 Agent 此刻有没有一轮在跑(`key: 'cloud-run'`,见下「云端 Agent 此刻在不在跑」),成员列表的计数与「离线,Agent 在跑」标记用。
 *
 * **兼容**:旧版文档服务不认识 `presence.*`,回 `error { reason: 'unsupported' }`:记下这条连接不支持,之后不再发,
 * 不报错、不断线(`markUnsupported`)。
 *
 * 不认识 store 以外的界面;连接由 syncManager 交进来(`setPresenceLink`),免得两边互相引用。
 */
import { useSyncExternalStore } from "react";
import { republishSelection, setSelectionLink } from "./selectionPresence.ts";

interface LinkLike {
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

export interface EditingEntityWire {
  clipId: string;
  kind: "drag" | "text" | "recent";
  remainingMs?: number;
}

/** 云端 Agent 服务在在场状态里挂的那一项:有一轮在跑时 `presence.set { key: 'cloud-run', ttlMs: 90000, data: { v: 1, kind: 'cloud-run', runs } }`,每 30 秒续一次,最后一轮结束时清掉 */
export const CLOUD_RUN_KEY = "cloud-run";

export interface RemoteAgent {
  id: string;
  member: string;
  vendor: string | null;
  /** 这是那位成员的云端 Agent(来源身份带 `service: 'agent'`) */
  cloud?: boolean;
  scope: string;
  expiresAt: number;
}

/** 页面「正在编辑」的过期时间:与 A2 服务端看板的续期口径一致(页面每 5 秒心跳一次) */
export const EDITING_TTL_MS = 15_000;

let current: { link: LinkLike; projectId: string; me: string } | null = null;
const unsupported = new WeakSet<LinkLike>();
let lastEditing: { session: string; entities: EditingEntityWire[] } | null = null;
/** 这条连接上有没有发布过(撤销只在发布过时发) */
const published = new WeakSet<LinkLike>();

/** 共享项目 userId 是「用户名@设备」,只取用户名;本机空间是 null */
export function memberOf(userId: unknown): string | null {
  if (typeof userId !== "string" || !userId || userId === "local" || userId === "anonymous") return null;
  const at = userId.indexOf("@");
  return at > 0 ? userId.slice(0, at) : userId;
}

function markReply(link: LinkLike, reply: Record<string, unknown> | null) {
  if (reply && reply.type === "error" && reply.reason === "unsupported") unsupported.add(link);
}

/** syncManager 换了连接(或断开:null)时交进来。`me` 是本页面的 userId(别人的 Agent 与自己的区分开) */
export function setPresenceLink(link: LinkLike | null, projectId: string | null, me: string, accountSelections = false): void {
  setSelectionLink(accountSelections ? link : null, accountSelections ? projectId : null);
  current = link && projectId ? { link, projectId, me } : null;
  remote.clear();
  cloudRuns.clear();
  emit();
  emitCloudRuns();
  if (current) {
    void refresh();
    if (lastEditing && lastEditing.entities.length) publishEditing(lastEditing.session, lastEditing.entities);
  }
}

/**
 * 同一条 `SyncLink` 底下换了一条连接(断线重连、账号项目到期前换会话):跟着连接走的在场状态在新连接上重建 ——
 * 选区重发;「正在编辑」重发(文档服务按连接记是谁发的,旧连接关掉时只撤它自己发的那条,新连接续上的不受影响);
 * 别的成员那边的 Agent 重新取一次(断着的那一会儿可能漏了变化)。
 */
export function resyncPresenceLink(): void {
  const c = current;
  if (!c) return;
  republishSelection();
  void refresh();
  if (lastEditing && lastEditing.entities.length) publishEditing(lastEditing.session, lastEditing.entities);
}

/** 页面「正在编辑」的片段(A2 的汇总每次变化、每次心跳调一次);空数组 = 撤掉 */
export function publishEditing(session: string, entities: EditingEntityWire[]): void {
  lastEditing = { session, entities };
  const c = current;
  if (!c || unsupported.has(c.link)) return;
  const link = c.link;
  if (!entities.length) {
    if (!published.has(link)) return;
    published.delete(link);
    link.request({ type: "presence.clear", projectId: c.projectId, session, key: "editing" }, 5000).then((r) => markReply(link, r), () => {});
    return;
  }
  published.add(link);
  link
    .request({ type: "presence.set", projectId: c.projectId, session, key: "editing", ttlMs: EDITING_TTL_MS, data: { v: 1, kind: "editing", session, entities: entities.slice(0, 64) } }, 5000)
    .then((r) => markReply(link, r), () => {});
}

/* ---------------- 收:别的成员那边的 Agent ---------------- */

const remote = new Map<string, RemoteAgent>();
const listeners = new Set<() => void>();
let snapshot: RemoteAgent[] = [];

function emit() {
  const t = Date.now();
  snapshot = [...remote.values()].filter((a) => a.expiresAt > t).sort((a, b) => (a.member + a.id < b.member + b.id ? -1 : 1));
  for (const l of [...listeners]) l();
}

function ingest(e: Record<string, unknown>) {
  const key = typeof e.key === "string" ? e.key : "";
  if (key === CLOUD_RUN_KEY) { ingestCloudRun(e); return; }
  if (!key.startsWith("agent:")) return;
  const id = key.slice("agent:".length);
  const from = (e.from ?? {}) as Record<string, unknown>;
  const data = e.data as Record<string, unknown> | null;
  if (!data || typeof data.scope !== "string" || !data.scope) {
    remote.delete(id);
    return;
  }
  // 自己这台机器上的 Agent 不算「别的成员」(本机空间里 userId 都是 local)
  if (current && (from.userId === current.me || memberOf(from.userId) === null)) return;
  remote.set(id, {
    id,
    member: memberOf(from.userId) ?? "?",
    vendor: typeof data.vendor === "string" ? data.vendor : null,
    ...(from.service === "agent" ? { cloud: true } : {}),
    scope: data.scope,
    expiresAt: typeof e.expiresAt === "number" ? e.expiresAt : Date.now() + 30 * 60_000,
  });
}

/** syncManager 的旁路消息里 `presence.*` 交到这里 */
export function receivePresence(msg: Record<string, unknown>): void {
  if (!current || (msg.projectId !== undefined && msg.projectId !== current.projectId)) return;
  if (msg.type === "presence.update") {
    ingest(msg);
    if (msg.key === CLOUD_RUN_KEY) emitCloudRuns();
    else emit();
  } else if (msg.type === "presence.state" && Array.isArray(msg.entries)) {
    for (const e of msg.entries) if (e && typeof e === "object") ingest(e as Record<string, unknown>);
    emit();
    if (msg.entries.some((e) => (e as { key?: unknown } | null)?.key === CLOUD_RUN_KEY)) emitCloudRuns();
  }
}

/* ---------------- 云端 Agent 此刻在不在跑 ----------------
 *
 * 云端 Agent 的连接在一轮结束后还会连着(闲置 10 分钟才回收),所以「这位成员名下有没有云端 Agent 的连接」说不清它在不在干活。
 * Agent 服务在有一轮在跑的时候经它自己的连接挂一项 `cloud-run`(带过期时间,每 30 秒续),最后一轮结束时撤掉,连接断了文档服务也会撤销;
 * 页面据此维护一张「哪些成员(`from.userId`,即 `用户名@设备号`,与成员行的 `${row.username}@${row.deviceId}` 同一写法)的云端 Agent 此刻有一轮在跑」的表。
 *
 * - 只认来源身份带 `service: 'agent'` 的条目(来源由文档服务按连接的身份写,页面发来的伪造不了);
 * - **自己的那一行也算**:不套 `agent:` 条目那条「自己的不算」的过滤(那条是为了不在 AI 栏上列自己的本机 Agent);
 * - 同一位成员可以有几条(几个对话、几条连接),只要有一条没过期且 `runs` > 0 就算在跑;
 * - 过期自动不算:读的时候按当前时间滤,并在最近一条到期时通知订阅者重画;换项目、断开时清空。
 */

const cloudRuns = new Map<string, { userId: string; runs: number; expiresAt: number }>();
const cloudListeners = new Set<() => void>();
const EMPTY_RUNNING: ReadonlySet<string> = new Set();
let cloudSnapshot: ReadonlySet<string> = EMPTY_RUNNING;
/** 快照里最早到期的那一条的时间;到了就要重算 */
let cloudSnapshotUntil = Infinity;
let cloudTimer: ReturnType<typeof setTimeout> | null = null;

function recomputeCloudRuns(): boolean {
  const t = Date.now();
  const ids = new Set<string>();
  let until = Infinity;
  for (const [k, v] of cloudRuns) {
    if (v.expiresAt <= t) { cloudRuns.delete(k); continue; }
    ids.add(v.userId);
    if (v.expiresAt < until) until = v.expiresAt;
  }
  cloudSnapshotUntil = until;
  const same = ids.size === cloudSnapshot.size && [...ids].every((x) => cloudSnapshot.has(x));
  if (same) return false;
  cloudSnapshot = ids.size ? ids : EMPTY_RUNNING;
  return true;
}

function emitCloudRuns() {
  recomputeCloudRuns();
  if (cloudTimer !== null) { clearTimeout(cloudTimer); cloudTimer = null; }
  if (Number.isFinite(cloudSnapshotUntil)) {
    // 最近一条到期时再算一次、通知订阅者(没有订阅者时也只是空转一次)
    cloudTimer = setTimeout(() => { cloudTimer = null; emitCloudRuns(); }, Math.max(0, cloudSnapshotUntil - Date.now()) + 20);
    (cloudTimer as { unref?: () => void }).unref?.();
  }
  for (const l of [...cloudListeners]) l();
}

function ingestCloudRun(e: Record<string, unknown>) {
  const from = (e.from ?? {}) as Record<string, unknown>;
  const userId = typeof from.userId === "string" ? from.userId : "";
  if (!userId || from.service !== "agent") return;
  const id = JSON.stringify([userId, from.deviceId ?? null, from.conversation ?? null, from.session ?? null]);
  const data = e.data as Record<string, unknown> | null;
  const runs = data && typeof data === "object" && data.kind === "cloud-run" && typeof data.runs === "number" ? Math.floor(data.runs) : 0;
  if (!data || runs < 1) {
    cloudRuns.delete(id);
    return;
  }
  cloudRuns.set(id, { userId, runs, expiresAt: typeof e.expiresAt === "number" && e.expiresAt > 0 ? e.expiresAt : Date.now() + 90_000 });
}

/** 取一次现有的在场状态;连接还没就绪就隔 2 秒再试(最多 15 次),换了连接就停 */
async function refresh() {
  const c = current;
  for (let i = 0; i < 15; i += 1) {
    if (!c || current !== c || unsupported.has(c.link)) return;
    try {
      const reply = await c.link.request({ type: "presence.list", projectId: c.projectId }, 5000);
      markReply(c.link, reply);
      if (current === c) receivePresence(reply);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** 此刻云端 Agent 有一轮在跑的成员(`用户名@设备号`)。同一次变化之间返回同一个对象 */
export function cloudRunning(): ReadonlySet<string> {
  if (cloudSnapshotUntil <= Date.now()) recomputeCloudRuns();
  return cloudSnapshot;
}

export function subscribeCloudRunning(cb: () => void): () => void {
  cloudListeners.add(cb);
  return () => { cloudListeners.delete(cb); };
}

export function useCloudRunning(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeCloudRunning, cloudRunning, cloudRunning);
}

export function remoteAgents(): RemoteAgent[] {
  return snapshot;
}

export function subscribeRemoteAgents(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useRemoteAgents(): RemoteAgent[] {
  return useSyncExternalStore(subscribeRemoteAgents, remoteAgents, remoteAgents);
}

/** 测试与诊断 */
export function presenceStatus(): { linked: boolean; unsupported: boolean; remote: number; cloudRunning: number } {
  return { linked: !!current, unsupported: !!current && unsupported.has(current.link), remote: snapshot.length, cloudRunning: cloudRunning().size };
}
