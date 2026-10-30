/**
 * 手机版 Agent 分页的视图模型(语义 `workflow/editing.md`「手机版界面」;交互以 `prototypes/mobile-ui-demo/` 的 Agent 页为准)。
 *
 * 纯函数,不碰 React、不碰 store,好让 node 直接跑测试(`agentView.test.mjs`):
 *   - 引用:输入框上方的「引用标记条」里放的是引用项(`QuoteRef`);发送时把它们按桌面「引用到 AI」同一个写法
 *     `@卡片 名字(片段 id)` 放在正文前面(Agent 认的就是这个写法),消息气泡上再把开头的这几串认出来,画成标记;
 *   - 一轮回复(`ChatMessage`)拆成:对用户说的话(气泡)、操作卡片里的条目(每次工具调用一条)、本轮 / 阶段小结。
 */
import type { ChatMessage, MessagePart, ToolCallInfo } from "../ai/types.ts";
import { isReportTool, parseProgressReport, type ProgressReport } from "../ai/progressReport.ts";
import { isUserMessageCall, sayingsOf, type Saying } from "../ai/userMessages.ts";
import { KIND_LABEL, bareToolName, toolKind } from "../editor/right/chat/iconRuns.ts";

/* ---------------- 引用 ---------------- */

export interface QuoteRef {
  /** 被引用的片段 id(转场则是转场 id;叠加卡是「片段 id#种类:定义 id」) */
  id: string;
  /** 给人看的名字 */
  label: string;
  /**
   * 引的是哪一级。缺省「卡片」= 整段,和以前一字不差;
   * 引单张叠加卡时写「叠加卡」—— 一段上挂两张同名的压暗很常见,不指明哪一张 Agent 只能反问。
   */
  kind?: string;
}

/** 一条引用在正文里的写法:同桌面 AI 栏「引用到 AI」插进输入框的那串 */
export function quoteToken(q: QuoteRef): string {
  return `@${q.kind || "卡片"} ${q.label}(${q.id})`;
}

/** 发送时的正文:引用在前、空格隔开,再接用户写的话 */
export function withQuotes(text: string, quotes: readonly QuoteRef[]): string {
  const body = text.trim();
  if (!quotes.length) return body;
  return `${quotes.map(quoteToken).join(" ")} ${body}`;
}

const QUOTE_RE = /^@卡片 (.+?)\(([^()\s]+)\)(?:[ \t]+|$)/;

/** 把一条用户消息开头的引用串认出来(桌面发的、手机发的写法一样);余下的是用户写的话 */
export function splitQuotes(text: string): { quotes: QuoteRef[]; rest: string } {
  let rest = text.replace(/^\s+/, "");
  const quotes: QuoteRef[] = [];
  for (;;) {
    const m = QUOTE_RE.exec(rest);
    if (!m) break;
    quotes.push({ label: m[1], id: m[2] });
    rest = rest.slice(m[0].length);
  }
  return { quotes, rest };
}

/** 往引用条里加一项:同一个 id 不重复放(重复点「引用」只是再确认一下) */
export function addQuote(list: readonly QuoteRef[], q: QuoteRef): QuoteRef[] {
  return list.some((x) => x.id === q.id) ? [...list] : [...list, q];
}

/* ---------------- 一轮回复 ---------------- */

/** 取一条消息的有序片段(同桌面 AgentBubble 的 partsOf:旧历史没有 parts 时按「文字 → 状态 → 工具」兜底) */
export function partsOf(m: ChatMessage): MessagePart[] {
  if (m.parts && m.parts.length > 0) return m.parts;
  const legacy: MessagePart[] = [];
  if (m.text) legacy.push({ kind: "text", text: m.text });
  for (const s of m.statuses || []) legacy.push({ kind: "status", text: s });
  for (const t of m.tools || []) legacy.push({ kind: "tool", ...t });
  return legacy;
}

/** 操作卡片里一条的状态:做完 / 在做 / 还没做(这一轮收了尾也没出结果的) / 失败 */
export type OpState = "done" | "run" | "todo" | "err";

export interface OpItem {
  key: string;
  state: OpState;
  /** 动作类别的中文(新增、修改、读取……) */
  kind: string;
  /** 工具名(去掉服务器前缀) */
  name: string;
}

/** 小结里的一行:已完成 / 待办 / 问题 */
export interface ReportRow {
  state: "done" | "todo" | "ask";
  text: string;
}

export interface ReportView {
  title: string;
  rows: ReportRow[];
}

export interface RoundView {
  /** 这是第几轮(对话里第几条助手回复,从 1 数) */
  ordinal: number;
  /** 第一次操作之前说的话 */
  before: Saying[];
  /** 第一次操作之后说的话 */
  after: Saying[];
  items: OpItem[];
  reports: ReportView[];
  /** 操作卡片标题:「第 1 轮 · 5 项操作」 */
  title: string;
  /** 有没有操作卡片可画 */
  hasCard: boolean;
}

const reportTitle = (r: ProgressReport): string => (r.final ? "本轮小结" : r.stage ? `阶段 · ${r.stage}` : "阶段小结");

function reportView(r: ProgressReport): ReportView {
  const rows: ReportRow[] = [
    ...r.done.map((text) => ({ state: "done" as const, text })),
    ...r.todo.map((text) => ({ state: "todo" as const, text })),
    ...r.problems.map((text) => ({ state: "ask" as const, text })),
  ];
  return { title: reportTitle(r), rows };
}

/** 话在这一轮片段里的位置(`Saying.key` 是 `s<片段下标>` 或 `t<片段下标>`) */
function sayingIndex(s: Saying): number {
  const n = Number(s.key.slice(1));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 把一轮回复拆开。顺序按演示稿的对话页:先是动手之前说的话,然后是这一轮的操作卡片,再是动手之后说的话。
 * 操作条目不含对用户说话的 `send_message` 和 `report_progress`(后者变成小结)。
 */
export function roundView(m: ChatMessage, ordinal: number): RoundView {
  const parts = partsOf(m);
  const items: OpItem[] = [];
  const reports: ReportView[] = [];
  let firstOp = -1;
  parts.forEach((p, i) => {
    if (p.kind !== "tool") return;
    if (isUserMessageCall(p.name, p.input)) return;
    if (isReportTool(p.name)) {
      const r = parseProgressReport(p.input);
      if (r) reports.push(reportView(r));
      return;
    }
    if (firstOp < 0) firstOp = i;
    const t: ToolCallInfo = p;
    const state: OpState = t.ok === true ? "done" : t.ok === false ? "err" : m.pending ? "run" : "todo";
    items.push({ key: `${m.id}:${i}`, state, kind: KIND_LABEL[toolKind(t.name)], name: bareToolName(t.name) });
  });
  const sayings = sayingsOf(m);
  const split = firstOp < 0 ? Infinity : firstOp;
  const before = sayings.filter((s) => sayingIndex(s) < split);
  const after = sayings.filter((s) => sayingIndex(s) >= split);
  return {
    ordinal,
    before,
    after,
    items,
    reports,
    title: `第 ${ordinal} 轮 · ${items.length} 项操作`,
    hasCard: items.length > 0 || reports.length > 0,
  };
}

/** 对话里每条助手回复是第几轮 */
export function ordinals(messages: readonly ChatMessage[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const m of messages) if (m.role === "assistant") out.set(m.id, ++n);
  return out;
}

/** 这条用户消息要不要画气泡:其他 Agent 递来的(`inbound`)不画,同桌面 */
export function isUserBubble(m: ChatMessage): boolean {
  return m.role === "user" && !(m.inbound && m.inbound.length > 0);
}
