/**
 * 预览走哪条路:**回滚开关 `?preview=legacy` 与双舞台开关 `?preview=stage`**(D5 / F2)。
 *
 * **R7 已经把缺省翻过来了**:不带参数、带 `?preview=stage`、带任何别的值,走的都是
 * 跨源双舞台 —— 舞台 iframe 直接露出来,播放头由可见舞台按帧节拍推(K4),
 * 主文档只留音频。要回到老路得显式写 `?preview=legacy`:一个同源舞台 iframe、
 * 整帧 `<img>` 预览、播放头由 `Preview` 的 rAF 循环推。
 *
 * R2～R6 期间缺省是 legacy,新东西全藏在 `?preview=stage` 后面 —— 那几步的验收条件是
 * 「可见行为逐项不变」,而新行为要多起两个端口、要 iframe 换源,用户手里那份编辑台
 * 随便刷新一下就会踩上去。R7 是第一步**故意**改用户可见行为的,所以这一步才翻。
 * **为什么必须和 D5 的其余几条一起原子地翻**见 `docs/archive/restructure_planning/r2-r7-task.md` 的 D5 末尾。
 *
 * `StageView` 自己那个 `LEGACY`(`?preview=legacy` 时 `setProject` 立刻按跳转重算这一帧)
 * 是回滚的**另一半**:R7-6 之前 `Preview` 从来不把 `preview` 参数传进 iframe,它永远
 * 不生效;现在 `stageSrc` 在 legacy 下把 `&preview=legacy` 一并传进去,D5 说的
 * 「两件事都生效」才成立。`?preview=stage` 那一支不受影响(舞台里只认 `preview=stage`
 * 开 live 变体,两个值互斥)。
 */

import { ONLINE } from "../online/mode";
import { singleStageTier, tierStart } from "../online/onlineTier";
import { onlineStageState, stageLayout } from "../online/stageOrigins";
import { STAGE_ENTRY_FILE } from "../online/isolation/stageGuard";

/** 舞台实例名。**只是实例名,和角色无关**(E1):谁当 `front` 由 `setRole` 定 */
export type StageId = "A" | "B";

export const STAGE_IDS: readonly StageId[] = ["A", "B"];

/** 起手的角色分派:A 当可见舞台,B 当后台舞台。K5 的互换之后这张表就不作数了 */
export const INITIAL_ROLE_OF: Record<StageId, "front" | "back"> = { A: "front", B: "back" };

export type PreviewMode = "legacy" | "stage";

const paramOf = (): string => (typeof location === "undefined" ? "" : new URLSearchParams(location.search).get("preview") || "");

/**
 * **缺省是 stage(R7 的原子切换)**;只有显式 `?preview=legacy` 才退回单舞台 + 整帧那条路。
 *
 * `?preview=stage` 仍然认 —— 它现在和不带参数一个意思,留着是因为 R2～R6 的探针、
 * 文档和用户手里的书签都写着它。别的值(打错的、老链接)一律按缺省走 stage。
 */
export function previewMode(): PreviewMode {
  return paramOf() === "legacy" ? "legacy" : "stage";
}

/**
 * 编辑器进程真的起起来的舞台端口(`server/vite-plugin-stage-ports.ts` 注入)。
 * 端口被占、或者在没有这个插件的环境里(vite preview 的产物包),这里是空表。
 */
export function stagePorts(): number[] {
  const v = (window as unknown as { __PC_STAGE_PORTS__?: unknown }).__PC_STAGE_PORTS__;
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
}

/**
 * 每个舞台实例该从哪个源加载。**按当前页面的 hostname 拼**(不是写死 127.0.0.1):
 * 用户从 `localhost` 打开时两个 iframe 也得是 `localhost` —— 同 host 不同端口 + OAC 头
 * 才是实测过的那条路(`docs/archive/restructure_planning/g0-a-webview2-probe.md`),换成别的 host 就成了另一件事。
 */
export function stageOrigins(): Record<StageId, string> | null {
  // 在线浏览器模式(C10 契约第 2 节):舞台源来自运行配置(`/editor/runtime-config.json`),不看舞台端口表
  if (ONLINE) return onlineStageState().origins;
  const ports = stagePorts();
  if (ports.length < STAGE_IDS.length) return null;
  const out = {} as Record<StageId, string>;
  STAGE_IDS.forEach((id, i) => { out[id] = `${location.protocol}//${location.hostname}:${ports[i]}`; });
  return out;
}

/**
 * 这一次到底开不开双舞台。两个条件都要:显式开了 `?preview=stage`,而且两个舞台端口都起来了。
 * 少一个就退回 legacy 的同源单舞台 —— 宁可少一个后台舞台,也不能让编辑台开不出画面。
 */
export function dualStage(): boolean {
  /*
   * 在线浏览器模式(C10 契约第 2 节):开两个同站跨源的舞台,舞台源来自运行配置;舞台闸门停在第一级(精简模式、低配模式)
   * 只开跨源单舞台 A(`online/onlineTier.ts`);握手失败退回跨源单舞台 A;读不到配置则不挂载舞台,不再退回同源单舞台(2026-10-14 用户定)。
   * 舞台端口表在线上一律不看。
   */
  if (ONLINE) {
    const st = onlineStageState();
    return stageLayout({ single: singleStageTier(), origins: st.origins, handshake: st.handshake, pageOrigin: typeof location === "undefined" ? undefined : location.origin }) === "dual";
  }
  return previewMode() === "stage" && stageOrigins() !== null;
}

/**
 * 在线双舞台首次握手的过渡期(`stageHandshake.ts` 的 `interim`)已撤销（2026-10-14 用户定：所有舞台一律跨源隔离，撤掉退回同源单舞台的路）。
 * 直接返回 false。
 */
export function interimStage(): boolean {
  return false;
}

/**
 * 在线浏览器模式的**单舞台 live 预览**(`docs/plan/c10a-contract.md` 第 8.1 节):跨源单舞台 A 按 live 变体渲
 * (素材层画进舞台、六个平面生效,相当于双舞台里 `&preview=stage` 的那一份),A 就是可见舞台,没有 B。
 * 双舞台与单舞台(舞台闸门第一级、握手失败的退回)都走它;`?preview=legacy` 在在线页面上不认(没有预渲染进程给整帧)。
 */
export function singleLiveStage(): boolean {
  return ONLINE;
}

/** 可见舞台渲 live 变体(双舞台,或在线页面的单舞台):播放头跟舞台的 `frame`、快照 / 抑制经 RPC 投递 */
export function liveStage(): boolean {
  return dualStage() || singleLiveStage();
}

/**
 * 舞台 iframe 的地址。legacy(或端口没起来)时是同源,只有 A 那一个。
 *
 * **开了双舞台才带 `&preview=stage`**(R3):舞台页靠它决定渲 `FrameScene` 的 live 变体
 * (素材层进舞台、六个平面 prop 生效)还是照旧只渲 `Stage`。不带 = 今天用户手里那份编辑台,
 * 舞台内容一个字不变 —— 这就是「新行为只在非 legacy 下生效」的落点。
 *
 * **`?preview=legacy` 同样传进去**(D5 / R7-6):`StageView` 里那个同名的 `LEGACY`
 * (`setProject` 立刻按跳转重算这一帧)是回滚的另一半,以前从来收不到这个参数、
 * 永远不生效 —— legacy 下改了项目之后,在下一次 `setTime` 之前舞台 DOM 停在旧状态,
 * 而 legacy 正是靠舞台做命中测试和实体框的。端口没起来的退回**不传**:那不是回滚,
 * 是双舞台开不出来,舞台内容应当照缺省走。
 */
export function stageSrc(id: StageId, opts: { dual?: boolean } = {}): string {
  // `opts.dual`:按双舞台 / 单舞台的形状给地址,不看此刻的布局(换回那一下的衔接要用)
  const dual = opts.dual ?? dualStage();
  const origins = ONLINE ? stageOrigins() : dual ? stageOrigins() : null;
  if (ONLINE && (!origins || !origins[id])) {
    throw new Error(`[previewMode] 在线舞台未配置跨源隔离源，禁止退回同源舞台: stage ${id}`);
  }
  const mode = dual || singleLiveStage() ? "&preview=stage" : previewMode() === "legacy" ? "&preview=legacy" : "";
  // 在线浏览器模式还没有运行期判据,先由编辑页地址上的 `platform=browser` 显式打开、转给舞台(`unsupported` 占位)
  const platform = new URLSearchParams(location.search).get("platform") === "browser" ? "&platform=browser" : "";
  /*
   * `dual=1`:这一台舞台有后台舞台做伴,宿主能力表照实报「能测量、能追活渲」(C10 契约第 2 节)。
   * 在线页面另带父页按闸门定下的几样(跨源的舞台读不到编辑器页那个源的页面本地存储,崩溃记录与闸门结果都在编辑器页):
   * `gl=shared|perDocument` 起手的 canvas 渲染路线(试第三级时父页经 RPC `setGlRoute` 换)、`compact=1` 只有一个舞台
   * (图集按小的上限开)、`lowest=1` 最低一档(素材起手只用小尺寸,不等父页的取档策略到了才改)。
   */
  const dualFlag = dual ? "&dual=1" : "";
  // 只按页面载入时定下的起手样子拼(`tierStart`):试的途中换路线走 RPC `setGlRoute`,基准卡判出最低一档走取档策略,都不改地址(改了 iframe 就重新载入)
  const tier = ONLINE ? `&gl=${tierStart().route}${dual ? "" : "&compact=1"}${tierStart().lowest ? "&lowest=1" : ""}` : "";
  /*
   * 在线的跨源舞台载单独的舞台入口 `stage.html`(同一份脚本包;契约 `online-card-exec-contract.md` 第 3.3 节):它带舞台的内容安全策略
   * (`<meta>` 兜底),加固与自检按这个路径认它(`isolation/stageGuard.ts`)。桌面运行环境端口未起时的退回地址一个字不变。
   */
  // 按构建的 base 拼(`/editor/stage.html`):编辑器页的地址可能是不带斜杠的 `/editor`,不能拿它的目录部分
  const base = typeof import.meta.env !== "undefined" && import.meta.env.BASE_URL ? import.meta.env.BASE_URL : "/";
  const path = ONLINE && origins ? `${base.endsWith("/") ? base : `${base}/`}${STAGE_ENTRY_FILE}` : location.pathname;
  return `${origins ? origins[id] : ""}${path}?stage=1&id=${id}${mode}${platform}${dualFlag}${tier}`;
}

/** 给 `createStageRpc` 的 `targetOrigin`:跨源时必须点名,不能用 `location.origin` */
export function stageTargetOrigin(id: StageId): string {
  const origins = ONLINE ? stageOrigins() : dualStage() ? stageOrigins() : null;
  if (ONLINE && (!origins || !origins[id])) {
    throw new Error(`[previewMode] 在线舞台未配置跨源隔离源，禁止退回同源舞台: stage ${id}`);
  }
  return origins ? origins[id] : location.origin;
}
