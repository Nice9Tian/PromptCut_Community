import type { AgentTab } from "../../../ai/agentTabs";

/**
 * rail 上 AI 类项(剧本、Agent 分页)的画法小件:剧本图标、Agent 头像里的字、标签截断、悬停说明。
 *
 * rail 本身已经左右共用、可以拖动,在 editor/dock/RailBar.tsx;原来这里的 RightRail 组件和 `pc.right.page`(剧本 / 助手)
 * 并进了 dock 的布局 store(editor/dock/railStore.ts,`pc.rail.layout.v1`)—— 剧本、每个 Agent 都是 rail 上独立的一项。
 */

/** rail 上「剧本」的图标:一页写了几行字的文稿 */
export function IconScript() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
      <path d="M9 11h7M9 14.5h7M9 18h4" />
    </svg>
  );
}

/** 头像里的字:默认名「Agent N」取编号,声明过范围的取标题首字 */
export function glyphOf(t: AgentTab, index: number): string {
  const num = /^Agent\s+(\d+)$/.exec(t.title.trim());
  if (num) return num[1];
  return [...t.title.trim()][0] ?? String(index + 1);
}

/**
 * rail 标签最多 4 个字宽:全角字算 1,半角字算 0.5。
 * 按字符数截的话「Agent 1」会被切成「Agen…」,而它其实比「剪辑导演」还窄。
 */
export function shortLabel(title: string): string {
  let units = 0;
  let out = "";
  for (const ch of title) {
    const w = ch.charCodeAt(0) <= 0xff ? 0.5 : 1;
    if (units + w > 4) return out + "…";
    units += w;
    out += ch;
  }
  return out;
}

/** 悬停说明:完整标题 + 范围 + 对话 ID(给模型看的 Agent ID,send_message 的收件人就写它) */
export function tabTooltip(t: AgentTab): string {
  const lines = [t.title];
  if (t.scope) lines.push(`范围:${t.scope}`);
  lines.push(t.conversationId ? `对话 ID:${t.conversationId}` : "还没开始对话");
  return lines.join("\n");
}
