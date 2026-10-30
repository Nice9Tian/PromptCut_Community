import type { Project } from "../kernel/project";
import { changedClips, isEmptyPatch } from "../render/changedClips.mjs";
// 显式 .ts 后缀:`stageEventRole` 是运行期的值,单测在 node 里直接 import 这个模块(见 stageBridge.test.mjs)
import { stageEventRole, type HostCapabilities, type StageEvent, type StageRole, type StageRpcClient } from "../render/stageRpc.ts";

/**
 * 主文档里「现在哪个 iframe 是舞台」的登记处(E0 / E1 / D4 页面侧)。
 *
 * 以前是挂在主窗口上的一个 getter(取 iframe 里的舞台 api),右栏的定位工具
 * 靠它量 contentBox。现在舞台只经 postMessage RPC 说话,主文档手里只有 RPC 客户端;
 * Preview 每换一个 iframe 就在这里登记一个新客户端,右栏拿到的永远是最新那个。
 *
 * 两个位置(**是角色,不是实例**:iframe 的 `id=A` / `id=B` 只是实例名,角色由 `setRole` 定,
 * K5 的互换会让同一个 iframe 换到另一个位置上):
 *   - `front`:可见的播放器舞台(拖动 / 暂停 / 命中测试)。
 *   - `back`:后台舞台(探针 / 补跑 / 页面侧测量)。legacy 的单舞台没有它,`back` 为空时用
 *     `front` 代替(D4:「先对它测;E1 之后改走 back 与单飞队列」)。
 *
 * 推项目只有两个口子,**都按 iframe 记一份「上次推过的项目」基线**(按客户端记,不按位置记;
 * K5 互换时同一个 iframe 换到另一个位置,基线跟着它走):
 *   - `syncProject(role, project)`:能做增量就发 changedClips 的两层 diff(舞台合并时保持
 *     未变片段的引用),没有基线就整份 + reset;和基线是同一个对象引用就什么都不发。
 *   - `pushProject(role, project, { reset })`:`reset` 时一律整份重灌。探针的缩水项目、
 *     K5 第二路的整场景补跑、D4 的页面侧测量都走它 —— **直接发 `setProject` 会绕过基线**,
 *     之后的 `syncProject(backRole(), …)` 因为「和基线比没变」静默不发,`back` 就一直
 *     留在缩水项目上(E0 点名的那个坑)。
 * 两个口子共用下面的 `send`,所以同一份项目不会被推两遍。
 */
interface Slot {
  client: StageRpcClient | null;
  /** 握手时舞台报的宿主能力表(J4)。K1 的 `device` 串要 `compact` / `offscreenGl` */
  caps: HostCapabilities | null;
  /** 这个位置上「有客户端了」的 Promise(whenStageReady);客户端换了就换一个新的 */
  ready: { promise: Promise<StageRpcClient>; resolve: (c: StageRpcClient) => void; settled: boolean };
  /** 这个位置上的客户端发来的事件的退订函数 */
  off: (() => void) | null;
}

function pendingReady(): Slot["ready"] {
  let resolve!: (c: StageRpcClient) => void;
  const promise = new Promise<StageRpcClient>((r) => { resolve = r; });
  return { promise, resolve, settled: false };
}

const newSlot = (): Slot => ({ client: null, caps: null, ready: pendingReady(), off: null });

const slots: Record<StageRole, Slot> = { front: newSlot(), back: newSlot() };

/**
 * 每个客户端(= 每个 iframe 的一次握手)各一份:上次成功推给它的项目(增量 diff 的基线),
 * 和推送的串行链(两次推送交错时,后一次等前一次落定再比)。
 *
 * **按客户端记,不按位置记**(根因 A):K5 第二路补跑时 `back` 收的是补跑开始那一刻的项目,
 * 补跑期间用户改了时间轴只推给了当时的 `front`。互换之后新 `front` 手里仍是旧项目 ——
 * 以前按位置记、互换时再用 `markPushed` 记成「此刻的最新项目」,之后 `syncProject` 因为基线相同不发,
 * 被删的片段永远留在舞台上。iframe 重载会换一个新客户端,这份自然作废。
 */
interface Pushed {
  project: Project | null;
  chain: Promise<void>;
}
let pushedBy = new WeakMap<StageRpcClient, Pushed>();
function pushedOf(client: StageRpcClient): Pushed {
  let p = pushedBy.get(client);
  if (!p) { p = { project: null, chain: Promise.resolve() }; pushedBy.set(client, p); }
  return p;
}

/** 事件订阅者(按角色过滤之后才喂给他们) */
const eventListeners = new Set<(e: StageEvent, role: StageRole) => void>();

/**
 * 登记 / 注销一个舞台客户端。换 iframe 时先登记新的再 dispose 旧的,基线随客户端一起换。
 *
 * 事件转发也挂在这里:**只有这里同时知道「哪个客户端」和「它此刻是什么角色」**,
 * 而 `event.source` 的过滤两样都要(E0 末条)。`createStageRpc` 那一层只管住了前半个问题。
 */
export function setStageClient(role: StageRole, client: StageRpcClient | null, caps: HostCapabilities | null = null): void {
  const slot = slots[role];
  if (slot.client === client) return;
  slot.off?.();
  slot.off = null;
  slot.client = client;
  slot.caps = caps;
  if (!client) {
    // 这个位置空了:下一次 whenStageReady 要等新的那个
    if (slot.ready.settled) slot.ready = pendingReady();
    return;
  }
  slot.off = client.onEvent((e) => {
    /*
     * 角色过滤:`frame` / `ended` / `settled` / `demote` 只认当前 `front` 发来的,
     * `mediaReady` / `probe` / `probe-frame` 只认当前 `back` 的,其余丢弃。
     * 互换那一拍两个舞台都可能 post(旧 front 走完本拍才停),不过滤就会重复 tick。
     */
    if (stageEventRole(e.type) !== role && !(role === "front" && backRole() === "front")) return;
    // 客户端在事件排队期间被换掉了:这一条是上一个 iframe 的,不算数
    if (slots[role].client !== client) return;
    for (const l of eventListeners) l(e, role);
  });
  // 已经 resolve 过的(上一个客户端)不能再 resolve:换一个新的 Promise,resolve 成新客户端
  if (slot.ready.settled) slot.ready = pendingReady();
  slot.ready.settled = true;
  slot.ready.resolve(client);
}

/**
 * iframe 卸掉了:它的客户端**不管此刻落在哪个位置上**都摘下来(K5 的互换之后,A 不一定还是 `front`)。
 *
 * 不摘的后果实测过:`frontStage()` 只看 `disposed`,而卸掉的 iframe 的客户端没人 dispose,
 * 于是它一直被当成可见舞台交出去 —— 3D 页按播放,`play()` 发进一个已经关掉的窗口,永远不回包。
 */
export function releaseStageClient(client: StageRpcClient): void {
  for (const role of ["front", "back"] as const) if (slots[role].client === client) setStageClient(role, null);
}

/**
 * 订阅舞台事件(七种,已按 `event.source` 的角色规矩过滤)。返回退订函数。
 *
 * R2 只搭骨架:`play` / `pause` 还回 `unsupported`(K4 是 R5 的活),所以 `frame` / `ended` /
 * `settled` 这几种在这一步里根本不会来;`probe` / `probe-frame` / `demote` 的消费者是
 * R4 的探针和 K6 的降级。**协议面和过滤在这里就位,R5 / R4 往里填消费者时不用再动它。**
 */
export function onStageEvent(listener: (e: StageEvent, role: StageRole) => void): () => void {
  eventListeners.add(listener);
  return () => { eventListeners.delete(listener); };
}

export function frontStage(): StageRpcClient | null {
  const c = slots.front.client;
  return c && !c.disposed ? c : null;
}

/** 后台舞台此刻落在哪个位置上(legacy 的单舞台没有 back,就是 front);推项目要按它选基线 */
export function backRole(): StageRole {
  const b = slots.back.client;
  return b && !b.disposed ? "back" : "front";
}

/** 后台舞台;legacy 的单舞台没有,退回可见舞台 */
export function backStage(): StageRpcClient | null {
  const b = slots.back.client;
  if (b && !b.disposed) return b;
  return frontStage();
}

/**
 * 等这个位置上有舞台客户端(E1)。**客户端换了就是一个新的 Promise** ——
 * 拿着旧 Promise 的调用方拿到的还是旧客户端,不会莫名其妙跳到新 iframe 上;
 * 新叫的那一次拿到的是新客户端。R4 的 `ProbeGate` 靠它知道后台舞台就绪。
 *
 * 只等「有客户端」,不等「角色已经设好」:角色由 Preview 在握手之后立刻发,
 * 而排到队里的活(stageJobs)每次开工前自己会发一遍 `setRole`。
 */
export function whenStageReady(role: StageRole): Promise<StageRpcClient> {
  return slots[role].ready.promise;
}

/**
 * 这个位置上的舞台握手时报的宿主能力表(J4)。
 *
 * K1 的 `device` 串要 `compact` / `offscreenGl`,而它们必须和**舞台那一侧**探测到的一致 ——
 * 离线探针拿的就是舞台 `pc-stage-ready` 里的这一份。主文档自己再探一遍是第二份实现,
 * 会悄悄走偏(比如主文档和 iframe 的 `deviceMemory` 上报不同)。
 * 还没握手时回 `null`,调用方按保守值兜底。
 */
export function stageCapabilities(role: StageRole): HostCapabilities | null {
  return slots[role].caps ?? slots.front.caps;
}

/**
 * K5 的角色互换:两个位置上的客户端对调,**基线跟着客户端走**(见上面 `pushedBy`)。
 * 互换之后调用方要对新 `front` 补推一次 `syncProject` —— 它手里是补跑开始时那一份,
 * 补跑期间的编辑按增量补上(`stageSwap.ts` 的 `swapAndDress`)。
 */
export function swapStageClients(
  front: { client: StageRpcClient | null; caps?: HostCapabilities | null },
  back: { client: StageRpcClient | null; caps?: HostCapabilities | null },
): void {
  // 先都摘下再登记:同一个客户端不会同一刻挂在两个位置上(事件过滤按「位置上的客户端」判)
  setStageClient("front", null);
  setStageClient("back", null);
  setStageClient("front", front.client, front.caps ?? null);
  setStageClient("back", back.client, back.caps ?? null);
}

/**
 * 两个推送口子共用的一段:串行化 + 基线维护,都挂在**发起这一刻**这个位置上的客户端身上。
 * 送到了就记在它身上,不管它之后被换到了哪个位置。
 */
function send(role: StageRole, project: Project, force: boolean): Promise<void> {
  const targetRole = role === "back" && backRole() === "front" ? "front" : role;
  const client = slots[targetRole].client;
  if (!client || client.disposed) return Promise.resolve();
  const mine = pushedOf(client);
  const run = async () => {
    if (client.disposed) return;
    if (!force && mine.project === project) return;
    const patch = force ? null : changedClips(mine.project, project);
    if (patch && mine.project && isEmptyPatch(patch)) {
      mine.project = project;
      return;
    }
    if (!patch || patch.kind === "full") await client.setProject(project, { reset: true });
    else await client.setProject(patch);
    mine.project = project;
  };
  const next = mine.chain.then(run, run);
  mine.chain = next.catch(() => {});
  return next;
}

/**
 * 把项目同步到某个舞台。返回时舞台已经收到并应用。
 * 基线相同(同一个对象引用)就什么都不发。
 */
export function syncProject(role: StageRole, project: Project): Promise<void> {
  return send(role, project, false);
}

/**
 * 换项目并更新基线(E0 / E1)。`reset: true` 一律整份重灌(探针的缩水项目、
 * K5 第二路的整场景补跑、D4 的页面侧测量都这么用);不带 `reset` 时和 `syncProject` 一样走增量。
 */
export function pushProject(role: StageRole, project: Project, opts: { reset?: boolean } = {}): Promise<void> {
  return send(role, project, !!opts.reset);
}

/** 测试 / 调试用:哪个舞台推到了哪份项目 */
export function pushedProject(role: StageRole): Project | null {
  const targetRole = role === "back" && backRole() === "front" ? "front" : role;
  const client = slots[targetRole].client;
  return client ? pushedBy.get(client)?.project ?? null : null;
}

/**
 * 直接把某个位置上那个客户端的基线记成这一份项目。**只在确知舞台手里就是这一份时用。**
 * K5 的互换**不再**用它(根因 A:互换时新 `front` 手里是补跑开始那一份,不是此刻的最新项目),
 * 改走 `swapStageClients` —— 基线本来就跟着客户端走。
 */
export function markPushed(role: StageRole, project: Project | null): void {
  const targetRole = role === "back" && backRole() === "front" ? "front" : role;
  const client = slots[targetRole].client;
  if (client) pushedOf(client).project = project;
}

/** 测试用:把登记处恢复成刚加载的样子 */
export function resetStageBridge(): void {
  for (const role of ["front", "back"] as StageRole[]) {
    slots[role].off?.();
    slots[role] = newSlot();
  }
  pushedBy = new WeakMap();
  eventListeners.clear();
}
