import { useState, useEffect, useRef, useCallback } from "react";
import type { ChatMessage } from "./types";
import {
  ChatSummary,
  newChatId,
  listChats,
  getChat,
  saveChat,
  deleteChat,
} from "./chatStore";

export function useChatHistory(opts: {
  provider: string | null;
  messages: ChatMessage[];
  sessionId?: string;
  /** localStorage 里记「当前会话 id」的键;多 Agent 分页时每页一个 */
  storageKey?: string;
}) {
  const keyRef = useRef(opts.storageKey ?? "pcChatId");
  // 当前会话 ID，初值从 localStorage 读，没有就创建并写回
  const [conversationId, setConversationId] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(keyRef.current);
      if (stored && /^[A-Za-z0-9_-]{1,64}$/.test(stored)) {
        return stored;
      }
      const fresh = newChatId();
      localStorage.setItem(keyRef.current, fresh);
      return fresh;
    } catch {
      return newChatId();
    }
  });

  const [history, setHistory] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const saveTimerRef = useRef<number | null>(null);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const messagesRef = useRef(opts.messages);
  messagesRef.current = opts.messages;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const queryRef = useRef(query);
  queryRef.current = query;

  // 立即将当前会话存盘（如果有非 pending 的消息），并清理防抖计时器
  const flush = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const toSave = messagesRef.current.filter((m) => !m.pending);
    if (toSave.length > 0) {
      saveChat({
        id: conversationIdRef.current,
        provider: optsRef.current.provider || undefined,
        sessionId: optsRef.current.sessionId,
        messages: toSave,
      });
    }
  }, []);

  /**
   * 回退之后立刻把截断的那份整份写回归档,**空列表也写**。
   *
   * 保存接口本身是整份覆盖,截断后的非空列表走下面的防抖存盘就对了;但回退到第一条时
   * 消息是空的,防抖那边「为空不存」,归档里就还是回退前的整段 —— 非主页刷新回来会从归档
   * 把回退掉的消息原样找回来。这里不能改成「变空就存」:换项目时主页的消息也会变空而
   * 会话 id 不变,那样会把上一个项目的归档清掉。所以只让回退显式调这一个。
   */
  const overwrite = useCallback((messages: ChatMessage[]) => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    messagesRef.current = messages;
    void saveChat({
      id: conversationIdRef.current,
      provider: optsRef.current.provider || undefined,
      sessionId: optsRef.current.sessionId,
      messages: messages.filter((m) => !m.pending),
    });
  }, []);

  // 监听 messages 变化，防抖 800ms 自动存盘；messages 为空时不存(回退清空走 overwrite)
  useEffect(() => {
    const toSave = opts.messages.filter((m) => !m.pending);
    if (toSave.length === 0) return;

    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    const currentId = conversationId;
    saveTimerRef.current = window.setTimeout(() => {
      saveChat({
        id: currentId,
        provider: opts.provider || undefined,
        sessionId: opts.sessionId,
        messages: toSave,
      });
      saveTimerRef.current = null;
    }, 800);

    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [opts.messages, conversationId, opts.provider, opts.sessionId]);

  // 刷新会话历史列表
  const refresh = useCallback(async (customQuery?: string) => {
    const q = customQuery !== undefined ? customQuery : queryRef.current;
    setLoading(true);
    try {
      const items = await listChats(q);
      setHistory(items);
    } finally {
      setLoading(false);
    }
  }, []);

  // query 变化防抖 250ms 自动刷新
  useEffect(() => {
    const timer = window.setTimeout(() => {
      refresh(query);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, refresh]);

  // 打开历史会话：切换前先 flush 当前会话
  const openChat = useCallback(
    async (id: string): Promise<ChatMessage[] | null> => {
      flush();
      const chat = await getChat(id);
      if (chat) {
        setConversationId(id);
        try {
          localStorage.setItem(keyRef.current, id);
        } catch {
          /* 忽略本地存储写入失败 */
        }
        return chat.messages;
      }
      return null;
    },
    [flush]
  );

  // 开始新会话：切换前先 flush 当前会话
  const startNewChat = useCallback((): string => {
    flush();
    const nextId = newChatId();
    setConversationId(nextId);
    try {
      localStorage.setItem(keyRef.current, nextId);
    } catch {
      /* 忽略本地存储写入失败 */
    }
    return nextId;
  }, [flush]);

  // 删除指定会话：若删除的是当前会话则顺手 startNewChat
  const removeChat = useCallback(
    async (id: string) => {
      await deleteChat(id);
      if (id === conversationIdRef.current) {
        startNewChat();
      }
      await refresh();
    },
    [refresh, startNewChat]
  );

  return {
    conversationId,
    history,
    loading,
    query,
    setQuery,
    refresh,
    openChat,
    startNewChat,
    removeChat,
    flush,
    overwrite,
  };
}
