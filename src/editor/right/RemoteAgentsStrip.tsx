import { useRemoteAgents } from "../sync/presence";
import { tr } from "../../i18n/index.ts";

/**
 * The scope declared by the Agent on other members' side in a shared project (plan
 * agent-workflow-plan.md A3 phase 2): received through the document service's presence state
 * (src/editor/sync/presence.ts) and listed as one row at the top of the AI panel, so that people
 * and Agents on this side know where others are editing. Not drawn if there is none.
 */
export function RemoteAgentsStrip() {
  const agents = useRemoteAgents();
  if (!agents.length) return null;
  return (
    <div
      className="pc-remote-agents"
      data-pc="remote-agents"
      style={{ padding: "4px 10px", fontSize: 12, lineHeight: 1.5, color: "var(--ui-text-dim, #888)", borderBottom: "1px solid var(--hairline, rgba(127,127,127,.2))" }}
    >
      {agents.map((a) => (
        <div key={a.id} data-pc="remote-agent" data-agent={a.id} title={tr("Chat ID {0}", a.id)}>
          {tr("{0} is editing: {1}", a.cloud ? tr("{0}'s Cloud Agent", a.member) : tr("Member {0}'s Agent{1}", a.member, a.vendor ? `(${a.vendor})` : ""), a.scope)}
        </div>
      ))}
    </div>
  );
}
