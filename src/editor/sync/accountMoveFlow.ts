/**
 * 账号办法的「搬到云端」接到编辑器上(流程本身在 `accountMove.ts`,这里只给它要用的东西):
 * 桌面版的账号客户端(登录恢复凭证在桌面外壳的保险箱里)、当前打开的项目或协作房间、内容的上传与读回、
 * 关掉本机协作(`collab.ts` 的 `disableCollab`,就是「取消多用户协作」走的那条路)、进云端项目(`enterAccountProject`)、
 * 素材交给上传队列(`collab.ts` 的 `queueExistingMedia`,先小尺寸、再原尺寸)。
 *
 * 只在桌面版里用:在线页面没有本机项目可搬(用户 2026-10-13 定这一版在线浏览器不做)。
 */
import { ONLINE } from "../../online/mode";
import { createAccountClient, loadAccountExtensions, projectLink, type Account, type CloudAccountClient } from "./accountExtensions";
import { desktopAccountBridge, isDesktopShellTooOld } from "./desktopShellBridge";
import { createEmptyProject, type Project } from "../../kernel/project";
import { getState } from "../../store/project";
import { hostedWsUrlOf } from "../../online/invite";
import { originalHashOf, smallHashOf } from "../../render/mediaTier";
import { remoteAssetBase } from "../media/assetTiers";
import { ensureActiveDraftId, getActiveDraftId, saveDraft, setActiveDraftId } from "../io/drafts";
import { forgetSaveTarget, hasSaveTarget, serializeProc, writeProcToDisk } from "../io/proc";
import { adminOp, currentDocLineage, dismissToast, ensureDevice, enterAccountProject, getSyncView, leaveSharedToLocal, pageSession, pushToast, whenSaved } from "./syncManager";
import { disableCollab, localCollab, pullOriginals, queueExistingMedia } from "./collab";
import { hosted } from "./sharedApi";
import {
  ACCOUNT_MOVE_TEXT, abandonMove, cloudProjectStateOf, createAttemptStore, isAccountCloudTarget, moveToAccountCloud, pendingAttempt, readProjectContent, sameContent, uploadProjectContent,
  type AbandonResult, type ContentLinkOptions, type MoveAttempt, type MoveResult, type MoveSource, type MoveStage,
} from "./accountMove";
import { currentCloudAssociation, setCloudAssociation } from "./recoveryAssociation";

/**
 * 在线构建的编译期常量(写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」)。在线页面没有编辑器进程,
 * 下面打本机 `/api/*` 的几处(问本机素材库、看上传队列、存草稿)在在线构建里整段剪掉(守门 `server/test/c10a-online-build.test.mjs` 的 C10A-API-03)。
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/* ---------------- 桌面版的账号云端 ---------------- */

export interface AccountCloud { origin: string; client: CloudAccountClient }

let cloud: Promise<AccountCloud | null> | null = null;
/** 这台桌面版的外壳太老（0.2.8 以前打了补丁），没有账号桥：`accountCloud()` 问到时记下，设置里据此说明要装完整安装包 */
let shellTooOld = false;

/**
 * 这台桌面版配置的账号云端与账号客户端(整个页面一份)。没有账号桥(在线页面、没有桌面外壳的开发服务器)回 null ——
 * 那时「搬到云端」照旧办法走,不显示账号这一套。
 */
export function accountCloud(): Promise<AccountCloud | null> {
  if (ONLINE) return Promise.resolve(null);
  if (cloud) return cloud;
  const task = (async (): Promise<AccountCloud | null> => {
    const device = await ensureDevice();
    if (!device) return null;
    let origin: string;
    try { origin = new URL((await desktopAccountBridge("configuration") as { origin: string }).origin).origin; }
    catch (error) { shellTooOld = isDesktopShellTooOld(error); return null; }
    shellTooOld = false;
    await loadAccountExtensions({ includeUi: false }).catch(() => false);
    return { origin, client: createAccountClient({ online: false, origin, device: { deviceId: device.deviceId, deviceName: device.deviceName }, native: desktopAccountBridge }) };
  })().catch(() => null);
  cloud = task;
  // 没取到(设备信息还没好、没有账号桥)不记住:下次再问
  void task.then((value) => { if (!value && cloud === task) cloud = null; });
  return task;
}

/**
 * 外壳太老、没有账号桥（`accountCloud()` 回 null 的原因之一，要先等它问过才有结果）。和「没有桌面外壳」不同：
 * 后者（在线页面、开发服务器）本来就没有这一套，照旧办法走，不提示。
 */
export function accountShellTooOld(): boolean { return shellTooOld; }

/**
 * 外壳太老时，界面上填的云端地址（或房间登记的）指的是不是缺省的账号云端：是的话「搬到云端」不能照旧办法走
 * （缺省云端只接受网站账号），要说明装完整安装包；用户自己填的别的节点仍是旧办法，不需要账号桥。
 * 外壳太老就读不到账号云端的配置，所以拿内置的缺省托管地址当账号云端认。
 */
export function oldShellBlocksAccountMove(serviceUrl: string | null | undefined): boolean {
  return shellTooOld && isAccountCloudTarget(serviceUrl, hosted.DEFAULT_HOSTED_URL, hosted.DEFAULT_HOSTED_URL);
}

/** 界面上填的云端地址(或房间登记用的那个)指的是不是账号云端 */
export function targetsAccountCloud(serviceUrl: string | null | undefined, c: AccountCloud | null): boolean {
  return !!c && isAccountCloudTarget(serviceUrl, c.origin, hosted.DEFAULT_HOSTED_URL);
}

/** 当前登录的账号(手里没有就凭保险箱里的恢复凭证取一次);没登录回 null;连不上抛错 */
export async function accountCloudLogin(c: AccountCloud): Promise<Account | null> {
  return c.client.account ?? await c.client.restore();
}

/** 在设置里登录(和开始页的登录是同一个保险箱:这里登了,开始页也是登录的) */
export async function accountCloudSignIn(c: AccountCloud, name: string, password: string): Promise<Account> {
  return c.client.login(name, password, false);
}

/* ---------------- 现在打开的是什么 ---------------- */

/** 能搬的两种:没开协作的本地项目;旧办法在本机开的协作房间(当前连着)。别的(已经是云端项目、协作身份还没恢复)不能搬 */
export function moveSource(): MoveSource | null {
  if (ONLINE) return null;
  const v = getSyncView();
  const contentId = getState().project.id ?? "";
  if (!contentId) return null;
  if (v.shared) return !v.shared.accountId && v.shared.where === "lan" ? { kind: "room", contentId, creator: v.shared.creator, roomId: v.shared.projectId } : null;
  if (v.association || v.kind !== "local") return null;
  return { kind: "local", contentId };
}

const attempts = createAttemptStore(typeof localStorage === "undefined" ? null : localStorage);

/**
 * 上一次没做完、云端已经建好项目的那次搬迁(设置里据此提示「接着做」、给「放弃这次搬迁」);没有回 null。
 * 判据见 `accountMove.ts` 的 `pendingAttempt`:当前打开的是能搬的本机项目或本机协作房间,且本机记录里有云端回的项目号
 */
export function pendingMove(accountId: string): MoveAttempt | null {
  return pendingAttempt(attempts, accountId, moveSource());
}

let abandoning: Promise<AbandonResult> | null = null;

/**
 * 放弃这次搬迁(〔裁〕H04):删掉上一次搬到云端没做完时建好的那个云端项目,再清掉本机的搬迁记录。流程在 `accountMove.ts` 的 `abandonMove`。
 * 这个窗口正在搬时不做;同一时间只做一次;不抛错
 */
export function abandonPendingMove(c: AccountCloud): Promise<AbandonResult> {
  if (ONLINE_BUILD || ONLINE) return Promise.resolve({ ok: false, error: "not-ready", name: null });
  if (moving) return Promise.resolve({ ok: false, error: "busy", name: null });
  if (abandoning) return abandoning;
  const { client } = c;
  const task = abandonMove({
    source: moveSource,
    account: () => accountCloudLogin(c),
    attempts,
    inspect: async (projectId) => cloudProjectStateOf(await client.members(projectId)),
    remove: (projectId, rev, requestId) => client.deleteProject(projectId, rev, requestId),
    // 搬迁失败时编辑器没有进过那个云端项目,本页的云端关联本来就不指向它;万一指向(进项目的半路出的错),一并清掉,另存文件时不再写进去
    forget: (projectId) => { if (currentCloudAssociation()?.projectId === projectId) setCloudAssociation(null); },
    newRequestId: () => `abandon-${crypto.randomUUID()}`,
    owner: pageSession(),
  }).finally(() => { if (abandoning === task) abandoning = null; });
  abandoning = task;
  return task;
}

/* ---------------- 素材 ---------------- */

async function localHave(hashes: string[]): Promise<Set<string>> {
  const got = new Set<string>();
  if (ONLINE_BUILD) return got;
  for (let i = 0; i < hashes.length; i += 40) {
    const r = await fetch(`/api/media/local?hashes=${hashes.slice(i, i + 40).join(",")}`, { cache: "no-store" });
    const j = (await r.json()) as { hashes?: string[] };
    for (const h of j.hashes ?? []) got.add(h);
  }
  return got;
}

/**
 * 协作房间里、搬的人不在主机那台电脑上时:项目引用的素材字节在主机的素材服务上,这台电脑的内容库里可能只有一部分。
 * 关掉本机协作之后就再也取不到了,所以先拉齐(两档都拉)。本机就是主机(没有远程素材服务)时什么都不用做。
 */
async function pullRoomMedia(project: Project): Promise<{ ok: boolean; missing: number }> {
  if (!remoteAssetBase()) return { ok: true, missing: 0 };
  const hashes = [...new Set((project.media ?? []).flatMap((m) => [originalHashOf(m), smallHashOf(m)]).filter((h): h is string => !!h))];
  if (!hashes.length) return { ok: true, missing: 0 };
  if (await pullOriginals(hashes)) return { ok: true, missing: 0 };
  let have = 0;
  try { have = (await localHave(hashes)).size; } catch { /* 问不到:按都没有算 */ }
  return { ok: false, missing: Math.max(1, hashes.length - have) };
}

/** 多久看一次后台上传的进度 */
const WATCH_MS = 3000;
/** 素材没交上(上传通道没就绪)时隔多久再交一次 */
const REQUEUE_MS = 15_000;
/** 卡片源码同步多久还没连上云端项目就说出来 */
const CARDS_STUCK_MS = 30_000;

/**
 * 搬完之后还在后台传的东西:素材(两档;卡片声音也是素材表里的一条)走上传队列,卡片源码走编辑器进程的卡片源码同步。
 * 一条不自己消失的气泡跟着说:还在传、出错在重试、素材还没开始传(上传通道没就绪,这里自己隔一会儿再交,交上为止)、
 * 卡片源码还没连上;都传完换成一句结束的话(有本机找不到文件的档,在那句话里说出来)。离开这个项目就收掉。
 *
 * 判「素材传完」看的是上传队列空了:传失败的素材不出队(队列按退避一直重试),所以不会把失败当成传完;
 * 进了队、到要传时本机文件又没了的那一档,队列会跳过它,这里按队列的「找不到」计数在结束的那句话里说出来。
 */
function watchBackground(projectId: string, first: { queued: number; missing: string[] } | null) {
  if (ONLINE_BUILD) return;
  let queued = first !== null, count = first?.queued ?? 0;
  let toast: number | null = null, shown = "", everShown = false;
  let idle = 0, missingBase: number | null = null, lastRequeue = Date.now(), requeueing = false;
  const startedAt = Date.now();
  const show = (text: string, tone: "info" | "warn") => {
    if (text === shown) return;
    if (toast !== null) dismissToast(toast);
    shown = text; everShown = true;
    toast = pushToast(text, tone, Infinity);
  };
  const stop = (final: { text: string; tone: "info" | "warn" } | null) => {
    clearInterval(timer);
    if (toast !== null) dismissToast(toast);
    if (final && everShown) pushToast(final.text, final.tone, final.tone === "warn" ? Infinity : 8000);
  };
  const tick = async () => {
    if (getSyncView().shared?.projectId !== projectId) { stop(null); return; }
    if (!queued && !requeueing && Date.now() - lastRequeue >= REQUEUE_MS) {
      requeueing = true;
      try { const r = await queueExistingMedia(); if (r) { queued = true; count = r.queued; } }
      finally { requeueing = false; lastRequeue = Date.now(); }
    }
    let left = 0, missing = 0, failing = false;
    try {
      const j = (await (await fetch("/api/media/upload-queue", { cache: "no-store" })).json()) as { queue?: { items?: unknown[]; missing?: number; lastError?: { at?: number } | null } | null };
      left = j.queue?.items?.length ?? 0;
      missing = Number(j.queue?.missing) || 0;
      failing = left > 0 && Number(j.queue?.lastError?.at) > startedAt;
    } catch { return; }
    missingBase ??= missing;
    let cards: "ok" | "pending" | "stuck" = "ok";
    try {
      const c = (await (await fetch("/api/cards/sync/status", { cache: "no-store" })).json()) as { enabled?: boolean; projectId?: string; connected?: boolean; pending?: unknown[] };
      if (c.enabled !== false) {
        const bound = c.projectId === projectId && c.connected === true;
        cards = bound ? ((c.pending?.length ?? 0) > 0 ? "pending" : "ok") : Date.now() - startedAt > CARDS_STUCK_MS ? "stuck" : "pending";
      }
    } catch { /* 问不到卡片同步的状态:这一轮不算它 */ }
    const parts: string[] = [];
    if (!queued) parts.push(ACCOUNT_MOVE_TEXT.mediaNotQueued);
    else if (left > 0) parts.push(failing ? ACCOUNT_MOVE_TEXT.mediaRetrying : ACCOUNT_MOVE_TEXT.uploading(Math.max(count, left)));
    if (cards === "pending") parts.push(ACCOUNT_MOVE_TEXT.cardsUploading);
    if (cards === "stuck") parts.push(ACCOUNT_MOVE_TEXT.cardsStuck);
    if (parts.length) { idle = 0; show(parts.join(""), !queued || failing || cards === "stuck" ? "warn" : "info"); return; }
    // 连着两次都没有要传的才算传完(小尺寸还在转码的素材是转完才进队的)
    if (++idle < 2) return;
    const lost = missing - (missingBase ?? missing);
    stop(lost > 0 ? { text: ACCOUNT_MOVE_TEXT.uploadedWithMissing(lost), tone: "warn" } : { text: ACCOUNT_MOVE_TEXT.uploaded, tone: "info" });
  };
  const timer = setInterval(() => { void tick(); }, WATCH_MS);
  if (!queued) show(ACCOUNT_MOVE_TEXT.mediaNotQueued, "warn");
  else if (count > 0) show(ACCOUNT_MOVE_TEXT.uploading(count), "info");
}

/* ---------------- 搬 ---------------- */

export interface MoveRequest {
  /** 云端项目名 */
  name: string;
  /** 协作房间:创建者密码(本机存着的不用填) */
  creatorPassword?: string;
  onStage?: (stage: MoveStage) => void;
}

export type MoveOutcome = MoveResult & { kind: "local" | "room" };

let moving: Promise<MoveOutcome> | null = null;

/** 把当前打开的本地项目或本机协作房间搬到账号云端。同一时间只做一次;不抛错 */
export function moveCurrentToAccountCloud(c: AccountCloud, request: MoveRequest): Promise<MoveOutcome> {
  // 在线页面没有本机项目可搬:在线构建里下面整段(连同存草稿、问本机素材库的那些调用)剪掉
  if (ONLINE_BUILD) return Promise.resolve({ ok: false, error: "not-ready", stage: "check", localClosed: false, cloud: null, kind: "local" });
  if (moving) return moving;
  // 正在放弃这次搬迁(删云端那个项目)时不搬:等它做完
  if (abandoning) return Promise.resolve({ ok: false, error: "busy", stage: "check", localClosed: false, cloud: null, kind: moveSource()?.kind ?? "local" });
  const task = run(c, request).finally(() => { if (moving === task) moving = null; });
  moving = task;
  return task;
}

async function run(c: AccountCloud, request: MoveRequest): Promise<MoveOutcome> {
  const { client, origin } = c;
  const kind = moveSource()?.kind ?? "local";
  const shared = getSyncView().shared;
  const password = request.creatorPassword || (shared ? localCollab(shared.projectId)?.creatorPassword : "") || "";
  const url = hostedWsUrlOf(`${origin}/hosted/`);
  // 探针用(只在开发模式):把内容连接的等待上限调短,好在几秒内看到「中途云端不可用」的失败
  const testHook = import.meta.env?.DEV ? (window as unknown as { __pcMoveTest?: { contentTimeoutMs?: number; onStage?: (stage: MoveStage) => void } }).__pcMoveTest : undefined;
  const testTimeout = testHook?.contentTimeoutMs;
  const linkTo = (projectId: string): ContentLinkOptions => ({
    url, ...(testTimeout ? { timeoutMs: testTimeout } : {}),
    // 每建一个会话取一张票据;背后的访问令牌至少还剩一分钟(传到一半到期的,连接按断线重建、凭新票据接着传)
    ticket: async () => (await client.session(projectId, { minRemainingMs: 60_000 })).connectionTicket,
  });
  // 搬的过程中登录的账号换了(退出后登了另一个):后面的每一步都拒掉,不把内容写到另一个账号名下
  let startedAs: string | null = null;
  const sameAccount = () => {
    if (startedAs && client.account?.id !== startedAs) throw Object.assign(new Error("credential-revoked"), { status: 401, code: "credential-revoked" });
  };
  const result = await moveToAccountCloud({
    source: moveSource,
    account: async () => { const a = await accountCloudLogin(c); startedAs = a?.id ?? null; return a; },
    snapshot: async () => { await whenSaved(10_000); return structuredClone(getState().project); },
    create: (name, stub, requestId, extra) => { sameAccount(); return client.create(name, stub, requestId, extra); },
    // 历史序号与提交摘要:当前这条本机文档连接(本地项目连本机文档服务、协作房间连房间)确认到的那一份
    lineage: () => currentDocLineage(getState().project.id ?? ""),
    current: () => getState().project,
    upload: (projectId, snapshot) => { sameAccount(); return uploadProjectContent(linkTo(projectId), projectId, snapshot); },
    read: async (projectId) => (await readProjectContent(linkTo(projectId), projectId, getState().project)).project,
    checkCreator: async (pw) => {
      const r = await adminOp("list-bans", { password: pw });
      return r.ok ? { ok: true } : { ok: false, error: r.error === "rate-limited" ? "rate-limited" : r.error === "offline" ? "network" : "bad-password" };
    },
    pullMedia: pullRoomMedia,
    closeRoom: async (pw) => {
      const closed = await disableCollab(pw);
      if (closed.ok || closed.error === "forbidden" || closed.error === "rate-limited") return closed;
      // 删除的回包丢了(连接先被服务端按「项目已删除」关掉)时 `disableCollab` 报的是失败,而房间其实已经删了:
      // 页面随后会收到那个关闭码、进「项目被删除」的状态。等几秒看是不是这样;是就把手里的内容接回本机项目,按关成了往下走
      // (否则界面会说「仍是原来的房间」,而房间已经没了)。这一支按代码推断写的,没有端到端验过
      for (let i = 0; i < 20 && getSyncView().blocked !== "deleted"; i++) await new Promise((r) => setTimeout(r, 150));
      if (getSyncView().blocked !== "deleted") return closed;
      leaveSharedToLocal(structuredClone(getState().project));
      return { ok: true };
    },
    saveLocal: ONLINE_BUILD ? undefined : async () => {
      // 本地项目:有草稿才存(不替用户新开草稿)。协作房间(这时已经关掉、编辑器在本机项目里):一定存下来,没有草稿就新开一份 ——
      // 房间删了,这是唯一一份全的;存出来的不带房间关联
      const id = kind === "room" ? ensureActiveDraftId() : getActiveDraftId();
      if (id) await saveDraft(id);
      // 这一次打开期间存过磁盘文件的,那个文件也照现在的样子写一遍(不然它里面还记着已经删掉的房间)
      if (kind === "room" && hasSaveTarget()) await writeProcToDisk(serializeProc(), `${getState().project.name || "未命名"}.proc`);
    },
    enter: async ({ projectId, name, snapshot, kind: from }) => {
      sameAccount();
      await enterAccountProject({ client, origin, projectId, name, initial: snapshot,
        enteredText: from === "room" ? ACCOUNT_MOVE_TEXT.toastRoom : ACCOUNT_MOVE_TEXT.toastLocal,
        // 换过去的那一刻再比一次:编辑器里的内容、云端发来的内容,有一样和核对过的那份不同就不换(流程回头再传)
        guard: (cloudNow) => {
          if (!sameContent(getState().project, snapshot) || !sameContent(cloudNow, snapshot)) throw Object.assign(new Error("content-changed"), { code: "content-changed" });
        } });
      // 之后的「保存」不再写回本机那份草稿或文件(它留作普通的本地项目);与从开始页进云端项目一致
      setActiveDraftId(null);
      forgetSaveTarget();
    },
    queueMedia: async () => {
      // 交不上(上传通道 30 秒没就绪)回 null:后台那条气泡明说「还没开始上传」,并隔一会儿再交,交上为止
      const r = await queueExistingMedia();
      const projectId = getSyncView().shared?.projectId;
      if (projectId) watchBackground(projectId, r);
      return r;
    },
    attempts,
    newRequestId: () => `move-${crypto.randomUUID()}`,
    // 占位内容:一份完整的空白项目(只有 `{ tracks: [] }` 的话编辑器打不开);项目号沿用本机那一份的
    stub: (name, contentId) => ({ ...createEmptyProject(name), id: contentId }),
    linkOf: (projectId) => projectLink(origin, projectId),
    onStage: (stage) => { testHook?.onStage?.(stage); request.onStage?.(stage); },
    owner: pageSession(),
  }, { name: request.name, creatorPassword: password });
  return { ...result, kind };
}
