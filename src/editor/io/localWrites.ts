/**
 * 保存前等本机写完(`docs/semantics/mechanism/document-service.md`「保存基准与修改状态检查」:
 * 「本机修改状态检查覆盖当前设备前台编辑、待提交操作、保存、素材入库/上传、本机 Agent、渲染和后台写入。
 * 保存暂时禁用前台编辑，等待本机写完」)。
 *
 * 「写完」指**已经开始、还没落地**的本机写入都落地了 —— 不是等所有会在将来写项目的任务都跑完:转写、声音生成这类
 * 要跑几分钟、最后一次性写回的任务,在它写回之前项目里没有它的半截东西,保存不用等;它写回之后项目重新变脏,下次保存带上。
 *
 * 各项「算完了」的判据(前台编辑这时已被 `../saveLock.ts` 拦住,下面这些都是还在路上的本机写入):
 *   - 待提交操作:文档服务确认了本页面发出的全部修改,恢复日志落盘(`settle`,即 syncManager 的 `whenSaved`);没接文档服务时
 *     本地修改是同步落进 store 的,没有在路上的。
 *   - 素材入库/上传:当前项目里没有「这台设备正在导入」的素材 —— `pending: true` 而且这台设备手里有它的文件(`getMediaFile`)。
 *     别的设备正在传的素材也是 pending,但不是本机写入,不等(语义:非本机内容固定快照,不要求别处停写)。
 *   - 本机 Agent:没有 Agent 让页面执行的工具正在跑(`userEditing.ts` 的 `agentToolRunning`)。
 *   - 后台写入:最近 `QUIET_MS` 毫秒里没有本页面自己的修改落地(`onLocalCommit`)。前台已经拦住,这时还在落地的只能是
 *     后台任务、Agent、上锁前开始的输入收尾 —— 等它们停下来,不必一个个去认。
 *   - 渲染:预渲染快照随文件一起存(`proc.ts` 的 `collectFrameSnapshots`),在写文件那一步等;不在这里。
 * 前三样和「后台写入」都在 `timeoutMs` 的总时限里等;到时还没完就抛 `LocalWritesPending`,调用方不写文件、告诉用户在等什么。
 */
import { onLocalCommit } from "../../store/project";
import { agentToolRunning } from "../userEditing";
import { tr } from "../../i18n/index.ts";

/** 一样本机写入:现在还有几件没写完 */
export interface LocalWriteProbe {
  /** 给用户看的名字,带件数,例如「正在导入的素材（2 个）」 */
  label(count: number): string;
  count(): number;
}

/** 等本机写完的总时限(毫秒) */
export const LOCAL_WRITES_TIMEOUT_MS = 10_000;
/** 「后台写入停下来了」:这么久没有本页面的修改落地 */
export const QUIET_MS = 300;
/** 轮询间隔 */
const POLL_MS = 50;

export const PENDING_OPS_LABEL = tr("The document service confirming local changes");
export const BACKGROUND_LABEL = tr("A background task is writing to the project");

/** 等文档服务确认超时的说法(沿用原来的那句) */
export const SETTLE_TIMEOUT_TEXT = tr("Some changes have not been confirmed by the document service (you may be offline, the connection may be slow, or sync may be paused), so nothing was saved this time. Save again once connected and processing has finished.");

export function pendingWritesText(labels: readonly string[]): string {
  return tr("Some local writes have not finished: {0}. The original file was not changed, save again after they finish.", labels.join(tr(", ")));
}

/** 等到时限还没写完 */
export class LocalWritesPending extends Error {
  readonly labels: readonly string[];
  constructor(labels: readonly string[], message: string) {
    super(message);
    this.name = "LocalWritesPending";
    this.labels = labels;
  }
}

/* ── 本页面的修改落地时刻 ── */

let lastCommitAt = Number.NEGATIVE_INFINITY;
let commitSeq = 0;
onLocalCommit(() => {
  lastCommitAt = Date.now();
  commitSeq += 1;
});

/** 本页面最近一次修改落地的时刻(没有过是 -Infinity) */
export function lastLocalCommitAt(): number {
  return lastCommitAt;
}

/** 本页面落地过几次修改(只增不减;比两次读数就知道这之间本机改没改过) */
export function localCommitSeq(): number {
  return commitSeq;
}

/* ── 各样本机写入 ── */

/** 本机 Agent:有工具正在跑 */
export const agentToolProbe: LocalWriteProbe = {
  label: () => tr("Changes the Agent is making"),
  count: () => (agentToolRunning() ? 1 : 0),
};

interface MediaLike { id: string; pending?: boolean }

/** 素材入库/上传:这台设备正在导入、还没传完的素材 */
export function mediaImportProbe(media: () => readonly MediaLike[], hasLocalFile: (id: string) => boolean): LocalWriteProbe {
  return {
    label: (n) => tr("Media being imported ({0})", n),
    count: () => media().filter((m) => m.pending && hasLocalFile(m.id)).length,
  };
}

export interface WaitLocalWritesOptions {
  /** 等文档服务确认本页面的修改(超时抛错) */
  settle(timeoutMs: number): Promise<void>;
  probes: readonly LocalWriteProbe[];
  timeoutMs?: number;
  quietMs?: number;
  /** 正在等哪几样(给「正在保存」那一层) */
  onWaiting?(labels: readonly string[]): void;
  /** 测试用 */
  now?(): number;
  lastCommitAt?(): number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 等本机写完。全都写完回 resolve;到时限还有没写完的抛 `LocalWritesPending`(说法里列出在等什么)。
 * 等文档服务确认放在最后:前面几样写完才会产生最后一批要确认的修改;确认的这段时间里又有本页面的修改落地,就再来一轮。
 */
export async function waitForLocalWrites(o: WaitLocalWritesOptions): Promise<void> {
  const now = o.now ?? Date.now;
  const lastAt = o.lastCommitAt ?? lastLocalCommitAt;
  const quietMs = o.quietMs ?? QUIET_MS;
  const deadline = now() + (o.timeoutMs ?? LOCAL_WRITES_TIMEOUT_MS);
  let shown = "";
  const show = (labels: readonly string[]) => {
    const key = labels.join("|");
    if (key === shown) return;
    shown = key;
    o.onWaiting?.(labels);
  };
  for (;;) {
    const busy: string[] = [];
    for (const p of o.probes) {
      const n = p.count();
      if (n > 0) busy.push(p.label(n));
    }
    if (now() - lastAt() < quietMs) busy.push(BACKGROUND_LABEL);
    if (busy.length) {
      if (now() >= deadline) throw new LocalWritesPending(busy, pendingWritesText(busy));
      show(busy);
      await sleep(POLL_MS);
      continue;
    }
    show([PENDING_OPS_LABEL]);
    const seq = commitSeq;
    try {
      await o.settle(Math.max(0, deadline - now()));
    } catch {
      throw new LocalWritesPending([PENDING_OPS_LABEL], SETTLE_TIMEOUT_TEXT);
    }
    // 确认期间又有本页面的修改落地(后台任务、Agent):再看一轮
    if (commitSeq === seq && o.probes.every((p) => p.count() === 0)) {
      show([]);
      return;
    }
  }
}
