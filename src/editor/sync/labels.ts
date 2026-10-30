/**
 * 撤销提示条、离线对话框、本地备份列表里「哪一处」「谁改的」的说法(c65-undo-draft.md 第 2 节)。
 *
 * - 实体按顶层计,前缀带类别:片段「开头空镜」、序列「主序列」、项目设置「帧率」;
 * - 身份:另一位成员(用户名)、Agent 的某个对话、某位成员的云端 Agent、你在另一个页面。
 *
 * 纯函数,不读 store:项目与「我是谁」都由调用方传进来。
 */
import { entityValuePath, getAt, parsePath } from "../../kernel/diffProject";
import { relocatePath } from "../../kernel/cutPaths";
import type { Project } from "../../kernel/project";
import { getCard } from "../../kernel/registry";
import type { Writer } from "../../store/docsync";
import { cloudAgentLabel } from "./hostedServices";

/** 集合名 → 类别 */
const KIND: Record<string, string> = {
  tracks: "序列",
  clips: "片段",
  transitions: "转场",
  cuts: "剪辑",
  media: "素材",
  cardNodes: "素材效果卡节点",
  cardDefinitions: "卡片定义",
  filters: "滤镜",
  pixelMaps: "像素映射",
  audioFx: "音频效果",
  captions: "字幕",
};

/** 项目顶层字段 → 名字 */
const META: Record<string, string> = {
  name: "名称",
  fps: "帧率",
  width: "宽度",
  height: "高度",
  duration: "时长",
  themeId: "主题",
  camera3dFov: "三维视角",
  glRoute: "渲染路线",
  creativity: "创造力等级",
  media: "素材",
  tracks: "序列",
  cuts: "剪辑",
};

const quoted = (s: string) => `「${s}」`;

/**
 * 片段怎么称呼:和时间轴上片段的标题一致(ClipView:卡片片段用卡片名,素材段用它的标签),
 * 同一张卡出现好几次时,后面带上开始时间好区分;都没有就用 id。
 */
function clipName(c: Record<string, unknown> | undefined, id: string): string {
  if (!c) return id;
  let name = "";
  if (typeof c.cardId === "string" && c.cardId) name = getCard(c.cardId)?.name ?? c.cardId;
  else if (typeof c.label === "string" && c.label.trim()) name = c.label.trim();
  if (!name) return id;
  return typeof c.start === "number" ? `${name} @${c.start.toFixed(1)}s` : name;
}

/** 实体 → 给人看的名字,例如 `片段「开头空镜」`、`序列「序列 1」`、`项目设置「帧率」` */
export function entityLabel(entity: string, project: Project | null): string {
  if (entity === "*") return "整个项目";
  if (entity.startsWith("/meta/")) {
    const key = entity.slice("/meta/".length).replace(/~1/g, "/").replace(/~0/g, "~");
    return `项目设置${quoted(META[key] ?? key)}`;
  }
  const segs = parsePath(entity);
  if (!segs || segs.length < 2) return entity;
  const coll = segs[segs.length - 2];
  const id = segs[segs.length - 1].replace(/^@/, "");
  const kind = KIND[coll] ?? "条目";
  // 序列在停放剪辑里时实体(不分住在哪)的路径要按序列 id 换到它现在住的地方才取得到值
  const valuePath = entityValuePath(entity);
  const value = project ? ((getAt(project, valuePath) ?? getAt(project, relocatePath(project, valuePath))) as Record<string, unknown> | undefined) : undefined;
  if (coll === "clips") return `片段${quoted(clipName(value, id))}`;
  const name = value && typeof value.name === "string" && value.name.trim() ? value.name.trim() : id;
  return `${kind}${quoted(name)}`;
}

/** 实体能不能点过去看:片段(选中并把播放头挪到开头)、序列、项目设置 */
export function clipOfEntity(entity: string): string | null {
  const m = /\/clips\/@([^/]+)$/.exec(entity);
  return m ? m[1].replace(/~1/g, "/").replace(/~0/g, "~") : null;
}

/** 本页面是谁:会话号,和连接的身份(本机空间是 `local`,共享项目是 `用户名@设备`) */
export interface Me {
  session: string;
  userId: string | null;
}

type Actor = { userId?: string; username?: string; deviceId?: string; deviceName?: string; role?: string; conversation?: number; session?: string; service?: string;
  /** 账号云端项目的写入身份带账号号(`server/docservice/modules/actor.mjs`);`userId` 是 `account:<账号号>@<设备号>`,不是给人看的 */
  accountId?: string };

/** 账号云端项目里显示名表的键:按账号查(同一个账号在哪台设备上都是同一个名字) */
export const accountNameKey = (accountId: string): string => `account:${accountId}`;

/** `用户名@设备` 里的用户名(写入身份里不带用户名,发起成员不在线时成员列表里也查不到) */
const usernameOf = (userId: string | undefined): string => {
  const s = userId ?? "";
  const at = s.lastIndexOf("@");
  return at > 0 ? s.slice(0, at) : s;
};

/** 共享项目里的显示名:成员列表给的 displayName(重名时带设备名),按 userId 查 */
export type DisplayNames = Map<string, string>;

/**
 * 写入身份 → 给人看的说法:`张三`、`Agent「第 2 个对话」`、`张三 · Agent · 第 2 个对话`、`张三的云端 Agent`、`你在另一个页面`。
 * 云端 Agent(`role: 'agent'` 且 `service: 'agent'`,契约 cloud-agent-contract.md 第 5 节)用的是发起成员的身份:
 * 别人看到「〈成员名〉的云端 Agent」,发起的那台设备上自己看到「你的云端 Agent」。
 */
export function writerLabel(by: Writer | undefined, me: Me, names: DisplayNames = new Map()): string {
  // 两种形状都认:`{ actor, session }`(DocSync 记的),和文档服务直接给的 actor 本身(`project.overwritten.by`)
  const raw = by as (Writer & Actor) | undefined;
  const actor = ((raw?.actor && typeof raw.actor === "object" ? raw.actor : raw && typeof raw.userId === "string" ? raw : {}) as Actor);
  const session = by?.session ?? actor.session;
  const sameUser = !!actor.userId && actor.userId === me.userId;
  if (!actor.userId && session === me.session) return "你在这个页面";
  if (actor.role === "agent" && actor.service === "agent") {
    if (sameUser) return "你的云端 Agent";
    // 账号云端项目:云端 Agent 的写入身份是 `account:<账号号>@run:<任务号>`,不带设备,按账号认人、按账号查名字
    if (typeof actor.accountId === "string") {
      if (me.userId?.startsWith(`${accountNameKey(actor.accountId)}@`)) return "你的云端 Agent";
      if (names.has(accountNameKey(actor.accountId))) return cloudAgentLabel(names.get(accountNameKey(actor.accountId))!);
    }
    return cloudAgentLabel(actor.username ?? usernameOf(actor.userId));
  }
  if (actor.role === "agent") {
    const n = typeof actor.conversation === "number" ? `第 ${actor.conversation} 个对话` : "某个对话";
    if (sameUser || !actor.username) return `Agent${quoted(n)}`;
    return `${names.get(actor.userId ?? "") ?? actor.username} · Agent · ${n}`;
  }
  if (session === me.session && (sameUser || !actor.userId)) return "你在这个页面";
  if (sameUser) return "你在另一个页面";
  if (actor.userId && names.has(actor.userId)) return names.get(actor.userId)!;
  // 账号云端项目:成员名单按账号给名字(`syncManager.ts` 的 `displayNames`)
  if (typeof actor.accountId === "string" && names.has(accountNameKey(actor.accountId))) return names.get(accountNameKey(actor.accountId))!;
  return actor.username ?? actor.userId ?? "别人";
}

/**
 * 改密码或重设密码之后选了「退出」，文档服务撤回了旧设备在那段时间里做的修改：此刻在线的成员收到的那条气泡
 * （`product/document-service.md`「保存与延迟退出的修改处理」，2026-10-22 用户定）。〈用户名〉是改密码的那个账号；名字取不到时退回「有成员」。
 */
export function rolledBackText(name: unknown): string {
  return typeof name === "string" && name.trim() ? `${name.trim()}撤回了内容` : "有成员撤回了内容";
}

/** 项目历史序号（修改计数）给人看的文字：历史序号 N */
export function historySeqLabel(rev: number | null | undefined): string {
  if (rev === null || rev === undefined || !Number.isFinite(rev)) return "历史序号 -";
  return `历史序号 ${rev}`;
}

