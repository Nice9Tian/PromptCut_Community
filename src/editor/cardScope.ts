import type { CardDef } from "../kernel/types";
import { onlinePage } from "../online/pageFlag.ts"; // 带扩展名:本模块的单测不装解析钩子,直接 import

/**
 * 卡片库对 Agent 暴露多少 —— 三档,以及每一档能不能关掉。
 *
 * # 为什么要有这个
 *
 * `src/cards/user/` 是**一个全局目录**,`index.ts` 用 `import.meta.glob` 扫全目录。
 * 所以从前 Agent 给 A 项目建的卡,打开 B 项目照样出现在 `list_cards` 里。
 * 用户的原话:「ThreeJS 的资产又从上一个项目泄露给他了」—— 那张卡是给某个客户做的,
 * 串到别人的片子里既是噪音也是风险(Agent 真的会拿去用)。
 *
 * # 三档
 *
 *   基础素材   内置的三组:自家库(native)、搬来的第三方(magicui)、素材封装卡(asset)。
 *              随包发,永远在,但可以按组关掉 —— 比如「这条片子只用自家库」。
 *   自定义素材 用户卡里标成「共享」的那些。跨项目可见,给你自己的品牌卡这类留的口子。
 *   项目素材   用户卡的默认档:只在**建它的那个项目**里出现。定制卡多半是给某个客户
 *              做的,默认共享才是反直觉的那个选择。
 *
 * 档位记在服务端的 `src/cards/user/_scopes.json`(见 server/vite-plugin-cards.ts),
 * 因为注册表拿到的是 import 出来的 CardDef 对象、读不到文件里的注释。
 *
 * # 老卡怎么办
 *
 * 这个功能之前建的卡在表里没有条目。**不把它们藏起来** —— 悄悄让四张已有的卡消失,
 * 比泄露更难查。它们按「自定义(未归属)」处理,在面板里标出来,由用户决定留还是删;
 * 而「自定义素材」这个开关本身就是最直接的止血手段:关掉它,立刻只剩内置卡 + 本项目的卡。
 */

export type CardScope = "project" | "custom";
export type BaseGroup = "native" | "magicui" | "asset";

export interface ScopeEntry {
  scope: CardScope;
  projectId?: string;
  createdAt?: string;
}

export interface CardVisibility {
  /** 基础素材总开关。关掉 = 只剩自定义 / 本项目的卡(极少用,但留着) */
  base: boolean;
  /** 基础素材里放出哪几组 */
  groups: Record<BaseGroup, boolean>;
  /** 自定义素材(标了共享的定制卡,跨项目可见) */
  custom: boolean;
  /** 项目素材(只属于当前项目的定制卡)。关掉它等于"这一轮只用现成的卡" */
  project: boolean;
}

export const ALL_GROUPS: BaseGroup[] = ["native", "magicui", "asset"];

export const GROUP_LABEL: Record<BaseGroup, string> = {
  native: "自家库",
  magicui: "第三方组件",
  asset: "Lottie / 粒子",
};

const DEFAULT: CardVisibility = {
  base: true,
  groups: { native: true, magicui: true, asset: true },
  custom: true,
  project: true,
};

const LS_KEY = "pc.cardVisibility.v1";

export function readVisibility(): CardVisibility {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT;
    const p = JSON.parse(raw);
    return {
      base: p.base !== false,
      groups: { ...DEFAULT.groups, ...(p.groups || {}) },
      custom: p.custom !== false,
      project: p.project !== false,
    };
  } catch {
    return DEFAULT;
  }
}

export function writeVisibility(v: CardVisibility): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch { /* 存不下就这一次不记住,不该报错 */ }
}

/** 服务端那张归属表。改动不频繁,读进来缓存着;建卡和改档位之后失效 */
let scopeCache: Record<string, ScopeEntry> | null = null;

/** 在线构建的编译期常量(写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」):在线构建里剪掉 /api/cards/scopes */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export async function loadScopes(force = false): Promise<Record<string, ScopeEntry>> {
  if (scopeCache && !force) return scopeCache;
  // 在线浏览器模式没有编辑器进程,也就没有定制卡的归属表(用户卡在在线页面一期不渲染,契约第 1 节)
  if (ONLINE_BUILD || onlinePage()) return (scopeCache = {});
  try {
    const r = await fetch("/api/cards/scopes").then((x) => x.json());
    scopeCache = r?.ok ? (r.scopes ?? {}) : {};
  } catch {
    scopeCache = {};
  }
  return scopeCache ?? {};
}

export function invalidateScopes(): void {
  scopeCache = null;
}

/**
 * 改一张卡的档位(右键菜单那一项)。
 *
 * projectId 由调用方传进来,不在这里去问 —— 这个模块只放**规则**,不依赖编辑器的 io 层。
 * 那条依赖曾经存在,结果是这份纯逻辑没法单测(node 解析不了 vite 那种省略扩展名的 import),
 * 而 isCardVisible 恰恰是整个「定制卡跨项目泄露」的唯一修复点,最该有测试的就是它。
 */
export async function setCardScope(cardId: string, scope: CardScope, projectId?: string | null): Promise<void> {
  if (ONLINE_BUILD || onlinePage()) return;
  await fetch("/api/cards/scopes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardId, scope, projectId: projectId ?? undefined }),
  });
  invalidateScopes();
}

/** 归属表已经加载过就给缓存,没加载过给 null。存盘是同步的,等不了一次请求 */
export function peekScopes(): Record<string, ScopeEntry> | null {
  return scopeCache;
}

/**
 * 项目里用到的全部卡片 id:所有剪辑(激活的那条在 tracks,停放的在 cuts[].tracks)里片段的 cardId。
 *
 * 「用到了」本身就是最硬的归属证据 —— 时间轴上摆着这张卡,它就是这个项目的素材,
 * 不管归属表里记的是哪个草稿 id(那张表以前按草稿 id 记,换个打开方式就对不上)。
 */
export function usedCardIds(p: { tracks?: { clips?: { cardId?: string }[] }[]; cuts?: { tracks?: { clips?: { cardId?: string }[] }[] }[] }): Set<string> {
  const out = new Set<string>();
  const scan = (tracks: { clips?: { cardId?: string }[] }[] | undefined) => {
    for (const t of tracks ?? []) for (const c of t.clips ?? []) if (typeof c.cardId === "string" && c.cardId) out.add(c.cardId);
  };
  scan(p.tracks);
  for (const cut of p.cuts ?? []) scan(cut.tracks);
  return out;
}

/**
 * 一张用户卡的源码 import 了同目录的哪些文件(`./other` / `./other.tsx`)。
 * 打包进 .proc 时顺着它把依赖一起带上,不然换台机器这张卡编译不过。
 */
export function localCardImports(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/\bfrom\s+["']\.\/([A-Za-z0-9_-]+)(?:\.tsx)?["']/g)) out.add(m[1]);
  for (const m of source.matchAll(/\bimport\s+["']\.\/([A-Za-z0-9_-]+)(?:\.tsx)?["']/g)) out.add(m[1]);
  return [...out];
}

/**
 * 这张卡此刻该不该出现在 list_cards 里。
 *
 * 判据分两半:内置卡看「组开没开」,用户卡看「档位 + 是不是本项目建的」。
 * 拿不到归属表(还没加载完、请求失败)时**一律放行** —— 宁可多给几张,
 * 也不能因为一次网络抖动让 Agent 突然一张卡都看不见。
 *
 * `used` 是当前项目时间轴上用到的卡(usedCardIds)。用到了就算本项目的素材,
 * 和归属表记的项目 id 无关 —— 否则从桌面打开一份 .proc,片子里正用着的卡在卡库里反而找不到。
 */
export function isCardVisible(
  card: CardDef<any>,
  v: CardVisibility,
  scopes: Record<string, ScopeEntry>,
  projectId: string | null,
  used?: ReadonlySet<string>,
): boolean {
  if (card.source !== "user") {
    if (!v.base) return false;
    const g = card.source as BaseGroup;
    return v.groups[g] !== false;
  }
  if (v.project && used?.has(card.id)) return true;
  const entry = scopes[card.id];
  // 没有条目 = 这个功能之前建的老卡,按「自定义(未归属)」处理,不藏。
  // 悄悄让几张已有的卡消失,比泄露更难查 —— 要清理请在卡库里手动改档或删掉。
  if (!entry) return v.custom;
  if (entry.scope === "custom") return v.custom;
  // 项目素材:只在建它的那个项目里出现。没记下项目 id 的(老数据)按本项目算,不藏
  if (!v.project) return false;
  if (!entry.projectId) return true;
  return entry.projectId === projectId;
}

/** 面板上要显示的一行:这张用户卡属于谁、是什么档 */
export function describeUserCard(
  card: CardDef<any>,
  scopes: Record<string, ScopeEntry>,
  projectId: string | null,
  used?: ReadonlySet<string>,
): { scope: CardScope | "unknown"; mine: boolean } {
  const e = scopes[card.id];
  if (!e) return { scope: "unknown", mine: !!used?.has(card.id) };
  return { scope: e.scope, mine: !e.projectId || e.projectId === projectId || !!used?.has(card.id) };
}
