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
  /** The localStorage key that records the "current session id"; one per tab with multi-Agent tabs */
  storageKey?: string;
}) {
  const keyRef = useRef(opts.storageKey ?? "pcChatId");
  // The current session ID: the initial value is read from localStorage; if there is none, it is
  // created and written back
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

  // Immediately save the current session to disk (if there are non-pending messages), and clear the debounce timer
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
   * Right after a rollback, write the truncated copy back to the archive in full, **even when the list
   * is empty**.
   *
   * The save interface itself overwrites the whole copy, and a non-empty truncated list going through
   * the debounced save below is fine; but when rolling back to the first message the messages are
   * empty, the debounce side "does not save when empty", and the archive would still hold the whole
   * pre-rollback conversation: a non-main tab coming back after a refresh would find the rolled-back
   * messages again from the archive. This cannot be changed to "save as soon as it becomes empty":
   * when the project is switched the main tab's messages also become empty while the session id stays
   * the same, and that would wipe the previous project's archive. So only rollback calls this one
   * explicitly.
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

  // Watch messages for changes and auto-save with an 800 ms debounce; do not save when messages is
  // empty (clearing on rollback goes through overwrite)
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

  // Refresh the session history list
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

  // Auto-refresh when query changes, debounced by 250 ms
  useEffect(() => {
    const timer = window.setTimeout(() => {
      refresh(query);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, refresh]);

  // Open a historical session: flush the current session before switching
  const openChat = useCallback(
    async (id: string): Promise<ChatMessage[] | null> => {
      flush();
      const chat = await getChat(id);
      if (chat) {
        setConversationId(id);
        try {
          localStorage.setItem(keyRef.current, id);
        } catch {
          /* Ignore local storage write failures */
        }
        return chat.messages;
      }
      return null;
    },
    [flush]
  );

  // Start a new session: flush the current session before switching
  const startNewChat = useCallback((): string => {
    flush();
    const nextId = newChatId();
    setConversationId(nextId);
    try {
      localStorage.setItem(keyRef.current, nextId);
    } catch {
      /* Ignore local storage write failures */
    }
    return nextId;
  }, [flush]);

  // Delete the given session: if it is the current session, also call startNewChat
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
