/**
 * The contract layer between the chat page (`ChatView.tsx`) and the Agent: messages, whether sending is
 * possible, send, stop, and the one sentence to show to the user.
 *
 * Vibe mode has two kinds of Agent connection (`user-workflow.md` "Agent connection types"), and the
 * chat page treats both alike:
 *   - **Cloud**: the one in the online browser, `useVibeCloud.ts` (underneath is
 *     `src/ai/cloud/useCloud.ts`, the same set as the editor's right rail and the mobile app);
 *   - **CLI / API**: the one on the desktop app, `useVibeLocal.ts` (underneath is `src/ai/useAiChat.ts`,
 *     the same set as the AI panel of the editor).
 *
 * So the chat page takes this interface rather than the concrete type of either one: the desktop app has
 * no account, no shared / private, and no host notice, and all of these degrade to "none" in this
 * interface (`me` is null, `consent.open` is always false), and the chat page runs just the same.
 */
import type { ChatMessage } from "../ai/types";
import type { CloudSender } from "../ai/chatTypes";

export interface VibeAgent {
  /** The chat itself. Field names follow the cloud's set, and the local one is filled in with the same shape */
  chat: {
    messages: readonly ChatMessage[];
    /** The chat page uses it as a key: when the chat changes, the unsent draft is cleared */
    conversationId: string;
    /** In a shared chat, a message sent by someone else is marked with who sent it; the local Agent has no one else, so give undefined */
    view: { senders?: Record<string, CloudSender> };
    /** Whether the history has been read back. The sentence carried over from the start page must wait for it to be true before being sent (so it is not sent into a chat that has not been matched up yet) */
    history: { loaded: boolean };
  };
  /** Who "I" am (used in a shared chat to decide which message was sent by someone else); the local Agent has no account, so it is null */
  me: string | null;
  /** The project currently connected; null if not connected. The chat page uses it to decide whether to show `whyNot` under the input box */
  projectId: string | null;
  canSend: boolean;
  whyNot: string | null;
  streaming: boolean;
  canStop: boolean;
  /** Number of messages queued up waiting behind */
  queued: number;
  /** The cloud execution service is not taking jobs right now (account mode, `info.executorMounted` is
   * not true): messages stay queued persistently and run once the execution service arrives.
   * Only the cloud has this; the local Agent runs on this machine, so it is always false */
  waitingExecutor: boolean;
  /** Host-can-read notice (`product/agent.md`). Only the cloud has it; the local Agent is always off */
  consent: { open: boolean; pending: boolean; error: string | null; accept: () => void; reject: () => void };
  send: (text: string) => Promise<boolean>;
  stop: () => Promise<void>;
  /** The one line at the top that is meant to be shown to people (connection lost, switch off, reason a send failed) */
  banner: string | null;
  clearBanner: () => void;
  /** Fallback description for the line under the input box: the cloud says "Keeps running after you close it", while the local one says something different, so the implementation supplies it */
  hint: string;
}
