/**
 * User-facing copy for cloud chat "50 limit" and "delete" in the UI is centralized here.
 *
 * These sentences are primary semantics (text visible to users). (user confirmation, 2026-10-13:
 * use as originally drafted, `docs/plan/user-decisions-2026-10-13.md` block 5 item 1), only the
 * remove member group below is marked "[draft]" (added in block 5 item 5, pending later user
 * revision). If modifications are needed, only modify this file (the server-side limit reached
 * notice is in `CONVERSATION_LIMIT_MESSAGE` in `server/agent/service/create-agent-service.mjs`,
 * must be updated in sync).
 *
 * (formerly in `src/ai/cloud/chatTexts.ts`, pure copy and limit constants moved up to public side
 * `src/ai/chatTexts.ts`)
 */
import type { CloudNotice } from "./chatTypes.ts";
import { tr } from "../i18n/index.ts";

/** Maximum number of cloud chats for the same person in the same project (server limit is in `server/account/conversation-authority.mjs`) */
export const CLOUD_CHAT_LIMIT = 50;

/** User-facing message shown when a guest wants to open a second Agent chat in the same project (keep identical to `src/account/guest.ts`) */
export const GUEST_CHAT_LIMIT_TEXT =
  tr("Guests can open only 1 Agent chat per project, and you have already opened it: click it in \"Chat history\" to continue. To open more, please register an account.");

export const CLOUD_CHAT_TEXT = {
  /** When a guest wants to open a second chat: message shown when the server rejects (`guest-chat-limit`) or UI intercepts first */
  guestLimit: GUEST_CHAT_LIMIT_TEXT,
  /** Prompt shown when clicking send while at capacity, or when creating new is rejected by the server */
  limitReached: tr("Your cloud chats in this project have reached the limit of {0}. Delete unused chats before creating a new one.", CLOUD_CHAT_LIMIT),
  /** One-line notice at the top of chat history when currently at capacity */
  limitHint: tr("You already have {0} cloud chats in this project, which is the limit. Delete unused ones before creating a new one.", CLOUD_CHAT_LIMIT),
  /** Notice above the input box when current chat is a new chat with no messages sent yet and is at capacity */
  limitComposer: tr("Cloud chats have reached the limit of {0}; sending the first message will be rejected. Delete unused chats in \"Chat history\" first.", CLOUD_CHAT_LIMIT),

  deleteButtonTitle: tr("Delete chat"),
  deleteResumeTitle: tr("Continue deleting"),
  deleting: tr("Deleting…"),
  deleteTitle: tr("Delete this chat?"),
  deleteBody: (title: string) => tr("\"{0}\" will be deleted. This cannot be undone.", title || tr("Cloud chat")),
  deleteRunning: tr("A task is running in this chat. It will be stopped before deletion, and changes already applied will be kept."),
  deleteOthers: tr("This chat was opened by another member. They will be notified when it is deleted."),
  deleteShared: tr("This is a shared chat. Other members who have posted in it will be notified."),
  deleteConfirm: tr("Delete"),
  deleteCancel: tr("Cancel"),
  deleteWorking: tr("Deleting…"),
  deleteRetry: tr("Retry delete"),
  deleteDone: tr("Deleted. The slot has been freed."),
  /** Task has not fully stopped yet, chat stays at "Deleting", retry uses the original request */
  deletePending: tr("The task in this chat has not fully stopped, so it has not been deleted yet. Wait a moment, then click \"Retry delete\" to continue."),
  deleteForbidden: tr("Only the person who opened this chat or the project creator can delete it."),
  conversationDeleting: tr("This chat is being deleted."),
  currentDeleted: tr("The chat you are viewing has been deleted."),
  noConversation: tr("This chat was not found. It may have been deleted."),
  /** [newly drafted 2026-10-13] Deletion was completed in document service, but an error occurred while cleaning up this chat's content on the cloud side: retry will continue cleaning */
  purgeFailed: tr("This chat has been deleted, but the cloud has not finished clearing its contents. Please try again."),
  /** [newly drafted 2026-10-13] Only project creator can clear others' private chats */
  creatorRequired: tr("Only the project creator can clear a member's private chats."),
  /** Shows how many this account has opened after the "Cloud" group title in chat history: updates in real time as others create or delete */
  countLabel: (n: number, limit: number = CLOUD_CHAT_LIMIT) => tr("Mine {0}/{1}", n, limit),

  /* [draft] Additional options and subsequent prompts when removing a member ("Kick account" in project members panel) (user decision, 2026-10-13: let operator choose whether to also clear their private chats, shared chats are kept by default) */
  clearPrivateOption: tr("Also clear their private chats (their shared chats are kept)"),
  clearPrivateWorking: tr("Clearing their private chats…"),
  clearPrivateDone: (n: number) => (n > 0 ? tr("Cleared {0} of their private chats.", n) : tr("They have no private chats.")),
  clearPrivatePending: (n: number) => tr("Tasks in {0} chats have not fully stopped, so they have not been cleared yet. Click \"Retry clear\" to continue.", n),
  clearPrivateRetry: tr("Retry clear"),
} as const;

/** Bubble popped up after someone deleted a chat related to you */
export function cloudNoticeText(n: Pick<CloudNotice, "recipientRole" | "deletedByRole" | "deletedByName" | "title">): string {
  const title = n.title || tr("Cloud chat");
  const who = n.deletedByRole === "creator" ? tr("Project creator \"{0}\"", n.deletedByName) : tr("\"{0}\"", n.deletedByName);
  return n.recipientRole === "owner"
    ? tr("{0} deleted your cloud chat \"{1}\".", who, title)
    : tr("{0} deleted the shared cloud chat \"{1}\", in which you posted messages.", who, title);
}
