import { useRemoteAgents } from "../sync/presence";

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
        <div key={a.id} data-pc="remote-agent" data-agent={a.id} title={`对话 ID ${a.id}`}>
          {a.cloud ? `${a.member}的云端 Agent` : `成员 ${a.member} 的 Agent${a.vendor ? `(${a.vendor})` : ""}`}正在改:{a.scope}
        </div>
      ))}
    </div>
  );
}
