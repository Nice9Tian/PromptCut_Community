/**
 * 纯浏览器节点在后台舞台上生成快照的「活」与每一帧的舞台往返(M7 契约第 4.3 节;从 `browserNodeHost.ts` 拆出,
 * `claude/queue-maint` 任务 F:好在 Node 里不起浏览器写舞台互换的剧本,见 `stageBake.test.mjs`)。
 *
 * 宿主(`browserNodeHost.ts`)一帧的前半段在这里:
 *
 *   - **活(lease)**:一段细任务认领到的第一帧,在单飞队列里排一个 `bake` 活(最不急:补跑 > 测量 > 探针 > 生成快照),
 *     拿到后台舞台才开工;这一段收尾(完成、失败、放回、丢认领)时宿主调 `close()` 交还。更急的活排进来时单飞队列 abort
 *     这个活,这里转给 `onUrgent()`,节点在当前帧做完后放回(D8)。
 *   - **每帧前核后台位置**:舞台互换(K5)或 iframe 重载之后,后台位置上换了人(`backStage()` 不再是这个活记的那台),
 *     就改用新的后台舞台,并把这一段的隔离单卡工程整份重灌过去(`pushProject('back', …, { reset })`)再发这一帧。
 *     做到哪一帧记在节点里(`browserNode.ts` 的已做帧),重开时只补缺的帧。
 *   - **顺推时先发下一帧**:推素材服务的网络往返与舞台推下一帧并行;下一帧的回包只在节点真来要它、且还是同一台舞台时才用。
 *   - **一帧中途换了人**(本模块补的,任务 F 剧本查出):互换或重载发生在一帧在飞时,旧舞台已不是后台,回 `cancelled` /
 *     `role`,或者帧做完了但它的 `bake-frame` 事件在互换之后才到、被 `stageBridge` 按角色滤掉。以前这一段按可重试失败交回
 *     (计一次失败,三次进 failed);现在只要后台位置确实换了人,就在新的后台舞台上重灌、重做这一帧(每帧最多
 *     `SWAP_REDO_MAX` 次),不计失败。后台位置没换人时照旧按失败交回。
 *
 * 舞台、单飞队列、事件都经 `deps` 注入(宿主传 `stageJobs` / `stageBridge` 的真函数;剧本传同一套真函数配假舞台)。
 */
import { bakeFrameBase, bakeInputOf, isolatedBakeProject, type BakeInput } from "../online/bakeTask.ts";
import type { Project } from "../kernel/project";
import type { BakeFrameReply, StageEvent, StageRpcClient } from "../render/stageRpc.ts";
import type { NodeTask } from "../online/browserNode.ts";

export type BakeFrameEvent = Extract<StageEvent, { type: "bake-frame" }>;
export type BakeFrameOk = Extract<BakeFrameReply, { ok: true }>;

/** 一帧中途后台位置换了人时,在新舞台上重做这一帧最多几次(三级数字) */
export const SWAP_REDO_MAX = 2;

/** 生成快照的回包里不可重试的原因:再做一遍结果一样 */
const FINAL_REASONS = new Set(["lossy", "no-clip", "no-control", "frame-mismatch", "unsupported"]);
/** 旧舞台已不是后台时会回的原因(`StageView.tsx` 的 `bakeFrame`):后台位置换了人就重做,不算失败 */
const SWAPPED_REASONS = new Set(["cancelled", "role", "no-project"]);

export interface StageBakerDeps {
  /** 单飞队列(`stageJobs.ts` 的 `runBackJob`) */
  runBackJob: (kind: "bake", run: (ctx: { stage: StageRpcClient; signal: AbortSignal }) => Promise<void>) => Promise<unknown>;
  /** 此刻的后台舞台(`stageBridge.ts` 的 `backStage`) */
  backStage: () => StageRpcClient | null;
  /** 往后台舞台灌项目(`stageBridge.ts` 的 `pushProject`) */
  pushProject: (role: "back", project: Project, opts: { reset?: boolean }) => Promise<void>;
  /** 舞台事件(已按角色过滤;`stageBridge.ts` 的 `onStageEvent`) */
  onStageEvent: (listener: (e: StageEvent) => void) => () => void;
  /** 更急的后台活来了(单飞队列 abort 了这个活):节点当前帧做完就放回 */
  onUrgent: () => void;
  /** 还闲着吗:闲着才先发下一帧 */
  isIdle: () => boolean;
  /** 推帧口径 */
  mode: "batch4" | "seq";
  /** 要不要出预渲染小尺寸(缺省要) */
  small?: boolean;
  now?: () => number;
  /** 每帧的时间构成(开活与灌工程 `lease`、舞台往返 `rpc`) */
  notePhase?: (k: "lease" | "rpc", ms: number) => void;
  /** 舞台回了不成的原因(诊断计数) */
  noteError?: (reason: string) => void;
}

export interface StageBakeResult {
  reply: BakeFrameOk;
  event: BakeFrameEvent;
  /** 这一帧实际出自哪台舞台 */
  stage: StageRpcClient;
}

export interface StageBakerDiag {
  /** 这一段的活换过几次舞台(每帧前核到换了人、或一帧中途换了人) */
  restages: number;
  /** 一帧中途换了人、在新舞台上重做的次数 */
  redos: number;
  /** 灌了几次隔离单卡工程 */
  pushes: number;
}

export interface StageBaker {
  /** `ahead`:这一帧做完后先发给舞台的那一帧(本地帧号);不给是下一帧,null 是不先发 */
  bakeFrame(job: { task: NodeTask; project: unknown; localFrame: number; signal: AbortSignal; ahead?: number | null }): Promise<StageBakeResult>;
  /** 交还这一段的活(停掉在推的帧、清掉顺推的接续点) */
  close(): void;
  /** 退订舞台事件(宿主卸载时) */
  dispose(): void;
  readonly leaseTaskId: string | null;
  diag(): StageBakerDiag;
}

/** 这一段的「活」:单飞队列里那个 `bake` 活,段收尾时交还 */
interface Lease {
  taskId: string;
  isolated: Project;
  input: BakeInput;
  /** 剪辑段里的卡:本地帧 0 是项目的第几帧(`bakeFrameBase`,〔裁〕R02);顶层的卡是 null */
  frameBase: number | null;
  stage: StageRpcClient;
  /** 这台舞台灌过这一段的隔离单卡工程没有 */
  pushedTo: StageRpcClient | null;
  /** 已经先发给舞台的下一帧 */
  ahead: { frame: number; stage: StageRpcClient; reply: Promise<BakeFrameReply> } | null;
  close: () => void;
}

const retryable = (message: string, value: boolean) => Object.assign(new Error(message), { retryable: value });

export function createStageBaker(deps: StageBakerDeps): StageBaker {
  const now = deps.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const small = deps.small !== false;
  let lease: Lease | null = null;
  const stats: StageBakerDiag = { restages: 0, redos: 0, pushes: 0 };
  /** 舞台发来的 `bake-frame`:会话号 + 本地帧 → 事件 */
  const bakeEvents = new Map<string, BakeFrameEvent>();
  const off = deps.onStageEvent((e) => {
    if (e.type !== "bake-frame") return;
    bakeEvents.set(`${e.session}#${e.localFrame}`, e);
    if (bakeEvents.size > 16) bakeEvents.delete(bakeEvents.keys().next().value as string);
  });

  const close = () => {
    const l = lease;
    lease = null;
    if (!l) return;
    try { void l.stage.bakeCancel().catch(() => {}); } catch { /* 舞台换了 */ }
    l.close();
  };

  /** 开这一段的活:排进单飞队列(最不急),拿到后台舞台才回 */
  const openLease = (task: NodeTask, project: unknown): Promise<Lease> => {
    const input = bakeInputOf(task);
    if (!input) return Promise.reject(retryable("任务没有 input.bake / clipId(切分方没给浏览器那一份的参数)", false));
    let isolated: Project;
    // 顶层的卡:隔离单卡工程;剪辑段里的卡:带着剪辑段链的隔离工程(`isolatedBakeProject`)
    try { isolated = isolatedBakeProject(project as Project, input) as Project; } catch (e) { return Promise.reject(Object.assign(e as Error, { retryable: false })); }
    const frameBase = bakeFrameBase(input);
    return new Promise<Lease>((resolve, reject) => {
      let got = false;
      void deps.runBackJob("bake", async (ctx) => {
        let release!: () => void;
        const done = new Promise<void>((r) => { release = r; });
        const l: Lease = { taskId: task.id, isolated, input, frameBase, stage: ctx.stage, pushedTo: null, ahead: null, close: () => release() };
        // 更急的活来了(补跑、测量、探针):当前帧做完就放回(D8)
        ctx.signal.addEventListener("abort", () => { deps.onUrgent(); }, { once: true });
        got = true;
        resolve(l);
        await done;
      }).catch((e) => { if (!got) reject(e); });
    });
  };

  /** 每帧前核后台位置:换了人就改用新的后台舞台(隔离单卡工程要重灌,先发的下一帧作废) */
  const followBack = (l: Lease) => {
    const cur = deps.backStage();
    if (cur && cur !== l.stage) { l.stage = cur; l.pushedTo = null; l.ahead = null; stats.restages++; }
  };

  async function bakeFrame({ task, localFrame, project, signal, ahead: aheadFrame }: { task: NodeTask; project: unknown; localFrame: number; signal: AbortSignal; ahead?: number | null }): Promise<StageBakeResult> {
    const t0 = now();
    if (!lease || lease.taskId !== task.id) {
      close();
      const l = await openLease(task, project);
      if (signal.aborted) { l.close(); throw retryable("已中止", true); }
      lease = l;
    }
    const l = lease;
    const session = task.id;
    for (let redo = 0; ; redo++) {
      // 舞台互换或 iframe 重载之后,后台位置上换了人:在新的后台舞台上重开(做到哪一帧记在节点里)
      followBack(l);
      const stage = l.stage;
      if (l.pushedTo !== stage) {
        await deps.pushProject("back", l.isolated, { reset: true });
        l.pushedTo = stage;
        stats.pushes++;
      }
      const tRpc = now();
      if (redo === 0) deps.notePhase?.("lease", tRpc - t0);
      const onAbort = () => { void stage.bakeCancel().catch(() => {}); };
      signal.addEventListener("abort", onAbort, { once: true });
      // 上一帧推两档时已经先发给舞台的这一帧:直接等它的回包;对不上(跳了帧、换了舞台)就照常发,新的一帧作废在飞的那一帧
      const ahead = l.ahead;
      l.ahead = null;
      let reply: BakeFrameReply;
      try {
        reply = ahead && ahead.frame === localFrame && ahead.stage === stage
          ? await ahead.reply
          : await stage.bakeFrame({ session, clipId: l.input.clipId, localFrame, mode: deps.mode, small, ...(l.frameBase !== null ? { frameBase: l.frameBase } : {}) });
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      deps.notePhase?.("rpc", now() - tRpc);
      // 一帧中途后台位置换了人:旧舞台回 cancelled / role,或者做完了但事件被按角色滤掉 —— 在新舞台上重做,不算失败
      const moved = () => { const cur = deps.backStage(); return !!cur && cur !== stage && lease === l && !signal.aborted; };
      if (!reply.ok && SWAPPED_REASONS.has(reply.reason) && redo < SWAP_REDO_MAX && moved()) { stats.redos++; continue; }
      /*
       * 先发下一帧(顺推时):推素材服务是网络往返(在线站点上每块至少一次 `GET chunks`),舞台在另一个进程里,
       * 两件事并行,每帧的耗时从「舞台 + 往返」降到两者取大。这一帧仍然两档都推成功才回(c10a 第 9 节);
       * 下一帧的回包只在节点真来要它时才用。让路、放回、丢认领时 `close` 的 `bakeCancel` 把它停在帧边界。
       * 不闲(要让路)或已中止时不先发。
       */
      const range = task.range;
      // 先发哪一帧:缺省是下一帧;调用方给了 `ahead` 就照它(稀疏的一趟每个分段只取第一帧,先发的是下一个分段的第一帧;null = 不先发)
      const next = aheadFrame === undefined ? localFrame + 1 : aheadFrame;
      if (reply.ok && deps.mode === "seq" && range && next !== null && Number.isInteger(next) && next > localFrame && next <= range.to && !signal.aborted && deps.isIdle() && lease === l && !moved()) {
        const p = stage.bakeFrame({ session, clipId: l.input.clipId, localFrame: next, mode: deps.mode, small, ...(l.frameBase !== null ? { frameBase: l.frameBase } : {}) })
          .catch((e): BakeFrameReply => ({ ok: false, reason: "cancelled", detail: String((e as Error)?.message ?? e).slice(0, 200) }));
        l.ahead = { frame: next, stage, reply: p };
      }
      if (!reply.ok) {
        deps.noteError?.(reply.reason);
        // 不可重试:再做一遍结果一样。`not-ready`(就绪闸超时)按可重试交回,同桌面 waitFrameReady 抛错的处理
        if (reply.reason === "role" || reply.reason === "no-project") l.pushedTo = null;
        throw retryable(`生成快照没成:${reply.reason}${reply.detail ? `(${reply.detail})` : ""}`, !FINAL_REASONS.has(reply.reason));
      }
      const ev = bakeEvents.get(`${session}#${localFrame}`);
      bakeEvents.delete(`${session}#${localFrame}`);
      if (!ev || ev.hash !== reply.hash) {
        if (redo < SWAP_REDO_MAX && moved()) { l.ahead = null; stats.redos++; continue; }
        throw retryable("舞台的 bake-frame 事件没到", true);
      }
      return { reply, event: ev, stage };
    }
  }

  return {
    bakeFrame,
    close,
    dispose: () => { close(); off(); },
    get leaseTaskId() { return lease?.taskId ?? null; },
    diag: () => ({ ...stats }),
  };
}
