// Corresponds to claude-quickstarts/agents/tools/think.py

export const thinkTool = {
  name: "think",
  description: "Record a thought or plan with no side effects. Use it to organize your thinking before multi-step operations.",
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
