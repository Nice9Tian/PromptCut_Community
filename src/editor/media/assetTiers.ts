/**
 * The two media tiers on the page side (`docs/plan/c66-design.md` section 4; task brief
 * `docs/plan/cloud-task.md` A1, "tier-switch criterion"):
 *
 * - **Polling**: every 2 seconds, ask **the current connection's asset service** with
 *   `GET media/<hash>/chunks`, and hand the set of hashes reported as `complete` to the tier-switch
 *   criterion (`chooseTier` in `src/render/mediaTier.ts`): the stage receives it via `setLocalHashes`, and
 *   the main document's audio layer reads it directly. Only the tier that has not reached the top tier is
 *   polled: once the original-size asset has fully arrived, that asset is no longer polled; hashes are
 *   immutable, so one that has fully arrived never reverts. When connected to the local asset service, the
 *   request goes to this machine's `/api/asset`; inside a shared project it goes to that project's remote
 *   asset service (with a read-only asset ticket). Whether the local cache has been written to disk is not
 *   a criterion (`docs/semantics/mechanism/asset-service.md`, "Sync state only asks the asset service").
 * - **Remote asset service**: set by `syncManager` when entering a shared project (`connectSharedAssets`),
 *   which also tells the local editor process (`POST /api/media/remote`), so that the read route fetches on
 *   demand and the prefetch queue starts moving. The ticket is pushed again after it is renewed on schedule.
 * - **Upload target**: when entering a shared project, the remote asset service base URL and an `rw` asset
 *   ticket are handed to the editor process's upload queue (`POST /api/media/upload-queue/target`), renewed
 *   when 1/3 of the validity period remains; on leaving, `{ base: null }` is pushed (design doc section 9,
 *   item 1).
 * - **Prefetch**: when the project's asset table changes (opening a project, importing) and a remote asset
 *   service is connected, the `prefetchOrder` manifest is handed to the editor process.
 * - **Pre-export gate**: `exportGate` asks the current asset service which original-size assets used on the
 *   timeline are not yet `complete`.
 *
 * The set carries a marker (`TIERS_KNOWN_LOCAL` / `TIERS_KNOWN_REMOTE`), so "asked, and none has fully
 * arrived" can be told apart from "not asked yet".
 */
import { withoutConfirmedMissing } from "../../audio/missingMaterialRecord";
import { useSyncExternalStore } from "react";
import type { Project } from "../../kernel/project";
import { getState, subscribe } from "../../store/project";
import { noteRenderNodeAssetBase } from "../sync/renderNodeHandoff";
import {
  TIERS_KNOWN_LOCAL, TIERS_KNOWN_REMOTE, missingOriginals, originalHashOf, prefetchOrder, smallHashOf, type MissingOriginal,
} from "../../render/mediaTier";
import { tr } from "../../i18n/index.ts";

/** Polling interval (A1: every 2 seconds) */
export const POLL_MS = 2000;
/** On the online page, once all assets have arrived, ask the asset service once every this many rounds to see whether it is still there (`pollOnce`) */
const HEALTH_EVERY = 5;
let idleRounds = 0;
/** Number of `chunks` requests in flight at the same time within one round */
const POLL_CONCURRENCY = 4;
/** Validity period of an asset ticket (`TICKET_TTL.asset` in `server/auth/protocol.mjs`); renewed when 1/3 remains */
const ASSET_TICKET_TTL_MS = 15 * 60_000;

export interface RemoteAssets {
  /** API base URL of the remote asset service, of the form `http://<ip>:<port>/api/asset` */
  base: string;
  /** Account cache identity is project scoped even when the public base is shared. */
  accountProjectId?: string;
  /** Get a read-only asset ticket; returns null if none is available (then it is omitted, and the asset service replies 401) */
  ticket?: (() => Promise<string | null>) & { info?: (opts?: { force?: boolean }) => Promise<{ ticket: string; exp: number } | null> };
}

const LOCAL_BASE = "/api/asset";

/**
 * Online browser mode (c10a section 2, "the online page does not request `/api/*`"): there is no local editor
 * process and no local asset service. Set by `Preview` on mount according to `ONLINE` (this file does not read
 * the compile-time constant, which is absent in unit tests). Once set: the editor process is no longer told
 * about the remote asset service / upload target / prefetch manifest, and the local asset service is not
 * polled (and nothing is polled until a remote asset service is connected).
 */
let noEditorProcess = false;
export function setNoEditorProcess(on: boolean): void {
  noEditorProcess = !!on;
}

/**
 * The document service connection of the current shared project (the one handed in by
 * `connectSharedAssets`). c10a section 9: the online page fetches prerendered small-size output per the
 * content store's manifest, and needs `content.get` on this connection (the online implementation in
 * `src/render/snapshotSource.ts` uses it via `docRequest`).
 */
let docLink: LinkLike | null = null;
let sharedAssetContext: { link: LinkLike; docBase: string; online: boolean; fallback: string | null } | null = null;
let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
let discoveryGeneration = 0;
export function docRequest(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
  if (!docLink) return Promise.reject(new Error(tr("Not connected to the document service")));
  return docLink.request(msg, timeoutMs);
}
export function hasDocLink(): boolean {
  return !!docLink;
}

let remote: RemoteAssets | null = null;
/** Hashes that have fully arrived on the current asset service (cleared when the asset service changes) */
let complete = new Set<string>();
let known = false;
let snapshot: readonly string[] = [];
let serviceGen = 0;
const listeners = new Set<() => void>();

function publish() {
  const next = known ? [remote ? TIERS_KNOWN_REMOTE : TIERS_KNOWN_LOCAL, ...[...complete].sort()] : [];
  if (next.length === snapshot.length && next.every((h, i) => h === snapshot[i])) return;
  snapshot = next;
  for (const l of [...listeners]) l();
}

/** The set used by the tier-switch criterion (with marker); an empty array if not asked yet */
export function tierHashes(): readonly string[] {
  return snapshot;
}

export function subscribeTierHashes(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useTierHashes(): readonly string[] {
  return useSyncExternalStore(subscribeTierHashes, tierHashes, tierHashes);
}

/** Whether the current connection is a remote asset service (base URL); null for local */
export function remoteAssetBase(): string | null {
  return remote?.base ?? null;
}

/**
 * Whether the current remote asset service belongs to an account cloud project (if so, returns that project
 * id; otherwise null). An account project's asset ticket is issued by the account session
 * (`enterAccountProject` in `syncManager.ts`); read and write use the same ticket, and permissions follow
 * the member; the old `auth.ticket` is rejected on an account connection, so places that need to write
 * assets use `remoteAssetTicketInfo` instead.
 */
export function remoteAccountProjectId(): string | null {
  return remote?.accountProjectId ?? null;
}

/**
 * The current remote asset service's read-only ticket together with its expiry time (C10 contract section 12:
 * `fetchTicket` for ticket renewal during frame-by-frame export, `src/export/ticketRenewal.ts`).
 * `force`: get a new one regardless of how long the current one has left. Null for the local asset service,
 * or if none is available.
 */
export async function remoteAssetTicketInfo(force = false): Promise<{ ticket: string; exp: number } | null> {
  const info = remote?.ticket?.info;
  if (!info) return null;
  try { return await info({ force }); } catch { return null; }
}

/** The current remote asset service's read-only ticket (for the online page's `<video>` query string and for fetching prerendered small-size output; c10a sections 8 and 9); null for local */
export async function remoteAssetTicket(): Promise<string | null> {
  if (!remote?.ticket) return null;
  try { return (await remote.ticket()) || null; } catch { return null; }
}

const remoteListeners = new Set<() => void>();
/** Notified when the remote asset service changes (entering / leaving a shared project); returns an unsubscribe function */
export function subscribeRemoteAssets(cb: () => void): () => void {
  remoteListeners.add(cb);
  return () => { remoteListeners.delete(cb); };
}

/** Request headers carrying the current asset ticket (`Authorization: Bearer`); an empty object for the local asset service */
export async function assetAuthHeaders(): Promise<Record<string, string>> {
  return authHeaders();
}

async function authHeaders(): Promise<Record<string, string>> {
  if (!remote?.ticket) return {};
  try {
    const t = await remote.ticket();
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

let pushedTicket: string | null = null;
/** Tell the local editor process (on-demand fetch and prefetch depend on it); online browser mode has no local editor, so failure is ignored */
async function pushRemoteToEditor(): Promise<void> {
  if (noEditorProcess) return;
  try {
    if (!remote) {
      pushedTicket = null;
      await fetch("/api/media/remote", { method: "DELETE" });
      return;
    }
    const auth = await authHeaders();
    const ticket = auth.Authorization ? auth.Authorization.slice("Bearer ".length) : null;
    pushedTicket = ticket;
    await fetch("/api/media/remote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base: remote.base, ticket }) });
  } catch { /* No local editor */ }
}

/**
 * Set the current connection's remote asset service; null = return to the local asset service. On change,
 * clear the set, immediately poll one more round, and reschedule prefetch.
 */
export function setRemoteAssets(next: RemoteAssets | null): void {
  const base = next ? next.base.replace(/\/+$/, "") : null;
  if ((remote?.base ?? null) === base && remote?.accountProjectId === next?.accountProjectId) {
    if (next && remote) remote.ticket = next.ticket;
    return;
  }
  remote = next ? { ...next, base: base! } : null;
  serviceGen++;
  setRemoteDown(false);
  complete = new Set();
  known = false;
  publish();
  lastPrefetchKey = "";
  for (const l of [...remoteListeners]) { try { l(); } catch { /* A broken subscriber does not affect the others */ } }
  void pushRemoteToEditor().then(() => { kick(); });
}

/**
 * Ask the current asset service which of these hashes are `complete`. Those that cannot be queried count as
 * not fully arrived.
 */
export async function askComplete(hashes: readonly string[]): Promise<Set<string>> {
  const base = remote?.base ?? LOCAL_BASE;
  const gen = serviceGen;
  const headers = await authHeaders();
  const out = new Set<string>();
  const queue = [...new Set(hashes)];
  let answered = 0, unreachable = 0;
  const worker = async () => {
    for (let h = queue.shift(); h; h = queue.shift()) {
      let r: Response;
      try {
        r = await fetch(`${base}/media/${h}/chunks`, { headers, cache: "no-store", ...(remote?.accountProjectId ? { credentials: 'omit' as const } : {}) });
      } catch { unreachable++; continue; } // Network error: cannot reach the asset service
      answered++;
      try {
        if (!r.ok) continue;
        const body = await r.json();
        if (body?.complete === true) out.add(h);
      } catch { /* Counts as not fully arrived */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POLL_CONCURRENCY, queue.length) }, worker));
  // Whether the remote asset service is reachable (used for "Cannot reach asset service" in the online page's
  // top bar): it only counts as unreachable if this round got no response at all and every request was a
  // network error
  if (remote && gen === serviceGen && (answered || unreachable)) setRemoteDown(answered === 0);
  return out;
}

/* ---------------- Whether the remote asset service is reachable (C10 contract section 10) ---------------- */

let remoteDown = false;
const healthListeners = new Set<() => void>();
function setRemoteDown(down: boolean): void {
  if (down === remoteDown) return;
  remoteDown = down;
  for (const l of [...healthListeners]) { try { l(); } catch { /* Same as above */ } }
}
/** The latest round of asking the remote asset service got no response at all (a network error, not 4xx/5xx). Gives false for the local asset service or if not asked yet */
export function remoteAssetsDown(): boolean {
  return !!remote && remoteDown;
}
export function subscribeRemoteAssetsHealth(cb: () => void): () => void {
  healthListeners.add(cb);
  return () => { healthListeners.delete(cb); };
}

/** Hashes to ask about this round: for assets whose original size has not fully arrived, ask for the original size; for those whose small size has not fully arrived, also ask for the small size; those at the top tier are not asked */
export function hashesToAsk(project: Pick<Project, "media">, done: ReadonlySet<string>): string[] {
  const ask: string[] = [];
  for (const m of project.media ?? []) {
    const o = originalHashOf(m);
    if (!o || done.has(o)) continue;
    ask.push(o);
    const s = smallHashOf(m);
    if (s && !done.has(s)) ask.push(s);
  }
  return [...new Set(ask)];
}

/** Run one polling round (also called directly before export and after switching asset services) */
export async function pollOnce(project: Pick<Project, "media"> = getState().project): Promise<void> {
  // The online page has no local asset service: if the remote asset service is not connected yet, do not ask
  if (noEditorProcess && !remote) return;
  const gen = serviceGen;
  const ask = hashesToAsk(project, complete);
  /*
   * Online page: once all assets have arrived, this round would otherwise ask nothing, so a dropped asset
   * service would go unnoticed. Every `HEALTH_EVERY` rounds, also ask about the original size of one asset
   * that has already fully arrived (a tiny reconciliation request), solely for the top bar's "Cannot reach
   * asset service".
   */
  if (!ask.length && noEditorProcess && remote && ++idleRounds % HEALTH_EVERY === 0) {
    const probe = (project.media ?? []).map(originalHashOf).find(Boolean);
    if (probe) ask.push(probe);
  }
  const got = ask.length ? await askComplete(ask) : new Set<string>();
  if (gen !== serviceGen) return; // This round asked the asset service that has since been replaced
  for (const h of got) complete.add(h);
  known = true;
  publish();
}

/* ---------------- Prefetch ---------------- */

let lastPrefetchKey = "";
async function maybePrefetch(project: Project): Promise<void> {
  if (!remote || noEditorProcess) return;
  const items = prefetchOrder(project);
  const key = `${remote.base}|${items.map((i) => i.hash).join(",")}`;
  if (key === lastPrefetchKey) return;
  lastPrefetchKey = key;
  try {
    await fetch("/api/media/prefetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
  } catch { /* No local editor */ }
}

/* ---------------- Polling loop ---------------- */

let timer: ReturnType<typeof setTimeout> | null = null;
let running = 0;
let polling = false;

function kick() {
  if (!running) return;
  if (timer) clearTimeout(timer);
  timer = null;
  void loop();
}

async function loop() {
  if (polling) return;
  polling = true;
  try {
    const project = getState().project;
    // The ticket was renewed: replace the editor process's copy too (it uses this ticket for on-demand fetch)
    if (remote?.ticket) {
      const auth = await authHeaders();
      const t = auth.Authorization ? auth.Authorization.slice("Bearer ".length) : null;
      if (t && t !== pushedTicket) await pushRemoteToEditor();
    }
    await pollOnce(project);
    await maybePrefetch(project);
  } finally {
    polling = false;
    if (running && !timer) timer = setTimeout(() => { timer = null; void loop(); }, POLL_MS);
  }
}

/**
 * Start polling (called when the preview mounts); returns a stop function. When the asset table changes
 * (opening another project, importing), poll one round immediately without waiting 2 seconds.
 * Can be called repeatedly; reference counted.
 */
export function startAssetTiers(): () => void {
  running++;
  let lastMedia = getState().project.media;
  const unsub = subscribe(() => {
    const media = getState().project.media;
    if (media === lastMedia) return;
    lastMedia = media;
    kick();
  });
  if (running === 1) {
    // The page was reloaded: the editor process may still hold the remote asset service set by the previous
    // page, so align it once with this page's state
    void pushRemoteToEditor();
    kick();
  }
  return () => {
    unsub();
    running = Math.max(0, running - 1);
    if (!running && timer) { clearTimeout(timer); timer = null; }
  };
}

/* ---------------- Pre-export gate ---------------- */

/**
 * Before export, ask the current asset service once: which original-size assets used on the timeline are not
 * yet `complete` (A1, "export only uses original-size assets" and "upload waiters").
 * Empty array = export is allowed.
 */
export async function exportGate(source: Project): Promise<MissingOriginal[]> {
  // Assets that have been confirmed missing will never fully arrive: do not block, and at export time output a
  // placeholder in the original position
  const project = withoutConfirmedMissing(source);
  const first = missingOriginals(project, []);
  if (!first.length) return [];
  const got = await askComplete(first.map((m) => m.hash));
  for (const h of got) complete.add(h);
  return missingOriginals(project, got);
}

/** Quick check that sends no request: based on the polled set. Gives null if not asked yet (unknown) */
export function exportGateNow(project: Project): MissingOriginal[] | null {
  if (!known) return null;
  return missingOriginals(withoutConfirmedMissing(project), complete);
}

/* ---------------- Shared project ---------------- */

interface LinkLike {
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

/**
 * Get a read-only asset ticket via `auth.ticket`, and replace it with a new one when 1/3 of the validity
 * period remains. "Validity period" is computed from this ticket's actual lifetime (issue to expiry), not
 * hard-coded to 15 minutes: when the ticket lifetime is shortened in tests (the acceptance check of C10
 * contract section 12), it is still replaced early.
 * The returned function carries `info({ force })`: it also gives the expiry time (used for renewal during
 * frame-by-frame export, `src/export/ticketRenewal.ts`).
 */
export function assetTicketSource(link: LinkLike, now: () => number = Date.now): (() => Promise<string | null>) & { info: (opts?: { force?: boolean }) => Promise<{ ticket: string; exp: number } | null> } {
  let cur: { ticket: string; exp: number; issued: number } | null = null;
  let inflight: Promise<{ ticket: string; exp: number } | null> | null = null;
  const fresh = () => !!cur && cur.exp - now() > Math.min(ASSET_TICKET_TTL_MS, Math.max(0, cur.exp - cur.issued)) / 3;
  const take = (): Promise<{ ticket: string; exp: number } | null> => {
    inflight ??= link.request({ type: "auth.ticket", kind: "asset", access: "r" }).then((r) => {
      if (r.type === "auth.ticket.ok" && typeof r.ticket === "string") {
        const issued = now();
        cur = { ticket: r.ticket, exp: Number(r.exp) || issued + ASSET_TICKET_TTL_MS, issued };
        return { ticket: cur.ticket, exp: cur.exp };
      }
      return null;
    }, () => null).finally(() => { inflight = null; });
    return inflight;
  };
  const get = async () => {
    if (fresh()) return cur!.ticket;
    return (await take())?.ticket ?? null;
  };
  get.info = async (opts: { force?: boolean } = {}) => {
    if (!opts.force && fresh()) return { ticket: cur!.ticket, exp: cur!.exp };
    return take();
  };
  return get;
}

/**
 * From the document service's service address registry (`service.watch`, kind `asset`), pick this shared
 * project's asset service: prefer the one on the same host as the document service; one pointing at this
 * page itself (this machine is the host) does not count as remote.
 *
 * Online browser mode (`online`) does not exclude the same host: the online page, document service and asset
 * service are all under one origin on the hosted side (nginx `/editor`, `/hosted/`, `/media/`, c10a contract
 * section 2), and the same-origin asset service is exactly the remote one; this page itself has no asset
 * service.
 */
export function pickAssetEndpoint(endpoints: unknown, docBase: string, selfHost: string, { online = false }: { online?: boolean } = {}): string | null {
  const urls: string[] = [];
  for (const e of Array.isArray(endpoints) ? endpoints : []) {
    const rec = e as { kind?: unknown; urls?: unknown };
    if (rec?.kind !== undefined && rec.kind !== "asset") continue;
    for (const u of Array.isArray(rec?.urls) ? rec.urls : []) if (typeof u === "string") urls.push(u);
  }
  let docHost = "";
  try { docHost = new URL(docBase).hostname; } catch { /* Left blank */ }
  const ok = urls.filter((u) => { try { return online || new URL(u).host !== selfHost; } catch { return false; } });
  return ok.find((u) => { try { return new URL(u).hostname === docHost; } catch { return false; } }) ?? ok[0] ?? null;
}

/**
 * Fallback address of the asset service for a project hosted on this machine (LAN) (M8-X1): the asset service
 * and the document service are in the same editor process on the host
 * (`docs/semantics/product/document-service.md`, "Deployment combinations"), and the host does not always
 * register the asset service with the service address registry (`server/vite-plugin-media.ts` only registers
 * it when `PROMPTCUT_DOCSERVICE_URL` is set). First use `asset` from the LAN discovery announcement; if there
 * is none (manually entered address, invite link), derive the same process's `/api/asset` from the document
 * service address, the same derivation as for a standalone render host (`hostAssetClient` in
 * `server/vite-plugin-frames.ts`). Not derived for projects moved to the cloud: the hosted combination's
 * asset service is not at `/api/asset`, and it is already registered.
 */
export function lanAssetBaseOf(candidate: { where?: string; base?: string; asset?: string } | null | undefined): string | null {
  if (candidate?.where !== "lan") return null;
  const valid = (u: unknown): string | null => {
    if (typeof u !== "string" || !u) return null;
    try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? u.replace(/\/+$/, "") : null; } catch { return null; }
  };
  const announced = valid(candidate.asset);
  if (announced) return announced;
  try {
    const u = new URL(String(candidate.base ?? ""));
    const proto = u.protocol === "wss:" || u.protocol === "https:" ? "https:" : u.protocol === "ws:" || u.protocol === "http:" ? "http:" : null;
    return proto ? `${proto}//${u.host}/api/asset` : null;
  } catch { return null; }
}

/** Use the fallback when the registry has no match; a fallback pointing at this page itself (this machine is the host) does not count as remote */
function withFallback(picked: string | null, fallback: string | null, online: boolean): string | null {
  if (picked || !fallback) return picked;
  if (online) return fallback;
  const selfHost = typeof location === "undefined" ? "" : location.host;
  try { return new URL(fallback).host === selfHost ? null : fallback; } catch { return null; }
}
function relayAssetBase(docBase: string, fallback: string | null): string | null {
  try { return /^\/hosting\/relay\/sp_[a-z2-7]{26}\/doc\/?$/.test(new URL(docBase).pathname) ? fallback : null; } catch { return null; }
}

/**
 * Called after entering a shared project: pick the asset service from the service address registry and set it
 * as the current remote asset service. When the registry has no match, use `fallback` (given by
 * `lanAssetBaseOf` for a project hosted on this machine); if there is none, or it points at this page itself
 * (this machine is the host), stay on the local asset service. Returns the chosen base URL.
 * `online`: online browser mode (supplied by the caller per `ONLINE` in `mode.ts`; this module is loaded by
 * Node unit tests, so it does not statically import `mode.ts`).
 */
export async function connectSharedAssets(link: LinkLike, docBase: string, { online = false, fallback = null, account }: { online?: boolean; fallback?: string | null; account?: { base: string; projectId: string; ticket: NonNullable<RemoteAssets['ticket']> } } = {}): Promise<string | null> {
  // Account tickets are issued by the HTTP session authority. v2 forbids the old
  // service.watch/auth.ticket protocols; keep them exclusively on the LAN branch.
  if (account) {
    discoveryGeneration++;
    if (discoveryTimer !== null) clearTimeout(discoveryTimer);
    discoveryTimer = null; sharedAssetContext = null; docLink = link;
    setRemoteAssets({ base: account.base, accountProjectId: account.projectId, ticket: account.ticket });
    stopUploadTarget?.();
    stopUploadTarget = startUploadTarget(link, account.base, { accountTicket: account.ticket.info });
    return account.base;
  }
  let base: string | null = null;
  // Called again after the same connection reconnects (re-subscribe and register): an asset service
  // that was already picked does not fall back to local because of one failure, and picking the same
  // one again does not reset it
  const again = docLink === link && remote !== null;
  let failed = false;
  const generation = ++discoveryGeneration;
  if (discoveryTimer !== null) clearTimeout(discoveryTimer);
  discoveryTimer = null;
  sharedAssetContext = { link, docBase, online, fallback };
  docLink = link;
  try {
    const r = await link.request({ type: "service.watch", kinds: ["asset"] });
    base = pickAssetEndpoint(r.endpoints, docBase, typeof location === "undefined" ? "" : location.host, { online });
  } catch { failed = true; /* Registry lookup failed: use the fallback, or stay local if there is none */ }
  base = relayAssetBase(docBase, fallback) ?? withFallback(base, fallback, online);
  if (generation !== discoveryGeneration || docLink !== link) return null;
  if (again && remote && (failed || base === remote.base)) {
    if (failed) discoveryTimer = setTimeout(() => {
      discoveryTimer = null;
      if (docLink === link) void connectSharedAssets(link, docBase, { online, fallback });
    }, 2000);
    return remote.base;
  }
  setRemoteAssets(base ? { base, ticket: assetTicketSource(link) } : null);
  stopUploadTarget?.();
  stopUploadTarget = startUploadTarget(link, base);
  // An online page has no local asset service: keep looking whether the registration request failed
  // or the service has not appeared yet.
  if (online && !base) discoveryTimer = setTimeout(() => {
    discoveryTimer = null;
    if (docLink === link) void connectSharedAssets(link, docBase, { online, fallback });
  }, 2000);
  return base;
}

/** Full follow-up notifications from the document service's service.watch; an asset service that
 * registers late can still be picked up. */
export function receiveSharedAssetEndpoints(endpoints: unknown): void {
  const ctx = sharedAssetContext;
  if (!ctx || docLink !== ctx.link) return;
  const base = relayAssetBase(ctx.docBase, ctx.fallback) ?? withFallback(pickAssetEndpoint(endpoints, ctx.docBase, typeof location === "undefined" ? "" : location.host, { online: ctx.online }), ctx.fallback, ctx.online);
  if ((remote?.base ?? null) === base) return;
  discoveryGeneration++;
  if (discoveryTimer !== null) clearTimeout(discoveryTimer);
  discoveryTimer = null;
  setRemoteAssets(base ? { base, ticket: assetTicketSource(ctx.link) } : null);
  stopUploadTarget?.();
  stopUploadTarget = startUploadTarget(ctx.link, base);
  if (ctx.online && !base) discoveryTimer = setTimeout(() => {
    discoveryTimer = null;
    if (docLink === ctx.link) void connectSharedAssets(ctx.link, ctx.docBase, { online: true, fallback: ctx.fallback });
  }, 2000);
}

/** Leaving the shared project: back to the local asset service */
export function disconnectSharedAssets(): void {
  discoveryGeneration++;
  if (discoveryTimer !== null) clearTimeout(discoveryTimer);
  discoveryTimer = null;
  sharedAssetContext = null;
  docLink = null;
  setRemoteAssets(null);
  stopUploadTarget?.();
  stopUploadTarget = startUploadTarget(null, null);
}

/* ---------------- Upload target (design doc section 9, item 1) ---------------- */

/**
 * The editor process's upload queue (`server/upload-queue.mjs`) needs to know the "currently connected
 * asset service" and a writable ticket. It has no project credentials of its own, so the page supplies
 * them: on entering a shared project it sends `POST /api/media/upload-queue/target { base, ticket }`
 * (an `rw` asset ticket, signed through this page's document service connection), and when 1/3 of the
 * ticket's lifetime is left it renews and pushes again. When leaving the shared project, or when this
 * machine is the host (no remote asset service can be picked), it pushes `{ base: null }` and the queue
 * goes back to "local asset service = no-op".
 * With no local editor (online browser mode), a failed push is simply ignored.
 */
let stopUploadTarget: (() => void) | null = null;

export interface UploadTargetDeps {
  accountTicket?: (opts?: { force?: boolean }) => Promise<{ ticket: string; exp: number } | null>;
  post?: (body: { base: string | null; ticket?: string | null }) => Promise<void>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

async function postUploadTarget(body: { base: string | null; ticket?: string | null }): Promise<void> {
  if (noEditorProcess) return;
  try {
    await fetch("/api/media/upload-queue/target", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch { /* No local editor */ }
}

/** How long to wait before retrying when no ticket can be signed */
const UPLOAD_TICKET_RETRY_MS = 30_000;

/**
 * Hands the upload target to the editor process and renews it on time; returns a stop function (which
 * pushes `{ base: null }` when stopped).
 * `link` / `base` is null: push `{ base: null }` only once.
 */
export function startUploadTarget(link: LinkLike | null, base: string | null, deps: UploadTargetDeps = {}): () => void {
  const post = deps.post ?? postUploadTarget;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.(); // In Node (unit tests) do not hold the process open; browsers have no unref
    return t;
  });
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let stopped = false;
  let timer: unknown = null;
  setUploadTargetReady(null);
  // This machine is the host (there is a connection but no remote asset service can be picked): an
  // import is written straight into this project's asset service, so imported assets need no record;
  // with no connection (left the shared project), whatever was recorded is dropped
  uploadTargetLocal = !!link && !base;
  if (!link || !base) deferredImports.clear();
  // Auto render node (`sync/renderNodeHandoff.ts`): the prerender process pushes its output to the same
  // asset service (null when this machine is the host, in which case it pushes to this machine's)
  noteRenderNodeAssetBase(link && base ? base : null);
  if (!link || !base) {
    void post({ base: null });
    return () => { /* It was local all along */ };
  }
  const renew = async () => {
    timer = null;
    if (stopped) return;
    const issued = now();
    let ticket: string | null = null;
    let exp = issued + ASSET_TICKET_TTL_MS;
    try {
      if (deps.accountTicket) { const r = await deps.accountTicket(); if (r) { ticket = r.ticket; exp = r.exp; } }
      else {
        const r = await link.request({ type: "auth.ticket", kind: "asset", access: "rw" });
        if (r.type === "auth.ticket.ok" && typeof r.ticket === "string") { ticket = r.ticket; exp = Number(r.exp) || exp; }
      }
    } catch { /* Treated as unable to sign below */ }
    if (stopped) return;
    await post({ base, ticket });
    if (stopped) return;
    if (ticket) setUploadTargetReady(base);
    // Renew when 1/3 of the lifetime is left: 2/3 of the lifetime has passed since issue
    const delay = ticket ? Math.max(1000, Math.floor((exp - issued) * 2 / 3)) : UPLOAD_TICKET_RETRY_MS;
    timer = setTimer(() => { void renew(); }, delay);
  };
  void renew();
  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    setUploadTargetReady(null);
    void post({ base: null });
  };
}

/* ---------------- When "move to the cloud" is turned on, hand the project's existing assets to the upload queue (C10a integration rework) ---------------- */

/** The base address if the editor process already has a remote upload target with an rw ticket; null
 * if not */
let uploadTargetReadyBase: string | null = null;
const uploadTargetWaiters = new Set<(base: string) => void>();

function setUploadTargetReady(base: string | null): void {
  uploadTargetReadyBase = base;
  if (!base) return;
  for (const w of [...uploadTargetWaiters]) w(base);
  if (deferredImports.size) void flushDeferredImports();
}

/** Waits until the editor process has a remote upload target with an rw ticket (the first successful
 * push of `startUploadTarget` with a ticket); returns null on timeout */
export function whenUploadTargetReady(timeoutMs = 30_000): Promise<string | null> {
  if (uploadTargetReadyBase) return Promise.resolve(uploadTargetReadyBase);
  return new Promise((resolve) => {
    const done = (base: string | null) => { uploadTargetWaiters.delete(onReady); clearTimeout(t); resolve(base); };
    const onReady = (base: string) => done(base);
    const t = setTimeout(() => done(null), timeoutMs);
    (t as { unref?: () => void }).unref?.();
    uploadTargetWaiters.add(onReady);
  });
}

type ExistingMedia = { id?: string; name?: string; hash?: string; pending?: boolean; tiers?: { original?: string; small?: string } | null };

/** An asset that cannot be handed to the upload queue by hash (it has no valid hash): the caller uses
 * this to notify the user; `pending` means it is still importing and the import path uploads it after
 * ingest */
export interface SkippedMedia { id?: string; name: string; pending?: boolean }

/**
 * The project's existing assets → the request body for enqueuing by hash: one entry per asset, two
 * tiers for video (`tiers.small`, `tiers.original`), and only the asset's original-size tier for
 * images and audio; the original size of the same asset is listed only once. Assets without a hash
 * (old assets from the migration period, ones still being ingested) cannot enter the queue and
 * **must not be skipped silently**: they always appear in `skipped` (the caller backfills ingest
 * first, and lists the ones that cannot be backfilled to the user).
 */
export function existingMediaItems(media: readonly ExistingMedia[]): { items: { name: string; original: string; small?: string }[]; skipped: SkippedMedia[] } {
  const seen = new Set<string>();
  const items: { name: string; original: string; small?: string }[] = [];
  const skipped: SkippedMedia[] = [];
  for (const m of media) {
    const original = String(m?.tiers?.original || m?.hash || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(original)) {
      skipped.push({ ...(m?.id ? { id: m.id } : {}), name: String(m?.name ?? ""), ...(m?.pending ? { pending: true } : {}) });
      continue;
    }
    if (seen.has(original)) continue;
    seen.add(original);
    const small = String(m?.tiers?.small || "").toLowerCase();
    items.push({ name: String(m?.name ?? ""), original, ...(/^[0-9a-f]{64}$/.test(small) && small !== original ? { small } : {}) });
  }
  return { items, skipped };
}

export interface EnqueueExistingResult { queued: string[]; missing: string[]; local?: boolean; skipped?: SkippedMedia[] }

/**
 * Called after multi-user collaboration "move to the cloud" is turned on: waits until the editor process
 * has the remote upload target and rw ticket, then hands the project's existing assets to the upload
 * queue by hash (`deps.post` sends `POST /api/media/upload-queue/enqueue`; only assets present in the
 * local content store are accepted, missing ones come back as `missing`).
 * After that, assets are uploaded one by one, small first and large later, following the C6.6 queue
 * rules. Returns null when there is no local editor (online browser mode) or the target never arrives.
 * Assets with no hash that cannot enter the queue are placed in the result's `skipped` (the caller
 * should first run `ingestUnhashedMedia` to backfill ingest, then call this).
 * `post` is supplied by the caller (`collab.ts` provides it according to the compile-time `ONLINE`;
 * in the online build it is pruned together with the API address).
 */
export async function enqueueExistingMedia(
  media: readonly ExistingMedia[],
  deps: { post: ((body: unknown) => Promise<EnqueueExistingResult | null>) | null; timeoutMs?: number },
): Promise<EnqueueExistingResult | null> {
  if (!deps.post) return null;
  const { items, skipped } = existingMediaItems(media);
  if (!items.length) return { queued: [], missing: [], skipped };
  if (!(await whenUploadTargetReady(deps.timeoutMs ?? 30_000))) return null;
  const r = await deps.post({ items });
  return r ? { ...r, skipped } : null;
}

/** IDs of "cannot be backfilled" assets already listed to the user: not popped up repeatedly within the
 * same page session */
const backfillNotified = new Set<string>();

/**
 * Called after the background backfill ingest after opening a project (`ingestUnhashedMedia` in
 * `io/mediaUpload.ts`) finishes: if the project is already "moved to the cloud" at this point (the
 * editor process has a remote upload target with an rw ticket), the assets that just got hashes are
 * handed to the upload queue by hash. Ingest of images and audio does not enter the queue by itself
 * (prepareImport in `server/media-tiers.mjs` only handles video); without handing them over they stay on
 * this machine only and other members cannot get them. Handing over video twice is harmless (the queue
 * dedupes by asset). Assets that cannot be backfilled or are not in the local content store are listed to
 * the user through `deps.notify`, the same as when move to the cloud was turned on (each asset is listed
 * only once per session).
 * Does nothing and returns null when this is not a shared project (`deps.shared` is falsy) or when no
 * upload target can be awaited (this machine is the host, or there is no local editor).
 */
export async function queueBackfilledMedia(
  r: { ingested: readonly string[]; failed: readonly { id?: string; name: string }[] },
  media: readonly ExistingMedia[],
  deps: {
    post: ((body: unknown) => Promise<EnqueueExistingResult | null>) | null;
    shared: () => boolean;
    notify?: (names: string[]) => void;
    timeoutMs?: number;
  },
): Promise<EnqueueExistingResult | null> {
  if (!deps.post || !deps.shared()) return null;
  if (!r.ingested.length && !r.failed.some((f) => !f.id || !backfillNotified.has(f.id))) return null;
  if (!(await whenUploadTargetReady(deps.timeoutMs ?? 30_000))) return null;
  const ids = new Set(r.ingested);
  const picked = media.filter((m) => m?.id && ids.has(m.id));
  let res: EnqueueExistingResult | null = { queued: [], missing: [] };
  if (picked.length) res = await enqueueExistingMedia(picked, deps);
  const nameOfHash = new Map<string, { id?: string; name: string }>();
  for (const m of picked) {
    const h = String(m.tiers?.original || m.hash || "").toLowerCase();
    if (h && !nameOfHash.has(h)) nameOfHash.set(h, { id: m.id, name: String(m.name ?? "") });
  }
  const list = [
    ...r.failed,
    ...(res?.missing ?? []).map((h) => nameOfHash.get(String(h).toLowerCase()) ?? { name: String(h) }),
  ].filter((f) => !f.id || !backfillNotified.has(f.id));
  for (const f of list) if (f.id) backfillNotified.add(f.id);
  if (list.length) deps.notify?.(list.map((f) => f.name));
  return res;
}

/* ---------------- Assets imported before the upload target is ready: record them, hand over once ready ---------------- */

/*
 * After a shared project is opened, the upload target is set asynchronously (`connectSharedAssets` first
 * looks up the service address registration, then signs an rw asset ticket and pushes it to the editor
 * process). For assets imported before that, when the editor process side (prepareImport in
 * `server/media-tiers.mjs`) enqueues them it sees the local target and drops them as a no-op, so other
 * members cannot get them. The page side records them when the import completes (applyUploadedMedia in
 * `io/mediaUpload.ts` → hooks.afterImport), and once the upload target is ready (`setUploadTargetReady`)
 * hands them to the upload queue by hash, through the same enqueue entry point used when move to the
 * cloud is turned on (`enqueueExistingMedia`).
 * Assets imported when the upload target is already ready are also handed over on the spot: the server's
 * enqueue and the import request run in parallel, so it is uncertain whether it gets there in time;
 * handing over twice is harmless, the queue dedupes by asset.
 */

/** Original-size hash of the asset → that asset (the same asset is recorded only once) */
const deferredImports = new Map<string, ExistingMedia>();
/** The enqueue entry point and notify callback given at the most recent recording (used when handing
 * over later) */
let deferredDeps: ImportQueueDeps | null = null;
/** This machine is the host of the current shared project (`startUploadTarget(link, null)`) */
let uploadTargetLocal = false;
let deferredFlushing = false;

export interface ImportQueueDeps {
  post: ((body: unknown) => Promise<EnqueueExistingResult | null>) | null;
  shared: () => boolean;
  notify?: (names: string[]) => void;
}

function importHashOf(m: ExistingMedia): string {
  return String(m?.tiers?.original || m?.hash || "").toLowerCase();
}

async function handImported(list: ExistingMedia[], deps: ImportQueueDeps): Promise<EnqueueExistingResult | null> {
  const r = deps.post ? await enqueueExistingMedia(list, { post: deps.post, timeoutMs: 0 }) : null;
  if (!r) return null;
  const nameOf = new Map(list.map((m) => [importHashOf(m), String(m.name ?? "")]));
  const names = (r.missing ?? []).map((h) => nameOf.get(String(h).toLowerCase()) ?? String(h));
  if (names.length) deps.notify?.(names);
  return r;
}

async function flushDeferredImports(): Promise<void> {
  const deps = deferredDeps;
  if (deferredFlushing || !deps || !uploadTargetReadyBase) return;
  if (!deps.post || !deps.shared()) { deferredImports.clear(); return; }
  deferredFlushing = true;
  const list = [...deferredImports.values()];
  deferredImports.clear();
  let r: EnqueueExistingResult | null = null;
  try { r = await handImported(list, deps); } catch { r = null; }
  finally { deferredFlushing = false; }
  // Hand-over failed (the editor process did not respond, or the upload target dropped in the meantime):
  // keep it and hand it over the next time the target is ready (renewal pushes again); do not keep it if
  // the shared project was left in the meantime
  if (!r && deps.shared() && !uploadTargetLocal) {
    for (const m of list) { const h = importHashOf(m); if (!deferredImports.has(h)) deferredImports.set(h, m); }
  }
  if (deferredImports.size && uploadTargetReadyBase && r) void flushDeferredImports();
}

/**
 * Called after one asset finishes importing (`sync/backfillUpload.ts` hooks it onto hooks.afterImport).
 * In a shared project: if the upload target is ready, the asset is handed to the upload queue by hash on
 * the spot; if not yet ready, it is recorded and handed over once ready; assets not in the local content
 * store (the queue returns missing) are listed to the user through `deps.notify`.
 * Does nothing and returns null when this is not a shared project, there is no enqueue entry point
 * (online build), this machine is the host, or there is no valid hash.
 */
export async function queueImportedMedia(media: ExistingMedia, deps: ImportQueueDeps): Promise<EnqueueExistingResult | null> {
  if (!deps.post || !deps.shared() || uploadTargetLocal) return null;
  const hash = importHashOf(media);
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  deferredDeps = deps;
  if (!uploadTargetReadyBase || deferredFlushing) {
    deferredImports.set(hash, media);
    return null;
  }
  const r = await handImported([media], deps);
  if (!r && deps.shared() && !uploadTargetLocal) deferredImports.set(hash, media);
  return r;
}

/** For unit tests: original-size hashes of assets still recorded and waiting for the upload target */
export function deferredImportsForTest(): string[] {
  return [...deferredImports.keys()];
}

/** For unit tests: the upload target base address the editor process already has */
export function uploadTargetReadyForTest(): string | null {
  return uploadTargetReadyBase;
}

/** Observation hook for probes and unit tests */
export function assetTiersDebug() {
  return { remote: remote?.base ?? null, known, complete: [...complete].sort(), snapshot: [...snapshot] };
}

/** For unit tests */
export function resetAssetTiersForTest(): void {
  backfillNotified.clear();
  deferredImports.clear();
  deferredDeps = null;
  uploadTargetLocal = false;
  deferredFlushing = false;
  uploadTargetReadyBase = null;
  uploadTargetWaiters.clear();
  remote = null;
  complete = new Set();
  known = false;
  snapshot = [];
  serviceGen++;
  lastPrefetchKey = "";
  listeners.clear();
  stopUploadTarget?.();
  stopUploadTarget = null;
  noEditorProcess = false;
  docLink = null;
  remoteListeners.clear();
}
