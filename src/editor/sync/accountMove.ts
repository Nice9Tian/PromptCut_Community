/**
 * The account mode's "move to the cloud" (desktop app): move a local project opened on this machine, or a
 * collaboration room opened locally under the old mode, into a cloud project owned by the currently logged-in account.
 * The four rules the user decided on 2026-10-13 are in `docs/plan/user-decisions-2026-10-13.md`, section 2 "Move a
 * local project to the cloud"; report: `docs/reports/AGENT-v18-move.md`.
 *
 * This file holds only the flow itself and knows nothing about the store, the UI or the account client: everything
 * it needs is supplied by the caller (`MoveDeps`), and the wiring is in `accountMoveFlow.ts`. This way the success
 * and failure of every step can be unit-tested in Node (`accountMove.test.mjs`), and tests against a real server
 * are in `server/test/account-move.test.mjs`.
 *
 * **Cloud first, local after** (the lesson from the old flow: it blocked the local room first and then uploaded, and
 * a failure left the room unopenable):
 *
 *   1 Check     Whether logged in; a collaboration room must be entered as its creator, and the creator password
 *               is verified on the spot (a read-only check that changes nothing); wait for local changes to
 *               settle, then take the project content; if the content exceeds the document service's limit for
 *               one root replacement, stop here.
 *   2 Create    `POST /hosted/shared/account/create`, with an empty project as a placeholder (the real content does
 *               not go through this endpoint: its limit is 1 MiB, the desktop shell's account bridge is also
 *               1 MiB, and when the same request ID is replayed the content must match byte for byte). The
 *               request ID, project name and placeholder content are first recorded locally
 *               (`MoveAttemptStore`); clicking again after a failure uses the same request ID, and the create
 *               endpoint is idempotent on it, so the cloud does not end up with a duplicate-named project.
 *   3 Upload    Open another document connection (not the one the editor is using) and write the project content
 *               into it as one root replacement; anything over the single-commit limit is uploaded by `DocSync` in
 *               chunks.
 *   4 Verify    Open one more connection and read the cloud content back, then compare it field by field with the
 *               local copy; stop if they differ. If the local side was modified again in the meantime, upload and
 *               verify again; if the local side is still changing after several rounds (an Agent or tool keeps
 *               editing through a connection), stop and do not go further.
 *   -- Up to here, the local project file, room record and collaboration state have not been touched at all.
 *   If any step fails, the local side stays usable as it was. --
 *   5 Collab room   First pull any media this computer does not have (when the person moving is not on the host
 *               computer), then close local collaboration (delete the room: old members' connections drop, old
 *               invite codes are void, and the registration on the hosted cloud service is cancelled). **The first
 *               thing after closing is to save the current content locally** (an ordinary local project with no
 *               room link), and only then upload what others changed right as it closed; if that top-up fails,
 *               the local copy is complete, and clicking again from the local project continues the top-up with
 *               the original request ID.
 *   6 Enter the project   The editor attaches to the cloud project; media goes to the upload queue and is uploaded
 *               in the background (small size first, then original size).
 *               **Compare once more at the moment of switching** (the contract of `MoveDeps.enter`): if the
 *               editor's content differs from the copy verified with the cloud, do not switch and go back to
 *               upload again, so "reported success but the cloud is older than local" cannot happen.
 *
 * What does not move to the cloud with the project (the old room's members and list, the project password, the
 * creator passphrase, invite codes, the ban list, the undo stack, Cloud Agent chats, etc.) is listed in the report.
 */
import type { Project } from "../../kernel/project";
import { UPLOAD_MAX_PARTS, UPLOAD_PART_CHARS } from "../../store/docsync";
import { SyncLink } from "./link";
import { tr } from "../../i18n/index.ts";

/* ---------------- Results and errors ---------------- */

export type MoveStage = "check" | "create" | "upload" | "verify" | "pull-media" | "close-local" | "sync-last" | "enter" | "queue-media" | "done";

export type MoveErrorCode =
  /** Not logged in to the website account */
  | "login-required"
  /** What is currently open cannot be moved (already a cloud project, collaboration identity not yet restored, online page) */
  | "not-ready"
  /** Collaboration room: not entered as its creator */
  | "not-creator"
  /** Collaboration room: the creator password is required (not stored locally and not filled in on the UI) */
  | "creator-password"
  /** Collaboration room: wrong creator password */
  | "bad-password"
  | "rate-limited"
  /** Another window is moving the same project */
  | "busy"
  /** The project kept being modified during the move (Agent or tool still editing), and several upload rounds could not catch up */
  | "busy-editing"
  /** Local changes have not settled (the document service never confirmed) */
  | "save-pending"
  /** The project content exceeds the limit for one root replacement */
  | "too-large"
  | "name-taken"
  | "invalid-name"
  /** This account is currently not allowed to create new ones (host policy, count limit) */
  | "create-refused"
  /** The software version is out of date (<0.7.18) */
  | "version-expired"
  /** The target cloud has no account-mode create endpoint (not an account-mode node) */
  | "not-account-cloud"
  /** Cannot reach the cloud (network, timeout) */
  | "network"
  /** The cloud replied with a server error (5xx): whether creation succeeded is uncertain, keep the request ID */
  | "create-failed"
  | "upload-failed"
  | "verify-failed"
  | "media-pull-failed"
  | "close-failed"
  | "sync-last-failed"
  | "enter-failed";

export interface MediaReport {
  /** Number of media items handed to the upload queue */
  queued: number;
  /** Names of media whose files cannot be found locally and cannot be uploaded */
  missing: string[];
}

export type MoveResult =
  | { ok: true; kind: "local" | "room"; projectId: string; name: string; link: string; media: MediaReport | null }
  | {
    ok: false; error: MoveErrorCode; stage: MoveStage; detail?: string;
    /** Local collaboration is already closed (only a failure after step 5 is true); false = the local project, room and collaboration state are untouched */
    localClosed: boolean;
    /** After local collaboration was closed, whether the current content was saved to a local file (only present when `localClosed`) */
    localSaved?: boolean;
    /** The project already created in the cloud (clicking again continues with it); null if it was not created */
    cloud: { projectId: string; name: string } | null;
    /** Cooldown seconds given by the server when rate limited */
    retryAfter?: number | null;
  };

/* ---------------- Content comparison ---------------- */

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonical(v)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/** Canonical text of the project content: keys sorted, `undefined` removed (consistent with the result after a JSON round trip) */
export function contentText(project: unknown): string {
  return JSON.stringify(canonical(project));
}

/** The two project contents are identical field by field */
export function sameContent(a: unknown, b: unknown): boolean {
  return a === b || contentText(a) === contentText(b);
}

/**
 * Number of characters one root replacement can hold: `DocSync` splits a root replacement that exceeds the
 * single-commit limit into at most `UPLOAD_MAX_PARTS` pieces of `UPLOAD_PART_CHARS` characters each
 * (`wireOps` in `src/store/docsync.ts`; the document service's `PROJECT_LIMITS.UPLOAD_MAX_PARTS`). Anything larger
 * cannot be uploaded.
 */
export const MAX_CONTENT_CHARS = UPLOAD_MAX_PARTS * UPLOAD_PART_CHARS;

/* ---------------- Whether "the cloud" means the account cloud ---------------- */

const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url.trim());
    return ["http:", "https:", "ws:", "wss:"].includes(u.protocol) ? u.host.toLowerCase() : null;
  } catch { return null; }
};

/**
 * Whether the cloud address filled in on the UI (or used for room registration) points to the account cloud
 * configured for this desktop app.
 * Yes: move to the cloud goes through the account mode. No (the user filled in another node themselves): the old
 * way, guarded by `server/recovery/relocation-preflight.mjs`.
 * Three cases are recognized: not filled in (default); the same host as the account cloud; the built-in default
 * hosted address and its sslip.io form (another entrance to the same node as the account cloud; account brief,
 * "Address of the online browser").
 */
export function isAccountCloudTarget(serviceUrl: string | null | undefined, accountOrigin: string, defaultHostedUrl: string): boolean {
  const text = String(serviceUrl ?? "").trim();
  if (!text) return true;
  const host = hostOf(text), account = hostOf(accountOrigin), builtin = hostOf(defaultHostedUrl);
  if (!host || !account) return false;
  if (host === account) return true;
  if (!builtin) return false;
  const name = (h: string) => h.replace(/:\d+$/, "");
  return name(host) === name(builtin) || name(host) === `${name(builtin).replaceAll(".", "-")}.sslip.io`;
}

/* ---------------- A move recorded locally (request ID) ---------------- */

/**
 * A move that is not yet finished. It is recorded only in this device's page storage (not in the project file or
 * the room record): deleted when done; after a failure, clicking again continues from it, using the same request ID
 * and the same placeholder content (the create endpoint is idempotent on the request ID, and different content is
 * rejected).
 */
export interface MoveAttempt {
  v: 1;
  accountId: string;
  /** The project ID in the local project file (`project.id`); it is also this in a collaboration room, not the room ID */
  contentId: string;
  requestId: string;
  name: string;
  stub: unknown;
  /** The cloud already replied with a project ID (created); none = the result of the last request is uncertain */
  projectId?: string;
  /**
   * Whether this create request carried the original local project ID (the project is still the same project after
   * moving up, 10-14 section 3.3). On an exact replay, send it or not accordingly;
   * if the original ID is already taken by another cloud project, switch to not sending it and start a new request ID,
   * and the cloud issues a new ID. Old records lack this field and count as not sent (that request did not send it)
   */
  keepId?: boolean;
  at: number;
}

/** Whether the original local project ID can be used directly as the cloud project ID (same shape as `projectIdOK` in `server/account/authority.mjs`) */
export const keepableProjectId = (id: string): boolean => /^(?:sp_[a-z2-7]{26}|[A-Za-z0-9_-]{8,64})$/.test(id);

export interface AttemptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const MOVE_ATTEMPTS_KEY = "pc.account.move";
/** A placeholder for "currently moving" (two windows on the same computer can see each other); the key is as above, the value is `{ owner, at }` */
export const MOVE_LOCKS_KEY = "pc.account.move.lock";
/** If the placeholder is not renewed for this long, that window counts as gone (renewed every `LOCK_BEAT_MS` while moving) */
export const LOCK_STALE_MS = 30_000;
export const LOCK_BEAT_MS = 5_000;
/** Local collaboration rooms closed when moving to the cloud (room ID → moment): an old file carrying these room links opens as an ordinary local project when reopened */
export const MOVED_ROOMS_KEY = "pc.account.moved-rooms";
const MOVED_ROOMS_KEEP = 200;

const attemptKey = (accountId: string, contentId: string) => `${accountId}|${contentId}`;

export function createAttemptStore(storage: AttemptStorage | null) {
  const readAll = (): Record<string, MoveAttempt> => {
    try {
      const value = JSON.parse(storage?.getItem(MOVE_ATTEMPTS_KEY) ?? "");
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, MoveAttempt> : {};
    } catch { return {}; }
  };
  const readJson = (key: string): Record<string, unknown> => {
    try {
      const value = JSON.parse(storage?.getItem(key) ?? "");
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch { return {}; }
  };
  const writeAll = (all: Record<string, MoveAttempt>) => {
    if (Object.keys(all).length) storage?.setItem(MOVE_ATTEMPTS_KEY, JSON.stringify(all));
    else storage?.removeItem(MOVE_ATTEMPTS_KEY);
  };
  const valid = (a: MoveAttempt | undefined, accountId: string, contentId: string): a is MoveAttempt =>
    !!a && a.v === 1 && a.accountId === accountId && a.contentId === contentId && typeof a.requestId === "string" && !!a.requestId &&
    typeof a.name === "string" && !!a.name && (a.projectId === undefined || keepableProjectId(a.projectId)) && Number.isFinite(a.at);
  return {
    get(accountId: string, contentId: string): MoveAttempt | null {
      const a = readAll()[attemptKey(accountId, contentId)];
      return valid(a, accountId, contentId) ? a : null;
    },
    /** A write failure (storage full, disabled) must be thrown: if the request ID cannot be remembered, the project should not be created */
    put(a: MoveAttempt): void {
      const all = readAll();
      all[attemptKey(a.accountId, a.contentId)] = a;
      writeAll(all);
      const back = readAll()[attemptKey(a.accountId, a.contentId)];
      if (!back || back.requestId !== a.requestId || back.projectId !== a.projectId) throw new Error(tr("The move record was not saved"));
    },
    /** Delete only this move's own record: if the request ID does not match (recorded later by another window), leave it alone */
    drop(accountId: string, contentId: string, requestId: string): void {
      const all = readAll();
      if (all[attemptKey(accountId, contentId)]?.requestId !== requestId) return;
      delete all[attemptKey(accountId, contentId)];
      try { writeAll(all); } catch { /* Cannot delete it: next time continue with the same project from it, so no extra one is created */ }
    },
    /**
     * Claim "this project is being moved" (if we already hold it, this renews it). Returns false if
     * another window holds it and it has not expired
     */
    lock(accountId: string, contentId: string, owner: string, at: number): boolean {
      const all = readJson(MOVE_LOCKS_KEY) as Record<string, { owner?: string; at?: number }>;
      const held = all[attemptKey(accountId, contentId)];
      if (held && held.owner !== owner && typeof held.at === "number" && at - held.at < LOCK_STALE_MS && at >= held.at) return false;
      all[attemptKey(accountId, contentId)] = { owner, at };
      try { storage?.setItem(MOVE_LOCKS_KEY, JSON.stringify(all)); } catch { /* Could not claim it: proceed as usual, records are kept separately per request ID */ }
      return true;
    },
    unlock(accountId: string, contentId: string, owner: string): void {
      const all = readJson(MOVE_LOCKS_KEY) as Record<string, { owner?: string }>;
      if (all[attemptKey(accountId, contentId)]?.owner !== owner) return;
      delete all[attemptKey(accountId, contentId)];
      try { if (Object.keys(all).length) storage?.setItem(MOVE_LOCKS_KEY, JSON.stringify(all)); else storage?.removeItem(MOVE_LOCKS_KEY); } catch { /* Expires on its own */ }
    },
    /** Record that "this local collaboration room was closed when moving to the cloud" */
    noteMovedRoom(roomId: string, at: number): void {
      const all = readJson(MOVED_ROOMS_KEY) as Record<string, number>;
      all[roomId] = at;
      const keep = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, MOVED_ROOMS_KEEP);
      try { storage?.setItem(MOVED_ROOMS_KEY, JSON.stringify(Object.fromEntries(keep))); } catch { /* Could not record it: such an old file shows "original room deleted" when reopened */ }
    },
    isMovedRoom(roomId: string): boolean {
      return typeof (readJson(MOVED_ROOMS_KEY) as Record<string, unknown>)[roomId] === "number";
    },
  };
}

export type AttemptStore = ReturnType<typeof createAttemptStore>;

/* ---------------- What the caller provides ---------------- */

export interface MoveSource {
  kind: "local" | "room";
  contentId: string;
  /** Collaboration room: whether this page entered as the creator */
  creator?: boolean;
  /** Collaboration room: room number */
  roomId?: string;
}

/** Failure of the account API: `status` 0 = could not connect */
export interface StatusError { status?: number; code?: string; message?: string }

export interface MoveDeps {
  /** What is open right now; null if it cannot be moved */
  source(): MoveSource | null;
  /** The currently logged-in account; null if not logged in; throws if unreachable */
  account(): Promise<{ id: string; name: string } | null>;
  /**
   * Create a cloud project; on failure throws an error carrying `status` / `code`. `extra`: the
   * original local project ID, history sequence number and commit digest (the moved project is
   * still the same project)
   */
  create(name: string, stub: unknown, requestId: string, extra?: { projectId?: string; rev?: number; history?: unknown[] }): Promise<{ projectId: string }>;
  /**
   * The local copy's current history sequence number and commit digest: read from the currently
   * connected local document connection (`rev` / `history` of `DocSync`); the cloud project keeps
   * counting up from this number (10-14 section 3.3). Returns null when no document connection is
   * attached (the cloud starts from 1)
   */
  lineage?(): { rev: number; history: unknown[] } | null;
  /** Wait until local edits settle, then return a copy of the project content; throws if that never happens */
  snapshot(): Promise<Project>;
  /** The project content in the editor right now (not copied, only used for comparison) */
  current(): Project;
  /** Write the content into the cloud project (root replace); throws on failure */
  upload(projectId: string, snapshot: Project): Promise<unknown>;
  /** Open a separate connection to read the cloud content back; throws on failure */
  read(projectId: string): Promise<Project>;
  /** Collaboration room: verify the creator password (read-only, changes nothing) */
  checkCreator?(password: string): Promise<{ ok: true } | { ok: false; error: "bad-password" | "rate-limited" | "network" }>;
  /** Collaboration room: fetch the media this computer lacks; `missing` is how many are still missing */
  pullMedia?(project: Project): Promise<{ ok: boolean; missing: number }>;
  /** Collaboration room: close local collaboration (delete the room); the editor returns to the local project */
  closeRoom?(password: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Save the local copy as it is now to a local file (without the room association). Local project:
   * save only if there is a draft. Collaboration room (just closed): it must be saved, creating a
   * new copy if there is no draft -- the room is already deleted, so this is the only complete
   * copy. Throws if it cannot be saved
   */
  saveLocal?(): Promise<void>;
  /**
   * Attach the editor to the cloud project. **Compare once more at the moment of switching**: if the
   * editor content or the content sent by the cloud differs from `snapshot` in any way, do not
   * switch and throw an error with `code: "content-changed"` (the flow uploads again and retries).
   * Other failures throw an error with `status`
   */
  enter(o: { projectId: string; name: string; snapshot: Project; kind: "local" | "room" }): Promise<void>;
  /** Hand the media referenced by the project to the upload queue; null if it cannot be handed over (the caller reports it and retries); does not throw */
  queueMedia(): Promise<MediaReport | null>;
  /** This window's ID (so two windows on the same computer moving the same project at once can recognize each other); a random one is used if not given */
  owner?: string;
  attempts: AttemptStore;
  newRequestId(): string;
  /** Placeholder content sent on creation: a complete blank project (the editor can open it) */
  stub(name: string, contentId: string): unknown;
  /** Project link */
  linkOf(projectId: string): string;
  onStage?(stage: MoveStage): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export interface MoveInput {
  /** Cloud project name (an attempt that was already created and is being continued reuses the name it was created with) */
  name: string;
  /** Collaboration room: creator password */
  creatorPassword?: string;
}

/** The local copy changed again during upload: maximum number of extra upload rounds */
export const MAX_CONTENT_ROUNDS = 3;
/** Entering the project failed (connection temporarily unavailable): maximum number of attempts */
export const ENTER_TRIES = 3;

const statusOf = (error: unknown): number | undefined => {
  const s = (error as StatusError | null)?.status;
  return typeof s === "number" ? s : undefined;
};
const codeOf = (error: unknown): string => String((error as StatusError | null)?.code ?? "");
const detailOf = (error: unknown): string => {
  const e = error as StatusError | null;
  return String(e?.code || e?.message || error || "").slice(0, 200);
};

/**
 * Failures of the create API where this request ID **definitely did not** create a project. Only
 * these cases count: name taken, name invalid, account not allowed to create (403), route missing,
 * app version outdated, original project ID already held by another cloud project --
 * all of them are rejected before anything is committed. Everything else is treated as "outcome
 * uncertain" and the request ID is kept: 401 too (the cloud first records the project and holds the
 * name, then checks the login again after initialization; if 401 is returned at that point the
 * project is already committed, see `createProject` in `server/account/authority.mjs`). If the
 * request ID were dropped, clicking again would report a duplicate name against a project we
 * cannot see.
 */
function createDefinitelyFailed(error: unknown): boolean {
  const kind = createErrorCode(error);
  return idTaken(error) || kind === "name-taken" || kind === "invalid-name" || kind === "create-refused" || kind === "not-account-cloud" || kind === "version-expired";
}

/** The cloud says the original project ID we brought is already held by another project (`project-id-taken`, 409) */
const idTaken = (error: unknown): boolean => codeOf(error) === "project-id-taken";

function createErrorCode(error: unknown): MoveErrorCode {
  const s = statusOf(error), code = codeOf(error);
  if (code === "version-expired") return "version-expired";
  if (s === 0 || code === "network") return "network";
  if (s === 401) return "login-required";
  if (code === "name-taken") return "name-taken";
  if (code === "invalid-name") return "invalid-name";
  if (s === 403) return "create-refused";
  if (s === 404 || s === 405 || s === 501 || code === "account-required" || code === "no-route" || code === "desktop-bridge-unavailable") return "not-account-cloud";
  return "create-failed";
}

/**
 * Move to the cloud. Does not throw: the result states which step it stopped at, whether local
 * collaboration was closed, and whether the cloud already has a created project.
 * Only one move runs per project at a time (other windows on the same computer count too); after
 * a mid-way failure, calling again continues with the request ID recorded locally.
 */
export async function moveToAccountCloud(deps: MoveDeps, input: MoveInput): Promise<MoveResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let stage: MoveStage = "check";
  let localClosed = false;
  let localSaved: boolean | undefined;
  let cloud: { projectId: string; name: string } | null = null;
  const at = (s: MoveStage) => { stage = s; deps.onStage?.(s); };
  const fail = (error: MoveErrorCode, detail?: string, extra: { retryAfter?: number | null } = {}): MoveResult =>
    ({ ok: false, error, stage, localClosed, ...(localClosed ? { localSaved: localSaved === true } : {}), cloud, ...(detail ? { detail } : {}), ...extra });

  /* 1 Verify */
  at("check");
  const source = deps.source();
  if (!source || !source.contentId) return fail("not-ready");
  let found: { id: string; name: string } | null;
  try { found = await deps.account(); }
  catch (error) { return fail(statusOf(error) === 401 ? "login-required" : "network", detailOf(error)); }
  if (!found) return fail("login-required");
  const account = found;
  const password = input.creatorPassword ?? "";
  if (source.kind === "room") {
    if (!source.creator) return fail("not-creator");
    if (!deps.checkCreator || !deps.closeRoom) return fail("not-ready");
    if (!password) return fail("creator-password");
    const checked = await deps.checkCreator(password);
    if (!checked.ok) return fail(checked.error);
  }
  // Only one move per project at a time: if another window is moving it, do nothing (do not touch
  // its record or the project it created)
  const owner = deps.owner ?? `w-${Math.random().toString(36).slice(2)}-${now()}`;
  if (!deps.attempts.lock(account.id, source.contentId, owner, now())) return fail("busy");
  const beat = setInterval(() => { deps.attempts.lock(account.id, source.contentId, owner, now()); }, LOCK_BEAT_MS);
  (beat as { unref?: () => void }).unref?.();
  try { return await run(); }
  finally { clearInterval(beat); deps.attempts.unlock(account.id, source.contentId, owner); }

  async function run(): Promise<MoveResult> {
    if (!source) return fail("not-ready");
    let snapshot: Project;
    try { snapshot = await deps.snapshot(); }
    catch (error) { return fail("save-pending", detailOf(error)); }
    const tooLarge = (p: Project) => JSON.stringify(p).length > MAX_CONTENT_CHARS;
    if (tooLarge(snapshot)) return fail("too-large", String(JSON.stringify(snapshot).length));

    /* 2 Create the project (or continue with the one created last time) */
    at("create");
    const name = input.name.trim();
    // Read the history sequence number and commit digest from the local document connection (read
    // after the snapshot: by then local edits have settled); the cloud keeps counting up from this number
    const lineage = deps.lineage?.() ?? null;
    const extraOf = (a: MoveAttempt) => ({
      ...(a.keepId === true ? { projectId: a.contentId } : {}),
      ...(lineage && Number.isSafeInteger(lineage.rev) && lineage.rev >= 1 ? { rev: lineage.rev, history: lineage.history } : {}),
    });
    const fresh = (keepId: boolean): MoveAttempt =>
      ({ v: 1, accountId: account.id, contentId: source.contentId, requestId: deps.newRequestId(), name, stub: deps.stub(name, source.contentId), keepId, at: now() });
    let idWasTaken = false;
    let attempt = deps.attempts.get(account.id, source.contentId);
    if (attempt && !attempt.projectId) {
      // The outcome of the last request is uncertain (no response received): first ask about it with the
      // identical request, to avoid creating another project under a new name.
      // The cloud's request ledger does not expire and replaying the identical request is always safe,
      // so this record has no expiry either
      try {
        const made = await deps.create(attempt.name, attempt.stub, attempt.requestId, extraOf(attempt));
        attempt = { ...attempt, projectId: made.projectId };
        deps.attempts.put(attempt);
      } catch (error) {
        if (!createDefinitelyFailed(error)) return fail(createErrorCode(error), detailOf(error));
        // That attempt really did not create anything: the record is void. If the name was not changed, or
        // the problem is not the name, report it to the user directly; if the name was changed, start over
        // with what was entered this time
        // (if the original project ID is held, start a new request below without the original ID)
        deps.attempts.drop(account.id, source.contentId, attempt.requestId);
        const kind = createErrorCode(error);
        idWasTaken = idTaken(error);
        if (!idWasTaken && (attempt.name === name || (kind !== "name-taken" && kind !== "invalid-name"))) return fail(kind, detailOf(error));
        attempt = null;
      }
    }
    if (!attempt) {
      if (!name || name.length > 200 || /[\u0000-\u001f]/.test(name)) return fail("invalid-name");
      // First create with the local original project ID (the moved project is still the same project);
      // if the original ID is already held by another cloud project (for example this file was saved as
      // a copy from that cloud project), let the cloud issue a new ID and create again -- the history
      // sequence number still continues counting up from the local one
      for (let keepId = keepableProjectId(source.contentId) && !idWasTaken; ; keepId = false) {
        attempt = fresh(keepId);
        // Record the request ID before sending the request: if the response is lost after sending, the
        // next attempt knows which request to ask about
        try { deps.attempts.put(attempt); } catch (error) { return fail("not-ready", detailOf(error)); }
        try {
          const made = await deps.create(attempt.name, attempt.stub, attempt.requestId, extraOf(attempt));
          attempt = { ...attempt, projectId: made.projectId };
          deps.attempts.put(attempt);
          break;
        } catch (error) {
          if (createDefinitelyFailed(error)) deps.attempts.drop(account.id, source.contentId, attempt.requestId);
          if (keepId && idTaken(error)) continue;
          return fail(createErrorCode(error), detailOf(error));
        }
      }
    }
    const made = attempt;
    const projectId = made.projectId!;
    cloud = { projectId, name: made.name };
    /** The cloud says this project is gone (deleted): the record is void, create it again next time */
    const goneCheck = (error: unknown) => { if (statusOf(error) === 404) deps.attempts.drop(account.id, source.contentId, made.requestId); };

    /* 3, 4 Upload the content, read it back and verify */
    const push = async (content: Project): Promise<MoveResult | null> => {
      at(localClosed ? "sync-last" : "upload");
      try { await deps.upload(projectId, content); }
      catch (error) {
        goneCheck(error);
        if (statusOf(error) === 401) return fail("login-required", detailOf(error));
        return fail(localClosed ? "sync-last-failed" : "upload-failed", detailOf(error));
      }
      if (!localClosed) at("verify");
      let back: Project;
      try { back = await deps.read(projectId); }
      catch (error) { goneCheck(error); return fail(localClosed ? "sync-last-failed" : "verify-failed", detailOf(error)); }
      if (!sameContent(back, content)) return fail(localClosed ? "sync-last-failed" : "verify-failed", "content-mismatch");
      return null;
    };
    // If the local copy changed in the meantime, do another round; if it is still changing after
    // several rounds (an Agent or tool is editing it), stop -- the local copy has not been touched, so
    // do not proceed
    for (let round = 1; ; round++) {
      const failed = await push(snapshot);
      if (failed) return failed;
      if (sameContent(deps.current(), snapshot)) break;
      if (round >= MAX_CONTENT_ROUNDS) return fail("busy-editing");
      try { snapshot = await deps.snapshot(); }
      catch (error) { return fail("save-pending", detailOf(error)); }
      if (tooLarge(snapshot)) return fail("too-large", String(JSON.stringify(snapshot).length));
    }

    /** The copy that was saved to the local file (object identity); if it is not the same as `snapshot`, it must be saved again */
    let savedFor: Project | null = null;
    const saveLocal = async () => {
      try { await deps.saveLocal?.(); localSaved = true; savedFor = snapshot; }
      catch { localSaved = false; savedFor = null; }
    };

    /* 5 Collaboration room: fetch media, close local collaboration; the first thing after closing is to save the current content locally */
    if (source.kind === "room") {
      if (deps.pullMedia) {
        at("pull-media");
        let pulled: { ok: boolean; missing: number };
        try { pulled = await deps.pullMedia(snapshot); } catch (error) { return fail("media-pull-failed", detailOf(error)); }
        if (!pulled.ok) return fail("media-pull-failed", String(pulled.missing));
      }
      at("close-local");
      // First record that "this room was closed when moving to the cloud": an old file that carries its
      // association and cannot be written back this time (the copy opened from elsewhere) is opened as a
      // normal local project when reopened
      if (source.roomId) deps.attempts.noteMovedRoom(source.roomId, now());
      let closed: { ok: true } | { ok: false; error: string };
      try { closed = await deps.closeRoom!(password); } catch (error) { closed = { ok: false, error: detailOf(error) }; }
      if (!closed.ok) return fail(closed.error === "forbidden" ? "bad-password" : closed.error === "rate-limited" ? "rate-limited" : "close-failed", closed.error);
      localClosed = true;
      await saveLocal();
      if (!sameContent(deps.current(), snapshot)) savedFor = null;
    }

    /* 6 Enter the project. Compare both before switching and at the moment of switching: if the local copy differs from what was verified with the cloud, upload the difference first and retry */
    let chases = 0;
    for (let tries = 1; ;) {
      if (!sameContent(deps.current(), snapshot)) {
        if (++chases > MAX_CONTENT_ROUNDS) return fail("busy-editing");
        try { snapshot = await deps.snapshot(); }
        catch (error) { return fail(localClosed ? "sync-last-failed" : "save-pending", detailOf(error)); }
        if (tooLarge(snapshot)) return fail("too-large", String(JSON.stringify(snapshot).length));
        // If local collaboration is already closed: save the local copy first, then upload the difference --
        // if the upload fails, the local copy is complete
        if (localClosed) await saveLocal();
        const failed = await push(snapshot);
        if (failed) return failed;
        continue;
      }
      // Save the local copy once as it looks now: after the move it is an ordinary local project
      if (savedFor !== snapshot) await saveLocal();
      at("enter");
      try { await deps.enter({ projectId, name: made.name, snapshot, kind: source.kind }); break; }
      catch (error) {
        if (codeOf(error) === "content-changed") {
          // The content did not match at the moment of switching (it was just changed again): no switch.
          // Go back up and upload the difference; stop if this happens several times in a row
          if (++chases > MAX_CONTENT_ROUNDS) return fail("busy-editing");
          continue;
        }
        const s = statusOf(error);
        goneCheck(error);
        if (s === 401 || s === 403 || s === 404 || tries >= ENTER_TRIES) return fail("enter-failed", detailOf(error));
        await sleep(1000 * tries);
        tries++;
      }
    }
    deps.attempts.drop(account.id, source.contentId, made.requestId);
    at("queue-media");
    let media: MediaReport | null = null;
    // null means it could not be handed over (upload channel not ready): the caller reports "upload has
    // not started yet" and retries until it is handed over
    try { media = await deps.queueMedia(); } catch { media = null; }
    at("done");
    return { ok: true, kind: source.kind, projectId, name: made.name, link: deps.linkOf(projectId), media };
  }
}

/* ---------------- Abandon this move ([ruling] H04, user decision, 2026-10-22) ---------------- */

/**
 * Criterion for a "half-finished move": the page storage of this device holds a move record
 * (`MoveAttempt`) for "the currently logged-in account + the currently open local project ID", and
 * the record **already has the project ID returned by the cloud** (the cloud really did create it).
 * This record is written only by the move flow (record the request ID first, then send the create
 * request, then add the project ID once returned), and is deleted after entering the project on a
 * successful move, so "record still present and carrying a project ID" = the last move to the cloud
 * created the cloud project but did not finish.
 * When the open one is a cloud project (something that cannot be moved), `source` is null and it
 * does not count; if the request outcome is uncertain (no project ID in the record) it does not
 * count either -- it is unknown whether the cloud created it.
 */
export function pendingAttempt(attempts: AttemptStore, accountId: string, source: MoveSource | null): (MoveAttempt & { projectId: string }) | null {
  if (!source?.contentId) return null;
  const a = attempts.get(accountId, source.contentId);
  return a?.projectId ? a as MoveAttempt & { projectId: string } : null;
}

export type AbandonErrorCode =
  /** What is open now is neither a local project nor a local collaboration room */
  | "not-ready"
  | "login-required"
  /** There is no half-finished move to abandon (the record is gone, or it is uncertain whether the cloud created it) */
  | "no-pending"
  /** This window or another window is moving this project */
  | "busy"
  /** The cloud says the current account is not the creator of that project */
  | "not-creator"
  /** That cloud project already has other members, or a device is connected: do not delete it as a half-finished move */
  | "in-use"
  /** Cannot reach the cloud; also this kind: the delete request was sent but the response was lost and a lookup finds nothing (clicking again is just as safe) */
  | "network"
  /** The cloud returned another error */
  | "delete-failed";

export type AbandonResult =
  | { ok: true; projectId: string; name: string; /** Before the click, that cloud project was already gone (only the local record was cleared) */ already: boolean }
  | { ok: false; error: AbandonErrorCode; name: string | null; detail?: string };

/** What that cloud project looks like right now (read from the account API `/hosted/shared/account/members`) */
export interface CloudProjectState {
  accessRevision: number;
  /** Whether the current account is its creator */
  creator: boolean;
  /** Number of members other than the creator */
  otherMembers: number;
  /** Number of devices connected to this project right now (including the creator's own other devices) */
  liveDevices: number;
}

export interface AbandonDeps {
  source(): MoveSource | null;
  /** The currently logged-in account; null if not logged in; throws if unreachable */
  account(): Promise<{ id: string; name: string } | null>;
  attempts: AttemptStore;
  /** Read what the cloud project looks like right now; throws 404 if the project is gone (`no-project` / `project-gone`) */
  inspect(projectId: string): Promise<CloudProjectState>;
  /** Delete the cloud project (`op: "delete"` of `/hosted/shared/account/admin`, the same API that "Delete project" uses) */
  remove(projectId: string, expectedAccessRevision: number, requestId: string): Promise<unknown>;
  /** Clear the association kept in this page's memory that points to this cloud project (the copy that gets written into the file on save-as, `recoveryAssociation.ts`) */
  forget?(projectId: string): void;
  newRequestId(): string;
  owner?: string;
  now?(): number;
}

/** The fields we need from the member snapshot returned by the account API `/hosted/shared/account/members` (`AccountMembersSnapshot` in `client.ts`) */
export interface MembersLike {
  accessRevision: number; creatorAccountId: string; self: { creator: boolean };
  members: { accountId: string }[]; devices: { conns: { role: string }[] }[];
}

/** Member snapshot → the fields needed to decide "is anyone using it". Only pages a person has open count as devices: the hosted side's render nodes and the Cloud Agent's connections follow the project and do not mean someone is using it */
export function cloudProjectStateOf(m: MembersLike): CloudProjectState {
  return { accessRevision: m.accessRevision, creator: m.self.creator,
    otherMembers: m.members.filter((x) => x.accountId !== m.creatorAccountId).length,
    liveDevices: m.devices.filter((d) => d.conns.some((c) => c.role === "page")).length };
}

/** The cloud confirms this project is gone (deleted, or never existed): only these two 404s from the account API count; `no-route` (a node not in account mode) does not */
const projectGone = (error: unknown): boolean => statusOf(error) === 404 && ["no-project", "project-gone"].includes(codeOf(error));

/** Member state had just changed at the moment of deletion (`access-revision-mismatch`): query again and then decide, at most this many rounds */
export const ABANDON_ROUNDS = 3;

/**
 * Abandon this move: delete the cloud project created by the last unfinished move to the cloud,
 * then clear the move record kept locally. Does not throw.
 *
 * - Uses only the `pendingAttempt` criterion; before deleting, ask the cloud once more: it must
 *   have been created by the current account, have no other members and no connected devices,
 *   otherwise it is not deleted (`in-use`).
 * - **Idempotent**: if the cloud no longer has the project (deleted earlier, or the response of
 *   this delete was lost) it counts as success and only the local record is cleared; repeated
 *   clicks and retries after a network drop never report an error.
 * - **Cloud first, local second**: the local record is deleted only once the cloud confirms it is
 *   gone; if the cloud delete did not succeed, the local record and local project stay untouched
 *   (the next "click again" can still continue the move as before).
 * - The local project file is untouched: when a move fails, the project file does not record this
 *   cloud project at all (the cloud association is recorded only after entering the cloud project
 *   succeeds, `enterAccountProject`).
 * - Shares the "this project is being moved" claim with the move: if another window is moving it,
 *   nothing is deleted.
 */
export async function abandonMove(deps: AbandonDeps): Promise<AbandonResult> {
  const now = deps.now ?? Date.now;
  const source = deps.source();
  if (!source?.contentId) return { ok: false, error: "not-ready", name: null };
  let account: { id: string; name: string } | null;
  try { account = await deps.account(); }
  catch (error) { return { ok: false, error: statusOf(error) === 401 ? "login-required" : "network", name: null, detail: detailOf(error) }; }
  if (!account) return { ok: false, error: "login-required", name: null };
  const attempt = pendingAttempt(deps.attempts, account.id, source);
  if (!attempt) return { ok: false, error: "no-pending", name: null };
  const { projectId, name } = attempt;
  const fail = (error: AbandonErrorCode, e?: unknown): AbandonResult => ({ ok: false, error, name, ...(e !== undefined ? { detail: detailOf(e) } : {}) });
  const failOf = (e: unknown): AbandonResult => {
    const s = statusOf(e);
    if (s === 401) return fail("login-required", e);
    if (s === 403) return fail("not-creator", e);
    return fail(s === 0 || codeOf(e) === "network" || codeOf(e) === "timeout" ? "network" : "delete-failed", e);
  };
  const finish = (already: boolean): AbandonResult => {
    // The cloud has confirmed it is gone: delete the local record (by request ID, only this one) and
    // also clear the association in this page's memory that points to it
    deps.attempts.drop(account!.id, source.contentId, attempt.requestId);
    deps.forget?.(projectId);
    return { ok: true, projectId, name, already };
  };
  const owner = deps.owner ?? `w-${Math.random().toString(36).slice(2)}-${now()}`;
  if (!deps.attempts.lock(account.id, source.contentId, owner, now())) return fail("busy");
  try {
    for (let round = 1; ; round++) {
      let state: CloudProjectState;
      try { state = await deps.inspect(projectId); }
      catch (error) { return projectGone(error) ? finish(true) : failOf(error); }
      if (!state.creator) return fail("not-creator");
      if (state.otherMembers > 0 || state.liveDevices > 0) return fail("in-use");
      try { await deps.remove(projectId, state.accessRevision, deps.newRequestId()); return finish(false); }
      catch (error) {
        if (projectGone(error)) return finish(true);
        // Member state changed between the lookup and the delete (someone joined, settings changed):
        // query again, and if someone joined, do not delete
        if (codeOf(error) === "access-revision-mismatch" && round < ABANDON_ROUNDS) continue;
        if (statusOf(error) === 401 || statusOf(error) === 403) return failOf(error);
        // Response lost, or cloud 5xx: it is uncertain whether the delete succeeded, so ask once more;
        // if it is reported gone, the delete succeeded
        try { await deps.inspect(projectId); }
        catch (again) { if (projectGone(again)) return finish(false); }
        return failOf(error);
      }
    }
  } finally { deps.attempts.unlock(account.id, source.contentId, owner); }
}

/* ---------------- Content upload and read-back (a real document connection) ---------------- */

export interface ContentLinkOptions {
  /** WebSocket address of the cloud document service (`wss://<account cloud>/hosted/`) */
  url: string;
  /** Get a connection ticket (once per session created; the access token behind it must last long enough) */
  ticket: () => Promise<string>;
  /** Maximum time to wait for the whole thing (only to prevent hangs) */
  timeoutMs?: number;
  WebSocketImpl?: unknown;
  /** For tests: get hold of this connection (cut the transport, drop the session) */
  onLink?: (link: SyncLink) => void;
}

export const CONTENT_TIMEOUT_MS = 180_000;

class ContentLinkError extends Error {
  status?: number;
  code: string;
  constructor(code: string, status?: number) { super(code); this.code = code; if (status !== undefined) this.status = status; }
}

let contentSeq = 0;

/** Open a document connection used only for this move and close it when done. Inside `run`, wait for conditions with `until`; a refused connection, a timeout, or a rejected commit makes the whole thing fail */
async function withContentLink<T>(o: ContentLinkOptions, projectId: string, initial: Project,
  run: (link: SyncLink, until: (check: () => boolean) => Promise<void>) => Promise<T>): Promise<T> {
  let kill!: (error: unknown) => void;
  let dead: unknown = null;
  const died = new Promise<never>((_, reject) => { kill = (error) => { if (!dead) { dead = error; reject(error); } }; });
  died.catch(() => undefined);
  const rand = (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 10);
  const link: SyncLink = new SyncLink({
    url: o.url, projectId, session: `move-${++contentSeq}-${rand}`, initial, initialize: false,
    protocols: async () => ["promptcut.v1", `promptcut.account.${await o.ticket()}`],
    // A close code is not final (4003 on an account connection is also used for permission changes);
    // whether to reconnect is up to the ticket endpoint
    isFatalClose: () => false,
    onProtocolError: (error) => {
      const s = statusOf(error);
      if (s === 401 || s === 403 || s === 404) { kill(new ContentLinkError(codeOf(error) || "refused", s)); return true; }
      return false;
    },
    // The access token behind this connection expired: treat it as a disconnect, rebuild the session with
    // a new ticket, and resend unconfirmed commits on the new session
    onAuthExpired: () => link.expire(),
    ...(o.WebSocketImpl ? { WebSocketImpl: o.WebSocketImpl as never } : {}),
  });
  const offNotice = link.ds.on("notice", (n) => {
    if (n.kind === "rejected") kill(new ContentLinkError(`rejected:${n.reason}`));
    else if (n.kind === "replay-dropped") kill(new ContentLinkError("replay-dropped"));
  });
  const offStatus = link.ds.on("status", (s) => { if (s === "paused") kill(new ContentLinkError("paused")); });
  const timer = setTimeout(() => kill(new ContentLinkError("timeout")), o.timeoutMs ?? CONTENT_TIMEOUT_MS);
  const until = async (check: () => boolean) => {
    while (!check()) {
      if (dead) throw dead;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  link.start();
  o.onLink?.(link);
  try { return await Promise.race([run(link, until), died]); }
  finally { clearTimeout(timer); offNotice(); offStatus(); link.stop(); }
}

const linkReady = (link: SyncLink) => link.ds.confirmedProject !== null && link.ds.status === "online";

/**
 * Write `snapshot` as the content of the cloud project: connect, fetch the cloud's current content, and if it
 * differs do one root replace (large ones are uploaded in chunks by `DocSync`), then wait for the document
 * service to confirm. If the cloud already has this content (the last upload got through but was not verified
 * in time), send nothing.
 */
export async function uploadProjectContent(o: ContentLinkOptions, projectId: string, snapshot: Project): Promise<{ rev: number; wrote: boolean }> {
  return withContentLink(o, projectId, snapshot, async (link, until) => {
    await until(() => linkReady(link));
    let wrote = false;
    if (!sameContent(link.ds.confirmedProject, snapshot)) {
      wrote = true;
      link.ds.load(snapshot);
      await until(() => link.ds.unconfirmed === 0 && linkReady(link));
    }
    if (!sameContent(link.ds.confirmedProject, snapshot)) throw new ContentLinkError("not-landed");
    return { rev: link.ds.rev, wrote };
  });
}

/** Open a separate connection and read the cloud project's current content back (for verification: this copy comes from the document service, not computed on this side) */
export async function readProjectContent(o: ContentLinkOptions, projectId: string, placeholder: Project): Promise<{ project: Project; rev: number }> {
  return withContentLink(o, projectId, placeholder, async (link, until) => {
    await until(() => linkReady(link));
    return { project: link.ds.confirmedProject!, rev: link.ds.rev };
  });
}

/* ---------------- User-facing text (draft, pending user review; the table is in the report) ---------------- */

export const ACCOUNT_MOVE_TEXT = {
  /** Note above the form when "Put in the cloud" is chosen in settings and the target is the account cloud */
  intro: tr("A cloud project belongs to your website account. After you click \"OK\", the current project is moved to the cloud and the editor continues in the cloud project; the local copy stays as a regular local project."),
  loggedIn: (name: string) => tr("Logged in: {0}", name),
  checkingLogin: tr("Checking login status…"),
  needLogin: tr("You need to log in to your website account before moving to the cloud."),
  loginButton: tr("Log in"),
  loginBusy: tr("Logging in…"),
  nameLabel: tr("Cloud project name"),
  /** The last move did not finish and the cloud project is already created: click "OK" again to continue */
  pending: (name: string) => tr("The last move to the cloud was not finished, and the cloud project \"{0}\" has already been created. Click \"OK\" to continue; no extra project will be created.", name),
  /** Confirmation dialog when "Move to the cloud" is clicked in a collaboration room */
  roomConfirm: (account: string) => tr("After the move, a new project belonging to the account \"{0}\" will be created in the cloud with the same content as now.\nLocal collaboration will be closed and the old invite code will be void. Existing members must rejoin using the new project link and their own website accounts.\nMove to the cloud?", account),
  stage: {
    check: tr("Moving to the cloud: checking login and project…"),
    create: tr("Moving to the cloud: creating the cloud project…"),
    upload: tr("Moving to the cloud: uploading project content…"),
    verify: tr("Moving to the cloud: verifying cloud content…"),
    "pull-media": tr("Moving to the cloud: pulling media to this computer…"),
    "close-local": tr("Moving to the cloud: closing local collaboration…"),
    "sync-last": tr("Moving to the cloud: uploading the last changes…"),
    enter: tr("Moving to the cloud: entering the cloud project…"),
    "queue-media": tr("Moving to the cloud: scheduling media uploads…"),
    done: tr("Moving to the cloud: finishing up…"),
  } as Record<MoveStage, string>,
  doneLocal: tr("Moved to the cloud. You are now editing the cloud project. The local copy stays as a regular local project."),
  doneRoom: tr("Moved to the cloud. Local collaboration is closed, the old invite code is void, and the old ban list was not carried over. Send the new project link to the existing members; they can join after logging in to their own website accounts."),
  /** Bubble shown after the move (with a "Copy project link" button) */
  toastLocal: tr("Moved to the cloud. You can send the project link to other logged-in members."),
  toastRoom: tr("Moved to the cloud. Local collaboration is closed, the old invite code is void, and the old ban list was not carried over. Send the new project link to the existing members."),
  copyLink: tr("Copy project link"),
  uploading: (n: number) => tr("Media is still uploading in the background ({0} in total, including card audio; small sizes first, then original sizes). Until it finishes, other members see placeholders.", n),
  uploaded: tr("Media and card source code have all been uploaded to the cloud."),
  uploadedWithMissing: (n: number) => tr("Upload finished, but {0} media files could not be found on this computer and were not uploaded, so other members cannot see them.", n),
  mediaNotQueued: tr("Media has not started uploading (the upload channel is not ready yet) and is being retried automatically. Until it is uploaded, other members see placeholders."),
  mediaRetrying: tr("Media upload failed and is being retried automatically, until it succeeds."),
  cardsUploading: tr("Card source code is still syncing to the cloud."),
  cardsStuck: tr("Card source code has not synced to the cloud yet (card sync is not connected), so other members cannot draw custom cards for now. It will be uploaded automatically once connected."),
  /** An old file carries the link to the room that was closed when moving to the cloud: when reopened it opens as a plain local project, with a notice shown once */
  reopenedLocal: tr("This file's original local collaboration was closed when it was moved to the cloud. It is now opened as a regular local project."),
  versionExpired: tr("This app version has expired and cannot move to the cloud"),
  /* Abandon this move ([ruling] H04) */
  /** The line shown when there is an unfinished cloud project but settings is not on the "Cloud" form (on the form it is `pending`) */
  pendingIdle: (name: string, room: boolean) => tr("The last move to the cloud was not finished, and the cloud project \"{0}\" has already been created. {1}; if you no longer want to move, you can abandon this move.", name, room ? tr("Click \"Move to cloud\" to continue") : tr("Check \"Multi-user collaboration\", choose cloud, and click \"OK\" to continue")),
  abandonButton: tr("Abandon this move"),
  abandonConfirm: (name: string) => tr("Abandoning this move will permanently delete the cloud project \"{0}\" (the one created when the last move to the cloud was not finished). Deleted cloud content cannot be recovered. The local project is not affected and can be edited and saved as usual; you can move it to the cloud again later.", name),
  abandonConfirmButton: tr("Delete cloud project"),
  abandonCancel: tr("Don't abandon"),
  abandoning: (name: string) => tr("Deleting cloud project \"{0}\"…", name),
  abandoned: (name: string) => tr("Abandoned this move: the cloud project \"{0}\" was deleted. The local project was not changed.", name),
  abandonedAlready: (name: string) => tr("Abandoned this move: the cloud project \"{0}\" no longer exists, and the local move record has been cleared. The local project was not changed.", name),
} as const;

/** The sentence shown when abandoning this move fails: states clearly what the cloud project and the local project look like now */
export function abandonFailureText(r: Extract<AbandonResult, { ok: false }>): string {
  const what = r.name ? tr("Cloud project \"{0}\"", r.name) : tr("Cloud project");
  const kept = tr("{0} and the local project were both left unchanged.", what);
  switch (r.error) {
    case "not-ready": return tr("The open project is not a local project, so there is no move to abandon.");
    case "login-required": return tr("Deleting the cloud project requires logging in to the website account first (the account that was used for the move).");
    case "no-pending": return tr("There is no unfinished cloud project to abandon.");
    case "busy": return tr("Another window is moving this project. Try again when it finishes.");
    case "not-creator": return tr("The account currently logged in is not the creator of {0}, so it cannot be deleted. {1}", what, kept);
    case "in-use": return tr("Other members have joined {0}, or a device has it open, so it is not treated as an unfinished project and will not be deleted. {1}", what, kept);
    case "network": return tr("Could not reach the cloud, so deletion of {0} was not confirmed. The local project is unchanged; click again later, and anything already deleted will not cause an error.", what);
    case "delete-failed": return tr("The cloud is temporarily unavailable, so {0} could not be deleted ({1}). The local project is unchanged; click again later.", what, r.detail || tr("unknown reason"));
  }
}

const unchanged = (kind: "local" | "room") => (kind === "room" ? tr("Local collaboration is unchanged, and the original room works as before.") : tr("The local project is unchanged."));
const resume = tr("Clicking again will continue with the cloud project that was already created, without creating another one.");
/** Failure after local collaboration was already closed: what is open now is a local project, and the entry point is "Multi-user collaboration → Cloud" in settings */
const again = tr("In project settings, check \"Multi-user collaboration\", choose cloud, and click \"OK\". This will continue with the cloud project that was already created, without creating another one.");

/** Failure after local collaboration was already closed: whether the current content was saved to a local file */
const savedNote = (r: Extract<MoveResult, { ok: false }>) => (r.localSaved === false
  ? tr("The latest content is still in this window and could not be saved to the local file. Please save manually first.")
  : tr("The latest content is already saved in this local file."));

/** The sentence shown to the user on failure: states clearly where it stopped and what state the local side is in */
export function moveFailureText(r: Extract<MoveResult, { ok: false }>, kind: "local" | "room"): string {
  const local = unchanged(kind);
  switch (r.error) {
    case "login-required": return ACCOUNT_MOVE_TEXT.needLogin;
    case "not-ready": return tr("Cannot move to the cloud yet (the project or collaboration identity is not ready). {0}", local);
    case "not-creator": return tr("Only the person who entered as the creator can move the collaboration room to the cloud.");
    case "creator-password": return tr("The creator password is required to move to the cloud (local collaboration will be closed after the move).");
    case "bad-password": return r.localClosed ? tr("Wrong password.") : tr("Wrong password. {0}", local);
    case "rate-limited": return tr("Too many attempts. Wait 60 seconds and try again. {0}", local);
    case "busy": return tr("Another window is moving this project. Try again when it finishes.");
    case "busy-editing": return r.localClosed
      ? tr("The project kept being modified (an Agent or tool may still be changing it), and the last changes were not caught up. Local collaboration is closed. {0} Stop it first, then move again: {1}", savedNote(r), again)
      : tr("The project kept being modified during the move (an Agent or tool may still be changing it), so the move did not complete. {0} Stop it first, then click again. {1}", local, r.cloud ? resume : tr("No extra project will be created."));
    case "save-pending": return tr("Local changes have not finished saving, so the move did not start. {0}", local);
    case "too-large": return tr("The project content is too large (about {0} million characters, limit {1} million), so it cannot be moved to the cloud for now. {2}", (Number(r.detail) / 1_000_000 || 0).toFixed(1), (MAX_CONTENT_CHARS / 1_000_000).toFixed(1), local);
    case "name-taken": return tr("This project name is already taken. Please choose another name. {0}", local);
    case "invalid-name": return tr("The project name cannot be empty or longer than 200 characters. {0}", local);
    case "create-refused": return tr("This account cannot create a cloud project right now ({0}). {1}", r.detail || tr("rejected"), local);
    case "version-expired": return ACCOUNT_MOVE_TEXT.versionExpired;
    case "not-account-cloud": return tr("This cloud does not accept projects from website accounts, so nothing was moved. {0}", local);
    case "network": return r.stage === "create" ? tr("Could not reach the cloud, so the cloud project was not created. {0} Click again later.", local) : tr("Could not reach the cloud, so the move did not start. {0}", local);
    case "create-failed": return tr("The cloud is temporarily unavailable, so the cloud project was not created. {0} Click again later; no extra project will be created.", local);
    case "upload-failed": return tr("The project content was not fully uploaded. {0} {1}", local, resume);
    case "verify-failed": return tr("The cloud content check failed, so the move was stopped. {0} {1}", local, resume);
    case "media-pull-failed": return tr("{0} media items have not been pulled to this computer yet, so local collaboration was not closed. {1} Click again after the media has finished pulling.", Number(r.detail) || tr("Some"), local);
    case "close-failed": return tr("The cloud project has been created and verified, but local collaboration was not closed and it is still the original room. {0}", resume);
    case "sync-last-failed": return tr("Local collaboration is closed. {0} The cloud project has been created, but the last few changes are missing. Sync them again: {1}", savedNote(r), again);
    case "enter-failed": return tr("Moved to the cloud{0}, but could not enter the cloud project \"{1}\" this time. {2} You can also go back to the start page and open it with the project link.", r.localClosed ? tr(", local collaboration closed") : "", r.cloud?.name ?? "", again);
  }
}
