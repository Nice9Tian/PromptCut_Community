/**
 * The desktop app automatically becomes a render node for a shared project: the page side (semantics
 * `product/platforms.md`, "render node": "a desktop app that joins a shared project automatically
 * becomes a render node of that project"). For the editor process side see
 * `server/render-node-relay.mjs`, for the prerender process side see `server/auto-render-node.mjs`.
 *
 * The prerender process knows no shared project when it starts. When the page enters a shared project
 * it hands over that project's shared config, the same idea as the media upload queue
 * (`startUploadTarget` in `media/assetTiers.ts`):
 * - **Handoff**: when `bind` in `syncManager.ts` attaches a shared project it sends `POST /api/render-node/bind
 *   { url, projectId, contentId, assetBase?, ticket }`. `url` is the document service this page is
 *   connected to (cloud, LAN host or local, all the same), `ticket` is a connection ticket with the render
 *   role that this page signed on its own connection
 *   (`auth.ticket { kind: 'conn', role: 'render', owner: { kind: 'user' } }`).
 *   The project passphrase and `K` are not handed over.
 * - **Asset base**: once this page has picked the asset service of the current project
 *   (`assetTiers.ts`) it hands over again (for the same project only the base changes, no rebuild).
 * - **Ticket round trip**: each time the prerender process creates a new session it needs a fresh ticket
 *   (tickets expire after two minutes). The editor process sends
 *   `pc:render-node { type: 'ticket', reqId, projectId }` over HMR; if this page is connected to exactly
 *   that project it signs one and returns it via `POST /api/render-node/ticket`.
 * - **Revoke**: when this page leaves the project (back to the local space, cancels collaboration,
 *   opens another project) it sends `POST /api/render-node/unbind { projectId }`.
 *   Closing the page (or the desktop app moving to background mode) does not count as leaving: sessions
 *   already built keep being used until they disconnect, and are resumed when the page comes back
 *   (prerender process side).
 *
 * The online page has no editor process, so it does not hand over (`syncManager.ts` calls this only in
 * the desktop app). The developer switch `PROMPTCUT_AUTO_RENDER_NODE=0` is checked on the server.
 */

/** Online build pruning (see `src/online/pageFlag.ts` for the syntax): in the online build the whole `/api/render-node/*` call in this module is pruned away */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export interface RenderNodeBinding {
  url: string;
  projectId: string;
  /** The `id` of the project document (the one used by the layer table key `layers:<id>`) */
  contentId: string | null;
}

export interface RenderNodeHooks {
  /** Signs a render connection ticket on this page's shared project connection; throws if it cannot get one */
  ticket: (projectId: string) => Promise<string>;
}

export interface RenderNodeDeps {
  post?: (path: string, body: unknown) => Promise<Record<string, unknown> | null>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

async function defaultPost(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

let post: NonNullable<RenderNodeDeps["post"]> = defaultPost;
let setTimer: NonNullable<RenderNodeDeps["setTimer"]> = (fn, ms) => setTimeout(fn, ms);
let clearTimer: NonNullable<RenderNodeDeps["clearTimer"]> = (t) => clearTimeout(t as ReturnType<typeof setTimeout>);
let current: RenderNodeBinding | null = null;
let hooks: RenderNodeHooks | null = null;
let assetBase: string | null = null;
/** Whether this project's shared config has been handed over; before that, waits for this page to pick an asset service (at most ASSET_WAIT_MS) */
let sent = false;
/** Incremented on every leave or connection change; even with the same room ID, an async ticket from an old connection must not be reused. */
let generation = 0;
/** First wait for the old bind that was already sent to finish, then revoke/hand over the new bind, so the HTTP completion order cannot pull the node back to the old room. */
let bindingWrite: Promise<void> = Promise.resolve();
let waitTimer: unknown = null;
let lastAnswer: { at: number; ok: boolean; error?: string } | null = null;
const counters = { binds: 0, unbinds: 0, tickets: 0, ticketFailures: 0 };
/**
 * The first handoff waits until this page has picked an asset service (`startUploadTarget` in
 * `assetTiers.ts`, which also reports null once if it cannot pick one), for at most this long:
 * otherwise the prerender process does not know where to push at startup and first falls back to the
 * local asset service (probe A1 measurement).
 */
export const ASSET_WAIT_MS = 5_000;

/** For unit tests: replaces HTTP and the timers */
export function setRenderNodeDeps(deps: RenderNodeDeps): void {
  post = deps.post ?? defaultPost;
  setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
}

async function sendBind(withTicket: boolean): Promise<void> {
  if (ONLINE_BUILD) return;
  const b = current;
  if (!b) return;
  const epoch = generation;
  const signer = hooks;
  let ticket: string | null = null;
  if (withTicket && signer) {
    try { ticket = await signer.ticket(b.projectId); } catch { ticket = null; /* The prerender process asks again when it creates a session */ }
  }
  const write = bindingWrite.catch(() => undefined).then(async () => {
    const now = current;
    if (generation !== epoch || !now || now.url !== b.url || now.projectId !== b.projectId) return;
    counters.binds++;
    const r = await post("/api/render-node/bind", { url: now.url, projectId: now.projectId, contentId: now.contentId, ...(assetBase ? { assetBase } : {}), ...(ticket ? { ticket } : {}) });
    if (r && r.ok === false) console.warn("[render-node] shared config was not handed to the prerender process:", r.error ?? "no response");
  });
  bindingWrite = write;
  await write.catch(() => undefined);
}

/** First handoff (with a ticket) */
function sendFirst(): void {
  if (sent || !current) return;
  sent = true;
  if (waitTimer !== null) { clearTimer(waitTimer); waitTimer = null; }
  void sendBind(true);
}

/** The page has attached the shared project: hands the shared config to the prerender process (waits for this page to pick an asset service, at most ASSET_WAIT_MS) */
export function bindRenderNode(b: RenderNodeBinding, h: RenderNodeHooks): void {
  if (ONLINE_BUILD) return;
  hooks = h;
  const same = current && current.url === b.url && current.projectId === b.projectId;
  if (same) {
    // Same project: only the project document id arrived late (when joining someone else's project, the project in the store is replaced by the document service's copy a bit later), hand over again without signing another ticket
    if (current!.contentId === b.contentId || !b.contentId) return;
    current = { ...current!, contentId: b.contentId };
    if (sent) void sendBind(false);
    return;
  }
  if (waitTimer !== null) { clearTimer(waitTimer); waitTimer = null; }
  generation++;
  current = { ...b };
  assetBase = null;
  sent = false;
  waitTimer = setTimer(() => { waitTimer = null; sendFirst(); }, ASSET_WAIT_MS);
}

/** This page has picked (or changed) the asset service base of the current shared project; null = no remote asset service (this machine is the host, and the prerender process pushes to local) */
export function noteRenderNodeAssetBase(base: string | null): void {
  if (ONLINE_BUILD) return;
  const next = base ? base.replace(/\/+$/, "") : null;
  if (current && !sent) {
    assetBase = next;
    sendFirst();
    return;
  }
  if (next === assetBase) return;
  assetBase = next;
  if (current && next) void sendBind(false);
}

/** This page left this shared project: revoke (only for the same project; other pages on other projects are unaffected) */
export function unbindRenderNode(projectId: string, reason = "page-left"): void {
  if (ONLINE_BUILD) return;
  if (!current || current.projectId !== projectId) return;
  if (waitTimer !== null) { clearTimer(waitTimer); waitTimer = null; }
  generation++;
  current = null;
  assetBase = null;
  sent = false;
  // Revoke even if it left before handing over (while waiting for the asset service): this page may have handed over before a refresh (revoking one that does not exist is a no-op)
  counters.unbinds++;
  bindingWrite = bindingWrite.catch(() => undefined).then(async () => { await post("/api/render-node/unbind", { projectId, reason }); });
}

/** The prerender process asks for a ticket: answers only if this page is connected to exactly this project (with several pages, the first one to hand back counts) */
export async function answerRenderNodeTicket(d: Record<string, unknown>): Promise<void> {
  if (ONLINE_BUILD) return;
  const reqId = typeof d.reqId === "string" ? d.reqId : null;
  const b = current;
  if (!reqId || !b || b.projectId !== d.projectId || !hooks) return;
  const epoch = generation;
  const signer = hooks;
  let reply: Record<string, unknown>;
  try {
    reply = { reqId, ticket: await signer.ticket(b.projectId) };
    if (generation !== epoch || current?.projectId !== b.projectId || current.url !== b.url) return;
    counters.tickets++;
    lastAnswer = { at: Date.now(), ok: true };
  } catch (e) {
    if (generation !== epoch || current?.projectId !== b.projectId || current.url !== b.url) return;
    reply = { reqId, error: (e as Error).message };
    counters.ticketFailures++;
    lastAnswer = { at: Date.now(), ok: false, error: (e as Error).message };
  }
  await post("/api/render-node/ticket", reply);
}

/** Diagnostics (the probe reads `window.__pcRenderNodeHandoff`): does not contain the ticket */
export function renderNodeHandoffDiag() {
  return { bound: current ? { url: current.url, projectId: current.projectId, contentId: current.contentId } : null, sent, assetBase, counters: { ...counters }, lastAnswer };
}

/* HMR channel: the editor process asks for tickets through it. Only present in pages served by the dev server (the installed app is a dev server) */
if (!ONLINE_BUILD && typeof window !== "undefined" && import.meta.hot) {
  import.meta.hot.on("pc:render-node", (d: Record<string, unknown>) => {
    if (d?.type === "ticket") void answerRenderNodeTicket(d);
  });
  (window as unknown as { __pcRenderNodeHandoff?: () => unknown }).__pcRenderNodeHandoff = renderNodeHandoffDiag;
}
