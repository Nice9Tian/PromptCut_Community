import type { ChatAttachment, ChatMessage } from "./types.ts";

/**
 * "Roll back to here": return to the point before a given user message was sent.
 *
 * That user message and every message after it are removed from the UI (when one question gets
 * several answers, the Agent replies carrying a roleId all come after it and go together), and the
 * original text and attachments of that message are put back in the input box for the user to edit
 * and send again.
 * Changes already made on the timeline are not handled here: they are not part of the chat and
 * cannot be undone, and the confirmation dialog must say so clearly.
 *
 * Pure function: it touches neither the store nor the session id; the execution steps are in
 * useAiChat.rewindTo / AiPanel.
 */
export interface RewindResult {
  /** The messages that remain (those before that user message) */
  kept: ChatMessage[];
  /** The messages that were removed; the first one is that user message */
  removed: ChatMessage[];
  /** What is put back into the input box */
  restored: { text: string; attachments: ChatAttachment[] };
}

/** Returns null if the id does not exist or that message is not a user message */
export function rewindAt(messages: ChatMessage[], userMessageId: string): RewindResult | null {
  const idx = messages.findIndex((m) => m.id === userMessageId && m.role === "user");
  if (idx < 0) return null;
  const target = messages[idx];
  return {
    kept: messages.slice(0, idx),
    removed: messages.slice(idx),
    restored: {
      text: target.text ?? "",
      // Make a copy: the input area modifies the attachments' state, so it must not modify the message
      // that is already archived
      attachments: (target.attachments ?? []).map((a) => ({ ...a })),
    },
  };
}
