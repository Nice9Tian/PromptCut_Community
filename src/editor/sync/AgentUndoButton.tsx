/**
 * AI 栏操作卡上的「撤销这步」(c65-undo-draft.md 第 4 节;c65-design.md 第 8 节裁定)。
 *
 * 只在改过项目的操作上出现:文档服务的「完成」事件(`events.event`)带了这次提交的 `opId`(c65-agent 那一路发)
 * 才算改过项目;按事件里的 `callId`(或 eventId)对上 AI 栏的这次工具调用。不需要二次确认,不是最新一步也能点;
 * 撤成功后变成灰的「已撤销」。以页面身份提交逆操作 + `undoOf`,进用户自己的撤销栈;冲突照撤销的规矩处理。
 */
import { agentOpFor, revertAgentOp, useSync } from "./syncManager";

export function AgentUndoButton({ callId }: { callId?: string }) {
  useSync((v) => v.agentOpsVersion);
  const rec = agentOpFor(callId);
  if (!rec) return null;
  const done = rec.state === "done";
  return (
    <div className="ai-opcard-undo" style={{ marginTop: 6, display: "flex", justifyContent: "flex-end" }}>
      <button
        type="button"
        className="pc-dialog-opt"
        data-pc="agent-undo"
        style={{ height: 24, padding: "0 10px", fontSize: 12 }}
        disabled={done}
        onClick={() => revertAgentOp(rec)}
      >
        {done ? "已撤销" : "撤销这步"}
      </button>
    </div>
  );
}
