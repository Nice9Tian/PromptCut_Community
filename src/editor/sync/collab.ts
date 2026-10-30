/**
 * 项目设置「多用户协作」的动作（C10a 契约 `docs/plan/c10a-contract.md` 第 6 节；语义 `workflow/project.md`「多用户协作」）。
 *
 * - **开启**：放云端向托管端 `POST shared/create`（地址缺省是内置托管地址，可改，沿用 C6.5）→ 以创建者身份进入、把当前项目
 *   以根替换写进去（`enterShared`，C6.5 的路径）→ `invite-create` → 界面显示邀请链接与二维码。放本机沿用 C6.5 的本机托管
 *   （本机文档服务 `/docservice/shared/create`），以原设备绑定向云端登记并保持出站隧道。
 * - **勾上时的缺省**：放本机、自由进入、创建者用户名取设备名；项目密码与创建者密码都自动生成（各 16 个字符）并存在本机〔裁，第 6 节〕。
 * - **邀请码**：原文只在签发时回给创建者，存在他本机保护存储；服务端不存原文，别的成员取不到〔裁，第 6 节〕。
 * - **取消**：放云端的先把项目真身与被引用的素材原尺寸全部拉回本机（预渲染产物可以再生，不拉），再以创建者身份 `delete`，
 *   本机项目回到 `local` 空间；中途失败就恢复为开启状态。放本机的停本机托管（删掉本机文档服务里的共享项目），回到 `local` 空间。
 *
 * 界面在 `CollabSection.tsx`；连接、进入、创建者操作在 `syncManager.ts`。
 */
import { adminOp, enterShared, ensureDevice, expectSharedClose, getSyncView, leaveSharedToLocal, pushToast, whenSaved, recoveryRequest, type AdminError } from "./syncManager";
import { errorStatus, route, hosted, type SharedMode, type Where } from "./sharedApi";
import { getState } from "../../store/project";
import { originalHashOf } from "../../render/mediaTier";
import { enqueueExistingMedia, type EnqueueExistingResult } from "../media/assetTiers";
import { ingestUnhashedMedia } from "../io/mediaUpload";
import { ONLINE } from "../../online/mode";
import { HOSTED_DOC_PATH, inviteLinkOf } from "../../online/invite";
import { cacheCollabSecrets, cachedCollabSecrets } from "./collabSecrets";

/* ---------------- 本机记下的东西 ---------------- */

export interface InviteInfo {
  link: string;
  expiresAt: number;
  maxUses: number | null;
}

/** 这台设备上以创建者身份开启过的协作项目：自动生成的两样密码、邀请链接（只有创建者本机有） */
export interface LocalCollab {
  projectId: string;
  where: Where;
  mode: SharedMode;
  name: string;
  creatorUsername: string;
  creatorPassword?: string;
  projectPassword?: string;
  invite?: InviteInfo | null;
}

const LOCAL_KEY = "pc.shared.local";

function readAll(): Record<string, LocalCollab> {
  try {
    const v = hosted.migrateHostedDeep(JSON.parse(localStorage.getItem(LOCAL_KEY) ?? ""));
    return v && typeof v === "object" ? (v as Record<string, LocalCollab>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, LocalCollab>) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
}

export function localCollab(projectId: string): LocalCollab | null {
  return cachedCollabSecrets<LocalCollab>(projectId) ?? readAll()[projectId] ?? null;
}

async function saveLocal(rec: LocalCollab) {
  const descriptor = getSyncView().association;
  if (ONLINE) { cacheCollabSecrets(rec.projectId, rec); return; }
  if (!descriptor || descriptor.roomId !== rec.projectId) throw new Error("当前房间的秘密无法可靠保存");
  await recoveryRequest("settings-write", descriptor, { settings: rec });
  cacheCollabSecrets(rec.projectId, rec);
  const all = readAll(); delete all[rec.projectId]; writeAll(all);
}

function dropLocal(projectId: string) {
  cacheCollabSecrets(projectId, null);
  const all = readAll();
  delete all[projectId];
  writeAll(all);
}

/* ---------------- 缺省值 ---------------- */

const PW_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 自动生成的密码：16 个字符，去掉容易看错的 0 O 1 l I */
export function generatePassword(length = 16): string {
  const bytes = new Uint8Array(length * 2);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    // 拒绝采样，免得前几个字符概率偏高
    if (bytes[i] >= 256 - (256 % PW_ALPHABET.length)) continue;
    out += PW_ALPHABET[bytes[i] % PW_ALPHABET.length];
  }
  return out.length === length ? out : generatePassword(length);
}

/** 缺省的创建者用户名：设备名 */
export async function defaultCreatorName(): Promise<string> {
  const d = await ensureDevice();
  return (d?.deviceName || "我").slice(0, 64);
}

/* ---------------- 邀请码 ---------------- */

/** 邀请链接的源：服务端给的公网源 → 在线页面自己的源 → 文档服务地址的源 */
/**
 * 邀请链接里要带的**文档服务路径**（`online/invite.ts` 的 `inviteLinkOf`）：托管端在 `/hosted/`、
 * 局域网主机在 `/docservice`，两种不一样,光有源推不出来,所以签发时写进链接。
 *
 * 服务端给了 `linkOrigin`（托管端的公网源）就按托管端的路径；没给就从文档服务的 base 上取它自己的路径
 * —— 放本机时那就是 `/docservice`。
 */
function docPathOf(given: unknown, base: string): string {
  if (typeof given === "string" && /^https?:\/\//.test(given)) return HOSTED_DOC_PATH;
  let path: string;
  try {
    path = new URL(base).pathname || HOSTED_DOC_PATH;
  } catch {
    return HOSTED_DOC_PATH;
  }
  /*
   * **末尾斜杠要去掉**（2026-10-26 端到端探针照出来的）：托管端的 `/hosted/` 必须带斜杠（nginx 对
   * 不带斜杠的回 301，WebSocket 升级跟不了重定向），**局域网主机的 `/docservice` 反过来，要的是不带斜杠的**
   * （见 `online/invite.ts` 的 `hostedWsUrlOf`）。文档服务的 base 这边带着斜杠，原样写进链接的话
   * 成员那边拼出 `ws://主机/docservice/`，握不上手，界面只说一句「连不上服务器」。
   */
  if (path === HOSTED_DOC_PATH) return path;
  return path.replace(/\/+$/, "") || "/";
}

function linkOriginOf(given: unknown, base: string): string {
  if (typeof given === "string" && /^https?:\/\//.test(given)) return given;
  if (ONLINE) return location.origin;
  try {
    return new URL(base).origin;
  } catch {
    return location.origin;
  }
}

export type InviteResult = { ok: true; invite: InviteInfo } | { ok: false; error: AdminError };

/** 签发（作废旧的、签发新的）：每次都要当场的创建者密码 */
/**
 * 放本机时邀请链接要用的源：**主机的局域网地址**，不是创建者此刻连的那个。
 *
 * 创建者多半是从回环（`http://127.0.0.1:<口>`）连自己的文档服务的，照那个源拼出来的链接只有这台机器打得开
 * ——局域网里的手机拿到的是它自己的回环。所以问一下本机绑在哪几个网段（`/api/lan-open`，只答回环，正合适），
 * 取第一个网段 + 编辑器的端口。几块网卡时取第一个：用户要是连的是另一个网段，「在手机上打开」那个窗口会
 * 当场说明（`LanOpenDialog` 的 `linkOnLan`）。问不到就退回按 base 推，至少不比以前差。
 */
async function lanLinkOrigin(): Promise<string | null> {
  // 在线构建里没有编辑器进程、也就没有 /api/lan-open。不剪掉这一支，这个接口地址会被
  // createInvite() 无条件拖进在线产物（C10A-API-03 判红）。ONLINE 是编译期常量，这里会整段剪掉。
  if (ONLINE) return null;
  try {
    const r = await fetch("/api/lan-open", { cache: "no-store" });
    if (!r.ok) return null;
    const v = (await r.json()) as { lanHost?: boolean; port?: number | null; addresses?: { address?: string }[] };
    const address = v?.addresses?.[0]?.address;
    if (!v?.lanHost || !address || !v.port) return null;
    return `http://${address}:${v.port}`;
  } catch {
    return null;
  }
}

export async function createInvite(creatorPassword: string): Promise<InviteResult> {
  const s = getSyncView().shared;
  if (!s) return { ok: false, error: "offline" };
  const r = await adminOp("invite-create", { password: creatorPassword });
  if (!r.ok) return r;
  const code = String(r.reply.code ?? "");
  const origin = (s.where === "lan" ? await lanLinkOrigin() : null) ?? linkOriginOf(r.reply.linkOrigin, s.base);
  const invite: InviteInfo = {
    link: inviteLinkOf(origin, code, docPathOf(r.reply.linkOrigin, s.base)),
    expiresAt: Number(r.reply.expiresAt),
    maxUses: typeof r.reply.maxUses === "number" ? r.reply.maxUses : null,
  };
  const prev = localCollab(s.projectId);
  await saveLocal({ ...(prev ?? { projectId: s.projectId, where: s.where, mode: s.mode, name: s.name, creatorUsername: s.username }), invite });
  return { ok: true, invite };
}

export interface InviteStatus {
  active: boolean;
  expiresAt: number | null;
  maxUses: number | null;
  used: number;
  revokedAt: number | null;
}

export async function fetchInviteStatus(creatorPassword: string): Promise<{ ok: true; status: InviteStatus } | { ok: false; error: AdminError }> {
  const r = await adminOp("invite-status", { password: creatorPassword });
  if (!r.ok) return r;
  const m = r.reply;
  return {
    ok: true,
    status: {
      active: m.active === true,
      expiresAt: typeof m.expiresAt === "number" ? m.expiresAt : null,
      maxUses: typeof m.maxUses === "number" ? m.maxUses : null,
      used: Number(m.used) || 0,
      revokedAt: typeof m.revokedAt === "number" ? m.revokedAt : null,
    },
  };
}

/* ---------------- 开启 ---------------- */

export interface EnableOptions {
  where: Where;
  mode: SharedMode;
  name: string;
  creator: { username: string; password: string };
  /** 自由进入的项目密码 */
  projectPassword?: string;
  /** 限定进入的名单 */
  list?: { username: string; password: string }[];
  /** 托管地址（放云端）；不给按覆盖顺序取 */
  hostedUrl?: string | null;
}

export type EnableError = "offline" | "unreachable" | "name-taken" | "lan-failed";

export async function enableCollab(o: EnableOptions): Promise<{ ok: true; invite: InviteInfo | null } | { ok: false; error: EnableError }> {
  if (o.where === "hosted" && typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, error: "offline" };
  let made: Awaited<ReturnType<typeof route.createSharedProject>>;
  try {
    made = await route.createSharedProject({
      where: o.where,
      name: o.name,
      mode: o.mode,
      creator: o.creator,
      ...(o.mode === "free" ? { password: o.projectPassword } : { list: o.list ?? [] }),
      ...(o.where === "hosted" && o.hostedUrl ? { hostedUrl: o.hostedUrl } : {}),
    });
  } catch (e) {
    const { status, reason } = errorStatus(e);
    console.warn("[collab] 建共享项目没成:", status, reason, (e as Error)?.message);
    if (status === 409 || reason === "name-taken") return { ok: false, error: "name-taken" };
    return { ok: false, error: o.where === "hosted" ? "unreachable" : "lan-failed" };
  }
  const device = getSyncView().device;
  const entered = await enterShared(
    { where: made.where, base: made.base, projectId: made.projectId, name: made.name, mode: made.mode, service: o.where === "lan" ? hosted.resolveHostedUrl({ ui: o.hostedUrl }) || made.base : made.base, ...(o.where === "lan" ? { hostDeviceName: device?.deviceName } : {}) },
    { as: "creator", username: o.creator.username, password: o.creator.password },
    { initialize: true },
  );
  if (!entered.ok) {
    console.warn("[collab] 以创建者身份进入没成:", entered.error);
    return { ok: false, error: o.where === "hosted" ? "unreachable" : "lan-failed" };
  }
  if (o.where === "lan") {
    const descriptor = getSyncView().association;
    if (descriptor) await recoveryRequest("activate-host", descriptor);
  }
  await saveLocal({
    projectId: made.projectId,
    where: made.where,
    mode: made.mode,
    name: made.name,
    creatorUsername: o.creator.username,
    creatorPassword: o.creator.password,
    ...(o.mode === "free" ? { projectPassword: o.projectPassword } : {}),
    invite: null,
  });
  if (o.where !== "hosted") {
    /*
     * 放本机的项目也签一张邀请链接(2026-10-26 用户定「局域网共享项目那一整套」时补):局域网里的手机、平板
     * 扫码就能加入(`product/platforms.md`「局域网里的第二块屏」)。链接的源由 `linkOriginOf` 从文档服务的
     * base 取 —— 主机以 `PROMPTCUT_LAN_HOST=1` 起时那就是它的局域网地址。
     * 签不成只少了链接(项目名 + 口令照样能加入),所以不挡开启。
     */
    const lanInvite = await createInvite(o.creator.password);
    return { ok: true, invite: lanInvite.ok ? lanInvite.invite : null };
  }
  /*
   * 开启前就在项目里的素材也要上云(C10a 集成返工):等编辑器进程拿到托管端素材服务与 rw 票据(进入共享项目时
   * connectSharedAssets 设的上传目标),再按哈希交给上传队列,之后照上传队列的规则传(所有素材小尺寸先传、再传素材原尺寸)。
   * 不挡开启:传的进度由上传队列管,缺的(本机内容库里没有)记一笔。
   */
  void queueExistingMedia();
  const inv = await createInvite(o.creator.password);
  // 项目已经建好、进去了；邀请码没签成只少了链接，设置里可以再点「作废并重新生成」
  return { ok: true, invite: inv.ok ? inv.invite : null };
}

/**
 * 开启「放云端」后把项目里已有的素材交给上传队列:先把没有哈希、本机还取得到字节的老素材补入库
 * (`ingestUnhashedMedia`,写回素材表并同步到文档服务),再按哈希入队。补不上的、本机内容库里没有的
 * 传不上去,别的成员拿不到:用气泡把这些素材的名字列给用户(控制台那一行不算告知)。
 * 回交给队列的个数与传不上去的名字(账号办法的「搬到云端」`accountMoveFlow.ts` 也用它);没交成回 null。
 */
export async function queueExistingMedia(): Promise<{ queued: number; missing: string[] } | null> {
  if (ONLINE) return null;
  try { await ingestUnhashedMedia(); } catch (e) { console.warn("[collab] 补入库没做完:", (e as Error)?.message); }
  const media = getState().project.media ?? [];
  const r = await enqueueExistingMedia(media, { post: postEnqueue });
  if (!r) { console.warn("[collab] 已有素材没交给上传队列(等不到上传目标,或没有本机编辑器)"); return null; }
  const nameOfHash = new Map<string, string>();
  for (const m of media) {
    const h = String(m.tiers?.original || m.hash || "").toLowerCase();
    if (h && !nameOfHash.has(h)) nameOfHash.set(h, m.name);
  }
  const names = [
    ...(r.skipped ?? []).filter((s) => !s.pending).map((s) => s.name),
    ...r.missing.map((h) => nameOfHash.get(String(h).toLowerCase()) ?? String(h)),
  ];
  if (!names.length) return { queued: r.queued.length, missing: [] };
  console.warn("[collab] 这些素材传不上去:", names);
  pushToast(uploadMissingMessage(names), "warn", Infinity);
  return { queued: r.queued.length, missing: names };
}

/** 放云端时传不上去的素材:给用户的那句话(名字去重,太多时只列前面若干条) */
export function uploadMissingMessage(names: readonly string[], limit = 8): string {
  const uniq = [...new Set(names.map((n) => String(n || "").replace(/^\(缺失\) /, "")).filter(Boolean))];
  const shown = uniq.slice(0, limit).join("、");
  const more = uniq.length > limit ? ` 等 ${uniq.length} 条` : "";
  return `这些素材本机找不到文件，没有传到云端，其他成员看不到：${shown}${more}`;
}

/**
 * 编辑器进程的「按哈希入队」(`server/vite-plugin-media.ts`)。在线构建里 `ONLINE` 是常量 true,这一支连同接口地址被剪掉
 * (在线页面没有编辑器进程;也不会走到放云端的开启,那在桌面版里做)。
 */
export const postEnqueue = ONLINE ? null : async (body: unknown): Promise<EnqueueExistingResult | null> => {
  try {
    const r = await fetch("/api/media/upload-queue/enqueue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json()) as { ok?: boolean } & EnqueueExistingResult;
    return j?.ok ? { queued: j.queued ?? [], missing: j.missing ?? [], local: !!j.local } : null;
  } catch {
    return null;
  }
};

/* ---------------- 取消 ---------------- */

export type DisableError = "forbidden" | "rate-limited" | "pull-failed" | "offline" | "online-page";

/** 拉回素材原尺寸：交给编辑器进程的预取队列，轮询本地内容库直到到齐；一分钟没有进展算失败 */
export async function pullOriginals(hashes: string[], onProgress?: (done: number, total: number) => void): Promise<boolean> {
  if (ONLINE) return false; // 在线页面没有本机素材库
  if (!hashes.length) return true;
  try {
    const r = await fetch("/api/media/prefetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: hashes.map((hash) => ({ hash })) }) });
    if (!r.ok) return false;
  } catch {
    return false;
  }
  let have = new Set<string>();
  let lastProgress = Date.now();
  for (;;) {
    const got = new Set<string>();
    for (let i = 0; i < hashes.length; i += 40) {
      const part = hashes.slice(i, i + 40);
      try {
        const r = await fetch(`/api/media/local?hashes=${part.join(",")}`, { cache: "no-store" });
        const j = (await r.json()) as { hashes?: string[] };
        for (const h of j.hashes ?? []) got.add(h);
      } catch {
        /* 这一轮没问到：下轮再问 */
      }
    }
    if (got.size > have.size) lastProgress = Date.now();
    have = got;
    onProgress?.(have.size, hashes.length);
    if (have.size >= hashes.length) return true;
    if (Date.now() - lastProgress > 60_000) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * 取消多用户协作（创建者）：核对创建者密码 → 放云端的先把项目真身与素材原尺寸拉回本机 → `delete` → 回到本机空间。
 * 删除前失败保留开启；服务删除成功后即使本机注销记录写失败，也不能报成房间还在。
 */
export async function disableCollab(creatorPassword: string, onProgress?: (done: number, total: number) => void): Promise<{ ok: true } | { ok: false; error: DisableError }> {
  const s = getSyncView().shared;
  if (!s) return { ok: false, error: "offline" };
  if (ONLINE) return { ok: false, error: "online-page" };
  // 先核对一次创建者密码（无副作用），免得白拉一趟
  const check = await adminOp("list-bans", { password: creatorPassword });
  if (!check.ok) return { ok: false, error: check.error === "rate-limited" ? "rate-limited" : check.error === "offline" ? "offline" : "forbidden" };
  try {
    await whenSaved(10_000);
  } catch {
    return { ok: false, error: "pull-failed" };
  }
  const project = structuredClone(getState().project);
  if (s.where === "hosted") {
    const hashes = [...new Set((project.media ?? []).map((m) => originalHashOf(m)).filter((h): h is string => !!h))];
    if (!(await pullOriginals(hashes, onProgress))) return { ok: false, error: "pull-failed" };
  }
  expectSharedClose(true);
  const del = await adminOp("delete", { key: check.key });
  if (!del.ok) {
    expectSharedClose(false);
    return { ok: false, error: del.error === "rate-limited" ? "rate-limited" : del.error === "forbidden" ? "forbidden" : "pull-failed" };
  }
  dropLocal(s.projectId);
  // 拉回本机的是删除落地那一刻页面手里的内容,不是上面动手之前拷的那一份:从拷贝到删除落地之间房间收下的修改
  // (别的成员的、自己还没确认的)都在同一条连接上先于删除的回包到了页面,用早先那份拷贝会把它们丢掉
  const final = structuredClone(getState().project);
  const descriptor = getSyncView().association;
  if (descriptor) {
    try { await recoveryRequest("revoke", descriptor); }
    catch { pushToast("房间已经删除，但本机注销记录未能保存。请保留项目并检查磁盘；旧房间不会重新创建。", "warn", Infinity); }
  }
  leaveSharedToLocal(final);
  return { ok: true };
}

/** 创建者在成员浮层或设置里改了密码：本机记下的那份跟着换（这台设备上没开启过的不记） */
export async function rememberPasswords(projectId: string, p: { creatorPassword?: string; projectPassword?: string }) {
  const prev = localCollab(projectId);
  if (!prev) return;
  await saveLocal({ ...prev, ...p });
}
