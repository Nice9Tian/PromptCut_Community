/**
 * The page's sync manager (c65-design.md sections 4, 6, 8, 9): the page connects to the document service
 * over WebSocket and attaches DocSync to the store.
 *
 * - **Local project**: connects to the local editor's `/docservice` (loopback with nothing attached =
 *   the `local` space), and the project ID is `project.id`.
 *   When another project is loaded (start page, open .proc, new), it switches to a new connection and a
 *   new DocSync and writes the loaded content in as a root replacement (the opened file is the copy the
 *   user wants); when the loaded one is still the same project, it is a root replacement of it.
 * - **Shared project**: by the connection at entry time (by proof, `server/auth/client.mjs`), and the
 *   project ID is the shared project's `projectId`.
 *   Loading another project inside a shared project = leaving the shared project and returning to the
 *   local space (another file is not laid over everyone's project in full).
 * - `?join=<project ID>`: a second page joins the same local project, the content follows the document
 *   service and no root replacement is done (used by the real page version of V2).
 * - Headless instance (`?headless=1`), read-only viewing, or when the local document service cannot be
 *   reached: not attached, and the store uses the snapshot stack as before.
 *
 * UI state (sync status, offline dialog, undo toast, member list, blocking popup, bubble) lives in a
 * small store here, and components read it with `useSync(selector)`.
 */
import { useSyncExternalStore } from "react";
import { bindStore, DocSync, type CommitSummary, type LocalBackup, type PausedInfo, type SyncNotice, type SyncStatus, type UndoResult, type Writer } from "../../store/docsync";
import { actions, getState, subscribe, setProjectLoader } from "../../store/project";
import { entitiesOf, entityOfPath, type PathOp } from "../../kernel/diffProject";
import type { Project } from "../../kernel/project";
import { isViewOnly, setProjectAccess } from "../io/viewOnly";
import { SyncLink, type AnyMsg, type CloseInfo } from "./link";
import { classifyEnterFailure, classifyProtocolError } from "./enterFailure";
import { client, errorStatus, route, hosted, type Candidate, type SharedMode, type Where } from "./sharedApi";
import { currentAssociation, noteConvertedFrom, publishGoneConversion, setAssociation, takeLoadedAssociation, type CollaborationDescriptor, type CloudProjectAssociation, currentCloudAssociation, setCloudAssociation, takeLoadedCloudAssociation, handleCloudAssociationReopen, setRealtimeRevGetter, setCloudSnapshotGetter } from "./recoveryAssociation";
import { reopenPlan } from "./cloudSnapshot";
import { convertGoneProject, restoreOfflineEdits, type GoneProof } from "./cloudGone";




// @ts-expect-error Browser-safe service identity validation.
import { serviceIdentity } from "../../../server/recovery/descriptor.mjs";


import { accountNameKey, clipOfEntity, entityLabel, rolledBackText, writerLabel, type DisplayNames, type Me } from "./labels";
import { undoConflictPlan } from "./undoConflict";
import { connectSharedAssets, disconnectSharedAssets, lanAssetBaseOf, receiveSharedAssetEndpoints } from "../media/assetTiers";
import { bindCardSync, noteProjectForCardSync, detachCardSync, takeMineCard, receiveCardSyncNotice } from "./cardSync";
import { accountCardTicket } from "./accountCardSync";
import { createAccountLinkLife } from "./accountLinkLife";
import { bindAgentSide, releaseAgentSide } from "./agentSideBinding";
import { bindRenderNode, unbindRenderNode } from "./renderNodeHandoff";
import { receivePresence, resyncPresenceLink, setPresenceLink } from "./presence";
import { ONLINE } from "../../online/mode";
import { cacheCollabSecrets } from "./collabSecrets";
import { accountHostedFailure, applyHostedChange, applyHostedOptionChange, hostedChangeNotices, HOSTED_SERVICE_TEXT, hostedOptionText, parseHosted, type HostedOptionName, type HostedServiceName, type HostedView } from "./hostedServices";
import {
  ensureOnlineExtensionsLoaded,
  getSyncCloudBackend,
  subscribeSyncCloudBackend,
  type AccountMemberOperation,
  type AccountMemberResult,
  type AccountMembersSnapshot,
  type CloudAccountClient,
  type CloudIdentity,
  type ProjectSession,
  type RecoveryCoordinatorHandlers,
  type RecoveryCoordinatorLike,
} from "../../online/boot";



/**
 * Compile-time constant of the online build (see "Online build pruning" in `src/online/pageFlag.ts` for
 * the syntax and purpose), with the same value as `ONLINE`. Used only at pruning sites, written as
 * `!ONLINE_BUILD && !ONLINE`: in the online build the whole expression folds to false, and in unit tests,
 * when `mode.ts` is swapped for an online stub, it still follows `ONLINE` as before.
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";
/** Account project: interval (milliseconds) for renewing the session to read the service switches the creator changed, one's own permissions and member changes; renewed any time when the session is about to expire */
export const ACCOUNT_METADATA_RENEW_MS = 15_000;
/** Key of the bubble for entering a cloud project: one bubble per key, and entering another project replaces the previous one (issue #15) */
export const ENTERED_TOAST_KEY = "cloud-entered";
/** How long the bubble for entering a cloud project stays (milliseconds). Callers that bring their own text ("move to the cloud") are not governed by this number, see `enterAccountProject` */
export const ENTERED_TOAST_MS = 8000;
import { loadBrowserDevice } from "../../online/device";

import { hostedWsUrlOf } from "../../online/invite";
const discoverRoom = async (opts: Record<string, unknown>): Promise<Candidate> => { await ensureOnlineExtensionsLoaded(); return getSyncCloudBackend().discoverRoom(opts) as Promise<Candidate>; };
const relayFetch = (access: unknown): typeof fetch => getSyncCloudBackend().relayFetch(access);
const authorizeRelayAsset = async (candidate: Candidate, ticket: string): Promise<void> => { await ensureOnlineExtensionsLoaded(); return getSyncCloudBackend().authorizeRelayAsset(candidate, ticket); };
const queryGone = async (descriptor: CollaborationDescriptor, opts?: { signal?: AbortSignal }) => { await ensureOnlineExtensionsLoaded(); return getSyncCloudBackend().queryGone(descriptor, opts); };
const setHostedAgent = (projectId: string, raw: unknown) => getSyncCloudBackend().setHostedAgent(projectId, raw);
const setHostedAgentEnabled = (projectId: string, enabled: boolean) => getSyncCloudBackend().setHostedAgentEnabled(projectId, enabled);
const clearHostedAgent = () => getSyncCloudBackend().clearHostedAgent();
const setCloudIdentity = (next: CloudIdentity | null) => getSyncCloudBackend().setCloudIdentity(next);
const accountCloudIdentity = (options: Parameters<ReturnType<typeof getSyncCloudBackend>["accountCloudIdentity"]>[0]) => getSyncCloudBackend().accountCloudIdentity(options);
const setCloudConsentSource = (next: { client: CloudAccountClient; accountId: string } | null) => getSyncCloudBackend().setCloudConsentSource(next);
const accountConnectionProtocols = (session: ProjectSession) => getSyncCloudBackend().accountConnectionProtocols(session);
const projectLink = (origin: string, projectId: string, linkToken?: string) => getSyncCloudBackend().projectLink(origin, projectId, linkToken);

class AccountFailure extends Error {
  status: number;
  code: string;
  body?: Record<string, unknown>;
  constructor(status: number, code: string, message?: string, body?: Record<string, unknown>) {
    const created = getSyncCloudBackend().createAccountFailure(status, code, message, body) as Error & { status: number; code: string; body?: Record<string, unknown> };
    super(created.message);
    this.status = created.status;
    this.code = created.code;
    if (created.body) this.body = created.body;
    return created as this;
  }
  static [Symbol.hasInstance](instance: unknown): boolean {
    return getSyncCloudBackend().isAccountFailure(instance);
  }
}

class CloudDelegationError extends Error {
  readonly code: string;
  constructor(reason: string) {
    const created = getSyncCloudBackend().createCloudDelegationError(reason);
    super(created.message);
    this.name = "CloudDelegationError";
    this.code = created.code;
    return created as this;
  }
}

class RecoveryCoordinator {
  private inner: RecoveryCoordinatorLike | null = null;
  private readonly handlers: RecoveryCoordinatorHandlers;
  constructor(handlers: RecoveryCoordinatorHandlers) {
    this.handlers = handlers;
    subscribeSyncCloudBackend(() => { this.inner = null; });
  }
  private resolve(): RecoveryCoordinatorLike {
    if (!this.inner) this.inner = getSyncCloudBackend().createRecoveryCoordinator(this.handlers);
    return this.inner;
  }
  get generation(): number {
    return this.resolve().generation;
  }
  start(descriptor: CollaborationDescriptor, contentId?: string): void {
    void ensureOnlineExtensionsLoaded().then(() => { this.resolve().start(descriptor, contentId); });
  }
  cancel(): void {
    this.resolve().cancel();
  }
}
import { createOnlineBackups, type OnlineBackups } from "./onlineBackups";
import { ACCOUNT_MOVE_TEXT, createAttemptStore } from "./accountMove";
import { nextRecovery, offlineStoreOf, unsentAtRisk, RECOVERED_SHOW_MS, UNSENT_NO_STORE_TOAST, type OfflineStore } from "./onlineStatus";
import { applyMerge, cardConflictThing, selectionList, staleSelections, type Box, type MergeThing, type Selection } from "./mergeItems";
import { MergeTable } from "./mergeTable";
import { offlineThings } from "./offlineTransfer";
import { cacheKey, defaultStore, defaultStoreDurable } from "./offlineCache";
import { tr } from "../../i18n/index.ts";

/* ---------------- UI state ---------------- */

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  /** The editor is bound to the LAN (started with PROMPTCUT_LAN_HOST=1): can act as a LAN host */
  lanHost: boolean;
  /** The page is served by the local editor (opened via the loopback address); a pure browser (online browser mode) cannot act as a LAN host */
  localEditor: boolean;
}

export interface MemberRow {
  deviceId: string | null;
  deviceName: string | null;
  username: string;
  displayName: string;
  creator: boolean;
  tags: { editing: boolean; rendering: boolean; agents: number };
  /** The entry with `service: 'agent'` is the Cloud Agent that entered the project on behalf of this member */
  conns: { role: string; conversation?: number | string; service?: string }[];
  /** A service of the host (not a member): this row is shown by service name (`hostedServices.ts`), not counted in the member count, and has no kick button */
  service?: string;
}

export interface SharedInfo {
  projectId: string;
  name: string;
  mode: SharedMode;
  where: Where;
  base: string;
  username: string;
  /** Enter as the creator */
  creator: boolean;
  hostDeviceName?: string;
  accountId?: string;
  /**
   * Permission sent by the server (`'r'` read-only / `'rw'` read-write). A guest entering someone else's
   * project is always `'r'` (user decision, 2026-10-23).
   * The UI goes read-only based on it (`src/editor/io/viewOnly.ts`); what really blocks writes is the
   * server, not this field.
   */
  access?: 'r' | 'rw';
}

export interface UndoNoticeView {
  id: number;
  kind: "undo" | "redo" | "agent";
  result: UndoResult;
  /** The project when the prompt is shown (the entity name is taken from it) */
  project: Project;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "warn";
  /** A button on a bubble ("Download backup" on the online page): clicking it still doesn't close the bubble; the user closes it */
  action?: { label: string; run: () => void; pc?: string };
  /**
   * Key for a class of bubbles: pushing another one with the same key makes the old one give way (issue #15:
   * every time you entered a cloud project a new persistent bubble was stacked, and clicking between a few
   * projects in Vibe mode piled them into a stack). Bubbles without a key stay independent as before
   */
  key?: string;
}

export type Blocked = "kicked" | "removed" | "deleted";

export interface AgentOp {
  /** Event id (the eventId of `events.event`) */
  eventId: string;
  /** callId of this tool call (only present if the event carries it; the AI panel uses it to match SSE tool calls) */
  callId?: string;
  opId: string;
  inverse?: PathOp[];
  rev?: number;
  by?: Writer;
  state: "ready" | "done" | "none";
}

/**
 * One tool call record in the AI panel (D2, c65-design.md section 7): for each tool call the Agent server sends two
 * events, "created" and "completed"; they are merged into this record by `eventId`. A text reply is a record with
 * `kind: "text"`. Only a summary is stored; the full parameters are in the content store under `event-detail`
 * and are fetched on expand.
 */
export interface EventRecord {
  eventId: string;
  kind: "tool" | "text";
  tool?: string;
  icon?: string | null;
  target?: string | null;
  args?: string | null;
  callId?: string;
  actor?: Record<string, unknown>;
  /** null = still running (only the creation event was received) */
  status: "ok" | "error" | "cancelled" | null;
  summary?: string | null;
  durationMs?: number | null;
  at?: number;
  text?: string;
  /** The commit this call wrote into the project (only present for successful writes) */
  opId?: string;
  detailKey?: string | null;
}

export interface SyncView {
  hostRegistration: string | null;
  association: CollaborationDescriptor | null;
  reopenState: string | null;
  /** The page is connected to the document service (otherwise the store uses the snapshot stack) */
  active: boolean;
  kind: "local" | "shared" | "off";
  status: SyncStatus;
  paused: PausedInfo | null;
  offlineOpen: boolean;
  shared: SharedInfo | null;
  members: MemberRow[];
  /** Availability and switch of the host's service (`hosted` at the top level of the member list); absent for projects kept on this machine and for hosted sides without a registry */
  hosted: HostedView | null;
  blocked: Blocked | null;
  notice: UndoNoticeView | null;
  toasts: Toast[];
  device: DeviceInfo | null;
  /** Version number of the AI panel records: incremented whenever agentOps changes */
  agentOpsVersion: number;
  /** Version number of the tool call records (eventRecords): incremented whenever they change */
  eventsVersion: number;
  /** Number of local commits not yet confirmed by the document service (for the online page's offline notice; not updated on desktop, always 0) */
  unconfirmed: number;
  /** Recovery phase of the online page coming back from offline (C10 contract section 10, `nextRecovery` in `onlineStatus.ts`) */
  recovery: "recovering" | "recovered" | null;
  /** Number of local backups in the online page's memory (`onlineBackups.ts`) */
  onlineBackups: number;
  /** History sequence number of the current project (the rev confirmed by the document service) */
  rev: number | null;
  /**
   * Pending merge table (the "Merge conflicts" window, `mergeItems.ts`): what this user has not finished handling
   * in the current project. Stored in the document service per "project × user" (using a copy staged on this
   * machine when it is unreachable); shared by offline reconnect and the undo conflicts of 0.7.20.
   */
  merge: { things: MergeThing[]; version: number; blocked: string | null };
  /** The "Merge conflicts" window is open (opened automatically when a reconnect moves into a new offline batch; the "Merge conflicts" button in the navigation bar also opens it) */
  mergeOpen: boolean;
  /**
   * Where offline changes are stored now (for the persistent offline notice and the leave confirmation,
   * `onlineStatus.ts`): `saved` = stored on this machine (account cloud projects are written to the browser's
   * local cache; the desktop app's local recovery file); `page` = only in this page (the passphrase room of
   * the old approach on the online page, or the browser local cache failed to write this time).
   */
  offlineStore: OfflineStore;
}

let view: SyncView = {
  hostRegistration: null,
  association: null,
  reopenState: null,
  active: false,
  kind: "off",
  status: "idle",
  paused: null,
  offlineOpen: false,
  shared: null,
  members: [],
  hosted: null,
  blocked: null,
  notice: null,
  toasts: [],
  device: null,
  agentOpsVersion: 0,
  eventsVersion: 0,
  unconfirmed: 0,
  recovery: null,
  onlineBackups: 0,
  rev: null,
  merge: { things: [], version: 0, blocked: null },
  mergeOpen: false,
  offlineStore: ONLINE ? "page" : "saved",
};
const viewListeners = new Set<() => void>();

function patch(p: Partial<SyncView>) {
  view = { ...view, ...p };
  // The UI's read-only switch follows the current project's permissions (`src/editor/io/viewOnly.ts`). Flip it
  // only here, once: there are seven or eight places that leave a project, and recording it in each would
  // eventually miss one, carrying the read-only state into the next project
  if ('shared' in p) setProjectAccess(view.shared ? (view.shared.access ?? 'rw') : null);
  for (const l of viewListeners) l();
}

export function getSyncView(): SyncView {
  return view;
}

// Read-only hook for probes and troubleshooting (like __pcStore and __pcCloud, a __pc* hook): whether we are
// connected right now, the count of unconfirmed items, and where offline changes are stored.
// The UI uses useSync itself, not this; probes use it to check the real state, instead of having to infer it
// backwards from the notices in the UI
if (typeof window !== "undefined") {
  (window as unknown as { __pcSync?: { view: () => SyncView } }).__pcSync = { view: () => view };
}

export function subscribeSync(l: () => void): () => void {
  viewListeners.add(l);
  return () => viewListeners.delete(l);
}

export function useSync<T>(selector: (v: SyncView) => T): T {
  return useSyncExternalStore(subscribeSync, () => selector(view), () => selector(view));
}

let toastSeq = 0;
/**
 * If `ms` is `Infinity` the bubble does not disappear on its own (the user clicks × to close it). Returns this
 * bubble's number (for `dismissToast`). If `key` is given: the old bubble with the same key is removed first,
 * so there is only ever one of a class on screen
 */
export function pushToast(text: string, tone: Toast["tone"] = "info", ms = 6000, action?: Toast["action"], key?: string): number {
  const t: Toast = { id: ++toastSeq, text, tone, ...(action ? { action } : {}), ...(key ? { key } : {}) };
  patch({ toasts: [...(key ? view.toasts.filter((old) => old.key !== key) : view.toasts), t] });
  if (Number.isFinite(ms)) setTimeout(() => dismissToast(t.id), ms);
  return t.id;
}

export function dismissToast(id: number) {
  if (!view.toasts.some((t) => t.id === id)) return;
  patch({ toasts: view.toasts.filter((t) => t.id !== id) });
}

let noticeSeq = 0;
export function dismissNotice() {
  patch({ notice: null });
}

/* ---------------- Connection ---------------- */

interface Current {
  link: SyncLink;
  kind: "local" | "shared";
  docProjectId: string;
  /** Address of the document service this connection connects to (told to the Agent server, see bindAgentSide) */
  url: string;
  unbind: () => void;
  offs: (() => void)[];
  /** Change the in-memory proof used by subsequent reconnects after a successful own-password update. */
  updateAuthentication?: (key: string) => void;
  setAccountAgentEnabled?: (enabled: boolean) => Promise<void>;
  /** Account project: the creator changes the switch of the host's render node, or its sub-option ("Generate track stream"). Member calls are rejected by the server (403) */
  setAccountHosted?: (change: { service: "render"; enabled: boolean } | { service: "render"; option: HostedOptionName; enabled: boolean }) => Promise<void>;
  accountMembers?: () => Promise<AccountMembersSnapshot>;
  /** Diagnostics: the lifetime of this connection in an account project */
  accountLife?: () => { expiresAt: number | null; trusted: boolean | null; renews: number; expires: number; busy: boolean };
  accountMemberAdmin?: (operation: AccountMemberOperation) => Promise<AccountMemberResult>;
  /** Account project: the creator revokes and regenerates the project link, returning the new project link (renews the session once first to get the current access version number) */
  regenAccountLink?: () => Promise<string>;
  /** Account project: the creator sets / changes (string) or clears (null) the project secondary password (same as above, renews the session first) */
  setAccountSecondaryPassword?: (password: string | null) => Promise<void>;
  /** Account project: the current project link (the creator gets it with the current link passphrase) */
  accountLink?: () => string;
}

let cur: Current | null = null;
let started = false;
const session = `page-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 12)}`;

export function pageSession(): string {
  return session;
}

export async function accountProjectMembers(): Promise<AccountMembersSnapshot> {
  const current = cur;
  if (!view.shared?.accountId || !current?.accountMembers) throw new AccountFailure(503, 'members-unavailable');
  const result = await current.accountMembers();
  if (cur !== current) throw new AccountFailure(401, 'credential-revoked');
  return result;
}
export async function accountMemberAdmin(operation: AccountMemberOperation): Promise<AccountMemberResult> {
  const current = cur;
  if (!view.shared?.accountId || !current?.accountMemberAdmin) throw new AccountFailure(503, 'members-unavailable');
  const result = await current.accountMemberAdmin(operation);
  if (cur !== current) throw new AccountFailure(401, 'credential-revoked');
  return result;
}
/** Only leave this page. No logout, membership deletion, or conversion to a local project. */
export async function returnToAccountProjectHome(): Promise<void> {
  const current = cur;
  if (!view.shared?.accountId || !current) return;
  // Keep unsent edits visible if they cannot be confirmed; do not silently discard them.
  await current.link.ds.whenSettled({ timeoutMs: 5000 });
  if (cur !== current) return;
  current.link.stop();
  detach(); disconnectSharedAssets(); clearSharedResume();
  patch({ shared: null, members: [], hosted: null, blocked: null });
  window.dispatchEvent(new Event('pc-go-home'));
}

/** Id of the project currently connected (project.id for a local project, the shared project's projectId for a shared project); project.id when not connected to the document service */
export function currentDocProjectId(): string {
  return cur?.docProjectId ?? getState().project.id ?? "";
}

/** Who this page is (used by the undo notice bar to recognize "you are on another page") */
export function me(): Me {
  const s = view.shared;
  if (s && view.device) return { session, userId: `${s.accountId ? `account:${s.accountId}` : s.username}@${view.device.deviceId}` };
  return { session, userId: "local" };
}

export function displayNames(): DisplayNames {
  const m: DisplayNames = new Map();
  for (const row of view.members) if (row.deviceId) m.set(`${row.username}@${row.deviceId}`, row.displayName);
  // Account cloud project: `view.members` is empty (the member list goes through the account API instead), and names are recorded per account in `accountNames`
  for (const [accountId, name] of accountNames) m.set(accountNameKey(accountId), name);
  return m;
}

/**
 * Names of each member's account in an account cloud project (used for "who changed it" in notice bubbles):
 * fetch the member list once when entering the project, then again when members change (the permission version
 * in the session changed). Cleared on leaving the project. If it can't be fetched there are no names, and the
 * bubble shows its original fallback.
 */
let accountNames = new Map<string, string>();
function accountNamesFrom(snapshot: AccountMembersSnapshot): void {
  const next = new Map<string, string>();
  for (const row of snapshot.members) if (row.accountName) next.set(row.accountId, row.accountName);
  accountNames = next;
}

function localWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/docservice`;
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

/**
 * Device info: provided by the local editor; a pure browser (online browser mode) uses a random id stored in
 * the page's local storage and "browser name + OS name + random 4 digits"
 * (C10a contract section 2, `src/online/device.ts`), without going through `/api/docservice/device`.
 */
async function loadDevice(): Promise<DeviceInfo | null> {
  if (ONLINE) {
    const d = loadBrowserDevice();
    return { deviceId: d.deviceId, deviceName: d.deviceName, lanHost: false, localEditor: false };
  }
  /*
   * Devices on the LAN ("the second screen on the LAN": a phone or tablet opening the host's page) cannot reach
   * this API: `/api/**` other than the asset service only answers loopback (`server/vite-plugin-api-guard.ts`),
   * and they get a 403. So use the page's own identity, the same path as the online browser
   * (`src/online/device.ts`): this device has no editor process to begin with, so `localEditor` is false.
   * Found by the 2026-10-26 end-to-end probe: without this fallback these devices cannot join a shared project.
   */
  const onLoopback = isLoopbackHost(location.hostname);
  const browserDevice = (): DeviceInfo => {
    const d = loadBrowserDevice();
    return { deviceId: d.deviceId, deviceName: d.deviceName, lanHost: false, localEditor: false };
  };
  try {
    const r = await fetch("/api/docservice/device", { cache: "no-store" });
    if (!r.ok) return onLoopback ? null : browserDevice();
    const j = await r.json();
    if (!j?.ok) return onLoopback ? null : browserDevice();
    return { deviceId: j.deviceId, deviceName: j.deviceName, lanHost: !!j.lanHost, localEditor: onLoopback };
  } catch {
    return onLoopback ? null : browserDevice();
  }
}

/* ---------------- Local backup ---------------- */

/**
 * The online page's local backups stay only in this page's memory (C10 contract section 10, section 18 item 4;
 * `onlineBackups.ts`): nothing is written to browser storage, nothing is downloaded automatically, and closing
 * the page loses them. Desktop writes to the editor process's `/api/project-backups` as before.
 */
const onlineBackupStore: OnlineBackups = createOnlineBackups({ projectName: () => getState().project.name });
onlineBackupStore.subscribe(() => patch({ onlineBackups: onlineBackupStore.list().length }));

export function onlineBackups(): OnlineBackups {
  return onlineBackupStore;
}

/**
 * Online page: store in memory and give the "Download backup" button on the spot.
 * - Overwritten: a notice that doesn't interrupt the operation (a bubble that disappears after 10 seconds;
 *   the panel can still download it);
 * - Offline changes discarded: the user just clicked "Discard" in the dialog, and the bubble stays until the
 *   user closes it.
 */
function saveOnlineBackup(b: LocalBackup) {
  const index = onlineBackupStore.save(b);
  const action = { label: tr("Download backup"), pc: "backup-download", run: () => { onlineBackupStore.download(index); } };
  if (b.kind === "overwritten") {
    const what = entityLabel(b.entity, getState().project);
    pushToast(tr("{0} was overwritten by someone else; your earlier version is kept on this page. You can download a backup before closing the page.", what), "info", 10_000, action);
  } else {
    pushToast(tr("Discarded {0} offline edit steps; they are kept on this page. You can download a backup before closing the page.", b.batch.length), "warn", Infinity, action);
  }
}

async function saveBackup(b: LocalBackup) {
  // The whole-batch rollback when an offline batch is moved item by item into the pending merge table: the content is in the pending merge table and this copy is only a safety net, so no "Discarded" notice (on the online page it stays in this page's memory)
  const quiet = b.kind === "offline-discard" && transferringBatch;
  if (quiet) {
    if (ONLINE) { onlineBackupStore.save(b); return; }
  } else if (ONLINE) {
    saveOnlineBackup(b);
    return;
  }
  const project = getState().project;
  const body =
    b.kind === "offline-discard"
      ? { ...b, projectName: project.name, pageSession: session, batch: b.batch.map((x) => ({ ...x, entities: entitiesOf(x.ops) })) }
      : { ...b, projectName: project.name, pageSession: session };
  try {
    const r = await fetch("/api/project-backups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    // Even if it can't be saved, the user must know: don't let them think the backup is there (except the safety net when moving to the table: the content is in the pending merge table)
    if (!quiet) pushToast(tr("The local backup was not saved ({0}); the overwritten version cannot be recovered.", (e as Error).message), "warn", 10_000);
  }
}

/* ---------------- Outline for remote changes ---------------- */

const FLASH_MS = 1500;

function flashEntities(entities: string[]) {
  if (typeof document === "undefined") return;
  const ids = new Set<string>();
  const project = getState().project;
  for (const e of entities) {
    const clip = clipOfEntity(e);
    if (clip) ids.add(clip);
    const track = /^\/tracks\/@([^/]+)$/.exec(e);
    if (track) for (const c of project.tracks.find((t) => t.id === track[1])?.clips ?? []) ids.add(c.id);
  }
  if (!ids.size) return;
  // Wait until this change has rendered before looking up the element (a newly inserted clip only has its DOM then). Use a timer, not rAF: rAF doesn't run while the page is in the background
  setTimeout(() => {
    for (const id of ids) {
      for (const el of document.querySelectorAll<HTMLElement>(`[data-clip-id="${CSS.escape(id)}"]`)) {
        el.setAttribute("data-remote-flash", "");
        const prev = Number(el.dataset.remoteFlashTimer || 0);
        if (prev) clearTimeout(prev);
        el.dataset.remoteFlashTimer = String(
          setTimeout(() => {
            el.removeAttribute("data-remote-flash");
            delete el.dataset.remoteFlashTimer;
          }, FLASH_MS),
        );
      }
    }
  }, 30);
}

/* ---------------- Binding ---------------- */

function onNotice(n: SyncNotice) {
  switch (n.kind) {
    case "undo":
    case "revert-remote": {
      const r = n.result;
      if (!r.skipped.length && !r.failed.length) return;
      // Changed further by others on top of it: split by changed item; items nobody changed are undone directly, real conflicts go to the "Merge conflicts" window (user decision, 2026-10-18);
      // the notice bar keeps only those that "no longer exist and can't be rolled back"
      const routed = r.skipped.length > 0 && r.conflict !== undefined && routeUndoConflict(r.conflict);
      const shown = routed ? { ...r, skipped: [] } : r;
      if (!shown.skipped.length && !shown.failed.length) return;
      patch({ notice: { id: ++noticeSeq, kind: n.kind === "undo" ? (n.redo ? "redo" : "undo") : "agent", result: shown, project: getState().project } });
      return;
    }
    case "overwritten": {
      // Wording follows section 5 of the interaction draft, with "recovery entry pending ruling" replaced by the entry the ruling settled on (c65-design.md section 8)
      const who = writerLabel(n.by, me(), displayNames());
      pushToast(tr("Your recent edits were overwritten by {0}. Your edited version has been saved to the draft backups (find it under the \"Project\" menu → \"Local backups…\").", who), "warn", 10_000);
      return;
    }
    case "remote":
      flashEntities(n.entities);
      return;
    case "rejected":
      pushToast(tr("An edit was not accepted by the document service ({0}) and has been rolled back.", n.reason), "warn");
      return;
    case "replay-dropped":
      pushToast(tr("An offline edit could not be applied on top of the latest history sequence number and was discarded."), "warn");
      return;
    default:
      return;
  }
}

function refreshStatus() {
  if (!cur) return;
  const ds = cur.link.ds;
  // Offline batch rejected and stopped: move it item by item into the pending merge table (only if that fails, fall back to the offline dialog that handles the whole batch)
  if (ds.status === "paused" && mergeTable && !transferringBatch) transferOffline(cur.link);
  const status = ds.status;
  const paused = ds.pausedInfo;
  patch({ status, paused, offlineOpen: status === "paused" ? view.offlineOpen || view.status !== "paused" : false });
  attachMergeChannel(status === "online" ? cur.link : null);
  if (ONLINE) tickOnline();
}

/*
 * Online page: the count of unconfirmed commits and the recovery phase (C10 contract section 10). DocSync emits
 * no event for "the unconfirmed count changed", so we check every 500 ms here (updating the UI state only when
 * it changed); `refreshStatus` also checks once on the way when the state changes.
 */
export const ONLINE_TICK_MS = 500;
let recoveryState: { phase: "recovering" | "recovered" | null; wasOffline: boolean; hadUnsent: boolean } = { phase: null, wasOffline: false, hadUnsent: false };
/** Offline changes of this round can't be kept (the browser can't provide storage, or the write failed): the bubble speaks only in these two cases, not for the passphrase room, which "never persists to disk anyway" */
let journalUnstorable = false;
/** Whether that bubble has already been shown this round (the persistent notice stays up, so showing the bubble once is enough) */
let noStoreToasted = false;
let recoveredTimer: ReturnType<typeof setTimeout> | null = null;

function tickOnline() {
  if (!cur) return;
  const ds = cur.link.ds;
  const unconfirmed = ds.unconfirmed;
  const prevPhase = recoveryState.phase;
  recoveryState = nextRecovery(recoveryState, ds.status, unconfirmed);
  if (recoveryState.phase === "recovered" && prevPhase !== "recovered") {
    if (recoveredTimer) clearTimeout(recoveredTimer);
    recoveredTimer = setTimeout(() => {
      recoveredTimer = null;
      if (recoveryState.phase === "recovered") recoveryState = { ...recoveryState, phase: null };
      patch({ recovery: null });
    }, RECOVERED_SHOW_MS);
  }
  if (unconfirmed !== view.unconfirmed || recoveryState.phase !== view.recovery) patch({ unconfirmed, recovery: recoveryState.phase });
  // Can't be kept, and there really are uncommitted changes piled up: show a bubble once to explain why (the persistent notice only says "where")
  if (journalUnstorable && !noStoreToasted && unsentAtRisk(ds.status, unconfirmed, view.offlineStore)) {
    noStoreToasted = true;
    pushToast(UNSENT_NO_STORE_TOAST, "warn", 12_000);
  }
}

/* ---------------- Project copy on the Agent server: binding and unbinding are in `agentSideBinding.ts`, here we only answer the ticket it needs ---------------- */

/**
 * `agent.ticket` in SSE: the Agent server wants a connection ticket with the agent role (k:'conn', r:'agent',
 * c: chat id). Signed on this page's connection to this shared project (same identity as this page), and handed
 * back to POST /api/agent/ticket.
 */
export async function issueAgentTicket(req: { reqId?: unknown; projectId?: unknown; conversation?: unknown }): Promise<void> {
  if (ONLINE) return; // The Agent server lives in the editor process, which the online page doesn't have
  const reqId = typeof req.reqId === "string" ? req.reqId : null;
  if (!reqId) return;
  let reply: Record<string, unknown>;
  try {
    if (!cur || cur.kind !== "shared" || cur.docProjectId !== req.projectId) throw new Error(tr("This page is not connected to this shared project"));
    const r = await cur.link.request({ type: "auth.ticket", kind: "conn", role: "agent", conversation: Number(req.conversation) });
    if (r.type !== "auth.ticket.ok" || typeof r.ticket !== "string") throw new Error(String(r.reason ?? r.detail ?? r.type));
    reply = { reqId, ticket: r.ticket };
  } catch (e) {
    reply = { reqId, error: (e as Error).message };
  }
  await fetch("/api/agent/ticket", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reply) }).catch(() => undefined);
}

/**
 * Card source sync (C6.6 section 5, `cardSync.ts`): when the editor process wants a connection ticket with the
 * page role, it is signed on this page's shared project connection; notices go through the same bubbles, and
 * the writer identity is shown per the member list.
 */
const cardSyncHooks = {
  ticket: async (projectId: string): Promise<string> => {
    if (!cur || cur.kind !== "shared" || cur.docProjectId !== projectId) throw new Error(tr("This page is not connected to this shared project"));
    const r = await cur.link.request({ type: "auth.ticket", kind: "conn", role: "page" });
    if (r.type !== "auth.ticket.ok" || typeof r.ticket !== "string") throw new Error(String(r.reason ?? r.detail ?? r.type));
    return r.ticket;
  },
  toast: (text: string, tone: Toast["tone"], ms?: number) => pushToast(text, tone, ms),
  who: (actor: Record<string, unknown> | null | undefined) =>
    actor ? writerLabel({ actor, session: typeof actor.session === "string" ? actor.session : undefined }, me(), displayNames()) : tr("Someone else"),
  // A card changed during the disconnection and also changed in the cloud by someone else: one entry per card goes into "Merge conflicts" (this machine has switched to the cloud version, my version is in the table, and there is also a backup)
  conflict: (c: { key: string; mine: string; cloud: string; rev: number }) => {
    const table = mergeTable;
    if (!table) return false;
    void table.add([cardConflictThing({ key: c.key, mine: c.mine, cloud: c.cloud, rev: c.rev, at: Date.now(), batch: newBatchId() })]);
    patch({ mergeOpen: true });
    return true;
  },
};

/**
 * The desktop app automatically becomes a render node of the shared project (`renderNodeHandoff.ts`): the render
 * connection ticket the prerender process needs when it creates a new session is signed on this page's shared
 * project connection (`owner: { kind: 'user' }`: this is the user's own desktop node, and it can claim tasks of
 * any member of this project).
 */
const renderNodeHooks = {
  ticket: async (projectId: string): Promise<string> => {
    if (!cur || cur.kind !== "shared" || cur.docProjectId !== projectId) throw new Error(tr("This page is not connected to this shared project"));
    const r = await cur.link.request({ type: "auth.ticket", kind: "conn", role: "render", owner: { kind: "user" } });
    if (r.type !== "auth.ticket.ok" || typeof r.ticket !== "string") throw new Error(String(r.reason ?? r.detail ?? r.type));
    return r.ticket;
  },
};

/**
 * Identity of the Cloud Agent (contract `docs/plan/cloud-agent-contract.md` section 4.2): the delegation ticket
 * and the chat delegation are both requested on this page's connection to the shared project
 * (`auth.ticket { kind: 'delegate', audience: 'agent', conversation? }`), and the identity and permissions are
 * those of this page's member. Same path for the online page and the desktop app.
 * Tickets are not cached (a delegation ticket lives only 2 minutes and is fetched fresh per request; chat
 * delegation fetches a new one for every message sent) and are not logged.
 * When the connection is replaced (leaving the project, switching projects) this identity is invalidated:
 * later requests are refused outright and never get another project's ticket.
 */
function cloudIdentityOf(link: SyncLink): CloudIdentity {
  const ask = async (conversation?: string): Promise<string> => {
    if (!cur || cur.link !== link || cur.kind !== "shared") throw new CloudDelegationError("closed");
    let r: AnyMsg;
    try {
      r = await link.request({ type: "auth.ticket", kind: "delegate", audience: "agent", ...(conversation ? { conversation } : {}) });
    } catch {
      throw new CloudDelegationError("closed");
    }
    if (r.type !== "auth.ticket.ok" || typeof r.ticket !== "string" || !r.ticket) throw new CloudDelegationError(String(r.reason ?? r.type));
    return r.ticket;
  };
  return { getTicket: () => ask(), getGrant: (conversationId) => ask(conversationId) };
}

/** Before an Agent tool that stays on the page executes, record a position; after it executes, take the commits this page issued in between (the reply carries opIds, used by server/agent/agent-side.mjs) */
export function pageOpMark(): number | null {
  return cur ? cur.link.ds.opMark() : null;
}

export function pageOpIdsSince(mark: number | null): string[] {
  if (!cur || mark === null) return [];
  return cur.link.ds.opIdsSince(mark);
}

function bind(link: SyncLink, kind: "local" | "shared", docProjectId: string, url: string, accountClient: CloudAccountClient | null = null, mergeUser: string | null = kind === "local" ? "local" : null) {
  const account = accountClient !== null;
  const prev = cur;
  if (!account) accountNames = new Map();
  if (prev) {
    for (const off of prev.offs) off();
    prev.unbind();
  }
  const unbind = bindStore(link.ds, { load: onLoad });
  let seenProject: Project | null = null;
  const offs = [
    link.ds.on("status", () => refreshStatus()),
    link.ds.on("notice", onNotice),
    // Card source sync: report again when the cards the project uses change (a card was added on the timeline) (C6.6 section 5)
    subscribe(() => {
      const p = getState().project;
      if (p === seenProject) return;
      seenProject = p;
      noteProjectForCardSync(p);
      // Automatic render node: hand over again when the project document's id (used by the layer table key) arrives late (the same project only changes its id, no rebuild)
      if (!account && kind === "shared" && !ONLINE_BUILD && !ONLINE) bindRenderNode({ url, projectId: docProjectId, contentId: p.id || null }, renderNodeHooks);
    }),
    link.ds.on("project", () => { patch({ rev: link.ds.rev }); }),
    link.ds.on("status", () => { patch({ rev: link.ds.rev }); }),
  ];
  if (ONLINE) {
    recoveryState = { phase: null, wasOffline: false, hadUnsent: false };
    const tick = setInterval(tickOnline, ONLINE_TICK_MS);
    offs.push(() => clearInterval(tick));
  }
  cur = { link, kind, docProjectId, url, unbind, offs };
  bindMergeTable(docProjectId, mergeUser);
  // Account cloud project (both online browser and desktop app): changes made during disconnection are written to the browser local cache (the collaboration room of the old approach additionally has a local recovery file on the desktop app)
  if (mergeUser && account) offs.push(watchBrowserJournal(link, docProjectId, mergeUser));
  // Where offline changes are stored: an account project is written to the browser local cache, and the desktop app has a local recovery file → this machine; the online page's passphrase room is not written to disk → only this page.
  // When this browser can provide neither IndexedDB nor localStorage (private mode, storage disabled), the cache falls back to an in-memory version that raises no error on write,
  // and that copy is gone when the page closes: always count it as "only in this page", so a false "stored on this machine" doesn't hide it from both the notice and the leave confirmation
  journalUnstorable = !defaultStoreDurable();
  noStoreToasted = false;
  patch({ offlineStore: offlineStoreOf({ durable: !journalUnstorable, account, online: ONLINE }) });
  // The Cloud Agent's identity follows the shared project's connection: ready once connected, revoked on returning to the local space (the UI re-fetches info and the chat list accordingly)
  setCloudIdentity(kind === "shared" && !account ? cloudIdentityOf(link) : null);
  setCloudConsentSource(kind === "shared" && accountClient ? { client: accountClient, accountId: accountClient.principal?.id ?? "" } : null);
  if (kind !== "shared") clearHostedAgent();
  if (kind === "shared" && !ONLINE_BUILD && !ONLINE) {
    const descriptor = currentAssociation();
    if (descriptor) offs.push(link.ds.on("project", () => persistJournal(link.ds, descriptor, getState().project.id ?? "")));
    if (descriptor?.where === "lan") {
      const checkHost = () => { void recoveryRequest("host-state", descriptor).then(r => { if (cur?.link === link) patch({ hostRegistration: r.state === "inactive" ? null : r.state }); }, () => { if (cur?.link === link) patch({ hostRegistration: "pending" }); }); };
      checkHost(); const timer = setInterval(checkHost, 2000); offs.push(() => clearInterval(timer));
    }
  }
  // Presence (A3 phase 2): the clips this page is "editing" are published over this connection, and the Agent's scope on other members' side is received through it
  setPresenceLink(link, docProjectId, me().userId ?? "", account);
  patch({ active: true, kind, rev: link.ds.rev, members: kind === "local" ? [] : view.members, hosted: kind === "local" ? null : view.hosted, notice: null });
  refreshStatus();
  // The Agent server and card source sync both live in the editor process; the online page has no editor process (C10a section 2), so don't bind (in the online build /api/agent/bind and /api/cards/sync/bind are stripped out)
  if (!account && !ONLINE_BUILD && !ONLINE) {
    bindAgentSide(kind, docProjectId, url);
    bindCardSync({ kind, projectId: docProjectId, url }, getState().project, cardSyncHooks);
    /*
     * The desktop app automatically becomes a render node of the shared project (semantics product/platforms.md "render node"; `renderNodeHandoff.ts`):
     * revoked on leaving the shared project (back to the local space, cancelling collaboration, switching to open another project); on connecting to a shared project the shared config is handed to the prerender process.
     * Connecting to the local space when the page has just opened (prev is empty) doesn't count as leaving: the config handed over by another tab or the last open stays untouched.
     */
    if (prev?.kind === "shared" && (kind !== "shared" || prev.docProjectId !== docProjectId)) unbindRenderNode(prev.docProjectId, kind === "shared" ? "switched" : "left");
    if (kind === "shared") bindRenderNode({ url, projectId: docProjectId, contentId: getState().project.id || null }, renderNodeHooks);
  }
  // Account cloud project (desktop app): release the old binding left on the Agent server, and connect card source sync with the ticket from the account approach (the render node doesn't connect this time)
  if (accountClient && !ONLINE_BUILD && !ONLINE) bindAccountEditorSide(link, docProjectId, url, accountClient);
  if (prev && prev.link !== link) retire(prev.link);
}

/**
 * What the editor process side must do when the desktop app enters an account cloud project (render node not included):
 * - Agent server: don't bind in an account project (the local Agent goes through "page does it on its behalf"), but the binding the previous project left on the server must be released (`agentSideBinding.ts`);
 * - Card source sync: when the editor process wants a ticket, the page fetches another project session with the login and hands over the connection ticket in it (`accountCardSync.ts`).
 */
function bindAccountEditorSide(link: SyncLink, docProjectId: string, url: string, client: CloudAccountClient) {
  releaseAgentSide();
  const accountId = client.principal?.id;
  bindCardSync({ kind: "shared", projectId: docProjectId, url, account: true }, getState().project, {
    ...cardSyncHooks,
    ticket: accountCardTicket({
      session: (projectId) => client.session(projectId),
      isCurrent: () => cur?.link === link && !!accountId && client.principal?.id === accountId,
      stop: detachCardSync,
    }),
  });
}

/** Online page leaves a shared project: there is no local document service to return to, so release the current connection and the store goes back to the snapshot stack (C10a) */
function detach() {
  const prev = cur;
  cur = null;
  bindMergeTable(null, null);
  accountNames = new Map();
  setCloudIdentity(null);
  setCloudConsentSource(null);
  setCloudAssociation(null);
  clearHostedAgent();
  setPresenceLink(null, null, "");
  if (prev) {
    for (const off of prev.offs) off();
    prev.unbind();
    retire(prev.link);
    if (prev.kind === "shared" && !ONLINE_BUILD && !ONLINE) unbindRenderNode(prev.docProjectId, "left");
    if (!ONLINE_BUILD && !ONLINE) {
      // When entering an account project the Agent server binding was already released, so here only card source sync is released
      if (!view.shared?.accountId) releaseAgentSide();
      detachCardSync();
    }
  }
  patch({ active: false, kind: "off", status: "idle", paused: null, offlineOpen: false, notice: null, unconfirmed: 0, recovery: null, hostRegistration: null });
}

/** The replaced connection: wait until its unconfirmed commits land (at most 5 s), then close it */
function retire(link: SyncLink) {
  link.ds
    .whenSettled({ timeoutMs: 5000 })
    .catch(() => undefined)
    .finally(() => link.stop());
}

function newLocalLink(docProjectId: string, initial: Project): SyncLink {
  const link: SyncLink = new SyncLink({
    url: localWsUrl(),
    protocols: () => ["promptcut.v1"],
    projectId: docProjectId,
    session,
    initial,
    saveBackup: (b) => void saveBackup(b),
    onMessage: onSideMessage,
    // After connecting, backfill the most recent tool call records (the AI panel's action log; the document service keeps the latest 500 per project in memory)
    onOpen: () => void link.send({ type: "events.list", projectId: docProjectId }),
  });
  return link;
}

/** Switch to this project in the local space; when `load` is true, write this content in as a root replacement (the file content wins) */
function switchToLocal(project: Project, { load }: { load: boolean }): Project {
  if (ONLINE) {
    // The online page has no local space: leaving a shared project means disconnecting (C10a section 2)
    detach();
    patch({ shared: null, members: [], hosted: null, blocked: null });
    disconnectSharedAssets();
    return project;
  }
  const id = project.id || "untitled";
  const link = newLocalLink(id, project);
  if (load) link.ds.load(project);
  bind(link, "local", id, localWsUrl());
  patch({ shared: null, members: [], hosted: null, blocked: null });
  // C6.6: returning to the local space = returning to the local asset service
  disconnectSharedAssets();
  link.start();
  return link.ds.project;
}

/** The store's load (loadProject) is handed over here: the same local project is a root replace, any other project switches the connection */
function onLoad(project: Project): Project {
  const previousAssociation = currentAssociation();
  identitySave = null; lastIdentity = null;
  releaseHolding();
  recoveryCoordinator.cancel();
  cancelHostTask(previousAssociation);
  const association = takeLoadedAssociation(project);
  const cloudAssoc = takeLoadedCloudAssociation(project);
  patch({ association, reopenState: null, rev: cur?.link.ds.rev ?? null });
  if (cloudAssoc) {
    detach(); disconnectSharedAssets();
    setCloudAssociation(cloudAssoc);
    void handleCloudAssociationReopen(project, cloudAssoc, {
      toast: pushToast,
      // The "not a member" prompt with the "Send request" button was sent as one that must be dismissed (notMemberToast in recoveryAssociation.ts)
      dismissToast,
      openAsLocal: (p) => { switchToLocal(p, { load: false }); },
      enterProject: async (opts) => {
        await enterAccountProject(opts);
        const ds = cur?.link.ds;
        if (!ds || !ds.confirmedProject) return;
        // Pinned non-local snapshot (`cloudSnapshot.ts`): the file carries the baseline from when it was saved as, so compare it with the file content item by item:
        // if nobody touched the cloud, commit directly; if others changed it, go to "Conflict merge", and later changes by others are not treated as "undone by me"
        const plan = reopenPlan(cloudAssoc, project, ds.rev, { batch: newBatchId(), at: Date.now() });
        if (plan.kind === "none") return;
        if (plan.kind === "table") {
          if (mergeTable) {
            void mergeTable.add(plan.things);
            patch({ mergeOpen: true });
            return "pending-merge";
          }
        } else if (plan.kind === "commit") {
          ds.mergeOffline(project, ds.rev);
          return;
        }
        // Old file without a baseline: merge in against the cloud state at reconnect time as before (conflicts are handled like an offline batch)
        if (JSON.stringify(project) !== JSON.stringify(ds.confirmedProject)) ds.mergeOffline(project, cloudAssoc.savedRev);
      },
    });
    return switchToLocal(project, { load: false });
  }
  if (association) {
    detach(); disconnectSharedAssets();
    patch({ shared: null, members: [], hosted: null, blocked: null });
    holdRecovery(project, association);
    if (started) recoveryCoordinator.start(association, project.id);
    return project;
  }
  if (!started && !cur) return project;
  if (ONLINE && !cur) return project;
  if (cur && cur.kind === "local" && project.id === cur.docProjectId) return cur.link.ds.load(project);
  if (cur?.kind === "shared") clearSharedResume();
  return switchToLocal(project, { load: true });
}

/* ---------------- Returning to the shared project after a refresh ---------------- */

/**
 * After the same browser tab refreshes (full page reload), return to the shared project that was open before the refresh
 * (C10a r2; the semantics did not cover it, so follow "least surprise for the user", tier to be decided).
 *
 * - Stored in `sessionStorage`: belongs to this tab only and is gone once the tab is closed;
 * - Stores the candidate used to enter (project number, address, name, entry type), the identity and user name,
 *   and the derived `K` (`onKey` of `client.buildAuthProtocols`, "cache K, not the passphrase");
 *   the passphrase and the invite code are not stored;
 * - Cleared on explicit leave (cancel multi-user collaboration, back to the start page), kick, removal,
 *   project deletion, and opening a different project;
 * - When it cannot connect (offline, rate-limited, device info not fetched), keep it and retry on the next refresh;
 *   clear it when the credentials are wrong, the project is gone, or the user was kicked.
 */
const SHARED_RESUME_KEY = "pc.shared.resume";

interface SharedResume {
  candidate: Candidate;
  as: "member" | "creator";
  username: string;
  key: string;
}

function readSharedResume(): SharedResume | null {
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(SHARED_RESUME_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const r = hosted.migrateHostedDeep(JSON.parse(raw)) as SharedResume;
    const c = r?.candidate;
    if (!c || typeof c.projectId !== "string" || typeof c.base !== "string" || typeof r.username !== "string" || typeof r.key !== "string" || !r.key) return null;
    if (r.as !== "member" && r.as !== "creator") return null;
    return r;
  } catch {
    return null;
  }
}

function rememberSharedResume(r: SharedResume): void {
  const { access: _access, routeProtocol: _route, originalHost: _host, ...candidate } = r.candidate;
  // Desktop pointers contain no K. A valid legacy K is migrated only after trusted room matching.
  const saved = ONLINE ? { ...r, candidate } : { candidate, as: r.as, username: r.username, key: "device-vault" };
  try { sessionStorage.setItem(SHARED_RESUME_KEY, JSON.stringify(saved)); } catch { /* Cannot be stored: back to the start page after a refresh */ }
}

function clearSharedResume(): void {
  try { sessionStorage.removeItem(SHARED_RESUME_KEY); } catch { /* Same as above */ }
}

/** This tab had a shared project open before the refresh (not yet returned to) */
export function hasSharedResume(): boolean {
  return readSharedResume() !== null;
}

/**
 * Return to the shared project that was open before the refresh. Returns true if already in this project;
 * returns false if there is no record.
 * The caller first swaps the store for an empty project (same as "join someone else's project"); the content
 * is whatever the document service says.
 */
export async function resumeShared(): Promise<boolean> {
  const r = readSharedResume();
  if (!r) return false;
  if (cur?.kind === "shared" && cur.docProjectId === r.candidate.projectId) return true;
  const descriptor = descriptorOf(r.candidate);
  if (view.association?.roomId === descriptor.roomId && holding) return true;
  recoveryCoordinator.cancel(); detach(); disconnectSharedAssets(); releaseHolding();
  setAssociation(descriptor, true); patch({ association: descriptor, shared: null, reopenState: "recovering" });
  holdRecovery(getState().project, descriptor);
  recoveryCoordinator.start(descriptor, getState().project.id);
  return true;
}

/** After going back to the start page (top bar "Back to home") and then refreshing, stay on the start page: forget this record */
export function forgetSharedResume(): void {
  recoveryCoordinator.cancel();
  cancelHostTask(currentAssociation());
  releaseHolding();
  detach(); disconnectSharedAssets();
  patch({ reopenState: null, shared: null, members: [], hosted: null, blocked: null });
  clearSharedResume();
}

/* ---------------- Other messages: members, events, notifications ---------------- */

const agentOps = new Map<string, AgentOp>();

function asOps(v: unknown): PathOp[] | undefined {
  return Array.isArray(v) && v.length ? (v as PathOp[]) : undefined;
}

/** Tool call records: eventId → record (insertion order, the oldest is dropped past the limit) */
const eventRecords = new Map<string, EventRecord>();
const EVENT_RECORDS_KEEP = 1000;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Update one record by eventId (creation, completion, text and events.list entries all go through here); the record after merging */
function upsertRecord(e: Record<string, unknown>): EventRecord | null {
  const eventId = str(e.eventId);
  if (!eventId) return null;
  const prev = eventRecords.get(eventId);
  const isText = e.phase === "text" || (typeof e.text === "string" && e.tool == null);
  const status = e.status === "ok" || e.status === "error" || e.status === "cancelled" ? e.status : e.phase === "create" ? null : prev?.status ?? null;
  const rec: EventRecord = {
    ...(prev ?? { eventId, kind: isText ? "text" : "tool", status: null }),
    ...(str(e.tool) !== undefined ? { tool: str(e.tool) } : {}),
    ...(e.icon !== undefined ? { icon: (e.icon as string | null) ?? null } : {}),
    ...(e.target !== undefined ? { target: (e.target as string | null) ?? null } : {}),
    ...(e.args !== undefined ? { args: (e.args as string | null) ?? null } : {}),
    ...(str(e.callId) ? { callId: str(e.callId) } : {}),
    ...(e.actor && typeof e.actor === "object" && !prev?.actor ? { actor: e.actor as Record<string, unknown> } : {}),
    ...(e.summary !== undefined ? { summary: (e.summary as string | null) ?? null } : {}),
    ...(typeof e.durationMs === "number" ? { durationMs: e.durationMs } : {}),
    ...(typeof e.at === "number" && prev?.at === undefined ? { at: e.at } : typeof e.createdAt === "number" && prev?.at === undefined ? { at: e.createdAt } : {}),
    ...(typeof e.text === "string" ? { text: e.text } : {}),
    ...(str(e.opId) ? { opId: str(e.opId) } : {}),
    ...(e.detailKey !== undefined ? { detailKey: (e.detailKey as string | null) ?? null } : {}),
    status: isText ? "ok" : status,
  };
  eventRecords.delete(eventId);
  eventRecords.set(eventId, rec);
  while (eventRecords.size > EVENT_RECORDS_KEEP) eventRecords.delete(eventRecords.keys().next().value!);
  return rec;
}

/** Operation log of the AI panel (newest first) */
export function eventRecordList(): EventRecord[] {
  return [...eventRecords.values()].reverse();
}

/** Get, by eventId, the write record that the AI panel's "Undo this step" needs */
export function agentOpOfEvent(eventId: string): AgentOp | null {
  return agentOps.get(eventId) ?? null;
}

function rememberEvent(e: Record<string, unknown>) {
  const record = upsertRecord(e);
  if (record) patch({ eventsVersion: view.eventsVersion + 1 });
  const opId = typeof e.opId === "string" ? e.opId : null;
  const eventId = typeof e.eventId === "string" ? e.eventId : null;
  if (!opId || !eventId) return;
  const callId = typeof e.callId === "string" ? e.callId : typeof e.toolCallId === "string" ? e.toolCallId : record?.callId;
  const actor = e.actor as { session?: string } | undefined;
  const prev = agentOps.get(eventId);
  const rec: AgentOp = {
    eventId,
    callId,
    opId,
    inverse: asOps(e.inverse) ?? prev?.inverse,
    rev: typeof e.rev === "number" ? e.rev : prev?.rev,
    by: actor ? { actor, session: actor.session } : prev?.by,
    state: prev?.state === "done" ? "done" : "ready",
  };
  agentOps.set(eventId, rec);
  if (callId) agentOps.set(`call:${callId}`, rec);
  patch({ agentOpsVersion: view.agentOpsVersion + 1 });
}

/**
 * Completion notifications that the render queue pushes to this page (as publisher) (C10 contract section 7: the page
 * subscribes to `task.done`, merging it into the layer table and readiness).
 * The publisher automatically subscribes to the plan it published and the subtasks split from it; here we only forward, without interpreting.
 */
const queueEventListeners = new Set<(msg: AnyMsg) => void>();
export function subscribeQueueEvents(cb: (msg: AnyMsg) => void): () => void {
  queueEventListeners.add(cb);
  return () => { queueEventListeners.delete(cb); };
}

function onSideMessage(msg: AnyMsg) {
  if (msg.type === "task.done" || msg.type === "task.failed") {
    for (const l of [...queueEventListeners]) { try { l(msg); } catch { /* A broken subscriber must not affect others */ } }
    return;
  }
  switch (msg.type) {
    case "service.endpoints":
      receiveSharedAssetEndpoints(msg.endpoints);
      return;
    case "shared.members.list":
      patch({ members: Array.isArray(msg.devices) ? (msg.devices as MemberRow[]) : [], hosted: parseHosted(msg.hosted) });
      // Whether the hosted side has a Cloud Agent, whether it is on, and where it is (top-level `hosted.agent`, one more `url` than the UI state; projects kept locally have no such field)
      setHostedAgent(view.shared?.projectId ?? currentDocProjectId(), (msg.hosted as { agent?: unknown } | undefined)?.agent ?? null);
      return;
    case "shared.notice":
      if (msg.event === "password-changed") pushToast(tr("The project password has been changed. Your current connection is not affected, but you will need the new password next time you enter."), "info", 8000);
      // After the password change the user chose to sign out, and the document service revoked the old device's changes made in that period: one entry per member currently online (offline members are not backfilled)
      if (msg.event === "content-rolled-back") pushToast(rolledBackText(msg.name), "info", 8000);
      // The creator toggled the hosted side's service: the UI follows immediately (a refreshed member list follows right after, and that one takes precedence)
      if (msg.event === "hosted-service-changed") {
        const next = applyHostedChange(view.hosted, msg.service, msg.enabled);
        if (next !== view.hosted) {
          patch({ hosted: next });
          const text = HOSTED_SERVICE_TEXT[msg.service as HostedServiceName]?.changed(msg.enabled === true);
          if (text) pushToast(text, "info", 6000);
        }
        // The "cloud" entry in the AI panel is greyed out or restored accordingly
        if (msg.service === "agent" && typeof msg.enabled === "boolean") setHostedAgentEnabled(view.shared?.projectId ?? currentDocProjectId(), msg.enabled);
      }
      // The creator changed a sub-option under the hosted side's service (the render node's "Generate track stream"): same as above, the UI follows immediately, and other members get a notice only when it is turned off
      if (msg.event === "hosted-option-changed") {
        const next = applyHostedOptionChange(view.hosted, msg.service, msg.option, msg.enabled);
        if (next !== view.hosted) {
          patch({ hosted: next });
          const text = hostedOptionText(msg.service, msg.option)?.changed(msg.enabled === true);
          if (text) pushToast(text, "info", 6000);
        }
      }
      return;
    case "events.event":
      rememberEvent(msg as Record<string, unknown>);
      return;
    case "events.listing":
      for (const it of Array.isArray(msg.items) ? msg.items : []) rememberEvent(it as Record<string, unknown>);
      return;
    case "presence.update":
    case "presence.state":
    case "presence.message":
      receivePresence(msg as Record<string, unknown>);
      return;
    case "merge.state":
      // The same user changed the pending merge table on another device or another page
      mergeTable?.receive(msg as { projectId?: unknown; things?: unknown; version?: unknown });
      return;
    default:
      return;
  }
}

/* ---------------- Hooks for acceptance checks (dev mode only) ---------------- */

if (typeof window !== "undefined" && import.meta.env?.DEV) {
  (window as unknown as { __pcSyncTest?: unknown }).__pcSyncTest = {
    /** Cut the network for ms milliseconds (acceptance check of the offline dialog) */
    drop: (ms: number) => cur?.link.dropFor(ms),
    /** Drop the transport just once (the session resumes within the retention period; page acceptance check for HT-a) */
    cut: () => cur?.link.cutTransport() ?? false,
    /** Diagnostics of the current session: the transport actually used, resume count, unacknowledged bytes, and whether it faces an old server without a session layer */
    link: () => cur?.link.stats() ?? null,
    /** Hand one document service message to the page (AI panel "Undo this step": opId and inverse in the event are currently filled in by the c65-agent path) */
    inject: (msg: AnyMsg) => onSideMessage(msg),
    view: () => view,
    docProjectId: () => currentDocProjectId(),
    rev: () => cur?.link.ds.rev ?? null,
    agentOp: (callId: string) => agentOpFor(callId),
    /** Account cloud project: how long this connection stays usable and how many times the session was replaced (`accountLinkLife.ts`) */
    accountLife: () => cur?.accountLife?.() ?? null,
    events: () => eventRecordList(),
    /** Hand one card source sync notice to the page (the same path the editor process uses via HMR; for the acceptance check of the card row in conflict merge) */
    cardNotice: (n: Record<string, unknown>) => receiveCardSyncNotice(n),
    /** The current state of the pending merge table */
    mergeThings: () => view.merge.things,
  };
}

/* ---------------- Startup ---------------- */

/** Called once when the editor mounts (idempotent). If the local document service is unreachable, nothing is connected */
export async function startSync(): Promise<void> {
  if (started) return;
  started = true;
  const q = new URLSearchParams(location.search);
  if (q.has("headless") || isViewOnly()) return;
  const device = view.device ?? (await loadDevice());
  if (!device) return;
  patch({ device });
  // The online page has no local document service: connect only after entering a shared project from the start page (C10a section 2)
  if (ONLINE) return;
  // A shared project was already entered on the start page ("Join someone else's project", C10a section 4): do not switch back to the local space
  if (cur) return;
  const association = currentAssociation();
  if (association) { recoveryCoordinator.start(association, getState().project.id); return; }
  const join = q.get("join");
  if (join) {
    const link = newLocalLink(join, getState().project);
    bind(link, "local", join, localWsUrl());
    link.start();
    return;
  }
  switchToLocal(getState().project, { load: true });
}

/** Page opened via `?join=`: content is whatever the document service says, so skip opening fillers such as demo cards */
export function isJoinPage(): boolean {
  // C10a: those who come in from the start page via "Join someone else's project" (already connected to a shared project), and the online page (which can only enter the editor via join),
  // likewise take content from the document service: do not insert demo cards when the editor mounts, otherwise every joiner would add them to everyone's project again
  if (ONLINE || currentAssociation() || cur?.kind === "shared" || hasSharedResume()) return true;
  try {
    return new URLSearchParams(location.search).has("join");
  } catch {
    return false;
  }
}

/* ---------------- Save ---------------- */

/** `.proc` is written only after all local changes are acknowledged (semantics "project file"); passes straight through when no document service is connected */
export async function whenSaved(timeoutMs = 10_000): Promise<void> {
  if (identitySave) { try { await identitySave; } catch { if (!lastIdentity) throw new Error(tr("Collaboration identity not saved")); identitySave = saveRecoveryIdentity(lastIdentity.descriptor, lastIdentity.record); await identitySave; } }
  if (currentAssociation() && !cur && view.reopenState !== "unsupported") throw new Error(tr("The collaboration identity has not been restored yet; wait for the host or re-authenticate before saving. The file content has been kept."));
  if (!cur) return;
  await cur.link.ds.whenSettled({ timeoutMs });
  const descriptor = currentAssociation();
  if (descriptor && !ONLINE_BUILD && !ONLINE) { persistJournal(cur.link.ds, descriptor, getState().project.id ?? ""); await journalWrite; }
}

/* ---------------- Offline ---------------- */

export function setOfflineOpen(open: boolean) {
  patch({ offlineOpen: open });
}

export function replayOffline() {
  cur?.link.ds.replayOffline();
  patch({ offlineOpen: false });
  refreshStatus();
}

export function discardOffline() {
  cur?.link.ds.discardOffline();
  patch({ offlineOpen: false });
  refreshStatus();
}


/* ---------------- Conflict merge: pending merge table ---------------- */

/**
 * This user's pending merge table in the current project (`mergeTable.ts`): when connected to the document service it
 * follows the service, and when offline it uses the copy staged on this machine.
 * Users are keyed by "project × user": account project `account:<id>`, passphrase project `user:<name>`, local space `local`
 * (the same scheme the document service uses when keying by connection identity).
 */
let mergeTable: MergeTable | null = null;
/** Which connection the pending merge table is currently attached to (attached only when online) */
let mergeAttached: SyncLink | null = null;
/** Currently moving the offline batch into the pending merge table (that whole-batch rollback does not show "Discarded") */
let transferringBatch = false;

function bindMergeTable(docProjectId: string | null, user: string | null) {
  if (mergeTable && mergeTable.projectId === docProjectId && mergeTable.user === user) return;
  mergeTable?.attach(null);
  mergeAttached = null;
  const table: MergeTable | null = docProjectId && user ? new MergeTable({ projectId: docProjectId, user, kv: defaultStore(), onChange: (things) => {
    // After switching projects, late callbacks from the old table (slow local staging reads, replies from the old connection) are ignored
    if (!table || mergeTable !== table) return;
    patch({ merge: { things, version: view.merge.version + 1, blocked: table.blocked } });
  } }) : null;
  mergeTable = table;
  patch({ merge: { things: mergeTable?.things ?? [], version: view.merge.version + 1, blocked: null }, mergeOpen: false });
}

function attachMergeChannel(link: SyncLink | null) {
  if (!mergeTable || mergeAttached === link) return;
  mergeAttached = link;
  void mergeTable.attach(link ? { request: (msg) => link.request(msg as AnyMsg) } : null);
}

const newBatchId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Offline batch rejected (the project was changed by others while offline): baseline → compare item by item on my side to find what is pending merge, and hand it to the pending merge table;
 * DocSync immediately returns to the current cloud state and syncs as usual,
 * and the offline changes remain only in the pending merge table (`product/document-service.md` "Offline": after reconnecting, save into that user's pending merge records). Opens the "Conflict merge" window.
 * Wait for storage after the sync finishes: new changes made during that wait are not swept away by the whole-batch rollback. If the baseline cannot be computed, fall back to the offline dialog that handles the whole copy.
 */
function transferOffline(link: SyncLink) {
  const ds = link.ds, table = mergeTable;
  if (!table || ds.status !== "paused") return;
  const things = offlineThings(ds.recoveryJournal(), { batch: newBatchId(), at: Date.now() });
  if (!things) return;
  transferringBatch = true;
  try {
    ds.discardOffline();
  } finally {
    transferringBatch = false;
  }
  if (things.length) patch({ mergeOpen: true });
  // Recovery phase of the online page: the offline changes were not committed but moved into the pending merge table, so we must not say "All changes made while offline have been committed"
  if (ONLINE) { recoveryState = { phase: null, wasOffline: false, hadUnsent: false }; patch({ recovery: null }); }
  void table.add(things).then((durable) => {
    if (!durable && table.pendingOps) pushToast(tr("Offline edits were moved into \"Conflict merge\", but this device cannot store them for now; do not close the page until the document service is reachable."), "warn", 10_000);
  });
  clearBrowserJournal(link);
}

/**
 * Undo (including the AI panel's "Undo this step") hit a conflict: the blocked items are broken down by changed item (`undoConflict.ts`).
 * Those not changed by others are undone directly (not pushed onto the undo stack); those changed by others go into this user's pending merge table (source `undo`) and the "Conflict merge" window opens.
 * Returns false when no pending merge table is attached (the document service was never connected), falling back to the original notice bar.
 */
function routeUndoConflict(conflict: NonNullable<UndoResult["conflict"]>): boolean {
  const table = mergeTable, ds = cur?.link.ds;
  if (!table || !ds) return false;
  const plan = undoConflictPlan(ds.project, conflict, { batch: newBatchId(), baseRev: ds.rev, at: Date.now() },
    { manualDuration: getState().durationManual });
  if (plan.direct) {
    try { ds.commitAside(plan.direct); } catch (e) { pushToast(tr("Could not undo: {0}", (e as Error).message), "warn"); }
  }
  if (plan.things.length) {
    void table.add(plan.things);
    patch({ mergeOpen: true });
  }
  return true;
}

export function setMergeOpen(open: boolean) {
  patch({ mergeOpen: open });
}

/** Result of merging or deleting the selection: a sentence shown in the window */
export interface MergeOutcome { ok: boolean; message: string; stale?: string[] }

/**
 * "Merge": write the selected secondary items into the project as they are on my side (one ordinary change, pushed onto the undo stack), and remove the ones written from the pending merge table.
 * Re-checked every time: `seen` is each secondary item's cloud value when the window was shown; an item that differs from the current one (changed again by others after the window opened) is not merged this time and is handed back to the UI to refresh and review.
 */
export function mergeSelected(sel: Selection, seen: Map<string, Box>): MergeOutcome {
  const table = mergeTable;
  if (!table || !cur || view.status !== "online") return { ok: false, message: tr("Currently offline. Merge after reconnecting.") };
  const ds = cur.link.ds;
  const things = table.things;
  const stale = staleSelections(ds.project, things, seen, sel);
  const chosen: Selection = new Map();
  for (const [key, props] of sel) {
    const kept = new Set([...props].filter((p) => !stale.includes(`${key}|${p}`)));
    if (kept.size) chosen.set(key, kept);
  }
  const r = applyMerge(ds.project, things, chosen, { manualDuration: getState().durationManual });
  // Card source: hand it to the editor process to install as on my side and upload, then remove it from the table once done (async; the result gets its own bubble)
  if (r.external.length) void mergeCards(r.external);
  if (r.done.length) {
    try {
      ds.mergeOffline(r.project, ds.rev);
    } catch (e) {
      return { ok: false, message: tr("Could not merge: {0}", (e as Error).message) };
    }
    void table.remove(r.done);
  }
  const n = r.done.reduce((k, d) => k + (chosen.get(d.key)?.size ? d.props.filter((p) => chosen.get(d.key)!.has(p)).length : 0), 0);
  const parts = [n ? tr("Merged {0} items.", n) : r.external.length ? "" : tr("No items were merged.")];
  if (r.external.length) parts.push(tr("The source of {0} cards is being written back to match your side.", r.external.length));
  if (stale.length) parts.push(tr("{0} items were changed by someone else after the window was opened and were not merged this time. Please review the current values and decide.", stale.length));
  if (r.failed.length) parts.push(tr("{0} items could not be merged: {1}.", r.failed.length, [...new Set(r.failed.map((f) => f.reason))].join(tr(";"))));
  return { ok: r.failed.length === 0 && stale.length === 0, message: parts.join(""), stale };
}

async function mergeCards(list: { key: string; props: string[]; thing: MergeThing }[]) {
  for (const x of list) {
    const r = await takeMineCard(x.thing.ref.id, String(x.thing.mine?.v ?? ""));
    if (r.ok) void mergeTable?.remove([{ key: x.key, props: x.props }]);
    else pushToast(tr("Card {0} was not written back: {1}", x.thing.ref.id.replace(/^src\//, ""), r.error ?? ""), "warn", 10_000);
  }
}

/** "Delete selected": remove from the pending merge table, the cloud stays as is; works while offline too (handed to the document service after reconnecting) */
export function deleteSelected(sel: Selection): MergeOutcome {
  const table = mergeTable;
  if (!table) return { ok: false, message: tr("No pending items to merge.") };
  const list = selectionList(sel);
  const n = list.reduce((k, x) => k + x.props.length, 0);
  void table.remove(list);
  return { ok: true, message: tr("Deleted {0} items, the cloud stays as it is.", n) };
}

/* ---------------- Offline batches in the browser local cache ---------------- */

/**
 * Account cloud project and online page: changes made while offline (DocSync's offline batch) are persisted to the browser local cache (`offlineCache.ts`, IndexedDB),
 * so closing or refreshing the page does not lose them; on re-entering this project they are restored first, then go through the usual "try the first one with the expected version". Deleted once all are acknowledged.
 * Writes are coalesced to once per `BROWSER_JOURNAL_MS`.
 */
export const BROWSER_JOURNAL_MS = 300;
let journalSaved = true;
const journalKey = (projectId: string, user: string) => cacheKey("journal", projectId, user);

function watchBrowserJournal(link: SyncLink, projectId: string, user: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = () => {
    timer = null;
    const ds = link.ds;
    const kv = defaultStore();
    const key = journalKey(projectId, user);
    const job = ds.unconfirmed > 0 && ds.status !== "paused" ? kv.put(key, ds.recoveryJournal()) : ds.status === "online" && ds.unconfirmed === 0 ? kv.delete(key) : null;
    if (!job) return;
    journalSaved = false;
    // Only counts as "already on this machine" once written; if the write fails (quota, private mode), honestly say "only in this page" instead
    job.then(() => { journalSaved = true; if (cur?.link === link) patch({ offlineStore: "saved" }); },
      () => { journalSaved = false; journalUnstorable = true; if (cur?.link === link) patch({ offlineStore: "page" }); });
  };
  const schedule = () => { if (!timer) timer = setTimeout(write, BROWSER_JOURNAL_MS); };
  const offs = [link.ds.on("project", schedule), link.ds.on("status", schedule)];
  // When leaving the project, flush the pending beat (do not drop it): otherwise changes in the last 300 ms while offline are not persisted,
  // "already on this machine" would not hold, and that is exactly what decides whether to ask when leaving the editor (okToLeaveOnline in `TopBar.tsx`)
  return () => { if (timer) { clearTimeout(timer); write(); } for (const off of offs) off(); };
}

function clearBrowserJournal(link: SyncLink) {
  const user = mergeTable?.user;
  if (!user) return;
  void defaultStore().delete(journalKey(link.ds.projectId, user)).catch(() => undefined);
}

/** Before entering a project: if the browser local cache holds an offline batch this user did not submit last time for this project, restore it into the new connection's DocSync */
async function restoreBrowserJournal(ds: DocSync, user: string): Promise<boolean> {
  try {
    const saved = await defaultStore().get(journalKey(ds.projectId, user));
    if (!saved) return false;
    ds.restoreJournal(saved as Parameters<DocSync["restoreJournal"]>[0]);
    return true;
  } catch {
    return false;
  }
}

/** Whether the offline batch in the browser local cache was last saved (used for the confirmation on leaving the page) */
export function browserJournalSaved(): boolean {
  return journalSaved;
}

/** "The project changed as follows in the meantime" in the offline dialog: who changed which entities */
export function pausedSummary(): { who: string; what: string[] }[] {
  const since = view.paused?.since ?? [];
  const project = getState().project;
  return since.map((s) => {
    const actor = s.actor as Record<string, unknown> | undefined;
    const entities = (s as { entities?: string[] }).entities ?? (s.paths ?? []).map(entityOfPath);
    return {
      who: writerLabel({ actor, session: s.session ?? (actor?.session as string | undefined) }, me(), displayNames()),
      what: [...new Set(entities.map((e) => entityLabel(e, project)))],
    };
  });
}

/* ---------------- Undo: jump over to look ---------------- */

export function jumpToEntity(entity: string) {
  const clip = clipOfEntity(entity);
  const project = getState().project;
  if (clip) {
    const c = project.tracks.flatMap((t) => t.clips).find((x) => x.id === clip);
    if (!c) return;
    actions.select([clip]);
    actions.seek(c.start);
    document.querySelector(`[data-clip-id="${CSS.escape(clip)}"]`)?.scrollIntoView?.({ block: "nearest", inline: "center" });
    return;
  }
  if (entity.startsWith("/meta/")) window.dispatchEvent(new Event("pc-open-project-settings"));
}

/* ---------------- AI panel "Undo this step" ---------------- */

export function agentOpFor(callId: string | undefined): AgentOp | null {
  if (!callId) return null;
  return agentOps.get(`call:${callId}`) ?? agentOps.get(callId) ?? null;
}

/** Undo an Agent step: submit the inverse operation + undoOf under this page's identity, onto this page's undo stack */
export function revertAgentOp(rec: AgentOp): UndoResult | null {
  if (!cur) return null;
  const ds = cur.link.ds;
  if (!ds.canRevertRemote(rec.opId, rec.inverse)) {
    pushToast(tr("The change record for this step is not on this page, so it cannot be undone."), "warn");
    return null;
  }
  const result = ds.revertRemote({ opId: rec.opId, inverse: rec.inverse, rev: rec.rev, by: rec.by });
  if (result.done) {
    rec.state = "done";
    patch({ agentOpsVersion: view.agentOpsVersion + 1 });
  } else if (!result.skipped.length && !result.failed.length) {
    // Nothing was blocked by later changes and nothing failed to apply, yet nothing at all was undone: say so, so the button never appears to do nothing when clicked
    pushToast(tr("This step could not be undone: what it changed already looks the way it did before the step (it may have been undone already), so there is nothing to roll back."), "warn");
  }
  return result;
}

/* ---------------- Shared project ---------------- */

export type EnterError = "auth" | "rate-limited" | "unreachable" | "no-project" | "kicked" | "not-ready" | "host-data-missing";

export interface EnterCredentials {
  as: "member" | "creator";
  username: string;
  password: string;
  /** An already derived K (C10a: the project passphrase K the server returns when an open entry project is redeemed with an invite code); when given, it is no longer derived from the password */
  key?: string;
}

/** Entry failed: the reason, and when rate-limited also the cooldown seconds given by the server (C10a table A "Try again in {seconds} seconds") */
export type EnterResult = { ok: true } | { ok: false; error: EnterError; retryAfter?: number | null };

/** Account v2 cloud entry. Server projection wins; no local root upload or legacy password proof. */
export async function enterAccountProject(options: { client: CloudAccountClient; origin: string; projectId: string;
  name: string; initial: Project; firstSession?: ProjectSession;
  /** Change the wording of the bubble with "Copy project link" shown after entering (used by the account route's "Move to the cloud", `accountMoveFlow.ts`); when omitted, the default wording is used */
  enteredText?: string;
  /**
   * Whether to show the bubble after entering. Shown by default.
   *
   * Pass false when clicking into an already joined project from the "My projects" list (issue #15): that is not a new join, there is no "send the link to others" step,
   * and in Vibe mode clicking back and forth between a few projects would stack up a pile of persistent bubbles. Creating, joining by link, and moving to the cloud still show it.
   */
  announce?: boolean;
  /**
   * Called once at the moment of the switch (cloud content has arrived, the editor is not yet attached), given the content sent from the cloud; if it throws, no switch happens, the whole entry fails, and the editor stays in the original project.
   * "Move to the cloud" uses it to guarantee the editor content matches the cloud when switched over (`MoveDeps.enter` in `accountMove.ts`). Called synchronously, with no gap in between
   */
  guard?: (cloud: Project) => void }): Promise<void> {
  await ensureDevice();
  const origin = new URL(options.origin).origin, base = `${origin}/hosted/`, url = hostedWsUrlOf(base);
  let current = options.firstSession ?? await options.client.session(options.projectId);
  let first = true, stopped = false, renewing: Promise<ProjectSession> | null = null;
  const projectAccountId = options.client.principal?.id;
  const isCurrent = () => !stopped && cur?.link === link && options.client.principal?.id === projectAccountId;
  /** This page is itself changing the hosted side's service toggle (so that reading the new state when resuming the session after the change does not show itself "The creator turned off…") */
  let ownHostedChange = 0;
  const projectSession = (value: ProjectSession) => {
    if (!isCurrent()) return;
    // Account projects have no `hosted-service-changed` / `hosted-option-changed` notifications: members learn what the creator changed from the state read on each session resume.
    // Same rule as passphrase projects: only show other members a notice when it is turned off, none when turned on (same wording source, `hostedChangeNotices`)
    if (ownHostedChange === 0 && view.shared) for (const text of hostedChangeNotices(view.hosted, value.hosted)) pushToast(text, "info", 6000);
    patch({ shared: view.shared ? { ...view.shared, creator: value.creator } : null, hosted: value.hosted });
    setHostedAgent(options.projectId, value.hosted.agent);
    // Own permission changed (read-only to writable): switch to a new session so the new connection can write
    if (ready) void life.accessSeen(value.access);
    // When members change (someone joins, is kicked, permissions change), fetch the names again
    if (ready && value.accessRevision !== namesRevision) {
      namesRevision = value.accessRevision;
      void options.client.members(options.projectId).then((snapshot: AccountMembersSnapshot) => { if (isCurrent()) accountNamesFrom(snapshot); }, () => { if (namesRevision === value.accessRevision) namesRevision = null; });
    }
  };
  let namesRevision: number | null = null;
  // Resume the session when under 60 seconds remain (the `ticket.info` below and the cloud identity, two places). When resuming, require the website login to still have at least 70 seconds left too: the login token lives only 2 minutes, and the client by default resumes it only at 10 seconds left,
  // while the session's expiry follows the login token; without this requirement, a session resumed in the last 50 seconds would still have under 60 seconds left, and the Cloud Agent would resume on every request
  // (measured 2026-10-17: up to 50 calls per minute to `/account/session`)
  const renew = (): Promise<ProjectSession> => renewing ??= options.client.session(options.projectId, { minRemainingMs: 70_000 }).then((value: ProjectSession) => {
    current = value; projectSession(value); return value;
  }).finally(() => { renewing = null; });
  // This page's connection is usable only until the access token behind the ticket expires: before expiry, switch to a new session, and if that fails, honestly go offline (`accountLinkLife.ts`)
  const life = createAccountLinkLife({
    session: ({ minRemainingMs }) => options.client.session(options.projectId, { minRemainingMs }).then((value: ProjectSession) => { current = value; projectSession(value); return value; }),
    link: () => link,
    onTerminal: error => fail(error),
  });
  const protocols = async () => { if (stopped) throw new AccountFailure(401, 'credential-revoked');
    const ticket = await life.ticket(first ? current : null); first = false;
    return accountConnectionProtocols({ connectionTicket: ticket } as ProjectSession); };
  const ticket = Object.assign(async () => (await ticket.info())?.ticket ?? null, {
    info: async ({ force = false }: { force?: boolean } = {}) => {
      if (stopped || cur?.link !== link) return null;
      if (force || current.expiresAt <= Date.now() + 60_000) await renew();
      if (stopped || cur?.link !== link) return null;
      return { ticket: current.assetTicket, exp: current.expiresAt };
    },
  });
  let ready = false;
  let resolveEntry!: () => void, rejectEntry!: (error: unknown) => void;
  const opened = new Promise<void>((resolve, reject) => { resolveEntry = resolve; rejectEntry = reject; });
  const fail = (error: unknown) => { stopped = true; link.stop(); if (cur?.link === link) { setCloudConsentSource(null); setCloudIdentity(null);
    // Login invalid, kicked, project gone: the editor process's card source sync connection stops too (back to the local space, no longer asking this page for tickets)
    if (!ONLINE_BUILD && !ONLINE) detachCardSync();
    if (error instanceof AccountFailure && error.status === 403 && ['banned', 'not-listed'].includes(error.code))
      patch({ blocked: error.code === 'banned' ? 'kicked' : 'removed' });
  } if (!ready) rejectEntry(error);
    else { disconnectSharedAssets(); pushToast(error instanceof Error ? error.message : tr("Cloud sign-in has expired, please sign in again."), 'warn', Infinity); } };
  const link = new SyncLink({ url, projectId: options.projectId, initial: options.initial, initialize: false, session,
    // Resume without a ticket: the document service forbids an auth item next to a resume item (with
    // one, the handshake returns 400 and all you can do is wait out the retention period, then rebuild
    // the session). On resume the server re-checks login and membership using the identity recorded in
    // the session. The ticket is only presented when building a new session (`protocols`)
    protocols,
    saveBackup: b => void saveBackup(b), onMessage: onSideMessage,
    // A close code from the server is not final (4003 also appears when writable changes to read-only):
    // back off and reconnect with a new ticket, and only give up when the ticket endpoint says no:
    // 401 login expired, 403 kicked / not on the list, 404 project gone (the message is the string the
    // client already has, "This cloud project no longer exists.")
    isFatalClose: () => false,
    onProtocolError: error => { const e = error as { status?: number }; if (e.status === 401 || e.status === 403) { fail(error); return true; }
      if (e.status === 404) { fail(new AccountFailure(404, 'project-gone')); return true; }
      pushToast(error instanceof Error ? error.message : tr("Cloud service is temporarily unavailable, waiting to reconnect."), 'warn'); return false; },
    onAuthExpired: () => { void life.authExpired(); },
    onOpen: () => { life.opened(); void (async () => {
      // Rebuilding a session (reconnect after a drop, or swapping sessions before expiry): everything set
      // up when entering the project is still there, and only the things that travel with the connection
      // are rebuilt on the new one: selection and presence (`resyncPresenceLink`), the tool call log
      // (`events.list`); the publisher registration is re-reported by `SyncLink.renew` itself;
      // everything else (asset tickets, member list, Cloud Agent identity, card source sync) does not use
      // this connection. For the list see `docs/reports/AGENT-v18-cardsync.md`
      if (ready) { if (!stopped && cur?.link === link) { resyncPresenceLink(); link.send({ type: 'events.list', projectId: options.projectId }); refreshStatus(); } return; }
      await sharedStateReady(link);
      if (stopped) return;
      // Which identity to enter with: account or guest (`client.principal`). It used to check
      // `client.account`, which is always null for a guest, so a guest opening their own project always
      // got "Please sign in to your account first." (claude/guest-enter, verified online on 0.7.21)
      const account = options.client.principal;
      if (!account) throw new AccountFailure(401, 'login-required');
      options.guard?.(link.ds.project);
      recoveryCoordinator.cancel(); releaseHolding(); setAssociation(null); clearSharedResume();
      setCloudAssociation({
        accountProject: true,
        projectId: options.projectId,
        docServiceUrl: base,
        origin,
        savedRev: link.ds.rev,
        savedAt: new Date().toISOString(),
      });
      patch({ shared: { projectId: options.projectId, name: options.name, mode: 'free', where: 'hosted', base,
        username: account.name, accountId: account.id, creator: current.creator, access: current.access ?? 'rw' },
        members: [], hosted: current.hosted, blocked: null, association: null, reopenState: null });
      bind(link, 'shared', options.projectId, url, options.client, `account:${account.id}`);
      projectSession(current);
      setCloudIdentity(accountCloudIdentity({ projectId: options.projectId, isCurrent, session: async () => {
        if (current.expiresAt <= Date.now() + 60_000) await renew();
        return current;
      } }));
      if (cur?.link === link) cur.accountLife = () => life.describe();
      if (cur?.link === link) cur.setAccountAgentEnabled = async enabled => {
        if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
        await renew();
        if (!isCurrent() || !current.creator) throw new AccountFailure(403, 'creator-required');
        await options.client.setAgentEnabled(options.projectId, enabled, current.accessRevision, crypto.randomUUID());
        await renew();
      };
      if (cur?.link === link) cur.setAccountHosted = async change => {
        if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
        ownHostedChange += 1;
        try {
          await renew();
          if (!isCurrent() || !current.creator) throw new AccountFailure(403, 'creator-required');
          try {
            if ('option' in change) await options.client.setHostedOption(options.projectId, change.service, change.option, change.enabled, current.accessRevision, crypto.randomUUID());
            else await options.client.setHostedService(options.projectId, change.service, change.enabled, current.accessRevision, crypto.randomUUID());
          } catch (error) {
            // Rejected (e.g. not in the permission group for "generate track streams") or not done: re-read the
            // session right away, so switches and greyed-out states follow the server's real state, without
            // waiting for the next scheduled session renewal; if the read fails, still hand the original error
            // to the UI to state plainly
            await renew().catch(() => undefined);
            throw error;
          }
          await renew();
        } finally { ownHostedChange -= 1; }
      };
      if (cur?.link === link) {
        // Invalidate and regenerate the project link and project secondary password (10-14 section 3.3):
        // same rule as the switches above: first renew the session to get the current access version
        // number (the ledger uses it to guard against concurrent changes, hard-coding 0 gets rejected with
        // 409), then renew once more after the change, so the version number and link token held by the
        // page catch up
        cur.regenAccountLink = async () => {
          if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
          await renew();
          if (!isCurrent() || !current.creator) throw new AccountFailure(403, 'creator-required');
          const out = await options.client.regenProjectLink(options.projectId, current.accessRevision, crypto.randomUUID());
          await renew().catch(() => undefined);
          return projectLink(origin, options.projectId, out.linkToken);
        };
        cur.setAccountSecondaryPassword = async password => {
          if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
          await renew();
          if (!isCurrent() || !current.creator) throw new AccountFailure(403, 'creator-required');
          await options.client.setSecondaryPassword(options.projectId, password, current.accessRevision, crypto.randomUUID());
          await renew().catch(() => undefined);
        };
        cur.accountLink = () => projectLink(origin, options.projectId, current.creator ? current.linkToken ?? undefined : undefined);
      }
      if (cur?.link === link) {
        cur.accountMembers = async () => {
          if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
          try {
            const snapshot = await options.client.members(options.projectId);
            if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
            return snapshot;
          } catch (error) {
            if (error instanceof AccountFailure && (error.status === 401 || error.code === 'banned' || error.code === 'not-listed')) fail(error);
            throw error;
          }
        };
        cur.accountMemberAdmin = async operation => {
          if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
          const result = await options.client.memberAdmin(options.projectId, operation);
          if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
          return result;
        };
      }
      if (cur?.link === link) {
        // Every 3 seconds check whether the connection has expired (computed locally, no request); renew the
        // session (read the service switches the creator changed, own permissions, member changes) every 15
        // seconds, and at any time when the session is about to expire. It used to renew unconditionally
        // every 3 seconds: 34 calls to `/account/session` in 2 minutes (measured online 2026-10-19), and
        // the document service had to sign three tickets each time
        let lastRenew = Date.now();
        const metadataTimer = setInterval(() => {
          if (!isCurrent()) return;
          if (Date.now() - lastRenew >= ACCOUNT_METADATA_RENEW_MS || current.expiresAt <= Date.now() + 60_000) {
            lastRenew = Date.now();
            void renew().catch((error: unknown) => { if (error instanceof AccountFailure && (error.status === 401 || error.status === 403)) fail(error); });
          }
          void life.tick();
        }, 3000);
        cur.offs.push(() => clearInterval(metadataTimer));
        // Page back in the foreground, network restored, computer woke from sleep: don't wait for the timer
        // (browsers throttle timers in background tabs to once a minute), check on the spot whether the
        // connection has expired
        const wake = () => { if (isCurrent() && (typeof document === "undefined" || document.visibilityState !== "hidden")) void life.tick(); };
        if (typeof window !== "undefined") {
          window.addEventListener("online", wake); window.addEventListener("focus", wake); window.addEventListener("pageshow", wake);
          document.addEventListener("visibilitychange", wake);
          cur.offs.push(() => { window.removeEventListener("online", wake); window.removeEventListener("focus", wake); window.removeEventListener("pageshow", wake); document.removeEventListener("visibilitychange", wake); });
        }
      }
      await connectSharedAssets(link, base, { online: ONLINE_BUILD || ONLINE, account: { base: `${origin}/media/api/asset`, projectId: options.projectId, ticket } });
      link.send({ type: 'events.list', projectId: options.projectId });
      ready = true; resolveEntry();
      // Fetch member names ("who changed it" in the tooltip bubble) once on arrival, and again after
      // member changes
      projectSession(current);
      // Build the link at click time: if the creator regenerated the project link, what gets copied is the
      // one with the new token
      const linkText = () => projectLink(origin, options.projectId, current.creator ? current.linkToken ?? undefined : undefined);
      // Same key: entering another project replaces the previous one instead of stacking (issue #15). The
      // default message only reminds that the link can be shared with others, 8 seconds is enough
      // (Vibe mode's top bar also has a permanent "Copy project link" button); messages supplied by the
      // caller ("Move to the cloud") are one-off important notices, which stay as before and are
      // dismissed by the user
      if (options.announce !== false) pushToast(options.enteredText ?? tr("Entered the cloud project. You can send the project link to another signed-in member."), 'info',
        options.enteredText ? Infinity : ENTERED_TOAST_MS, {
          label: tr("Copy project link"), pc: 'cloud-project-copy', run: () => { const text = linkText(); void navigator.clipboard.writeText(text).then(
            () => pushToast(tr("Project link copied."), 'info'), () => pushToast(tr("Project link: {0}", text), 'info', Infinity)); },
        }, ENTERED_TOAST_KEY);
    })().catch(fail); },
    onClosed: info => { if (!ready || info.fatal) fail(new AccountFailure(info.fatal ? 403 : 0, info.reason || 'network'));
      else refreshStatus(); },
  });
  // Changes not delivered when the network dropped last time in this project (browser local cache):
  // restore them first, submit as usual after connecting, and move them item by item into the pending
  // merge items when rejected
  if (projectAccountId) await restoreBrowserJournal(link.ds, `account:${projectAccountId}`);
  const timeout = setTimeout(() => { if (!ready) fail(new AccountFailure(503, 'session-unavailable')); }, 20_000);
  link.start();
  try { await opened; } finally { clearTimeout(timeout); }
}

const KICKED_KEY = "pc.shared.kicked";
const CREATORS_KEY = "pc.shared.creators";

function readJson<T>(key: string, fallback: T): T {
  try {
    // Swap the old hosted host name for the new one (RETIRED_HOSTED_HOSTS in hosted-default.mjs):
    // recovery credentials and local records keep working as before
    const v = hosted.migrateHostedDeep(JSON.parse(localStorage.getItem(key) ?? ""));
    return v && typeof v === "object" ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* If it cannot be saved, so be it: only affects the notice text */
  }
}

/** Creator user names of the shared projects created on this device (used to prefill "I am the creator" when opening) */
export function knownCreator(projectId: string): string | null {
  return readJson<Record<string, string>>(CREATORS_KEY, {})[projectId] ?? null;
}

function rememberCreator(projectId: string, username: string) {
  writeJson(CREATORS_KEY, { ...readJson<Record<string, string>>(CREATORS_KEY, {}), [projectId]: username });
}

function kickedKey(projectId: string, username: string) {
  return `${projectId}\n${username}`;
}

function rememberKicked(projectId: string, username: string, on: boolean) {
  const all = readJson<Record<string, number>>(KICKED_KEY, {});
  if (on) all[kickedKey(projectId, username)] = Date.now();
  else delete all[kickedKey(projectId, username)];
  writeJson(KICKED_KEY, all);
}

function wasKicked(projectId: string, username: string): boolean {
  return !!readJson<Record<string, number>>(KICKED_KEY, {})[kickedKey(projectId, username)];
}

/**
 * Device info: fetch it on demand if not fetched yet (on the start page, before entering the editor
 * and before `startSync` has run, "Join someone else's project" needs it first).
 * Returns null if it cannot be fetched (the editor process did not respond in the desktop runtime).
 */
export async function ensureDevice(): Promise<DeviceInfo | null> {
  if (view.device) return view.device;
  const device = await loadDevice();
  if (device) patch({ device });
  return device;
}

/**
 * Enter a shared project: fetch the challenge and connect with the proof; once connected, this page
 * switches to this project's space, and the project content follows the document service
 * (when the project is still empty, DocSync writes the current one into it as a root replace: this
 * is how creating a shared project carries the current project over).
 */
export async function enterShared(candidate: Candidate, cred: EnterCredentials, options: { initialize?: boolean; current?: () => boolean } = {}): Promise<EnterResult> {
  const current = options.current ?? (() => true);
  const device = await ensureDevice();
  if (!device) return { ok: false, error: "not-ready" };
  let key: string | undefined = cred.key;
  let firstDial = true;
  const make = async () => {
    if (candidate.access && !firstDial) {
      const fresh = await discoverRoom({ service: candidate.service, roomId: candidate.projectId, username: cred.username, as: cred.as, deviceId: device.deviceId, key });
      candidate.access = fresh.access; candidate.routeProtocol = fresh.routeProtocol;
    }
    firstDial = false;
    const protocols = await client.buildAuthProtocols({
      base: candidate.base,
      projectId: candidate.projectId,
      username: cred.username,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      as: cred.as,
      ...(candidate.access ? { fetch: relayFetch(candidate.access) } : {}),
      ...(key ? { key } : { password: cred.password }),
      role: "page",
      onKey: (k) => {
        key = k;
      },
    });
    return candidate.routeProtocol ? [...protocols, candidate.routeProtocol] : protocols;
  };
  // Fetch the challenge once first: rate limiting (429), project gone (404) and unreachable can be
  // told apart at this step
  let first: string[] | null;
  try {
    first = await make();
  } catch (e) {
    const { status, retryAfter } = errorStatus(e);
    if (status === 429) return { ok: false, error: "rate-limited", retryAfter };
    const terminal = classifyProtocolError(e);
    if (terminal) return { ok: false, error: terminal };
    return { ok: false, error: "unreachable" };
  }
  if (!current()) return { ok: false, error: "not-ready" };
  const wsUrl = candidate.ws ?? route.wsBaseOf(candidate.base);
  const outcome = await new Promise<"open" | CloseInfo>((resolve) => {
    let settled = false;
    const endIdentity = (link: SyncLink, failure: "auth" | "kicked" | "removed" | "deleted") => {
      if (cur?.link !== link || expectedClose === link) return;
      if (failure === "kicked") rememberKicked(candidate.projectId, cred.username, true);
      const descriptor = currentAssociation();
      recoveryCoordinator.cancel(); cancelHostTask(descriptor);
      clearSharedResume(); detach(); disconnectSharedAssets();
      patch({ blocked: failure === "auth" ? null : failure, shared: null, members: [], hosted: null, reopenState: failure === "auth" ? "needs-auth" : failure === "deleted" ? "deleted" : "rejected" });
      if (failure === "auth") pushToast(tr("The original collaboration identity has expired, please authenticate again; local content has been kept."), "warn", Infinity);
      // Even if the tunnel breaks before the fatal close frame arrives, `deleted` from the trusted
      // discovery endpoint must still be durably deregistered.
      if (failure === "deleted" && descriptor && !ONLINE_BUILD && !ONLINE) {
        void recoveryRequest("revoke", descriptor).catch(() => pushToast(tr("The room was deleted, but saving the local revocation record failed. Check the disk and try again."), "warn", Infinity));
      }
    };
    const link = new SyncLink({
      docSync: holding?.ds.projectId === candidate.projectId ? holding.ds : undefined,
      initialize: options.initialize === true,
      url: wsUrl,
      protocols: () => {
        if (first) {
          const p = first;
          first = null;
          return p;
        }
        return make();
      },
      resumeProtocols: candidate.access ? async () => {
        const fresh = await discoverRoom({ service: candidate.service, roomId: candidate.projectId, username: cred.username, as: cred.as, deviceId: device.deviceId, key });
        candidate.access = fresh.access; candidate.routeProtocol = fresh.routeProtocol;
        return fresh.routeProtocol ? [fresh.routeProtocol] : [];
      } : undefined,
      projectId: candidate.projectId,
      session,
      initial: getState().project,
      saveBackup: (b) => void saveBackup(b),
      onMessage: onSideMessage,
      onResponse: async msg => { if (msg.type === "auth.ticket.ok" && typeof msg.ticket === "string") await authorizeRelayAsset(candidate, msg.ticket); },
      onProtocolError: error => {
        if (!settled) return false;
        const failure = classifyProtocolError(error);
        if (!failure) return false;
        endIdentity(link, failure === "no-project" ? "deleted" : failure);
        return true;
      },
      onOpen: () => { void (async () => {
        if (!current()) { link.stop(); resolve({ code: 0, reason: "cancelled", fatal: false, neverOpened: true }); return; }
        if (settled) {
          // Reconnected: resubscribe to member changes
          link.send({ type: "shared.watch" });
          void connectSharedAssets(link, candidate.base, { online: ONLINE, fallback: lanAssetBaseOf(candidate) });
          return;
        }
        try { await sharedStateReady(link); } catch { link.stop(); if (!settled) { settled = true; resolve({ code: 0, reason: "host-data-missing", fatal: false, neverOpened: true }); } return; }
        if (!current() || settled) { if (!current()) link.stop(); return; }
        settled = true;
        if (holding?.ds === link.ds) releaseHolding();
        const descriptor = descriptorOf(candidate);
        setAssociation(descriptor);
        bind(link, "shared", candidate.projectId, wsUrl, null, `user:${cred.username}`);
        if (cur?.link === link) cur.updateAuthentication = k => { key = k; };
        patch({
          // The password path (local / LAN) has no read-only member identity yet, entering means read-write
          // (memberAccess in `server/auth/delegation.mjs`)
          shared: { projectId: candidate.projectId, name: candidate.name, mode: candidate.mode, where: candidate.where, base: candidate.base, username: cred.username, creator: cred.as === "creator", hostDeviceName: candidate.hostDeviceName, access: 'rw' },
          members: [],
          hosted: null,
          blocked: null,
        });
        rememberKicked(candidate.projectId, cred.username, false);
        if (cred.as === "creator") rememberCreator(candidate.projectId, cred.username);
        // Coming back here after a refresh of the same tab (only the derived K is stored, not the password;
        // see resumeShared)
        if (key) rememberSharedResume({ candidate, as: cred.as, username: cred.username, key });
        patch({ association: descriptor, reopenState: "connected" });
        if (key) {
          lastIdentity = { descriptor, record: { candidate, as: cred.as, username: cred.username, key, profile: "default" } };
          identitySave = saveRecoveryIdentity(descriptor, { candidate, as: cred.as, username: cred.username, key, profile: "default" });
          try { await identitySave; } catch { pushToast(tr("The collaboration identity could not be saved reliably; retry saving, otherwise you will need to authenticate again next time you open it."), "warn", Infinity); }
        }
        if (!current()) { link.stop(); resolve({ code: 0, reason: "cancelled", fatal: false, neverOpened: true }); return; }
        if (candidate.originalHost && !ONLINE_BUILD && !ONLINE) {
          try { await recoveryRequest("activate-host", descriptor); } catch { pushToast(tr("The local room has been restored, but the cloud registration has not. Check the collaboration status."), "warn"); }
          if (!current()) { link.stop(); resolve({ code: 0, reason: "cancelled", fatal: false, neverOpened: true }); return; }
        }
        link.send({ type: "shared.watch" });
        link.send({ type: "events.list", projectId: candidate.projectId });
        // C6.6: the asset service of this shared project (asset in the service address registry) is treated
        // as the remote asset service of the current connection
        // Online browser mode: the asset service is same-origin with this page, and must be accepted too
        // (c10a; assetTiers.pickAssetEndpoint)
        void connectSharedAssets(link, candidate.base, { online: ONLINE, fallback: lanAssetBaseOf(candidate) });
        resolve("open");
      })(); },
      onClosed: (info) => {
        if (!settled) {
          if (info.neverOpened && info.reason !== "protocols") {
            settled = true;
            link.stop();
            resolve(info);
          }
          return;
        }
        // The 4004 received when deleting one's own project (cancelling multi-user collaboration) is
        // expected, and does not show the blocking dialog
        if (info.fatal && cur?.link === link && expectedClose !== link) {
          const blocked: Blocked = info.code === 4004 ? "deleted" : info.reason === "removed" ? "removed" : "kicked";
          endIdentity(link, blocked);
        }
        refreshStatus();
      },
    });
    if (holding?.ds === link.ds) holding.target.link = link;
    link.start();
    setTimeout(() => {
      if (settled) return;
      settled = true;
      link.stop();
      resolve({ code: 0, reason: "timeout", fatal: false, neverOpened: true });
    }, 15_000);
  });
  if (outcome === "open") return { ok: true };
  if (outcome.reason === "host-data-missing") return { ok: false, error: "host-data-missing" };
  // Dropped before opening: the browser cannot tell a rejected handshake from a failed connection, so
  // ask shared/verify once with a fresh proof and then decide (enterFailure.ts)
  const failed = await classifyEnterFailure(outcome, {
    fresh: make,
    verify: (protocols) => client.verifyProtocols({ base: candidate.base, protocols, ...(candidate.access ? { fetch: relayFetch(candidate.access) } : {}) }),
    wasKicked: () => wasKicked(candidate.projectId, cred.username),
  });
  return { ok: false, ...failed };
}

/** The shared project connection we are closing ourselves (deleting the project when cancelling multi-user collaboration receives 4004, which does not count as deleted) */
let expectedClose: SyncLink | null = null;

/** The current shared project connection is about to be closed by the server (we deleted the project ourselves), do not show the blocking dialog */
export function expectSharedClose(on = true) {
  expectedClose = on ? cur?.link ?? null : null;
}

/**
 * Leave the shared project and return to the local space, and write `project` (defaults to the
 * current one) into the local project as a root replace (C10a section 6 "Uncheck": the project's
 * real content is pulled back to this machine). An online page has no local space, it only
 * disconnects.
 */
export function leaveSharedToLocal(project: Project = getState().project): Project {
  recoveryCoordinator.cancel(); cancelHostTask(currentAssociation()); setAssociation(null);
  releaseHolding();
  patch({ association: null, reopenState: null });
  clearSharedResume();
  patch({ shared: null, members: [], hosted: null, blocked: null });
  const out = switchToLocal(project, { load: true });
  expectedClose = null;
  return out;
}

let identitySave: Promise<void> | null = null;
let lastIdentity: { descriptor: CollaborationDescriptor; record: RecoveryIdentity } | null = null;
interface RecoveryIdentity { candidate: Candidate; as: "member" | "creator"; username: string; key: string; profile?: string }
export function descriptorOf(candidate: Candidate): CollaborationDescriptor {
  return { version: 1, roomId: candidate.projectId, where: candidate.where,
    service: serviceIdentity(candidate.service ?? (candidate.where === "hosted" ? candidate.base : hosted.resolveHostedUrl() || candidate.base)), hint: serviceIdentity(candidate.base) };
}
export async function recoveryRequest(endpoint: string, descriptor: CollaborationDescriptor, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, any>> {
  if (ONLINE_BUILD) throw new Error(tr("The online page has no local identity interface"));
  const r = await fetch(`/api/collaboration/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ descriptor, ...fields, task: session, taskVersion: recoveryCoordinator.generation }), signal, redirect: "error" });
  const body = await r.json();
  if (!r.ok || !body.ok) throw Object.assign(new Error(tr("Collaboration recovery failed")), { reason: body.error, retryAfter: body.retryAfter });
  return body;
}
function cancelHostTask(descriptor: CollaborationDescriptor | null) {
  if (!ONLINE_BUILD && !ONLINE && descriptor?.version === 1 && descriptor.where === "lan") void recoveryRequest("cancel-host", descriptor).catch(() => undefined);
}
if (!ONLINE_BUILD && !ONLINE && typeof window !== "undefined") window.addEventListener("pagehide", () => {
  const descriptor = currentAssociation(); recoveryCoordinator.cancel();
  if (descriptor?.version === 1 && descriptor.where === "lan") {
    navigator.sendBeacon?.("/api/collaboration/cancel-host", new Blob([JSON.stringify({ descriptor, task: session, taskVersion: recoveryCoordinator.generation })], { type: "application/json" }));
  }
});
async function saveRecoveryIdentity(descriptor: CollaborationDescriptor, record: RecoveryIdentity): Promise<void> {
  const { access: _access, routeProtocol: _route, originalHost: _host, ...candidate } = record.candidate;
  record = { ...record, candidate };
  if (ONLINE) {
    // Existing browser entry only. Restrictive storage errors remain visible to the user.
    const all = readJson<Record<string, RecoveryIdentity>>("pc.shared.identities", {});
    localStorage.setItem("pc.shared.identities", JSON.stringify({ ...all, [JSON.stringify([descriptor.service, descriptor.roomId, record.as, record.username])]: record }));
    return;
  }
  await recoveryRequest("identity", descriptor, { record, contentId: getState().project.id });
}
/**
 * The document service confirmed that the original cloud project no longer exists (proof already
 * checked): turn the content at hand into an independent local project. The content is the one being
 * kept (the content in the file plus the offline changes on this device not yet sent); switch to a
 * new local project ID; clear the collaboration link (multi-user collaboration is off by default);
 * deregister the old room identity stored on this machine as well; the save target and draft
 * ownership are cleared by subscribers (the original file is kept); the UI shows a notice once.
 */
let goneConversion = 0;
async function becomeLocalAfterGone(answer: { proof: GoneProof }) {
  const descriptor = currentAssociation();
  if (!descriptor || descriptor.where !== "hosted" || answer?.proof?.projectId !== descriptor.roomId) return;
  const kept = holding?.ds.projectId === descriptor.roomId ? holding : null;
  const contentId = getState().project.id ?? "";
  const ticket = ++goneConversion;
  const stillHere = () => ticket === goneConversion && currentAssociation() === descriptor && holding === kept;
  // First merge in the offline changes on this device that were not sent, then convert; if they cannot
  // be merged in, do not convert and do not deregister the local identity, the content stays as is
  if (kept && !ONLINE_BUILD && !ONLINE) {
    try {
      await restoreOfflineEdits({ restored: kept.restored,
        readJournal: async () => (await recoveryRequest("select", descriptor, { contentId })).journal ?? null,
        restoreJournal: (journal) => kept.ds.restoreJournal(journal as Parameters<DocSync["restoreJournal"]>[0]) });
      kept.restored = true;
    } catch (e) {
      if (!stillHere()) return;
      if ((e as { reason?: string }).reason === "offline-edits-unreadable") {
        patch({ reopenState: "waiting-storage" });
        setTimeout(() => { if (stillHere()) recoveryCoordinator.start(descriptor, contentId); }, 3000);
      } else patch({ reopenState: "damaged" });
      return;
    }
    if (!stillHere()) return;
  }
  const source = kept ? kept.ds.project : getState().project;
  let converted;
  try { converted = convertGoneProject(source, descriptor, answer.proof); }
  catch { patch({ reopenState: "damaged" }); return; }
  recoveryCoordinator.cancel(); releaseHolding(); setAssociation(null); clearSharedResume();
  detach(); disconnectSharedAssets();
  patch({ association: null, reopenState: null, shared: null, members: [], hosted: null, blocked: null });
  if (!ONLINE_BUILD && !ONLINE) void recoveryRequest("revoke", descriptor).catch(() => undefined);
  noteConvertedFrom(converted.project, converted.from);
  // Go through load: a project without a link is picked up by onLoad into the local space (a root
  // replace based on the file content)
  actions.loadProject(converted.project, getState().filePath);
  publishGoneConversion({ projectId: converted.project.id!, name: converted.project.name, from: converted.from });
}

const movedRooms = createAttemptStore(typeof localStorage === "undefined" ? null : localStorage);
function movedRoomAssociation(): CollaborationDescriptor | null {
  const d = currentAssociation();
  return !ONLINE_BUILD && !ONLINE && d?.version === 1 && d.where === "lan" && d.roomId && movedRooms.isMovedRoom(d.roomId) ? d : null;
}
/**
 * The local collaboration room recorded in the file was already closed on "Move to the cloud" (in
 * this device's protected storage it is deregistered, in page storage it is recorded as closed by
 * the move):
 * open the content at hand as an ordinary local project and clear the room link; files saved
 * afterwards no longer carry it.
 */
function becomeLocalAfterMove() {
  const descriptor = movedRoomAssociation();
  if (!descriptor) return;
  const kept = holding;
  const source = kept && kept.ds.projectId === descriptor.roomId ? kept.ds.project : getState().project;
  recoveryCoordinator.cancel(); releaseHolding(); setAssociation(null); clearSharedResume();
  detach(); disconnectSharedAssets();
  patch({ association: null, reopenState: null, shared: null, members: [], hosted: null, blocked: null });
  actions.loadProject(source, getState().filePath);
  pushToast(ACCOUNT_MOVE_TEXT.reopenedLocal, "info", 10_000);
}

const recoveryCoordinator = new RecoveryCoordinator({
  state: (reopenState: string, detail?: { proof: GoneProof }) => {
    if (reopenState === "gone" && detail?.proof) { void becomeLocalAfterGone(detail); return; }
    // The local collaboration room was closed on "Move to the cloud": an old file still carrying its
    // link (the copy that could not be written back then) opens as an ordinary local project instead of
    // getting stuck on "The original room has been deleted"
    if (reopenState === "deleted" && movedRoomAssociation()) { queueMicrotask(becomeLocalAfterMove); return; }
    patch({ reopenState });
  },
  // The trust table is only the one shipped with the software (`TRUSTED_GONE_AUTHORITIES` in
  // `gone-proof.mjs`, the default of `queryGone`): do not pass any other table here, and none is
  // allowed.
  // The gatekeeper test `server/test/gone-trust-source.test.mjs` blocks it.
  gone: (descriptor: CollaborationDescriptor, signal: AbortSignal) => queryGone(descriptor, { signal }),
  identity: async (descriptor: CollaborationDescriptor, contentId: string, signal: AbortSignal) => {
    if (ONLINE) {
      const identities = Object.values(readJson<Record<string, RecoveryIdentity>>("pc.shared.identities", {})).filter(r => descriptorOf(r.candidate).service === descriptor.service && r.candidate.projectId === descriptor.roomId);
      const resume = readSharedResume();
      const selected = identities.find(r => r.as === resume?.as && r.username === resume?.username) ?? (identities.length === 1 ? identities[0] : null);
      if (!selected && resume && descriptorOf(resume.candidate).service === descriptor.service && resume.candidate.projectId === descriptor.roomId && /^[A-Za-z0-9_-]{43}$/.test(resume.key)) return { identities: [resume], selected: resume };
      return { identities, selected };
    }
    let result = await recoveryRequest("select", descriptor, { contentId }, signal);
    if (result.recoveryMove?.terminal) throw Object.assign(new Error(tr("Room migration needs attention")), { reason: result.recoveryMove.error === "auth" ? "auth"
      : result.recoveryMove.error === "deleted" ? "deleted" : result.recoveryMove.error === "host-auth" || result.recoveryMove.error === "host-conflict" ? "host-conflict" : "relocation-damaged" });
    if (!signal.aborted && !result.selected && !result.revoked) {
      const legacy = readSharedResume();
      if (legacy && /^[A-Za-z0-9_-]{43}$/.test(legacy.key) && legacy.candidate.projectId === descriptor.roomId && descriptorOf(legacy.candidate).service === descriptor.service) {
        await saveRecoveryIdentity(descriptor, legacy);
        result = await recoveryRequest("select", descriptor, { contentId }, signal);
      }
    }
    if (!signal.aborted && result.selected && !result.revoked) {
      let settings = result.settings;
      if (!settings) {
        const legacy = readJson<Record<string, unknown>>("pc.shared.local", {})[descriptor.roomId!];
        if (legacy) {
          await recoveryRequest("settings-write", descriptor, { settings: legacy }, signal);
          settings = legacy;
          const all = readJson<Record<string, unknown>>("pc.shared.local", {}); delete all[descriptor.roomId!];
          localStorage.setItem("pc.shared.local", JSON.stringify(all));
        }
      }
      if (settings) cacheCollabSecrets(descriptor.roomId!, settings);
    }
    if (!signal.aborted && result.selected && holding && holding.ds.projectId === descriptor.roomId && !holding.restored) {
      try { if (result.journal) holding.ds.restoreJournal(result.journal); holding.restored = true; }
      catch { throw Object.assign(new Error(tr("Offline recovery data is corrupted")), { reason: "recovery-storage" }); }
      if (holding.ds.unconfirmed) persistJournal(holding.ds, descriptor, contentId);
    }
    return result;
  },
  host: async (descriptor: CollaborationDescriptor, signal: AbortSignal) => (await recoveryRequest("restore-host", descriptor, {}, signal)).candidate,
  discover: async (descriptor: CollaborationDescriptor, record: RecoveryIdentity, signal: AbortSignal) => {
    if (record.candidate.where === "hosted") {
      const service = record.candidate.service ?? descriptor.service;
      const relayBase = `${service!.replace(/\/+$/, "")}/hosting/relay/${descriptor.roomId}/doc`;
      // A persisted relay address never contains a current route capability; discover it afresh.
      if (record.candidate.base.replace(/\/+$/, "") !== relayBase) {
        const device = await ensureDevice(); if (!device) throw new Error(tr("Device information is not ready yet"));
        try {
          await client.buildAuthProtocols({ base: record.candidate.base, projectId: descriptor.roomId!, username: record.username, as: record.as, key: record.key,
            deviceId: device.deviceId, deviceName: device.deviceName,
            fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) }) });
          return { ...record.candidate, projectId: descriptor.roomId };
        } catch (e) {
          if (signal.aborted || (e as { reason?: string }).reason !== "relocated") throw e;
          // Only the durably sealed old service may redirect recovery to its trusted authority.
        }
      }
      const device = await ensureDevice(); if (!device) throw new Error(tr("Device information is not ready yet"));
      return discoverRoom({ service, roomId: descriptor.roomId, username: record.username, as: record.as, deviceId: device.deviceId, key: record.key });
    }
    if (!ONLINE_BUILD && !ONLINE) {
      let room;
      try {
        const r = await fetch(`/api/docservice/lan-discover?name=${encodeURIComponent(record.candidate.name)}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
        const found = r.ok ? await r.json() : null;
        room = found?.hosts?.find((h: { projectId: string }) => h.projectId === descriptor.roomId);
      } catch { if (signal.aborted) throw signal.reason; /* Discovery failure must still permit the trusted relay. */ }
      if (room) {
        const direct = { ...record.candidate, base: room.docservice, asset: room.asset, projectId: descriptor.roomId };
        // A stale multicast answer is a hint, never a reason to keep retrying an unreachable route.
        try { await client.buildAuthProtocols({ base: direct.base, projectId: direct.projectId!, username: record.username, as: record.as, key: record.key, deviceId: view.device!.deviceId, deviceName: view.device!.deviceName, fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) }) }); return direct; } catch { /* Try authenticated outbound relay. */ }
      }
    }
    // Kept only as a trusted device-owned hint; file-provided hints never receive a key.
    const device = await ensureDevice();
    if (!device) throw new Error(tr("Device information is not ready yet"));
    return discoverRoom({ service: record.candidate.service ?? descriptor.service, roomId: descriptor.roomId, username: record.username, as: record.as, deviceId: device.deviceId, key: record.key });
  },
  enter: (candidate: Candidate, record: RecoveryIdentity, current: () => boolean) => enterShared(candidate, { ...record, password: "" }, { current }),
});
let holding: { ds: DocSync; target: { link: SyncLink | null }; off: () => void; restored: boolean } | null = null;
let journalWrite: Promise<unknown> = Promise.resolve();
function persistJournal(ds: DocSync, descriptor: CollaborationDescriptor, contentId: string) {
  const journal = ds.recoveryJournal();
  journalWrite = journalWrite.catch(() => undefined).then(() => recoveryRequest("journal", descriptor, { contentId, journal }));
  void journalWrite.catch(() => pushToast(tr("Offline changes could not be saved reliably. Keep the current page open and try again."), "warn", Infinity));
}
function sharedStateReady(link: SyncLink): Promise<void> {
  return new Promise((resolve, reject) => {
    const ready = () => !!link.ds.confirmedProject && (link.ds.status === "online" || link.ds.status === "paused");
    if (ready()) { resolve(); return; }
    const timeout = setTimeout(() => { off(); reject(new Error(tr("Service state was not restored"))); }, 10000);
    const off = link.ds.on("status", () => { if (ready()) { clearTimeout(timeout); off(); resolve(); } });
    // Initial root acknowledgement can leave status unchanged (online -> online).
    void link.ds.whenSettled({ timeoutMs: 10000 }).then(() => { if (ready()) { clearTimeout(timeout); off(); resolve(); } }, () => undefined);
  });
}
function holdRecovery(project: Project, descriptor: CollaborationDescriptor) {
  if (descriptor.version !== 1) return;
  const target: { link: SyncLink | null } = { link: null };
  const ds = new DocSync(project, { projectId: descriptor.roomId!, session, initialize: false, send: msg => target.link?.send(msg as unknown as AnyMsg), saveBackup: b => void saveBackup(b) });
  const offStore = bindStore(ds, { load: onLoad });
  const offJournal = ds.on("project", () => {
    if (ONLINE_BUILD || ONLINE || !holding?.restored || holding.ds !== ds) return;
    persistJournal(ds, descriptor, project.id ?? "");
  });
  holding = { ds, target, restored: false, off: () => { offStore(); offJournal(); } };
}
function releaseHolding() { holding?.off(); holding = null; }
setProjectLoader(onLoad);
setRealtimeRevGetter(() => cur?.link?.ds?.rev ?? null);
// "Non-local content-determined snapshot" when saving as .proc: only provided while connected to this
// cloud project (when opened as a local copy, cur is the local space, and its sequence number and
// content must not be used)
setCloudSnapshotGetter((projectId) => {
  const ds = cur?.kind === "shared" && cur.docProjectId === projectId ? cur.link.ds : null;
  return ds?.confirmedProject ? { rev: ds.rev, project: ds.confirmedProject } : null;
});

/** A choice binds an existing device identity; file role fields never participate. */
export async function recoveryIdentities(): Promise<{ as: "creator" | "member"; username: string; profile?: string }[]> {
  const descriptor = currentAssociation();
  if (!descriptor) return [];
  const saved = await recoveryRequest("select", descriptor, { contentId: getState().project.id });
  return (saved.identities ?? []).map((r: RecoveryIdentity) => ({ as: r.as, username: r.username, profile: r.profile ?? "default" }));
}
export async function chooseRecoveryIdentity(as: string, username: string, profile = "default") {
  const descriptor = currentAssociation();
  if (!descriptor) return;
  const contentId = getState().project.id;
  const saved = await recoveryRequest("select", descriptor, { contentId });
  const selected = saved.identities?.find((r: RecoveryIdentity) => r.as === as && r.username === username && (r.profile ?? "default") === profile);
  if (!selected || saved.revoked) throw new Error(tr("This identity cannot be recovered"));
  await recoveryRequest("identity", descriptor, { contentId, record: selected });
  recoveryCoordinator.start(descriptor, contentId);
}
/** Explicit movement runs in the original host's service; reopening follows the same coordinator. */
export async function moveSharedToHosted(): Promise<{ ok: true } | { ok: false; error: string }> {
  const descriptor = currentAssociation(), original = cur?.link;
  if (ONLINE_BUILD || ONLINE || !descriptor || descriptor.where !== "lan" || !original || cur?.kind !== "shared") return { ok: false, error: "not-original-host" };
  try {
    await whenSaved(10000); await identitySave;
    if (cur?.link !== original || currentAssociation() !== descriptor) return { ok: false, error: "cancelled" };
    await recoveryRequest("move-hosted", descriptor);
    if (cur?.link !== original || currentAssociation() !== descriptor) return { ok: false, error: "cancelled" };
    const project = structuredClone(getState().project);
    recoveryCoordinator.cancel(); cancelHostTask(descriptor); releaseHolding(); detach(); disconnectSharedAssets();
    setAssociation(descriptor, true); patch({ association: descriptor, shared: null, members: [], hosted: null, blocked: null, reopenState: "waiting-host" });
    holdRecovery(project, descriptor); recoveryCoordinator.start(descriptor, project.id);
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as { reason?: string }).reason ?? "relocation-network" }; }
}
export async function moveSharedToLan(): Promise<{ ok: true } | { ok: false; error: string }> {
  const descriptor = currentAssociation(), original = cur?.link;
  if (ONLINE_BUILD || ONLINE || !descriptor || descriptor.where !== "hosted" || !original || cur?.kind !== "shared") return { ok: false, error: "not-ready" };
  try {
    await whenSaved(10000); await identitySave;
    if (cur?.link !== original || currentAssociation() !== descriptor) return { ok: false, error: "cancelled" };
    const result = await recoveryRequest("move-lan", descriptor, { contentId: getState().project.id });
    if (cur?.link !== original || currentAssociation() !== descriptor) return { ok: false, error: "cancelled" };
    const project = structuredClone(getState().project), destination = result.descriptor as CollaborationDescriptor;
    recoveryCoordinator.cancel(); releaseHolding(); detach(); disconnectSharedAssets();
    setAssociation(destination, true); patch({ association: destination, shared: null, members: [], hosted: null, blocked: null, reopenState: "waiting-host" });
    holdRecovery(project, destination); recoveryCoordinator.start(destination, project.id);
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as { reason?: string }).reason ?? "relocation-network" }; }
}
/** The user supplies a password after seeing the destination; no cached secret is sent to a file URL. */
export async function authenticateRecovery(username: string, password: string, as: "creator" | "member"): Promise<EnterResult> {
  const descriptor = currentAssociation();
  const device = await ensureDevice();
  if (!descriptor || descriptor.version !== 1 || !device) return { ok: false, error: "not-ready" };
  recoveryCoordinator.cancel();
  const generation = recoveryCoordinator.generation;
  let key: string | undefined;
  const candidate: Candidate = descriptor.where === "hosted"
    ? { where: "hosted", projectId: descriptor.roomId!, base: descriptor.service!, service: descriptor.service!, name: getState().project.name, mode: "free" }
    : await discoverRoom({ service: descriptor.service, roomId: descriptor.roomId, username, password, as, deviceId: device.deviceId, onKey: (k: string) => { key = k; } });
  const result = await enterShared(candidate, { as, username, password, key }, { current: () => recoveryCoordinator.generation === generation });
  if (!result.ok) patch({ reopenState: result.error === "auth" ? "needs-auth" : result.error === "kicked" ? "rejected" : "waiting-host" });
  return result;
}

/** Whether a shared project is currently connected (the project settings "Multi-user collaboration" shows its checked state by it) */
export function currentSharedLink(): SyncLink | null {
  return cur && cur.kind === "shared" ? cur.link : null;
}

/** Document service address of the current shared project connection (the render connection of a pure browser node uses the same address, M7 contract section 5); returns null when no shared project is connected */
export function currentSharedUrl(): string | null {
  return cur && cur.kind === "shared" ? cur.url : null;
}

/** Click "Start page" after being kicked / removed / the project was deleted: return to the local space, then to the start page */
export function leaveBlocked() {
  clearSharedResume();
  patch({ blocked: null, shared: null, members: [], hosted: null });
  switchToLocal(getState().project, { load: false });
  window.dispatchEvent(new Event("pc-go-home"));
}

/* ---------------- Creator actions ---------------- */

export type AdminError = "forbidden" | "rate-limited" | "bad-message" | "offline" | "other";

/**
 * Do one creator operation (contract `auth-contract.md` section 7): on the same connection fetch the
 * challenge, derive K from the creator password, compute the proof, send `shared.admin`.
 * The password is given on the spot each time (not cached); `key` is the K just verified in the same
 * operation flow (verifying identity and the actual operation are two proofs).
 */
export async function adminOp(
  op: string,
  auth: { password?: string; key?: string },
  fields: Record<string, unknown> = {},
): Promise<{ ok: true; reply: AnyMsg; key: string } | { ok: false; error: AdminError }> {
  const s = view.shared;
  if (!cur || cur.kind !== "shared" || !s) return { ok: false, error: "offline" };
  const link = cur.link;
  let ch: AnyMsg;
  try {
    ch = await link.request({ type: "shared.challenge" });
  } catch {
    return { ok: false, error: "offline" };
  }
  if (ch.type !== "shared.challenge.ok") return { ok: false, error: ch.reason === "rate-limited" ? "rate-limited" : "forbidden" };
  const key = auth.key ?? (await client.deriveKey(auth.password ?? "", ch.salt as string, ch.kdf as never));
  const m = await client.adminProof({ key, projectId: s.projectId, username: s.username, op, nonce: ch.nonce as string });
  let reply: AnyMsg;
  try {
    reply = await link.request({ type: "shared.admin", op, proof: { nonce: ch.nonce, m }, ...fields });
  } catch {
    return { ok: false, error: "offline" };
  }
  if (reply.type === "shared.admin.ok") {
    const descriptor = currentAssociation();
    const replacement = op === "set-creator-password" && s.creator ? fields.creator : op === "set-password" && !s.creator ? fields.project : null;
    if (descriptor && lastIdentity && replacement && typeof (replacement as { key?: unknown }).key === "string") {
      const record = { ...lastIdentity.record, key: (replacement as { key: string }).key };
      if (cur?.link === link) cur.updateAuthentication?.(record.key);
      lastIdentity = { descriptor, record }; identitySave = saveRecoveryIdentity(descriptor, record);
      rememberSharedResume(record);
      try { await identitySave; } catch { pushToast(tr("The new password is in effect, but saving the local recovery credential failed; retry saving."), "warn", Infinity); }
    }
    if (descriptor && !ONLINE_BUILD && !ONLINE) void recoveryRequest("host-update", descriptor).catch(() => pushToast(tr("Cloud permission registration is waiting for a retry; local permissions have been updated."), "warn"));
    return { ok: true, reply, key };
  }
  const reason = String(reply.reason ?? "");
  return { ok: false, error: reason === "forbidden" || reason === "rate-limited" || reason === "bad-message" ? (reason as AdminError) : "other" };
}

/**
 * The creator switches the host's service on or off (contract `docs/plan/hosted-render-contract.md`
 * section 3): `shared.admin { op: 'set-hosted-service' }`, with the same proof as other creator
 * operations (`key` is the K just verified in the same flow). On success, immediately update this
 * page's switch state (the server later pushes a refreshed member list, which takes precedence).
 */
export async function setHostedService(service: HostedServiceName, enabled: boolean, key: string): Promise<HostedChangeResult> {
  if (view.shared?.accountId) {
    // Account project: no creator-password proof, it relies on the account's login state, and the server
    // checks the creator identity (members get 403). Renew the session after the change, and the UI
    // follows the state it read
    try {
      if (service === 'agent') await setAccountAgentEnabled(enabled);
      else await setAccountHosted({ service, enabled });
      return { ok: true };
    } catch (error) { return accountHostedFailure(error); }
  }
  const r = await adminOp("set-hosted-service", { key }, { service, enabled });
  if (!r.ok) return r;
  patch({ hosted: applyHostedChange(view.hosted, service, enabled) });
  // The creator's own AI panel on this page also changes right away (the notification is only sent to
  // other connections)
  if (service === "agent") setHostedAgentEnabled(view.shared?.projectId ?? currentDocProjectId(), enabled);
  return { ok: true };
}

/**
 * The creator changes a sub-option under the host's service (the render node's "generate track
 * streams", contract `docs/plan/hosted-render-contract.md` section 3.1):
 * `shared.admin { op: 'set-hosted-option' }`, with the same proof as other creator operations. On
 * success, immediately update this page's state (the server later pushes a refreshed member list).
 * Account project (the cloud account path): the creator changes it through `set-hosted-option` on
 * `/hosted/shared/account/admin`, relying on the account's login state, and members are rejected by
 * the server.
 */
export async function setHostedOption(service: HostedServiceName, option: HostedOptionName, enabled: boolean, key: string): Promise<HostedChangeResult> {
  if (view.shared?.accountId) {
    if (service !== 'render') return { ok: false, error: 'bad-message' };
    try { await setAccountHosted({ service, option, enabled }); return { ok: true }; }
    catch (error) { return accountHostedFailure(error); }
  }
  const r = await adminOp("set-hosted-option", { key }, { service, option, enabled });
  if (!r.ok) return r;
  patch({ hosted: applyHostedOptionChange(view.hosted, service, option, enabled) });
  return { ok: true };
}

/** The account branch uses the live bearer/admin revision; no legacy password challenge. */
export async function setAccountAgentEnabled(enabled: boolean): Promise<void> {
  if (!cur?.setAccountAgentEnabled) throw new AccountFailure(503, 'session-unavailable');
  await cur.setAccountAgentEnabled(enabled);
}

/** Account project: the creator changes the host's render node switch or its sub-option (same as above, relying on the account's login state) */
async function setAccountHosted(change: Parameters<NonNullable<Current["setAccountHosted"]>>[0]): Promise<void> {
  if (!cur?.setAccountHosted) throw new AccountFailure(503, 'session-unavailable');
  await cur.setAccountHosted(change);
}

/** Result of changing the host's service switch. On failure in an account project it also carries `message` (one sentence translated from the rejection reason given by the server), see `accountHostedFailure` in `hostedServices.ts` */
export type HostedChangeResult = { ok: true } | { ok: false; error: AdminError; message?: string };


/** A new password credential (used for changing the project password, the list, and the creator password); kdf uses the default, consistent with the project record */
export function makeCredential(password: string) {
  return client.makeCredential(password);
}

/**
 * Account cloud project: invalidate and regenerate the project link (10-14 section 3.3). The old link
 * stops working, members already inside are unaffected, and new people use the new link.
 * Only account projects have this (rooms of the old way use "Invalidate and regenerate invite code").
 */
export async function regenAccountProjectLink(): Promise<{ ok: true; link: string } | { ok: false; error: string }> {
  if (!view.shared?.accountId || !cur?.regenAccountLink) return { ok: false, error: tr("This is not an account cloud project.") };
  try { return { ok: true, link: await cur.regenAccountLink() }; }
  catch (e) { return { ok: false, error: e instanceof Error && e.message ? e.message : tr("Failed to regenerate the project link.") }; }
}

/** Account cloud project: set / change the project secondary password (a string, as is, whitespace not trimmed) or clear it (null or empty string) (10-14 section 3.3) */
export async function setAccountSecondaryPassword(password: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!view.shared?.accountId || !cur?.setAccountSecondaryPassword) return { ok: false, error: tr("This is not an account cloud project.") };
  try { await cur.setAccountSecondaryPassword(password || null); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error && e.message ? e.message : tr("Failed to set the project secondary password.") }; }
}

/** The current project link of an account cloud project (the creator gets it with the current link token); returns null when not in an account project */
export function currentAccountProjectLink(): string | null {
  return view.shared?.accountId && cur?.accountLink ? cur.accountLink() : null;
}

/**
 * The history sequence number and commit summary to carry up on "Move to the cloud" (10-14 section
 * 3.3): read from the `DocSync` of the current local document connection (a local project connects
 * to the local document service, a collaboration room of the old way connects to the room), only
 * given when it is connected to exactly this content (`contentId`); returns null when the sequence
 * number confirmed by the document service is not yet available (`rev` is 0) or when already in an
 * account cloud project.
 */
export function currentDocLineage(contentId: string): { rev: number; history: CommitSummary[] } | null {
  const ds = cur?.link.ds;
  if (!cur || !ds || view.shared?.accountId || !contentId || ds.project.id !== contentId) return null;
  const rev = ds.rev;
  if (!Number.isSafeInteger(rev) || rev < 1) return null;
  return { rev, history: ds.history.filter((h) => h.rev <= rev) };
}
