/**
 * Speak to the user: `to` in `send_message` is set to "user" (user decision, 2026-10-20, user's exact
 * words: "only show what is being done in the bubble (harness may need changes, such as adding
 * usage of send_message(user,xxx).)"). The message is sequentially rendered by the UI into this
 * round's bubble according to `text` in the `tool_call` event; it does not enter the project, and
 * does not go through the multi-Agent bulletin board; the tool result is simply "Displayed".
 *
 * `send_message` for multi-Agent coordination (sent to other Agents) is defined in
 * `server/tools/agent.mjs` with the same name; the definition here is only patched in when that
 * tool is not provided to the model (the hosted tier open manifest excludes it), and can only send
 * to the user.
 */
export const USER_MESSAGE_RESULT = Object.freeze({ ok: true, shown: true, note: 'Shown in the user\'s chat bubble' });

/** Respond once to messages for the user: if text is empty, reject it and have the model speak again */
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
