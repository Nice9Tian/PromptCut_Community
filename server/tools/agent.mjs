import { SPAWN_ROLE_IDS, SPAWN_ROLE_HINTS } from "../agent/spawn-roles.mjs";

// 多 Agent(计划 docs/plan/agent-workflow-plan.md A3):五个工具都在编辑器进程里答(side: "server"),
// 公告板按项目一份(server/agent/agent-board.mjs),所有 Agent 看到同一份;拉起子 Agent 见 server/agent/multi-agent.mjs。
export const agentTools = [
  {
    name: "spawn_agent",
    description: `拉起一个子 Agent 并给它分派任务:开一个新页签(新的对话 ID、新的写入身份),套上预设角色的提示词,把 task 作为第一条消息发给它;返回子 Agent 的对话 ID(之后用 send_message 和它协调,用 list_agents 看它忙不忙)。厂商与驱动沿用你这个对话,创造力等级取你此刻生效的等级、不会高于你。限制:子 Agent 不能再拉起(深度 1);同时开着的子 Agent 至多 4 个(用户关掉它的页签才腾出名额);你没有页签可开时(桌面 APP 的会话)不能用。拆活时一个子 Agent 一块互不重叠的范围,task 里写清要它做什么、改哪条「剪辑->序列」、做完怎么交代。可选角色:${SPAWN_ROLE_IDS.map((id) => `${id}(${SPAWN_ROLE_HINTS[id]})`).join(";")}。`,
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", enum: [...SPAWN_ROLE_IDS], description: "预设角色" },
        task: { type: "string", description: "交给它的任务(作为它的第一条消息);写清范围和交付标准" }
      },
      required: ["role", "task"]
    },
    side: "server"
  },
  {
    name: "declare_scope",
    description: "开工第一步:声明你这一轮打算改的范围,格式「剪辑X->序列X」(多个用逗号分开,如「剪辑1->序列2,剪辑1->序列3」)。会显示在你的页签上,其他 Agent 也会收到通知;返回里列出别的 Agent 和它们的范围,有重叠会给 warning,先 send_message 商量好再动手。之后别人写进你声明的范围时,你下一次工具结果里会带提示。范围变了就再声明一次。",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "「剪辑X->序列X」,多个用逗号分开" },
        note: { type: "string", description: "一句话说明打算做什么(可选)" }
      },
      required: ["scope"]
    },
    side: "server"
  },
  {
    name: "list_agents",
    description: "看现在有哪些 Agent 在同一个项目上并行(每个的对话 ID、页签名、声明的范围、忙不忙、厂商;子 Agent 带角色和父对话;共享项目里别的成员那边的 Agent 带成员名)。you 是你自己的对话 ID。要给谁发消息先用它拿 ID。",
    inputSchema: { type: "object", properties: {} },
    side: "server"
  },
  {
    name: "send_message",
    // to 填 "user" 是对用户说话(2026-10-20 用户定:气泡里只展示 Agent 在做什么);API 直连由 harness/tools/index.mjs 就地答,经 MCP 的由公告板(agent-board.mjs)答
    description: "发一段话。to 填 \"user\" 是对用户说话:每组操作前用一两句话告诉用户接下来要做什么、做完一组说一句做好了什么,按顺序显示在这一轮的对话气泡里(收尾仍交 final 为 true 的 report_progress)。to 填别的 Agent 的对话 ID(list_agents 里的 id)或 all,是给其他 Agent 发话协调分工(比如「序列2 我来改,你别动」):对方空闲时这段话会立刻作为一条消息发给它;它正忙就带在它下一次工具调用的结果里。Agent 之间连续互发有层数上限,超过就留在对方信箱里等用户下次开口时带上,所以不要用它来回闲聊,说清楚一次就够。",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "user(对用户说话),或收件 Agent 的对话 ID,或 all" },
        text: { type: "string", description: "要说的话" }
      },
      required: ["to", "text"]
    },
    side: "server"
  },
  {
    name: "check_messages",
    description: "看看有没有别的 Agent 给你的消息、以及自上次以来别人改了哪些「剪辑->序列」(不取走)。一般不用主动调:这些内容会在你每一轮开始时自动附在提示词前面,跑的途中也会带在工具结果里;只在长任务中途想确认一下时用。",
    inputSchema: { type: "object", properties: {} },
    side: "server"
  }
];
