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

/** 同一个项目里同一个人最多这么多个云端对话（服务端的上限在 `server/account/conversation-authority.mjs`） */
export const CLOUD_CHAT_LIMIT = 50;

/** 游客想在同一个项目里开第二个 Agent 对话时给的那句人话（与 `src/account/guest.ts` 保持同文） */
export const GUEST_CHAT_LIMIT_TEXT =
  "游客在每个项目里只能开 1 个 Agent 对话，你已经开过了：在「对话历史」里点它就能接着聊。要多开，请注册一个账号。";

export const CLOUD_CHAT_TEXT = {
  /** 游客想开第二个对话：服务端拒了（`guest-chat-limit`），或界面上先拦下时给的那一句 */
  guestLimit: GUEST_CHAT_LIMIT_TEXT,
  /** 满额时点发送、或新建被服务端拒了，给的提示 */
  limitReached: `你在这个项目里的云端对话已满 ${CLOUD_CHAT_LIMIT} 个。请先删除不用的对话，再新建。`,
  /** 对话历史顶上、当前已满额时的一行提示 */
  limitHint: `你在这个项目里已有 ${CLOUD_CHAT_LIMIT} 个云端对话，已满。新建前请先删除不用的。`,
  /** 当前是一段还没发过消息的新对话、又已满额时，输入框上方的提示 */
  limitComposer: `云端对话已满 ${CLOUD_CHAT_LIMIT} 个，发出第一条消息会被拒绝。请先在「对话历史」里删除不用的对话。`,

  deleteButtonTitle: "删除对话",
  deleteResumeTitle: "继续删除",
  deleting: "正在删除…",
  deleteTitle: "删除这个对话？",
  deleteBody: (title: string) => `「${title || "云端对话"}」会被删除，删除后不能恢复。`,
  deleteRunning: "这个对话里有任务正在运行。删除时会先停止它，已经落地的修改会保留。",
  deleteOthers: "这是其他成员开的对话，删除后他会收到通知。",
  deleteShared: "这是共有对话，在里面发过消息的其他成员会收到通知。",
  deleteConfirm: "删除",
  deleteCancel: "取消",
  deleteWorking: "正在删除…",
  deleteRetry: "重试删除",
  deleteDone: "已删除，名额已经让出。",
  /** 任务还没停稳，对话停在「正在删除」，重试沿用原来的请求 */
  deletePending: "对话里的任务还没完全停下，暂时没有删除。稍等一下，点「重试删除」会接着办。",
  deleteForbidden: "只有开这个对话的人或项目创建者能删除它。",
  conversationDeleting: "这个对话正在被删除。",
  currentDeleted: "你正在看的对话已被删除。",
  noConversation: "没有找到这个对话，它可能已经被删除。",
  /** 〔2026-10-13 新起草〕删除已经在文档服务办成，但云端一侧清理这个对话的内容出错了：重试会接着清 */
  purgeFailed: "这个对话已经删除，但云端还没有清理完它的内容。请再试一次。",
  /** 〔2026-10-13 新起草〕只有项目创建者能清除别人的私有对话 */
  creatorRequired: "只有项目创建者能清除成员的私有对话。",
  /** 对话历史里「云端」一组标题后面显示这位账号自己开了多少个：随别人新建、删除实时变 */
  countLabel: (n: number, limit: number = CLOUD_CHAT_LIMIT) => `我的 ${n}/${limit}`,

  /* 〔草稿〕移出成员(项目成员面板里「踢出账号」)时多出来的选项与随后的提示（2026-10-13 用户定：让操作的人选是否同时清除他的私有对话，共有对话缺省保留） */
  clearPrivateOption: "同时清除他的私有对话（他的共有对话会保留）",
  clearPrivateWorking: "正在清除他的私有对话…",
  clearPrivateDone: (n: number) => (n > 0 ? `已清除他的 ${n} 个私有对话。` : "他没有私有对话。"),
  clearPrivatePending: (n: number) => `还有 ${n} 个对话里的任务没停稳，暂时没有清除。点「重试清除」会接着办。`,
  clearPrivateRetry: "重试清除",
} as const;

/** 别人删了和你有关的对话以后弹出的气泡 */
export function cloudNoticeText(n: Pick<CloudNotice, "recipientRole" | "deletedByRole" | "deletedByName" | "title">): string {
  const title = n.title || "云端对话";
  const who = n.deletedByRole === "creator" ? `项目创建者「${n.deletedByName}」` : `「${n.deletedByName}」`;
  return n.recipientRole === "owner"
    ? `${who}删除了你的云端对话「${title}」。`
    : `${who}删除了共有云端对话「${title}」，你在里面发过消息。`;
}
