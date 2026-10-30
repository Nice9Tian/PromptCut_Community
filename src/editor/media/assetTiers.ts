/**
 * 页面这一侧的两档素材(`docs/plan/c66-design.md` 第 4 节;任务书 `docs/plan/cloud-task.md` A1「换档判据」):
 *
 * - **轮询**:每 2 秒向**当前连接的素材服务**问 `GET media/<hash>/chunks`,把报 `complete` 的哈希集合交给
 *   换档判据(`src/render/mediaTier.ts` 的 `chooseTier`):舞台经 `setLocalHashes` 下发、主文档的声音层直接读。
 *   只问还没到顶档的那一档:素材原尺寸到齐了这份素材就不再问;哈希不可变,问到齐的不会再变回去。
 *   连本地素材服务时问的是本机 `/api/asset`;进了共享项目问的是那个项目的远程素材服务(带只读素材票据)——
 *   本机缓存落没落盘不作判据(`docs/semantics/mechanism/asset-service.md`「同步状态只问素材服务」)。
 * - **远程素材服务**:进入共享项目时由 `syncManager` 设(`connectSharedAssets`),同时告诉本机编辑器进程
 *   (`POST /api/media/remote`),读路由才会按需拉取、预取队列才会动。票据按时续签后再推一次。
 * - **上传目标**:进入共享项目时把远程素材服务基址和一张 `rw` 素材票据交给编辑器进程的上传队列
 *   (`POST /api/media/upload-queue/target`),剩 1/3 有效期时续签;离开时推 `{ base: null }`(设计稿第 9 节第 1 条)。
 * - **预取**:项目的素材表变了(打开项目、导入)且连着远程素材服务时,把 `prefetchOrder` 的清单交给编辑器进程。
 * - **导出前的拦截**:`exportGate` 问当前素材服务,时间轴上用到的素材原尺寸哪些还没 `complete`。
 *
 * 集合里带一个标记(`TIERS_KNOWN_LOCAL` / `TIERS_KNOWN_REMOTE`):「问过了、一个都没到齐」和「还没问过」分得开。
 */
import { withoutConfirmedMissing } from "../../audio/missingMaterialRecord";
import { useSyncExternalStore } from "react";
import type { Project } from "../../kernel/project";
import { getState, subscribe } from "../../store/project";
import { noteRenderNodeAssetBase } from "../sync/renderNodeHandoff";
import {
  TIERS_KNOWN_LOCAL, TIERS_KNOWN_REMOTE, missingOriginals, originalHashOf, prefetchOrder, smallHashOf, type MissingOriginal,
} from "../../render/mediaTier";

/** 轮询间隔(A1:每 2 秒) */
export const POLL_MS = 2000;
/** 在线页面素材全到齐时,每这么多轮问一次素材服务看它还在不在(`pollOnce`) */
const HEALTH_EVERY = 5;
let idleRounds = 0;
/** 同一轮里同时在飞的 `chunks` 请求数 */
const POLL_CONCURRENCY = 4;
/** 素材票据的有效期(`server/auth/protocol.mjs` 的 `TICKET_TTL.asset`);剩 1/3 时续签 */
const ASSET_TICKET_TTL_MS = 15 * 60_000;

export interface RemoteAssets {
  /** 远程素材服务的 API 基址,形如 `http://<ip>:<port>/api/asset` */
  base: string;
  /** Account cache identity is project scoped even when the public base is shared. */
  accountProjectId?: string;
  /** 取一张只读素材票据;取不到给 null(那就不带,由素材服务回 401) */
  ticket?: (() => Promise<string | null>) & { info?: (opts?: { force?: boolean }) => Promise<{ ticket: string; exp: number } | null> };
}

const LOCAL_BASE = "/api/asset";

/**
 * 在线浏览器模式(c10a 第 2 节「在线页面不请求 `/api/*`」):没有本机编辑器进程,也没有本地素材服务。
 * 由 `Preview` 在挂上时按 `ONLINE` 设(本文件不读编译期常量,单测里没有它)。设了之后:
 * 不再告诉编辑器进程远程素材服务 / 上传目标 / 预取清单,也不问本地素材服务(还没连上远程素材服务时不轮询)。
 */
let noEditorProcess = false;
export function setNoEditorProcess(on: boolean): void {
  noEditorProcess = !!on;
}

/**
 * 当前共享项目的文档服务连接(`connectSharedAssets` 交进来的那一条)。c10a 第 9 节:在线页面按内容库的清单
 * 拉预渲染小尺寸,要在这条连接上 `content.get`(`src/render/snapshotSource.ts` 的在线实现经 `docRequest` 用它)。
 */
let docLink: LinkLike | null = null;
let sharedAssetContext: { link: LinkLike; docBase: string; online: boolean; fallback: string | null } | null = null;
let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
let discoveryGeneration = 0;
export function docRequest(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
  if (!docLink) return Promise.reject(new Error("没连上文档服务"));
  return docLink.request(msg, timeoutMs);
}
export function hasDocLink(): boolean {
  return !!docLink;
}

let remote: RemoteAssets | null = null;
/** 当前素材服务上到齐的哈希(换了素材服务就清空) */
let complete = new Set<string>();
let known = false;
let snapshot: readonly string[] = [];
let serviceGen = 0;
const listeners = new Set<() => void>();

function publish() {
  const next = known ? [remote ? TIERS_KNOWN_REMOTE : TIERS_KNOWN_LOCAL, ...[...complete].sort()] : [];
  if (next.length === snapshot.length && next.every((h, i) => h === snapshot[i])) return;
  snapshot = next;
  for (const l of [...listeners]) l();
}

/** 换档判据用的集合(带标记);还没问过是空数组 */
export function tierHashes(): readonly string[] {
  return snapshot;
}

export function subscribeTierHashes(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useTierHashes(): readonly string[] {
  return useSyncExternalStore(subscribeTierHashes, tierHashes, tierHashes);
}

/** 当前连的是不是远程素材服务(基址);本地给 null */
export function remoteAssetBase(): string | null {
  return remote?.base ?? null;
}

/**
 * 当前远程素材服务是不是账号云端项目的(是就回那个项目号,不是回 null)。账号项目的素材票据由账号会话签发
 * (`syncManager.ts` 的 `enterAccountProject`),读写是同一张、权限跟着成员走;旧的 `auth.ticket` 在账号连接上被拒,
 * 要写素材的地方据此改用 `remoteAssetTicketInfo`。
 */
export function remoteAccountProjectId(): string | null {
  return remote?.accountProjectId ?? null;
}

/**
 * 当前远程素材服务的只读票据连同过期时刻(C10 契约第 12 节:逐帧导出续签票据的 `fetchTicket`,`src/export/ticketRenewal.ts`)。
 * `force`:不管手里那张还剩多久,换一张新的。本地素材服务、取不到给 null。
 */
export async function remoteAssetTicketInfo(force = false): Promise<{ ticket: string; exp: number } | null> {
  const info = remote?.ticket?.info;
  if (!info) return null;
  try { return await info({ force }); } catch { return null; }
}

/** 当前远程素材服务的只读票据(在线页面给 `<video>` 的查询串、取预渲染小尺寸用;c10a 第 8、9 节);本地给 null */
export async function remoteAssetTicket(): Promise<string | null> {
  if (!remote?.ticket) return null;
  try { return (await remote.ticket()) || null; } catch { return null; }
}

const remoteListeners = new Set<() => void>();
/** 远程素材服务换了(进入 / 离开共享项目)时通知;回退订 */
export function subscribeRemoteAssets(cb: () => void): () => void {
  remoteListeners.add(cb);
  return () => { remoteListeners.delete(cb); };
}

/** 带当前素材票据的请求头(`Authorization: Bearer`);本地素材服务给空对象 */
export async function assetAuthHeaders(): Promise<Record<string, string>> {
  return authHeaders();
}

async function authHeaders(): Promise<Record<string, string>> {
  if (!remote?.ticket) return {};
  try {
    const t = await remote.ticket();
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

let pushedTicket: string | null = null;
/** 告诉本机编辑器进程(按需拉取与预取靠它);在线浏览器模式没有本机编辑器,失败就算了 */
async function pushRemoteToEditor(): Promise<void> {
  if (noEditorProcess) return;
  try {
    if (!remote) {
      pushedTicket = null;
      await fetch("/api/media/remote", { method: "DELETE" });
      return;
    }
    const auth = await authHeaders();
    const ticket = auth.Authorization ? auth.Authorization.slice("Bearer ".length) : null;
    pushedTicket = ticket;
    await fetch("/api/media/remote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base: remote.base, ticket }) });
  } catch { /* 没有本机编辑器 */ }
}

/**
 * 设当前连接的远程素材服务;null = 回到本地素材服务。换了就清空集合、立刻重问一轮、重排预取。
 */
export function setRemoteAssets(next: RemoteAssets | null): void {
  const base = next ? next.base.replace(/\/+$/, "") : null;
  if ((remote?.base ?? null) === base && remote?.accountProjectId === next?.accountProjectId) {
    if (next && remote) remote.ticket = next.ticket;
    return;
  }
  remote = next ? { ...next, base: base! } : null;
  serviceGen++;
  setRemoteDown(false);
  complete = new Set();
  known = false;
  publish();
  lastPrefetchKey = "";
  for (const l of [...remoteListeners]) { try { l(); } catch { /* 一个订阅者坏了不影响别人 */ } }
  void pushRemoteToEditor().then(() => { kick(); });
}

/**
 * 问当前素材服务:这些哈希里哪些 `complete`。问不到的算没到齐。
 */
export async function askComplete(hashes: readonly string[]): Promise<Set<string>> {
  const base = remote?.base ?? LOCAL_BASE;
  const gen = serviceGen;
  const headers = await authHeaders();
  const out = new Set<string>();
  const queue = [...new Set(hashes)];
  let answered = 0, unreachable = 0;
  const worker = async () => {
    for (let h = queue.shift(); h; h = queue.shift()) {
      let r: Response;
      try {
        r = await fetch(`${base}/media/${h}/chunks`, { headers, cache: "no-store", ...(remote?.accountProjectId ? { credentials: 'omit' as const } : {}) });
      } catch { unreachable++; continue; } // 网络错误:连不上素材服务
      answered++;
      try {
        if (!r.ok) continue;
        const body = await r.json();
        if (body?.complete === true) out.add(h);
      } catch { /* 算没到齐 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POLL_CONCURRENCY, queue.length) }, worker));
  // 远程素材服务连不连得上(在线页面顶栏「连不上素材服务」用):这一轮一个回应都没有、全是网络错误才算连不上
  if (remote && gen === serviceGen && (answered || unreachable)) setRemoteDown(answered === 0);
  return out;
}

/* ---------------- 远程素材服务连不连得上(C10 契约第 10 节) ---------------- */

let remoteDown = false;
const healthListeners = new Set<() => void>();
function setRemoteDown(down: boolean): void {
  if (down === remoteDown) return;
  remoteDown = down;
  for (const l of [...healthListeners]) { try { l(); } catch { /* 同上 */ } }
}
/** 最近一轮问远程素材服务时一个回应都没拿到(网络错误,不是 4xx/5xx)。本地素材服务、还没问过都给 false */
export function remoteAssetsDown(): boolean {
  return !!remote && remoteDown;
}
export function subscribeRemoteAssetsHealth(cb: () => void): () => void {
  healthListeners.add(cb);
  return () => { healthListeners.delete(cb); };
}

/** 这一轮要问的哈希:素材原尺寸还没到齐的素材问素材原尺寸,素材小尺寸还没到齐的也问素材小尺寸;全到顶档的不问 */
export function hashesToAsk(project: Pick<Project, "media">, done: ReadonlySet<string>): string[] {
  const ask: string[] = [];
  for (const m of project.media ?? []) {
    const o = originalHashOf(m);
    if (!o || done.has(o)) continue;
    ask.push(o);
    const s = smallHashOf(m);
    if (s && !done.has(s)) ask.push(s);
  }
  return [...new Set(ask)];
}

/** 跑一轮轮询(导出前、切换素材服务后也直接调) */
export async function pollOnce(project: Pick<Project, "media"> = getState().project): Promise<void> {
  // 在线页面没有本地素材服务:还没连上远程素材服务就不问
  if (noEditorProcess && !remote) return;
  const gen = serviceGen;
  const ask = hashesToAsk(project, complete);
  /*
   * 在线页面:素材全到齐之后这一轮本来什么都不问,也就看不出素材服务断没断。每 `HEALTH_EVERY` 轮
   * 顺带问一张已经到齐的素材原尺寸(一个很小的对账请求),只为顶栏的「连不上素材服务」。
   */
  if (!ask.length && noEditorProcess && remote && ++idleRounds % HEALTH_EVERY === 0) {
    const probe = (project.media ?? []).map(originalHashOf).find(Boolean);
    if (probe) ask.push(probe);
  }
  const got = ask.length ? await askComplete(ask) : new Set<string>();
  if (gen !== serviceGen) return; // 这一轮问的是换掉之前的素材服务
  for (const h of got) complete.add(h);
  known = true;
  publish();
}

/* ---------------- 预取 ---------------- */

let lastPrefetchKey = "";
async function maybePrefetch(project: Project): Promise<void> {
  if (!remote || noEditorProcess) return;
  const items = prefetchOrder(project);
  const key = `${remote.base}|${items.map((i) => i.hash).join(",")}`;
  if (key === lastPrefetchKey) return;
  lastPrefetchKey = key;
  try {
    await fetch("/api/media/prefetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
  } catch { /* 没有本机编辑器 */ }
}

/* ---------------- 轮询循环 ---------------- */

let timer: ReturnType<typeof setTimeout> | null = null;
let running = 0;
let polling = false;

function kick() {
  if (!running) return;
  if (timer) clearTimeout(timer);
  timer = null;
  void loop();
}

async function loop() {
  if (polling) return;
  polling = true;
  try {
    const project = getState().project;
    // 票据续签过:编辑器进程那份也换掉(它拿这张去按需拉取)
    if (remote?.ticket) {
      const auth = await authHeaders();
      const t = auth.Authorization ? auth.Authorization.slice("Bearer ".length) : null;
      if (t && t !== pushedTicket) await pushRemoteToEditor();
    }
    await pollOnce(project);
    await maybePrefetch(project);
  } finally {
    polling = false;
    if (running && !timer) timer = setTimeout(() => { timer = null; void loop(); }, POLL_MS);
  }
}

/**
 * 开始轮询(预览挂上时调),回停止函数。素材表换了(打开别的项目、导入)立刻问一轮,不等 2 秒。
 * 可以重复调,引用计数。
 */
export function startAssetTiers(): () => void {
  running++;
  let lastMedia = getState().project.media;
  const unsub = subscribe(() => {
    const media = getState().project.media;
    if (media === lastMedia) return;
    lastMedia = media;
    kick();
  });
  if (running === 1) {
    // 页面重载过:编辑器进程那边可能还留着上一个页面设的远程素材服务,按本页面的状态对齐一次
    void pushRemoteToEditor();
    kick();
  }
  return () => {
    unsub();
    running = Math.max(0, running - 1);
    if (!running && timer) { clearTimeout(timer); timer = null; }
  };
}

/* ---------------- 导出前的拦截 ---------------- */

/**
 * 导出前问一遍当前素材服务:时间轴上用到的素材原尺寸哪些还没 `complete`(A1「导出只用素材原尺寸」「等待上传方」)。
 * 空数组 = 可以导出。
 */
export async function exportGate(source: Project): Promise<MissingOriginal[]> {
  // 认定过「确认缺失」的素材不会再到齐:不拦,导出时照原位置出占位
  const project = withoutConfirmedMissing(source);
  const first = missingOriginals(project, []);
  if (!first.length) return [];
  const got = await askComplete(first.map((m) => m.hash));
  for (const h of got) complete.add(h);
  return missingOriginals(project, got);
}

/** 不发请求的快速判断:按轮询到的集合。还没问过给 null(不知道) */
export function exportGateNow(project: Project): MissingOriginal[] | null {
  if (!known) return null;
  return missingOriginals(withoutConfirmedMissing(project), complete);
}

/* ---------------- 共享项目 ---------------- */

interface LinkLike {
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

/**
 * 按 `auth.ticket` 取只读素材票据,剩 1/3 有效期时换新的。「有效期」按这一张实际的寿命算(签发到过期),不写死 15 分钟:
 * 测试里缩短了票据时限(C10 契约第 12 节的验收)时照样提前换。
 * 回的函数带 `info({ force })`:连同过期时刻给出(逐帧导出的续签用,`src/export/ticketRenewal.ts`)。
 */
export function assetTicketSource(link: LinkLike, now: () => number = Date.now): (() => Promise<string | null>) & { info: (opts?: { force?: boolean }) => Promise<{ ticket: string; exp: number } | null> } {
  let cur: { ticket: string; exp: number; issued: number } | null = null;
  let inflight: Promise<{ ticket: string; exp: number } | null> | null = null;
  const fresh = () => !!cur && cur.exp - now() > Math.min(ASSET_TICKET_TTL_MS, Math.max(0, cur.exp - cur.issued)) / 3;
  const take = (): Promise<{ ticket: string; exp: number } | null> => {
    inflight ??= link.request({ type: "auth.ticket", kind: "asset", access: "r" }).then((r) => {
      if (r.type === "auth.ticket.ok" && typeof r.ticket === "string") {
        const issued = now();
        cur = { ticket: r.ticket, exp: Number(r.exp) || issued + ASSET_TICKET_TTL_MS, issued };
        return { ticket: cur.ticket, exp: cur.exp };
      }
      return null;
    }, () => null).finally(() => { inflight = null; });
    return inflight;
  };
  const get = async () => {
    if (fresh()) return cur!.ticket;
    return (await take())?.ticket ?? null;
  };
  get.info = async (opts: { force?: boolean } = {}) => {
    if (!opts.force && fresh()) return { ticket: cur!.ticket, exp: cur!.exp };
    return take();
  };
  return get;
}

/**
 * 从文档服务的服务地址登记(`service.watch`,kind `asset`)里挑这个共享项目的素材服务:
 * 优先和文档服务同一台主机的那一个;指向本页面自己的(本机就是主机)不算远程。
 *
 * 在线浏览器模式(`online`)不排除同主机的:在线页面、文档服务、素材服务都在托管端的同一个源下
 * (nginx 的 `/editor`、`/hosted/`、`/media/`,c10a 契约第 2 节),同源的素材服务正是远端那一个,
 * 本页面自己并没有素材服务。
 */
export function pickAssetEndpoint(endpoints: unknown, docBase: string, selfHost: string, { online = false }: { online?: boolean } = {}): string | null {
  const urls: string[] = [];
  for (const e of Array.isArray(endpoints) ? endpoints : []) {
    const rec = e as { kind?: unknown; urls?: unknown };
    if (rec?.kind !== undefined && rec.kind !== "asset") continue;
    for (const u of Array.isArray(rec?.urls) ? rec.urls : []) if (typeof u === "string") urls.push(u);
  }
  let docHost = "";
  try { docHost = new URL(docBase).hostname; } catch { /* 留空 */ }
  const ok = urls.filter((u) => { try { return online || new URL(u).host !== selfHost; } catch { return false; } });
  return ok.find((u) => { try { return new URL(u).hostname === docHost; } catch { return false; } }) ?? ok[0] ?? null;
}

/**
 * 放本机(局域网)项目的素材服务后备地址(M8-X1):素材服务与文档服务在主机的同一个编辑器进程里
 * (`docs/semantics/product/document-service.md`「部署组合」),主机不一定向服务地址登记素材服务
 * (`server/vite-plugin-media.ts` 只在设了 `PROMPTCUT_DOCSERVICE_URL` 时登记)。先用局域网发现通告里的
 * `asset`,没有(手填地址、邀请链接)就按文档服务地址推同一进程的 `/api/asset`——与独立渲染主机的推法相同
 * (`server/vite-plugin-frames.ts` 的 `hostAssetClient`)。放云端不推:托管组合的素材服务不在 `/api/asset`,
 * 且它已登记。
 */
export function lanAssetBaseOf(candidate: { where?: string; base?: string; asset?: string } | null | undefined): string | null {
  if (candidate?.where !== "lan") return null;
  const valid = (u: unknown): string | null => {
    if (typeof u !== "string" || !u) return null;
    try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? u.replace(/\/+$/, "") : null; } catch { return null; }
  };
  const announced = valid(candidate.asset);
  if (announced) return announced;
  try {
    const u = new URL(String(candidate.base ?? ""));
    const proto = u.protocol === "wss:" || u.protocol === "https:" ? "https:" : u.protocol === "ws:" || u.protocol === "http:" ? "http:" : null;
    return proto ? `${proto}//${u.host}/api/asset` : null;
  } catch { return null; }
}

/** 登记里挑不到时用后备;后备指向本页面自己(本机就是主机)的不算远程 */
function withFallback(picked: string | null, fallback: string | null, online: boolean): string | null {
  if (picked || !fallback) return picked;
  if (online) return fallback;
  const selfHost = typeof location === "undefined" ? "" : location.host;
  try { return new URL(fallback).host === selfHost ? null : fallback; } catch { return null; }
}
function relayAssetBase(docBase: string, fallback: string | null): string | null {
  try { return /^\/hosting\/relay\/sp_[a-z2-7]{26}\/doc\/?$/.test(new URL(docBase).pathname) ? fallback : null; } catch { return null; }
}

/**
 * 进入共享项目后调:从服务地址登记里挑素材服务、设成当前远程素材服务。登记里挑不到时用 `fallback`
 * (放本机项目由 `lanAssetBaseOf` 给);都没有、或指向本页面自己(本机就是主机)就留在本地素材服务。回挑中的基址。
 * `online`:在线浏览器模式(调用方按 `mode.ts` 的 `ONLINE` 给;本模块会被 Node 单测载入,不静态引 `mode.ts`)。
 */
export async function connectSharedAssets(link: LinkLike, docBase: string, { online = false, fallback = null, account }: { online?: boolean; fallback?: string | null; account?: { base: string; projectId: string; ticket: NonNullable<RemoteAssets['ticket']> } } = {}): Promise<string | null> {
  // Account tickets are issued by the HTTP session authority. v2 forbids the old
  // service.watch/auth.ticket protocols; keep them exclusively on the LAN branch.
  if (account) {
    discoveryGeneration++;
    if (discoveryTimer !== null) clearTimeout(discoveryTimer);
    discoveryTimer = null; sharedAssetContext = null; docLink = link;
    setRemoteAssets({ base: account.base, accountProjectId: account.projectId, ticket: account.ticket });
    stopUploadTarget?.();
    stopUploadTarget = startUploadTarget(link, account.base, { accountTicket: account.ticket.info });
    return account.base;
  }
  let base: string | null = null;
  // 同一条连接重连后再调(重新订阅登记):已经挑好的素材服务不因一次失败退回本地,挑到同一个也不重设
  const again = docLink === link && remote !== null;
  let failed = false;
  const generation = ++discoveryGeneration;
  if (discoveryTimer !== null) clearTimeout(discoveryTimer);
  discoveryTimer = null;
  sharedAssetContext = { link, docBase, online, fallback };
  docLink = link;
  try {
    const r = await link.request({ type: "service.watch", kinds: ["asset"] });
    base = pickAssetEndpoint(r.endpoints, docBase, typeof location === "undefined" ? "" : location.host, { online });
  } catch { failed = true; /* 取不到登记:用后备,没有就留在本地 */ }
  base = relayAssetBase(docBase, fallback) ?? withFallback(base, fallback, online);
  if (generation !== discoveryGeneration || docLink !== link) return null;
  if (again && remote && (failed || base === remote.base)) {
    if (failed) discoveryTimer = setTimeout(() => {
      discoveryTimer = null;
      if (docLink === link) void connectSharedAssets(link, docBase, { online, fallback });
    }, 2000);
    return remote.base;
  }
  setRemoteAssets(base ? { base, ticket: assetTicketSource(link) } : null);
  stopUploadTarget?.();
  stopUploadTarget = startUploadTarget(link, base);
  // 在线页面没有本地素材服务：登记请求失败或服务尚未出现，都要继续找。
  if (online && !base) discoveryTimer = setTimeout(() => {
    discoveryTimer = null;
    if (docLink === link) void connectSharedAssets(link, docBase, { online, fallback });
  }, 2000);
  return base;
}

/** 文档服务的 service.watch 后续全量通知；素材服务晚登记也能接上。 */
export function receiveSharedAssetEndpoints(endpoints: unknown): void {
  const ctx = sharedAssetContext;
  if (!ctx || docLink !== ctx.link) return;
  const base = relayAssetBase(ctx.docBase, ctx.fallback) ?? withFallback(pickAssetEndpoint(endpoints, ctx.docBase, typeof location === "undefined" ? "" : location.host, { online: ctx.online }), ctx.fallback, ctx.online);
  if ((remote?.base ?? null) === base) return;
  discoveryGeneration++;
  if (discoveryTimer !== null) clearTimeout(discoveryTimer);
  discoveryTimer = null;
  setRemoteAssets(base ? { base, ticket: assetTicketSource(ctx.link) } : null);
  stopUploadTarget?.();
  stopUploadTarget = startUploadTarget(ctx.link, base);
  if (ctx.online && !base) discoveryTimer = setTimeout(() => {
    discoveryTimer = null;
    if (docLink === ctx.link) void connectSharedAssets(ctx.link, ctx.docBase, { online: true, fallback: ctx.fallback });
  }, 2000);
}

/** 离开共享项目:回到本地素材服务 */
export function disconnectSharedAssets(): void {
  discoveryGeneration++;
  if (discoveryTimer !== null) clearTimeout(discoveryTimer);
  discoveryTimer = null;
  sharedAssetContext = null;
  docLink = null;
  setRemoteAssets(null);
  stopUploadTarget?.();
  stopUploadTarget = startUploadTarget(null, null);
}

/* ---------------- 上传目标(设计稿第 9 节第 1 条) ---------------- */

/**
 * 编辑器进程的上传队列(`server/upload-queue.mjs`)要知道「当前连接的素材服务」和一张能写的票据,
 * 它自己没有项目凭证,由页面给:进入共享项目时 `POST /api/media/upload-queue/target { base, ticket }`
 * (`rw` 素材票据,经本页面的文档服务连接签),票据剩 1/3 有效期时续签再推一次;离开共享项目、
 * 或本机就是主机(挑不到远程素材服务)时推 `{ base: null }`,队列回到「本机素材服务 = 空操作」。
 * 没有本机编辑器(在线浏览器模式)时推送失败就算了。
 */
let stopUploadTarget: (() => void) | null = null;

export interface UploadTargetDeps {
  accountTicket?: (opts?: { force?: boolean }) => Promise<{ ticket: string; exp: number } | null>;
  post?: (body: { base: string | null; ticket?: string | null }) => Promise<void>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

async function postUploadTarget(body: { base: string | null; ticket?: string | null }): Promise<void> {
  if (noEditorProcess) return;
  try {
    await fetch("/api/media/upload-queue/target", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch { /* 没有本机编辑器 */ }
}

/** 签不到票据时隔多久再试 */
const UPLOAD_TICKET_RETRY_MS = 30_000;

/**
 * 把上传目标交给编辑器进程并按时续签,回停止函数(停止时推 `{ base: null }`)。
 * `link` / `base` 为 null:只推一次 `{ base: null }`。
 */
export function startUploadTarget(link: LinkLike | null, base: string | null, deps: UploadTargetDeps = {}): () => void {
  const post = deps.post ?? postUploadTarget;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.(); // Node(单测)里不拖住进程;浏览器没有 unref
    return t;
  });
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let stopped = false;
  let timer: unknown = null;
  setUploadTargetReady(null);
  // 本机就是主机(有连接、挑不到远程素材服务):导入就是写进这个项目的素材服务,导入的素材不用记;没有连接(离开共享项目)时记下的丢掉
  uploadTargetLocal = !!link && !base;
  if (!link || !base) deferredImports.clear();
  // 自动渲染节点(`sync/renderNodeHandoff.ts`):预渲染进程推产物用同一个素材服务(本机就是主机时为 null,它推本机的)
  noteRenderNodeAssetBase(link && base ? base : null);
  if (!link || !base) {
    void post({ base: null });
    return () => { /* 本来就是本机 */ };
  }
  const renew = async () => {
    timer = null;
    if (stopped) return;
    const issued = now();
    let ticket: string | null = null;
    let exp = issued + ASSET_TICKET_TTL_MS;
    try {
      if (deps.accountTicket) { const r = await deps.accountTicket(); if (r) { ticket = r.ticket; exp = r.exp; } }
      else {
        const r = await link.request({ type: "auth.ticket", kind: "asset", access: "rw" });
        if (r.type === "auth.ticket.ok" && typeof r.ticket === "string") { ticket = r.ticket; exp = Number(r.exp) || exp; }
      }
    } catch { /* 下面按签不到处理 */ }
    if (stopped) return;
    await post({ base, ticket });
    if (stopped) return;
    if (ticket) setUploadTargetReady(base);
    // 剩 1/3 有效期时续:从签发起过了 2/3 的寿命
    const delay = ticket ? Math.max(1000, Math.floor((exp - issued) * 2 / 3)) : UPLOAD_TICKET_RETRY_MS;
    timer = setTimer(() => { void renew(); }, delay);
  };
  void renew();
  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    setUploadTargetReady(null);
    void post({ base: null });
  };
}

/* ---------------- 开启「放云端」时把项目里已有的素材交给上传队列(C10a 集成返工) ---------------- */

/** 编辑器进程已经拿到带 rw 票据的远程上传目标:那个基址;没有是 null */
let uploadTargetReadyBase: string | null = null;
const uploadTargetWaiters = new Set<(base: string) => void>();

function setUploadTargetReady(base: string | null): void {
  uploadTargetReadyBase = base;
  if (!base) return;
  for (const w of [...uploadTargetWaiters]) w(base);
  if (deferredImports.size) void flushDeferredImports();
}

/** 等编辑器进程拿到带 rw 票据的远程上传目标(`startUploadTarget` 第一次带票据推成功);超时回 null */
export function whenUploadTargetReady(timeoutMs = 30_000): Promise<string | null> {
  if (uploadTargetReadyBase) return Promise.resolve(uploadTargetReadyBase);
  return new Promise((resolve) => {
    const done = (base: string | null) => { uploadTargetWaiters.delete(onReady); clearTimeout(t); resolve(base); };
    const onReady = (base: string) => done(base);
    const t = setTimeout(() => done(null), timeoutMs);
    (t as { unref?: () => void }).unref?.();
    uploadTargetWaiters.add(onReady);
  });
}

type ExistingMedia = { id?: string; name?: string; hash?: string; pending?: boolean; tiers?: { original?: string; small?: string } | null };

/** 没法按哈希交给上传队列的一条素材(没有合法哈希):调用方据此提示用户;`pending` 是还在导入、入库后由导入那一路上传 */
export interface SkippedMedia { id?: string; name: string; pending?: boolean }

/**
 * 项目里已有的素材 → 按哈希入队的请求体:一个素材一项,视频两档(`tiers.small`、`tiers.original`),
 * 图片、音频只有素材原尺寸一档;同一素材原尺寸只列一次。没有哈希的(迁移期老素材、还在入库的)进不了队列,
 * **不许悄悄跳过**:一律出现在 `skipped` 里(调用方先补入库,补不上的列给用户)。
 */
export function existingMediaItems(media: readonly ExistingMedia[]): { items: { name: string; original: string; small?: string }[]; skipped: SkippedMedia[] } {
  const seen = new Set<string>();
  const items: { name: string; original: string; small?: string }[] = [];
  const skipped: SkippedMedia[] = [];
  for (const m of media) {
    const original = String(m?.tiers?.original || m?.hash || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(original)) {
      skipped.push({ ...(m?.id ? { id: m.id } : {}), name: String(m?.name ?? ""), ...(m?.pending ? { pending: true } : {}) });
      continue;
    }
    if (seen.has(original)) continue;
    seen.add(original);
    const small = String(m?.tiers?.small || "").toLowerCase();
    items.push({ name: String(m?.name ?? ""), original, ...(/^[0-9a-f]{64}$/.test(small) && small !== original ? { small } : {}) });
  }
  return { items, skipped };
}

export interface EnqueueExistingResult { queued: string[]; missing: string[]; local?: boolean; skipped?: SkippedMedia[] }

/**
 * 开启多用户协作「放云端」之后调:等编辑器进程拿到远程上传目标与 rw 票据,再把项目里已有的素材按哈希交给
 * 上传队列(`deps.post` 发 `POST /api/media/upload-queue/enqueue`,只收本地内容库里有的,缺的回 `missing`)。
 * 之后照 C6.6 队列规则逐个素材、先小后大地传。没有本机编辑器(在线浏览器模式)、等不到目标时回 null。
 * 没有哈希、进不了队列的素材放在结果的 `skipped` 里(调用方应先 `ingestUnhashedMedia` 补入库再调这里)。
 * `post` 由调用方给(`collab.ts` 按编译期的 `ONLINE` 给,在线构建里连同接口地址一起被剪掉)。
 */
export async function enqueueExistingMedia(
  media: readonly ExistingMedia[],
  deps: { post: ((body: unknown) => Promise<EnqueueExistingResult | null>) | null; timeoutMs?: number },
): Promise<EnqueueExistingResult | null> {
  if (!deps.post) return null;
  const { items, skipped } = existingMediaItems(media);
  if (!items.length) return { queued: [], missing: [], skipped };
  if (!(await whenUploadTargetReady(deps.timeoutMs ?? 30_000))) return null;
  const r = await deps.post({ items });
  return r ? { ...r, skipped } : null;
}

/** 已经列给用户看过的「补不上」素材 id:同一页面会话里不反复弹 */
const backfillNotified = new Set<string>();

/**
 * 打开项目后在后台补入库(`io/mediaUpload.ts` 的 `ingestUnhashedMedia`)做完之后调:项目这时已经「放云端」
 * (编辑器进程有带 rw 票据的远程上传目标)的,把这次补上哈希的素材按哈希交给上传队列 —— 图片、音频的入库
 * 不会自己进队列(`server/media-tiers.mjs` 的 prepareImport 只管视频),不交就只在本机,别的成员拿不到;
 * 视频重复交无妨(队列按素材去重)。补不上的、本机内容库里没有的,照开启放云端时的做法用 `deps.notify` 列给用户
 * (同一条素材一个会话里只列一次)。
 * 不是共享项目(`deps.shared` 为假)、或等不到上传目标(本机就是主机、没有本机编辑器)时什么都不做,回 null。
 */
export async function queueBackfilledMedia(
  r: { ingested: readonly string[]; failed: readonly { id?: string; name: string }[] },
  media: readonly ExistingMedia[],
  deps: {
    post: ((body: unknown) => Promise<EnqueueExistingResult | null>) | null;
    shared: () => boolean;
    notify?: (names: string[]) => void;
    timeoutMs?: number;
  },
): Promise<EnqueueExistingResult | null> {
  if (!deps.post || !deps.shared()) return null;
  if (!r.ingested.length && !r.failed.some((f) => !f.id || !backfillNotified.has(f.id))) return null;
  if (!(await whenUploadTargetReady(deps.timeoutMs ?? 30_000))) return null;
  const ids = new Set(r.ingested);
  const picked = media.filter((m) => m?.id && ids.has(m.id));
  let res: EnqueueExistingResult | null = { queued: [], missing: [] };
  if (picked.length) res = await enqueueExistingMedia(picked, deps);
  const nameOfHash = new Map<string, { id?: string; name: string }>();
  for (const m of picked) {
    const h = String(m.tiers?.original || m.hash || "").toLowerCase();
    if (h && !nameOfHash.has(h)) nameOfHash.set(h, { id: m.id, name: String(m.name ?? "") });
  }
  const list = [
    ...r.failed,
    ...(res?.missing ?? []).map((h) => nameOfHash.get(String(h).toLowerCase()) ?? { name: String(h) }),
  ].filter((f) => !f.id || !backfillNotified.has(f.id));
  for (const f of list) if (f.id) backfillNotified.add(f.id);
  if (list.length) deps.notify?.(list.map((f) => f.name));
  return res;
}

/* ---------------- 上传目标就绪之前导入的素材:记下,就绪后补交 ---------------- */

/*
 * 打开共享项目后,上传目标是异步设上的(`connectSharedAssets` 先问服务地址登记,再签 rw 素材票据、推给编辑器进程)。
 * 这之前导入的素材,编辑器进程那一侧(`server/media-tiers.mjs` 的 prepareImport)入队时看到的是本机目标,当空操作丢掉,
 * 别的成员拿不到。页面一侧在导入完成时(`io/mediaUpload.ts` 的 applyUploadedMedia → hooks.afterImport)记下,
 * 上传目标就绪(`setUploadTargetReady`)后按哈希补交给上传队列,走开启放云端时同一个入队口子(`enqueueExistingMedia`)。
 * 上传目标已经就绪时导入的也当场交一次:服务端的入队与导入请求是并行的,赶不赶得上说不准;重复交无妨,队列按素材去重。
 */

/** 素材原尺寸哈希 → 那条素材(同一素材只记一次) */
const deferredImports = new Map<string, ExistingMedia>();
/** 最近一次记下时给的入队口子与提示(补交时用) */
let deferredDeps: ImportQueueDeps | null = null;
/** 当前共享项目本机就是主机(`startUploadTarget(link, null)`) */
let uploadTargetLocal = false;
let deferredFlushing = false;

export interface ImportQueueDeps {
  post: ((body: unknown) => Promise<EnqueueExistingResult | null>) | null;
  shared: () => boolean;
  notify?: (names: string[]) => void;
}

function importHashOf(m: ExistingMedia): string {
  return String(m?.tiers?.original || m?.hash || "").toLowerCase();
}

async function handImported(list: ExistingMedia[], deps: ImportQueueDeps): Promise<EnqueueExistingResult | null> {
  const r = deps.post ? await enqueueExistingMedia(list, { post: deps.post, timeoutMs: 0 }) : null;
  if (!r) return null;
  const nameOf = new Map(list.map((m) => [importHashOf(m), String(m.name ?? "")]));
  const names = (r.missing ?? []).map((h) => nameOf.get(String(h).toLowerCase()) ?? String(h));
  if (names.length) deps.notify?.(names);
  return r;
}

async function flushDeferredImports(): Promise<void> {
  const deps = deferredDeps;
  if (deferredFlushing || !deps || !uploadTargetReadyBase) return;
  if (!deps.post || !deps.shared()) { deferredImports.clear(); return; }
  deferredFlushing = true;
  const list = [...deferredImports.values()];
  deferredImports.clear();
  let r: EnqueueExistingResult | null = null;
  try { r = await handImported(list, deps); } catch { r = null; }
  finally { deferredFlushing = false; }
  // 没交成(编辑器进程没回、期间上传目标又掉了):留着,下一次就绪(续签再推一次)再交;期间已经离开了共享项目的不留
  if (!r && deps.shared() && !uploadTargetLocal) {
    for (const m of list) { const h = importHashOf(m); if (!deferredImports.has(h)) deferredImports.set(h, m); }
  }
  if (deferredImports.size && uploadTargetReadyBase && r) void flushDeferredImports();
}

/**
 * 一条素材导入完成之后调(`sync/backfillUpload.ts` 挂在 hooks.afterImport 上)。共享项目里:上传目标已就绪的当场按哈希
 * 交给上传队列;还没就绪的先记下,就绪后补交;本机内容库里没有的(队列回 missing)用 `deps.notify` 列给用户。
 * 不是共享项目、没有入队的口子(在线构建)、本机就是主机、没有合法哈希时什么都不做,回 null。
 */
export async function queueImportedMedia(media: ExistingMedia, deps: ImportQueueDeps): Promise<EnqueueExistingResult | null> {
  if (!deps.post || !deps.shared() || uploadTargetLocal) return null;
  const hash = importHashOf(media);
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  deferredDeps = deps;
  if (!uploadTargetReadyBase || deferredFlushing) {
    deferredImports.set(hash, media);
    return null;
  }
  const r = await handImported([media], deps);
  if (!r && deps.shared() && !uploadTargetLocal) deferredImports.set(hash, media);
  return r;
}

/** 单测用:还记着、等上传目标就绪的素材原尺寸哈希 */
export function deferredImportsForTest(): string[] {
  return [...deferredImports.keys()];
}

/** 单测用:编辑器进程已经拿到的上传目标基址 */
export function uploadTargetReadyForTest(): string | null {
  return uploadTargetReadyBase;
}

/** 探针与单测的观察口 */
export function assetTiersDebug() {
  return { remote: remote?.base ?? null, known, complete: [...complete].sort(), snapshot: [...snapshot] };
}

/** 单测用 */
export function resetAssetTiersForTest(): void {
  backfillNotified.clear();
  deferredImports.clear();
  deferredDeps = null;
  uploadTargetLocal = false;
  deferredFlushing = false;
  uploadTargetReadyBase = null;
  uploadTargetWaiters.clear();
  remote = null;
  complete = new Set();
  known = false;
  snapshot = [];
  serviceGen++;
  lastPrefetchKey = "";
  listeners.clear();
  stopUploadTarget?.();
  stopUploadTarget = null;
  noEditorProcess = false;
  docLink = null;
  remoteListeners.clear();
}
