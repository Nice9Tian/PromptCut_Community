/**
 * The page side of card source sync (C6.6 design draft, section 5; the editor process side is in
 * `server/vite-plugin-cards.ts` and `server/card-sync.mjs`).
 *
 * The sync itself runs in the editor process (it has the files, the change layer, and its own connection
 * to the document service). The page only does three things:
 * - **Binding**: when the page connects to the document service (`bind` in `syncManager.ts`), it tells the
 *   editor process "which space I am in and which cards the project uses" (`POST /api/cards/sync/bind`);
 *   when the cards the project uses change (a card is added on the timeline) it reports again, and new
 *   user cards / modified built-in cards are uploaded;
 * - **Ticket**: in a shared project the editor process needs a connection ticket with the page role (via
 *   HMR `pc:card-sync` `{ type: 'ticket' }`); the page signs it on its own shared-project connection
 *   (`auth.ticket`) and hands it back to `POST /api/cards/sync/ticket`;
 * - **Notices**: someone else's version was installed, your own copy was overwritten (and backed up), you
 *   overwrote someone else's, or installing failed: each gives a bubble.
 *
 * After installing: the editor process hot-updates the same way edit_card does (the page swaps in the new
 * code); once the hot update lands, this module emits the page event `pc-cards-synced`, and `ProbeGate.tsx`,
 * on receiving it, re-schedules a round of probes for the current project (cards whose source version in
 * the identity key changed are re-measured, and the dispatch table is recomputed accordingly) —
 * although the hot update re-runs the probe modules along the import chain, in practice it does not
 * re-schedule, so this extra step is needed.
 * **This module must not statically import any module on that chain** (`probeRunner`, and `costIdentity`
 * which imports `cardSourceFiles.mjs`, which globs in all the source of `src/cards/**`): once it does,
 * `syncManager` also becomes a hot-update ancestor of every card, so editing one card re-runs it, the
 * page's shared-project connection is dropped as a result, and it falls back to the local space (observed).
 */
import type { Project } from "../../kernel/project";
import { usedCardIds, peekScopes } from "../cardScope";
import { tr } from "../../i18n/index.ts";

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export interface CardSyncHooks {
  /**
   * Gets a connection ticket with the page role (only requested for shared projects); throws if it cannot be obtained.
   * The ticket of an account cloud project carries an expiry time (the connection is only usable until then,
   * and the editor process uses it to renew the session ahead of time).
   */
  ticket: (projectId: string) => Promise<string | { ticket: string; expiresAt: number }>;
  /** Bubble */
  toast: (text: string, tone: "info" | "warn", ms?: number) => void;
  /** Write identity → display name ("You", "Agent chat 2", "bob") */
  who: (actor: Record<string, unknown> | null | undefined) => string;
  /**
   * A card that was changed during the disconnection and was also changed by someone else in the cloud (the
   * editor process's sync hands it over when reconciling on reconnect): put it into "Merge conflicts"
   * (`syncManager.ts`). Returns false if it was not put in (there is no pending-merge table), falling back to
   * the original overwrite notice.
   */
  conflict?: (c: { key: string; mine: string; cloud: string; rev: number; backup?: string }) => boolean;
}

interface Binding {
  kind: "local" | "shared";
  projectId: string;
  url: string;
  /**
   * Account cloud project: the ticket is the kind the page fetches from the account session API using its
   * login (`accountCardSync.ts`), and the editor process connects with the account method's subprotocol.
   * The rest (binding timing, the cards the project uses, notices) is the same as for the old shared project.
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

/** Cards the project must carry: those used on the timeline (including nodes in the card graph) + those the ownership table records under this project's name */
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
    console.warn("[cards] Card source sync did not bind:", j?.error ?? "no response");
  }
}

/** The page changed space (local project / shared project): tell the editor process */
export function bindCardSync(b: Binding, project: Project, h: CardSyncHooks): void {
  hooks = h;
  current = b;
  const ids = projectCardIds(project, b.kind === "shared" ? b.projectId : project.id);
  cardIdsKey = ids.join(",");
  void send(b, ids);
}

/** The project changed: report again only if the cards it uses changed (only meaningful in a shared project) */
export function noteProjectForCardSync(project: Project): void {
  // Online pages do not bind (`syncManager.ts`), so current is always empty; in the online build it is pruned together with /api/cards/sync/bind (M8 leftover L24, see `src/online/pageFlag.ts` for how it is written)
  if (ONLINE_BUILD) return;
  const b = current;
  if (!b || b.kind !== "shared") return;
  const ids = projectCardIds(project, b.projectId);
  const k = ids.join(",");
  if (k === cardIdsKey) return;
  cardIdsKey = k;
  void send(b, ids);
}

/** After installing, wait for this hot update to land (HMR `vite:afterUpdate`, up to 3 s) before asking the probes to re-schedule */
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

/** A notice sent by the editor process (the notice of HMR `pc:card-sync`); the dev-mode acceptance-check hook also goes through here */
export function receiveCardSyncNotice(d: Record<string, unknown>): void {
  onNotice(d);
}

function onNotice(d: Record<string, unknown>) {
  const h = hooks;
  const file = nameOf(d.key);
  switch (d.type) {
    case "installed":
      afterSyncedInstall();
      if (!d.backup) h?.toast(tr("Card {0} synced to the version by {1}.", file, h.who(d.actor as Record<string, unknown>)), "info", 5000);
      return;
    case "overwritten":
      h?.toast(
        tr("Your changes to card {0} were overwritten by {1}. Your version was backed up to {2}.", file, h.who(d.actor as Record<string, unknown>), String(d.backup ?? tr("(no backup)"))),
        "warn",
        10_000,
      );
      return;
    case "overwrote":
      h?.toast(tr("You overwrote {0}'s changes to card {1}.", h.who(d.previousActor as Record<string, unknown>), file), "info", 8000);
      return;
    case "rejected":
      h?.toast(tr("Card {0} was not synced: {1}", file, String(d.error ?? "")), "warn", 10_000);
      return;
    case "conflict": {
      afterSyncedInstall();
      const ok = typeof d.key === "string" && typeof d.mine === "string" && typeof d.cloud === "string"
        && !!h?.conflict?.({ key: d.key, mine: d.mine, cloud: d.cloud, rev: Number(d.rev) || 0, ...(typeof d.backup === "string" ? { backup: d.backup } : {}) });
      if (!ok) h?.toast(tr("Your changes to card {0} while offline conflict with the changes by {1}. It was replaced with the cloud version, and your version was backed up to {2}.", file, h?.who(d.actor as Record<string, unknown>) ?? tr("Someone else"), String(d.backup ?? tr("(no backup)"))), "warn", 10_000);
      return;
    }
    default:
      return;
  }
}

/**
 * Clicking "Merge" on a card in "Merge conflicts": hands it to the editor process to install back locally
 * from my side's source and upload it (takeMine in `server/card-sync.mjs`).
 * The online build has no editor process, so it returns unsupported (no card conflict items appear on
 * online pages: card source sync only runs in the desktop app).
 */
export async function takeMineCard(key: string, source: string): Promise<{ ok: boolean; error?: string }> {
  if (ONLINE_BUILD) return { ok: false, error: tr("The online page cannot edit card source") };
  const j = await post("/api/cards/sync/take-mine", { key, source });
  return j?.ok ? { ok: true } : { ok: false, error: typeof j?.error === "string" ? j.error : tr("The editor process did not respond") };
}

async function onTicket(d: Record<string, unknown>) {
  const reqId = typeof d.reqId === "string" ? d.reqId : null;
  const b = current;
  // Not the shared project this page is connected to: let other pages answer (with several pages, the first one to respond counts)
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

/* HMR channel: the editor process uses it to request tickets and send notices. Only present in pages served by the dev server */
if (typeof window !== "undefined" && import.meta.hot) {
  import.meta.hot.on("pc:card-sync", (d: Record<string, unknown>) => {
    if (d?.type === "ticket") void onTicket(d);
    else if (d?.type === "notice" && d.notice && typeof d.notice === "object") onNotice(d.notice as Record<string, unknown>);
    else if (d?.type === "changed") afterSyncedInstall();
  });
  // The hot-updated module was just swapped in and the source in the registry updates with it; send on the next tick so the probes do not read a half-updated state
  import.meta.hot.on("vite:afterUpdate", () => {
    if (waitingUpdate) setTimeout(fireSynced, 50);
  });
}
