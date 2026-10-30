/**
 * 页面到文档服务的同步层(c65-design.md 第 4、6、8 节)。
 *
 * 一个 DocSync 实例 = 一个页面会话对一个项目的副本。它不认识 store,也不认识网络:
 *   - 往外发消息用构造时注入的 `send`;收到的消息由接线的一方调 `receive(msg)` 交进来;
 *   - 连上 / 断开由接线的一方调 `connect()` / `disconnect()` 告诉它;
 *   - 本地副本变了就发 `project` 事件,接 store 的那一侧(`bindStore`)把它写进 state。
 * 测试里用内存假件当文档服务,真连接由后续分支接。
 *
 * 数据流:
 *   - 本地修改:`commit(next)` 算 `diffProject(local, next)`,本地先落地(乐观),进待确认队列,
 *     按顺序提交 `project.op`。本地存的是 `applyOps(local, ops)` 的结果而不是 next 本身,
 *     这样本地副本与文档服务的副本连键的顺序都一样。
 *   - 别人的 `project.ops`:应用到「已确认副本」上,再把还没确认的本地操作重放一遍得到本地副本。
 *     这就是设计稿说的「撤回 - 应用远端 - 重放」,只是撤回不靠逆操作,而是直接从已确认副本重放,
 *     结果与文档服务里的顺序(先远端、后本地)逐字节一致。
 *   - 离线:操作照常落地、进队列;重连后第一条带 `expectRev: offlineRev`,被接受就依次发其余的,
 *     被拒(stale)就整批停下(status = "paused"),等 `replayOffline()` 或 `discardOffline()`。
 *   - `.proc` 保存:`whenSettled()` 等所有本地操作都拿到 ok。
 *   - 撤销:每个实例一个栈,撤销 = 提交逆操作(带 undoOf);这一步之后被别的写入身份改过的实体不撤。
 */
import {
  applyOps,
  diffProject,
  entitiesOf,
  entitiesOverlap,
  entityValuePath,
  getAt,
  type PathOp,
} from "../kernel/diffProject";
import { relocateOps, undoEntitiesOf, undoEntityOfOp } from "../kernel/cutPaths";
import type { Project } from "../kernel/project";
import { attachProjectSync, set, state } from "./core";
import { pageStateAfterRemote } from "./remotePageState";

/* ---------------- 消息 ---------------- */

/** 写入身份:actor 来自连接凭证(文档服务填),session 是页面会话或 Agent 对话号 */
export interface Writer {
  actor?: unknown;
  session?: string;
}

export interface OpenMsg {
  type: "project.open";
  projectId: string;
}

/** 线上的一条操作:多了一种「引用分片上传的整份项目」的根替换(`project.upload`,c65-design.md 第 13 节) */
export type WireOp = PathOp | { op: "set"; path: ""; upload: string };

export interface OpMsg {
  type: "project.op";
  projectId: string;
  opId: string;
  session: string;
  ops: WireOp[];
  expectRev?: number;
  undoOf?: string;
}

/** 大的根替换分片上传(文档服务 `project.upload`):收齐后由 `project.op` 的 `{ op: 'set', path: '', upload }` 引用 */
export interface UploadMsg {
  type: "project.upload";
  projectId: string;
  uploadId: string;
  index: number;
  count: number;
  data: string;
}

export type ClientMsg = OpenMsg | OpMsg | UploadMsg;

export interface StateMsg {
  type: "project.state";
  projectId?: string;
  rev: number;
  /** 大项目不带 project、带 parts(分片数),随后是 project.state.part / project.state.end */
  project?: Project | null;
  parts?: number;
  writers?: unknown;
}

export interface StatePartMsg {
  type: "project.state.part";
  projectId?: string;
  rev: number;
  index: number;
  count: number;
  data: string;
}

export interface StateEndMsg {
  type: "project.state.end";
  projectId?: string;
  rev: number;
  digest?: string;
}

export interface OkMsg {
  type: "project.op.ok";
  opId: string;
  rev: number;
  overwrote?: { entity: string; by: Writer }[];
}

export interface SinceEntry {
  rev: number;
  actor?: unknown;
  session?: string;
  paths?: string[];
}

export interface RejectedMsg {
  type: "project.op.rejected";
  opId: string;
  reason: "stale" | "bad-path" | "too-large" | "forbidden" | string;
  currentRev?: number;
  since?: SinceEntry[];
}

export interface OpsMsg {
  type: "project.ops";
  rev: number;
  opId: string;
  /** 上传引用的大根替换广播时不带 ops、带 resync: true,页面重新 open */
  ops?: PathOp[];
  resync?: boolean;
  actor?: unknown;
  session?: string;
  undoOf?: string;
}

export interface OverwrittenMsg {
  type: "project.overwritten";
  entity: string;
  by: Writer;
  rev: number;
}

export type ServerMsg = StateMsg | StatePartMsg | StateEndMsg | OkMsg | RejectedMsg | OpsMsg | OverwrittenMsg;

/* ---------------- 对外的状态与通知 ---------------- */

/**
 * idle:还没连;connecting:发了 open 在等 project.state;online:正常;
 * offline:断线,操作进队列;paused:离线批次的第一条被拒,等用户选「重放 / 丢弃」
 */
export type SyncStatus = "idle" | "connecting" | "online" | "offline" | "paused";

export interface SkippedEntity {
  entity: string;
  /** 这一步之后改过它的写入身份(最近的那一个) */
  by: Writer;
}

export interface UndoResult {
  /** 至少撤了一处 */
  done: boolean;
  /** 因为别的写入身份后来改过而没撤的实体 */
  skipped: SkippedEntity[];
  /** 逆操作落不下去(比如父级已被删)而没撤的实体 */
  failed: string[];
  /** 这次撤销 / 重做提交的 opId;done 为 false 时没有 */
  opId?: string;
  /**
   * 因为别人后来改过而没撤的那几样(`skipped`)交给「冲突合并」窗口用的材料(2026-10-18 用户定,0.7.20 接上):
   * `landed` 是那一步落地后的项目,`reverted` 是在它上面只撤这几样之后的项目。界面按修改项逐条比(`mergeItems.ts` 的 `diffThings`):
   * 基准是 `landed`(期望云端仍是它)、我这边是 `reverted`。不知道那一步落地后是什么样(撤别人那一步、本页面没亲眼看到它落地)时没有。
   */
  conflict?: { landed: Project; reverted: Project };
}

export type SyncNotice =
  | { kind: "rejected"; opId: string; reason: string }
  | { kind: "replay-dropped"; opId: string; detail: string }
  | { kind: "overwrote"; opId: string; entities: { entity: string; by: Writer }[] }
  | { kind: "overwritten"; entity: string; by: Writer; rev: number }
  | { kind: "undo"; redo: boolean; result: UndoResult }
  | { kind: "resync"; reason: string }
  /** 别人的一次改动落到了本地副本上(时间轴描边 1.5 s 用) */
  | { kind: "remote"; rev: number; opId: string; entities: string[]; by: Writer; undoOf?: string }
  /** AI 栏「撤销这一步」:撤的是别人(Agent)那次提交 */
  | { kind: "revert-remote"; of: string; result: UndoResult };

/** 本地备份:被覆盖的实体、或被丢弃的离线批次。由接线的一方落盘(草稿目录下 backups/) */
export type LocalBackup =
  | { kind: "overwritten"; projectId: string; entity: string; by: Writer; rev: number; value: unknown; at: number }
  | { kind: "offline-discard"; projectId: string; baseRev: number; batch: { opId: string; ops: PathOp[] }[]; project: Project; at: number };

export interface PausedInfo {
  /** 离线时记下的版本 */
  offlineRev: number;
  /** 文档服务当前的版本 */
  currentRev?: number;
  /** 离线期间别人落地的改动 */
  since?: SinceEntry[];
  /** 攒着没发的本地操作条数 */
  queued: number;
}

/**
 * 本页面看到落地的一次提交(自己的拿到 ok、别人的收到 project.ops)的摘要,形状同文档服务历史里的那一条
 * (`server/docservice/modules/project.mjs` 的提交摘要)。「搬到云端」把它连同历史序号带上去(`history` 读)。
 */
export interface CommitSummary {
  rev: number;
  opId: string;
  /** 自己的提交是 null(写入身份由文档服务按连接定,本页面不知道原样) */
  actor: unknown;
  at: number;
  paths: string[];
  entities: string[];
}

export interface CommitOptions {
  /** false:不进撤销栈(素材元数据回填、总时长跟随等) */
  undoable?: boolean;
  /** 同一个 key、合并窗口内的提交合并成撤销栈上的一步(滑块一次拖动、数字框连续步进) */
  mergeKey?: string;
  /** 合并窗口(毫秒,以上一次合并为准往后滚);不传取 `MERGE_WINDOW_MS`;`Infinity` = 只认 key */
  mergeWindowMs?: number;
}

export interface DocSyncOptions {
  /** Only explicit creation may initialize an empty service room. */
  initialize?: boolean;
  projectId: string;
  /** 这个页面会话的 id,写进每次提交 */
  session: string;
  send: (msg: ClientMsg) => void;
  newOpId?: () => string;
  now?: () => number;
  saveBackup?: (backup: LocalBackup) => void;
}

/* ---------------- 内部 ---------------- */

interface Pending {
  opId: string;
  ops: PathOp[];
  inverse: PathOp[];
  undoOf?: string;
  sent: boolean;
  /** 拿到 ok 但还没并进已确认副本(在等 project.state 时) */
  ackRev?: number;
  /** 已发出、但在最新的已确认副本上重放失败 —— 文档服务那边也会拒 */
  brokenLocally?: boolean;
}

interface Step {
  opIds: string[];
  /** 撤这一步要应用的操作(按顺序) */
  inverse: PathOp[];
  entities: string[];
  /** 这一步第一条提交落地的版本;还没确认时为 undefined */
  rev?: number;
  mergeKey?: string;
  lastAt: number;
  /** 这一步落地后的本地副本(撤销遇到冲突时交给「冲突合并」窗口当基准;项目对象不原地改,存引用不复制) */
  after?: Project;
}

interface RemoteWrite {
  rev: number;
  opId: string;
  by: Writer;
  entities: string[];
}

/** 本页面已确认的提交(AI 栏撤 Agent 那一步时,自己后来改过的也要挡) */
interface LocalWrite {
  rev: number;
  entities: string[];
}

/** 撤别人的一次提交要的材料(AI 栏「撤销这一步」):那次提交的 opId 与逆操作,知道的话再给它落地的版本号 */
export interface RemoteStep {
  opId: string;
  /** 不给就用本页面收到那次提交时自己算的逆操作;两边都没有就撤不了 */
  inverse?: PathOp[];
  /** 那次提交落地的版本号;不给就按本页面收到的 project.ops 查 */
  rev?: number;
  /** 那次提交的写入身份;不给就按本页面收到的 project.ops 查(都查不到时,之后的任何远端写入都算别人) */
  by?: Writer;
}

type Events = {
  /**
   * 本地副本换了。`commit` / `load` 是 store 自己(setProject / loadProject)发起的,调用方拿返回值写 state;
   * 其余都不是经 store 发起的,接 store 的一侧要把它写进 state。`revert-remote` 是 AI 栏「撤销这步」
   * (`revertRemote`):以本页面身份提交,但不经 setProject,所以不能算 `commit`。
   */
  project: (project: Project, cause: "commit" | "remote" | "state" | "rejected" | "undo" | "redo" | "revert-remote" | "discard" | "replay" | "load") => void;
  status: (status: SyncStatus) => void;
  notice: (notice: SyncNotice) => void;
};

export const UNDO_LIMIT = 100;
/** 本页面发出的提交记多少条 opId(`opIdsSince`) */
const OWN_OPS_KEEP = 1000;
export const MERGE_WINDOW_MS = 300;
/** 文档服务单次提交 ops 序列化后的上限(`PROJECT_LIMITS.MAX_OPS_BYTES`):超过就改成根替换、走分片上传 */
export const MAX_OPS_BYTES = 256 * 1024;
/** 分片上传每片的字符数:UTF-8 最坏 4 字节 / 字符,128 Ki 字符不超过文档服务每片 512 KiB 的上限 */
export const UPLOAD_PART_CHARS = 128 * 1024;
/** 文档服务 `UPLOAD_MAX_PARTS` */
export const UPLOAD_MAX_PARTS = 64;

/** 文本按 UTF-8 的字节数;短到不可能超限时直接回字符数,省一次编码 */
const utf8Bytes = (text: string): number => {
  if (text.length * 3 <= MAX_OPS_BYTES) return text.length;
  return new TextEncoder().encode(text).length;
};
const BEFORE_REMOTE_KEEP = 32;
/** 记多少次 Agent 提交的逆操作 */
const REMOTE_INVERSE_KEEP = 200;
/** 提交摘要记多少条(与文档服务 `PROJECT_LIMITS.HISTORY` 同数) */
const COMMIT_LOG_KEEP = 1000;
/** 一条摘要里最多记几个路径(文档服务的 `capPaths` 也只留一部分) */
const COMMIT_PATHS_KEEP = 32;

let opSeq = 0;
function defaultOpId(session: string): string {
  opSeq++;
  const rand = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${session}:${Date.now().toString(36)}:${opSeq.toString(36)}:${rand}`;
}

export class DocSync {
  readonly projectId: string;
  readonly session: string;
  private readonly sendMsg: (msg: ClientMsg) => void;
  private readonly newOpId: () => string;
  private readonly now: () => number;
  private readonly saveBackup?: (backup: LocalBackup) => void;
  private readonly initialize: boolean;

  private local: Project;
  private confirmed: Project | null = null;
  private confirmedRev = 0;
  private pending: Pending[] = [];

  private connected = false;
  private awaitingState = false;
  /** 断线时最后知道的版本;没有离线批次时为 null */
  private offlineRev: number | null = null;
  /** 离线批次的第一条已发出、在等它的回音;这期间其余的不发 */
  private gateOpId: string | null = null;
  private paused: PausedInfo | null = null;

  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private stepOf = new Map<string, Step>();
  private remoteWrites: RemoteWrite[] = [];
  private localWrites: LocalWrite[] = [];
  /** Agent 提交的 opId → 它落地的版本号与逆操作(按收到的 project.ops 在已确认副本上算) */
  private remoteInverses = new Map<string, { rev: number; inverse: PathOp[]; after?: Project }>();
  /** rev → 应用这次远端改动之前的本地副本,给覆盖备份用 */
  private beforeRemote = new Map<number, Project>();
  /** 本页面看到落地的提交摘要(按历史序号递增;`history` 读) */
  private commitLog: CommitSummary[] = [];

  private listeners: { [K in keyof Events]: Set<Events[K]> } = { project: new Set(), status: new Set(), notice: new Set() };
  private settleWaiters: { resolve: (v: { rev: number; project: Project }) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }[] = [];

  constructor(initial: Project, opts: DocSyncOptions) {
    this.local = initial;
    this.projectId = opts.projectId;
    this.session = opts.session;
    this.sendMsg = opts.send;
    this.newOpId = opts.newOpId ?? (() => defaultOpId(opts.session));
    this.now = opts.now ?? (() => Date.now());
    this.saveBackup = opts.saveBackup;
    this.initialize = opts.initialize !== false;
  }

  /* ---------- 读 ---------- */

  get project(): Project {
    return this.local;
  }

  /** 文档服务确认过的版本号 */
  get rev(): number {
    return this.confirmedRev;
  }

  /**
   * 文档服务确认过的那一版项目(`rev` 那一版;还没有回 null)。只读:纯浏览器节点发布清单计划时按版本号留存它
   * (M7 契约 D6:执行细任务用任务的 `projectRev` 那一版),不改它。
   */
  get confirmedProject(): Project | null {
    return this.confirmed;
  }

  /**
   * 本页面看到落地的提交摘要(历史序号递增、最多 `COMMIT_LOG_KEEP` 条;拷贝,不给改)。只含这条连接打开以来确认过的那几笔:
   * 更早的在文档服务自己的历史里。「搬到云端」连同 `rev` 一起带上去,云端项目的历史序号与摘要接着本机这一份往下记。
   */
  get history(): CommitSummary[] {
    return this.commitLog.map((c) => ({ ...c, paths: [...c.paths], entities: [...c.entities] }));
  }

  private noteCommit(rev: number, opId: string, actor: unknown, ops: { path: string }[], entities: string[]) {
    const last = this.commitLog[this.commitLog.length - 1];
    if (last && last.rev >= rev) return;
    this.commitLog.push({ rev, opId, actor: actor ?? null, at: this.now(), paths: ops.slice(0, COMMIT_PATHS_KEEP).map((o) => o.path), entities: entities.slice(0, 64) });
    if (this.commitLog.length > COMMIT_LOG_KEEP) this.commitLog.splice(0, this.commitLog.length - COMMIT_LOG_KEEP);
  }

  /** Device-owned crash recovery, never used as a root replacement on normal reentry. */
  recoveryJournal() {
    return { version: 1, projectId: this.projectId, project: this.local, rev: this.confirmedRev,
      offlineRev: this.offlineRev, pending: this.pending.map(p => ({ ...p, sent: false })) };
  }

  restoreJournal(journal: ReturnType<DocSync["recoveryJournal"]>) {
    if (journal.version !== 1 || journal.projectId !== this.projectId || !Number.isSafeInteger(journal.rev) || journal.rev < 0 || !Array.isArray(journal.project?.tracks)
      || !Array.isArray(journal.pending) || journal.pending.some(p => typeof p.opId !== "string" || !Array.isArray(p.ops) || !Array.isArray(p.inverse))) throw new Error("离线操作恢复数据损坏");
    const newer = this.pending;
    let recovered = journal.project;
    for (const p of newer) { const applied = applyOps(recovered, p.ops); if (!applied.ok) throw new Error("恢复期间的离线修改无法接续；请先保留独立备份"); recovered = applied.value; }
    this.local = recovered;
    this.confirmedRev = journal.rev;
    this.offlineRev = journal.pending.length || newer.length ? journal.offlineRev ?? journal.rev : null;
    this.pending = [...journal.pending.map(p => ({ ...p, sent: false })), ...newer];
    this.emit("project", this.local, "state");
  }

  get status(): SyncStatus {
    if (this.paused) return "paused";
    if (!this.connected) return this.confirmed || this.offlineRev !== null ? "offline" : "idle";
    if (this.awaitingState) return "connecting";
    return "online";
  }

  get pausedInfo(): PausedInfo | null {
    return this.paused ? { ...this.paused, queued: this.pending.length } : null;
  }

  /** 还没拿到 ok 的本地提交条数 */
  get unconfirmed(): number {
    return this.pending.length;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  on<K extends keyof Events>(event: K, cb: Events[K]): () => void {
    (this.listeners[event] as Set<Events[K]>).add(cb);
    return () => {
      (this.listeners[event] as Set<Events[K]>).delete(cb);
    };
  }

  private emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>) {
    for (const cb of this.listeners[event] as Set<(...a: Parameters<Events[K]>) => void>) cb(...args);
  }

  private setLocal(p: Project, cause: Parameters<Events["project"]>[1]) {
    if (p === this.local) return;
    this.local = p;
    this.emit("project", p, cause);
  }

  private statusChanged(before: SyncStatus) {
    const after = this.status;
    if (after !== before) this.emit("status", after);
  }

  /* ---------- 连接 ---------- */

  /** 连上了(或重连上了):发 project.open,等 project.state */
  connect() {
    const before = this.status;
    this.connected = true;
    this.awaitingState = true;
    this.partial = null;
    this.sendMsg({ type: "project.open", projectId: this.projectId });
    this.statusChanged(before);
  }

  /** 断了:在途的提交当没发(重连后用原 opId 重发,文档服务按 opId 去重) */
  disconnect() {
    if (!this.connected) return;
    const before = this.status;
    this.connected = false;
    this.awaitingState = false;
    this.handingOver = false;
    this.partial = null;
    if (this.confirmed && this.offlineRev === null) this.offlineRev = this.confirmedRev;
    this.gateOpId = null;
    for (const p of this.pending) if (p.ackRev === undefined) p.sent = false;
    this.statusChanged(before);
  }

  /**
   * 计划内换连接(账号云端项目的连接到期前换到新会话上,`src/editor/sync/link.ts` 的 `renew`):新连接已经建好、旧连接作废的那一刻调。
   * 和断线重连的区别是**不记成离线**:在途的提交当没发、在新连接上重新 `project.open`,拿到状态后未确认的照常补发
   * (文档服务按 opId 去重),不走离线批次的版本闸 —— 这一下不是用户离线,别人恰好在这时改了项目也不该弹离线对话框。
   * 拿到的状态版本与手里已确认的相同(换的这一下没有别人的改动)时,手里的项目对象原样留着,不换新对象。
   * 本来就在离线批次里(已有离线版本、或正暂停着)的,照离线的规矩走,这里不改。
   */
  handover() {
    const before = this.status;
    this.connected = true;
    this.awaitingState = true;
    this.handingOver = true;
    this.partial = null;
    for (const p of this.pending) if (p.ackRev === undefined) p.sent = false;
    this.sendMsg({ type: "project.open", projectId: this.projectId });
    this.statusChanged(before);
  }
  private handingOver = false;

  /** 收到文档服务的一条消息 */
  receive(msg: ServerMsg) {
    const before = this.status;
    switch (msg.type) {
      case "project.state":
        if (msg.project === undefined && typeof msg.parts === "number") this.onStateStart(msg);
        else this.onState(msg);
        break;
      case "project.state.part":
        this.onStatePart(msg);
        break;
      case "project.state.end":
        this.onStateEnd(msg);
        break;
      case "project.ops":
        this.onOps(msg);
        break;
      case "project.op.ok":
        this.onOk(msg);
        break;
      case "project.op.rejected":
        this.onRejected(msg);
        break;
      case "project.overwritten":
        this.onOverwritten(msg);
        break;
    }
    this.statusChanged(before);
    this.checkSettled();
  }

  private resync(reason: string) {
    this.emit("notice", { kind: "resync", reason });
    if (!this.connected) return;
    this.awaitingState = true;
    this.partial = null;
    this.sendMsg({ type: "project.open", projectId: this.projectId });
  }

  private onState(msg: StateMsg) {
    if (!this.awaitingState) return;
    this.awaitingState = false;
    const handover = this.handingOver;
    this.handingOver = false;
    if (this.gateOpId) {
      // 离线批次的第一条还没回音就重新同步了:按没发处理,下面重新试
      const g = this.pending.find((p) => p.opId === this.gateOpId);
      if (g && g.ackRev === undefined) g.sent = false;
      this.gateOpId = null;
    }
    if (msg.project == null) {
      if (!this.initialize) {
        this.connected = false;
        this.emit("notice", { kind: "resync", reason: "协作服务状态缺失，保留本地内容，请从原备份恢复。" });
        this.emit("status", this.status);
        return;
      }
      // 文档服务还没有这个项目:把本地这一份(连同还没确认的修改)以根替换写进去
      const seed: Pending = { opId: this.newOpId(), ops: [{ op: "set", path: "", value: this.local }], inverse: [], sent: false };
      for (const p of this.pending) {
        const step = this.stepOf.get(p.opId);
        if (step) this.stepOf.set(seed.opId, step);
      }
      this.pending = [seed];
      this.confirmed = null;
      this.confirmedRev = msg.rev;
      this.offlineRev = null;
      this.flush();
      return;
    }
    // 已经在这份快照里的(拿过 ok、rev 不超过快照)不再重放
    this.pending = this.pending.filter((p) => p.ackRev === undefined || p.ackRev > msg.rev);
    if (handover && this.confirmed !== null && msg.rev === this.confirmedRev && this.offlineRev === null && !this.paused) {
      // 计划内换连接、期间没有新版本:同一个版本的内容必然相同,手里的对象(已确认副本与本地副本)原样留着,只把没确认的补发
      this.flush();
      return;
    }
    this.confirmed = msg.project;
    this.confirmedRev = msg.rev;
    if (this.commitLog.length && this.commitLog[this.commitLog.length - 1].rev > msg.rev) this.commitLog = this.commitLog.filter((c) => c.rev <= msg.rev);
    this.beforeRemote.clear();
    const hasBacklog = this.offlineRev !== null && this.pending.some((p) => !p.sent);
    if (hasBacklog && !this.paused) {
      // 离线批次:本地副本先不动,第一条带 offlineRev 去试
      this.sendGate();
      return;
    }
    if (this.paused) return;
    this.offlineRev = null;
    this.setLocal(this.pending.length ? this.replay(this.confirmed) : this.confirmed, "state");
    this.flush();
  }

  /** 分片接收中的快照:拼完之前到的 project.ops(rev 大于快照的)先攒着 */
  private partial: { rev: number; count: number; chunks: string[]; buffered: OpsMsg[] } | null = null;

  private onStateStart(msg: StateMsg) {
    if (!this.awaitingState) return;
    this.partial = { rev: msg.rev, count: msg.parts!, chunks: [], buffered: [] };
  }

  private onStatePart(msg: StatePartMsg) {
    if (!this.partial || msg.rev !== this.partial.rev) return;
    this.partial.chunks[msg.index] = msg.data;
  }

  private onStateEnd(msg: StateEndMsg) {
    const part = this.partial;
    if (!part || msg.rev !== part.rev) return;
    this.partial = null;
    let project: Project;
    try {
      if (part.chunks.length !== part.count || part.chunks.some((c) => typeof c !== "string")) throw new Error("分片不全");
      project = JSON.parse(part.chunks.join(""));
    } catch (e) {
      this.resync(`项目分片拼不起来:${(e as Error).message}`);
      return;
    }
    this.onState({ type: "project.state", rev: part.rev, project });
    for (const m of part.buffered) this.onOps(m);
  }

  private onOps(msg: OpsMsg) {
    // 文档服务不回发给提交者;万一回发了,当 ok 处理
    if (this.pending.some((p) => p.opId === msg.opId)) {
      this.onOk({ type: "project.op.ok", opId: msg.opId, rev: msg.rev });
      return;
    }
    if (this.partial) {
      if (msg.rev > this.partial.rev) this.partial.buffered.push(msg);
      return;
    }
    if (this.awaitingState || !this.confirmed) return;
    if (msg.rev <= this.confirmedRev) return;
    if (msg.resync || !Array.isArray(msg.ops)) {
      this.resync("远端的大根替换没带操作,重新打开");
      return;
    }
    if (msg.rev !== this.confirmedRev + 1) {
      this.resync(`版本跳号:本地 ${this.confirmedRev},收到 ${msg.rev}`);
      return;
    }
    const r = applyOps(this.confirmed, msg.ops);
    if (!r.ok) {
      this.resync(`远端操作在已确认副本上落不下去:${r.detail}`);
      return;
    }
    // 顺手记下这次别人提交的逆操作(AI 栏「撤销这一步」用;事件里带了 inverse 时以事件为准)。
    // 不按 actor.role 挑:本机 local 空间里 Agent 的连接眼下还是 page 身份(c65-integ 报告第 7 节),分不出来
    this.remoteInverses.set(msg.opId, { rev: msg.rev, inverse: diffProject(r.value, this.confirmed).ops, after: r.value });
    if (this.remoteInverses.size > REMOTE_INVERSE_KEEP) this.remoteInverses.delete(this.remoteInverses.keys().next().value!);
    this.confirmed = r.value;
    this.confirmedRev = msg.rev;
    const by: Writer = { actor: msg.actor, session: msg.session ?? (msg.actor as { session?: string } | undefined)?.session };
    const remoteEntities = entitiesOf(msg.ops);
    this.remoteWrites.push({ rev: msg.rev, opId: msg.opId, by, entities: undoEntitiesOf(msg.ops) });
    this.noteCommit(msg.rev, msg.opId, msg.actor, msg.ops, remoteEntities);
    this.emit("notice", { kind: "remote", rev: msg.rev, opId: msg.opId, entities: remoteEntities, by, ...(msg.undoOf ? { undoOf: msg.undoOf } : {}) });
    this.pruneRemoteWrites();
    this.beforeRemote.set(msg.rev, this.local);
    if (this.beforeRemote.size > BEFORE_REMOTE_KEEP) this.beforeRemote.delete(this.beforeRemote.keys().next().value!);

    // 离线批次在等回音、或已暂停:本地副本先不动
    if (this.gateOpId || this.paused) return;
    if (this.pending.length === 0) {
      // 没有未确认的:直接在本地副本上应用,与已确认副本合成同一棵树
      const r2 = applyOps(this.local, msg.ops);
      if (r2.ok) {
        this.confirmed = r2.value;
        this.setLocal(r2.value, "remote");
      } else {
        this.setLocal(this.confirmed, "remote");
      }
      return;
    }
    this.setLocal(this.replay(this.confirmed), "remote");
  }

  private onOk(msg: OkMsg) {
    const idx = this.pending.findIndex((p) => p.opId === msg.opId);
    if (idx < 0) return;
    const entry = this.pending[idx];
    const step = this.stepOf.get(entry.opId);
    if (step && step.rev === undefined) step.rev = msg.rev;
    if (msg.overwrote?.length) this.emit("notice", { kind: "overwrote", opId: entry.opId, entities: msg.overwrote });

    if (this.awaitingState) {
      entry.ackRev = msg.rev;
      return;
    }
    if (msg.rev <= this.confirmedRev) {
      // 重发的提交其实早已落地(已经含在快照里):去掉,不再应用
      this.pending.splice(idx, 1);
      if (this.gateOpId === entry.opId) this.openGate();
      else if (!this.gateOpId && !this.paused && this.confirmed) this.setLocal(this.replay(this.confirmed), "commit");
      return;
    }
    // 换连接之后也可能走到这里:旧连接上在途的提交晚到,先于排在它前面那条的回音。不去猜前面那条落没落地
    // (猜错了页面与文档服务的内容会悄悄不一样),一律整份重取、在取到的状态上重放没确认的
    if (idx !== 0 || msg.rev !== this.confirmedRev + 1 || entry.brokenLocally) {
      this.resync(`确认乱序或与本地不一致:${entry.opId} rev ${msg.rev}`);
      return;
    }
    if (this.confirmed === null) {
      // 根替换建项目
      const r0 = applyOps({} as Project, entry.ops);
      if (!r0.ok) return this.resync("建项目的根替换落不下去");
      this.confirmed = r0.value;
    } else {
      const r = applyOps(this.confirmed, entry.ops);
      if (!r.ok) {
        this.resync(`已确认的提交在已确认副本上落不下去:${r.detail}`);
        return;
      }
      this.confirmed = r.value;
    }
    this.confirmedRev = msg.rev;
    this.pending.shift();
    this.localWrites.push({ rev: msg.rev, entities: undoEntitiesOf(entry.ops) });
    this.noteCommit(msg.rev, entry.opId, null, entry.ops, entitiesOf(entry.ops));
    this.pruneRemoteWrites();
    if (this.gateOpId === entry.opId) {
      this.openGate();
      return;
    }
    // 全部确认完:本地副本就是已确认副本,并成同一棵树
    if (this.pending.length === 0 && !this.paused && !this.gateOpId) this.confirmed = this.local;
  }

  private onRejected(msg: RejectedMsg) {
    const idx = this.pending.findIndex((p) => p.opId === msg.opId);
    if (idx < 0) return;
    const entry = this.pending[idx];
    if (msg.reason === "stale" && this.gateOpId === entry.opId) {
      entry.sent = false;
      this.gateOpId = null;
      this.paused = { offlineRev: this.offlineRev ?? this.confirmedRev, currentRev: msg.currentRev, since: msg.since, queued: this.pending.length };
      return;
    }
    this.pending.splice(idx, 1);
    this.dropSteps([entry.opId]);
    this.emit("notice", { kind: "rejected", opId: entry.opId, reason: msg.reason });
    if (this.gateOpId === entry.opId) {
      // 离线批次的第一条因为别的原因被拒:下一条接着当「第一条」去试
      this.gateOpId = null;
      this.sendGate();
      return;
    }
    if (this.confirmed && !this.paused && !this.gateOpId) this.setLocal(this.replay(this.confirmed), "rejected");
  }

  private onOverwritten(msg: OverwrittenMsg) {
    // 先把自己那一版的该实体存成本地备份,再(或已经)换成新版本
    const mine = this.beforeRemote.get(msg.rev) ?? this.local;
    this.saveBackup?.({ kind: "overwritten", projectId: this.projectId, entity: msg.entity, by: msg.by, rev: msg.rev, value: getAt(mine, entityValuePath(msg.entity)), at: this.now() });
    this.emit("notice", { kind: "overwritten", entity: msg.entity, by: msg.by, rev: msg.rev });
  }

  /* ---------- 离线批次 ---------- */

  private sendGate() {
    const first = this.pending.find((p) => !p.sent);
    if (!first || !this.connected || this.awaitingState) {
      if (!first) this.openGate();
      return;
    }
    this.gateOpId = first.opId;
    first.sent = true;
    this.sendOp(first, this.offlineRev ?? this.confirmedRev);
  }

  private openGate() {
    this.gateOpId = null;
    this.offlineRev = null;
    if (this.confirmed) this.setLocal(this.pending.length ? this.replay(this.confirmed) : this.confirmed, "replay");
    this.flush();
  }

  /** 离线批次被拒后,用户选「重放」:去掉期望版本,依次提交 */
  replayOffline() {
    if (!this.paused) return;
    const before = this.status;
    this.paused = null;
    this.offlineRev = null;
    if (this.confirmed) this.setLocal(this.replay(this.confirmed), "replay");
    this.flush();
    this.statusChanged(before);
    this.checkSettled();
  }

  /** 离线批次被拒后,用户选「丢弃」:先把这批存成本地备份,再回到文档服务的版本 */
  discardOffline() {
    if (!this.paused) return;
    const before = this.status;
    const batch = this.pending.map((p) => ({ opId: p.opId, ops: p.ops }));
    this.saveBackup?.({ kind: "offline-discard", projectId: this.projectId, baseRev: this.paused.offlineRev, batch, project: this.local, at: this.now() });
    this.dropSteps(batch.map((b) => b.opId));
    this.redoStack = [];
    this.pending = [];
    this.paused = null;
    this.offlineRev = null;
    if (this.confirmed) this.setLocal(this.confirmed, "discard");
    this.statusChanged(before);
    this.checkSettled();
  }

  /**
   * 把一份离线改过的内容(从云端项目另存出去、之后在本地副本里改过的文件)当一次普通修改合上去(10-14 第 3.4 节)。
   * 差异按当前已确认的那一版算,`baseRev` 是那份文件另存时的历史序号:
   * - 文档服务现在还是 `baseRev`(期间没人改过):就是一次普通提交;
   * - 期间有人改过:照离线批次办 —— 这一条带 `baseRev` 去试,被拒成 stale 就停下(paused),
   *   由用户照现有的冲突处理选「重放 / 丢弃」(丢弃前存一份本地备份)。
   * 连接还没就绪(没拿到已确认的一版、在等状态、已经停着)抛错;没有差异回 false,什么都不发。
   */
  mergeOffline(next: Project, baseRev: number): boolean {
    if (!this.connected || this.awaitingState || !this.confirmed || this.paused || this.gateOpId) throw new Error("文档连接还没就绪，不能合并离线修改");
    if (!Number.isSafeInteger(baseRev) || baseRev < 0) throw new Error("离线修改的历史序号不对");
    if (baseRev === this.confirmedRev && this.offlineRev === null) {
      // 不是经 store 发起的:用 replay 作原因,接 store 的一侧把结果写进 state
      const prev = this.local;
      return this.commitInternal(next, {}, undefined, undefined, "replay") !== prev;
    }
    const before = this.status;
    const d = diffProject(this.local, next);
    if (d.ops.length === 0) return false;
    const r = applyOps(this.local, d.ops);
    if (!r.ok) throw new Error(`离线修改落不下去:${r.detail}`);
    const ops: PathOp[] = utf8Bytes(JSON.stringify(d.ops)) > MAX_OPS_BYTES ? [{ op: "set", path: "", value: r.value }] : d.ops;
    const entry: Pending = { opId: this.newOpId(), ops, inverse: d.inverse, sent: false };
    this.pending.push(entry);
    this.noteOwnOp(entry.opId);
    this.offlineRev = baseRev;
    // 离线批次:本地副本是带着离线修改的那一份,已确认副本不动;文档服务答了再定
    this.setLocal(r.value, "replay");
    this.sendGate();
    this.statusChanged(before);
    return true;
  }

  /**
   * 撤销遇到冲突时,同一样东西里没被别人改过的那几项直接撤(0.7.20,`src/editor/sync/undoConflict.ts`):
   * 一次普通提交,但不进撤销栈(它是刚才那次撤销的一部分);不是经 store 发起的,用 replay 作原因让接 store 的一侧写进 state。
   */
  commitAside(next: Project): boolean {
    const prev = this.local;
    return this.commitInternal(next, { undoable: false }, undefined, undefined, "replay") !== prev;
  }

  /* ---------- 本地修改 ---------- */

  /**
   * 本地改成 next:算差异、乐观落地、进队列并尽量发出。
   * 返回落地后的本地副本(键的顺序以它为准),调用方把它写进 store。
   */
  commit(next: Project, opts: CommitOptions = {}): Project {
    return this.commitInternal(next, opts, undefined, undefined);
  }

  /** 载入另一份内容(打开旧 .proc、Skill 合并结果):一次根替换,清空撤销栈 */
  load(next: Project): Project {
    this.undoStack = [];
    this.redoStack = [];
    this.stepOf.clear();
    const entry: Pending = { opId: this.newOpId(), ops: [{ op: "set", path: "", value: next }], inverse: [{ op: "set", path: "", value: this.local }], sent: false };
    this.pending.push(entry);
    this.noteOwnOp(entry.opId);
    this.setLocal(next, "load");
    this.flush();
    return this.local;
  }

  /* ---------- 本页面发出的提交(留在页面的 Agent 工具回包里带 opIds 用) ---------- */

  private ownOps: string[] = [];
  private ownOpsBase = 0;

  private noteOwnOp(opId: string) {
    this.ownOps.push(opId);
    if (this.ownOps.length > OWN_OPS_KEEP) {
      const drop = this.ownOps.length - OWN_OPS_KEEP;
      this.ownOps.splice(0, drop);
      this.ownOpsBase += drop;
    }
  }

  /** 记个位置;之后用 `opIdsSince` 取这之后本页面发出的提交的 opId */
  opMark(): number {
    return this.ownOpsBase + this.ownOps.length;
  }

  /** `opMark()` 之后本页面发出的提交(含撤销、载入);太久远、已修剪掉的那部分取不到 */
  opIdsSince(mark: number): string[] {
    return this.ownOps.slice(Math.max(0, mark - this.ownOpsBase));
  }

  private commitInternal(
    next: Project,
    opts: CommitOptions,
    undoOf: string | undefined,
    target: "undo" | "redo" | undefined,
    cause: "commit" | "undo" | "redo" | "revert-remote" | "replay" = target ?? "commit",
  ): Project {
    const prev = this.local;
    const d = diffProject(prev, next);
    if (d.ops.length === 0) return prev;
    const r = applyOps(prev, d.ops);
    if (!r.ok) throw new Error(`diffProject 产出的操作落不下去:${r.detail}`);
    // 差异本身超过文档服务的单次上限:改成一条根替换(值就是落地后的本地副本),发送时走分片上传。
    // 在已确认副本上重放它得到的仍是这一份,与文档服务「最后写的赢」一致;逆操作照旧用差异算的那份
    const ops: PathOp[] = utf8Bytes(JSON.stringify(d.ops)) > MAX_OPS_BYTES ? [{ op: "set", path: "", value: r.value }] : d.ops;
    const entry: Pending = { opId: this.newOpId(), ops, inverse: d.inverse, undoOf, sent: false };
    this.pending.push(entry);
    this.noteOwnOp(entry.opId);
    const now = this.now();
    if (target) {
      // 撤销 / 重做本身:它的逆操作进对面的栈
      const step: Step = { opIds: [entry.opId], inverse: d.inverse, entities: undoEntitiesOf(d.ops), lastAt: now, after: r.value };
      this.stepOf.set(entry.opId, step);
      const stack = target === "undo" ? this.redoStack : this.undoStack;
      stack.push(step);
      if (stack.length > UNDO_LIMIT) stack.shift();
    } else if (opts.undoable !== false) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (opts.mergeKey && top && top.mergeKey === opts.mergeKey && now - top.lastAt <= (opts.mergeWindowMs ?? MERGE_WINDOW_MS) && this.redoStack.length === 0) {
        top.opIds.push(entry.opId);
        top.inverse = [...d.inverse, ...top.inverse];
        for (const e of undoEntitiesOf(d.ops)) if (!top.entities.includes(e)) top.entities.push(e);
        top.lastAt = now;
        top.after = r.value;
        this.stepOf.set(entry.opId, top);
      } else {
        const step: Step = { opIds: [entry.opId], inverse: d.inverse, entities: undoEntitiesOf(d.ops), mergeKey: opts.mergeKey, lastAt: now, after: r.value };
        this.stepOf.set(entry.opId, step);
        this.undoStack.push(step);
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      }
      this.redoStack = [];
    }
    this.setLocal(r.value, cause);
    this.flush();
    return this.local;
  }

  private sendOp(p: Pending, expectRev?: number) {
    const msg: OpMsg = { type: "project.op", projectId: this.projectId, opId: p.opId, session: this.session, ops: this.wireOps(p) };
    if (expectRev !== undefined) msg.expectRev = expectRev;
    if (p.undoOf) msg.undoOf = p.undoOf;
    this.sendMsg(msg);
  }

  /**
   * 超过单次上限的根替换改走 `project.upload`:先按顺序发完分片,再发引用它的 `project.op`。
   * 同一条连接上消息按序处理,所以不用等 `project.uploaded` 的回音。片数超过上限时照原样发,由文档服务回 too-large。
   */
  private wireOps(p: Pending): WireOp[] {
    const only = p.ops.length === 1 ? p.ops[0] : null;
    if (!only || only.op !== "set" || only.path !== "") return p.ops;
    if (utf8Bytes(JSON.stringify(p.ops)) <= MAX_OPS_BYTES) return p.ops;
    const text = JSON.stringify(only.value);
    const count = Math.ceil(text.length / UPLOAD_PART_CHARS);
    if (count > UPLOAD_MAX_PARTS) return p.ops;
    const uploadId = `up.${p.opId}`.slice(0, 128);
    for (let index = 0; index < count; index++) {
      this.sendMsg({ type: "project.upload", projectId: this.projectId, uploadId, index, count, data: text.slice(index * UPLOAD_PART_CHARS, (index + 1) * UPLOAD_PART_CHARS) });
    }
    return [{ op: "set", path: "", upload: uploadId }];
  }

  /** 能发就按顺序把没发的都发出去 */
  private flush() {
    if (!this.connected || this.awaitingState || this.gateOpId || this.paused) return;
    for (const p of this.pending) {
      if (p.sent) continue;
      p.sent = true;
      this.sendOp(p);
    }
  }

  /** 在已确认副本上依次重放未确认的本地操作;没发出去又落不下去的直接丢掉 */
  private replay(base: Project): Project {
    let cur = base;
    const dropped: string[] = [];
    for (const p of this.pending) {
      if (p.ackRev !== undefined && p.ackRev <= this.confirmedRev) continue;
      const r = applyOps(cur, p.ops);
      if (r.ok) {
        cur = r.value;
        p.brokenLocally = false;
      } else if (!p.sent) {
        dropped.push(p.opId);
        this.emit("notice", { kind: "replay-dropped", opId: p.opId, detail: r.detail });
      } else {
        p.brokenLocally = true;
      }
    }
    if (dropped.length) {
      this.pending = this.pending.filter((p) => !dropped.includes(p.opId));
      this.dropSteps(dropped);
    }
    return cur;
  }

  /** 这些提交作废了:含它们的撤销步整步拿掉(逆操作已经对不上了) */
  private dropSteps(opIds: string[]) {
    const gone = new Set(opIds);
    const keep = (s: Step) => !s.opIds.some((id) => gone.has(id));
    this.undoStack = this.undoStack.filter(keep);
    this.redoStack = this.redoStack.filter(keep);
    for (const id of opIds) this.stepOf.delete(id);
  }

  /* ---------- 撤销 / 重做 ---------- */

  undo(): UndoResult | null {
    const step = this.undoStack.pop();
    if (!step) return null;
    return this.revert(step, "undo");
  }

  redo(): UndoResult | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    return this.revert(step, "redo");
  }

  /** 这一步之后被别的写入身份改过的实体 → 最近改它的是谁 */
  private conflictsFor(step: Step): Map<string, Writer> {
    const out = new Map<string, Writer>();
    if (step.rev === undefined) return out; // 还没确认:之后收到的远端改动都排在它前面
    for (const w of this.remoteWrites) {
      if (w.rev <= step.rev) continue;
      for (const e of step.entities) if (w.entities.some((x) => entitiesOverlap(x, e))) out.set(e, w.by);
    }
    return out;
  }

  /**
   * AI 栏「撤销这一步」:以本页面的身份提交别人(Agent)那次提交的逆操作,带 `undoOf` 指向那次提交,
   * 进本页面自己的撤销栈(c65-design.md 第 8 节裁定)。冲突检查同 `undo`:那次提交之后,
   * 被**别的写入身份**(含本页面自己后来的改动)改过的实体不撤;那次提交的写入者自己后来又改的不算。
   * 那次提交的版本号查不到(页面连上之前落地、记录已修剪,事件里也没带)时只按本页面没确认的修改挡。
   */
  /** 撤得了这次别人的提交吗:事件带了逆操作,或本页面收到它时记下了 */
  canRevertRemote(opId: string, inverse?: PathOp[]): boolean {
    return (inverse?.length ?? 0) > 0 || this.remoteInverses.has(opId);
  }

  revertRemote(remote: RemoteStep): UndoResult {
    const own = this.remoteWrites.find((w) => w.opId === remote.opId);
    const kept = this.remoteInverses.get(remote.opId);
    const rev = remote.rev ?? own?.rev ?? kept?.rev;
    const inverse = remote.inverse?.length ? remote.inverse : kept?.inverse ?? [];
    const entities = undoEntitiesOf(inverse);
    const blocked = new Map<string, Writer>();
    const mine: Writer = { session: this.session };
    if (rev !== undefined) {
      const origin = remote.by ?? own?.by;
      const sameWriter = (by: Writer) =>
        origin !== undefined && by.session === origin.session && JSON.stringify(by.actor ?? null) === JSON.stringify(origin.actor ?? null);
      for (const w of this.remoteWrites) {
        if (w.rev <= rev || sameWriter(w.by)) continue;
        for (const e of entities) if (w.entities.some((x) => entitiesOverlap(x, e))) blocked.set(e, w.by);
      }
      for (const w of this.localWrites) {
        if (w.rev <= rev) continue;
        for (const e of entities) if (w.entities.some((x) => entitiesOverlap(x, e))) blocked.set(e, mine);
      }
    }
    // 还没确认的本地修改也算「后来改过」
    for (const p of this.pending) {
      for (const x of undoEntitiesOf(p.ops)) for (const e of entities) if (entitiesOverlap(x, e)) blocked.set(e, mine);
    }
    // 本页面亲眼看到它落地,才知道「那一步落地后」是什么样
    const after = kept?.after;
    const step: Step = { opIds: [remote.opId], inverse, entities, lastAt: this.now(), after };
    const result = this.applyRevert(step, blocked, undefined);
    this.emit("notice", { kind: "revert-remote", of: remote.opId, result });
    return result;
  }

  private revert(step: Step, kind: "undo" | "redo"): UndoResult {
    for (const id of step.opIds) this.stepOf.delete(id);
    const result = this.applyRevert(step, this.conflictsFor(step), kind);
    this.emit("notice", { kind: "undo", redo: kind === "redo", result });
    return result;
  }

  /** 按冲突表撤一步:落得下的照撤;kind 为空时(撤别人那一步)结果当一次普通修改进撤销栈 */
  private applyRevert(step: Step, blocked: Map<string, Writer>, kind: "undo" | "redo" | undefined): UndoResult {
    const skipped: SkippedEntity[] = [...blocked].map(([entity, by]) => ({ entity, by }));
    // 被挡住的那几样:在「那一步落地后」上只撤它们,交给冲突合并窗口逐项比(撤不下去就不给,界面退回提示条)
    let conflict: UndoResult["conflict"];
    if (blocked.size && step.after) {
      const r = applyOps(step.after, relocateOps(step.after, step.inverse.filter((op) => blocked.has(undoEntityOfOp(op)))));
      if (r.ok && r.value !== step.after) conflict = { landed: step.after, reverted: r.value };
    }
    // 逆操作记的是写入当时序列住的位置(激活剪辑的 /tracks 或停放剪辑的 /cuts/@X/tracks);之后切换剪辑搬过家的,
    // 按序列 id 找到它现在住哪儿再套用,不切换激活剪辑(kernel/cutPaths.ts)
    const allowed = relocateOps(this.local, step.inverse.filter((op) => !blocked.has(undoEntityOfOp(op))));
    const failed: string[] = [];
    let candidate = this.local;
    if (allowed.length) {
      const all = applyOps(candidate, allowed);
      if (all.ok) candidate = all.value;
      else {
        // 整批落不下:按实体分组逐组试,落不下的那组记为没撤成
        const groups = new Map<string, PathOp[]>();
        for (const op of allowed) {
          const e = undoEntityOfOp(op);
          if (!groups.has(e)) groups.set(e, []);
          groups.get(e)!.push(op);
        }
        for (const [e, ops] of groups) {
          const r = applyOps(candidate, ops);
          if (r.ok) candidate = r.value;
          else failed.push(e);
        }
      }
    }
    if (candidate === this.local) {
      // 一处都没撤成:出栈,也不进对面的栈(c65-design.md 第 8 节裁定)
      return { done: false, skipped, failed, ...(conflict ? { conflict } : {}) };
    }
    const undoOf = step.opIds[step.opIds.length - 1];
    const before = this.pending.length;
    // 撤别人那一步不经 setProject:以 revert-remote 发出,让接 store 的一侧写进 state(不然页面要等下一次改动才刷新)
    this.commitInternal(candidate, kind ? { undoable: false } : {}, undoOf, kind, kind ?? "revert-remote");
    const opId = this.pending.length > before ? this.pending[this.pending.length - 1].opId : undefined;
    return { done: opId !== undefined, skipped, failed, opId, ...(conflict ? { conflict } : {}) };
  }

  private pruneRemoteWrites() {
    if (this.remoteWrites.length < 256 && this.localWrites.length < 256) return;
    let min = this.confirmedRev;
    for (const s of [...this.undoStack, ...this.redoStack]) if (s.rev !== undefined && s.rev < min) min = s.rev;
    this.remoteWrites = this.remoteWrites.filter((w) => w.rev > min);
    this.localWrites = this.localWrites.filter((w) => w.rev > min);
  }

  /* ---------- 保存 ---------- */

  private isSettled(): boolean {
    return this.connected && !this.awaitingState && !this.paused && !this.gateOpId && this.pending.length === 0 && this.confirmed !== null;
  }

  /**
   * 等所有本地操作都拿到 ok(`.proc` 只在这之后写)。返回文档服务确认过的版本号和那一版内容。
   * 超时(缺省不超时)就 reject,调用方提示用户。
   */
  whenSettled(opts: { timeoutMs?: number } = {}): Promise<{ rev: number; project: Project }> {
    if (this.isSettled()) return Promise.resolve({ rev: this.confirmedRev, project: this.confirmed! });
    return new Promise((resolve, reject) => {
      const w: (typeof this.settleWaiters)[number] = { resolve, reject };
      if (opts.timeoutMs !== undefined) {
        w.timer = setTimeout(() => {
          this.settleWaiters = this.settleWaiters.filter((x) => x !== w);
          reject(new Error(`等文档服务确认超时(还有 ${this.pending.length} 条没确认,状态 ${this.status})`));
        }, opts.timeoutMs);
      }
      this.settleWaiters.push(w);
    });
  }

  private checkSettled() {
    if (!this.settleWaiters.length || !this.isSettled()) return;
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiters) {
      if (w.timer) clearTimeout(w.timer);
      w.resolve({ rev: this.confirmedRev, project: this.confirmed! });
    }
  }
}

/* ---------------- 接 store ---------------- */

/**
 * 把一个 DocSync 接到编辑器 store 上:setProject / loadProject / undo / redo / canUndo / canRedo
 * 改由它接管,别人的改动写进 state(不进撤销栈、不回发)。返回解绑函数,解绑后回到快照栈模式。
 *
 * 换项目(另一个 projectId)时先解绑、再为新项目建一个 DocSync;`loadProject` 在接着的时候
 * 是对**当前这个项目**的一次根替换。
 */
export function bindStore(ds: DocSync, opts: { load?: (project: Project) => Project } = {}): () => void {
  if (ds.project !== state.project) {
    // DocSync 应以 store 里的那一份建;不是的话以 DocSync 为准
    set({ project: ds.project });
  }
  attachProjectSync({
    commit: (_prev, next, opts) => ds.commit(next, opts),
    // 接线的一方可以接管「载入」:载入的是另一个项目时,换一个 DocSync 而不是对当前项目做根替换
    load: (project) => (opts.load ? opts.load(project) : ds.load(project)),
    undo: () => void ds.undo(),
    redo: () => void ds.redo(),
    canUndo: () => ds.canUndo(),
    canRedo: () => ds.canRedo(),
    // .proc 只在所有本地修改都拿到确认之后写(c65-design.md 第 4 节、V7)
    whenSettled: (opts) => ds.whenSettled(opts),
  });
  const off = ds.on("project", (project, cause) => {
    // commit / load 由 setProject / loadProject 自己写进 state
    if (cause === "commit" || cause === "load") return;
    if (project === state.project) return;
    const prev = state.project;
    // 别人的改动:本页面的页面状态跟着调(切剪辑换播放头、总时长手动值、选区里被删的片段;c65-integ2 裁定)
    const pagePatch = cause === "remote" ? pageStateAfterRemote(prev, project, state) : null;
    set({ project, dirty: true, ...(pagePatch ?? {}) });
  });
  return () => {
    off();
    attachProjectSync(null);
  };
}
