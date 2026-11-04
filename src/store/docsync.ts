/**
 * Sync layer from page to document service (c65-design.md sections 4, 6, and 8).
 *
 * One DocSync instance = one replica of a project for a page session. It knows neither store
 * nor network:
 *   - Outgoing messages use `send` injected at construction; incoming messages are handed in
 *     by the connecting side calling `receive(msg)`;
 *   - Connecting / disconnecting is communicated by the connecting side calling `connect()` /
 *     `disconnect()`;
 *   - When the local replica changes, it emits a `project` event, and the side connected to
 *     the store (`bindStore`) writes it into state.
 * Tests use an in-memory mock as the document service; real connections are wired in later branches.
 *
 * Data flow:
 *   - Local modifications: `commit(next)` computes `diffProject(local, next)`, lands locally first
 *     (optimistically), enters the pending confirmation queue, and submits `project.op` in order.
 *     What is stored locally is the result of `applyOps(local, ops)` rather than next itself,
 *     so that even the order of keys matches between the local replica and the document service
 *     replica.
 *   - Others' `project.ops`: applied to the "confirmed replica", then unconfirmed local operations
 *     are replayed to get the local replica. This is the "revert - apply remote - replay" from the
 *     design spec, except reverting does not rely on inverse operations but replays directly from
 *     the confirmed replica, producing a result byte-for-byte identical with the document service
 *     order (remote first, then local).
 *   - Offline: operations land and enter the queue as normal; upon reconnecting, the first carries
 *     `expectRev: offlineRev`, and if accepted, the rest are sent in sequence; if rejected (stale),
 *     the whole batch pauses (status = "paused"), waiting for `replayOffline()` or
 *     `discardOffline()`.
 *   - `.proc` save: `whenSettled()` waits until all local operations receive ok.
 *   - Undo: one stack per instance; undo = submit inverse operations (with undoOf); entities
 *     modified by another write identity after this step are not reverted.
 */
import {
  applyOps,
  diffProject,
  entitiesOf,
  entitiesOverlap,
  entityValuePath,
  getAt,
  type PathOp,
} from "../kernel/diffProject";
import { relocateOps, undoEntitiesOf, undoEntityOfOp } from "../kernel/cutPaths";
import type { Project } from "../kernel/project";
import { attachProjectSync, set, state } from "./core";
import { pageStateAfterRemote } from "./remotePageState";
import { tr } from "../i18n/index.ts";

/* ---------------- Messages ---------------- */

/** Write identity: actor comes from connection credentials (filled by document service), session is a page session or Agent chat number */
export interface Writer {
  actor?: unknown;
  session?: string;
}

export interface OpenMsg {
  type: "project.open";
  projectId: string;
}

/** An operation on the wire: added a root replacement variant that "references a whole project uploaded in chunks" (`project.upload`, c65-design.md section 13) */
export type WireOp = PathOp | { op: "set"; path: ""; upload: string };

export interface OpMsg {
  type: "project.op";
  projectId: string;
  opId: string;
  session: string;
  ops: WireOp[];
  expectRev?: number;
  undoOf?: string;
}

/** Chunked upload for large root replacements (document service `project.upload`): once all parts are received, referenced by `project.op`'s `{ op: 'set', path: '', upload }` */
export interface UploadMsg {
  type: "project.upload";
  projectId: string;
  uploadId: string;
  index: number;
  count: number;
  data: string;
}

export type ClientMsg = OpenMsg | OpMsg | UploadMsg;

export interface StateMsg {
  type: "project.state";
  projectId?: string;
  rev: number;
  /** Large projects do not include project, but include parts (chunk count), followed by project.state.part / project.state.end */
  project?: Project | null;
  parts?: number;
  writers?: unknown;
}

export interface StatePartMsg {
  type: "project.state.part";
  projectId?: string;
  rev: number;
  index: number;
  count: number;
  data: string;
}

export interface StateEndMsg {
  type: "project.state.end";
  projectId?: string;
  rev: number;
  digest?: string;
}

export interface OkMsg {
  type: "project.op.ok";
  opId: string;
  rev: number;
  overwrote?: { entity: string; by: Writer }[];
}

export interface SinceEntry {
  rev: number;
  actor?: unknown;
  session?: string;
  paths?: string[];
}

export interface RejectedMsg {
  type: "project.op.rejected";
  opId: string;
  reason: "stale" | "bad-path" | "too-large" | "forbidden" | string;
  currentRev?: number;
  since?: SinceEntry[];
}

export interface OpsMsg {
  type: "project.ops";
  rev: number;
  opId: string;
  /** Large root replacements referencing uploads do not carry ops when broadcast, but carry resync: true, and the page re-opens */
  ops?: PathOp[];
  resync?: boolean;
  actor?: unknown;
  session?: string;
  undoOf?: string;
}

export interface OverwrittenMsg {
  type: "project.overwritten";
  entity: string;
  by: Writer;
  rev: number;
}

export type ServerMsg = StateMsg | StatePartMsg | StateEndMsg | OkMsg | RejectedMsg | OpsMsg | OverwrittenMsg;

/* ---------------- External state and notifications ---------------- */

/**
 * idle: not connected yet; connecting: sent open and waiting for project.state; online: normal;
 * offline: disconnected, operations queued; paused: first item of offline batch was rejected,
 * waiting for user to choose "replay / discard"
 */
export type SyncStatus = "idle" | "connecting" | "online" | "offline" | "paused";

export interface SkippedEntity {
  entity: string;
  /** The write identity that modified it after this step (the most recent one) */
  by: Writer;
}

export interface UndoResult {
  /** At least one change was reverted */
  done: boolean;
  /** Entities not reverted because another write identity modified them later */
  skipped: SkippedEntity[];
  /** Entities not reverted because inverse operations could not be applied (e.g. parent already deleted) */
  failed: string[];
  /** The opId submitted by this undo / redo; absent when done is false */
  opId?: string;
  /**
   * Materials passed to the "conflict merge" window for items not reverted because someone else
   * modified them later (`skipped`) (user decision, 2026-10-18, wired in 0.7.20):
   * `landed` is the project after that step landed; `reverted` is the project after reverting only
   * those items on top of it. The UI compares item by item across modified items (`diffThings`
   * in `mergeItems.ts`): the baseline is `landed` (expected to still be on the cloud), and my side
   * is `reverted`. Absent when the state after that step landed is unknown (reverting someone else's
   * step where this page did not see it land directly).
   */
  conflict?: { landed: Project; reverted: Project };
}

export type SyncNotice =
  | { kind: "rejected"; opId: string; reason: string }
  | { kind: "replay-dropped"; opId: string; detail: string }
  | { kind: "overwrote"; opId: string; entities: { entity: string; by: Writer }[] }
  | { kind: "overwritten"; entity: string; by: Writer; rev: number }
  | { kind: "undo"; redo: boolean; result: UndoResult }
  | { kind: "resync"; reason: string }
  /** A change by someone else landed on the local replica (used for 1.5 s timeline outline) */
  | { kind: "remote"; rev: number; opId: string; entities: string[]; by: Writer; undoOf?: string }
  /** AI panel "Undo this step": reverts that commit made by someone else (Agent) */
  | { kind: "revert-remote"; of: string; result: UndoResult };

/** Local backup: overwritten entities, or discarded offline batches. Persisted to disk by the connecting side (backups/ under the draft directory) */
export type LocalBackup =
  | { kind: "overwritten"; projectId: string; entity: string; by: Writer; rev: number; value: unknown; at: number }
  | { kind: "offline-discard"; projectId: string; baseRev: number; batch: { opId: string; ops: PathOp[] }[]; project: Project; at: number };

export interface PausedInfo {
  /** Version recorded when offline */
  offlineRev: number;
  /** Current version in the document service */
  currentRev?: number;
  /** Changes landed by others while offline */
  since?: SinceEntry[];
  /** Number of queued unsent local operations */
  queued: number;
}

/**
 * Summary of a commit seen landed by this page (own commit receiving ok, others' receiving
 * project.ops), matching the shape of an entry in document service history (commit summary in
 * `server/docservice/modules/project.mjs`). "Move to the cloud" carries it up along with its
 * history sequence number (read by `history`).
 */
export interface CommitSummary {
  rev: number;
  opId: string;
  /** null for own commits (write identity is determined by document service per connection; this page does not know the original) */
  actor: unknown;
  at: number;
  paths: string[];
  entities: string[];
}

export interface CommitOptions {
  /** false: does not enter undo stack (asset metadata backfill, total duration tracking, etc.) */
  undoable?: boolean;
  /** Commits with the same key within the merge window are merged into a single step on the undo stack (single slider drag, continuous number box stepping) */
  mergeKey?: string;
  /** Merge window (ms, rolling forward from the last merge); defaults to `MERGE_WINDOW_MS` if omitted; `Infinity` = match key only */
  mergeWindowMs?: number;
}

export interface DocSyncOptions {
  /** Only explicit creation may initialize an empty service room. */
  initialize?: boolean;
  projectId: string;
  /** ID of this page session, written into each commit */
  session: string;
  send: (msg: ClientMsg) => void;
  newOpId?: () => string;
  now?: () => number;
  saveBackup?: (backup: LocalBackup) => void;
}

/* ---------------- Internal ---------------- */

interface Pending {
  opId: string;
  ops: PathOp[];
  inverse: PathOp[];
  undoOf?: string;
  sent: boolean;
  /** Received ok but not yet merged into confirmed replica (while waiting for project.state) */
  ackRev?: number;
  /** Sent, but failed to replay on the latest confirmed replica: the document service side will also reject it */
  brokenLocally?: boolean;
}

interface Step {
  opIds: string[];
  /** Operations to apply to undo this step (in order) */
  inverse: PathOp[];
  entities: string[];
  /** Version when the first commit of this step landed; undefined if not yet confirmed */
  rev?: number;
  mergeKey?: string;
  lastAt: number;
  /** Local replica after this step landed (passed to the "conflict merge" window as baseline when undo encounters conflicts; project objects are not mutated in place, storing reference without copying) */
  after?: Project;
}

interface RemoteWrite {
  rev: number;
  opId: string;
  by: Writer;
  entities: string[];
}

/** Confirmed commits from this page (when AI panel reverts that Agent step, own later modifications must also be blocked) */
interface LocalWrite {
  rev: number;
  entities: string[];
}

/** Materials required to revert another's commit (AI panel "Undo this step"): that commit's opId and inverse operations, plus the version number it landed at if known */
export interface RemoteStep {
  opId: string;
  /** If omitted, uses inverse operations computed by this page when receiving that commit; cannot revert if neither has them */
  inverse?: PathOp[];
  /** Version number at which that commit landed; if omitted, looked up from project.ops received by this page */
  rev?: number;
  /** Write identity of that commit; if omitted, looked up from project.ops received by this page (if not found, any subsequent remote write is considered someone else) */
  by?: Writer;
}

type Events = {
  /**
   * Local replica replaced. `commit` / `load` are initiated by the store itself (setProject /
   * loadProject), where callers use the return value to write state; the rest are not initiated
   * via store, and the side connected to store must write it into state. `revert-remote` is AI panel
   * "Undo this step" (`revertRemote`): submitted with this page's identity, but without going
   * through setProject, so it cannot count as `commit`.
   */
  project: (project: Project, cause: "commit" | "remote" | "state" | "rejected" | "undo" | "redo" | "revert-remote" | "discard" | "replay" | "load") => void;
  status: (status: SyncStatus) => void;
  notice: (notice: SyncNotice) => void;
};

export const UNDO_LIMIT = 100;
/** How many opIds of commits sent by this page to record (`opIdsSince`) */
const OWN_OPS_KEEP = 1000;
export const MERGE_WINDOW_MS = 300;
/** Upper limit on serialized ops for a single document service commit (`PROJECT_LIMITS.MAX_OPS_BYTES`): if exceeded, switch to root replacement and use chunked upload */
export const MAX_OPS_BYTES = 256 * 1024;
/** Character count per chunk in chunked upload: worst case UTF-8 is 4 bytes / char, 128 Ki chars does not exceed document service 512 KiB per-chunk limit */
export const UPLOAD_PART_CHARS = 128 * 1024;
/** Document service `UPLOAD_MAX_PARTS` */
export const UPLOAD_MAX_PARTS = 64;

/** Byte count of text in UTF-8; returns character count directly when short enough that exceeding the limit is impossible, saving an encoding step */
const utf8Bytes = (text: string): number => {
  if (text.length * 3 <= MAX_OPS_BYTES) return text.length;
  return new TextEncoder().encode(text).length;
};
const BEFORE_REMOTE_KEEP = 32;
/** How many Agent commit inverse operations to record */
const REMOTE_INVERSE_KEEP = 200;
/** How many commit summaries to record (matches document service `PROJECT_LIMITS.HISTORY`) */
const COMMIT_LOG_KEEP = 1000;
/** Maximum number of paths recorded in one summary (document service `capPaths` also only retains a subset) */
const COMMIT_PATHS_KEEP = 32;

let opSeq = 0;
function defaultOpId(session: string): string {
  opSeq++;
  const rand = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${session}:${Date.now().toString(36)}:${opSeq.toString(36)}:${rand}`;
}

export class DocSync {
  readonly projectId: string;
  readonly session: string;
  private readonly sendMsg: (msg: ClientMsg) => void;
  private readonly newOpId: () => string;
  private readonly now: () => number;
  private readonly saveBackup?: (backup: LocalBackup) => void;
  private readonly initialize: boolean;

  private local: Project;
  private confirmed: Project | null = null;
  private confirmedRev = 0;
  private pending: Pending[] = [];

  private connected = false;
  private awaitingState = false;
  /** Last known version upon disconnect; null when there is no offline batch */
  private offlineRev: number | null = null;
  /** The first item of the offline batch has been sent and is awaiting response; during this time, the rest are not sent */
  private gateOpId: string | null = null;
  private paused: PausedInfo | null = null;

  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private stepOf = new Map<string, Step>();
  private remoteWrites: RemoteWrite[] = [];
  private localWrites: LocalWrite[] = [];
  /** Agent commit opId → version number it landed at and inverse operations (computed on confirmed replica from received project.ops) */
  private remoteInverses = new Map<string, { rev: number; inverse: PathOp[]; after?: Project }>();
  /** rev → local replica before applying this remote modification, used for overwrite backup */
  private beforeRemote = new Map<number, Project>();
  /** Commit summaries seen landed by this page (in ascending history sequence number order; read by `history`) */
  private commitLog: CommitSummary[] = [];

  private listeners: { [K in keyof Events]: Set<Events[K]> } = { project: new Set(), status: new Set(), notice: new Set() };
  private settleWaiters: { resolve: (v: { rev: number; project: Project }) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }[] = [];

  constructor(initial: Project, opts: DocSyncOptions) {
    this.local = initial;
    this.projectId = opts.projectId;
    this.session = opts.session;
    this.sendMsg = opts.send;
    this.newOpId = opts.newOpId ?? (() => defaultOpId(opts.session));
    this.now = opts.now ?? (() => Date.now());
    this.saveBackup = opts.saveBackup;
    this.initialize = opts.initialize !== false;
  }

  /* ---------- Read ---------- */

  get project(): Project {
    return this.local;
  }

  /** Version number confirmed by document service */
  get rev(): number {
    return this.confirmedRev;
  }

  /**
   * The version of the project confirmed by document service (the `rev` version; returns null
   * if none yet). Read-only: browser-only nodes retain it by version number when publishing
   * manifest plans (M7 contract D6: fine-grained task execution uses the task's `projectRev`
   * version), without modifying it.
   */
  get confirmedProject(): Project | null {
    return this.confirmed;
  }

  /**
   * Commit summaries seen landed by this page (ascending history sequence numbers, at most
   * `COMMIT_LOG_KEEP` entries; copy, read-only). Contains only those confirmed since this connection
   * was opened: earlier entries reside in document service's own history. "Move to the cloud"
   * carries them up together with `rev`; cloud project history sequence numbers and summaries
   * continue recording from this local copy.
   */
  get history(): CommitSummary[] {
    return this.commitLog.map((c) => ({ ...c, paths: [...c.paths], entities: [...c.entities] }));
  }

  private noteCommit(rev: number, opId: string, actor: unknown, ops: { path: string }[], entities: string[]) {
    const last = this.commitLog[this.commitLog.length - 1];
    if (last && last.rev >= rev) return;
    this.commitLog.push({ rev, opId, actor: actor ?? null, at: this.now(), paths: ops.slice(0, COMMIT_PATHS_KEEP).map((o) => o.path), entities: entities.slice(0, 64) });
    if (this.commitLog.length > COMMIT_LOG_KEEP) this.commitLog.splice(0, this.commitLog.length - COMMIT_LOG_KEEP);
  }

  /** Device-owned crash recovery, never used as a root replacement on normal reentry. */
  recoveryJournal() {
    return { version: 1, projectId: this.projectId, project: this.local, rev: this.confirmedRev,
      offlineRev: this.offlineRev, pending: this.pending.map(p => ({ ...p, sent: false })) };
  }

  restoreJournal(journal: ReturnType<DocSync["recoveryJournal"]>) {
    if (journal.version !== 1 || journal.projectId !== this.projectId || !Number.isSafeInteger(journal.rev) || journal.rev < 0 || !Array.isArray(journal.project?.tracks)
      || !Array.isArray(journal.pending) || journal.pending.some(p => typeof p.opId !== "string" || !Array.isArray(p.ops) || !Array.isArray(p.inverse))) throw new Error(tr("Offline operation recovery data is corrupted"));
    const newer = this.pending;
    let recovered = journal.project;
    for (const p of newer) { const applied = applyOps(recovered, p.ops); if (!applied.ok) throw new Error(tr("Offline changes made during recovery cannot be continued; please keep a separate backup first")); recovered = applied.value; }
    this.local = recovered;
    this.confirmedRev = journal.rev;
    this.offlineRev = journal.pending.length || newer.length ? journal.offlineRev ?? journal.rev : null;
    this.pending = [...journal.pending.map(p => ({ ...p, sent: false })), ...newer];
    this.emit("project", this.local, "state");
  }

  get status(): SyncStatus {
    if (this.paused) return "paused";
    if (!this.connected) return this.confirmed || this.offlineRev !== null ? "offline" : "idle";
    if (this.awaitingState) return "connecting";
    return "online";
  }

  get pausedInfo(): PausedInfo | null {
    return this.paused ? { ...this.paused, queued: this.pending.length } : null;
  }

  /** Number of local commits that have not yet received ok */
  get unconfirmed(): number {
    return this.pending.length;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  on<K extends keyof Events>(event: K, cb: Events[K]): () => void {
    (this.listeners[event] as Set<Events[K]>).add(cb);
    return () => {
      (this.listeners[event] as Set<Events[K]>).delete(cb);
    };
  }

  private emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>) {
    for (const cb of this.listeners[event] as Set<(...a: Parameters<Events[K]>) => void>) cb(...args);
  }

  private setLocal(p: Project, cause: Parameters<Events["project"]>[1]) {
    if (p === this.local) return;
    this.local = p;
    this.emit("project", p, cause);
  }

  private statusChanged(before: SyncStatus) {
    const after = this.status;
    if (after !== before) this.emit("status", after);
  }

  /* ---------- Connection ---------- */

  /** Connected (or reconnected): send project.open, wait for project.state */
  connect() {
    const before = this.status;
    this.connected = true;
    this.awaitingState = true;
    this.partial = null;
    this.sendMsg({ type: "project.open", projectId: this.projectId });
    this.statusChanged(before);
  }

  /** Disconnected: in-flight commits are treated as unsent (re-sent with original opId after reconnecting; document service deduplicates by opId) */
  disconnect() {
    if (!this.connected) return;
    const before = this.status;
    this.connected = false;
    this.awaitingState = false;
    this.handingOver = false;
    this.partial = null;
    if (this.confirmed && this.offlineRev === null) this.offlineRev = this.confirmedRev;
    this.gateOpId = null;
    for (const p of this.pending) if (p.ackRev === undefined) p.sent = false;
    this.statusChanged(before);
  }

  /**
   * Planned connection switch (switching to a new session before an account cloud project connection
   * expires, `renew` in `src/editor/sync/link.ts`): called the moment the new connection is established
   * and the old connection is invalidated.
   * The difference from disconnect-reconnect is that it is **not recorded as offline**: in-flight
   * commits are treated as unsent, `project.open` is re-issued on the new connection, and unconfirmed
   * commits are re-sent as normal once state is received (document service deduplicates by opId),
   * without going through the offline batch version gate: this is not a user going offline, and someone
   * modifying the project at this exact moment should not pop up an offline dialog.
   * When the received state version matches the confirmed version in hand (no changes from others during
   * this switch), keep the project object in hand as-is without replacing it with a new object.
   * Sessions already in an offline batch (already have an offline version, or are currently paused)
   * follow offline rules and are not changed here.
   */
  handover() {
    const before = this.status;
    this.connected = true;
    this.awaitingState = true;
    this.handingOver = true;
    this.partial = null;
    for (const p of this.pending) if (p.ackRev === undefined) p.sent = false;
    this.sendMsg({ type: "project.open", projectId: this.projectId });
    this.statusChanged(before);
  }
  private handingOver = false;

  /** Received a message from document service */
  receive(msg: ServerMsg) {
    const before = this.status;
    switch (msg.type) {
      case "project.state":
        if (msg.project === undefined && typeof msg.parts === "number") this.onStateStart(msg);
        else this.onState(msg);
        break;
      case "project.state.part":
        this.onStatePart(msg);
        break;
      case "project.state.end":
        this.onStateEnd(msg);
        break;
      case "project.ops":
        this.onOps(msg);
        break;
      case "project.op.ok":
        this.onOk(msg);
        break;
      case "project.op.rejected":
        this.onRejected(msg);
        break;
      case "project.overwritten":
        this.onOverwritten(msg);
        break;
    }
    this.statusChanged(before);
    this.checkSettled();
  }

  private resync(reason: string) {
    this.emit("notice", { kind: "resync", reason });
    if (!this.connected) return;
    this.awaitingState = true;
    this.partial = null;
    this.sendMsg({ type: "project.open", projectId: this.projectId });
  }

  private onState(msg: StateMsg) {
    if (!this.awaitingState) return;
    this.awaitingState = false;
    const handover = this.handingOver;
    this.handingOver = false;
    if (this.gateOpId) {
      // Resynced before the first item of offline batch received a response: treat as unsent, retry below
      const g = this.pending.find((p) => p.opId === this.gateOpId);
      if (g && g.ackRev === undefined) g.sent = false;
      this.gateOpId = null;
    }
    if (msg.project == null) {
      if (!this.initialize) {
        this.connected = false;
        this.emit("notice", { kind: "resync", reason: "Collaboration service state is missing. Local content is kept; please restore from the original backup." });
        this.emit("status", this.status);
        return;
      }
      // Document service does not have this project yet: write local copy (along with unconfirmed changes) as a root replacement
      const seed: Pending = { opId: this.newOpId(), ops: [{ op: "set", path: "", value: this.local }], inverse: [], sent: false };
      for (const p of this.pending) {
        const step = this.stepOf.get(p.opId);
        if (step) this.stepOf.set(seed.opId, step);
      }
      this.pending = [seed];
      this.confirmed = null;
      this.confirmedRev = msg.rev;
      this.offlineRev = null;
      this.flush();
      return;
    }
    // Those already in this snapshot (received ok, rev does not exceed snapshot) are not replayed again
    this.pending = this.pending.filter((p) => p.ackRev === undefined || p.ackRev > msg.rev);
    if (handover && this.confirmed !== null && msg.rev === this.confirmedRev && this.offlineRev === null && !this.paused) {
      // Planned connection switch with no new version in the interim: content for the same version is
      // necessarily identical, so keep objects in hand (confirmed replica and local replica) as-is
      // and only re-send unconfirmed ones
      this.flush();
      return;
    }
    this.confirmed = msg.project;
    this.confirmedRev = msg.rev;
    if (this.commitLog.length && this.commitLog[this.commitLog.length - 1].rev > msg.rev) this.commitLog = this.commitLog.filter((c) => c.rev <= msg.rev);
    this.beforeRemote.clear();
    const hasBacklog = this.offlineRev !== null && this.pending.some((p) => !p.sent);
    if (hasBacklog && !this.paused) {
      // Offline batch: leave local replica untouched for now, try the first item with offlineRev
      this.sendGate();
      return;
    }
    if (this.paused) return;
    this.offlineRev = null;
    this.setLocal(this.pending.length ? this.replay(this.confirmed) : this.confirmed, "state");
    this.flush();
  }

  /** Snapshot receiving in chunks: buffer project.ops (with rev greater than snapshot) that arrive before assembly completes */
  private partial: { rev: number; count: number; chunks: string[]; buffered: OpsMsg[] } | null = null;

  private onStateStart(msg: StateMsg) {
    if (!this.awaitingState) return;
    this.partial = { rev: msg.rev, count: msg.parts!, chunks: [], buffered: [] };
  }

  private onStatePart(msg: StatePartMsg) {
    if (!this.partial || msg.rev !== this.partial.rev) return;
    this.partial.chunks[msg.index] = msg.data;
  }

  private onStateEnd(msg: StateEndMsg) {
    const part = this.partial;
    if (!part || msg.rev !== part.rev) return;
    this.partial = null;
    let project: Project;
    try {
      if (part.chunks.length !== part.count || part.chunks.some((c) => typeof c !== "string")) throw new Error(tr("Incomplete chunks"));
      project = JSON.parse(part.chunks.join(""));
    } catch (e) {
      this.resync(tr("Project shards cannot be assembled: {0}", (e as Error).message));
      return;
    }
    this.onState({ type: "project.state", rev: part.rev, project });
    for (const m of part.buffered) this.onOps(m);
  }

  private onOps(msg: OpsMsg) {
    // Document service does not echo back to submitter; if echoed back, treat as ok
    if (this.pending.some((p) => p.opId === msg.opId)) {
      this.onOk({ type: "project.op.ok", opId: msg.opId, rev: msg.rev });
      return;
    }
    if (this.partial) {
      if (msg.rev > this.partial.rev) this.partial.buffered.push(msg);
      return;
    }
    if (this.awaitingState || !this.confirmed) return;
    if (msg.rev <= this.confirmedRev) return;
    if (msg.resync || !Array.isArray(msg.ops)) {
      this.resync(tr("The remote large-root replacement carried no operations, reopening"));
      return;
    }
    if (msg.rev !== this.confirmedRev + 1) {
      this.resync(tr("Version gap: local {0}, received {1}", this.confirmedRev, msg.rev));
      return;
    }
    const r = applyOps(this.confirmed, msg.ops);
    if (!r.ok) {
      this.resync(tr("Remote operation cannot be applied to the confirmed copy: {0}", r.detail));
      return;
    }
    // Record inverse operations for this commit by someone else (used by AI panel "Undo this step";
    // defer to event if inverse is included in event).
    // Do not filter by actor.role: in this machine local space, Agent connections currently still
    // have page identity (c65-integ report section 7), indistinguishable
    this.remoteInverses.set(msg.opId, { rev: msg.rev, inverse: diffProject(r.value, this.confirmed).ops, after: r.value });
    if (this.remoteInverses.size > REMOTE_INVERSE_KEEP) this.remoteInverses.delete(this.remoteInverses.keys().next().value!);
    this.confirmed = r.value;
    this.confirmedRev = msg.rev;
    const by: Writer = { actor: msg.actor, session: msg.session ?? (msg.actor as { session?: string } | undefined)?.session };
    const remoteEntities = entitiesOf(msg.ops);
    this.remoteWrites.push({ rev: msg.rev, opId: msg.opId, by, entities: undoEntitiesOf(msg.ops) });
    this.noteCommit(msg.rev, msg.opId, msg.actor, msg.ops, remoteEntities);
    this.emit("notice", { kind: "remote", rev: msg.rev, opId: msg.opId, entities: remoteEntities, by, ...(msg.undoOf ? { undoOf: msg.undoOf } : {}) });
    this.pruneRemoteWrites();
    this.beforeRemote.set(msg.rev, this.local);
    if (this.beforeRemote.size > BEFORE_REMOTE_KEEP) this.beforeRemote.delete(this.beforeRemote.keys().next().value!);

    // Offline batch is awaiting response or paused: leave local replica untouched for now
    if (this.gateOpId || this.paused) return;
    if (this.pending.length === 0) {
      // No unconfirmed commits: apply directly to local replica, merging into the same tree as confirmed replica
      const r2 = applyOps(this.local, msg.ops);
      if (r2.ok) {
        this.confirmed = r2.value;
        this.setLocal(r2.value, "remote");
      } else {
        this.setLocal(this.confirmed, "remote");
      }
      return;
    }
    this.setLocal(this.replay(this.confirmed), "remote");
  }

  private onOk(msg: OkMsg) {
    const idx = this.pending.findIndex((p) => p.opId === msg.opId);
    if (idx < 0) return;
    const entry = this.pending[idx];
    const step = this.stepOf.get(entry.opId);
    if (step && step.rev === undefined) step.rev = msg.rev;
    if (msg.overwrote?.length) this.emit("notice", { kind: "overwrote", opId: entry.opId, entities: msg.overwrote });

    if (this.awaitingState) {
      entry.ackRev = msg.rev;
      return;
    }
    if (msg.rev <= this.confirmedRev) {
      // Re-sent commit actually landed long ago (already included in snapshot): remove, do not apply again
      this.pending.splice(idx, 1);
      if (this.gateOpId === entry.opId) this.openGate();
      else if (!this.gateOpId && !this.paused && this.confirmed) this.setLocal(this.replay(this.confirmed), "commit");
      return;
    }
    // Can also reach here after switching connections: an in-flight commit on the old connection
    // arrived late, before the response to the one ahead of it. Do not guess whether the preceding
    // commit landed (guessing wrong will silently cause page and document service contents to diverge),
    // refetch the whole document unconditionally and replay unconfirmed commits on the fetched state
    if (idx !== 0 || msg.rev !== this.confirmedRev + 1 || entry.brokenLocally) {
      this.resync(tr("Acknowledgement out of order or inconsistent with local: {0} rev {1}", entry.opId, msg.rev));
      return;
    }
    if (this.confirmed === null) {
      // Create project via root replacement
      const r0 = applyOps({} as Project, entry.ops);
      if (!r0.ok) return this.resync(tr("The root replacement that creates the project cannot be applied"));
      this.confirmed = r0.value;
    } else {
      const r = applyOps(this.confirmed, entry.ops);
      if (!r.ok) {
        this.resync(tr("The confirmed commit cannot be applied to the confirmed copy: {0}", r.detail));
        return;
      }
      this.confirmed = r.value;
    }
    this.confirmedRev = msg.rev;
    this.pending.shift();
    this.localWrites.push({ rev: msg.rev, entities: undoEntitiesOf(entry.ops) });
    this.noteCommit(msg.rev, entry.opId, null, entry.ops, entitiesOf(entry.ops));
    this.pruneRemoteWrites();
    if (this.gateOpId === entry.opId) {
      this.openGate();
      return;
    }
    // All confirmed: local replica becomes confirmed replica, merged into the same tree
    if (this.pending.length === 0 && !this.paused && !this.gateOpId) this.confirmed = this.local;
  }

  private onRejected(msg: RejectedMsg) {
    const idx = this.pending.findIndex((p) => p.opId === msg.opId);
    if (idx < 0) return;
    const entry = this.pending[idx];
    if (msg.reason === "stale" && this.gateOpId === entry.opId) {
      entry.sent = false;
      this.gateOpId = null;
      this.paused = { offlineRev: this.offlineRev ?? this.confirmedRev, currentRev: msg.currentRev, since: msg.since, queued: this.pending.length };
      return;
    }
    this.pending.splice(idx, 1);
    this.dropSteps([entry.opId]);
    this.emit("notice", { kind: "rejected", opId: entry.opId, reason: msg.reason });
    if (this.gateOpId === entry.opId) {
      // First item of offline batch rejected for other reasons: next item continues as "first item" to try
      this.gateOpId = null;
      this.sendGate();
      return;
    }
    if (this.confirmed && !this.paused && !this.gateOpId) this.setLocal(this.replay(this.confirmed), "rejected");
  }

  private onOverwritten(msg: OverwrittenMsg) {
    // Save its version of this entity as a local backup first, then (or already) switch to new version
    const mine = this.beforeRemote.get(msg.rev) ?? this.local;
    this.saveBackup?.({ kind: "overwritten", projectId: this.projectId, entity: msg.entity, by: msg.by, rev: msg.rev, value: getAt(mine, entityValuePath(msg.entity)), at: this.now() });
    this.emit("notice", { kind: "overwritten", entity: msg.entity, by: msg.by, rev: msg.rev });
  }

  /* ---------- Offline batch ---------- */

  private sendGate() {
    const first = this.pending.find((p) => !p.sent);
    if (!first || !this.connected || this.awaitingState) {
      if (!first) this.openGate();
      return;
    }
    this.gateOpId = first.opId;
    first.sent = true;
    this.sendOp(first, this.offlineRev ?? this.confirmedRev);
  }

  private openGate() {
    this.gateOpId = null;
    this.offlineRev = null;
    if (this.confirmed) this.setLocal(this.pending.length ? this.replay(this.confirmed) : this.confirmed, "replay");
    this.flush();
  }

  /** Offline batch rejected, user selects "Replay": drop expected version, submit in sequence */
  replayOffline() {
    if (!this.paused) return;
    const before = this.status;
    this.paused = null;
    this.offlineRev = null;
    if (this.confirmed) this.setLocal(this.replay(this.confirmed), "replay");
    this.flush();
    this.statusChanged(before);
    this.checkSettled();
  }

  /** Offline batch rejected, user selects "Discard": save as local backup first, then revert to document service version */
  discardOffline() {
    if (!this.paused) return;
    const before = this.status;
    const batch = this.pending.map((p) => ({ opId: p.opId, ops: p.ops }));
    this.saveBackup?.({ kind: "offline-discard", projectId: this.projectId, baseRev: this.paused.offlineRev, batch, project: this.local, at: this.now() });
    this.dropSteps(batch.map((b) => b.opId));
    this.redoStack = [];
    this.pending = [];
    this.paused = null;
    this.offlineRev = null;
    if (this.confirmed) this.setLocal(this.confirmed, "discard");
    this.statusChanged(before);
    this.checkSettled();
  }

  /**
   * Merge offline-modified content (a file saved out from a cloud project and subsequently
   * modified in the local replica) as a normal modification (10-14 Section 3.4).
   * Diff is calculated against the currently confirmed version; `baseRev` is the history sequence
   * number when that file was saved out:
   * - Document service is still at `baseRev` (unmodified in the interim): just a normal commit;
   * - Modified in the interim: handle as an offline batch: try this item with `baseRev`, pause if
   *   rejected as stale, letting user choose "Replay / Discard" per existing conflict handling
   *   (save a local backup before discarding).
   * Throw error if connection is not ready (not received confirmed version, waiting for status,
   * or already paused); return false and send nothing if there is no diff.
   */
  mergeOffline(next: Project, baseRev: number): boolean {
    if (!this.connected || this.awaitingState || !this.confirmed || this.paused || this.gateOpId) throw new Error(tr("The document connection is not ready yet; offline changes cannot be merged"));
    if (!Number.isSafeInteger(baseRev) || baseRev < 0) throw new Error(tr("The history sequence number of the offline changes is wrong"));
    if (baseRev === this.confirmedRev && this.offlineRev === null) {
      // Not initiated via store: use replay as reason, side connected to store writes result into state
      const prev = this.local;
      return this.commitInternal(next, {}, undefined, undefined, "replay") !== prev;
    }
    const before = this.status;
    const d = diffProject(this.local, next);
    if (d.ops.length === 0) return false;
    const r = applyOps(this.local, d.ops);
    if (!r.ok) throw new Error(tr("Offline changes cannot be applied: {0}", r.detail));
    const ops: PathOp[] = utf8Bytes(JSON.stringify(d.ops)) > MAX_OPS_BYTES ? [{ op: "set", path: "", value: r.value }] : d.ops;
    const entry: Pending = { opId: this.newOpId(), ops, inverse: d.inverse, sent: false };
    this.pending.push(entry);
    this.noteOwnOp(entry.opId);
    this.offlineRev = baseRev;
    // Offline batch: local replica is the one with offline modifications, confirmed replica stays
    // untouched; decide after document service responds
    this.setLocal(r.value, "replay");
    this.sendGate();
    this.statusChanged(before);
    return true;
  }

  /**
   * When undo encounters conflict, items in the same object not modified by others are undone directly
   * (0.7.20, `src/editor/sync/undoConflict.ts`): a normal commit, but does not enter undo stack (it is
   * part of that preceding undo); not initiated via store, use replay as reason so the side connected
   * to store writes into state.
   */
  commitAside(next: Project): boolean {
    const prev = this.local;
    return this.commitInternal(next, { undoable: false }, undefined, undefined, "replay") !== prev;
  }

  /* ---------- Local modifications ---------- */

  /**
   * Locally change to next: compute diff, optimistically apply, enqueue, and send eagerly.
   * Return applied local replica (key order is based on it); caller writes it into store.
   */
  commit(next: Project, opts: CommitOptions = {}): Project {
    return this.commitInternal(next, opts, undefined, undefined);
  }

  /** Load another content (opening old .proc, skill merge result): a root replacement, clear undo stack */
  load(next: Project): Project {
    this.undoStack = [];
    this.redoStack = [];
    this.stepOf.clear();
    const entry: Pending = { opId: this.newOpId(), ops: [{ op: "set", path: "", value: next }], inverse: [{ op: "set", path: "", value: this.local }], sent: false };
    this.pending.push(entry);
    this.noteOwnOp(entry.opId);
    this.setLocal(next, "load");
    this.flush();
    return this.local;
  }

  /* ---------- Commits sent by this page (used for carrying opIds in Agent tool responses staying on page) ---------- */

  private ownOps: string[] = [];
  private ownOpsBase = 0;

  private noteOwnOp(opId: string) {
    this.ownOps.push(opId);
    if (this.ownOps.length > OWN_OPS_KEEP) {
      const drop = this.ownOps.length - OWN_OPS_KEEP;
      this.ownOps.splice(0, drop);
      this.ownOpsBase += drop;
    }
  }

  /** Record a position; later use `opIdsSince` to get opId of commits sent by this page after this */
  opMark(): number {
    return this.ownOpsBase + this.ownOps.length;
  }

  /** Commits sent by this page after `opMark()` (including undo, load); old, pruned parts cannot be retrieved */
  opIdsSince(mark: number): string[] {
    return this.ownOps.slice(Math.max(0, mark - this.ownOpsBase));
  }

  private commitInternal(
    next: Project,
    opts: CommitOptions,
    undoOf: string | undefined,
    target: "undo" | "redo" | undefined,
    cause: "commit" | "undo" | "redo" | "revert-remote" | "replay" = target ?? "commit",
  ): Project {
    const prev = this.local;
    const d = diffProject(prev, next);
    if (d.ops.length === 0) return prev;
    const r = applyOps(prev, d.ops);
    if (!r.ok) throw new Error(tr("Operations produced by diffProject cannot be applied: {0}", r.detail));
    // Diff itself exceeds document service per-request limit: convert to a root replacement (value is
    // applied local replica), sent via chunked upload.
    // Replaying it on confirmed replica still yields this copy, consistent with document service
    // "last write wins"; inverse op still uses the one calculated from diff
    const ops: PathOp[] = utf8Bytes(JSON.stringify(d.ops)) > MAX_OPS_BYTES ? [{ op: "set", path: "", value: r.value }] : d.ops;
    const entry: Pending = { opId: this.newOpId(), ops, inverse: d.inverse, undoOf, sent: false };
    this.pending.push(entry);
    this.noteOwnOp(entry.opId);
    const now = this.now();
    if (target) {
      // Undo / redo itself: its inverse operation enters the opposite stack
      const step: Step = { opIds: [entry.opId], inverse: d.inverse, entities: undoEntitiesOf(d.ops), lastAt: now, after: r.value };
      this.stepOf.set(entry.opId, step);
      const stack = target === "undo" ? this.redoStack : this.undoStack;
      stack.push(step);
      if (stack.length > UNDO_LIMIT) stack.shift();
    } else if (opts.undoable !== false) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (opts.mergeKey && top && top.mergeKey === opts.mergeKey && now - top.lastAt <= (opts.mergeWindowMs ?? MERGE_WINDOW_MS) && this.redoStack.length === 0) {
        top.opIds.push(entry.opId);
        top.inverse = [...d.inverse, ...top.inverse];
        for (const e of undoEntitiesOf(d.ops)) if (!top.entities.includes(e)) top.entities.push(e);
        top.lastAt = now;
        top.after = r.value;
        this.stepOf.set(entry.opId, top);
      } else {
        const step: Step = { opIds: [entry.opId], inverse: d.inverse, entities: undoEntitiesOf(d.ops), mergeKey: opts.mergeKey, lastAt: now, after: r.value };
        this.stepOf.set(entry.opId, step);
        this.undoStack.push(step);
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      }
      this.redoStack = [];
    }
    this.setLocal(r.value, cause);
    this.flush();
    return this.local;
  }

  private sendOp(p: Pending, expectRev?: number) {
    const msg: OpMsg = { type: "project.op", projectId: this.projectId, opId: p.opId, session: this.session, ops: this.wireOps(p) };
    if (expectRev !== undefined) msg.expectRev = expectRev;
    if (p.undoOf) msg.undoOf = p.undoOf;
    this.sendMsg(msg);
  }

  /**
   * Root replacements exceeding single limit switch to `project.upload`: first send all chunks in
   * sequence, then send `project.op` referencing it.
   * Messages on the same connection are processed in order, so no need to wait for `project.uploaded`
   * reply. When chunk count exceeds limit, send as-is and let document service return too-large.
   */
  private wireOps(p: Pending): WireOp[] {
    const only = p.ops.length === 1 ? p.ops[0] : null;
    if (!only || only.op !== "set" || only.path !== "") return p.ops;
    if (utf8Bytes(JSON.stringify(p.ops)) <= MAX_OPS_BYTES) return p.ops;
    const text = JSON.stringify(only.value);
    const count = Math.ceil(text.length / UPLOAD_PART_CHARS);
    if (count > UPLOAD_MAX_PARTS) return p.ops;
    const uploadId = `up.${p.opId}`.slice(0, 128);
    for (let index = 0; index < count; index++) {
      this.sendMsg({ type: "project.upload", projectId: this.projectId, uploadId, index, count, data: text.slice(index * UPLOAD_PART_CHARS, (index + 1) * UPLOAD_PART_CHARS) });
    }
    return [{ op: "set", path: "", upload: uploadId }];
  }

  /** Send all unsent items in sequence whenever possible */
  private flush() {
    if (!this.connected || this.awaitingState || this.gateOpId || this.paused) return;
    for (const p of this.pending) {
      if (p.sent) continue;
      p.sent = true;
      this.sendOp(p);
    }
  }

  /** Replay unconfirmed local operations in sequence on confirmed replica; drop unsent ones that cannot be applied */
  private replay(base: Project): Project {
    let cur = base;
    const dropped: string[] = [];
    for (const p of this.pending) {
      if (p.ackRev !== undefined && p.ackRev <= this.confirmedRev) continue;
      const r = applyOps(cur, p.ops);
      if (r.ok) {
        cur = r.value;
        p.brokenLocally = false;
      } else if (!p.sent) {
        dropped.push(p.opId);
        this.emit("notice", { kind: "replay-dropped", opId: p.opId, detail: r.detail });
      } else {
        p.brokenLocally = true;
      }
    }
    if (dropped.length) {
      this.pending = this.pending.filter((p) => !dropped.includes(p.opId));
      this.dropSteps(dropped);
    }
    return cur;
  }

  /** These commits are invalidated: undo steps containing them are completely removed (inverse ops no longer match) */
  private dropSteps(opIds: string[]) {
    const gone = new Set(opIds);
    const keep = (s: Step) => !s.opIds.some((id) => gone.has(id));
    this.undoStack = this.undoStack.filter(keep);
    this.redoStack = this.redoStack.filter(keep);
    for (const id of opIds) this.stepOf.delete(id);
  }

  /* ---------- Undo / redo ---------- */

  undo(): UndoResult | null {
    const step = this.undoStack.pop();
    if (!step) return null;
    return this.revert(step, "undo");
  }

  redo(): UndoResult | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    return this.revert(step, "redo");
  }

  /** Entities modified by another write identity after this step → who modified it most recently */
  private conflictsFor(step: Step): Map<string, Writer> {
    const out = new Map<string, Writer>();
    if (step.rev === undefined) return out; // Not yet confirmed: remote changes received later are all ordered before it
    for (const w of this.remoteWrites) {
      if (w.rev <= step.rev) continue;
      for (const e of step.entities) if (w.entities.some((x) => entitiesOverlap(x, e))) out.set(e, w.by);
    }
    return out;
  }

  /**
   * AI panel "Undo this step": submit inverse operation of that commit by others (Agent) under this
   * page's identity, with `undoOf` pointing to that commit, entering this page's own undo stack
   * (c65-design.md section 8 ruling). Conflict check is same as `undo`: after that commit, entities
   * modified by **another write identity** (including this page's own subsequent changes) are not
   * undone; subsequent changes by that commit's own author do not count.
   * When version number of that commit cannot be found (applied before page connected, records pruned,
   * not included in event), block only based on unconfirmed modifications of this page.
   */
  /** Can this commit from others be undone: event carried inverse op, or this page recorded it when received */
  canRevertRemote(opId: string, inverse?: PathOp[]): boolean {
    return (inverse?.length ?? 0) > 0 || this.remoteInverses.has(opId);
  }

  revertRemote(remote: RemoteStep): UndoResult {
    const own = this.remoteWrites.find((w) => w.opId === remote.opId);
    const kept = this.remoteInverses.get(remote.opId);
    const rev = remote.rev ?? own?.rev ?? kept?.rev;
    const inverse = remote.inverse?.length ? remote.inverse : kept?.inverse ?? [];
    const entities = undoEntitiesOf(inverse);
    const blocked = new Map<string, Writer>();
    const mine: Writer = { session: this.session };
    if (rev !== undefined) {
      const origin = remote.by ?? own?.by;
      const sameWriter = (by: Writer) =>
        origin !== undefined && by.session === origin.session && JSON.stringify(by.actor ?? null) === JSON.stringify(origin.actor ?? null);
      for (const w of this.remoteWrites) {
        if (w.rev <= rev || sameWriter(w.by)) continue;
        for (const e of entities) if (w.entities.some((x) => entitiesOverlap(x, e))) blocked.set(e, w.by);
      }
      for (const w of this.localWrites) {
        if (w.rev <= rev) continue;
        for (const e of entities) if (w.entities.some((x) => entitiesOverlap(x, e))) blocked.set(e, mine);
      }
    }
    // Unconfirmed local modifications also count as "modified later"
    for (const p of this.pending) {
      for (const x of undoEntitiesOf(p.ops)) for (const e of entities) if (entitiesOverlap(x, e)) blocked.set(e, mine);
    }
    // Only when this page sees it land directly does it know what "after that step landed" looks like
    const after = kept?.after;
    const step: Step = { opIds: [remote.opId], inverse, entities, lastAt: this.now(), after };
    const result = this.applyRevert(step, blocked, undefined);
    this.emit("notice", { kind: "revert-remote", of: remote.opId, result });
    return result;
  }

  private revert(step: Step, kind: "undo" | "redo"): UndoResult {
    for (const id of step.opIds) this.stepOf.delete(id);
    const result = this.applyRevert(step, this.conflictsFor(step), kind);
    this.emit("notice", { kind: "undo", redo: kind === "redo", result });
    return result;
  }

  /** Undo step by conflict table: undo those that apply; when kind is empty (undoing step from others), result enters undo stack as normal modification */
  private applyRevert(step: Step, blocked: Map<string, Writer>, kind: "undo" | "redo" | undefined): UndoResult {
    const skipped: SkippedEntity[] = [...blocked].map(([entity, by]) => ({ entity, by }));
    // Blocked items: undo only them on "after that step landed", hand over to conflict merge window
    // to compare item by item (if undo fails, reject; UI returns to notice bar)
    let conflict: UndoResult["conflict"];
    if (blocked.size && step.after) {
      const r = applyOps(step.after, relocateOps(step.after, step.inverse.filter((op) => blocked.has(undoEntityOfOp(op)))));
      if (r.ok && r.value !== step.after) conflict = { landed: step.after, reverted: r.value };
    }
    // Inverse operation records track location at write time (active cut's /tracks or parked cut's
    // /cuts/@X/tracks); for tracks moved by later cut switching, find current location by track id
    // and apply without switching active cut (kernel/cutPaths.ts)
    const allowed = relocateOps(this.local, step.inverse.filter((op) => !blocked.has(undoEntityOfOp(op))));
    const failed: string[] = [];
    let candidate = this.local;
    if (allowed.length) {
      const all = applyOps(candidate, allowed);
      if (all.ok) candidate = all.value;
      else {
        // Entire batch cannot apply: group by entity and try group by group; mark the failing group as failed to undo
        const groups = new Map<string, PathOp[]>();
        for (const op of allowed) {
          const e = undoEntityOfOp(op);
          if (!groups.has(e)) groups.set(e, []);
          groups.get(e)!.push(op);
        }
        for (const [e, ops] of groups) {
          const r = applyOps(candidate, ops);
          if (r.ok) candidate = r.value;
          else failed.push(e);
        }
      }
    }
    if (candidate === this.local) {
      // Not a single place succeeded in undoing: pop from stack, do not enter opposite stack (c65-design.md section 8 ruling)
      return { done: false, skipped, failed, ...(conflict ? { conflict } : {}) };
    }
    const undoOf = step.opIds[step.opIds.length - 1];
    const before = this.pending.length;
    // Undoing that step from others bypasses setProject: send as revert-remote so store bridge side
    // writes into state (otherwise page waits for next change to refresh)
    this.commitInternal(candidate, kind ? { undoable: false } : {}, undoOf, kind, kind ?? "revert-remote");
    const opId = this.pending.length > before ? this.pending[this.pending.length - 1].opId : undefined;
    return { done: opId !== undefined, skipped, failed, opId, ...(conflict ? { conflict } : {}) };
  }

  private pruneRemoteWrites() {
    if (this.remoteWrites.length < 256 && this.localWrites.length < 256) return;
    let min = this.confirmedRev;
    for (const s of [...this.undoStack, ...this.redoStack]) if (s.rev !== undefined && s.rev < min) min = s.rev;
    this.remoteWrites = this.remoteWrites.filter((w) => w.rev > min);
    this.localWrites = this.localWrites.filter((w) => w.rev > min);
  }

  /* ---------- Save ---------- */

  private isSettled(): boolean {
    return this.connected && !this.awaitingState && !this.paused && !this.gateOpId && this.pending.length === 0 && this.confirmed !== null;
  }

  /**
   * Wait until all local operations receive ok (`.proc` is written only after this). Return version
   * number confirmed by document service and that version of content.
   * Reject on timeout (no timeout by default); caller prompts the user.
   */
  whenSettled(opts: { timeoutMs?: number } = {}): Promise<{ rev: number; project: Project }> {
    if (this.isSettled()) return Promise.resolve({ rev: this.confirmedRev, project: this.confirmed! });
    return new Promise((resolve, reject) => {
      const w: (typeof this.settleWaiters)[number] = { resolve, reject };
      if (opts.timeoutMs !== undefined) {
        w.timer = setTimeout(() => {
          this.settleWaiters = this.settleWaiters.filter((x) => x !== w);
          reject(new Error(tr("Timed out waiting for document service confirmation ({0} still unconfirmed, status {1})", this.pending.length, this.status)));
        }, opts.timeoutMs);
      }
      this.settleWaiters.push(w);
    });
  }

  private checkSettled() {
    if (!this.settleWaiters.length || !this.isSettled()) return;
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiters) {
      if (w.timer) clearTimeout(w.timer);
      w.resolve({ rev: this.confirmedRev, project: this.confirmed! });
    }
  }
}

/* ---------------- Connect to store ---------------- */

/**
 * Connect a DocSync to editor store: setProject / loadProject / undo / redo / canUndo / canRedo
 * are taken over by it; changes from others write into state (not into undo stack, no echo back).
 * Return unbind function; after unbinding, revert to snapshot stack mode.
 *
 * When switching projects (another projectId), unbind first, then create a DocSync for the new
 * project; when connected, `loadProject` is a root replacement on **this current project**.
 */
export function bindStore(ds: DocSync, opts: { load?: (project: Project) => Project } = {}): () => void {
  if (ds.project !== state.project) {
    // DocSync should be created from the copy in store; if not, DocSync takes precedence
    set({ project: ds.project });
  }
  attachProjectSync({
    commit: (_prev, next, opts) => ds.commit(next, opts),
    // Connecting side can take over "load": when loading another project, replace DocSync instead of
    // doing root replacement on current project
    load: (project) => (opts.load ? opts.load(project) : ds.load(project)),
    undo: () => void ds.undo(),
    redo: () => void ds.redo(),
    canUndo: () => ds.canUndo(),
    canRedo: () => ds.canRedo(),
    // .proc is only written after all local modifications receive confirmation (c65-design.md section 4, V7)
    whenSettled: (opts) => ds.whenSettled(opts),
  });
  const off = ds.on("project", (project, cause) => {
    // commit / load are written into state by setProject / loadProject themselves
    if (cause === "commit" || cause === "load") return;
    if (project === state.project) return;
    const prev = state.project;
    // Changes from others: page state of this page adjusts accordingly (switch cuts to update
    // playhead, manual total duration value, deleted clips in selection; c65-integ2 ruling)
    const pagePatch = cause === "remote" ? pageStateAfterRemote(prev, project, state) : null;
    set({ project, dirty: true, ...(pagePatch ?? {}) });
  });
  return () => {
    off();
    attachProjectSync(null);
  };
}
