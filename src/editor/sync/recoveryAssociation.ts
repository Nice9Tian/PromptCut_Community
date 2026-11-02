import type { Project } from "../../kernel/project";
// @ts-expect-error Browser-safe format validation, also used by the server.
import { parseCollaboration } from "../../../server/recovery/descriptor.mjs";
import { convertGoneProject, type GoneProof } from "./cloudGone";
import { verifiedBase, type CloudSnapshot } from "./cloudSnapshot";
import { JOIN_REQUEST_TEXT, reopenNotice, type JoinRequestStatus } from "./joinRequestText";
import { createRequestIds } from "./requestIds";
import { tr } from "../../i18n/index.ts";


export interface CollaborationDescriptor {
  version: number;
  roomId?: string;
  service?: string;
  where?: "lan" | "hosted";
  hint?: string;
  [key: string]: unknown;
}
let pending: { contentId: string; descriptor: CollaborationDescriptor | null } | null = null;
let active: CollaborationDescriptor | null = null;
let recovering = false;

/** Validate only, do not record: throw if the collaboration association in the file is corrupted (called when opening a file, before any side effect) */
export function checkAssociation(value: unknown): void { parseCollaboration(value); }
export function noteLoadedAssociation(project: Project, value: unknown) {
  pending = { contentId: project.id!, descriptor: parseCollaboration(value) as CollaborationDescriptor | null };
}
export function takeLoadedAssociation(project: Project): CollaborationDescriptor | null {
  const value = pending && pending.contentId === project.id ? pending.descriptor : null;
  pending = null; active = value; recovering = !!value;
  return value;
}
export function currentAssociation(): CollaborationDescriptor | null { return active; }
export function setAssociation(value: CollaborationDescriptor | null, restoring = false) { active = value; recovering = !!value && restoring; }
export function isRecoveringAssociation(): boolean { return recovering; }

/**
 * Provenance record for "an expired cloud project was converted to a local project" (saved in the `.proc` shell, used only for notices and tracing):
 * the original room ID and collaboration service address, plus the issuer, tombstone version and key ID from the document service's "no longer exists" proof.
 * It contains no account credentials and is not a recovery association: reopening a file that carries it gives an ordinary local project and no longer connects to the old cloud.
 */
export interface ConvertedFrom {
  v: 1;
  roomId: string;
  service: string;
  authorityId: string;
  tombstoneRevision: number;
  kid: string;
  convertedAt: string;
}
export function parseConvertedFrom(value: unknown): ConvertedFrom | null {
  const v = value as Partial<ConvertedFrom> | null;
  if (!v || typeof v !== "object" || v.v !== 1 || typeof v.roomId !== "string" || !/^sp_[a-z2-7]{26}$/.test(v.roomId) ||
    typeof v.service !== "string" || v.service.length > 2048 || typeof v.authorityId !== "string" || v.authorityId.length > 128 ||
    !Number.isSafeInteger(v.tombstoneRevision) || typeof v.kid !== "string" || v.kid.length > 128 ||
    typeof v.convertedAt !== "string" || v.convertedAt.length > 64) return null;
  return { v: 1, roomId: v.roomId, service: v.service, authorityId: v.authorityId, tombstoneRevision: v.tombstoneRevision!, kid: v.kid, convertedAt: v.convertedAt };
}
let convertedFrom: { contentId: string; info: ConvertedFrom } | null = null;
/** Recorded when a file is loaded or just after a conversion; once a different project is switched to (different project ID) this one is no longer returned */
export function noteConvertedFrom(project: Pick<Project, "id">, value: unknown) {
  const info = parseConvertedFrom(value);
  convertedFrom = info && project.id ? { contentId: project.id, info } : null;
}
export function convertedFromOf(project: Pick<Project, "id">): ConvertedFrom | null {
  return convertedFrom && convertedFrom.contentId === project.id ? convertedFrom.info : null;
}

/** Notification that a conversion finished: the save target and draft ownership are cleared accordingly (the original file is kept), and the UI shows a notice once. */
export interface GoneConversion { projectId: string; name: string; from: ConvertedFrom }
const goneListeners = new Set<(event: GoneConversion) => void>();
let goneNotices: GoneConversion[] = [];
export function onGoneConversion(listener: (event: GoneConversion) => void): () => void {
  goneListeners.add(listener); return () => { goneListeners.delete(listener); };
}
export function publishGoneConversion(event: GoneConversion) {
  goneNotices = [...goneNotices, event];
  for (const listener of [...goneListeners]) { try { listener(event); } catch { /* One subscriber failing does not block the others */ } }
}
/** The UI takes the entries that have not been notified yet (each entry is notified only once) */
export function takeGoneNotices(): GoneConversion[] { const out = goneNotices; goneNotices = []; return out; }

/**
 * Cloud association marker when an account cloud project is saved as .proc / .procp (10-14 section 3.4)
 */
export interface CloudProjectAssociation {
  accountProject: true;
  projectId: string;
  docServiceUrl: string;
  origin?: string;
  savedRev: number;
  savedAt: string;
  /**
   * Pinned non-local snapshot (`cloudSnapshot.ts`): the version the document service confirmed at the moment of save-as (the baseline content) and its hash.
   * Old files do not have it; on read-back, one whose hash does not match is discarded (treated as absent), and the file still opens as before.
   */
  base?: Project;
  baseSha256?: string;
}

export function parseCloudAssociation(value: unknown): CloudProjectAssociation | null {
  const v = value as Partial<CloudProjectAssociation> | null;
  if (!v || typeof v !== "object" || v.accountProject !== true || typeof v.projectId !== "string" || !v.projectId) return null;
  if (typeof v.docServiceUrl !== "string" || !v.docServiceUrl) return null;
  const savedRev = Number.isSafeInteger(v.savedRev) ? Number(v.savedRev) : 1;
  const savedAt = typeof v.savedAt === "string" ? v.savedAt : new Date().toISOString();
  return {
    accountProject: true,
    projectId: v.projectId,
    docServiceUrl: v.docServiceUrl,
    origin: typeof v.origin === "string" ? v.origin : v.docServiceUrl,
    savedRev,
    savedAt,
    ...(verifiedBase(v) ? { base: v.base as Project, baseSha256: v.baseSha256 as string } : {}),
  };
}

let loadedCloudAssoc: { contentId: string; assoc: CloudProjectAssociation } | null = null;
let activeCloudAssoc: CloudProjectAssociation | null = null;

export function noteLoadedCloudAssociation(project: Pick<Project, "id">, value: unknown) {
  const assoc = parseCloudAssociation(value);
  loadedCloudAssoc = assoc && project.id ? { contentId: project.id, assoc } : null;
}

export function takeLoadedCloudAssociation(project: Pick<Project, "id">): CloudProjectAssociation | null {
  const value = loadedCloudAssoc && loadedCloudAssoc.contentId === project.id ? loadedCloudAssoc.assoc : null;
  loadedCloudAssoc = null;
  activeCloudAssoc = value;
  return value;
}

export function currentCloudAssociation(): CloudProjectAssociation | null {
  return activeCloudAssoc;
}

export function setCloudAssociation(value: CloudProjectAssociation | null) {
  activeCloudAssoc = value;
}

/**
 * On save-as, fetches the confirmed copy and sequence number of "the cloud project currently connected" (installed by `syncManager.ts`); returns null if this project is not connected,
 * and save-as then keeps the baseline already in the file (`snapshotForSave` in `cloudSnapshot.ts`).
 */
let cloudSnapshotGetter: ((projectId: string) => CloudSnapshot | null) | null = null;
export function setCloudSnapshotGetter(getter: ((projectId: string) => CloudSnapshot | null) | null) {
  cloudSnapshotGetter = getter;
}
export function currentCloudSnapshot(projectId: string): CloudSnapshot | null {
  return cloudSnapshotGetter ? cloudSnapshotGetter(projectId) : null;
}

let realtimeRevGetter: (() => number | null) | null = null;
export function setRealtimeRevGetter(getter: () => number | null) {
  realtimeRevGetter = getter;
}
/**
 * Query for "whether this cloud project is really gone" (a replaceable seam).
 *
 * The real implementation is `server/recovery/gone-proof.mjs` (closed source), registered by `cloud/account/manifest.ts`.
 * The default on the public side is "no credentials found": the community edition has no cloud projects, so this path is never reached;
 * when the default returns null the caller shows "cannot open" as before and never marks a local project as "converted from a vanished cloud project".
 */
let goneQuery: ((descriptor: CollaborationDescriptor) => Promise<GoneProof | null>) | null = null;

export function registerGoneQuery(fn: ((descriptor: CollaborationDescriptor) => Promise<GoneProof | null>) | null): void {
  goneQuery = fn;
}

export function currentRealtimeRev(): number | null {
  return realtimeRevGetter ? realtimeRevGetter() : null;
}

/** The shape of `pushToast`: returns the ID of the bubble (used to close it); one with a button does not disappear by itself */
type ReopenToast = (msg: string, tone?: "info" | "warn", duration?: number, action?: { label: string; run: () => void; pc?: string }) => number | void;
type JoinRequestClient = { joinRequestStatus?: (projectId: string) => Promise<JoinRequestStatus>; sendJoinRequest?: (projectId: string, requestId: string) => Promise<JoinRequestStatus> };
/**
 * The notice "This account is not a member of this cloud project" shown when reopening a file. Only when blocked by the account list (`not-listed`) and the project allows only its account list does it also carry a "Send request" button
 * (first look up the account's own request: if one is already waiting, or it was rejected and the attempts are used up, no button is given, and the current status is appended after the message); for kicked (`banned`) or unknown cases there is just the message as before.
 * Clicking the button sends the request: if no reply was received, clicking again reuses the original request ID (`src/account/requestIds.ts`, shared with the start page and the member popover); only one is sent at a time.
 * Once sent, this notice with the button is closed and later clicks no longer send (semantics: after sending, show "Sent, waiting for the creator to approve"; it must not stay up and let people send repeatedly, wasting request attempts),
 * and a new notice "Sent, waiting for the creator to approve" is raised, explaining how to reconnect after approval.
 */
async function notMemberToast(toast: ReopenToast, dismissToast: ((id: number) => void) | undefined, client: JoinRequestClient | null | undefined,
  projectId: string, code: unknown) {
  let status: JoinRequestStatus | null = null;
  if (code === "not-listed" && typeof client?.joinRequestStatus === "function" && typeof client.sendJoinRequest === "function") {
    try { status = await client.joinRequestStatus(projectId); } catch { status = null; }
  }
  const notice = status ? reopenNotice(status) : null;
  if (!notice) { toast(JOIN_REQUEST_TEXT.reopenNotMember, "warn", 10_000); return; }
  if (!notice.canSend) { toast(notice.text, "warn", 10_000); return; }
  const ids = createRequestIds();
  let sending = false, done = false;
  const id = toast(notice.text, "warn", Infinity, { label: JOIN_REQUEST_TEXT.send, pc: "reopen-join-request", run: () => {
    if (sending || done) return;
    sending = true;
    void ids.run("send", requestId => client!.sendJoinRequest!(projectId, requestId)).then(result => {
      done = true;
      if (typeof id === "number") dismissToast?.(id);
      const next = reopenNotice(result);
      toast(result.state === "pending" ? JOIN_REQUEST_TEXT.reopenSent : (next?.text ?? JOIN_REQUEST_TEXT.reopenNotMember), "info", 10_000);
    }, (error: { message?: string }) => {
      toast(error?.message || tr("The request was not sent. Please try again."), "warn", 10_000);
    }).finally(() => { sending = false; });
  } });
}

/**
 * The four rules for reopening after an account cloud project is saved as .proc / .procp (10-14 section 3.4):
 * 1. Not logged in: prompt to log in, open the local copy, keep the association;
 * 2. The logged-in account is not a member: show "This account is not a member of this cloud project" and open the local copy; if the project allows only its account list, the notice also has a "Send request" button
 *    (user decision, 2026-10-22, `workflow/project.md` line 44; `notMemberToast`);
 * 3. The cloud project was deleted: using the deletion proof (goneProof), convert to a standalone local project and open it;
 * 4. Has permission and has offline changes: reconnect to the cloud project and merge the offline changes; on a network error fall back to the local copy.
 */
export async function handleCloudAssociationReopen(
  project: Project,
  assoc: CloudProjectAssociation,
  options: {
    account?: { id: string; name: string } | null;
    client?: {
      account?: { id: string; name: string } | null;
      session: (projectId: string) => Promise<any>;
      join?: (projectId: string, requestId: string, joinOpts?: any) => Promise<any>;
    } | any;
    queryGone?: (descriptor: CollaborationDescriptor) => Promise<GoneProof | null>;
    isOfflineModified?: boolean;
    cloudProject?: Project;
    /** The 4th parameter is the button on the bubble (the "Send request" of the "not a member" notice when reopening); `pushToast` already accepts it */
    toast?: (msg: string, tone?: "info" | "warn", duration?: number, action?: { label: string; run: () => void; pc?: string }) => number | void;
    /** Close a bubble (`dismissToast` in `syncManager.ts`): the notice with "Send request" from reopening a file is closed once the request is sent */
    dismissToast?: (id: number) => void;
    openAsLocal?: (p: Project) => void;
    /**
     * Reconnect to the cloud project and handle the changes in the file; returns `"pending-merge"` when the cloud was changed by someone else after the save-as and the changes went into "conflict merge" (not committed directly).
     */
    enterProject?: (options: any) => Promise<void | "pending-merge">;
  } = {},
): Promise<{ status: "opened" | "merged" | "pending-merge" | "converted" | "login-required" | "forbidden"; project?: Project }> {
  const toast = options.toast ?? (() => {});
  // 1. Rule 1: not logged in
  let account = options.account;
  let client = options.client;
  if (account === undefined) {
    try {
      const flow = await import("./accountMoveFlow.ts");
      const c = await flow.accountCloud();
      if (c) {
        client = c.client;
        account = await flow.accountCloudLogin(c);
      }
    } catch {}
  }

  if (!account) {
    toast(tr("Please sign in to your website account first; opening a local copy for now."), "info");
    setCloudAssociation(assoc);
    options.openAsLocal?.(project);
    return { status: "login-required", project };
  }

  // 2. Check member permissions and status
  let session: any = null;
  const descriptor: CollaborationDescriptor = {
    version: 1,
    roomId: assoc.projectId,
    where: "hosted",
    service: assoc.docServiceUrl,
  };

  if (client) {
    try {
      session = await client.session(assoc.projectId);
    } catch (error: any) {
      const status = error?.status;
      const code = error?.code;
      // Rule 3: the cloud project was deleted by its creator
      if (status === 404 || code === "project-gone" || code === "no-project") {
        const query = options.queryGone ?? goneQuery ?? (async () => null);
        let proof: GoneProof | null = null;
        try { proof = await query(descriptor); } catch {}
        if (proof) {
          const converted = convertGoneProject(project, descriptor, proof);
          setCloudAssociation(null);
          publishGoneConversion({ projectId: converted.project.id!, name: converted.project.name, from: converted.from });
          toast(tr("This cloud project no longer exists."), "info", 8000);
          options.openAsLocal?.(converted.project);
          return { status: "converted", project: converted.project };
        }
      }
      // Rule 2: logged in but not a member of this project (a project that allows only its account list also gets "Send request")
      if (status === 403 || code === "not-listed" || code === "banned" || code === "forbidden") {
        await notMemberToast(toast, options.dismissToast, client, assoc.projectId, code);
        setCloudAssociation(assoc);
        options.openAsLocal?.(project);
        return { status: "forbidden", project };
      }
      // Network error or other temporary failure: fall back to opening the local copy
      options.openAsLocal?.(project);
      toast(tr("Can't reach the cloud project; opening a local copy for now."), "warn", 6000);
      return { status: "opened", project };
    }
  }

  if (!session && !options.client) {
    toast(JOIN_REQUEST_TEXT.reopenNotMember, "warn", 10_000);
    setCloudAssociation(assoc);
    options.openAsLocal?.(project);
    return { status: "forbidden", project };
  }

  // Rule 4: has permission. Check for offline changes
  const isOfflineModified = options.isOfflineModified ?? (
    ((project as any).rev !== undefined && (project as any).rev > assoc.savedRev) ||
    (options.cloudProject && JSON.stringify(project) !== JSON.stringify(options.cloudProject))
  );

  let outcome: void | "pending-merge" = undefined;
  if (options.enterProject && client) {
    try {
      outcome = await options.enterProject({
        client,
        origin: assoc.origin || assoc.docServiceUrl,
        projectId: assoc.projectId,
        name: project.name,
        initial: project,
        firstSession: session,
      });
    } catch {
      options.openAsLocal?.(project);
      toast(tr("Can't reach the cloud project; opening a local copy for now."), "warn", 6000);
      return { status: "opened", project };
    }
  }

  if (isOfflineModified) {
    if (outcome === "pending-merge") {
      // The cloud was changed by someone else after the save-as: compare the changes item by item against the baseline at save-as time and put them into "conflict merge", instead of overwriting directly
      toast(tr("Reconnected to the cloud project. Others changed the cloud project after you saved a copy, so your changes were placed in \"Conflict merge\", where you can merge them item by item."), "info", 8000);
      return { status: "pending-merge", project };
    }
    toast(tr("Reconnected to the cloud project; offline changes were merged and synced."), "info", 6000);
    return { status: "merged", project };
  }

  return { status: "opened", project };
}


