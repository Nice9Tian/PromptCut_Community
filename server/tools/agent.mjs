import { SPAWN_ROLE_IDS, SPAWN_ROLE_HINTS } from "../agent/spawn-roles.mjs";

// Multi-agent (plan docs/plan/agent-workflow-plan.md A3): all five tools answered in editor process (side: "server"),
// bulletin board is one per project (server/agent/agent-board.mjs), seen by all Agents; subagents: server/agent/multi-agent.mjs.
export const agentTools = [
  {
    name: "spawn_agent",
    description: `Spawn a sub-Agent and assign it a task: opens a new tab (new chat ID, new write identity), applies the prompt of a preset role, and sends task to it as the first message; returns the sub-Agent's chat ID (afterwards coordinate with it via send_message, and use list_agents to see whether it is busy). The vendor and driver follow your chat, and the creativity level is the level currently in effect for you and never higher than yours. Limits: a sub-Agent cannot spawn further (depth 1); at most 4 sub-Agents can be open at the same time (a slot frees up when the user closes its tab); it cannot be used when you have no tab to open (a desktop app session). When splitting work, give each sub-Agent a non-overlapping scope, and state in task what it must do, which "cut->track" it should change, and how to report when done. Available roles: ${SPAWN_ROLE_IDS.map((id) => `${id}(${SPAWN_ROLE_HINTS[id]})`).join(";")}.`,
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", enum: [...SPAWN_ROLE_IDS], description: "Preset role" },
        task: { type: "string", description: "The task to hand over (as its first message); state the scope and the delivery criteria" }
      },
      required: ["role", "task"]
    },
    side: "server"
  },
  {
    name: "declare_scope",
    description: "First step before starting work: declare the scope you plan to change in this turn, in the format \"cut X->track X\" (separate multiple with commas, e.g. \"cut 1->track 2,cut 1->track 3\"). It is shown on your tab and other Agents are notified; the result lists other Agents and their scopes, and a warning is given on overlap, so agree via send_message before you act. If someone else later writes into your declared scope, your next tool result will carry a notice. Declare again if the scope changes.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "\"cut X->track X\", separate multiple with commas" },
        note: { type: "string", description: "One sentence on what you plan to do (optional)" }
      },
      required: ["scope"]
    },
    side: "server"
  },
  {
    name: "list_agents",
    description: "See which Agents are currently working in parallel on the same project (each one's chat ID, tab name, declared scope, busy or not, vendor; sub-Agents carry their role and parent chat; Agents on other members' side in a shared project carry the member name). you is your own chat ID. Use this first to get the ID of whoever you want to message.",
    inputSchema: { type: "object", properties: {} },
    side: "server"
  },
  {
    name: "send_message",
    // Setting to to "user" speaks to the user (user decision, 2026-10-20: bubbles only show what the Agent is doing);
    // direct API is answered locally by harness/tools/index.mjs, and via MCP by the bulletin board (agent-board.mjs)
    description: "Send a message. With to set to \"user\" you speak to the user: before each group of operations, tell the user in a sentence or two what you are about to do, and after each group say in one sentence what was done; these appear in order in this turn's chat bubbles (the wrap-up is still delivered with a report_progress whose final is true). With to set to another Agent's chat ID (the id in list_agents) or all, you message other Agents to coordinate the division of work (e.g. \"I'll edit track 2, you don't touch it\"): if the recipient is idle, the message is sent to it immediately as a message; if it is busy, it rides along in the result of its next tool call. There is a cap on consecutive back-and-forth between Agents; beyond it, messages stay in the recipient's inbox until the user next speaks, so do not use it for idle chatter: saying it clearly once is enough.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "user (speak to the user), or the recipient Agent's chat ID, or all" },
        text: { type: "string", description: "What to say" }
      },
      required: ["to", "text"]
    },
    side: "server"
  },
  {
    name: "check_messages",
    description: "See whether other Agents have sent you messages, and which \"cut->track\" others have changed since last time (without taking them away). Normally no need to call it proactively: this content is attached automatically before the prompt at the start of each of your turns, and also rides along in tool results mid-run; use it only when you want to check in the middle of a long task.",
    inputSchema: { type: "object", properties: {} },
    side: "server"
  }
];
