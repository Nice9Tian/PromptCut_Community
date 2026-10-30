import type { Project } from "../kernel/project";
import { getState, subscribe } from "../store/project";
import { onlinePage } from "../online/pageFlag";
import { changedClips, projectHash, type ProjectPatch } from "./changedClips.mjs";

/**
 * 数据管理的只读镜像:编辑页把项目(带版本号)推给服务端一份
 * (docs/archive/topics/decoupling-plan.md 第 3.2 节「数据管理 → 项目」,阶段 4;A7)。
 *
 * # 为什么
 *
 * 以前 Agent 的每一个动作都要经过编辑器页面中转:服务端通过 SSE 把调用转给页面,页面再去请求渲染。
 * 时间轴的真身在浏览器 store 里(right/index.tsx 的 seePreview 注释),所以不这么绕拿不到项目 ——
 * 可这一绕,Agent 的看图请求就挂在编辑器页面的连接上,这正是它能卡住界面的结构原因。
 *
 * 有了镜像,Agent 的读和渲染(get_project / see_frames / get_gif / bake_card / inspect_card_dom)
 * 由服务端直接拿镜像去问预渲染,完全不碰页面;写操作仍经过页面,撤销 / 重做不变。
 * **帧请求也一样**:body 里不再带项目,只带 `{session, localRev}`,服务端按键从镜像插件取
 * (src/render/frameClient.ts、server/vite-plugin-mirror.ts)。
 *
 * # 什么时候开始推
 *
 * **编辑页一加载就推**,不再等「连上 MCP 桥」—— 帧请求要靠镜像拿项目,没有 Agent 的时候
 * 预览也得能画。判据从「连着桥」换成「页面角色是编辑页」:只读观看页(`?observe` / `?view`)、
 * 舞台页、导出页一律不推(两个页面同时推会互相覆盖)。
 *
 * # 版本号
 *
 * `localRev` 在 **`project` 引用变化**时 +1(store 是不可变更新)。它是帧请求的键的一半,
 * 所以只能在这里加 —— 在推送的时候才加的话,同一个号会指向两份不同的项目。
 *
 * # 一致性
 *
 * - 用户的编辑:防抖 250 ms 推一次,能做增量就发两层 diff(src/render/changedClips.mjs)。
 * - Agent 的写操作:mcpExecutor 在回结果之前调 flushDataMirror(),所以 Agent「改完马上看」
 *   看到的一定是改完的那份(读后写一致)。取帧之前也会对齐(alignMirror)。
 * - 播放头 `{t, playing}` 走 `/api/data/playhead`,和项目分开:它是「停下来报一次当前时刻」,
 *   混进项目那条路的话,拖一次播放头要带着整份项目再飞一趟。
 * - **播放中每 2 秒发一条保活**(`PLAYHEAD_KEEPALIVE_MS`,下面「播放保活」一节):预渲染进程靠这条路上的音讯判断用户还在播放,
 *   播放头下没有缺口时 `wanted` 不发,不保活的话连播 5 秒就被当成用户走了。
 * - **推送一次只飞一个**,后一次等前一次落地再发:两次同时在路上的话,到达顺序没保证,
 *   旧的可能把新的盖掉。链上最多排一个等着的 —— 它跑起来时读的是最新状态,排十个没有意义。
 * - **推失败(网络错误、HTTP 非 2xx)就当没推过**,过一会儿自己再推;不然镜像会一直停在旧版。
 * - 服务端回 409 = 补丁对不上(基线滑出 8 版窗口,或者应用完哈希不等):当场整份重推。
 */

/** 这个页面这次打开的会话 id:刷新页面版本号从头数,服务端靠它分辨「新页面」和「旧推送」 */
const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 项目引用变一次 +1。0 = 还没开始镜像 */
let localRev = 0;
/** 已经推上去、服务端确认收下的那一版 */
let pushedRev = -1;
let pushedProject: Project | null = null;
let pushedT = -1;
let pushedPlaying: boolean | null = null;

let timer: ReturnType<typeof setTimeout> | null = null;
let headTimer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();
let queued = false;
let started = false;

/**
 * 这个页面该不该推镜像。只读观看页、舞台页、导出页都不推 —— 它们看的是别人的项目,
 * 推上去会把编辑页那一份盖掉。
 */
function isMirrorPage(): boolean {
  // 在线浏览器模式没有编辑器进程可镜像(C10a 契约第 2 节)
  if (onlinePage()) return false;
  try {
    const p = new URLSearchParams(location.search);
    if (p.has("observe") || p.get("view")) return false;
    if (p.has("export") || p.has("stage")) return false;
    return true;
  } catch {
    return false;
  }
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    // body 读完再走,免得连接挂在那儿
    await res.json().catch(() => null);
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function pushNow(): Promise<void> {
  if (!started) return;
  const project = getState().project as Project | undefined;
  if (!project) return;
  if (project === pushedProject && pushedRev === localRev) return;

  const rev = localRev;
  const hash = projectHash(project);
  const patch: ProjectPatch = pushedProject && pushedRev >= 0
    ? changedClips(pushedProject, project)
    : { kind: "full", project };

  let result = { ok: false, status: 0 };
  if (patch.kind === "tracks") {
    // 空补丁也发:引用变了但内容没变时,服务端也得把这个号记上,不然帧请求按它取不到
    result = await post("/api/data/diff", { session, fromLocalRev: pushedRev, toLocalRev: rev, projectHash: hash, patch });
    // 409:服务端对不上(基线滑出窗口 / 哈希不等)。整份重推,别在错的基线上接着打补丁
    if (!result.ok) pushedProject = null;
  }
  if (!result.ok) {
    result = await post("/api/data/project", { session, localRev: rev, project, projectHash: hash });
  }

  if (result.ok) {
    pushedProject = project;
    pushedRev = rev;
    // 项目和播放头一起变过(比如 Agent 改完就跳时间)时顺手把播放头也对上
    if (headTimer === null && !getState().playing) schedulePlayhead(0);
  } else if (started) {
    // 推不上:过两秒再试。服务端没有新镜像时 Agent 的工具退回经页面执行,不会用到过期的这一份
    schedule(2000);
  }
}

/**
 * 排进推送链:前一次落地之后才发下一次。链上最多排一个 —— 它跑起来时读的是当时最新的
 * 状态,排一串等于把同一份项目推很多遍。
 */
function push(): Promise<void> {
  if (queued) return chain;
  queued = true;
  const run = () => { queued = false; return pushNow(); };
  chain = chain.then(run, run);
  return chain;
}

function schedule(delay: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void push();
  }, delay);
}

async function pushPlayheadNow(): Promise<void> {
  if (!started) return;
  const s = getState();
  if (s.t === pushedT && s.playing === pushedPlaying) return;
  const t = s.t, playing = s.playing;
  const res = await post("/api/data/playhead", { session, t, playing });
  if (res.ok) { pushedT = t; pushedPlaying = playing; }
}

function schedulePlayhead(delay: number) {
  if (headTimer) clearTimeout(headTimer);
  headTimer = setTimeout(() => {
    headTimer = null;
    void pushPlayheadNow();
  }, delay);
}

/* ------------------------------------------------------------------ C4 wanted */

/**
 * C4:父页按层选快照时顺带得出「播放头附近现在缺哪些层」,经这里报给预渲染进程,
 * 它在 4 帧批次的边界读到之后把含这些帧的批提到前面。
 *
 * **单开一条发送路,不走上面的播放头路**,因为那一条的四个性质对 `wanted` 全是错的:
 *
 * - `:184` 的 `!s.playing` 闸门 —— 播放中根本不推,而播放正是最需要给播放头前方铺路的时候;
 * - `:149` 的「`t` 和 `playing` 没变就早退」—— 拖动停在同一帧、缺的层换了一张,发不出去;
 * - `:186` 的 400 ms 可重入防抖 —— 连续拖动期间一次都不触发;
 * - `post()` 既 `await` 又读完响应体、还带 10 秒超时 —— 一份「提示」不值得占一条连接。
 *
 * 这里的口径:**100 ms 固定节流**(不是防抖:节流窗口到点就发最后一份,连续拖动
 * 期间每 100 ms 稳定发一条)、`keepalive: true`、**不读响应**、失败静默。
 * 原有的播放头推送路径行为不变。
 */
export type WantedFrame = { clipId: string; frame: number };

/** C4 原文:最多 8 条 */
const MAX_WANTED = 8;
/** 固定节流窗口 */
const WANTED_MS = 100;

let wantedTimer: ReturnType<typeof setTimeout> | null = null;
let wantedPending: WantedFrame[] | null = null;
let wantedSentAt = 0;

/**
 * 轻路的一次发送:`wanted` 和下面的播放保活共用。不 await、不读响应、`keepalive: true`、失败静默 ——
 * 它是一份提示,晚一拍到也只是少插一次队(保活晚一拍到,服务端还有 5 秒的余量)。
 */
function sendPlayheadLight(body: Record<string, unknown>) {
  try {
    void fetch("/api/data/playhead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch { /* 页面正在卸载 / 网络断了:下一拍再说 */ }
}

function sendWanted(wanted: WantedFrame[]) {
  wantedSentAt = Date.now();
  sendPlayheadLight({ session, t: getState().t, playing: getState().playing, wanted });
}

/* ------------------------------------------------------------------ 播放保活 */

/**
 * 播放保活的间隔。预渲染进程判断「用户在不在播放」只看这条路上最近一次音讯:`playing` 且 5 秒内有过
 * (`FramePipeline.streamBusy()`、`server/queue-idle.mjs` 的 `interactionReason`),所以连续播放时得有音讯不断地来。
 * 原来播放中能刷新它的只有上面的 `wanted`,而播放头下每一层都有流盖着时没有缺口、`wanted` 不发 ——
 * 连着播放超过 5 秒,预渲染进程就当成用户走了,在播放中接着把别的卡的流补成满密度,违反「播放时不产」。
 *
 * 取 2 秒:明显小于服务端的 5 秒窗口,丢一两拍(页面卡一下、请求晚到)也不会过期;比 `wanted` 的 100 毫秒稀得多,
 * 一分钟 30 条小请求。服务端的两个窗口(5 秒、800 毫秒)不改。
 */
export const PLAYHEAD_KEEPALIVE_MS = 2000;

let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

/** 页面此刻在后台(标签页切走、窗口最小化):用户没在看,不发保活,预渲染进程可以恢复产流 */
function pageHidden(): boolean {
  try { return typeof document !== "undefined" && document.visibilityState === "hidden"; } catch { return false; }
}

function sendKeepalive() {
  if (!started) return stopKeepalive();
  const s = getState();
  if (!s.playing) return stopKeepalive();
  if (pageHidden()) return;
  // 不带 `wanted`:服务端沿用上一次的缺口提示(和「停下推一次」那条一样),保活既不刷新也不清掉它
  sendPlayheadLight({ session, t: s.t, playing: true });
}

function startKeepalive() {
  if (keepaliveTimer !== null) return;
  keepaliveTimer = setInterval(sendKeepalive, PLAYHEAD_KEEPALIVE_MS);
}

function stopKeepalive() {
  if (keepaliveTimer === null) return;
  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

/**
 * 报一次缺口。同一个 100 ms 窗口里调多少次都只飞一条(最后一份为准);
 * 空数组表示「现在什么都不缺」,不发。
 */
export function pushWanted(wanted: WantedFrame[]): void {
  if (!started || !Array.isArray(wanted) || !wanted.length) return;
  const list = wanted
    .filter((item) => item && typeof item.clipId === "string" && item.clipId && Number.isInteger(item.frame) && item.frame >= 0)
    .slice(0, MAX_WANTED);
  if (!list.length) return;
  const since = Date.now() - wantedSentAt;
  if (since >= WANTED_MS && wantedTimer === null) return sendWanted(list);
  wantedPending = list;
  if (wantedTimer !== null) return;
  wantedTimer = setTimeout(() => {
    wantedTimer = null;
    const next = wantedPending;
    wantedPending = null;
    if (next) sendWanted(next);
  }, Math.max(0, WANTED_MS - since));
}

/** 测试用:把节流状态清干净 */
export function resetWantedThrottle(): void {
  if (wantedTimer !== null) clearTimeout(wantedTimer);
  wantedTimer = null;
  wantedPending = null;
  wantedSentAt = 0;
}

/**
 * 开始镜像。**编辑页加载即调**;只读观看页 / 舞台页 / 导出页调了也空转。
 * 重复调用无副作用(返回的 disposer 只对第一次有效)。
 */
export function startDataMirror(): () => void {
  if (started) return () => {};
  if (!isMirrorPage()) return () => {};
  started = true;
  localRev = 1;
  let lastProject = getState().project;
  let lastPlaying = getState().playing;
  schedule(0);
  schedulePlayhead(0);
  if (lastPlaying) startKeepalive();
  const off = subscribe(() => {
    const s = getState();
    if (s.project !== lastProject) {
      // 版本号跟着**引用**走:帧请求的键就是它,只能在这里加
      lastProject = s.project;
      localRev++;
      schedule(250);
    }
    if (!s.playing && (lastPlaying || s.t !== pushedT)) {
      // 播放中不推 t;停下来(或暂停时拖了播放头)才推一次
      schedulePlayhead(400);
    } else if (s.playing !== pushedPlaying) {
      schedulePlayhead(0);
    }
    // 播放保活的计时器跟着 `playing` 起停(重复进来无副作用)
    if (s.playing) startKeepalive();
    else stopKeepalive();
    lastPlaying = s.playing;
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
    if (headTimer) clearTimeout(headTimer);
    timer = null;
    headTimer = null;
    stopKeepalive();
    resetWantedThrottle();
    started = false;
  };
}

/** 立刻把还没推的改动推上去并等它落地。Agent 的写工具回结果之前调 */
export async function flushDataMirror(): Promise<void> {
  if (!started) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await push();
}

/**
 * 整份重推一次并等它落地。帧请求收到 409 `MIRROR_MISSING` 时调 —— 那说明**某一个进程**
 * 手里没有这个键(多半是预渲染刚重启,转发正好丢在那一下),再打补丁只会接着落空。
 * 把基线清掉,下一次推送就是整份;编辑器那一端收到整份会无条件转给预渲染(见
 * server/vite-plugin-mirror.ts 的转发说明),所以这一次重推是真的能补到对面的。
 */
export async function resyncDataMirror(): Promise<void> {
  if (!started) return;
  pushedProject = null;
  pushedRev = -1;
  await flushDataMirror();
}

/** 这个页面镜像里的键;不做镜像的页面返回 null */
export function mirrorKey(): { session: string; localRev: number } | null {
  return started ? { session, localRev } : null;
}

/**
 * 帧请求之前的对齐:号和已推送的对不上就先 flush 一次,再把键交给调用方。
 *
 * 返回 null = 这个页面不做镜像(只读观看页 / 舞台页 / 导出页)。调用方这时把整份项目
 * 塞进 body —— 服务端的 prologue 认这条迁移路,读写都不经镜像。
 */
export async function alignMirror(): Promise<{ session: string; localRev: number } | null> {
  if (!started) {
    if (!isMirrorPage()) return null;
    // 打开项目时 import 可能抢在右栏挂载之前:这里补一次,别让第一趟请求落空
    startDataMirror();
    if (!started) return null;
  }
  if (localRev !== pushedRev) await flushDataMirror();
  return { session, localRev };
}
