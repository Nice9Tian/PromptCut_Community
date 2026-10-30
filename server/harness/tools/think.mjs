// 对应 claude-quickstarts/agents/tools/think.py

export const thinkTool = {
  name: "think",
  description: "记录一段思考或计划,不产生副作用。用于在多步操作前理清思路。",
  inputSchema: {
    type: "object",
    properties: {
      thought: { type: "string" }
    },
    required: ["thought"]
  },
  async execute() {
    return "ok";
  }
};
