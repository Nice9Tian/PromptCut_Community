/**
 * "Undo this step" on an AI panel action card (c65-undo-draft.md section 4; ruled in c65-design.md section 8).
 *
 * It appears only on actions that changed the project: the document service's "completed" event (`events.event`) carrying the `opId` of this commit (sent by the c65-agent side)
 * counts as having changed the project; the AI panel's tool call is matched by the event's `callId` (or eventId). No second confirmation, and it is clickable even if it is not the latest step;
 * after a successful undo it turns into a gray "Undone". The inverse operation is submitted as the page's identity + `undoOf`, into the user's own undo stack; conflicts are handled by the usual undo rules.
 */
import { agentOpFor, revertAgentOp, useSync } from "./syncManager";
import { tr } from "../../i18n/index.ts";

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
        {done ? tr("Undone") : tr("Undo this step")}
      </button>
    </div>
  );
}
