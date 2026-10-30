/**
 * 「展开但没打开」的云端项目底下列什么(issue #15)。
 *
 * 氛围式侧栏原来只有**此刻连着的**那个项目列得出对话:对话要凭这个项目的身份向它的云端 Agent 服务要,
 * 而全局只连得了一个项目,于是点第二个项目,第一个就塌回去。这里给没连着的项目开一条**只读**的路:
 *
 *   1. 向这个项目的文档服务现取一次会话(`client.session`,就是进项目时用的那条 `/hosted/shared/account/session`),
 *      拿它的云端 Agent 委托票据和地址 —— **不开文档连接、不动编辑器里打开的那个项目**;
 *   2. 凭那张票据 `GET /conversations`,再按共有 / 私有复核一遍(`vibeOrg.ts` 的 `viewableChats`),别人的私有对话不列。
 *
 * 节奏上刻意保守:只在用户点开那一支时取,取到的东西 `BROWSE_TTL_MS` 内不再取;页面回到前台、刷新都不自动重取。
 * 票据只活五分钟,而每取一次会话服务端要签三张票,展开着十个项目的人一刷新就是十次签票 —— 不值得。
 *
 * 浏览态是**只读**的:列出来的对话只能点进去(那会连上那个项目),改名、置顶、归档、删除都不在这里做 ——
 * 删对话走的是当前连着那个项目的 Agent 服务,置顶归档写的是「当前打开的项目」名下,在浏览态里做会落到别的项目上。
 * 哪几项置灰、怎么说,在 `OnlineStart.tsx` 的 `ops.blocked`。
 *
 * 本文件不引 React(React 那一层在 `OnlineStart.tsx`,用 `useSyncExternalStore` 订阅),Node 单测直接用。
 */
import { CloudError, ONLINE_AGENT_PATH, getAiCloudProvider } from "../ai/extensions.ts";
import { viewableChats } from "./vibeOrg.ts";
import type { VibeChat } from "./types.ts";

/** 会话回包里列对话用得到的几项（结构类型，不直接依赖 `src/account/client.ts`） */
export interface BrowseSession {
  agentDelegationTicket: string;
  creator: boolean;
  hosted?: {
    agent?: { available: boolean; enabled?: boolean; url: string | null } | null;
  } | null;
}

function isAccountFailure(error: unknown): error is Error & { status: number; code: string } {
  return (
    error instanceof Error &&
    !(error instanceof CloudError) &&
    typeof (error as { status?: unknown }).status === "number" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

/** 取回来的对话列表多久之内不再取(毫秒)。票据本身活五分钟,这个数要比它小 */
export const BROWSE_TTL_MS = 180_000;

/** 侧栏里一个「展开但没打开」的项目此刻是什么样 */
export interface BrowseEntry {
  state: "loading" | "ready" | "error";
  /** 已经按共有 / 私有复核过的对话;还没取到时是空的 */
  chats: VibeChat[];
  /** 这一支底下写的那一行话(正在取、取不到、这个项目没有云端 Agent、要二级密码…);没有就不写 */
  note?: string;
  /** 那一行后面给不给「重试」 */
  retry?: boolean;
  /** 这一份是什么时候取到的(`now()`);没取到过是 0 */
  at: number;
}

export interface BrowseDeps {
  /** 现取一次这个项目的会话(`useAccountProjects` 的 `peekSession`) */
  session: (projectId: string) => Promise<BrowseSession>;
  /** 此刻是谁在看(账号或游客的编号);复核私有对话要用 */
  viewer: () => { accountId: string | null };
  /** 在线页面的同源地址;文档服务没报 Agent 地址时按它拼(与 `resolveCloudAgent` 同一条规矩) */
  origin?: () => string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export type BrowseState = Readonly<Record<string, BrowseEntry>>;

/**
 * 这个项目的云端 Agent 在哪。与 `endpoint.ts` 的 `resolveCloudAgent`(在线那一支)同一条规矩:
 * 文档服务说没有就是没有;说有、但没给地址的,按页面同源拼
 */
export function agentBaseOf(hosted: BrowseSession["hosted"], origin: string): { url: string | null; note?: string } {
  const agent = hosted?.agent;
  if (!agent?.available) return { url: null, note: "这个项目所在的云端没有 Agent 服务，列不出对话。" };
  if (agent.enabled === false) return { url: null, note: "项目创建者关闭了云端 Agent，这里列不出对话。" };
  const url = agent.url ? agent.url.replace(/\/+$/, "") : `${origin}${ONLINE_AGENT_PATH}`;
  return { url };
}

/** 取不到时底下写哪一句、给不给「重试」。能自己重试的才给(网络、服务一时不可用),要用户去做别的事的不给 */
export function browseNoteOf(error: unknown): { note: string; retry: boolean } {
  if (isAccountFailure(error)) {
    // 要输这个项目的二级密码、已不在名单、被禁入、项目没了:重试多少次都一样,告诉他去做什么
    if (error.code === "secondary-password-required") return { note: "这个项目要先输项目二级密码：点项目名进去，按提示输入。", retry: false };
    if (["not-listed", "banned", "no-project", "project-gone"].includes(error.code)) return { note: error.message, retry: false };
    if (error.status === 401) return { note: error.message, retry: false };
    return { note: error.message, retry: true };
  }
  if (error instanceof CloudError) {
    if (error.code === "disabled") return { note: "项目创建者关闭了云端 Agent，这里列不出对话。", retry: false };
    if (error.code === "unauthorized" || error.code === "forbidden") return { note: "没有读这个项目对话的权限。", retry: false };
    return { note: error.message, retry: true };
  }
  return { note: error instanceof Error && error.message ? error.message : "暂时读不到这个项目的对话。", retry: true };
}

/**
 * 取一个项目的对话列表。`note` 有值表示列不出来(没有 Agent 服务、创建者关了);这两种不算失败,
 * 不必重试,所以照常记成 `ready`
 */
export async function fetchBrowsedChats(projectId: string, deps: BrowseDeps): Promise<{ chats: VibeChat[]; note?: string }> {
  const session = await deps.session(projectId);
  const origin = deps.origin?.() ?? (typeof location !== "undefined" ? location.origin : "");
  const base = agentBaseOf(session.hosted, origin);
  if (!base.url) return { chats: [], ...(base.note ? { note: base.note } : {}) };
  const items = await getAiCloudProvider().listCloudChats({
    baseUrl: () => base.url,
    projectId: () => projectId,
    ticket: async () => session.agentDelegationTicket,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return { chats: viewableChats(items, { accountId: deps.viewer().accountId, creator: session.creator === true }, projectId) };
}

export interface BrowseChats {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => BrowseState;
  /**
   * 该去取这个项目的对话了(用户点开了那一支)。`force` 是用户自己点「重试」:不管 TTL 都取一次。
   * 正在取的、TTL 之内取过的都不会再发请求
   */
  load: (projectId: string, options?: { force?: boolean }) => void;
  /** 换账号、退出登录:整桶丢掉(不然会串出上一个账号的对话) */
  forget: () => void;
}

export function createBrowseChats(deps: BrowseDeps): BrowseChats {
  const now = deps.now ?? (() => Date.now());
  const listeners = new Set<() => void>();
  const inFlight = new Set<string>();
  let state: BrowseState = {};
  const emit = () => { for (const l of [...listeners]) l(); };
  const put = (projectId: string, entry: BrowseEntry) => { state = { ...state, [projectId]: entry }; emit(); };

  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot() { return state; },
    load(projectId, options) {
      if (!projectId || inFlight.has(projectId)) return;
      const had = state[projectId];
      if (!options?.force && had && had.state === "ready" && now() - had.at < BROWSE_TTL_MS) return;
      inFlight.add(projectId);
      // 取的时候把上一次的结果留在原处:只在那一行写「正在取」,底下已经列着的对话不闪掉
      put(projectId, { state: "loading", chats: had?.chats ?? [], note: "正在读这个项目的对话…", at: had?.at ?? 0 });
      void fetchBrowsedChats(projectId, deps).then(
        (out) => { inFlight.delete(projectId); put(projectId, { state: "ready", chats: out.chats, ...(out.note ? { note: out.note } : {}), at: now() }); },
        (error) => {
          inFlight.delete(projectId);
          const why = browseNoteOf(error);
          put(projectId, { state: "error", chats: had?.chats ?? [], note: why.note, retry: why.retry, at: had?.at ?? 0 });
        },
      );
    },
    forget() { inFlight.clear(); if (Object.keys(state).length === 0) return; state = {}; emit(); },
  };
}
