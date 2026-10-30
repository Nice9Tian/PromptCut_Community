/**
 * 侧栏那棵树里「整理信息」那一半:分组、项目放在哪个分组、置顶、归档、手排的顺序。
 *
 * **两套分组,互不混放**(用户 2026-10-23 定:「分本地分组(桌面版的本地 Agent)和云端分组。云端分组存云端,本地分组存本地。
 * 本地项目放不进云端的分组(反之云端也放不进本地)」):
 *
 * |          | 装什么项目                         | 存在哪                   | 哪一屏用            |
 * |----------|------------------------------------|--------------------------|---------------------|
 * | 本地分组 `local` | 本机草稿项目(`editor/io/drafts.ts`) | 本机(`localStorage`)      | `DesktopStart.tsx`  |
 * | 云端分组 `cloud` | 云端项目(云端文档服务的项目列表)   | 云端,跟着账号走(见下)   | `OnlineStart.tsx`   |
 *
 * 一份 `OrgState` 只属于一套(`realm`),键、内容里的标记、拼清单、放进分组四处都按它认,任何一处对不上都拒绝:
 * - **存储键按套分开**(`orgKey`):`pc.start.org.local.<范围>` 与 `pc.start.org.cloud.<范围>`,前缀就不同,谁也盖不到谁;
 * - **内容里带标记**(`parseOrg`):读出来的东西标着另一套的,当没记过,不会把一套的内容当成另一套的;
 * - **拼清单只收同一套的项目**(`mergeProjects`);
 * - **放进分组只能同一套**(`moveProject`、`moveRefusal`):跨套返回一句说明,整理信息原样不动。
 *
 * **云端那一套存哪**:存在云端文档服务、按账号一份,整份(分组、项目放在哪、置顶、归档、顺序、对话标记)一起上云
 * (接口 `POST /hosted/shared/account/start-org`,服务端 `cloud/docservice/modules/account-org.mjs`,裁定 V22-05～09)。
 * 本机的键 `pc.start.org.cloud.<账号>` 是它在这台浏览器里的缓存:打开先用它,同步逻辑见 `orgSync.ts`、`orgMerge.ts`、`useCloudOrg.ts`。
 * 服务端还没有这条路由(老服务端)时安静地退回「只记在这台浏览器里」,界面据此改口。游客没有云端那一份(游客身份不跨设备、只有一个项目),也就没有分组。
 *
 * 项目本身(有哪些、叫什么、谁建的)一律以项目列表为准:这里只记整理信息,列表里没有的项目不会凭空出现;
 * 列表暂时取不到时也不丢已经记下的整理信息(`withProjects` 把这次没出现的条目原样留着)。
 *
 * 纯函数加一对读写,不碰 React;读写都包 try/catch(无痕窗口、禁了站点数据会直接抛),取不到就当没记过。
 * 一律返回新对象,不原地改(仓库约束)。单测 `vibeOrg.test.mjs`、`orgRealm.test.mjs`。
 */
import type { OrgRealm, Ratio, TreeFlags, VibeChat, VibeGroup, VibeProject } from "./types.ts";

export type { OrgRealm } from "./types.ts";

export interface OrgProject extends TreeFlags {
  id: string;
  groupId: string | null;
}

export interface OrgChat extends TreeFlags {
  id: string;
  projectId: string;
}

/** 存起来的分组:属于哪一套由整份 `OrgState` 的 `realm` 说了算,每个分组不再各记一遍 */
export type OrgGroup = Omit<VibeGroup, "realm">;

export interface OrgState {
  v: 1;
  /** 这一份属于哪一套;键、内容、拼清单、放进分组都按它核对 */
  realm: OrgRealm;
  groups: OrgGroup[];
  /** 数组顺序就是显示顺序(同级之间) */
  projects: OrgProject[];
  chats: OrgChat[];
}

const EMPTY: Readonly<Record<OrgRealm, OrgState>> = Object.freeze({
  local: Object.freeze({ v: 1, realm: "local", groups: [], projects: [], chats: [] }) as OrgState,
  cloud: Object.freeze({ v: 1, realm: "cloud", groups: [], projects: [], chats: [] }) as OrgState,
});

/** 这一套里什么都没记过的整理信息(共用的冻住对象,不要改它) */
export const emptyOrg = (realm: OrgRealm): OrgState => EMPTY[realm];

/** 本机分组在本机存储里只有一份:桌面版是一台机器,范围固定用它 */
export const LOCAL_ORG_SCOPE = "desktop";

/** 云端分组的范围:登录账号的编号。游客没有(游客没有分组,见文件头) */
export const cloudOrgScope = (accountId: string): string => `acc:${accountId}`;

/**
 * 本机存储的键。**两套的前缀不同**(`pc.start.org.local.` / `pc.start.org.cloud.`),所以任何范围名都撞不到对面那一套去。
 * 云端那一套按账号各一份;本机那一套按范围(现在只有 `LOCAL_ORG_SCOPE` 一个)。
 */
export const orgKey = (realm: OrgRealm, scope: string): string => `pc.start.org.${realm}.${scope}`;

/** 分套之前的老键(`pc.start.org.<范围>`):读不到新键时认一次,写只写新键 */
const legacyOrgKey = (scope: string): string => `pc.start.org.${scope}`;

/** 本地项目放不进云端分组、云端项目放不进本地分组:说给用户的那一句。同一套返回 null */
export function moveRefusal(projectRealm: OrgRealm, groupRealm: OrgRealm): string | null {
  if (projectRealm === groupRealm) return null;
  return projectRealm === "local"
    ? "本地项目不能放进云端分组：本地分组装本机的项目，云端分组装云端的项目。"
    : "云端项目不能放进本地分组：云端分组装云端的项目，本地分组装本机的项目。";
}

/**
 * 云端分组是不是存在云端。云端存储接上之后(服务端有 `start-org`、页面有同步)恒为 true;
 * 保留成常量是为了:服务端没部署到位的版本可以改回 false,界面立刻只说「只记在这台浏览器里」,不假装已经跨设备。
 * 运行时探到老服务端(没有这条路由)另有一道,见 `orgWhereText` 的第二个参数。
 */
export const CLOUD_ORG_IN_CLOUD = true;

/**
 * 这一套的整理信息存在哪,说给用户的一句(新建分组的提示、侧栏的说明都用它)。
 * `inCloud`:云端这一套此刻是不是真存在云端;缺省看 `CLOUD_ORG_IN_CLOUD`,在线屏在探到老服务端时传 false。
 */
export function orgWhereText(realm: OrgRealm, inCloud: boolean = CLOUD_ORG_IN_CLOUD): string {
  if (realm === "local") return "只记在这台机器上";
  return inCloud ? "存在云端，换设备也能看到" : "暂时只记在这台浏览器里";
}

/** 「新建分组」处说的话:这是哪一套分组、存在哪、装什么 */
export function groupNoteText(realm: OrgRealm, inCloud: boolean = CLOUD_ORG_IN_CLOUD): string {
  return realm === "local"
    ? `本地分组：${orgWhereText("local")}，只能放本机的项目。`
    : `云端分组：${orgWhereText("cloud", inCloud)}，只能放云端的项目。`;
}

/**
 * 云端项目列表取到了之后,把整理信息里**已经不在列表里**的项目清掉,免得云端那一份只增不减:
 * 项目条目没有分组、置顶、归档(没有任何整理信息,只剩一个位置)的去掉;项目下的对话条目跟着项目去掉。
 * 有整理信息的条目留着(也许是列表一时没取全)。列表没取到(`ids` 为 null)不清理。没有要清的返回原对象。
 */
export function pruneOrg(org: OrgState, ids: ReadonlySet<string> | null): OrgState {
  if (!ids) return org;
  const keep = (p: OrgProject) => ids.has(p.id) || p.groupId !== null || !!p.pinned || !!p.archived;
  const projects = org.projects.filter(keep);
  const known = new Set([...ids, ...projects.map((p) => p.id)]);
  const chats = org.chats.filter((c) => known.has(c.projectId));
  if (projects.length === org.projects.length && chats.length === org.chats.length) return org;
  return { ...org, projects, chats };
}

/** 侧栏要的分组清单:存起来的分组盖上这一套的标记 */
export function groupsOf(org: OrgState): VibeGroup[] {
  return org.groups.map((g) => ({ ...g, realm: org.realm }));
}

function flagsOf(x: unknown): TreeFlags {
  const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const out: TreeFlags = {};
  if (r.pinned === true) out.pinned = true;
  if (r.archived === true) out.archived = true;
  return out;
}

function idOk(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 200;
}

type Loose = Record<string, unknown>;
const rows = (x: unknown): Loose[] => (Array.isArray(x) ? x.filter((r) => r && typeof r === "object") : []) as Loose[];

/**
 * 读回来的东西不可信(手改过、旧版本写的别的形状):逐条认,认不出的丢掉。
 * `realm` 是调用方要读的那一套:内容里标着另一套的整份不认(当没记过);没标的是分套之前写的老格式,按调用方要的这一套认。
 */
export function parseOrg(raw: string | null, realm: OrgRealm): OrgState {
  if (!raw) return emptyOrg(realm);
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return emptyOrg(realm);
  }
  const r = (v && typeof v === "object" ? v : {}) as Loose;
  if (r.realm !== undefined && r.realm !== realm) return emptyOrg(realm);
  const groups: OrgGroup[] = rows(r.groups)
    .filter((g) => idOk(g.id) && typeof g.name === "string" && g.name.trim() !== "")
    .map((g) => ({ id: g.id as string, name: String(g.name).slice(0, 200), ...flagsOf(g) }));
  const groupIds = new Set(groups.map((g) => g.id));
  const projects: OrgProject[] = rows(r.projects)
    .filter((p) => idOk(p.id))
    .map((p) => ({ id: p.id as string, groupId: idOk(p.groupId) && groupIds.has(p.groupId) ? p.groupId : null, ...flagsOf(p) }));
  const chats: OrgChat[] = rows(r.chats)
    .filter((c) => idOk(c.id) && idOk(c.projectId))
    .map((c) => ({ id: c.id as string, projectId: c.projectId as string, ...flagsOf(c) }));
  return { v: 1, realm, groups, projects, chats };
}

/** 读这一套在本机存的那一份。没有范围(没登录)、读不到、读出来不对,都当没记过 */
export function loadOrg(realm: OrgRealm, scope: string | null): OrgState {
  if (!scope) return emptyOrg(realm);
  try {
    // 新键没有就认一次分套之前的老键(它没有套的标记,按调用方要的这一套认)
    const raw = localStorage.getItem(orgKey(realm, scope)) ?? localStorage.getItem(legacyOrgKey(scope));
    return parseOrg(raw, realm);
  } catch {
    return emptyOrg(realm);
  }
}

/** 写在本机。键按这一份自己的套来定(`org.realm`),调用方没有机会把一套写进另一套的键 */
export function saveOrg(scope: string | null, org: OrgState): void {
  if (!scope) return;
  try {
    localStorage.setItem(orgKey(org.realm, scope), JSON.stringify(org));
  } catch {
    /* 存不了就只在这次打开期间有效 */
  }
}

/** 项目清单里的一个项目:带它属于哪一套(本机草稿是 local;云端列表里的我创建的、我加入的、游客自己的是 cloud) */
export interface OrgEntry {
  id: string;
  name: string;
  role: VibeProject["role"];
  realm: OrgRealm;
}

/** 这台浏览器打开过这个项目时记下的画面信息(`thumbCache.ts`) */
export interface SeenMeta {
  ratio: Ratio | null;
  duration: number | null;
  thumb: string | null;
  seenAt: string | null;
}

/**
 * 把项目列表和整理信息拼成侧栏要的项目清单。顺序:记过顺序的按记的排;这次新出现的(刚建的、刚被拉进来的)排最前面,
 * 彼此之间保持列表里的先后。同一个项目在「我创建的」「我加入的」里都出现时只留第一次。
 * **只收和这份整理信息同一套的项目**:本地整理信息里不会出现云端项目,云端的里也不会出现本机草稿。
 */
export function mergeProjects(org: OrgState, cloud: readonly OrgEntry[], meta: Readonly<Record<string, SeenMeta>> = {}): VibeProject[] {
  const byId = new Map<string, OrgEntry>();
  for (const c of cloud) if (c.realm === org.realm && !byId.has(c.id)) byId.set(c.id, c);
  const groupIds = new Set(org.groups.map((g) => g.id));
  const known = org.projects.filter((p) => byId.has(p.id));
  const knownIds = new Set(known.map((p) => p.id));
  const fresh: OrgProject[] = [...byId.values()].filter((c) => !knownIds.has(c.id)).map((c) => ({ id: c.id, groupId: null }));
  return [...fresh, ...known].map((o) => {
    const c = byId.get(o.id)!;
    const m = meta[o.id];
    const p: VibeProject = {
      id: c.id,
      name: c.name,
      role: c.role,
      realm: org.realm,
      groupId: o.groupId && groupIds.has(o.groupId) ? o.groupId : null,
      ratio: m?.ratio ?? null,
      duration: m?.duration ?? null,
      thumb: m?.thumb ?? null,
      seenAt: m?.seenAt ?? null,
    };
    if (o.pinned) p.pinned = true;
    if (o.archived) p.archived = true;
    return p;
  });
}

/**
 * 侧栏改过项目之后(置顶、归档、排序、换分组)写回整理信息。这次清单里没有的条目(列表暂时取不到、换了账号范围)原样留在后面,不丢。
 */
export function withProjects(org: OrgState, list: readonly Pick<VibeProject, "id" | "realm" | "groupId" | "pinned" | "archived">[]): OrgState {
  // 另一套的项目不进这一份(正常走不到:清单是 `mergeProjects` 拼的,已经只有同一套)
  const mine = list.filter((p) => p.realm === org.realm);
  const ids = new Set(mine.map((p) => p.id));
  const rest = org.projects.filter((p) => !ids.has(p.id));
  return {
    ...org,
    projects: [...mine.map((p) => ({ id: p.id, groupId: p.groupId ?? null, ...flagsOf(p) })), ...rest],
  };
}

export function withGroups(org: OrgState, groups: readonly (OrgGroup & { realm?: OrgRealm })[]): OrgState {
  // 另一套的分组不进这一份
  groups = groups.filter((g) => g.realm === undefined || g.realm === org.realm);
  const ids = new Set(groups.map((g) => g.id));
  return {
    ...org,
    groups: groups.map((g) => ({ id: g.id, name: g.name, ...flagsOf(g) })),
    // 删掉的分组:里面的项目回到「没放进分组」
    projects: org.projects.map((p) => (p.groupId && !ids.has(p.groupId) ? { ...p, groupId: null } : p)),
  };
}

export function withChats(org: OrgState, projectId: string, list: readonly Pick<VibeChat, "id" | "pinned" | "archived">[]): OrgState {
  const ids = new Set(list.map((c) => c.id));
  const rest = org.chats.filter((c) => !(c.projectId === projectId && ids.has(c.id)));
  return { ...org, chats: [...list.map((c) => ({ id: c.id, projectId, ...flagsOf(c) })), ...rest] };
}

/** 新建分组。名字空白就叫「新分组」;编号在这一份里不重复 */
export function addGroup(org: OrgState, name: string, rand: () => string = () => Math.random().toString(36).slice(2, 8)): { org: OrgState; id: string } {
  const taken = new Set(org.groups.map((g) => g.id));
  let id = `g-${rand()}`;
  for (let i = 0; taken.has(id) && i < 50; i++) id = `g-${rand()}${i}`;
  const group: OrgGroup = { id, name: name.trim().slice(0, 200) || "新分组" };
  return { org: { ...org, groups: [...org.groups, group] }, id };
}

/**
 * 把一个项目放进某个分组(null 是移出分组)。**只许同一套**:项目属于另一套(本地项目对云端分组、云端项目对本地分组)时
 * 整理信息原样不动、`refused` 是说给用户的那一句。放进分组的入口(右键菜单、将来的拖拽)都得走这一个函数。
 */
export function moveProject(org: OrgState, project: Pick<VibeProject, "id" | "realm">, groupId: string | null): { org: OrgState; refused: string | null } {
  const refused = moveRefusal(project.realm, org.realm);
  if (refused) return { org, refused };
  const target = groupId && org.groups.some((g) => g.id === groupId) ? groupId : null;
  const has = org.projects.some((p) => p.id === project.id);
  const projects = has
    ? org.projects.map((p) => (p.id === project.id ? { ...p, groupId: target } : p))
    : [{ id: project.id, groupId: target }, ...org.projects];
  return { org: { ...org, projects }, refused: null };
}

/** 右键「移到分组」里的一项。`blocked` 有值是放不进去:置灰,悬停说为什么 */
export interface MoveTarget {
  id: string | null;
  name: string;
  blocked?: string;
}

/**
 * 一个项目右键「移到分组」能列哪些。别的套的分组也列出来、置灰并说明(侧栏一旦同时有两套分组,
 * 用户会想把项目往那边放,得告诉他为什么不行,而不是悄悄不列)。当前所在的分组、归档的分组不列;已在某个分组里时多一项「移出分组」。
 */
export function moveTargetsFor(project: Pick<VibeProject, "realm" | "groupId">, groups: readonly VibeGroup[]): MoveTarget[] {
  const targets: MoveTarget[] = groups
    .filter((g) => !g.archived && g.id !== project.groupId)
    .map((g) => {
      const blocked = moveRefusal(project.realm, g.realm);
      return blocked ? { id: g.id, name: g.name, blocked } : { id: g.id, name: g.name };
    });
  if (project.groupId) targets.push({ id: null, name: "" });
  return targets;
}

/* ---------------- 项目 Agent:看得到哪些对话 ---------------- */

/** 云端历史列表里的一条(`src/ai/cloud/types.ts` 的 `CloudChatItem`,这里只认用得到的几项) */
export interface ChatItemLike {
  id: string;
  title: string;
  state: VibeChat["state"];
  visibility?: "shared" | "private";
  ownerAccountId?: string;
  creatorReadOnly?: boolean;
}

/**
 * 当前账号看得到的对话(`product/agent.md`「接入」):共有对话同项目有效成员都看得到;私有对话只有所属账号,
 * 例外是项目创建者能只读地看。服务端已经按这条过滤过,页面再复核一遍:**不能把别人的私有对话列出来**。
 * 没带归属的老条目(服务端没给 `ownerAccountId`)以服务端的过滤为准、照列。
 */
export function viewableChats(items: readonly ChatItemLike[], viewer: { accountId: string | null; creator: boolean }, projectId: string): VibeChat[] {
  const out: VibeChat[] = [];
  for (const it of items) {
    const visibility = it.visibility === "private" ? "private" : "shared";
    const owned = typeof it.ownerAccountId === "string" && it.ownerAccountId !== "";
    const mine = owned && viewer.accountId !== null && it.ownerAccountId === viewer.accountId;
    if (visibility === "private") {
      // 私有:没带归属的只在服务端说了是创建者只读时才列;带了归属的,是自己的或自己是创建者才列
      if (!owned && !it.creatorReadOnly && viewer.accountId === null) continue;
      if (owned && !mine && !viewer.creator) continue;
    }
    out.push({
      id: it.id,
      name: it.title || "云端对话",
      projectId,
      state: it.state,
      visibility,
      readOnly: visibility === "private" && (it.creatorReadOnly === true || (owned && !mine)),
    });
  }
  return out;
}

/** 把本机记的置顶、归档、顺序套到这个项目的对话上。服务端新出现的对话排前面(和项目同一个规矩) */
export function mergeChats(org: OrgState, projectId: string, chats: readonly VibeChat[]): VibeChat[] {
  const byId = new Map(chats.map((c) => [c.id, c]));
  const known = org.chats.filter((c) => c.projectId === projectId && byId.has(c.id));
  const knownIds = new Set(known.map((c) => c.id));
  const fresh = chats.filter((c) => !knownIds.has(c.id));
  return [
    ...fresh,
    ...known.map((o) => {
      const c: VibeChat = { ...byId.get(o.id)! };
      if (o.pinned) c.pinned = true;
      if (o.archived) c.archived = true;
      return c;
    }),
  ];
}
