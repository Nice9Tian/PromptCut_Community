import { loadProc, serializeProc, forgetSaveTarget, withFrameSnapshots } from "./proc";
import { acquireDraftLock, releaseDraftLock } from "./procLock";
import { isViewOnly, viewOnlyReason, viewOnlyText } from "./viewOnly";
import { actions } from "../../store/project";
import type { Project } from "../../kernel/project";
import { onGoneConversion } from "../sync/recoveryAssociation";

/** 本地草稿:服务端 `.pc-projects/` 目录里的一个 .proc 文件 */
export interface DraftInfo {
  id: string;
  name: string;
  updatedAt: string;
  size: number;
  duration: number;
  clips: number;
  thumbnail: string | null;
  /** 文件坏了(解析不出来)。仍然列出来,好让用户删掉 */
  broken: boolean;
}

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `请求失败(${res.status})`);
  }
  return data as T;
}

export async function listDrafts(): Promise<DraftInfo[]> {
  const data = await json<{ projects: DraftInfo[] }>(await fetch("/api/projects"));
  return data.projects ?? [];
}

/** 草稿 id:时间戳打头,列表按名字排也大致是按时间 */
export function newDraftId(): string {
  return `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function saveDraft(id: string, thumbnail: string | null = null): Promise<DraftInfo> {
  // 只读查看的页面在这里就停住,不用等服务端拒了再报错 —— 报错文案也更像人话
  if (isViewOnly()) throw new Error(viewOnlyText());
  await (await import("../sync/syncManager")).whenSaved();
  return json<DraftInfo>(
    await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: await withFrameSnapshots(serializeProc(thumbnail)),
    }),
  );
}

/** 读一份草稿并载入 store。返回载入后的 Project */
export async function openDraft(id: string): Promise<Project> {
  /*
   * 先抢独占锁再读内容。顺序不能反 —— 读完再抢的话,两个实例可能都已经把项目
   * 载进内存了,再告诉其中一个「你没抢到」就晚了,它已经能编辑了。
   */
  const lock = await acquireDraftLock(id);
  if (!lock.ok) throw new Error(lock.error || "这个项目正被另一个 PromptCut 打开");
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  if (!res.ok) {
    await releaseDraftLock();
    throw new Error(`打不开这份草稿(${res.status})`);
  }
  // 老草稿没有 project.id:拿草稿 id 顶上,和定制卡归属表里的老条目对得上
  const project = loadProc(await res.text(), { legacyId: id });
  // 换了草稿就换了落点,不能再覆盖上一个项目的文件
  forgetSaveTarget();
  actions.loadProject(project, `${project.name}.proc`);
  return project;
}

export async function deleteDraft(id: string): Promise<void> {
  if (isViewOnly()) throw new Error(viewOnlyReason() === "read-only-member" ? "你在这个项目里只能查看，删不了它。" : "这是只读查看模式,删不了这个项目");
  // 和 saveDraft 一样要带 owner 头:删也是写,无头实例上的写闸认的是这个头。
  // 漏了的话,实例**自己的**页面点删除会被自己的闸拦下。
  await json(await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

/**
 * 当前编辑的是哪份草稿。
 *
 * 放模块级变量而不是 store:它只影响「保存」往哪个文件写,不参与撤销重做,
 * 也不该进 .proc 文件本身。开始页选中草稿时写入,顶栏保存时读出。
 */
let activeDraftId: string | null = null;

export function setActiveDraftId(id: string | null): void {
  // 换草稿(含设成 null:新建项目、从文件打开)就把上一份的锁放掉。
  // 只放上一份(带 id):开草稿是先 openDraft(id) 抢到新锁、再来这里记 id 的,
  // 不带 id 会把刚抢到的那把放掉(换草稿后正在编辑的草稿失锁)。
  // 不 await:调用点大多在用户手势里,放锁慢一点不该卡住界面;放锁本身是幂等的。
  if (activeDraftId && activeDraftId !== id) void releaseDraftLock(activeDraftId);
  activeDraftId = id;
}

/** 没有就现开一个,这样「保存」永远有地方写 */
export function ensureActiveDraftId(): string {
  if (!activeDraftId) activeDraftId = newDraftId();
  return activeDraftId;
}

export function getActiveDraftId(): string | null {
  return activeDraftId;
}
// 过期的云端项目转成本地项目之后,原来那份草稿保留:转出来的项目不再属于它,保存时另开一份
onGoneConversion(() => setActiveDraftId(null));
