import type { Project } from "../../kernel/project";
// @ts-expect-error Browser-safe format validation, also used by the server.
import { parseCollaboration } from "../../../server/recovery/descriptor.mjs";
import { convertGoneProject, type GoneProof } from "./cloudGone";
import { verifiedBase, type CloudSnapshot } from "./cloudSnapshot";
import { JOIN_REQUEST_TEXT, reopenNotice, type JoinRequestStatus } from "./joinRequestText";
import { createRequestIds } from "./requestIds";


export interface CollaborationDescriptor {
  version: number;
  roomId?: string;
  service?: string;
  where?: "lan" | "hosted";
  hint?: string;
  [key: string]: unknown;
}
let pending: { contentId: string; descriptor: CollaborationDescriptor | null } | null = null;
let active: CollaborationDescriptor | null = null;
let recovering = false;

/** 只校验、不记:文件里的协作关联写坏了就抛错(打开文件时先于一切副作用调用) */
export function checkAssociation(value: unknown): void { parseCollaboration(value); }
export function noteLoadedAssociation(project: Project, value: unknown) {
  pending = { contentId: project.id!, descriptor: parseCollaboration(value) as CollaborationDescriptor | null };
}
export function takeLoadedAssociation(project: Project): CollaborationDescriptor | null {
  const value = pending && pending.contentId === project.id ? pending.descriptor : null;
  pending = null; active = value; recovering = !!value;
  return value;
}
export function currentAssociation(): CollaborationDescriptor | null { return active; }
export function setAssociation(value: CollaborationDescriptor | null, restoring = false) { active = value; recovering = !!value && restoring; }
export function isRecoveringAssociation(): boolean { return recovering; }

/**
 * 「过期的云端项目转成了本地项目」的出处记录（随 `.proc` 的壳保存，只供提示与追溯）：
 * 原来的房间号、协作服务地址，以及文档服务那份「已不存在」证明里的签发方、墓碑版本、钥匙号。
 * 不含任何账号凭证，也不是恢复关联：带着它的文件重开就是一个普通的本地项目，不再去连旧云端。
 */
export interface ConvertedFrom {
  v: 1;
  roomId: string;
  service: string;
  authorityId: string;
  tombstoneRevision: number;
  kid: string;
  convertedAt: string;
}
export function parseConvertedFrom(value: unknown): ConvertedFrom | null {
  const v = value as Partial<ConvertedFrom> | null;
  if (!v || typeof v !== "object" || v.v !== 1 || typeof v.roomId !== "string" || !/^sp_[a-z2-7]{26}$/.test(v.roomId) ||
    typeof v.service !== "string" || v.service.length > 2048 || typeof v.authorityId !== "string" || v.authorityId.length > 128 ||
    !Number.isSafeInteger(v.tombstoneRevision) || typeof v.kid !== "string" || v.kid.length > 128 ||
    typeof v.convertedAt !== "string" || v.convertedAt.length > 64) return null;
  return { v: 1, roomId: v.roomId, service: v.service, authorityId: v.authorityId, tombstoneRevision: v.tombstoneRevision!, kid: v.kid, convertedAt: v.convertedAt };
}
let convertedFrom: { contentId: string; info: ConvertedFrom } | null = null;
/** 载入文件、或刚转换完时记下；换了别的项目（项目号不同）就不再回这一份 */
export function noteConvertedFrom(project: Pick<Project, "id">, value: unknown) {
  const info = parseConvertedFrom(value);
  convertedFrom = info && project.id ? { contentId: project.id, info } : null;
}
export function convertedFromOf(project: Pick<Project, "id">): ConvertedFrom | null {
  return convertedFrom && convertedFrom.contentId === project.id ? convertedFrom.info : null;
}

/** 转换完成的通知：保存落点与草稿归属据此清掉（原文件保留），界面据此提示一次。 */
export interface GoneConversion { projectId: string; name: string; from: ConvertedFrom }
const goneListeners = new Set<(event: GoneConversion) => void>();
let goneNotices: GoneConversion[] = [];
export function onGoneConversion(listener: (event: GoneConversion) => void): () => void {
  goneListeners.add(listener); return () => { goneListeners.delete(listener); };
}
export function publishGoneConversion(event: GoneConversion) {
  goneNotices = [...goneNotices, event];
  for (const listener of [...goneListeners]) { try { listener(event); } catch { /* 一个订阅者出错不挡别的 */ } }
}
/** 界面取走还没提示过的那几条（每条只提示一次） */
export function takeGoneNotices(): GoneConversion[] { const out = goneNotices; goneNotices = []; return out; }

/**
 * 账号云端项目另存为 .proc / .procp 时的云端关联记号（10-14 第 3.4 节）
 */
export interface CloudProjectAssociation {
  accountProject: true;
  projectId: string;
  docServiceUrl: string;
  origin?: string;
  savedRev: number;
  savedAt: string;
  /**
   * 固定非本机快照(`cloudSnapshot.ts`):另存那一刻文档服务确认过的那一版(基准内容)与它的哈希。
   * 老文件没有;读回时哈希对不上的丢掉(当没有),都照旧能打开。
   */
  base?: Project;
  baseSha256?: string;
}

export function parseCloudAssociation(value: unknown): CloudProjectAssociation | null {
  const v = value as Partial<CloudProjectAssociation> | null;
  if (!v || typeof v !== "object" || v.accountProject !== true || typeof v.projectId !== "string" || !v.projectId) return null;
  if (typeof v.docServiceUrl !== "string" || !v.docServiceUrl) return null;
  const savedRev = Number.isSafeInteger(v.savedRev) ? Number(v.savedRev) : 1;
  const savedAt = typeof v.savedAt === "string" ? v.savedAt : new Date().toISOString();
  return {
    accountProject: true,
    projectId: v.projectId,
    docServiceUrl: v.docServiceUrl,
    origin: typeof v.origin === "string" ? v.origin : v.docServiceUrl,
    savedRev,
    savedAt,
    ...(verifiedBase(v) ? { base: v.base as Project, baseSha256: v.baseSha256 as string } : {}),
  };
}

let loadedCloudAssoc: { contentId: string; assoc: CloudProjectAssociation } | null = null;
let activeCloudAssoc: CloudProjectAssociation | null = null;

export function noteLoadedCloudAssociation(project: Pick<Project, "id">, value: unknown) {
  const assoc = parseCloudAssociation(value);
  loadedCloudAssoc = assoc && project.id ? { contentId: project.id, assoc } : null;
}

export function takeLoadedCloudAssociation(project: Pick<Project, "id">): CloudProjectAssociation | null {
  const value = loadedCloudAssoc && loadedCloudAssoc.contentId === project.id ? loadedCloudAssoc.assoc : null;
  loadedCloudAssoc = null;
  activeCloudAssoc = value;
  return value;
}

export function currentCloudAssociation(): CloudProjectAssociation | null {
  return activeCloudAssoc;
}

export function setCloudAssociation(value: CloudProjectAssociation | null) {
  activeCloudAssoc = value;
}

/**
 * 另存时取「当下连着的这个云端项目」的确认副本与序号(`syncManager.ts` 装上);没连着这个项目回 null,
 * 另存就沿用文件里原来的基准(`cloudSnapshot.ts` 的 `snapshotForSave`)。
 */
let cloudSnapshotGetter: ((projectId: string) => CloudSnapshot | null) | null = null;
export function setCloudSnapshotGetter(getter: ((projectId: string) => CloudSnapshot | null) | null) {
  cloudSnapshotGetter = getter;
}
export function currentCloudSnapshot(projectId: string): CloudSnapshot | null {
  return cloudSnapshotGetter ? cloudSnapshotGetter(projectId) : null;
}

let realtimeRevGetter: (() => number | null) | null = null;
export function setRealtimeRevGetter(getter: () => number | null) {
  realtimeRevGetter = getter;
}
/**
 * 「这个云端项目是不是真的已经不在了」的查询（替换型接缝）。
 *
 * 真实现在 `server/recovery/gone-proof.mjs`（归闭源），由 `cloud/account/manifest.ts` 注册进来。
 * 公开侧的缺省是「查不到凭据」—— 社区版没有云端项目，这条路本来就走不到；
 * 缺省返回 null 时调用方按原样提示「打不开」，不会把本地项目标成「从已消失的云端项目转来」。
 */
let goneQuery: ((descriptor: CollaborationDescriptor) => Promise<GoneProof | null>) | null = null;

export function registerGoneQuery(fn: ((descriptor: CollaborationDescriptor) => Promise<GoneProof | null>) | null): void {
  goneQuery = fn;
}

export function currentRealtimeRev(): number | null {
  return realtimeRevGetter ? realtimeRevGetter() : null;
}

/** `pushToast` 的样子:回这条气泡的号(关它用),带按钮的不自己消失 */
type ReopenToast = (msg: string, tone?: "info" | "warn", duration?: number, action?: { label: string; run: () => void; pc?: string }) => number | void;
type JoinRequestClient = { joinRequestStatus?: (projectId: string) => Promise<JoinRequestStatus>; sendJoinRequest?: (projectId: string, requestId: string) => Promise<JoinRequestStatus> };
/**
 * 重开文件时「这个账号不是这个云端项目的成员」那条提示。只在被账号名单挡住(`not-listed`)、项目只放账号名单时另带「发送申请」按钮
 * (先问一次自己那一条申请:已经在等、被拒且次数用完的不给按钮,把现状接在后面说);被踢(`banned`)、问不到的照旧只有那一句。
 * 点了按钮发申请:没收到回包再点沿用原请求号(`src/account/requestIds.ts`,与开始页、成员浮层共用);一次只发一个。
 * 发成了就把这条带按钮的提示关掉、之后再点也不再发(语义「发出后显示『已发送，等创建者通过』」;不能一直挂着让人反复发、白耗申请次数),
 * 另起一条「已发送，等创建者通过」并说明通过以后怎么连回去。
 */
async function notMemberToast(toast: ReopenToast, dismissToast: ((id: number) => void) | undefined, client: JoinRequestClient | null | undefined,
  projectId: string, code: unknown) {
  let status: JoinRequestStatus | null = null;
  if (code === "not-listed" && typeof client?.joinRequestStatus === "function" && typeof client.sendJoinRequest === "function") {
    try { status = await client.joinRequestStatus(projectId); } catch { status = null; }
  }
  const notice = status ? reopenNotice(status) : null;
  if (!notice) { toast(JOIN_REQUEST_TEXT.reopenNotMember, "warn", 10_000); return; }
  if (!notice.canSend) { toast(notice.text, "warn", 10_000); return; }
  const ids = createRequestIds();
  let sending = false, done = false;
  const id = toast(notice.text, "warn", Infinity, { label: JOIN_REQUEST_TEXT.send, pc: "reopen-join-request", run: () => {
    if (sending || done) return;
    sending = true;
    void ids.run("send", requestId => client!.sendJoinRequest!(projectId, requestId)).then(result => {
      done = true;
      if (typeof id === "number") dismissToast?.(id);
      const next = reopenNotice(result);
      toast(result.state === "pending" ? JOIN_REQUEST_TEXT.reopenSent : (next?.text ?? JOIN_REQUEST_TEXT.reopenNotMember), "info", 10_000);
    }, (error: { message?: string }) => {
      toast(error?.message || "申请没有发出去，请重试。", "warn", 10_000);
    }).finally(() => { sending = false; });
  } });
}

/**
 * 账号云端项目另存为 .proc / .procp 后的重开四规则（10-14 第 3.4 节）：
 * 1. 没登录：提示登录，以本地副本打开，保留关联；
 * 2. 登录的账号不是成员：提示「这个账号不是这个云端项目的成员」，以本地副本打开；项目只放账号名单时，提示里另有「发送申请」按钮
 *    （2026-10-22 用户定，`workflow/project.md` 第 44 行；`notMemberToast`）；
 * 3. 云端项目已删：凭已删证明（goneProof）转成独立本地项目打开；
 * 4. 有权限且有离线修改：连回云端项目合并离线修改，网络错误回退本地副本。
 */
export async function handleCloudAssociationReopen(
  project: Project,
  assoc: CloudProjectAssociation,
  options: {
    account?: { id: string; name: string } | null;
    client?: {
      account?: { id: string; name: string } | null;
      session: (projectId: string) => Promise<any>;
      join?: (projectId: string, requestId: string, joinOpts?: any) => Promise<any>;
    } | any;
    queryGone?: (descriptor: CollaborationDescriptor) => Promise<GoneProof | null>;
    isOfflineModified?: boolean;
    cloudProject?: Project;
    /** 第 4 个参数是气泡上的按钮(重开时「不是成员」那条提示的「发送申请」);`pushToast` 本来就收它 */
    toast?: (msg: string, tone?: "info" | "warn", duration?: number, action?: { label: string; run: () => void; pc?: string }) => number | void;
    /** 关掉一条气泡(`syncManager.ts` 的 `dismissToast`):重开文件那条带「发送申请」的提示,发成了就关掉 */
    dismissToast?: (id: number) => void;
    openAsLocal?: (p: Project) => void;
    /**
     * 连回云端项目并处理文件里的修改;回 `"pending-merge"` 表示云端在另存之后被别人改过、修改进了「冲突合并」(没直接提交)。
     */
    enterProject?: (options: any) => Promise<void | "pending-merge">;
  } = {},
): Promise<{ status: "opened" | "merged" | "pending-merge" | "converted" | "login-required" | "forbidden"; project?: Project }> {
  const toast = options.toast ?? (() => {});
  // 1. 规则 1：未登录
  let account = options.account;
  let client = options.client;
  if (account === undefined) {
    try {
      const flow = await import("./accountMoveFlow.ts");
      const c = await flow.accountCloud();
      if (c) {
        client = c.client;
        account = await flow.accountCloudLogin(c);
      }
    } catch {}
  }

  if (!account) {
    toast("请先登录网站账号；当前以本地副本打开。", "info");
    setCloudAssociation(assoc);
    options.openAsLocal?.(project);
    return { status: "login-required", project };
  }

  // 2. 核对成员权限与状态
  let session: any = null;
  const descriptor: CollaborationDescriptor = {
    version: 1,
    roomId: assoc.projectId,
    where: "hosted",
    service: assoc.docServiceUrl,
  };

  if (client) {
    try {
      session = await client.session(assoc.projectId);
    } catch (error: any) {
      const status = error?.status;
      const code = error?.code;
      // 规则 3：云端项目已被创建者删除
      if (status === 404 || code === "project-gone" || code === "no-project") {
        const query = options.queryGone ?? goneQuery ?? (async () => null);
        let proof: GoneProof | null = null;
        try { proof = await query(descriptor); } catch {}
        if (proof) {
          const converted = convertGoneProject(project, descriptor, proof);
          setCloudAssociation(null);
          publishGoneConversion({ projectId: converted.project.id!, name: converted.project.name, from: converted.from });
          toast("这个云端项目已不存在。", "info", 8000);
          options.openAsLocal?.(converted.project);
          return { status: "converted", project: converted.project };
        }
      }
      // 规则 2：已登录但不是该项目成员（只放账号名单的项目另给「发送申请」）
      if (status === 403 || code === "not-listed" || code === "banned" || code === "forbidden") {
        await notMemberToast(toast, options.dismissToast, client, assoc.projectId, code);
        setCloudAssociation(assoc);
        options.openAsLocal?.(project);
        return { status: "forbidden", project };
      }
      // 网络错误或其他临时故障：回退以本地副本打开
      options.openAsLocal?.(project);
      toast("连不上云端项目，当前以本地副本打开。", "warn", 6000);
      return { status: "opened", project };
    }
  }

  if (!session && !options.client) {
    toast(JOIN_REQUEST_TEXT.reopenNotMember, "warn", 10_000);
    setCloudAssociation(assoc);
    options.openAsLocal?.(project);
    return { status: "forbidden", project };
  }

  // 规则 4：有权限。检查是否有离线修改
  const isOfflineModified = options.isOfflineModified ?? (
    ((project as any).rev !== undefined && (project as any).rev > assoc.savedRev) ||
    (options.cloudProject && JSON.stringify(project) !== JSON.stringify(options.cloudProject))
  );

  let outcome: void | "pending-merge" = undefined;
  if (options.enterProject && client) {
    try {
      outcome = await options.enterProject({
        client,
        origin: assoc.origin || assoc.docServiceUrl,
        projectId: assoc.projectId,
        name: project.name,
        initial: project,
        firstSession: session,
      });
    } catch {
      options.openAsLocal?.(project);
      toast("连不上云端项目，当前以本地副本打开。", "warn", 6000);
      return { status: "opened", project };
    }
  }

  if (isOfflineModified) {
    if (outcome === "pending-merge") {
      // 另存之后云端被别人改过:修改按另存时的基准逐项比出来放进「冲突合并」,不直接盖上去
      toast("已连回云端项目。另存之后云端有别人的改动，你的修改已放进「冲突合并」，可以逐项合并。", "info", 8000);
      return { status: "pending-merge", project };
    }
    toast("已连回云端项目，离线修改已合并同步。", "info", 6000);
    return { status: "merged", project };
  }

  return { status: "opened", project };
}


