import { useRemoteAgents } from "../sync/presence";
import { tr } from "../../i18n/index.ts";

/**
 * 共享项目里别的成员那边的 Agent 声明的范围(计划 agent-workflow-plan.md A3 第二阶段):经文档服务的在场状态收来
 * (src/editor/sync/presence.ts),在 AI 栏顶上列一行,好让这边的人和 Agent 知道别人在改哪儿。没有就不画。
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
