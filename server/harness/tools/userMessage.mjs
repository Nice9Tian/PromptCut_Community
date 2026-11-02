/**
 * 对用户说话:send_message 的 to 填 "user"(2026-10-20 用户定,用户原话「气泡里面只展示在做什么(harness可能要改,
 * 比如加入send_message(user,xxx)的用法。)」)。说的话由界面按 tool_call 事件里的 text 按顺序画进这一轮的气泡,
 * 不进项目、不经多 Agent 公告板;工具结果只是一句「已显示」。
 *
 * 多 Agent 协调的 send_message(发给别的 Agent)定义在 server/tools/agent.mjs,同一个名字;
 * 这里的定义只在那个工具没交给模型时(托管档的开放清单不含它)补上,只能发给用户。
 */
export const USER_MESSAGE_RESULT = Object.freeze({ ok: true, shown: true, note: 'Shown in the user\'s chat bubble' });

/** 答一次对用户说的话:text 是空的就退回去,让模型重说 */
export function answerUserMessage(input) {
  if (typeof input?.text !== 'string' || !input.text.trim()) return { ok: false, error: 'text must not be empty: write one or two sentences to say to the user' };
  return USER_MESSAGE_RESULT;
}

export function userMessageTool() {
  return {
    name: 'send_message',
    description: 'Say one or two sentences to the user: set to to "user" and write in text what you are about to do or what you just finished. They appear in order in the chat bubbles of this turn. Say one before each group of operations and one after, in the same reply as that group of tool calls; still finish with a report_progress whose final is true.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', enum: ['user'], description: 'Always set to user' },
        text: { type: 'string', description: 'What to say to the user, one or two sentences, concise Chinese' },
      },
      required: ['to', 'text'],
    },
    async execute(input) {
      if (!input || String(input.to ?? '').trim().toLowerCase() !== 'user') return { ok: false, error: 'to must be user' };
      return answerUserMessage(input);
    },
  };
}
