/**
 * 对用户说话:send_message 的 to 填 "user"(2026-10-20 用户定,用户原话「气泡里面只展示在做什么(harness可能要改,
 * 比如加入send_message(user,xxx)的用法。)」)。说的话由界面按 tool_call 事件里的 text 按顺序画进这一轮的气泡,
 * 不进项目、不经多 Agent 公告板;工具结果只是一句「已显示」。
 *
 * 多 Agent 协调的 send_message(发给别的 Agent)定义在 server/tools/agent.mjs,同一个名字;
 * 这里的定义只在那个工具没交给模型时(托管档的开放清单不含它)补上,只能发给用户。
 */
export const USER_MESSAGE_RESULT = Object.freeze({ ok: true, shown: true, note: '已显示在用户的对话气泡里' });

/** 答一次对用户说的话:text 是空的就退回去,让模型重说 */
export function answerUserMessage(input) {
  if (typeof input?.text !== 'string' || !input.text.trim()) return { ok: false, error: 'text 不能是空的:写一两句要对用户说的话' };
  return USER_MESSAGE_RESULT;
}

export function userMessageTool() {
  return {
    name: 'send_message',
    description: '对用户说一两句话:to 填 "user",text 写你接下来要做什么、或刚做好了什么。会按顺序显示在这一轮的对话气泡里。每组操作前说一句、做完说一句,和那一组工具调用放在同一次回复里;收尾仍交 final 为 true 的 report_progress。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', enum: ['user'], description: '固定填 user' },
        text: { type: 'string', description: '要对用户说的话,一两句,简洁中文' },
      },
      required: ['to', 'text'],
    },
    async execute(input) {
      if (!input || String(input.to ?? '').trim().toLowerCase() !== 'user') return { ok: false, error: 'to 只能填 user' };
      return answerUserMessage(input);
    },
  };
}
