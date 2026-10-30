/**
 * Vibe 模式开始页里三种东西的形状:分组、项目、项目 Agent(云端对话)。
 *
 * 数据来源(2026-10-23 接业务层,`docs/reports/AGENT-claude-vibe-wire.md`):
 * - **项目**:云端文档服务的项目列表(`src/account/useAccountProjects.ts` 的 `lists`:我创建的 / 我加入的);
 *   游客没有这张表,他自己那一个项目记在本机(`src/account/guest.ts`)。名字、归属以服务端为准;
 *   画幅、时长、缩略图是这台浏览器打开过这个项目时记下的(`thumbCache.ts`),没打开过就没有,界面退回色块。
 * - **项目 Agent**:此刻连着的那个项目里、当前账号看得到的云端 Agent 对话(`src/ai/cloud/useCloud.ts` 的历史列表,
 *   服务端按 `product/agent.md` 的共有 / 私有规则过滤,页面再按同一条规则复核一遍,见 `vibeOrg.ts` 的 `viewableChats`)。
 * - **分组**(用户 2026-10-23 定:分本地分组和云端分组,互相放不进):本地分组装本机草稿项目、存本机;
 *   云端分组装云端项目、存云端。两套各管各的项目,这里用 `OrgRealm` 标出一个东西属于哪一套(`vibeOrg.ts`)。
 *
 * 置顶、归档、手排的顺序跟着分组走:本地项目记在本机,云端项目记在云端那一份。
 */

/** 分组、项目属于哪一套:本地(桌面版,本机草稿项目)或云端(云端文档服务的项目)。两套互不混放 */
export type OrgRealm = "local" | "cloud";

/** 三种东西都能右键、能拖着排序,所以都带这两个标记(规则在 `treeState.ts`:只在自己同级里生效) */
export interface TreeFlags {
  pinned?: boolean;
  archived?: boolean;
}

export interface VibeGroup extends TreeFlags {
  id: string;
  name: string;
  /** 这个分组属于哪一套;只能装同一套的项目 */
  realm: OrgRealm;
}

export type Ratio = "16:9" | "9:16" | "1:1";

export interface VibeProject extends TreeFlags {
  id: string;
  name: string;
  /** 项目属于哪一套:本机草稿是 local,云端项目是 cloud。只能放进同一套的分组 */
  realm: OrgRealm;
  /** 所属分组(同一套里的分组);null 是没放进分组的 */
  groupId: string | null;
  /** 我创建的 / 我加入的 / 游客自己的那一个 */
  role: "owned" | "joined" | "guest";
  /** 这台浏览器上次打开它时记下的;没打开过是 null */
  ratio: Ratio | null;
  duration: number | null;
  /** 缩略图(data URL,小 JPEG);取不到是 null,界面退回色块 */
  thumb: string | null;
  /** 上次在这台浏览器里打开的时刻(ISO);没打开过是 null */
  seenAt: string | null;
}

/** 项目 Agent:一个云端 Agent 对话。只挂在项目上(「分组 Agent」语义里没有,这一版不做) */
export interface VibeChat extends TreeFlags {
  id: string;
  name: string;
  projectId: string;
  /** 进行中 / 已中断 / 出错 / 已失效 / 空闲 */
  state: "idle" | "running" | "interrupted" | "failed" | "revoked";
  visibility: "shared" | "private";
  /** 项目创建者在看别人的私有对话:只读 */
  readOnly: boolean;
  /** 还没发过消息的新对话(只在本页上有,服务端还没有这一条) */
  fresh?: boolean;
}
