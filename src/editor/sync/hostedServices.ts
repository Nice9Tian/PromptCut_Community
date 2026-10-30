/**
 * 托管方服务（云节点上托管方自带的服务）在界面里的纯逻辑（契约 `docs/plan/hosted-render-contract.md` 第 1.7、3 节）。
 *
 * - 成员列表顶层 `hosted: { render: { available, enabled }, agent: { available, enabled } }`：放本机的项目与没有登记表的
 *   托管端没有这个字段（解析出来是 null）；`enabled` 是本项目对这个服务的开关，记录里没有算开。
 * - 成员列表里 `service` 字段非空的行是托管方的服务：按服务名显示，不看用户名；不是成员、不计入成员数、没有踢人按钮。
 * - 项目设置里每种服务一行勾选，**按服务名渲染**：现在只有 `render`，第四段（云端 Agent）往 `HOSTED_SERVICE_ROWS` 与
 *   `HOSTED_SERVICE_TEXT` 各加一项就多一行。
 *
 * - 渲染节点那一行下面缩进多一行子选项「生成轨道流」（契约 `hosted-render-contract.md` 第 3.1 节）：成员列表里 `hosted.render.streams`
 *   （布尔，文档服务报了才出现；旧托管端不报，这一行就不显示），记录里没有算关（2026-10-12 用户定：在线浏览器暂停时不靠渲染节点也能看任意一帧，云端缺省不产轨道流，省服务器资源）；渲染节点那一行关着时置灰、不可点。
 *   子选项按「服务名 + 选项名」渲染，文案在 `HOSTED_OPTION_TEXT`。
 *
 * - 代成员进项目的服务连接（云端 Agent）不另起一行：归在那位成员的行里，`conns` 里那一项带 `service: 'agent'`，界面在这位成员下
 *   显示「〈成员名〉的云端 Agent」（`cloudAgentConns`、`cloudAgentLabel`；契约 `docs/plan/cloud-agent-contract.md` 第 5 节）。
 *   项目设置里 `agent` 一行就是「云端 Agent」开关。
 *
 * 不引 React、不引同步管理的运行时（只用类型），单测直接 import。
 */
import type { AdminError, MemberRow } from "./syncManager";

export type HostedServiceName = "render" | "agent";

export interface HostedServiceState {
  available: boolean;
  enabled: boolean;
  /** 渲染节点的子选项「生成轨道流」：文档服务报了才有（旧托管端没有）；缺省关由文档服务算好再报（记录里没有这一项算关，只有显式为 true 才算开） */
  streams?: boolean;
  /** 账号是否有权限开启「生成轨道流」（在权限组或管理员） */
  streamsAllowed?: boolean;
}

/** 服务下面的子选项名；现在只有渲染节点的 `streams` */
export type HostedOptionName = "streams";

/** 项目设置里出现哪几个子选项、按什么顺序（每项挂在自己的服务那一行下面） */
export const HOSTED_OPTION_ROWS: readonly { service: HostedServiceName; option: HostedOptionName }[] = [{ service: "render", option: "streams" }];

export type HostedView = Partial<Record<HostedServiceName, HostedServiceState>>;

/** 项目设置里出现哪几行、按什么顺序 */
export const HOSTED_SERVICE_ROWS: readonly HostedServiceName[] = ["render", "agent"];

export interface HostedServiceText {
  label: string;
  /** 勾选行下面的一行说明 */
  hint: (enabled: boolean) => string;
  /** 别的成员收到「创建者改了开关」时的提示；空串表示这个方向不提示（两个开关同一个规矩：只在关闭时提示，打开时不提示，〔用户 2026-10-07 定〕） */
  changed: (enabled: boolean) => string;
  /** 创建者确认弹窗里的一句话(`enabled` 是要改成的状态) */
  confirm: (enabled: boolean) => string;
}

/** 每种服务在界面上的文案。加服务时在这里加一项、再把名字加进 `HOSTED_SERVICE_ROWS` */
export const HOSTED_SERVICE_TEXT: Partial<Record<HostedServiceName, HostedServiceText>> = {
  render: {
    label: "托管方的渲染节点",
    hint: (enabled) => (enabled ? "云节点上托管方的渲染节点为这个项目做预渲染，创建者可以关掉。" : "已关闭：托管方的渲染节点不再为这个项目做预渲染，已经渲好的结果保留。"),
    // 与云端 Agent 同一个规矩：只在关闭时给别的成员气泡，打开时不提示〔用户 2026-10-07 定〕
    changed: (enabled) => (enabled ? "" : "创建者关闭了托管方的渲染节点，它不再为这个项目做预渲染。"),
    confirm: (enabled) => (enabled ? "打开后，托管方的渲染节点会为这个项目做预渲染。" : "关闭后，托管方的渲染节点不再为这个项目做预渲染，已经渲好的结果保留。"),
  },
  agent: {
    label: "云端 Agent",
    hint: (enabled) => (enabled ? "成员可以在 AI 栏里选「云端」，让云节点上的 Agent 代自己改项目，关掉软件也会继续。创建者可以关掉。" : "已关闭：成员不能再用云端 Agent，进行中的云端对话已被停下；已经落地的改动保留。"),
    // 只有关闭时给别的成员一条气泡，打开时不提示（空串就不弹）〔用户 2026-10-07 定〕
    changed: (enabled) => (enabled ? "" : "创建者关闭了云端 Agent，进行中的云端对话已被停下。"),
    confirm: (enabled) => (enabled ? "打开后，成员可以在 AI 栏里选「云端」，让云节点上的 Agent 代自己改项目。" : "关闭后，成员不能再用云端 Agent，进行中的云端对话会被立刻停下；已经落地的改动保留。"),
  },
};

export interface HostedOptionText {
  label: string;
  /** 勾选行下面的一行说明 */
  hint: (enabled: boolean) => string;
  /** 别的成员收到「创建者改了这个选项」时的提示；空串表示这个方向不提示（与服务开关同一个规矩：只在关闭时提示） */
  changed: (enabled: boolean) => string;
  /** 创建者确认弹窗里的一句话(`enabled` 是要改成的状态) */
  confirm: (enabled: boolean) => string;
}

/** 每个子选项在界面上的文案（先照任务书，用户看过截图再定）。键是 `<服务名>.<选项名>` */
export const HOSTED_OPTION_TEXT: Record<string, HostedOptionText> = {
  "render.streams": {
    label: "生成轨道流",
    hint: (enabled) => (enabled ? "托管方的渲染节点为这个项目生成轨道流，重卡在在线浏览器里播放更流畅。" : "没有打开：托管方的渲染节点不为这个项目生成轨道流，播放时用成员们各自设备生成的轨道流。打开后托管方也会生成，重卡在在线浏览器里播放更流畅，会多用云端的渲染时间。"),
    changed: (enabled) => (enabled ? "" : "创建者关闭了轨道流，托管方的渲染节点不再为这个项目生成轨道流。"),
    confirm: (enabled) => (enabled ? "打开后，托管方的渲染节点会为这个项目生成轨道流。" : "关闭后，托管方的渲染节点不再为这个项目生成轨道流，已经生成的保留。"),
  },
};

export const hostedOptionText = (service: unknown, option: unknown): HostedOptionText | null =>
  (typeof service === "string" && typeof option === "string" && HOSTED_OPTION_TEXT[`${service}.${option}`]) || null;

const isServiceName = (v: unknown): v is HostedServiceName => v === "render" || v === "agent";

/** 成员列表消息顶层的 `hosted` → 界面状态；没有或形状不对回 null（放本机的项目、旧托管端） */
export function parseHosted(raw: unknown): HostedView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: HostedView = {};
  for (const name of ["render", "agent"] as const) {
    const s = (raw as Record<string, unknown>)[name];
    if (!s || typeof s !== "object") continue;
    const { available, enabled, streams, streamsAllowed } = s as Record<string, unknown>;
    if (typeof available !== "boolean" || typeof enabled !== "boolean") continue;
    out[name] = { available, enabled };
    // 子选项：形状对才收（布尔）；旧托管端不报，就没有这个字段，对应的行不显示
    if (name === "render" && typeof streams === "boolean") out[name]!.streams = streams;
    if (name === "render" && typeof streamsAllowed === "boolean") out[name]!.streamsAllowed = streamsAllowed;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 账号项目改托管方服务开关(或「生成轨道流」)失败 → 错误种类 + 能直接给人看的原因。
 * 账号客户端抛的 `AccountFailure` 带 `status`、`code` 与按 `code` 翻好的一句话(`accountErrorText`,例如不在权限分组时
 * 「你的账号没有开启这一项的权限，请联系托管方。」),照它说;不再套口令项目的「密码错误。」(2026-10-20 在线实测:403 被说成别的或什么都没说)
 */
export function accountHostedFailure(error: unknown): { ok: false; error: AdminError; message: string } {
  const e = (error && typeof error === "object" ? error : {}) as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof e.status === "number" ? e.status : NaN;
  const kind: AdminError = status === 403 ? "forbidden" : status === 400 ? "bad-message" : status === 0 || e.code === "network" ? "offline" : "other";
  const known = typeof e.code === "string" && typeof e.message === "string" && e.message !== "" && e.message !== e.code;
  const message = known ? (e.message as string) : kind === "offline" ? "没连上云端服务，稍后再试。" : "没做成，稍后再试。";
  return { ok: false, error: kind, message };
}

/** 改托管方服务开关失败时对话框里的一句话:带了原因(账号项目)就照它说,否则照旧按错误种类说(口令项目,`fallback` 是那边的文案) */
export function hostedFailText(r: { error: string; message?: string }, unavailable: string, fallback: (error: string) => string): string {
  if (r.message) return r.message;
  return r.error === "bad-message" ? unavailable : fallback(r.error);
}

/** `hosted-service-changed` 通知落到状态上：服务不认识或这个项目没有这项服务就原样返回 */
export function applyHostedChange(hosted: HostedView | null, service: unknown, enabled: unknown): HostedView | null {
  if (!isServiceName(service) || typeof enabled !== "boolean") return hosted;
  const prev = hosted?.[service];
  if (!prev) return hosted;
  return { ...hosted, [service]: { ...prev, enabled } };
}

/** `hosted-option-changed` 通知落到状态上：服务或选项不认识、这个项目没有报这个选项（旧托管端）就原样返回 */
export function applyHostedOptionChange(hosted: HostedView | null, service: unknown, option: unknown, enabled: unknown): HostedView | null {
  if (service !== "render" || option !== "streams" || typeof enabled !== "boolean") return hosted;
  const prev = hosted?.render;
  if (!prev || typeof prev.streams !== "boolean") return hosted;
  return { ...hosted, render: { ...prev, streams: enabled } };
}

/**
 * 账号项目用:前后两次读到的托管方服务状态里,哪些变化要给别的成员一条提示(与口令项目的通知同一个规矩、同一处文案:
 * 只在关闭时提示,打开时不提示)。回要弹的句子;没有变化、变成打开、前一次没有这一项,都不弹。
 */
export function hostedChangeNotices(prev: HostedView | null, next: HostedView | null): string[] {
  const out: string[] = [];
  const a = prev?.render, b = next?.render;
  if (a && b) {
    if (a.enabled && !b.enabled) { const text = HOSTED_SERVICE_TEXT.render?.changed(false); if (text) out.push(text); }
    if (a.streams === true && b.streams === false) { const text = hostedOptionText("render", "streams")?.changed(false); if (text) out.push(text); }
  }
  return out;
}

/**
 * 本页此刻看到这个项目的「生成轨道流」是不是在起作用:项目放云端、托管方有渲染节点、渲染节点开着、这一项开着。
 * 在线页面据此在这一项从关变开时重发清单计划(`src/online/planPublisher.ts` 的 `streamsOn`)。旧文档服务不报这一项:一直是 false。
 */
export function hostedStreamsOn(where: "lan" | "hosted" | null | undefined, hosted: HostedView | null): boolean {
  const r = hosted?.render;
  return where === "hosted" && !!r && r.available === true && r.enabled === true && r.streams === true;
}

/**
 * 托管方服务的勾选要不要先验证创建者密码:口令项目要(创建者操作凭密码的证明);账号项目没有创建者密码,
 * 凭账号的登录态,由服务端按创建者身份把关,直接到确认那一步。
 */
export const hostedFlowNeedsPassword = (account: boolean): boolean => !account;

export interface HostedRow {
  service: HostedServiceName;
  label: string;
  enabled: boolean;
}

/**
 * 项目设置里要显示哪几行：项目放云端、且这台托管端的登记表里有这个服务（`available`）才出现。
 * 放本机的项目、没有登记表的托管端、`available` 为假，都没有这一项。
 */
export function hostedRowsOf(where: "lan" | "hosted" | null | undefined, hosted: HostedView | null): HostedRow[] {
  if (where !== "hosted" || !hosted) return [];
  const rows: HostedRow[] = [];
  for (const service of HOSTED_SERVICE_ROWS) {
    const s = hosted[service];
    const text = HOSTED_SERVICE_TEXT[service];
    if (s?.available && text) rows.push({ service, label: text.label, enabled: s.enabled });
  }
  return rows;
}

export interface HostedOptionRow {
  service: HostedServiceName;
  option: HostedOptionName;
  label: string;
  enabled: boolean;
  /** 它挂着的服务那一行关着：这一行置灰、不可点 */
  parentOff: boolean;
  /** 账号没有开启此项的权限：置灰、不可点 */
  notAllowed?: boolean;
}

/**
 * 项目设置里要显示哪几个子选项：项目放云端、这台托管端有这个服务（`available`）、文档服务报了这个选项（旧托管端不报）才出现。
 * 服务那一行关着时仍然出现，`parentOff` 为真，界面置灰。
 */
export function hostedOptionRowsOf(where: "lan" | "hosted" | null | undefined, hosted: HostedView | null): HostedOptionRow[] {
  if (where !== "hosted" || !hosted) return [];
  const rows: HostedOptionRow[] = [];
  for (const { service, option } of HOSTED_OPTION_ROWS) {
    const s = hosted[service];
    const text = hostedOptionText(service, option);
    const value = s?.[option];
    if (s?.available && text && typeof value === "boolean") {
      const notAllowed = option === "streams" && s.streamsAllowed === false;
      rows.push({ service, option, label: text.label, enabled: value, parentOff: !s.enabled, ...(notAllowed ? { notAllowed: true } : {}) });
    }
  }
  return rows;
}

/** 这位成员名下代他进项目的云端 Agent 连接(成员列表行的 `conns` 里带 `service: 'agent'` 的那几项) */
export function cloudAgentConns<T extends { role: string; service?: string }>(conns: readonly T[]): T[] {
  return conns.filter((c) => c.service === "agent");
}

/** 云端 Agent 的署名:「〈成员名〉的云端 Agent」(操作记录、覆盖提示、成员列表都用这一处) */
export const cloudAgentLabel = (name: string): string => `${name}的云端 Agent`;

/** 成员列表的这一行是不是托管方的服务 */
export const isServiceRow = (row: Pick<MemberRow, "service">): boolean => typeof row.service === "string" && row.service !== "";

/** 服务行显示的名字：按服务名，不看用户名；不认识的服务名给一个通用名 */
export function serviceRowLabel(service: string | undefined): string {
  return (isServiceName(service) && HOSTED_SERVICE_TEXT[service]?.label) || "托管方的服务";
}

/** 成员列表拆成两段：成员（在前，计入成员数）、托管方的服务（在后，不计数、没有踢人按钮） */
export function splitMembers<T extends Pick<MemberRow, "service">>(rows: readonly T[]): { people: T[]; services: T[] } {
  const people: T[] = [];
  const services: T[] = [];
  for (const r of rows) (isServiceRow(r) ? services : people).push(r);
  return { people, services };
}

/* ---------------------------------------------------------------------------------------------
 * 成员列表的计数口径〔用户 2026-10-07 定;同日改:云端 Agent 按「此刻有没有一轮在跑」算,不按「连没连着」〕：「成员：N 人 · Agent：M 个」
 *
 * 云端 Agent 的连接在一轮结束后还会连着(闲置 10 分钟才回收),连没连着说不清它在不在干活。Agent 服务在有一轮在跑时经在场状态挂一项
 * `cloud-run`(`presence.ts` 的 `cloudRunning()`:成员键 `用户名@设备号` 的集合,与成员行的 `${username}@${deviceId}` 同一写法),下面的函数都带这张表:
 *
 * - 人数只算真人在线的：这一行有任何一条不是「云端 Agent」的连接（页面、本机 Agent、渲染进程都说明他的设备在线）才算；
 * - Agent 数 = 本机 Agent（每个对话一条连接）加有一轮在跑的云端 Agent（每位成员最多一个，实例里有多条连接也只算一个）；闲置的云端 Agent 连接不计；
 * - 成员本人不在线、他的云端 Agent 有一轮在跑：这一行照常显示并标「离线，Agent 在跑」，不计入人数、计入 Agent 数；
 * - 成员本人不在线、只剩闲置的云端 Agent 连接：这一行不显示（不标、不计入任何一个数）；
 * - 成员本人在线、云端 Agent 闲置：行里不显示「[云端 Agent]」标记；有一轮在跑才显示；
 * - 托管方的服务行（渲染节点）不进任何一个数（`splitMembers` 已把它们分开）。
 * ------------------------------------------------------------------------------------------- */

type CountRow = Pick<MemberRow, "conns" | "username" | "deviceId">;

/** 此刻云端 Agent 有一轮在跑的成员键(`用户名@设备号`) */
export type CloudRunning = ReadonlySet<string>;

/** 成员行在「有一轮在跑」表里的键:与在场状态里来源身份的 `userId` 是同一种写法(`用户名@设备号`) */
export const memberKeyOf = (row: Pick<MemberRow, "username" | "deviceId">): string => `${row.username}@${row.deviceId}`;

/** 这一行的成员此刻是不是真人在线 */
export function isPersonOnline(row: Pick<MemberRow, "conns">): boolean {
  return row.conns.some((c) => c.service !== "agent");
}

/** 这位成员的云端 Agent 此刻有一轮在跑(连着,且在「有一轮在跑」表里) */
export function isCloudAgentRunning(row: CountRow, running: CloudRunning): boolean {
  return cloudAgentConns(row.conns).length > 0 && running.has(memberKeyOf(row));
}

/** 这位成员本人不在线、他的云端 Agent 有一轮在跑:标「离线，Agent 在跑」 */
export function isCloudAgentOnly(row: CountRow, running: CloudRunning): boolean {
  return !isPersonOnline(row) && isCloudAgentRunning(row, running);
}

/** 这位成员本人不在线、只剩闲置的云端 Agent 连接:这一行不显示 */
export function isIdleCloudAgentOnly(row: CountRow, running: CloudRunning): boolean {
  return !isPersonOnline(row) && cloudAgentConns(row.conns).length > 0 && !isCloudAgentRunning(row, running);
}

/** 成员列表里要显示的行(去掉只剩闲置云端 Agent 连接的)。`people` 是 `splitMembers` 分出来的成员行 */
export function visibleMembers<T extends CountRow>(people: readonly T[], running: CloudRunning): T[] {
  return people.filter((r) => !isIdleCloudAgentOnly(r, running));
}

/** 本机 Agent 的数量(这一行里 `role: 'agent'` 且不是云端 Agent 的连接) */
export function localAgentCount(row: Pick<MemberRow, "conns">): number {
  return row.conns.filter((c) => c.role === "agent" && c.service !== "agent").length;
}

/** 顶栏成员数与 Agent 数。`people` 是 `splitMembers` 分出来的成员行 */
export function memberCounts(people: readonly CountRow[], running: CloudRunning): { people: number; agents: number } {
  let online = 0;
  let agents = 0;
  for (const r of visibleMembers(people, running)) {
    if (isPersonOnline(r)) online++;
    agents += localAgentCount(r) + (isCloudAgentRunning(r, running) ? 1 : 0);
  }
  return { people: online, agents };
}

/** 顶栏按钮上的字。自己总是在线的，所以人数至少 1 */
export function memberCountLabel(people: readonly CountRow[], running: CloudRunning): string {
  const c = memberCounts(people, running);
  return `成员：${Math.max(1, c.people)} 人 · Agent：${c.agents} 个`;
}

/* ---------------------------------------------------------------------------------------------
 * 账号云端项目的成员列表(`AccountMembersPanel`、手机版 `useMembers`)用同一口径〔语义 `product/agent.md`「成员列表怎么数」〕。
 *
 * 成员名单(`members`)按账号一行;在线连接(`devices`)按「账号 + 设备」给,云端 Agent 的任务连接没有设备,
 * 文档服务按任务号归成 `run:<任务号>` 一项、记在发起成员的账号下(`server/account/project-members.mjs`)。
 * 账号项目的任务连接只在一轮在跑时连着(一轮结束就关),所以「连着」就是「有一轮在跑」,不另看在场状态里的 `cloud-run`。
 *
 * - 人数:有页面连接(`role: 'page'`)的账号;
 * - Agent 数:本机 Agent 连接(`role: 'agent'` 且不是云端 Agent)逐条算,云端 Agent 每位成员最多算一个;
 * - 本人没有页面连接、云端 Agent 连着:「离线，Agent 在跑」,不计入人数、计入 Agent 数。
 * ------------------------------------------------------------------------------------------- */

interface AccountConnLike { role: string; service?: string; conversation?: string | number }
interface AccountDeviceLike { accountId: string; conns: readonly AccountConnLike[] }

export interface AccountMemberState {
  /** 本人在线(有页面连接) */
  online: boolean;
  /** 他的云端 Agent 此刻有一轮在跑 */
  cloudRunning: boolean;
  /** 本人不在线、云端 Agent 在跑:标「离线，Agent 在跑」 */
  offlineAgent: boolean;
  /** 他名下的本机 Agent 连接 */
  localAgents: AccountConnLike[];
}

/** 一位账号成员此刻的在线与 Agent 状态 */
export function accountMemberState(accountId: string, devices: readonly AccountDeviceLike[]): AccountMemberState {
  const conns = devices.filter((d) => d.accountId === accountId).flatMap((d) => d.conns);
  const online = conns.some((c) => c.role === "page");
  const cloudRunning = conns.some((c) => c.role === "agent" && c.service === "agent");
  return { online, cloudRunning, offlineAgent: !online && cloudRunning, localAgents: conns.filter((c) => c.role === "agent" && c.service !== "agent") };
}

/** 账号项目的「成员：N 人 · Agent：M 个」的两个数。只数名单里的账号(被踢的、不在名单里的连接文档服务已滤掉) */
export function accountMemberCounts(snapshot: { members: readonly { accountId: string }[]; devices: readonly AccountDeviceLike[] }): { people: number; agents: number } {
  let people = 0;
  let agents = 0;
  for (const m of snapshot.members) {
    const s = accountMemberState(m.accountId, snapshot.devices);
    if (s.online) people++;
    agents += s.localAgents.length + (s.cloudRunning ? 1 : 0);
  }
  return { people, agents };
}

/** 账号项目顶栏按钮上的字 */
export function accountMemberCountLabel(snapshot: Parameters<typeof accountMemberCounts>[0]): string {
  const c = accountMemberCounts(snapshot);
  return `成员：${c.people} 人 · Agent：${c.agents} 个`;
}
