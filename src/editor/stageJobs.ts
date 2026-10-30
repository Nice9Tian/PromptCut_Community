// 显式 .ts 后缀:单测在 node 里直接 import 这两个模块(见 stageJobs.test.mjs)
import { backRole, backStage, whenStageReady } from "./stageBridge.ts";
import type { BackJob, RenderAborted, StageRpcClient } from "../render/stageRpc.ts";

/**
 * 后台舞台的**单飞队列**(D4 / E0)。
 *
 * 后台舞台的项目有三种占用者,而它只有一台:
 *   - **补跑**(`catchup`):K5 第二路的整场景补跑、K3(b) 的重试路。用户已经停下来在等画面,
 *     最急;
 *   - **页面侧测量**(`measure`):D4 的 `measureContentBoxes` —— Agent 或右栏的定位工具
 *     在等一个实体框,是一次交互;
 *   - **探针**(`probe`):K1 的实测。它是背景工作,随时可以从这张卡的头重排。
 * 优先级就是这个顺序:**补跑 > 页面侧测量 > 探针**。同一优先级按先来后到。
 *
 * M7(契约第 4.3 节)加第四种、最不急的:**生成快照**(`bake`)—— 在线双舞台的后台舞台兼做纯浏览器节点,
 * 为认领到的快照任务逐帧生成快照(工作项就是 J4 早留的 `'bake'`)。它排在探针之后;更急的活排进来时照样收到 abort 通知,
 * 由纯浏览器节点在当前帧做完后放回任务(D8)。
 *
 * 每个活开工前先发 `setRole('back', { job })` 把后台舞台切到这个工作项上 ——
 * **E0 的「掐断后不重发」例外按工作项判、不按 `settling` 标志判**:`job: 'catchup'` 期间
 * 收到的 `{ aborted: true, reason: 'project' }` 一律丢弃(那份 `setProject` 正是这个活
 * 自己灌的),`job: 'probe'` 期间收到的才按当前目标重发。判据见 `renderAbortAction`。
 * 队列空下来就把工作项交还成 `'probe'`(E0:「`settled` 或补跑中止后发
 * `setRole('back', { job: 'probe' })`,探针从当前这张卡的头重排」)。
 *
 * **R2 只放队列本身**:排进来的只有 D4 的页面侧测量。R4 的探针和 R5 的补跑以后往里排活,
 * 不用再动这个模块。
 *
 * legacy 的单舞台没有真正的 `back`(`backRole()` 回 `'front'`),那时**不发 `setRole`** ——
 * 把可见舞台切成 `back` 会清掉它的快照 / 抑制集合、停它的节拍循环,用户眼前的画面就没了。
 * 队列本身照常串行化,行为和今天「直接对唯一那个舞台量一次」一样。
 */

/** 队列里的活分三种,数字越小越急 */
export type BackJobKind = "catchup" | "measure" | "probe" | "bake";

const PRIORITY: Record<BackJobKind, number> = { catchup: 0, measure: 1, probe: 2, bake: 3 };

/**
 * 队列里的三种活映射到 RPC 的工作项枚举(J4:`'probe' | 'catchup' | 'bake'`)。
 *
 * **页面侧测量映射到 `'catchup'` 而不是另开一个枚举值**:D4 明写「测量进场先
 * `setRole('back', { job: 'catchup' })`」,E0 的例外那条也把「D4 的页面侧测量」和补跑
 * 并列在 `job: 'catchup'` 名下。测量要的正是补跑那一套语义(探针挂起、自己灌的项目
 * 掐出来的 `'project'` 不重发),没必要给舞台加第四个它分辨不出差别的枚举值。
 * 队列这一侧仍然分三档,因为**优先级**要分(补跑 > 测量)。
 */
const RPC_JOB: Record<BackJobKind, BackJob> = { catchup: "catchup", measure: "catchup", probe: "probe", bake: "bake" };

/** `'project'` 掐断之后按当前目标重发的上限(E0:超过就报错、该片段按声明兜底分派) */
export const MAX_PROJECT_RESENDS = 3;

/** 父页收到一个 `render` 的中止回包该怎么办(E0 把五种 reason 的规矩逐条写死了) */
export type RenderAbortAction =
  /** 丢弃,不重发 —— 重发只会再掐掉新的那次,或者掐掉自己 */
  | "drop"
  /** 按当前目标重发(最多 MAX_PROJECT_RESENDS 次) */
  | "resend"
  /** 丢弃回包,按**新**客户端重发当前目标(iframe 换了) */
  | "rebind"
  /** 既不重发也不当错误:K1 探针的封顶,父页按已推帧外推 catchUpMs */
  | "ignore"
  /** 当错误,不重发 */
  | "error";

/**
 * @param reason `RenderAborted.reason`
 * @param job    后台舞台此刻的工作项(`currentBackJob()`);没有活在跑就是 null
 */
export function renderAbortAction(reason: RenderAborted["reason"], job: BackJob | null): RenderAbortAction {
  switch (reason) {
    case "superseded":
      // 父页自己的新 render 掐的,重发会再掐掉新的那次
      return "drop";
    case "project":
      /*
       * 唯一按工作项分岔的一条。`job: 'catchup'` 期间那份 `setProject` 是这个活自己灌的
       * (补跑的全量项目 / 测量的全量项目),重发探针会把它掐成 'superseded',而
       * 'superseded' 又不许重发 —— 三条规则成环,`settled` 永远发不出去。
       */
      return job === "catchup" ? "drop" : "resend";
    case "timeout":
      // 截断 ≠ capped:capped 只由 stepMs > B 决定
      return "ignore";
    case "role":
      // 重发也还是同一个角色
      return "error";
    case "detached":
      return "rebind";
  }
}

export interface BackJobContext {
  /** 这次该对谁说话。legacy 单舞台时它就是可见舞台 */
  stage: StageRpcClient;
  /** 更急的活进来了:正在跑的这个自己收摊(不强杀,让它把状态收干净) */
  signal: AbortSignal;
  kind: BackJobKind;
  /** 这次发给舞台的工作项;legacy 单舞台下没发过 setRole,这里也就没意义 */
  job: BackJob;
}

interface QueueItem {
  kind: BackJobKind;
  seq: number;
  run: (ctx: BackJobContext) => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

let seqNo = 0;
const queue: QueueItem[] = [];
let running: { item: QueueItem; abort: AbortController } | null = null;
let pumping = false;

/** 后台舞台此刻在做哪个工作项;没有活在跑就是 null */
export function currentBackJob(): BackJob | null {
  return running ? RPC_JOB[running.item.kind] : null;
}

/** 排在前面的活有几个(含正在跑的那个);验收和调试看 */
export function backJobQueueLength(): number {
  return queue.length + (running ? 1 : 0);
}

/**
 * 比生成快照更急的活有几个(排着的加正在跑的,不算 `bake` 自己)。纯浏览器节点「闲」的判据之一(M7 契约第 2 节):
 * 单飞队列里有补跑、测量、探针时不认领新任务。
 */
export function urgentBackJobs(): number {
  let n = queue.filter((item) => item.kind !== "bake").length;
  if (running && running.item.kind !== "bake") n++;
  return n;
}

/** 取下一个该跑的:优先级最高的那一档里最早排进来的 */
function takeNext(): QueueItem | null {
  if (!queue.length) return null;
  let best = 0;
  for (let i = 1; i < queue.length; i++) {
    const a = queue[i];
    const b = queue[best];
    if (PRIORITY[a.kind] < PRIORITY[b.kind] || (PRIORITY[a.kind] === PRIORITY[b.kind] && a.seq < b.seq)) best = i;
  }
  return queue.splice(best, 1)[0];
}

async function resolveStage(): Promise<StageRpcClient> {
  const now = backStage();
  if (now) return now;
  /*
   * 还没有任何舞台。两个位置都等着:E1 之后来的是 `back`,legacy 的单舞台只会有 `front`,
   * 而 `backStage()` 对 legacy 正是退回 `front`。谁先就绪就用谁。
   */
  return await Promise.race([whenStageReady("back"), whenStageReady("front")]);
}

/**
 * 把工作项发给后台舞台。**同一个客户端上的同一个工作项不重发** —— `setRole('back')`
 * 每次都会清空快照 / 抑制 / 流平面并中止追帧(E0),白发一次等于白清一次。
 * legacy 的单舞台不发(见文件头)。
 *
 * **记的是「哪个客户端 + 哪个工作项」,不只是工作项**(R7):`back` 这个位置上的客户端会换人 ——
 * K5 的互换让另一个 iframe 接任 `back`,iframe 重载也会换一个新客户端。只记工作项的话,
 * 新客户端从没收到过 `setRole`(它的缺省角色是 `front`),而这里却因为「工作项没变」跳过发送,
 * 于是新 `back` 一直留在 `front` 角色上:它不认 `render`(回 `reason: 'role'`)、
 * 也不按 `back` 的规矩走,探针和补跑就此停摆。带上客户端身份之后,换人必然不等于上一条记录,
 * 一定会重发一次。
 */
let lastSent: { client: StageRpcClient; job: BackJob } | null = null;
async function sendJob(stage: StageRpcClient | null, job: BackJob): Promise<void> {
  if (!stage) return;
  if (backRole() !== "back" && job !== "bake") return;
  if (lastSent && lastSent.client === stage && lastSent.job === job) return;
  try {
    await stage.setRole("back", { job });
    if (backRole() === "back") lastSent = { client: stage, job };
  } catch {
    // iframe 正在换:下一个活开工时会重发
    lastSent = null;
  }
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const item = takeNext();
      if (!item) {
        /*
         * 队列空了,把工作项交还成 'probe'(E0):探针从当前这张卡的头重排。
         * R4 之前没有探针在排队,这一句只是把状态放回缺省档,不会真的启动什么。
         * 这一下是个 await,期间还可能再排进活来 —— 所以要再看一眼队列才能收工。
         */
        await sendJob(backStage(), "probe");
        if (queue.length) continue;
        break;
      }
      const abort = new AbortController();
      running = { item, abort };
      try {
        const stage = await resolveStage();
        const job = RPC_JOB[item.kind];
        await sendJob(stage, job);
        item.resolve(await item.run({ stage, signal: abort.signal, kind: item.kind, job }));
      } catch (err) {
        item.reject(err);
      } finally {
        running = null;
      }
    }
  } finally {
    pumping = false;
  }
}

/**
 * 往队列里排一个活。返回 `run` 的返回值;`run` 抛什么这里就抛什么。
 *
 * 更急的活排进来时,正在跑的那个会收到 `ctx.signal` 的 abort —— **只是通知,不强杀**:
 * `run` 自己决定什么时候收摊(探针会在下一次 `render` 的 `abort` 回调里退出),
 * 没理会 signal 的活照样跑完,只是让后面的多等一会儿。
 */
export function runBackJob<T>(kind: BackJobKind, run: (ctx: BackJobContext) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({ kind, seq: seqNo++, run: run as (ctx: BackJobContext) => Promise<unknown>, resolve: resolve as (v: unknown) => void, reject });
    if (running && PRIORITY[kind] < PRIORITY[running.item.kind]) running.abort.abort();
    void pump();
  });
}

/** 测试用:清空队列(正在跑的那个收到 abort,但它的 Promise 照常按 run 的结果落定) */
export function resetStageJobs(): void {
  queue.length = 0;
  running?.abort.abort();
  seqNo = 0;
  lastSent = null;
}
