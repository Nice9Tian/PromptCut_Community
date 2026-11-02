/**
 * The Cloud Agent of the project currently connected in Vibe mode: the chat list ("Project Agents" in the
 * sidebar), the messages of the current chat, send, stop, shared / private.
 *
 * The business logic always reuses the same set as the editor's right rail and the mobile app
 * (`useCloudChat` in `src/ai/cloud/useCloud.ts`, done the way `src/mobile/AgentChat.tsx` does it):
 *   - Before sending, it first goes through the "host-can-read notice" (`product/agent.md` "Host-can-read
 *     notice"): a dialog pops up on first use, sending happens only after choosing "Got it", and the
 *     choice is remembered per account;
 *   - Sending is shown optimistically: your own bubble appears the moment you click, and when it cannot
 *     be sent that bubble is marked "Not sent" and the original text is put back in the input box; when
 *     offline, messages queue up and wait for the network to recover;
 *   - Chat permissions (who can send, who can stop, who can switch shared / private) follow
 *     `cloudConversationControlPolicy`, and read-only members (a guest in someone else's project) cannot
 *     send;
 *   - The chats listed in the sidebar come from the same history list and are checked again against the
 *     shared / private rules (`viewableChats` in `vibeOrg.ts`); other people's private chats are not
 *     listed.
 *
 * It has content only after a project is connected: when no project is connected the key of
 * `useCloudChat` is empty and no request is sent at all.
 * The records of the before / after pictures of changes (right side panel) set their read scope by the
 * current chat (`setCloudVisualScope` in `ToolVisual.tsx`).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useCloudAgent, useCloudChat, type CloudAgentState, type CloudChat } from "../ai/extensions";
import { CloudError, cloudConversationControlPolicy, cloudErrorText } from "../ai/extensions";
import { cloudTicket } from "../ai/extensions";
import { acceptCloudConsent, cloudConsentState, refreshCloudConsent, subscribeCloudConsent } from "../ai/extensions";
import { OUTBOX_RESEND_EVENT } from "../ai/outbox";
import { isIdleHead } from "../ai/chatTypes";
import { useSync } from "../editor/sync/syncManager";
import { useReadOnly } from "../editor/readOnly";
import { setCloudVisualScope } from "../editor/right/ToolVisual";
import { viewableChats } from "./vibeOrg";
import type { VibeAgent } from "./vibeAgent";
import type { VibeChat } from "./types";
import { tr } from "../i18n/index.ts";

/** The chat tab number this set occupies (the local storage keys of `useCloudChat` are split by it): unrelated to the tabs of the editor's right rail and the mobile app */
export const VIBE_TAB = "vibe";

/** The Cloud Agent's version. The chat page only recognizes `VibeAgent` (the desktop app's version is in `useVibeLocal.ts`); what is extra here is what only the cloud has */
export interface VibeCloud extends VibeAgent {
  cloud: CloudAgentState;
  chat: CloudChat;
  /** The chats listed under this project in the sidebar (already re-checked against permissions); the current new chat that has not sent a message yet is in there too (`fresh`) */
  chats: VibeChat[];
  /** The chat being viewed */
  current: VibeChat | null;

  canSwitchVisibility: boolean;
  toggleVisibility: () => Promise<void>;
}

export function useVibeCloud(o: { connected: boolean; shown: boolean }): VibeCloud {
  const cloud = useCloudAgent();
  const consent = useSyncExternalStore(subscribeCloudConsent, cloudConsentState, cloudConsentState);
  const creator = useSync((s) => s.shared?.creator === true);
  const ro = useReadOnly();
  const chat = useCloudChat({ tabId: VIBE_TAB, cloud, enabled: o.connected, autoAttach: false, outbox: true });
  const { view } = chat;
  const projectId = o.connected ? cloud.projectId : null;

  const qKey = `${cloud.accountId ?? "none"}:${consent.bindingVersion}:${projectId ?? "none"}`;
  const keyRef = useRef(qKey);
  keyRef.current = qKey;
  const stillCurrent = () => keyRef.current === qKey &&
    cloudConsentState().accountId === cloud.accountId && cloudConsentState().bindingVersion === consent.bindingVersion;

  /* ---------- Notice (same as the mobile app and the desktop right rail) ---------- */
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  useEffect(() => {
    if (!o.shown || !projectId || !cloud.available || !consent.accountId || consent.accountId !== cloud.accountId) return;
    let dead = false;
    void refreshCloudConsent().then(
      (accepted) => { if (!dead) setConsentOpen(!accepted && cloudConsentState().accepted !== true); },
      (error) => { if (!dead && cloudConsentState().accepted !== true) setConsentError(error instanceof Error ? error.message : tr("The cloud account is temporarily unavailable.")); },
    );
    return () => { dead = true; };
  }, [o.shown, projectId, cloud.available, cloud.accountId, consent.accountId, consent.bindingVersion]);
  useEffect(() => { setConsentOpen(false); setConsentError(null); }, [qKey]);

  const admit = async (): Promise<boolean | "queue"> => {
    if (!stillCurrent()) return false;
    if (!cloud.accountId || consent.accountId !== cloud.accountId) { setConsentError(tr("Please sign in to the account for the current project first.")); return false; }
    const expected = { accountId: cloud.accountId, bindingVersion: consent.bindingVersion };
    try {
      const accepted = await refreshCloudConsent(expected);
      if (!stillCurrent()) return false;
      if (!accepted) { setConsentError(null); setConsentOpen(true); }
      return accepted;
    } catch (error) {
      if (!stillCurrent()) return false;
      if (chat.outbox.transient(error)) return "queue";
      setConsentError(error instanceof Error ? error.message : tr("The cloud account is temporarily unavailable."));
      setConsentOpen(true);
      return false;
    }
  };

  /* ---------- Permissions ---------- */
  const currentMeta = chat.history.items.find((item) => item.id === chat.conversationId) ?? null;
  const policy = cloudConversationControlPolicy({
    accountMode: cloud.accountMode, accountId: cloud.accountId, creator, conversation: currentMeta,
    queue: view.queue, senders: view.senders, legacyStreaming: view.streaming,
  });
  const off = !cloud.enabled || chat.info?.enabled === false;
  const whyNot = !projectId ? tr("No project is open yet.")
    : !cloud.available ? tr("The hosted side of this project has no Cloud Agent service.")
    : off ? cloudErrorText("disabled")
    : ro.locked ? tr("You can only view this project, not send messages to the Cloud Agent.")
    : policy.creatorReadOnly ? tr("This is another member's private chat: the project creator can view it but cannot send messages in it.")
    : view.revoked ? tr("You no longer have read access to this chat.")
    : null;

  /* ---------- Chats the sidebar needs ---------- */
  const chats = useMemo(() => {
    if (!projectId) return [];
    const list = viewableChats(chat.history.items, { accountId: cloud.accountId, creator }, projectId);
    // The server does not have a just-opened new chat yet: list it on this page first; after the first message is sent it will be in the list
    if (chat.conversationId && !list.some((c) => c.id === chat.conversationId)) {
      list.unshift({ id: chat.conversationId, name: chat.messages.length ? tr("Cloud chat") : tr("New chat"), projectId, state: "idle", visibility: "shared", readOnly: false, fresh: true });
    }
    return list;
  }, [chat.history.items, chat.conversationId, chat.messages.length, projectId, cloud.accountId, cloud.accountMode, creator, consent.accepted]);
  const current = chats.find((c) => c.id === chat.conversationId) ?? null;

  /* ---------- Before / after picture records: set the read scope by the current chat ---------- */
  useEffect(() => {
    if (!projectId || !cloud.url || !chat.conversationId) { setCloudVisualScope(null); return; }
    setCloudVisualScope({
      baseUrl: cloud.url, projectId, conversationId: chat.conversationId, accountId: cloud.accountId,
      visibility: currentMeta?.visibility, revoked: view.revoked === true, ticket: cloudTicket,
    });
  }, [projectId, cloud.url, cloud.accountId, chat.conversationId, currentMeta?.visibility, view.revoked]);
  useEffect(() => () => setCloudVisualScope(null), []);

  /* ---------- Resend on the "Not sent" bubble ---------- */
  const resendRef = useRef(chat.outbox.resend);
  resendRef.current = chat.outbox.resend;
  useEffect(() => {
    const onResend = (ev: Event) => {
      const id = (ev as CustomEvent).detail?.id;
      if (typeof id === "string") resendRef.current(id);
    };
    window.addEventListener(OUTBOX_RESEND_EVENT, onResend as EventListener);
    return () => window.removeEventListener(OUTBOX_RESEND_EVENT, onResend as EventListener);
  }, []);

  /* ---------- Send, stop, shared / private ---------- */
  const send = async (text: string): Promise<boolean> => {
    const body = text.trim();
    if (!body) return false;
    if (whyNot) { chat.notify(whyNot); return false; }
    if (!cloud.accountMode) {
      if (await admit() !== true) return false;
      return chat.send(body);
    }
    const staged = chat.stage(body);
    if (staged && (chat.outbox.offline() || chat.outbox.mustQueue()) && chat.outbox.enqueue(body, undefined, staged)) return true;
    const admitted = await admit();
    if (admitted === "queue" && staged && stillCurrent() && chat.outbox.enqueue(body, undefined, staged)) return true;
    if (admitted !== true || !stillCurrent()) {
      if (staged) chat.failStaged(staged, tr("Read and confirm the notice before using Cloud Agent."));
      return false;
    }
    const ok = await chat.send(body, undefined, staged ?? undefined, null, { queueOnNetwork: true });
    return stillCurrent() && ok;
  };

  const reqRef = useRef<{ key: string; id: string } | null>(null);
  const requestId = (key: string) => {
    if (reqRef.current?.key !== key) reqRef.current = { key, id: crypto.randomUUID() };
    return reqRef.current.id;
  };
  const stop = async () => {
    if (!cloud.accountMode) { await chat.abort(); return; }
    if (!policy.canStop || !policy.currentRunId) { chat.notify(tr("You can only stop tasks you started.")); return; }
    try {
      await chat.abort(policy.currentRunId, requestId(`stop:${policy.currentRunId}`));
      reqRef.current = null;
      void chat.history.refresh();
    } catch (error) {
      chat.notify(error instanceof Error ? error.message : tr("The stop request failed. You can click again."));
    }
  };
  const toggleVisibility = async () => {
    if (!policy.canSwitchVisibility || !currentMeta) return;
    const target = currentMeta.visibility === "private" ? "shared" : "private";
    try {
      await chat.switchVisibility(target, requestId(`vis:${chat.conversationId}:${target}`));
      reqRef.current = null;
      await chat.history.refresh();
    } catch (error) {
      chat.notify(error instanceof CloudError ? error.message : tr("Couldn't switch for now. You can click again."));
    }
  };

  const banner = view.connection === "reconnecting"
    ? tr("The connection to the Cloud Agent was lost. Reconnecting. The current turn in the cloud is still running, and the missed progress will be filled in once reconnected.")
    : chat.notice;

  return {
    cloud, chat, chats, current,
    me: cloud.accountId, projectId: cloud.projectId,
    hint: tr("Runs in the cloud and keeps going after you close it; reopen to pick up where you left off."),
    canSend: !whyNot, whyNot,
    streaming: policy.streaming, canStop: policy.canStop,
    // Counted the same way as the editor's right rail (`QueueList.tsx`): when the execution service is polling, the first message in an idle chat starts right away and does not count as queued
    queued: view.queue?.items.filter((i) => i.state === "queued" && !(chat.info?.executorMounted === true && isIdleHead(view.queue, i))).length ?? 0,
    waitingExecutor: cloud.accountMode && !!chat.info && chat.info.executorMounted !== true,
    consent: {
      open: o.shown && consentOpen && Boolean(consent.accountId) && consent.accountId === cloud.accountId,
      pending: consent.pending, error: consentError,
      accept: () => {
        void acceptCloudConsent().then(
          () => { setConsentError(null); setConsentOpen(false); },
          (error) => setConsentError(error instanceof Error ? error.message : tr("The cloud account is temporarily unavailable.")),
        );
      },
      reject: () => { setConsentError(null); setConsentOpen(false); },
    },
    send, stop,
    canSwitchVisibility: policy.canSwitchVisibility,
    toggleVisibility,
    banner,
    clearBanner: chat.clearNotice,
  };
}
