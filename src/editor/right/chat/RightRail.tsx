import type { AgentTab } from "../../../ai/agentTabs";
import { tr } from "../../../i18n/index.ts";

/**
 * Drawing helpers for the AI items on the rail (script, Agent tabs): the script icon, the letter in an
 * Agent avatar, label truncation, hover tooltip.
 *
 * The rail itself is now shared left and right and draggable, in editor/dock/RailBar.tsx; the
 * RightRail component that used to be here and `pc.right.page` (script / assistant) were merged into
 * the dock's layout store (editor/dock/railStore.ts, `pc.rail.layout.v1`): the script and every Agent
 * is an independent item on the rail.
 */

/** The icon for "Script" on the rail: a document with a few lines of text on one page */
export function IconScript() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
      <path d="M9 11h7M9 14.5h7M9 18h4" />
    </svg>
  );
}

/** The letter in the avatar: for the default name "Agent N" take the number, for one with a declared scope take the first letter of the title */
export function glyphOf(t: AgentTab, index: number): string {
  const num = /^Agent\s+(\d+)$/.exec(t.title.trim());
  if (num) return num[1];
  return [...t.title.trim()][0] ?? String(index + 1);
}

/**
 * A rail label is at most 4 characters wide: a full-width character counts as 1, a half-width one as 0.5.
 * Truncating by character count would cut "Agent 1" into "Agen…", although it is actually narrower
 * than "Cut director".
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

/** Hover tooltip: full title + scope + chat ID (the Agent ID shown to the model, the recipient of send_message is written as this) */
export function tabTooltip(t: AgentTab): string {
  const lines = [t.title];
  if (t.scope) lines.push(tr("Scope: {0}", t.scope));
  lines.push(t.conversationId ? tr("Chat ID: {0}", t.conversationId) : tr("No chat started yet"));
  return lines.join("\n");
}
