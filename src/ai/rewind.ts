import type { ChatAttachment, ChatMessage } from "./types.ts";

/**
 * 「回退到这里」:回到发某条用户消息之前。
 *
 * 那条用户消息和它之后的所有消息都从界面上拿掉(一问多答时,带 roleId 的几条 Agent 回复
 * 都排在它后面,一起走),那条消息的原文和附件放回输入框,用户改一改再发。
 * 时间轴上已经做过的修改不在这里管 —— 那些不是对话的一部分,撤不回来,确认框里要说清楚。
 *
 * 纯函数:不碰 store、不碰会话 id,执行步骤在 useAiChat.rewindTo / AiPanel 里。
 */
export interface RewindResult {
  /** 留下来的消息(那条用户消息之前的) */
  kept: ChatMessage[];
  /** 被移除的消息,第一条就是那条用户消息 */
  removed: ChatMessage[];
  /** 放回输入框的东西 */
  restored: { text: string; attachments: ChatAttachment[] };
}

/** id 不存在、或者那条不是用户消息时返回 null */
export function rewindAt(messages: ChatMessage[], userMessageId: string): RewindResult | null {
  const idx = messages.findIndex((m) => m.id === userMessageId && m.role === "user");
  if (idx < 0) return null;
  const target = messages[idx];
  return {
    kept: messages.slice(0, idx),
    removed: messages.slice(idx),
    restored: {
      text: target.text ?? "",
      // 拷一份:输入区会改附件的状态,别改到已经归档的那条消息身上
      attachments: (target.attachments ?? []).map((a) => ({ ...a })),
    },
  };
}
