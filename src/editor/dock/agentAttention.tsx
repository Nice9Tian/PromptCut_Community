import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useAgentTabs } from "../../ai/agentTabs";
import { getChatStore } from "../../ai/liveChat";
import type { ChatMessage } from "../../ai/types";
import { useRailCollapsed } from "../sideRails";
import { agentItem, effectiveActive, sideOf } from "./railLayout";
import { useRailLayout } from "./railStore";

/**
 * rail 上 Agent 项的「等你查看」标记。
 *
 *   正在跑        → 头像背景流动的光(RailBar 按 tab.busy 加 is-busy,不在这里记)
 *   跑完了        → 蓝点(done),等用户点开这一页看
 *   被停掉 / 出错 → 黄点(interrupted),同样等用户看
 *
 * 只有**用户这时没在看这一页**才记:这一页是它那一侧 rail 的选中项、那一侧整列显示着、面板没收起,就算在看。
 * 用户切到这一页(或把收起的面板展开)就清掉;这一页又开始跑也清掉(跑的时候只显示流光)。
 * 标记只在内存里,不落盘:刷新之后没有「等你看」的东西。
 */
export type AgentAttention = "done" | "interrupted";

let marks: ReadonlyMap<string, AgentAttention> = new Map();
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function setMark(tabId: string, value: AgentAttention | null): void {
  if ((marks.get(tabId) ?? null) === value) return;
  const next = new Map(marks);
  if (value) next.set(tabId, value);
  else next.delete(tabId);
  marks = next;
  for (const fn of listeners) fn();
}

/** 所有页的标记(引用只在有变化时换,RailBar 一次读全) */
export function useAgentAttentionMap(): ReadonlyMap<string, AgentAttention> {
  return useSyncExternalStore(subscribe, () => marks, () => marks);
}

/**
 * 一轮是怎么结束的:只有明确 outcome 为 completed 才算完成;
 * 用户停掉(aborted)、出错、其它结局、没写结局,以及消息还挂着 pending 就不跑了(比如跑着的时候回了首页,卸载时被 abort)都算中断
 */
export function attentionOf(last: Pick<ChatMessage, "outcome" | "error" | "pending"> | undefined): AgentAttention {
  if (!last) return "done";
  if (last.pending || last.error) return "interrupted";
  return last.outcome === "completed" ? "done" : "interrupted";
}

function lastAssistant(tabId: string): ChatMessage | undefined {
  const msgs = getChatStore(tabId).get();
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "assistant") return msgs[i];
  return undefined;
}

/**
 * 盯着各页 busy 的变化打标记、按「用户在不在看」清标记。不画东西,DockPages 里挂一个。
 * 单独做成组件:它订阅收起状态,变化时只重渲它自己,不连累 DockPages 下面所有页面。
 */
export function AgentAttentionTracker(): null {
  const { tabs } = useAgentTabs();
  const layout = useRailLayout();
  const leftCollapsed = useRailCollapsed("left");
  const rightCollapsed = useRailCollapsed("right");
  const wasBusy = useRef(new Map<string, boolean>());

  // layout effect:切到那一页时标记在画出来之前就清掉,不会闪一下点
  useLayoutEffect(() => {
    const viewing = (tabId: string) => {
      const item = agentItem(tabId);
      const side = sideOf(layout, item);
      if (!side) return false;
      if (side === "left" ? leftCollapsed : rightCollapsed) return false;
      return effectiveActive(layout, side) === item;
    };

    for (const t of tabs) {
      const was = wasBusy.current.get(t.id) ?? false;
      wasBusy.current.set(t.id, t.busy);
      if (t.busy) {
        if (!was) setMark(t.id, null);
        continue;
      }
      if (was && !viewing(t.id)) setMark(t.id, attentionOf(lastAssistant(t.id)));
      else if (marks.has(t.id) && viewing(t.id)) setMark(t.id, null);
    }
    // 关掉的页
    for (const id of [...wasBusy.current.keys()]) {
      if (tabs.some((t) => t.id === id)) continue;
      wasBusy.current.delete(id);
      setMark(id, null);
    }
  });

  return null;
}
