/**
 * 云端对话的「50 个上限」与「删除」在界面上给用户看的话，集中在这一处。
 *
 * 这些句子是一级语义（用户看得到的文字）。2026-10-13 用户确认：照原来起草的用（`docs/plan/user-decisions-2026-10-13.md` 块五第 1 条），
 * 下面标「〔草稿〕」的只有移出成员那一组（块五第 5 条新增，等用户事后改）。要改只改这一个文件
 * （服务端那一句满额提示在 `server/agent/service/create-agent-service.mjs` 的 `CONVERSATION_LIMIT_MESSAGE`，要同步改）。
 *
 * （原在 `src/ai/cloud/chatTexts.ts`，纯文案与上限常量上移至公开侧 `src/ai/chatTexts.ts`）
 */
import type { CloudNotice } from "./chatTypes.ts";
import { tr } from "../i18n/index.ts";

/** 同一个项目里同一个人最多这么多个云端对话（服务端的上限在 `server/account/conversation-authority.mjs`） */
export const CLOUD_CHAT_LIMIT = 50;

/** 游客想在同一个项目里开第二个 Agent 对话时给的那句人话（与 `src/account/guest.ts` 保持同文） */
export const GUEST_CHAT_LIMIT_TEXT =
  tr("Guests can open only 1 Agent chat per project, and you have already opened it: click it in \"Chat history\" to continue. To open more, please register an account.");

export const CLOUD_CHAT_TEXT = {
  /** 游客想开第二个对话：服务端拒了（`guest-chat-limit`），或界面上先拦下时给的那一句 */
  guestLimit: GUEST_CHAT_LIMIT_TEXT,
  /** 满额时点发送、或新建被服务端拒了，给的提示 */
  limitReached: tr("Your cloud chats in this project have reached the limit of {0}. Delete unused chats before creating a new one.", CLOUD_CHAT_LIMIT),
  /** 对话历史顶上、当前已满额时的一行提示 */
  limitHint: tr("You already have {0} cloud chats in this project, which is the limit. Delete unused ones before creating a new one.", CLOUD_CHAT_LIMIT),
  /** 当前是一段还没发过消息的新对话、又已满额时，输入框上方的提示 */
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
  /** 任务还没停稳，对话停在「正在删除」，重试沿用原来的请求 */
  deletePending: tr("The task in this chat has not fully stopped, so it has not been deleted yet. Wait a moment, then click \"Retry delete\" to continue."),
  deleteForbidden: tr("Only the person who opened this chat or the project creator can delete it."),
  conversationDeleting: tr("This chat is being deleted."),
  currentDeleted: tr("The chat you are viewing has been deleted."),
  noConversation: tr("This chat was not found. It may have been deleted."),
  /** 〔2026-10-13 新起草〕删除已经在文档服务办成，但云端一侧清理这个对话的内容出错了：重试会接着清 */
  purgeFailed: tr("This chat has been deleted, but the cloud has not finished clearing its contents. Please try again."),
  /** 〔2026-10-13 新起草〕只有项目创建者能清除别人的私有对话 */
  creatorRequired: tr("Only the project creator can clear a member's private chats."),
  /** 对话历史里「云端」一组标题后面显示这位账号自己开了多少个：随别人新建、删除实时变 */
  countLabel: (n: number, limit: number = CLOUD_CHAT_LIMIT) => tr("Mine {0}/{1}", n, limit),

  /* 〔草稿〕移出成员(项目成员面板里「踢出账号」)时多出来的选项与随后的提示（2026-10-13 用户定：让操作的人选是否同时清除他的私有对话，共有对话缺省保留） */
  clearPrivateOption: tr("Also clear their private chats (their shared chats are kept)"),
  clearPrivateWorking: tr("Clearing their private chats…"),
  clearPrivateDone: (n: number) => (n > 0 ? tr("Cleared {0} of their private chats.", n) : tr("They have no private chats.")),
  clearPrivatePending: (n: number) => tr("Tasks in {0} chats have not fully stopped, so they have not been cleared yet. Click \"Retry clear\" to continue.", n),
  clearPrivateRetry: tr("Retry clear"),
} as const;

/** 别人删了和你有关的对话以后弹出的气泡 */
export function cloudNoticeText(n: Pick<CloudNotice, "recipientRole" | "deletedByRole" | "deletedByName" | "title">): string {
  const title = n.title || tr("Cloud chat");
  const who = n.deletedByRole === "creator" ? tr("Project creator \"{0}\"", n.deletedByName) : tr("\"{0}\"", n.deletedByName);
  return n.recipientRole === "owner"
    ? tr("{0} deleted your cloud chat \"{1}\".", who, title)
    : tr("{0} deleted the shared cloud chat \"{1}\", in which you posted messages.", who, title);
}
