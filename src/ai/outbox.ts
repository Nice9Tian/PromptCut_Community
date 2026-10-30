/**
 * 云端对话的「断网待发」(2026-10-22 用户定,`docs/semantics/workflow/production.md`「云端对话」):
 * 断网时发的消息先排在这里,气泡照常显示、下面写「等网络恢复后发出」;网络恢复后自动发出。
 * 发出之前**向服务端现问一次**这个对话里最近一条用户消息,和排队时页面看到的那一条不一样(离线期间有别人或自己的其它设备发过)就不发,
 * 气泡标「发送失败」、带「重新发送」。没有 React,Node 里有单测(`outbox.test.mjs`)。
 *
 * 三样东西:
 *   - `createOutbox`:待发清单。按账号、项目存进浏览器本地存储(跨页面刷新存活,〔裁〕见 AGENT 报告),同一个对话里按排队先后发;
 *   - `outboxVerdict`:拿服务端的消息清单和排队时看到的「最近一条用户消息」比,定发 / 不发 / 已经到了;
 *   - `createOutboxRunner`:什么时候试着发、发不出去等多久再试(退避),一次只跑一遍。
 *
 * 只管云端对话的账号模式;桌面版本机 Agent 不走这里。
 */
import type { ChatAttachment } from "./types.ts";

export const DOC_LINK_DOWN_TEXT = "和文档服务的连接断着,云端 Agent 暂时用不了。连上后再试。";

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
 * 排队那一刻,页面上这个对话里最近一条用户消息是哪一条。
 * `messageId`:服务端已有的那条(文档服务的消息号);`requestId`:这一页更早排着、还没发出的那条(发出后服务端的记录上带着同一个请求号)。
 * `null`:那时对话里还没有任何用户消息。
 */
export interface OutboxBaseline { messageId?: string; requestId?: string }

export interface OutboxOptions { model?: string; effort?: string; creativity?: string | null }

export type OutboxState = "queued" | "sending" | "failed";

export interface OutboxItem {
  /** 发送的请求号。同一条消息重试、重新发送都用它(文档服务按请求号去重:丢了回包的那次真到了,再发不会多出一条) */
  requestId: string;
  /** 它在对话里那个本地气泡的号;缺省 `local-<requestId>`(先在线发、断网后才排进来的那条沿用点发送时那个气泡) */
  localId?: string;
  conversationId: string;
  text: string;
  attachments?: ChatAttachment[];
  /** 模型、思考强度、创造力按点发送那一刻的办(2026-10-18 用户定:排队的消息按发出时点的办) */
  options: OutboxOptions;
  baseline: OutboxBaseline | null;
  state: OutboxState;
  /** `failed` 时给用户看的话(已带「发送失败：」) */
  error?: string;
  /** 试过几次都因为连不上没发出去;0 次时正在发的气泡写「发送中…」,试过以后一直写「等网络恢复后发出」(不来回闪) */
  tries?: number;
  createdAt: number;
}

/** 服务端消息清单里的一条(文档服务 `get` 回的 `messages`,只用这几个字段) */
export interface OutboxServerMessage { messageId?: unknown; requestId?: unknown; arrivalSeq?: unknown }

export type OutboxVerdict = "send" | "delivered" | "conflict";

/** 用户看得到的几句话(一级语义的文字;出错对照表要补的行见 AGENT 报告) */
/**
 * 「发送失败」气泡上的「重新发送」:气泡发这个窗口事件(带气泡号),由持有待发清单的云端对话页接
 * (桌面 `CloudAiPanel`、手机 `AgentChat`)。走事件不走 props:气泡组件是 memo 的,不多传一个会变的函数。
 */
export const OUTBOX_RESEND_EVENT = "pc-cloud-resend";

export const OUTBOX_TEXT = {
  /** 排着的气泡下面那一行 */
  queued: "等网络恢复后发出",
  /** 不发了的气泡:离线期间这个对话里有了新消息 */
  conflict: "发送失败：断网期间这个对话里有了新消息，这条没有发出。",
  /** 其它原因没发出去(没权限、对话被删等):后面接原因 */
  failed: (reason: string) => `发送失败：${reason}`,
  resend: "重新发送",
} as const;

/** 一个账号、一个项目的待发清单最多留这么多条(〔裁〕三级,AGENT 报告数字表) */
export const OUTBOX_MAX_ITEMS = 100;
/** 退避:第 n 次没发出去后等多久再试。2 秒起、每次翻倍、封顶 30 秒(〔裁〕三级,AGENT 报告数字表) */
export const outboxBackoff = (attempt: number) => Math.min(30_000, 2000 * 2 ** Math.max(0, attempt - 1));

/** 这条在对话里那个本地气泡的号 */
export const outboxLocalId = (item: Pick<OutboxItem, "requestId" | "localId">) => item.localId ?? `local-${item.requestId}`;

/** 本地存储的键:按账号、项目分。和项目改动的离线存储(冲突合并那一套)不共用键 */
export const outboxKey = (accountId: string, projectId: string, tabId: string) => `pc.cloudOutbox:${accountId}:${projectId}:${tabId}`;

/**
 * 点发送那一下的错是不是「断网」:连不上云端 Agent 服务(`network`),或和文档服务的连接断着(取票据、取委托失败)。
 * 只有这一类在点发送时转成排着;别的错照旧当场标「没有发出去」。
 */
export function isOfflineError(err: unknown, browserOffline = false): boolean {
  if (browserOffline) return true;
  if (isCloudError(err)) return err.code === "network" || (err.code === "unavailable" && err.status === 0 && err.message === DOC_LINK_DOWN_TEXT);
  return err instanceof TypeError;
}

/**
 * 已经排着的那条试发时遇到的错,是不是等一等还能发:断网一类,加上服务端暂时不可用(5xx)、太忙(429 / busy)。
 * 这些留着按退避再试;别的(没权限、对话被删、满额、告知没确认)不再试,标「发送失败」。
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
  // 刷新前正在发的那条:不知道发没发到,当排着的办(发之前现问服务端,已经到了就不会再多一条)
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
 * 待发清单。`storage` 给了就存进去(刷新页面后还在),没给只在内存里。
 * 顺序就是排队的先后;同一个对话里的几条按这个顺序发。改动一律换新数组(订阅方按引用判断变没变)。
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
    } catch { /* 存不了:只在这次页面里有效 */ }
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
    /** 同一个页签在别的浏览器标签页里改了清单(`storage` 事件):重读,正在发的那几条保持「正在发」 */
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
     * 重新发送:把这条挪到清单末尾(它现在是最新的一条)、换上新的「看到的最近一条」、改回排着。
     * 核对以点重新发送这一刻页面上的为准(语义:这时最近一条用户消息已经是新的了)。
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
 * 排一条新消息时,它「看到的最近一条用户消息」:
 * 这一页在同一个对话里更早排着、还没发出(也没失败)的那条优先(用户看着它在气泡里);没有就是页面上最近一条已发出的用户消息。
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
 * 发不发:拿服务端此刻的消息清单(文档服务的记录,都是用户消息)和排队时看到的比。
 * - 清单里已经有这条的请求号:它其实早到了(丢了回包、或别的标签页先发了)→ `delivered`(用同一个请求号再发一次只会拿回原来的结果,不会多一条);
 * - 最近一条和看到的是同一条(消息号对得上,或请求号对得上 = 这一页更早排的那条已经发出)→ `send`;
 * - 都没有消息、排队时也没看到任何消息 → `send`;
 * - 其它 → `conflict`,不发。
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

/** 一条排着的消息试发一次的结果 */
export type OutboxAttempt =
  | { kind: "sent" }
  /** 还连不上(断网、服务暂时不可用):留着,退避后再试 */
  | { kind: "retry" }
  /** 不发了:`error` 是给用户看的整句(已带「发送失败：」) */
  | { kind: "failed"; error: string };

export interface OutboxRunnerDeps {
  outbox: Outbox;
  /** 试发一条:核对 + 发送都在里面(见 useCloud.ts)。同一时刻只会有一条在试 */
  attempt: (item: OutboxItem) => Promise<OutboxAttempt>;
  /** 浏览器说自己断网了(`navigator.onLine === false`):不试,等 `online` 事件或下一次退避 */
  offline?: () => boolean;
  backoff?: (attempt: number) => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * 什么时候试着发:`kick()`(网络恢复、事件流重新连上、页面回到前台、刚排了一条)就马上跑一遍;
 * 这一遍里有没发出去的(`retry`)就按退避排下一遍。同一时刻只跑一遍,跑的时候又被叫就跑完再来一遍。
 * 同一个对话里前一条还没发出去,后面的不越过它。
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
    /** 马上跑一遍(退避中的也提前):网络恢复、连上了、回到前台、刚排了一条 */
    kick() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      failures = 0;
      return run();
    },
    stop() { stopped = true; if (timer !== null) { clearTimer(timer); timer = null; } },
    /** 单测用 */
    get busy() { return running; },
  };
}
export type OutboxRunner = ReturnType<typeof createOutboxRunner>;
