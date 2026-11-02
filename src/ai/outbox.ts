/**
 * The cloud chat "offline outbox" (user decision, 2026-10-22; `docs/semantics/workflow/production.md`
 * "Cloud chat"):
 * a message sent while offline is queued here first; its bubble is shown as usual with "Will send
 * once the network is back" beneath it, and it is sent automatically when the network returns.
 * Before sending, it **asks the server afresh** for the most recent user message in this chat; if
 * that differs from the one the page saw at queue time (someone else, or another device of the
 * user's own, sent something while offline), it is not sent, and the bubble is marked "Send
 * failed" with a "Resend" button. No React; there are Node unit tests (`outbox.test.mjs`).
 *
 * Three things:
 *   - `createOutbox`: the pending list. Stored per account and project in the browser's local
 *     storage (survives a page refresh, [ruling] see the AGENT report), sent in queue order within
 *     the same chat;
 *   - `outboxVerdict`: compares the server's message list with the "most recent user message" seen
 *     at queue time and decides send / do not send / already arrived;
 *   - `createOutboxRunner`: when to try sending, and how long to wait before trying again after a
 *     failure (backoff), running only one pass at a time.
 *
 * Covers only the account mode of cloud chats; the desktop app's local Agent does not go through
 * here.
 */
import type { ChatAttachment } from "./types.ts";
import { tr } from "../i18n/index.ts";

export const DOC_LINK_DOWN_TEXT = tr("The connection to the document service is down, so Cloud Agent is unavailable for now. Try again once connected.");

interface CloudErrorShape {
  name: string;
  code: string;
  status: number;
  message: string;
}

function isCloudError(err: unknown): err is CloudErrorShape {
  return Boolean(
    err &&
      typeof err === "object" &&
      (err as { name?: unknown }).name === "CloudError" &&
      typeof (err as { code?: unknown }).code === "string" &&
      typeof (err as { status?: unknown }).status === "number" &&
      typeof (err as { message?: unknown }).message === "string",
  );
}

/**
 * At the moment of queuing, which was the most recent user message in this chat on the page.
 * `messageId`: the one the server already has (the document service's message number); `requestId`:
 * an earlier one queued on this page and not yet sent (once sent, the server's record carries the
 * same request id).
 * `null`: there was no user message in the chat at that time.
 */
export interface OutboxBaseline { messageId?: string; requestId?: string }

export interface OutboxOptions { model?: string; effort?: string; creativity?: string | null }

export type OutboxState = "queued" | "sending" | "failed";

export interface OutboxItem {
  /**
   * The request id of the send. Retries and resends of the same message all use it (the document
   * service deduplicates by request id: if the response of an attempt was lost but it did arrive,
   * sending again does not create an extra one)
   */
  requestId: string;
  /**
   * The number of its local bubble in the chat; defaults to `local-<requestId>` (a message that was
   * first sent online and only queued after going offline keeps the bubble from when send was clicked)
   */
  localId?: string;
  conversationId: string;
  text: string;
  attachments?: ChatAttachment[];
  /**
   * Model, thinking effort and creativity level are taken as they were when send was clicked (user
   * decision, 2026-10-18: a queued message uses the settings from the time it was sent)
   */
  options: OutboxOptions;
  baseline: OutboxBaseline | null;
  state: OutboxState;
  /** Text shown to the user when `failed` ("Send failed:" is already prepended) */
  error?: string;
  /**
   * How many attempts have failed to send because the connection could not be made; at 0 the bubble
   * being sent reads "Sending…", and after an attempt it keeps reading "Will send once the network is
   * back" (so it does not flicker back and forth)
   */
  tries?: number;
  createdAt: number;
}

/**
 * One entry in the server's message list (from the `messages` returned by the document service's
 * `get`; only these fields are used)
 */
export interface OutboxServerMessage { messageId?: unknown; requestId?: unknown; arrivalSeq?: unknown }

export type OutboxVerdict = "send" | "delivered" | "conflict";

/**
 * The few sentences the user can see (level-1 semantics text; for the rows to add to the error
 * lookup table see the AGENT report)
 */
/**
 * The "Resend" on a "Send failed" bubble: the bubble dispatches this window event (carrying the
 * bubble number), picked up by the cloud chat page that holds the pending list (desktop
 * `CloudAiPanel`, mobile `AgentChat`). It goes through an event rather than props: the bubble
 * component is memoized, and no extra changing function should be passed to it.
 */
export const OUTBOX_RESEND_EVENT = "pc-cloud-resend";

export const OUTBOX_TEXT = {
  /** The line under a queued bubble */
  queued: tr("Will be sent when the network is back"),
  /** A bubble that is not sent after all: new messages appeared in this chat while offline */
  conflict: tr("Send failed: new messages arrived in this chat while offline, so this one was not sent."),
  /** Not sent for other reasons (no permission, chat deleted, etc.): the reason follows */
  failed: (reason: string) => tr("Send failed: {0}", reason),
  resend: tr("Resend"),
} as const;

/**
 * At most this many entries are kept in the pending list of one account and one project ([ruling]
 * level 3, AGENT report number table)
 */
export const OUTBOX_MAX_ITEMS = 100;
/**
 * Backoff: how long to wait before retrying after the nth failed send. Starts at 2 seconds, doubles
 * each time, capped at 30 seconds ([ruling] level 3, AGENT report number table)
 */
export const outboxBackoff = (attempt: number) => Math.min(30_000, 2000 * 2 ** Math.max(0, attempt - 1));

/** The number of this message's local bubble in the chat */
export const outboxLocalId = (item: Pick<OutboxItem, "requestId" | "localId">) => item.localId ?? `local-${item.requestId}`;

/**
 * Local storage key: split by account and project. It does not share keys with the offline storage
 * of project changes (the conflict merge machinery)
 */
export const outboxKey = (accountId: string, projectId: string, tabId: string) => `pc.cloudOutbox:${accountId}:${projectId}:${tabId}`;

/**
 * Whether the error at the moment of clicking send is an "offline" one: the Cloud Agent service
 * cannot be reached (`network`), or the connection to the document service is down (fetching the
 * ticket or the delegation failed).
 * Only this kind is turned into queuing at send time; other errors are still marked "not sent" on
 * the spot.
 */
export function isOfflineError(err: unknown, browserOffline = false): boolean {
  if (browserOffline) return true;
  if (isCloudError(err)) return err.code === "network" || (err.code === "unavailable" && err.status === 0 && err.message === DOC_LINK_DOWN_TEXT);
  return err instanceof TypeError;
}

/**
 * Whether the error met when trying to send an already queued message is one that waiting could
 * fix: the offline kind, plus the server being temporarily unavailable (5xx) or too busy
 * (429 / busy).
 * These are kept and retried with backoff; others (no permission, chat deleted, quota full, notice
 * not confirmed) are not retried and are marked "Send failed".
 */
export function isTransientError(err: unknown, browserOffline = false): boolean {
  if (isOfflineError(err, browserOffline)) return true;
  if (isCloudError(err)) return err.status >= 500 || err.status === 429 || err.code === "busy";
  const status = Number((err as { status?: unknown } | null)?.status ?? NaN);
  return Number.isFinite(status) && (status === 0 || status >= 500 || status === 429);
}

type StorageLike = { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem?: (k: string) => void };

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function cleanBaseline(v: unknown): OutboxBaseline | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  const out: OutboxBaseline = {};
  if (str(b.messageId)) out.messageId = b.messageId;
  if (str(b.requestId)) out.requestId = b.requestId;
  return out.messageId || out.requestId ? out : null;
}

function cleanItem(v: unknown): OutboxItem | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  if (!str(x.requestId) || !str(x.conversationId) || typeof x.text !== "string") return null;
  const o = (x.options && typeof x.options === "object" ? x.options : {}) as Record<string, unknown>;
  const options: OutboxOptions = {
    ...(str(o.model) ? { model: o.model } : {}),
    ...(str(o.effort) ? { effort: o.effort } : {}),
    ...(typeof o.creativity === "string" || o.creativity === null ? { creativity: o.creativity as string | null } : {}),
  };
  // The one being sent before the refresh: it is unknown whether it arrived, so handle it as a queued
  // one (ask the server right before sending; if it already arrived, no extra copy is created)
  const state: OutboxState = x.state === "failed" ? "failed" : "queued";
  return {
    requestId: x.requestId, ...(str(x.localId) ? { localId: x.localId } : {}), conversationId: x.conversationId, text: x.text,
    ...(Array.isArray(x.attachments) && x.attachments.length ? { attachments: x.attachments as ChatAttachment[] } : {}),
    options, baseline: cleanBaseline(x.baseline), state,
    ...(state === "failed" && typeof x.error === "string" ? { error: x.error } : {}),
    ...(typeof x.tries === "number" && x.tries > 0 ? { tries: x.tries } : {}),
    createdAt: typeof x.createdAt === "number" ? x.createdAt : 0,
  };
}

/**
 * The pending list. If `storage` is given it is saved there (still present after a page refresh);
 * otherwise it lives in memory only. The order is the queue order; several messages in the same chat
 * are sent in this order. Every change replaces the array with a new one (subscribers judge by
 * reference whether it changed).
 */
export function createOutbox(opts: { storage?: StorageLike | null; key?: string } = {}) {
  const { storage, key } = opts;
  let items: OutboxItem[] = [];
  const listeners = new Set<() => void>();
  function load(): OutboxItem[] {
    if (!storage || !key) return [];
    try {
      const raw = storage.getItem(key);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.map(cleanItem).filter((x): x is OutboxItem => !!x).slice(-OUTBOX_MAX_ITEMS) : [];
    } catch { return []; }
  }
  items = load();
  function save() {
    if (!storage || !key) return;
    try {
      if (items.length) storage.setItem(key, JSON.stringify(items));
      else storage.removeItem?.(key);
    } catch { /* Cannot save: only effective within this page */ }
  }
  function set(next: OutboxItem[]) {
    items = next;
    save();
    for (const l of [...listeners]) l();
  }
  return {
    get items() { return items; },
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    get(requestId: string) { return items.find((x) => x.requestId === requestId) ?? null; },
    /**
     * The same tab changed the list in another browser tab (`storage` event): re-read it; the ones
     * currently being sent stay "sending"
     */
    reload() {
      const sending = new Set(items.filter((x) => x.state === "sending").map((x) => x.requestId));
      items = load().map((x) => (sending.has(x.requestId) && x.state === "queued" ? { ...x, state: "sending" as const } : x));
      for (const l of [...listeners]) l();
    },
    add(item: OutboxItem) {
      const rest = items.filter((x) => x.requestId !== item.requestId);
      set([...rest, item].slice(-OUTBOX_MAX_ITEMS));
    },
    update(requestId: string, patch: Partial<OutboxItem>) {
      if (!items.some((x) => x.requestId === requestId)) return;
      set(items.map((x) => {
        if (x.requestId !== requestId) return x;
        const next = { ...x, ...patch };
        if (next.state !== "failed") delete next.error;
        return next;
      }));
    },
    /**
     * Resend: move this entry to the end of the list (it is now the newest), replace its "most recent
     * message seen" with the new one, and set it back to queued.
     * The check is based on what is on the page at the moment Resend is clicked (semantics: by then the
     * most recent user message is already a new one).
     */
    requeue(requestId: string, baseline: OutboxBaseline | null) {
      const cur = items.find((x) => x.requestId === requestId);
      if (!cur) return;
      const { error: _drop, tries: _tries, ...rest } = cur;
      set([...items.filter((x) => x.requestId !== requestId), { ...rest, baseline, state: "queued" }]);
    },
    remove(requestId: string) {
      if (items.some((x) => x.requestId === requestId)) set(items.filter((x) => x.requestId !== requestId));
    },
  };
}
export type Outbox = ReturnType<typeof createOutbox>;

/**
 * When queuing a new message, the "most recent user message" it sees:
 * the one queued earlier on this page in the same chat that has not been sent yet (and has not
 * failed) takes priority (the user is looking at it in a bubble); if there is none, it is the most
 * recent already-sent user message on the page.
 */
export function baselineFor(items: readonly OutboxItem[], conversationId: string, lastSeen: OutboxBaseline | null, exclude?: string): OutboxBaseline | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const x = items[i];
    if (x.conversationId !== conversationId || x.requestId === exclude || x.state === "failed") continue;
    return { requestId: x.requestId };
  }
  return lastSeen;
}

/**
 * Send or not: compare the server's message list as of now (the document service's records, all
 * user messages) with what was seen at queue time.
 * - The list already contains this message's request id: it actually arrived earlier (the response
 *   was lost, or another browser tab sent it first) → `delivered` (sending again with the same
 *   request id only returns the original result and does not create an extra one);
 * - The most recent message is the same one that was seen (the message number matches, or the
 *   request id matches = the one queued earlier on this page has been sent) → `send`;
 * - There are no messages, and none were seen at queue time either → `send`;
 * - Anything else → `conflict`, do not send.
 */
export function outboxVerdict(messages: readonly OutboxServerMessage[] | null | undefined, item: Pick<OutboxItem, "requestId" | "baseline">): OutboxVerdict {
  const list = (messages ?? []).filter((m) => m && typeof m === "object");
  if (list.some((m) => m.requestId === item.requestId)) return "delivered";
  let latest: OutboxServerMessage | null = null;
  for (const m of list) {
    const seq = typeof m.arrivalSeq === "number" ? m.arrivalSeq : -Infinity;
    const best = latest && typeof latest.arrivalSeq === "number" ? latest.arrivalSeq : -Infinity;
    if (!latest || seq >= best) latest = m;
  }
  const base = item.baseline;
  if (!latest) return base ? "conflict" : "send";
  if (!base) return "conflict";
  if (base.messageId && latest.messageId === base.messageId) return "send";
  if (base.requestId && latest.requestId === base.requestId) return "send";
  return "conflict";
}

/** The result of one attempt to send a queued message */
export type OutboxAttempt =
  | { kind: "sent" }
  /** Still cannot connect (offline, service temporarily unavailable): keep it and retry after backoff */
  | { kind: "retry" }
  /** Not sent after all: `error` is the full sentence shown to the user ("Send failed:" already prepended) */
  | { kind: "failed"; error: string };

export interface OutboxRunnerDeps {
  outbox: Outbox;
  /** Try to send one: both the check and the send are inside (see useCloud.ts). Only one is tried at a time */
  attempt: (item: OutboxItem) => Promise<OutboxAttempt>;
  /**
   * The browser says it is offline (`navigator.onLine === false`): do not try; wait for the `online`
   * event or the next backoff
   */
  offline?: () => boolean;
  backoff?: (attempt: number) => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * When to try sending: `kick()` (network restored, event stream reconnected, page back in the
 * foreground, or a message just queued) runs a pass immediately; if some were not sent in this pass
 * (`retry`), the next pass is scheduled with backoff. Only one pass runs at a time; if it is called
 * again while running, another pass follows after it finishes.
 * Within the same chat, if the previous message has not been sent, the ones behind it do not jump
 * ahead of it.
 */
export function createOutboxRunner(deps: OutboxRunnerDeps) {
  const backoff = deps.backoff ?? outboxBackoff;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let running = false;
  let again = false;
  let stopped = false;
  let failures = 0;
  let timer: unknown = null;

  function schedule() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (stopped || !deps.outbox.items.some((x) => x.state === "queued")) return;
    failures++;
    timer = setTimer(() => { timer = null; void run(); }, backoff(failures));
  }

  async function pass(): Promise<boolean> {
    if (deps.offline?.()) return true;
    let retry = false;
    const blocked = new Set<string>();
    for (const head of [...deps.outbox.items]) {
      if (stopped) return false;
      const item = deps.outbox.get(head.requestId);
      if (!item || item.state !== "queued" || blocked.has(item.conversationId)) continue;
      deps.outbox.update(item.requestId, { state: "sending" });
      let out: OutboxAttempt;
      try { out = await deps.attempt({ ...item, state: "sending" }); }
      catch { out = { kind: "retry" }; }
      if (out.kind === "sent") deps.outbox.remove(item.requestId);
      else if (out.kind === "failed") deps.outbox.update(item.requestId, { state: "failed", error: out.error });
      else {
        deps.outbox.update(item.requestId, { state: "queued", tries: (item.tries ?? 0) + 1 });
        blocked.add(item.conversationId);
        retry = true;
      }
    }
    return retry;
  }

  async function run() {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const retry = await pass();
        if (!retry && !again) { failures = 0; if (timer !== null) { clearTimer(timer); timer = null; } }
        if (retry && !again) schedule();
      } while (again && !stopped);
    } finally { running = false; }
  }

  return {
    /**
     * Run a pass immediately (also cutting short any backoff in progress): network restored, connected,
     * back in the foreground, a message just queued
     */
    kick() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      failures = 0;
      return run();
    },
    stop() { stopped = true; if (timer !== null) { clearTimer(timer); timer = null; } },
    /** For unit tests */
    get busy() { return running; },
  };
}
export type OutboxRunner = ReturnType<typeof createOutboxRunner>;
