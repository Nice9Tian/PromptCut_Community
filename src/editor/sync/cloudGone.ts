import { newProjectId, type Project } from "../../kernel/project";
import type { CollaborationDescriptor, ConvertedFrom } from "./recoveryAssociation";

/** 文档服务签发、客户端核对过的「这个项目已不存在」的证明（`server/recovery/gone-proof.mjs` 的 `verifyGoneProof`） */
export interface GoneProof {
  v: 1; authorityId: string; projectId: string; state: "gone"; tombstoneRevision: number; issuedAt: number; kid: string; signature: string;
}

/**
 * 过期的云端项目 → 独立的本地项目（纯函数，不碰 store、不发请求）。
 *
 * - 只在证明的项目号与文件里记的房间号逐字相同时才转，否则抛错（调用方不该走到这里）；
 * - 内容原样保留：序列、片段、参数、素材表（哈希、路径、名字）、卡片节点、剪辑都不动；
 * - 换一个新的本地项目号：转出来的项目与原云端项目不再是同一个，不借旧云端身份；
 * - 不返回任何协作关联：调用方把关联清掉，多用户协作缺省关。
 */
export function convertGoneProject(
  project: Project,
  descriptor: CollaborationDescriptor,
  proof: GoneProof,
  deps: { newId?: () => string; now?: () => Date } = {},
): { project: Project; from: ConvertedFrom } {
  if (descriptor.version !== 1 || descriptor.where !== "hosted" || !descriptor.roomId || !descriptor.service) throw new Error("只有云端项目才按「已不存在」转成本地项目");
  if (proof?.state !== "gone" || proof.projectId !== descriptor.roomId) throw new Error("「已不存在」的证明与这个项目对不上");
  if (!project || !Array.isArray(project.tracks)) throw new Error("项目内容不可读，没有转换");
  const id = (deps.newId ?? newProjectId)();
  return {
    project: { ...project, id },
    from: { v: 1, roomId: descriptor.roomId, service: descriptor.service, authorityId: proof.authorityId,
      tombstoneRevision: proof.tombstoneRevision, kid: proof.kid, convertedAt: (deps.now?.() ?? new Date()).toISOString() },
  };
}

/**
 * 转换之前，把这台设备上没发出去的离线修改并进手上这份内容。
 *
 * 离线修改记在本机的恢复数据里，正常重入时是找到身份之后才恢复的；而项目已被清掉时一上来就拿到了证明，走不到那一步。
 * 不先并进来，转出来的本地项目就只有文件里的内容，随后本机身份一注销，这些修改再也取不回。
 * - 已经恢复过（`restored`）就不再读；
 * - 读不出来（本机恢复数据暂时读不了）抛 `offline-edits-unreadable`：调用方不转、不注销，稍后再试；
 * - 读出来了但并不进去（记录损坏）抛 `offline-edits-damaged`：调用方不转、不注销，原样保留并提示。
 */
export async function restoreOfflineEdits(o: {
  restored: boolean;
  readJournal: () => Promise<unknown | null>;
  restoreJournal: (journal: unknown) => void;
}): Promise<"already" | "none" | "restored"> {
  if (o.restored) return "already";
  let journal: unknown;
  try { journal = await o.readJournal(); }
  catch (cause) { throw Object.assign(new Error("这台设备上的离线修改暂时读不出来"), { reason: "offline-edits-unreadable", cause }); }
  if (journal === null || journal === undefined) return "none";
  try { o.restoreJournal(journal); }
  catch (cause) { throw Object.assign(new Error("这台设备上的离线修改记录损坏"), { reason: "offline-edits-damaged", cause }); }
  return "restored";
}
