/**
 * 卡片源码同步的页面一侧(C6.6 设计稿第 5 节;编辑器进程一侧在 `server/vite-plugin-cards.ts` 与 `server/card-sync.mjs`)。
 *
 * 同步本身在编辑器进程里做(它有文件、有改动层、有自己的一条文档服务连接),页面只做三件事:
 * - **绑定**:页面接上文档服务时(`syncManager.ts` 的 `bind`)告诉编辑器进程「我在哪个空间、项目用到哪些卡」
 *   (`POST /api/cards/sync/bind`);项目用到的卡变了(时间轴上添了卡)再报一次,新的用户卡 / 改过的内置卡会传上去;
 * - **票据**:共享项目里编辑器进程要一张 page 角色的连接票据(经 HMR 的 `pc:card-sync` `{ type: 'ticket' }`),
 *   页面在自己那条共享项目连接上签(`auth.ticket`),交回 `POST /api/cards/sync/ticket`;
 * - **提示**:装上了别人的版本、自己那份被覆盖(已备份)、覆盖了别人、装不上,都给气泡。
 *
 * 装上之后:编辑器进程照 edit_card 的做法热更新(页面换上新代码);热更新落地后本模块发页面事件 `pc-cards-synced`,
 * `ProbeGate.tsx` 收到后按当前项目重排一轮探针(身份键里的源码版本变了的卡补测,分派表跟着重算)——
 * 热更新虽然沿导入链重跑了探针模块,实测并不重排,所以要这一下。
 * **本模块不能静态引入那条链上的任何模块**(`probeRunner`、`costIdentity` 引了 `cardSourceFiles.mjs`,
 * 它把 `src/cards/**` 的源码全 glob 进来):一旦引了,`syncManager` 也成了每张卡的热更新祖先,
 * 改一张卡它就被重跑,页面的共享项目连接随之丢掉、退回本机空间(实测)。
 */
import type { Project } from "../../kernel/project";
import { usedCardIds, peekScopes } from "../cardScope";

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export interface CardSyncHooks {
  /**
   * 给一张 page 角色的连接票据(共享项目才会被要);拿不到就抛。
   * 账号云端项目的票据带到期时刻(连接只能用到那时,编辑器进程据此提前换会话)。
   */
  ticket: (projectId: string) => Promise<string | { ticket: string; expiresAt: number }>;
  /** 气泡 */
  toast: (text: string, tone: "info" | "warn", ms?: number) => void;
  /** 写入身份 → 显示名(「你」「Agent 对话 2」「bob」) */
  who: (actor: Record<string, unknown> | null | undefined) => string;
  /**
   * 断网期间改过、云端也被别人改过的一张卡(编辑器进程的同步在重连对账时交过来):放进「冲突合并」(`syncManager.ts`)。
   * 回 false 表示没放进去(没有待合并表),退回原来的覆盖提示。
   */
  conflict?: (c: { key: string; mine: string; cloud: string; rev: number; backup?: string }) => boolean;
}

interface Binding {
  kind: "local" | "shared";
  projectId: string;
  url: string;
  /**
   * 账号云端项目:票据是页面凭登录向账号会话接口取的那种(`accountCardSync.ts`),编辑器进程用账号办法的子协议连。
   * 其余(绑定时机、项目用到的卡、提示)与旧共享项目相同。
   */
  account?: boolean;
}

let hooks: CardSyncHooks | null = null;
let current: Binding | null = null;
let lastSent = "";
let cardIdsKey = "";
let bindingWrite: Promise<unknown> = Promise.resolve();
export function detachCardSync(): void {
  if (!current) return;
  current = null; hooks = null; lastSent = ""; cardIdsKey = "";
  bindingWrite = bindingWrite.catch(() => undefined).then(() => post("/api/cards/sync/unbind", {}));
}

/** 项目要带上的卡:时间轴上用到的(含卡片图里的节点)+ 归属表记在本项目名下的 */
export function projectCardIds(p: Project, projectId?: string | null): string[] {
  const ids = usedCardIds(p);
  const nodes = (p as { cardNodes?: unknown }).cardNodes;
  const list = Array.isArray(nodes) ? nodes : nodes && typeof nodes === "object" ? Object.values(nodes) : [];
  for (const n of list) {
    const id = (n as { cardId?: unknown })?.cardId;
    if (typeof id === "string" && id) ids.add(id);
  }
  const scopes = peekScopes();
  const pid = projectId ?? p.id;
  if (scopes && pid) for (const [cardId, e] of Object.entries(scopes)) if (e.scope === "project" && e.projectId === pid) ids.add(cardId);
  return [...ids].sort();
}

async function post(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

async function send(b: Binding, cardIds: string[]) {
  const body =
    b.kind === "local"
      ? { mode: "local" }
      : { mode: b.account ? "account" : "ticket", projectId: b.projectId, url: b.url, cardIds };
  const key = JSON.stringify(body);
  if (key === lastSent) return;
  lastSent = key;
  const pending = bindingWrite.catch(() => undefined).then(() => post("/api/cards/sync/bind", body));
  bindingWrite = pending;
  const j = await pending;
  if (!j?.ok) {
    if (lastSent === key) lastSent = "";
    console.warn("[cards] 卡片源码同步没绑上:", j?.error ?? "无回包");
  }
}

/** 页面换了空间(本机项目 / 共享项目):告诉编辑器进程 */
export function bindCardSync(b: Binding, project: Project, h: CardSyncHooks): void {
  hooks = h;
  current = b;
  const ids = projectCardIds(project, b.kind === "shared" ? b.projectId : project.id);
  cardIdsKey = ids.join(",");
  void send(b, ids);
}

/** 项目变了:用到的卡有变化才再报一次(只在共享项目里有意义) */
export function noteProjectForCardSync(project: Project): void {
  // 在线页面不绑(`syncManager.ts`),current 恒为空;在线构建里连同 /api/cards/sync/bind 剪掉(M8 遗留 L24,写法见 `src/online/pageFlag.ts`)
  if (ONLINE_BUILD) return;
  const b = current;
  if (!b || b.kind !== "shared") return;
  const ids = projectCardIds(project, b.projectId);
  const k = ids.join(",");
  if (k === cardIdsKey) return;
  cardIdsKey = k;
  void send(b, ids);
}

/** 装上之后等这次热更新落地(HMR 的 `vite:afterUpdate`,最多等 3 s)再请探针重排 */
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let waitingUpdate = false;
function afterSyncedInstall() {
  waitingUpdate = true;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(fireSynced, 3000);
}
function fireSynced() {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = null;
  if (!waitingUpdate) return;
  waitingUpdate = false;
  window.dispatchEvent(new Event("pc-cards-synced"));
}

const nameOf = (key: unknown) => {
  const s = String(key ?? "");
  return s.replace(/^src\//, "");
};

/** 编辑器进程送来的一条提示(HMR `pc:card-sync` 的 notice);开发模式的验收钩子也走这里 */
export function receiveCardSyncNotice(d: Record<string, unknown>): void {
  onNotice(d);
}

function onNotice(d: Record<string, unknown>) {
  const h = hooks;
  const file = nameOf(d.key);
  switch (d.type) {
    case "installed":
      afterSyncedInstall();
      if (!d.backup) h?.toast(`卡片 ${file} 已同步为 ${h.who(d.actor as Record<string, unknown>)} 的版本。`, "info", 5000);
      return;
    case "overwritten":
      h?.toast(
        `你对卡片 ${file} 的改动已被 ${h.who(d.actor as Record<string, unknown>)} 覆盖。你的版本已备份到 ${String(d.backup ?? "(没有备份)")}。`,
        "warn",
        10_000,
      );
      return;
    case "overwrote":
      h?.toast(`你覆盖了 ${h.who(d.previousActor as Record<string, unknown>)} 对卡片 ${file} 的改动。`, "info", 8000);
      return;
    case "rejected":
      h?.toast(`卡片 ${file} 没同步上:${String(d.error ?? "")}`, "warn", 10_000);
      return;
    case "conflict": {
      afterSyncedInstall();
      const ok = typeof d.key === "string" && typeof d.mine === "string" && typeof d.cloud === "string"
        && !!h?.conflict?.({ key: d.key, mine: d.mine, cloud: d.cloud, rev: Number(d.rev) || 0, ...(typeof d.backup === "string" ? { backup: d.backup } : {}) });
      if (!ok) h?.toast(`你断网时对卡片 ${file} 的改动和 ${h?.who(d.actor as Record<string, unknown>) ?? "别人"} 的改动冲突。已换成云端的版本，你的版本已备份到 ${String(d.backup ?? "(没有备份)")}。`, "warn", 10_000);
      return;
    }
    default:
      return;
  }
}

/**
 * 「冲突合并」里对一张卡点了「合并」:交给编辑器进程照我这边的源码装回本机并传上去(`server/card-sync.mjs` 的 takeMine)。
 * 在线构建里没有编辑器进程,回不支持(在线页面里不会出现卡片的冲突项:卡片源码同步只在桌面版跑)。
 */
export async function takeMineCard(key: string, source: string): Promise<{ ok: boolean; error?: string }> {
  if (ONLINE_BUILD) return { ok: false, error: "在线页面不能改卡片源码" };
  const j = await post("/api/cards/sync/take-mine", { key, source });
  return j?.ok ? { ok: true } : { ok: false, error: typeof j?.error === "string" ? j.error : "编辑器进程没有回应" };
}

async function onTicket(d: Record<string, unknown>) {
  const reqId = typeof d.reqId === "string" ? d.reqId : null;
  const b = current;
  // 不是本页面连着的共享项目:让别的页面答(多个页面时第一个交回的算数)
  if (!reqId || !b || b.kind !== "shared" || b.projectId !== d.projectId || !hooks) return;
  let reply: Record<string, unknown>;
  try {
    const t = await hooks.ticket(b.projectId);
    reply = typeof t === "string" ? { reqId, ticket: t } : { reqId, ticket: t.ticket, expiresAt: t.expiresAt };
  } catch (e) {
    reply = { reqId, error: (e as Error).message };
  }
  await post("/api/cards/sync/ticket", reply);
}

/* HMR 通道:编辑器进程经它要票据、送提示。只在开发服务器给的页面里有 */
if (typeof window !== "undefined" && import.meta.hot) {
  import.meta.hot.on("pc:card-sync", (d: Record<string, unknown>) => {
    if (d?.type === "ticket") void onTicket(d);
    else if (d?.type === "notice" && d.notice && typeof d.notice === "object") onNotice(d.notice as Record<string, unknown>);
    else if (d?.type === "changed") afterSyncedInstall();
  });
  // 热更新的模块刚换上,注册表里的源码随之更新;下一拍再发,免得探针读到半截
  import.meta.hot.on("vite:afterUpdate", () => {
    if (waitingUpdate) setTimeout(fireSynced, 50);
  });
}
