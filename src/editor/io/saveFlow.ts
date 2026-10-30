/**
 * 顶栏「保存项目」「打包保存」的流程(从 `TopBar.tsx` 搬出来,好在 node 里测;界面只管按钮和提示)。
 * 语义:`docs/semantics/mechanism/document-service.md`「保存基准与修改状态检查」——
 * 「保存暂时禁用前台编辑，等待本机写完；失败不覆盖上次有效保存，并恢复编辑」。
 *
 * 两条规矩照旧:
 *   - 「另存为」要用户手势,挑落点必须是点击后的第一个 await;
 *   - 用户在「另存为」里点取消就整个不算保存:草稿不写、脏标记不清。
 *
 * 顺序:挑落点 → 上锁(`../saveLock.ts`,前台编辑暂停)→ 等本机写完(`localWrites.ts`,到时限没完就不写、说明在等什么)
 * → 序列化 → 写盘(`proc.ts`:收预渲染快照、写临时副本,出错丢掉临时副本,原文件不动)→ 草稿、脏标记 → 解锁。
 * 结束(成功、超时、失败)都解锁、恢复编辑。
 *
 * 依赖都从参数进来(`SaveDeps`),缺省接真东西的那一份在 TopBar 里拼。
 */
import type { SaveOutcome } from "./proc";
import { beginSaveLock, isSaveLocked, type SaveKind, type SaveLock } from "../saveLock";
import { LOCAL_WRITES_TIMEOUT_MS, localCommitSeq, waitForLocalWrites, type LocalWriteProbe } from "./localWrites";
import { writeToHandle } from "./safeWrite";

export { SETTLE_TIMEOUT_TEXT } from "./localWrites";

export interface PackResultLike {
  blob: Blob;
  missing: readonly unknown[];
}

export interface SaveDeps {
  /** 写 `.proc`:挑落点(或沿用上次的),再调 `produce` 取内容,写盘。即 `proc.ts` 的 `writeProcToDisk` */
  writeProc(produce: () => Promise<string>, fileName: string): Promise<SaveOutcome>;
  /** 等文档服务确认完所有本地修改,超时抛错(即 syncManager 的 `whenSaved`) */
  settle(timeoutMs: number): Promise<void>;
  /** 其余几样本机写入(素材导入、本机 Agent……),`localWrites.ts`;不给就只等文档服务确认与后台写入停下 */
  probes?: readonly LocalWriteProbe[];
  /** 等本机写完的总时限,缺省 `LOCAL_WRITES_TIMEOUT_MS`(测试用) */
  waitTimeoutMs?: number;
  /** 当前项目(对象身份):序列化之后项目又被本机改了,就不能标「已保存」 */
  currentProject?(): unknown;
  /** 当前项目 → `.proc` 文本 */
  serialize(): string;
  /** 本地草稿跟着更新 */
  saveDraft(): Promise<void>;
  /** 清脏标记、记下文件名 */
  markSaved(fileName: string): void;
  /** 给用户的一句话:`error` 是这次没保存成的原因,`info` 是保存成了但要告诉用户的事 */
  notify(message: string, tone?: "error" | "info"): void;
}

export interface PackDeps extends Omit<SaveDeps, "writeProc" | "serialize" | "saveDraft" | "markSaved" | "currentProject"> {
  /** 挑 `.procp` 的落点;没有文件系统访问 API 时回 null(退回浏览器下载)。用户取消抛 AbortError */
  pick(fileName: string): Promise<FileSystemFileHandle | null>;
  /** 装包 */
  pack(): Promise<PackResultLike>;
  /** 写进挑好的落点;缺省 `safeWrite.ts` 的 `writeToHandle`(出错丢掉临时副本,原文件不动) */
  writeHandle?(handle: FileSystemFileHandle, data: Blob): Promise<void>;
  /** 没有落点时退回浏览器下载 */
  download(blob: Blob, fileName: string): void;
  /** 包里缺了哪些素材的那句话 */
  missingMessage(missing: readonly unknown[]): string;
}

export { writeFailedText } from "./safeWrite";

export const CHANGED_DURING_SAVE_TEXT = "保存期间项目又被本机改了（Agent 或后台任务）。文件里是保存开始那一刻的内容，之后的修改还没保存。";

export const SNAPSHOTS_SKIPPED_TEXT = "预渲染快照这次没来得及收进文件（渲染服务没有及时应答）。项目内容已完整保存，重新打开后会重新预渲染。";

/** `busy`:上一次保存还没结束,这一次不另起 */
export type SaveResult = "saved" | "downloaded" | "cancelled" | "failed" | "busy";

/** 保存进行中又点了一次:不另起,也不报错(「正在保存」那一层还在) */
class SaveBusy extends Error {
  constructor() { super("正在保存"); this.name = "SaveBusy"; }
}

/** 锁放在一个小盒子里:上锁发生在交给 writeProc 的回调里,外面的 finally 要拿得到 */
interface LockBox { lock: SaveLock | null }

function lockFor(box: LockBox, kind: SaveKind): SaveLock {
  const lock = beginSaveLock(kind);
  if (!lock) throw new SaveBusy();
  box.lock = lock;
  return lock;
}

/** 等本机写完;到时限没完抛错(说法里列出在等什么) */
async function waitLocal(deps: Pick<SaveDeps, "settle" | "probes" | "waitTimeoutMs">, lock: SaveLock): Promise<void> {
  await waitForLocalWrites({
    settle: (ms) => deps.settle(ms),
    probes: deps.probes ?? [],
    timeoutMs: deps.waitTimeoutMs ?? LOCAL_WRITES_TIMEOUT_MS,
    onWaiting: (labels) => lock.waiting(labels),
  });
}

/** 保存 `.proc` */
export async function saveProcFile(fileName: string, deps: SaveDeps): Promise<SaveResult> {
  if (isSaveLocked()) return "busy";
  const box: LockBox = { lock: null };
  let serialized: unknown = undefined;
  let commitsAtSerialize = 0;
  try {
    const outcome = await deps.writeProc(async () => {
      const lock = lockFor(box, "proc");
      await waitLocal(deps, lock);
      lock.writing();
      serialized = deps.currentProject?.();
      commitsAtSerialize = localCommitSeq();
      return deps.serialize();
    }, fileName);
    if (outcome.kind === "cancelled") return "cancelled";
    await deps.saveDraft();
    const infos: string[] = [];
    // 存完就不脏了,否则「首页」「新建项目」每次都要多问一句。但序列化之后项目又变了(本机的 Agent、后台任务,
    // 或协作者),文件里没有那几笔:不能标「已保存」。是本机改的就告诉用户;协作者的修改本来就随时把项目标脏,不另说
    const changed = !!deps.currentProject && deps.currentProject() !== serialized;
    if (changed) {
      if (localCommitSeq() !== commitsAtSerialize) infos.push(CHANGED_DURING_SAVE_TEXT);
    } else deps.markSaved(fileName);
    if (outcome.kind === "downloaded") {
      // 这个 WebView 没有文件选择 API,至少告诉用户文件去哪了
      infos.unshift(`当前环境不支持选择目录，已保存到浏览器的下载位置：${outcome.where}`);
    } else if (outcome.snapshotsSkipped) {
      infos.push(SNAPSHOTS_SKIPPED_TEXT);
    }
    if (infos.length) deps.notify(infos.join("\n\n"), "info");
    return outcome.kind === "downloaded" ? "downloaded" : "saved";
  } catch (e) {
    if (e instanceof SaveBusy) return "busy";
    deps.notify(String((e as Error).message));
    return "failed";
  } finally {
    box.lock?.end();
  }
}

/**
 * 打包保存:.procp = 编排 + 项目用到的素材(A1)。
 *
 * 和保存项目同一条规矩 —— 挑落点必须是第一个 await,装包(从本地内容库按哈希取素材)只能排在挑好落点之后。
 */
export async function savePackedFile(fileName: string, deps: PackDeps): Promise<SaveResult> {
  if (isSaveLocked()) return "busy";
  let target: FileSystemFileHandle | null = null;
  try {
    target = await deps.pick(fileName);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return "cancelled"; // 用户取消,不是错误
    deps.notify(String((e as Error).message));
    return "failed";
  }
  const box: LockBox = { lock: null };
  try {
    const lock = lockFor(box, "procp");
    await waitLocal(deps, lock);
    lock.writing();
    // 没有哈希的老素材先补入库;补完仍进不了包的(文件真的不在了)在最后列给用户,不许悄悄漏掉
    const { blob, missing } = await deps.pack();
    let result: SaveResult = "saved";
    // 保存成了但要告诉用户的几件事合成一张卡片说(以前是接连两个 alert)
    const infos: string[] = [];
    if (target) {
      // 写临时副本、close 才替换原文件;出错 abort 丢掉临时副本,原来的包不变(`safeWrite.ts`)
      await (deps.writeHandle ?? writeToHandle)(target, blob);
    } else {
      deps.download(blob, fileName);
      infos.push(`当前环境不支持选择目录，已保存到浏览器的下载位置：${fileName}`);
      result = "downloaded";
    }
    if (missing.length) infos.push(deps.missingMessage(missing));
    if (infos.length) deps.notify(infos.join("\n\n"), "info");
    return result;
  } catch (e) {
    if (e instanceof SaveBusy) return "busy";
    deps.notify(String((e as Error).message));
    return "failed";
  } finally {
    box.lock?.end();
  }
}
