/**
 * Hooks the account route of "Move to the cloud" into the editor (the flow itself is in `accountMove.ts`;
 * this file only supplies what it needs):
 * the desktop app's account client (the login recovery credential is in the vault of the desktop shell),
 * the project or collaboration room currently open, content upload and read-back,
 * closing local collaboration (`disableCollab` in `collab.ts`, the path taken by "Cancel multi-user
 * collaboration"), entering the cloud project (`enterAccountProject`),
 * and handing media to the upload queue (`queueExistingMedia` in `collab.ts`, small size first, then original size).
 *
 * Used only in the desktop app: an online page has no local project to move (user decision, 2026-10-13:
 * the online browser is not part of this release).
 */
import { ONLINE } from "../../online/mode";
import { createAccountClient, loadAccountExtensions, projectLink, type Account, type CloudAccountClient } from "./accountExtensions";
import { desktopAccountBridge, isDesktopShellTooOld } from "./desktopShellBridge";
import { createEmptyProject, type Project } from "../../kernel/project";
import { getState } from "../../store/project";
import { hostedWsUrlOf } from "../../online/invite";
import { originalHashOf, smallHashOf } from "../../render/mediaTier";
import { remoteAssetBase } from "../media/assetTiers";
import { ensureActiveDraftId, getActiveDraftId, saveDraft, setActiveDraftId } from "../io/drafts";
import { forgetSaveTarget, hasSaveTarget, serializeProc, writeProcToDisk } from "../io/proc";
import { adminOp, currentDocLineage, dismissToast, ensureDevice, enterAccountProject, getSyncView, leaveSharedToLocal, pageSession, pushToast, whenSaved } from "./syncManager";
import { disableCollab, localCollab, pullOriginals, queueExistingMedia } from "./collab";
import { hosted } from "./sharedApi";
import {
  ACCOUNT_MOVE_TEXT, abandonMove, cloudProjectStateOf, createAttemptStore, isAccountCloudTarget, moveToAccountCloud, pendingAttempt, readProjectContent, sameContent, uploadProjectContent,
  type AbandonResult, type ContentLinkOptions, type MoveAttempt, type MoveResult, type MoveSource, type MoveStage,
} from "./accountMove";
import { currentCloudAssociation, setCloudAssociation } from "./recoveryAssociation";
import { tr } from "../../i18n/index.ts";

/**
 * Compile-time constants of the online build (see "Online build pruning" in `src/online/pageFlag.ts` for the
 * syntax and purpose). An online page has no editor process, so the few places below that hit the local `/api/*`
 * (asking the local media library, checking the upload queue, saving drafts) are pruned out whole in the online
 * build (guarded by C10A-API-03 in `server/test/c10a-online-build.test.mjs`).
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/* ---------------- Account cloud of the desktop app ---------------- */

export interface AccountCloud { origin: string; client: CloudAccountClient }

let cloud: Promise<AccountCloud | null> | null = null;
/** This desktop app's shell is too old (patched before 0.2.8) and has no account bridge: recorded when `accountCloud()` finds out, and settings uses it to say the full installer is needed */
let shellTooOld = false;

/**
 * The account cloud and account client configured for this desktop app (one per page). Returns null when there
 * is no account bridge (online page, dev server without a desktop shell):
 * then "Move to the cloud" takes the old route and the account UI is not shown.
 */
export function accountCloud(): Promise<AccountCloud | null> {
  if (ONLINE) return Promise.resolve(null);
  if (cloud) return cloud;
  const task = (async (): Promise<AccountCloud | null> => {
    const device = await ensureDevice();
    if (!device) return null;
    let origin: string;
    try { origin = new URL((await desktopAccountBridge("configuration") as { origin: string }).origin).origin; }
    catch (error) { shellTooOld = isDesktopShellTooOld(error); return null; }
    shellTooOld = false;
    await loadAccountExtensions({ includeUi: false }).catch(() => false);
    return { origin, client: createAccountClient({ online: false, origin, device: { deviceId: device.deviceId, deviceName: device.deviceName }, native: desktopAccountBridge }) };
  })().catch(() => null);
  cloud = task;
  // Not obtained (device info not ready, no account bridge): do not remember it, ask again next time
  void task.then((value) => { if (!value && cloud === task) cloud = null; });
  return task;
}

/**
 * The shell is too old and has no account bridge (one reason `accountCloud()` returns null; the result is
 * only available after it has been asked). Different from "no desktop shell":
 * the latter (online page, dev server) never had this feature, takes the old route, and shows no notice.
 */
export function accountShellTooOld(): boolean { return shellTooOld; }

/**
 * When the shell is too old: whether the cloud address entered in the UI (or the one registered for the room) refers to
 * the default account cloud. If so, "Move to the cloud" cannot take the old route
 * (the default cloud only accepts website accounts) and the user must be told to install the full installer;
 * any other node the user entered themselves still uses the old route and needs no account bridge.
 * A too-old shell cannot read the account cloud configuration, so the built-in default hosted address is treated as the account cloud.
 */
export function oldShellBlocksAccountMove(serviceUrl: string | null | undefined): boolean {
  return shellTooOld && isAccountCloudTarget(serviceUrl, hosted.DEFAULT_HOSTED_URL, hosted.DEFAULT_HOSTED_URL);
}

/** Whether the cloud address entered in the UI (or the one used for room registration) refers to the account cloud */
export function targetsAccountCloud(serviceUrl: string | null | undefined, c: AccountCloud | null): boolean {
  return !!c && isAccountCloudTarget(serviceUrl, c.origin, hosted.DEFAULT_HOSTED_URL);
}

/** The currently logged-in account (if none is in hand, fetch it once using the recovery credential in the vault); returns null if not logged in; throws if unreachable */
export async function accountCloudLogin(c: AccountCloud): Promise<Account | null> {
  return c.client.account ?? await c.client.restore();
}

/** Log in from settings (same vault as the start page login: logging in here also logs in the start page) */
export async function accountCloudSignIn(c: AccountCloud, name: string, password: string): Promise<Account> {
  return c.client.login(name, password, false);
}

/* ---------------- What is open now ---------------- */

/** The two kinds that can be moved: a local project without collaboration; a collaboration room opened on this machine by the old route (currently connected). Anything else (already a cloud project, collaboration identity not yet restored) cannot be moved */
export function moveSource(): MoveSource | null {
  if (ONLINE) return null;
  const v = getSyncView();
  const contentId = getState().project.id ?? "";
  if (!contentId) return null;
  if (v.shared) return !v.shared.accountId && v.shared.where === "lan" ? { kind: "room", contentId, creator: v.shared.creator, roomId: v.shared.projectId } : null;
  if (v.association || v.kind !== "local") return null;
  return { kind: "local", contentId };
}

const attempts = createAttemptStore(typeof localStorage === "undefined" ? null : localStorage);

/**
 * The previous move that did not finish and whose cloud project was already created (settings uses it to suggest "continue" and offer "Abandon this move"); null if none.
 * For the criteria see `pendingAttempt` in `accountMove.ts`: what is currently open is a movable local project or local collaboration room, and the local record holds a project ID returned by the cloud
 */
export function pendingMove(accountId: string): MoveAttempt | null {
  return pendingAttempt(attempts, accountId, moveSource());
}

let abandoning: Promise<AbandonResult> | null = null;

/**
 * Abandon this move ([ruling] H04): delete the cloud project created when the last move to the cloud did not finish, then clear the local move record. The flow is `abandonMove` in `accountMove.ts`.
 * Does nothing while this window is moving; only one at a time; does not throw
 */
export function abandonPendingMove(c: AccountCloud): Promise<AbandonResult> {
  if (ONLINE_BUILD || ONLINE) return Promise.resolve({ ok: false, error: "not-ready", name: null });
  if (moving) return Promise.resolve({ ok: false, error: "busy", name: null });
  if (abandoning) return abandoning;
  const { client } = c;
  const task = abandonMove({
    source: moveSource,
    account: () => accountCloudLogin(c),
    attempts,
    inspect: async (projectId) => cloudProjectStateOf(await client.members(projectId)),
    remove: (projectId, rev, requestId) => client.deleteProject(projectId, rev, requestId),
    // When a move fails the editor never entered that cloud project, so this page's cloud link does not point to it anyway; if it does (an error halfway through entering the project), clear it too so it is no longer written when saving to a file
    forget: (projectId) => { if (currentCloudAssociation()?.projectId === projectId) setCloudAssociation(null); },
    newRequestId: () => `abandon-${crypto.randomUUID()}`,
    owner: pageSession(),
  }).finally(() => { if (abandoning === task) abandoning = null; });
  abandoning = task;
  return task;
}

/* ---------------- Assets ---------------- */

async function localHave(hashes: string[]): Promise<Set<string>> {
  const got = new Set<string>();
  if (ONLINE_BUILD) return got;
  for (let i = 0; i < hashes.length; i += 40) {
    const r = await fetch(`/api/media/local?hashes=${hashes.slice(i, i + 40).join(",")}`, { cache: "no-store" });
    const j = (await r.json()) as { hashes?: string[] };
    for (const h of j.hashes ?? []) got.add(h);
  }
  return got;
}

/**
 * In a collaboration room, when the person moving is not on the host's computer: the asset bytes the project references are on the host's asset service,
 * and this computer's content store may hold only some of them. They can no longer be fetched once local collaboration is closed, so sync them first (both tiers).
 * Nothing to do when this machine is the host (no remote asset service).
 */
async function pullRoomMedia(project: Project): Promise<{ ok: boolean; missing: number }> {
  if (!remoteAssetBase()) return { ok: true, missing: 0 };
  const hashes = [...new Set((project.media ?? []).flatMap((m) => [originalHashOf(m), smallHashOf(m)]).filter((h): h is string => !!h))];
  if (!hashes.length) return { ok: true, missing: 0 };
  if (await pullOriginals(hashes)) return { ok: true, missing: 0 };
  let have = 0;
  try { have = (await localHave(hashes)).size; } catch { /* Cannot be queried: count as having none */ }
  return { ok: false, missing: Math.max(1, hashes.length - have) };
}

/** How often to check background upload progress */
const WATCH_MS = 3000;
/** How long to wait before handing media over again when it was not accepted (upload channel not ready) */
const REQUEUE_MS = 15_000;
/** How long card source sync may stay unconnected to the cloud project before it is reported */
const CARDS_STUCK_MS = 30_000;

/**
 * What is still uploading in the background after the move: media (both tiers; card sounds are also entries in the media table) goes through the upload queue, and card source goes through the editor process's card source sync.
 * A bubble that does not disappear on its own keeps reporting: still uploading, errors being retried, media not yet started (upload channel not ready; this code hands it over again after a while, until accepted),
 * card source not yet connected; when everything is uploaded it is replaced by a closing sentence (a tier with files the local machine cannot find is mentioned in that sentence). It is dismissed when leaving this project.
 *
 * "Media upload finished" is judged by the upload queue being empty: media that fails to upload does not leave the queue (the queue keeps retrying with backoff), so a failure is never taken as finished;
 * for a tier that entered the queue but whose local file is gone by the time it is to be uploaded, the queue skips it, and here the queue's "not found" count is reported in the closing sentence.
 */
function watchBackground(projectId: string, first: { queued: number; missing: string[] } | null) {
  if (ONLINE_BUILD) return;
  let queued = first !== null, count = first?.queued ?? 0;
  let toast: number | null = null, shown = "", everShown = false;
  let idle = 0, missingBase: number | null = null, lastRequeue = Date.now(), requeueing = false;
  const startedAt = Date.now();
  const show = (text: string, tone: "info" | "warn") => {
    if (text === shown) return;
    if (toast !== null) dismissToast(toast);
    shown = text; everShown = true;
    toast = pushToast(text, tone, Infinity);
  };
  const stop = (final: { text: string; tone: "info" | "warn" } | null) => {
    clearInterval(timer);
    if (toast !== null) dismissToast(toast);
    if (final && everShown) pushToast(final.text, final.tone, final.tone === "warn" ? Infinity : 8000);
  };
  const tick = async () => {
    if (getSyncView().shared?.projectId !== projectId) { stop(null); return; }
    if (!queued && !requeueing && Date.now() - lastRequeue >= REQUEUE_MS) {
      requeueing = true;
      try { const r = await queueExistingMedia(); if (r) { queued = true; count = r.queued; } }
      finally { requeueing = false; lastRequeue = Date.now(); }
    }
    let left = 0, missing = 0, failing = false;
    try {
      const j = (await (await fetch("/api/media/upload-queue", { cache: "no-store" })).json()) as { queue?: { items?: unknown[]; missing?: number; lastError?: { at?: number } | null } | null };
      left = j.queue?.items?.length ?? 0;
      missing = Number(j.queue?.missing) || 0;
      failing = left > 0 && Number(j.queue?.lastError?.at) > startedAt;
    } catch { return; }
    missingBase ??= missing;
    let cards: "ok" | "pending" | "stuck" = "ok";
    try {
      const c = (await (await fetch("/api/cards/sync/status", { cache: "no-store" })).json()) as { enabled?: boolean; projectId?: string; connected?: boolean; pending?: unknown[] };
      if (c.enabled !== false) {
        const bound = c.projectId === projectId && c.connected === true;
        cards = bound ? ((c.pending?.length ?? 0) > 0 ? "pending" : "ok") : Date.now() - startedAt > CARDS_STUCK_MS ? "stuck" : "pending";
      }
    } catch { /* Cannot query the card sync status: leave it out of this round */ }
    const parts: string[] = [];
    if (!queued) parts.push(ACCOUNT_MOVE_TEXT.mediaNotQueued);
    else if (left > 0) parts.push(failing ? ACCOUNT_MOVE_TEXT.mediaRetrying : ACCOUNT_MOVE_TEXT.uploading(Math.max(count, left)));
    if (cards === "pending") parts.push(ACCOUNT_MOVE_TEXT.cardsUploading);
    if (cards === "stuck") parts.push(ACCOUNT_MOVE_TEXT.cardsStuck);
    if (parts.length) { idle = 0; show(parts.join(""), !queued || failing || cards === "stuck" ? "warn" : "info"); return; }
    // Only finished when there was nothing to upload twice in a row (media whose small size is still transcoding enters the queue only after transcoding)
    if (++idle < 2) return;
    const lost = missing - (missingBase ?? missing);
    stop(lost > 0 ? { text: ACCOUNT_MOVE_TEXT.uploadedWithMissing(lost), tone: "warn" } : { text: ACCOUNT_MOVE_TEXT.uploaded, tone: "info" });
  };
  const timer = setInterval(() => { void tick(); }, WATCH_MS);
  if (!queued) show(ACCOUNT_MOVE_TEXT.mediaNotQueued, "warn");
  else if (count > 0) show(ACCOUNT_MOVE_TEXT.uploading(count), "info");
}

/* ---------------- Move ---------------- */

export interface MoveRequest {
  /** Cloud project name */
  name: string;
  /** Collaboration room: creator password (not needed if stored on this machine) */
  creatorPassword?: string;
  onStage?: (stage: MoveStage) => void;
}

export type MoveOutcome = MoveResult & { kind: "local" | "room" };

let moving: Promise<MoveOutcome> | null = null;

/** Move the currently open local project or local collaboration room to the account cloud. Only one at a time; does not throw */
export function moveCurrentToAccountCloud(c: AccountCloud, request: MoveRequest): Promise<MoveOutcome> {
  // An online page has no local project to move: in the online build the whole block below (including the calls that save drafts and query the local media library) is pruned
  if (ONLINE_BUILD) return Promise.resolve({ ok: false, error: "not-ready", stage: "check", localClosed: false, cloud: null, kind: "local" });
  if (moving) return moving;
  // Do not move while this move is being abandoned (deleting that cloud project): wait for it to finish
  if (abandoning) return Promise.resolve({ ok: false, error: "busy", stage: "check", localClosed: false, cloud: null, kind: moveSource()?.kind ?? "local" });
  const task = run(c, request).finally(() => { if (moving === task) moving = null; });
  moving = task;
  return task;
}

async function run(c: AccountCloud, request: MoveRequest): Promise<MoveOutcome> {
  const { client, origin } = c;
  const kind = moveSource()?.kind ?? "local";
  const shared = getSyncView().shared;
  const password = request.creatorPassword || (shared ? localCollab(shared.projectId)?.creatorPassword : "") || "";
  const url = hostedWsUrlOf(`${origin}/hosted/`);
  // For probes (dev mode only): shorten the content connection's wait limit so the "cloud became unavailable midway" failure shows up within a few seconds
  const testHook = import.meta.env?.DEV ? (window as unknown as { __pcMoveTest?: { contentTimeoutMs?: number; onStage?: (stage: MoveStage) => void } }).__pcMoveTest : undefined;
  const testTimeout = testHook?.contentTimeoutMs;
  const linkTo = (projectId: string): ContentLinkOptions => ({
    url, ...(testTimeout ? { timeoutMs: testTimeout } : {}),
    // Fetch one ticket per session created; the access token behind it has at least one minute left (one that expires halfway through the upload: the connection is rebuilt as a disconnect and continues with a new ticket)
    ticket: async () => (await client.session(projectId, { minRemainingMs: 60_000 })).connectionTicket,
  });
  // The logged-in account changed during the move (logged out and logged in as another): reject every later step, so content is not written under another account's name
  let startedAs: string | null = null;
  const sameAccount = () => {
    if (startedAs && client.account?.id !== startedAs) throw Object.assign(new Error("credential-revoked"), { status: 401, code: "credential-revoked" });
  };
  const result = await moveToAccountCloud({
    source: moveSource,
    account: async () => { const a = await accountCloudLogin(c); startedAs = a?.id ?? null; return a; },
    snapshot: async () => { await whenSaved(10_000); return structuredClone(getState().project); },
    create: (name, stub, requestId, extra) => { sameAccount(); return client.create(name, stub, requestId, extra); },
    // History sequence number and commit digest: the copy confirmed on the current local document connection (a local project connects to the local document service, a collaboration room connects to the room)
    lineage: () => currentDocLineage(getState().project.id ?? ""),
    current: () => getState().project,
    upload: (projectId, snapshot) => { sameAccount(); return uploadProjectContent(linkTo(projectId), projectId, snapshot); },
    read: async (projectId) => (await readProjectContent(linkTo(projectId), projectId, getState().project)).project,
    checkCreator: async (pw) => {
      const r = await adminOp("list-bans", { password: pw });
      return r.ok ? { ok: true } : { ok: false, error: r.error === "rate-limited" ? "rate-limited" : r.error === "offline" ? "network" : "bad-password" };
    },
    pullMedia: pullRoomMedia,
    closeRoom: async (pw) => {
      const closed = await disableCollab(pw);
      if (closed.ok || closed.error === "forbidden" || closed.error === "rate-limited") return closed;
      // When the delete reply was lost (the connection was first closed by the server as "project deleted"), `disableCollab` reports failure although the room is in fact already deleted:
      // the page will then receive that close code and enter the "project deleted" state. Wait a few seconds to see whether this is the case; if so, reattach the content in hand to the local project and proceed as if closing succeeded
      // (otherwise the UI would say "still the original room" while the room is gone). This branch was written by inference from the code and has not been verified end to end
      for (let i = 0; i < 20 && getSyncView().blocked !== "deleted"; i++) await new Promise((r) => setTimeout(r, 150));
      if (getSyncView().blocked !== "deleted") return closed;
      leaveSharedToLocal(structuredClone(getState().project));
      return { ok: true };
    },
    saveLocal: ONLINE_BUILD ? undefined : async () => {
      // Local project: save only if there is a draft (do not open a new draft for the user). Collaboration room (already closed by now, the editor is in the local project): always save it, opening a new draft if none exists --
      // the room is deleted, so this is the only complete copy; what is saved carries no room link
      const id = kind === "room" ? ensureActiveDraftId() : getActiveDraftId();
      if (id) await saveDraft(id);
      // If a disk file was saved during this session, write that file again as it is now (otherwise it still remembers the room that has been deleted)
      if (kind === "room" && hasSaveTarget()) await writeProcToDisk(serializeProc(), `${getState().project.name || tr("Untitled")}.proc`);
    },
    enter: async ({ projectId, name, snapshot, kind: from }) => {
      sameAccount();
      await enterAccountProject({ client, origin, projectId, name, initial: snapshot,
        enteredText: from === "room" ? ACCOUNT_MOVE_TEXT.toastRoom : ACCOUNT_MOVE_TEXT.toastLocal,
        // Compare once more at the moment of switching: if either the content in the editor or the content sent by the cloud differs from the verified copy, do not switch (the flow uploads again later)
        guard: (cloudNow) => {
          if (!sameContent(getState().project, snapshot) || !sameContent(cloudNow, snapshot)) throw Object.assign(new Error("content-changed"), { code: "content-changed" });
        } });
      // Later "Save" no longer writes back to the local draft or file (it stays as a plain local project); consistent with entering a cloud project from the start page
      setActiveDraftId(null);
      forgetSaveTarget();
    },
    queueMedia: async () => {
      // If it cannot be handed over (upload channel not ready after 30 seconds) returns null: the background bubble says plainly "upload not started yet" and hands it over again after a while, until accepted
      const r = await queueExistingMedia();
      const projectId = getSyncView().shared?.projectId;
      if (projectId) watchBackground(projectId, r);
      return r;
    },
    attempts,
    newRequestId: () => `move-${crypto.randomUUID()}`,
    // Placeholder content: a complete blank project (the editor cannot open it with just `{ tracks: [] }`); the project ID is kept from the local one
    stub: (name, contentId) => ({ ...createEmptyProject(name), id: contentId }),
    linkOf: (projectId) => projectLink(origin, projectId),
    onStage: (stage) => { testHook?.onStage?.(stage); request.onStage?.(stage); },
    owner: pageSession(),
  }, { name: request.name, creatorPassword: password });
  return { ...result, kind };
}
