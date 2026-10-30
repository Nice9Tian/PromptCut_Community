/**
 * 聊天页(`ChatView.tsx`)跟 Agent 之间的那层约定:消息、能不能发、发、停、要给人看的那一句。
 *
 * 氛围式有两种 Agent 接入(`user-workflow.md`「Agent 接入方式」),聊天页对两种一视同仁:
 *   - **云端**:在线浏览器里那一种,`useVibeCloud.ts`(底下是 `src/ai/cloud/useCloud.ts`,和编辑器右栏、手机版同一套);
 *   - **CLI / API**:桌面版那一种,`useVibeLocal.ts`(底下是 `src/ai/useAiChat.ts`,和编辑界面 AI 栏同一套)。
 *
 * 所以聊天页拿的是本接口,不是其中某一种的具体类型 —— 桌面版没有账号、没有共有 / 私有、没有告知托管方,
 * 这些在本接口里都退化成「没有」(`me` 为 null、`consent.open` 恒假),聊天页照样跑。
 */
import type { ChatMessage } from "../ai/types";
import type { CloudSender } from "../ai/chatTypes";

export interface VibeAgent {
  /** 这条对话本身。字段名沿用云端那一套,本机的照同样的形状填 */
  chat: {
    messages: readonly ChatMessage[];
    /** 聊天页用它当 key:换对话时清掉没发出去的草稿 */
    conversationId: string;
    /** 共有对话里别人发的那条标是谁发的;本机 Agent 没有别人,给 undefined */
    view: { senders?: Record<string, CloudSender> };
    /** 历史读回来了没有。开始页带过来的那句话要等它为真才发(免得发进一条还没对上的对话) */
    history: { loaded: boolean };
  };
  /** 「我」是谁(共有对话里判哪条是别人发的);本机 Agent 没有账号,是 null */
  me: string | null;
  /** 此刻连着的项目;没连上是 null。聊天页据此决定要不要把 `whyNot` 显示在输入框下面 */
  projectId: string | null;
  canSend: boolean;
  whyNot: string | null;
  streaming: boolean;
  canStop: boolean;
  /** 排在后面等着的消息条数 */
  queued: number;
  /** 云端的执行服务此刻没在接活(账号模式、`info.executorMounted` 不为真):消息会持久排着,等执行服务来了再跑。
   * 只有云端有;本机 Agent 的 Agent 就在本机,恒为假 */
  waitingExecutor: boolean;
  /** 告知托管方能读(`product/agent.md`)。只有云端有;本机 Agent 恒为关 */
  consent: { open: boolean; pending: boolean; error: string | null; accept: () => void; reject: () => void };
  send: (text: string) => Promise<boolean>;
  stop: () => Promise<void>;
  /** 顶上那一条要给人看的话(连接断了、开关关着、发送失败的原因) */
  banner: string | null;
  clearBanner: () => void;
  /** 输入框下面那一行的兜底说明:云端说「关掉还在跑」,本机说的是另一回事,所以由实现方给 */
  hint: string;
}
