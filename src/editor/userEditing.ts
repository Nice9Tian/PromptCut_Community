/**
 * 「用户正在编辑」的接线(计划 docs/plan/agent-workflow-plan.md A2):把编辑界面各处的编辑状态汇总
 * (汇总与节流的逻辑在 ./userEditingCore.ts),推给编辑器进程的 POST /api/agent/editing;
 * Agent 读或写到这些片段时,服务端在工具结果里标出「用户正在编辑」(server/agent/user-editing.mjs)。
 *
 * 各处怎么报:
 *   - 拖动、文字编辑:组件里调 useUserEditing(slot, clipId | null, kind),拖动 / 编辑开始时给片段 id、结束时给 null;
 *   - 「选中后动过」:这里旁听 store 的选区和本页面自己的修改(onLocalCommit),选中的片段被改了就记一笔;
 *     Agent 让页面执行的工具(src/ai/mcpExecutor.ts)执行期间的修改不算用户动过(beginAgentTool / endAgentTool)。
 */
import { useEffect } from "react";
import { getState, subscribe, onLocalCommit } from "../store/project";
import type { Project } from "../kernel/project";
import { createEditingTracker, type EditingEntity } from "./userEditingCore";
import { publishEditing } from "./sync/presence";

/** 这个页面的会话号(服务端按它整份替换这个页面报的状态) */
const session = `ue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 在线构建的编译期常量,写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/**
 * 在线页面没有编辑器进程(C10a 契约第 2 节),也就没有本机 Agent 可提示:不发,在线构建里连同这条 /api 路径一起剪掉。
 * 桌面 / 本机:不等回包、不读 body —— 它是一份提示,晚一拍到也只是少提示一次。
 */
const sendLocal: (entities: EditingEntity[]) => void = ONLINE_BUILD ? () => {} : (entities) => {
  try {
    void fetch("/api/agent/editing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, entities }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* 发不出去就等下一次 */ }
};

/**
 * 另外经这个页面的文档服务连接发布一份(A3 第二阶段,src/editor/sync/presence.ts):共享项目里别的成员的编辑器进程
 * 据此提示他们的 Agent「用户 <成员>正在编辑」。在线页面也走这条(它没有编辑器进程,只有文档服务连接)。
 */
const send = (entities: EditingEntity[]) => {
  sendLocal(entities);
  try { publishEditing(session, entities); } catch { /* 在场状态是附带的 */ }
};

const tracker = createEditingTracker({ send });

/** Agent 让页面执行的工具正在跑(可能嵌套):这期间本页面的修改不算用户动过 */
let agentToolDepth = 0;
export function beginAgentTool() { agentToolDepth += 1; }
export function endAgentTool() { agentToolDepth = Math.max(0, agentToolDepth - 1); }
/** 现在有没有 Agent 让页面执行的工具正在跑(保存要等它写完,`io/localWrites.ts`) */
export function agentToolRunning(): boolean { return agentToolDepth > 0; }

/** 两份项目之间,这几个片段里哪些换了对象(不可变更新:改过的片段一定是新对象) */
function changedClips(prev: Project, next: Project, ids: readonly string[]): string[] {
  if (!ids.length) return [];
  const find = (p: Project, id: string) => {
    for (const t of p.tracks) for (const c of t.clips) if (c.id === id) return c;
    return undefined;
  };
  return ids.filter((id) => {
    const a = find(prev, id);
    const b = find(next, id);
    return !!b && a !== b;
  });
}

let started = 0;
let offs: Array<() => void> = [];

/** 编辑台挂上时开始推(src/editor/right/index.tsx 与 Agent 的工具通道同一时机);回停止函数 */
export function startUserEditing(): () => void {
  started += 1;
  if (started === 1) {
    tracker.setSelection(getState().selection);
    let lastSel = getState().selection;
    offs = [
      subscribe(() => {
        const sel = getState().selection;
        if (sel !== lastSel) { lastSel = sel; tracker.setSelection(sel); }
      }),
      onLocalCommit((prev, next) => {
        if (agentToolDepth > 0) return;
        const ids = changedClips(prev, next, getState().selection);
        if (ids.length) tracker.touch(ids);
      }),
    ];
    tracker.setEnabled(true);
  }
  return () => {
    started = Math.max(0, started - 1);
    if (started > 0) return;
    for (const off of offs) off();
    offs = [];
    tracker.setEnabled(false);
  };
}

/**
 * 组件报「这个位置正在拖动 / 文字编辑哪个片段」。slot 在整个页面里唯一(同一个组件多个实例时带上片段 id)。
 * clipId 为 null 或组件卸载时撤掉。
 */
export function useUserEditing(slot: string, clipId: string | null | undefined, kind: "drag" | "text") {
  useEffect(() => {
    tracker.setActive(slot, clipId || null, kind);
    return () => tracker.setActive(slot, null, kind);
  }, [slot, clipId, kind]);
}

/** 测试与诊断:此刻会报出去的状态 */
export function userEditingSnapshot(): EditingEntity[] {
  return tracker.snapshot();
}
