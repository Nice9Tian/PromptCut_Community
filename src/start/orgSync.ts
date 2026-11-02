/**
 * Sync engine for cloud groups (ruling V22-05~09; design in `docs/archive/agent-reports/AGENT-claude-groups-local-cloud.md`, section "Plan").
 *
 * The cloud stores the whole `OrgState` (`realm: "cloud"`), one per account, through the `get` / `put` of
 * `POST /hosted/shared/account/start-org`.
 * This file only handles the sync logic and **touches no React, no network, no storage, no timers**: the caller
 * injects all four, so it can be unit tested without starting a server
 * (`orgSync.test.mjs`). The thin React shell is in `useCloudOrg.ts`, and the network side is `getStartOrg` /
 * `putStartOrg` in `src/account/client.ts`.
 *
 * Flow:
 *   - **Local cache first**: as soon as the UI opens, use the copy read by `loadOrg` (it is also the cache of the
 *     cloud copy in this browser), without waiting for the network.
 *   - **Pull** (`refresh`: on page open, login, page becoming visible again, network recovery): fetch the current
 *     cloud copy. If there are no local unuploaded changes, adopt the cloud copy directly;
 *     if there are, do a three-way merge (`orgMerge.ts`) and then upload. If the cloud has never stored anything
 *     (version 0) while the local side already has content (groups made before cloud storage was connected),
 *     upload the whole copy.
 *   - **Change** (`changed`): first record "whether there are unuploaded changes" (`dirty`, stored locally), then
 *     upload after a debounce of about 1 second.
 *   - **Upload**: carries the version last fetched. On success: the version is updated. On conflict (409, the
 *     cloud copy is newer than the one I fetched): three-way merge with the returned copy,
 *     re-upload with its version number, retrying a limited number of times. If new changes arrive during the
 *     upload, it is still marked "has unuploaded changes" afterwards and another upload is scheduled.
 *   - **Failures show no dialog**: the server doesn't have this route yet (old server, 404) → `unsupported`:
 *     changes stay only local, no error and no retry, probing again the next time the page opens;
 *     can't connect, 5xx, expired token, etc. → `pending`: changes are kept and retried after a while, with the
 *     interval doubling each time up to a one-minute cap, and also retried immediately when the page becomes
 *     visible again or the network recovers.
 *   - Only one thing runs at a time (chained into a single sequence), so two requests never fight over editing
 *     the local record.
 *
 * The local sync record (`SyncMeta`) and the organization data itself are stored under two separate keys:
 * `{ version: last fetched cloud version, base: the copy at that time, dirty: whether anything is unuploaded }`.
 * `base` is the "common starting point" of the three-way merge; if it can't be read (first time, record lost) it
 * is null, and in the merge everything on both sides counts as an addition, so nothing is lost.
 */
import { mergeOrg } from "./orgMerge.ts";
import { emptyOrg, parseOrg, type OrgState } from "./vibeOrg.ts";
import { tr } from "../i18n/index.ts";

/** One copy returned by the cloud: version 0 with org null means nothing was ever stored */
export interface RemoteOrg {
  version: number;
  org: unknown | null;
}

/** Result of `put`: on success it returns the written version and that copy; on conflict it brings back the current cloud copy */
export type PutResult =
  | { conflict: false; version: number; org: unknown }
  | { conflict: true; version: number; org: unknown | null };

/**
 * The network side. Requirement: throw any error when it can't connect or the service fails (the engine treats
 * it as `pending`); throw `OrgUnsupportedError` when the server doesn't have this route (old server).
 */
export interface OrgTransport {
  get(): Promise<RemoteOrg>;
  put(baseVersion: number, org: OrgState): Promise<PutResult>;
}

/** The server doesn't have the cloud groups route yet (404, etc.): the engine marks `unsupported`, with no error */
export class OrgUnsupportedError extends Error {
  constructor(message = tr("This cloud service doesn't support cloud groups yet")) {
    super(message);
    this.name = "OrgUnsupportedError";
  }
}

export interface SyncMeta {
  /** The cloud version last fetched (or written); 0 means the cloud never stored anything */
  version: number;
  /** The copy last fetched (or written): the common starting point of the three-way merge */
  base: OrgState | null;
  /** Whether this machine has changes that haven't been uploaded yet */
  dirty: boolean;
}

/**
 * - `idle`        the cloud hasn't been asked yet (just opened)
 * - `syncing`     reconciling with the cloud
 * - `synced`      this machine and the cloud agree
 * - `pending`     there are changes not uploaded (can't connect, etc.), will be retried after a while
 * - `unsupported` the cloud service doesn't have this route yet: kept only in this browser, the UI shows no error
 */
export type SyncStatus = "idle" | "syncing" | "synced" | "pending" | "unsupported";

export interface OrgSyncOptions {
  transport: OrgTransport;
  /** The organization data currently in the UI (including changes not yet uploaded) */
  getOrg: () => OrgState;
  /** Merged into new organization data: the UI switches to it and the local cache is written. **Do not** treat it as another user change (do not call `changed` again) */
  applyOrg: (org: OrgState) => void;
  loadMeta: () => SyncMeta | null;
  saveMeta: (meta: SyncMeta) => void;
  onStatus?: (status: SyncStatus) => void;
  /** Schedule a timer task and return a cancel function. Defaults to setTimeout */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** How long to wait after a change before uploading */
  debounceMs?: number;
  /** Retry interval after a failure: this long the first time, doubling each time after, capped at maxRetryMs */
  retryMs?: number;
  maxRetryMs?: number;
  /** The maximum number of re-merges on conflict within one sync */
  maxConflicts?: number;
}

export const SYNC_DEFAULTS = Object.freeze({ debounceMs: 1000, retryMs: 2000, maxRetryMs: 60_000, maxConflicts: 5 });

const keyOf = (org: OrgState): string => JSON.stringify([org.groups, org.projects, org.chats]);
const hasContent = (org: OrgState): boolean => org.groups.length + org.projects.length + org.chats.length > 0;

/** What the cloud returns is untrusted (the server checks it, and we recognize it again here): if it isn't recognized, treat it as absent */
function readRemote(org: unknown): OrgState | null {
  if (org === null || org === undefined) return null;
  return parseOrg(JSON.stringify(org), "cloud");
}

export interface OrgSync {
  /** Call on open, login, page becoming visible again, network recovery: reconcile with the cloud once */
  refresh(): Promise<void>;
  /** Call after the user changes organization data (the UI has already switched to the new one, and the local cache has already been written) */
  changed(): void;
  status(): SyncStatus;
  /** Schedule no more tasks (call on account switch and unmount); the one already running finishes but no longer calls back */
  stop(): void;
}

export function createOrgSync(options: OrgSyncOptions): OrgSync {
  const { transport, getOrg, applyOrg, loadMeta, saveMeta, onStatus } = options;
  const opt = {
    debounceMs: options.debounceMs ?? SYNC_DEFAULTS.debounceMs,
    retryMs: options.retryMs ?? SYNC_DEFAULTS.retryMs,
    maxRetryMs: options.maxRetryMs ?? SYNC_DEFAULTS.maxRetryMs,
    maxConflicts: options.maxConflicts ?? SYNC_DEFAULTS.maxConflicts,
  };
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); });

  const loaded = loadMeta();
  let meta: SyncMeta = loaded ?? { version: 0, base: null, dirty: false };
  /**
   * This device has never reconciled with the cloud (no sync record): the organization data it already has locally
   * (made before cloud storage was connected) counts as "not uploaded",
   * and must not be overwritten outright just because the cloud already has a copy uploaded by another device;
   * treat it as having unuploaded changes and no common starting point, and take the union with the cloud copy.
   */
  let firstContact = loaded === null;
  let status: SyncStatus = "idle";
  let stopped = false;
  let cancelTimer: (() => void) | null = null;
  let failures = 0;
  /** Chain into a single sequence: only one thing runs at a time */
  let chain: Promise<void> = Promise.resolve();

  const setStatus = (s: SyncStatus) => {
    if (status === s) return;
    status = s;
    if (!stopped) onStatus?.(s);
  };
  const setMeta = (next: SyncMeta) => { meta = next; saveMeta(next); };
  const clearTimer = () => { cancelTimer?.(); cancelTimer = null; };
  const later = (ms: number) => {
    clearTimer();
    if (stopped) return;
    cancelTimer = schedule(() => { cancelTimer = null; void enqueue(); }, ms);
  };

  /** Upload the unuploaded changes (merging first if necessary). Returns true on success; on failure a retry is already scheduled and it returns false */
  async function push(): Promise<boolean> {
    for (let conflicts = 0; ; ) {
      const mine = getOrg();
      const sent = keyOf(mine);
      const res = await transport.put(meta.version, mine);
      if (!res.conflict) {
        const stored = readRemote(res.org) ?? mine;
        // The user changed things again during the upload: this copy hasn't finished uploading, so record the new version number, and the flag stays "has unuploaded changes"
        const moved = keyOf(getOrg()) !== sent;
        setMeta({ version: res.version, base: stored, dirty: moved });
        if (moved) later(opt.debounceMs);
        return true;
      }
      if (++conflicts > opt.maxConflicts) throw new Error(tr("Cloud groups kept changing, so this merge failed"));
      const theirs = readRemote(res.org) ?? emptyOrg("cloud");
      const merged = mergeOrg(meta.base, mine, theirs);
      // Save locally first, then re-upload: the merge result cannot live only in memory
      applyOrg(merged);
      setMeta({ version: res.version, base: theirs, dirty: true });
    }
  }

  async function pullAndPush(): Promise<void> {
    const remote = await transport.get();
    const theirs = readRemote(remote.org);
    const mine = getOrg();
    if (firstContact && hasContent(mine) && !meta.dirty) setMeta({ ...meta, dirty: true });
    if (remote.version < meta.version) {
      // The cloud is older than what I recorded (cloud data was reset): start from the cloud and upload the
      // whole local copy again
      setMeta({ version: remote.version, base: theirs, dirty: hasContent(mine) || meta.dirty });
    } else if (remote.version > meta.version) {
      if (!meta.dirty) {
        // No unsent local changes: just take the cloud version
        const adopted = theirs ?? emptyOrg("cloud");
        if (theirs && keyOf(adopted) !== keyOf(mine)) applyOrg(adopted);
        setMeta({ version: remote.version, base: theirs, dirty: false });
        return;
      }
      const merged = mergeOrg(meta.base, mine, theirs ?? emptyOrg("cloud"));
      applyOrg(merged);
      setMeta({ version: remote.version, base: theirs, dirty: true });
    } else if (remote.version === 0 && !meta.dirty && hasContent(mine)) {
      // The cloud has never stored anything and this machine already has content (groups made before cloud
      // storage was connected): upload the whole thing
      setMeta({ ...meta, dirty: true });
    }
    if (meta.dirty) await push();
  }

  async function run(): Promise<void> {
    if (stopped) return;
    setStatus("syncing");
    try {
      await pullAndPush();
      firstContact = false;
      failures = 0;
      setStatus(meta.dirty ? "pending" : "synced");
    } catch (e) {
      if (e instanceof OrgUnsupportedError) {
        // Old server: no error, no retry (probe again the next time the page opens); changes stay local
        failures = 0;
        setStatus("unsupported");
        return;
      }
      failures += 1;
      setStatus("pending");
      // The server said how long to wait before retrying (429 Retry-After, cloud group write rate limit):
      // not earlier than that; no changes are lost, dirty is still set
      const hint = (e as { retryAfterSec?: unknown } | null)?.retryAfterSec;
      const asked = typeof hint === "number" && hint > 0 ? hint * 1000 : 0;
      later(Math.max(asked, Math.min(opt.maxRetryMs, opt.retryMs * 2 ** (failures - 1))));
    }
  }

  const enqueue = (): Promise<void> => {
    chain = chain.then(run, run);
    return chain;
  };

  return {
    refresh() {
      clearTimer();
      return enqueue();
    },
    changed() {
      if (stopped) return;
      if (!meta.dirty) setMeta({ ...meta, dirty: true });
      // Already confirmed that the cloud does not support this: stop queueing transports (the next refresh
      // will probe once more)
      if (status === "unsupported") return;
      setStatus(status === "synced" || status === "idle" ? "pending" : status);
      later(opt.debounceMs);
    },
    status: () => status,
    stop() {
      stopped = true;
      clearTimer();
    },
  };
}

/* ---------------- Sync record is stored locally ---------------- */

/** Key of the sync record: stored separately from the organization data itself (`orgKey("cloud", scope)`);
 * one is the content, the other is "how the content relates to the cloud" */
export const syncMetaKey = (scope: string): string => `pc.start.orgsync.cloud.${scope}`;

/** Data read back is not trusted: if it is not recognized, treat it as never recorded (first run, record
 * lost, corrupted) */
export function parseSyncMeta(raw: string | null): SyncMeta | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || !Number.isSafeInteger(v.version) || (v.version as number) < 0) return null;
    const base = v.base === null || v.base === undefined ? null : readRemote(v.base);
    return { version: v.version as number, base, dirty: v.dirty === true };
  } catch {
    return null;
  }
}

export function loadSyncMeta(scope: string): SyncMeta | null {
  try { return parseSyncMeta(localStorage.getItem(syncMetaKey(scope))); } catch { return null; }
}

export function saveSyncMeta(scope: string, meta: SyncMeta): void {
  try { localStorage.setItem(syncMetaKey(scope), JSON.stringify(meta)); } catch { /* If it cannot be saved, it is only valid for this session of the page */ }
}
