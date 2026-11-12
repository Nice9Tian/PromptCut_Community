/**
 * Page-side presence (plan docs/plan/agent-workflow-plan.md A3 phase 2; document service side: server/docservice/modules/presence.mjs).
 *
 * - **Send**: the clips this page is "editing" (the A2 summary, src/editor/userEditing.ts) go out through its own
 *   document service connection as `presence.set`, so other members of the same project (their editor processes,
 *   their Agents) know "User <member> is editing". Online pages (browser mode, with no local
 *   editor process) take this path too. Not written to project history; it has an expiry (15 seconds,
 *   renewed every 5 seconds while the page is non-empty).
 * - **Receive**: the scope declared by other members' Agents (`kind: 'agent'`), listed in the AI panel (RemoteAgentsStrip).
 * - **Receive**: whether a Cloud Agent round is running right now (`key: 'cloud-run'`, see "Whether the Cloud Agent is running right now" below), used for the member list count and the "Offline, Agent running" marker.
 *
 * **Compatibility**: an old document service does not know `presence.*` and replies `error { reason: 'unsupported' }`: record that this connection does not support it and stop sending,
 * with no error and no disconnect (`markUnsupported`).
 *
 * It knows no UI other than the store; the connection is handed in by syncManager (`setPresenceLink`), so the two sides do not reference each other.
 */
import { useSyncExternalStore } from "react";
import { republishSelection, setSelectionLink } from "./selectionPresence.ts";

interface LinkLike {
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

export interface EditingEntityWire {
  clipId: string;
  kind: "drag" | "text" | "recent";
  remainingMs?: number;
}

/** The presence entry that the Cloud Agent service publishes: while a round is running, `presence.set { key: 'cloud-run', ttlMs: 90000, data: { v: 1, kind: 'cloud-run', runs } }`, renewed every 30 seconds and cleared when the last round ends */
export const CLOUD_RUN_KEY = "cloud-run";

export interface RemoteAgent {
  id: string;
  member: string;
  vendor: string | null;
  /** This is that member's Cloud Agent (the source identity carries `service: 'agent'`) */
  cloud?: boolean;
  scope: string;
  expiresAt: number;
}

/** Expiry of the page's "editing" state: matches the renewal interval of the A2 server-side board (the page heartbeats every 5 seconds) */
export const EDITING_TTL_MS = 15_000;

let current: { link: LinkLike; projectId: string; me: string } | null = null;
const unsupported = new WeakSet<LinkLike>();
let lastEditing: { session: string; entities: EditingEntityWire[] } | null = null;
/** Whether anything has been published on this connection (a withdrawal is sent only if something was published) */
const published = new WeakSet<LinkLike>();

/** In a shared project userId is "username@device"; take only the username; a local space gives null */
export function memberOf(userId: unknown): string | null {
  if (typeof userId !== "string" || !userId || userId === "local" || userId === "anonymous") return null;
  const at = userId.indexOf("@");
  return at > 0 ? userId.slice(0, at) : userId;
}

function markReply(link: LinkLike, reply: Record<string, unknown> | null) {
  if (reply && reply.type === "error" && reply.reason === "unsupported") unsupported.add(link);
}

/** Handed in when syncManager switches connection (or disconnects: null). `me` is this page's userId (to tell other people's Agents from your own) */
export function setPresenceLink(link: LinkLike | null, projectId: string | null, me: string, accountSelections = false): void {
  setSelectionLink(accountSelections ? link : null, accountSelections ? projectId : null);
  current = link && projectId ? { link, projectId, me } : null;
  remote.clear();
  cloudRuns.clear();
  emit();
  emitCloudRuns();
  if (current) {
    void refresh();
    if (lastEditing && lastEditing.entities.length) publishEditing(lastEditing.session, lastEditing.entities);
  }
}

/**
 * The connection under the same `SyncLink` was replaced (reconnect after a drop, or a session switch before an account project expires): presence that follows the connection is rebuilt on the new connection ——
 * the selection is resent; "editing" is resent (the document service records the sender per connection, so closing the old connection only withdraws the entry it sent itself, and the new connection's entry is unaffected);
 * other members' Agents are fetched again (changes may have been missed while disconnected).
 */
export function resyncPresenceLink(): void {
  const c = current;
  if (!c) return;
  republishSelection();
  void refresh();
  if (lastEditing && lastEditing.entities.length) publishEditing(lastEditing.session, lastEditing.entities);
}

/** The clips the page is "editing" (called once on every change of the A2 summary and on every heartbeat); empty array = withdraw */
export function publishEditing(session: string, entities: EditingEntityWire[]): void {
  lastEditing = { session, entities };
  const c = current;
  if (!c || unsupported.has(c.link)) return;
  const link = c.link;
  if (!entities.length) {
    if (!published.has(link)) return;
    published.delete(link);
    link.request({ type: "presence.clear", projectId: c.projectId, session, key: "editing" }, 5000).then((r) => markReply(link, r), () => {});
    return;
  }
  published.add(link);
  link
    .request({ type: "presence.set", projectId: c.projectId, session, key: "editing", ttlMs: EDITING_TTL_MS, data: { v: 1, kind: "editing", session, entities: entities.slice(0, 64) } }, 5000)
    .then((r) => markReply(link, r), () => {});
}

/* ---------------- Receive: Agents of other members ---------------- */

const remote = new Map<string, RemoteAgent>();
const listeners = new Set<() => void>();
let snapshot: RemoteAgent[] = [];

function emit() {
  const t = Date.now();
  snapshot = [...remote.values()].filter((a) => a.expiresAt > t).sort((a, b) => (a.member + a.id < b.member + b.id ? -1 : 1));
  for (const l of [...listeners]) l();
}

function ingest(e: Record<string, unknown>) {
  const key = typeof e.key === "string" ? e.key : "";
  if (key === CLOUD_RUN_KEY) { ingestCloudRun(e); return; }
  if (!key.startsWith("agent:")) return;
  const id = key.slice("agent:".length);
  const from = (e.from ?? {}) as Record<string, unknown>;
  const data = e.data as Record<string, unknown> | null;
  if (!data || typeof data.scope !== "string" || !data.scope) {
    remote.delete(id);
    return;
  }
  // Agents on this very machine do not count as "other members" (in a local space every userId is local)
  if (current && (from.userId === current.me || memberOf(from.userId) === null)) return;
  remote.set(id, {
    id,
    member: memberOf(from.userId) ?? "?",
    vendor: typeof data.vendor === "string" ? data.vendor : null,
    ...(from.service === "agent" ? { cloud: true } : {}),
    scope: data.scope,
    expiresAt: typeof e.expiresAt === "number" ? e.expiresAt : Date.now() + 30 * 60_000,
  });
}

export interface PresenceMessageEnvelope {
  projectId: string;
  from: {
    userId?: string;
    username?: string;
    deviceId?: string;
    deviceName?: string;
    displayName?: string;
    creator?: boolean;
    role?: string;
    session?: string | null;
  };
  data: Record<string, unknown>;
  at: number;
}

const messageListeners = new Set<(msg: PresenceMessageEnvelope) => void>();

export function subscribePresenceMessages(fn: (msg: PresenceMessageEnvelope) => void): () => void {
  messageListeners.add(fn);
  return () => {
    messageListeners.delete(fn);
  };
}

export async function sendPresenceMessage(data: Record<string, unknown>, session?: string): Promise<boolean> {
  const c = current;
  if (!c || unsupported.has(c.link)) return false;
  try {
    const reply = await c.link.request(
      {
        type: "presence.send",
        projectId: c.projectId,
        ...(session ? { session } : {}),
        data,
      },
      5000,
    );
    markReply(c.link, reply);
    return (
      (reply?.type === "presence.ok" || reply?.type === "presence.send.ok") &&
      (typeof reply.delivered !== "number" || reply.delivered > 0)
    );
  } catch {
    return false;
  }
}

/** `presence.*` from syncManager's side-channel messages is delivered here */
export function receivePresence(msg: Record<string, unknown>): void {
  if (!current || (msg.projectId !== undefined && msg.projectId !== current.projectId)) return;
  if (msg.type === "presence.update") {
    ingest(msg);
    if (msg.key === CLOUD_RUN_KEY) emitCloudRuns();
    else emit();
  } else if (msg.type === "presence.state" && Array.isArray(msg.entries)) {
    for (const e of msg.entries) if (e && typeof e === "object") ingest(e as Record<string, unknown>);
    emit();
    if (msg.entries.some((e) => (e as { key?: unknown } | null)?.key === CLOUD_RUN_KEY)) emitCloudRuns();
  } else if (msg.type === "presence.message" && msg.data && typeof msg.data === "object") {
    const env: PresenceMessageEnvelope = {
      projectId: String(msg.projectId ?? current.projectId),
      from: (msg.from && typeof msg.from === "object" ? msg.from : {}) as PresenceMessageEnvelope["from"],
      data: msg.data as Record<string, unknown>,
      at: typeof msg.at === "number" ? msg.at : Date.now(),
    };
    for (const fn of [...messageListeners]) {
      try { fn(env); } catch { /* ignore listener errors */ }
    }
  }
}

/* ---------------- Whether the Cloud Agent is running right now ----------------
 *
 * A Cloud Agent's connection stays connected after a round ends (reclaimed after 10 minutes idle), so "does this member have a Cloud Agent connection" cannot tell whether it is working.
 * While a round is running, the Agent service publishes an entry `cloud-run` through its own connection (with an expiry, renewed every 30 seconds), withdraws it when the last round ends, and the document service also withdraws it when the connection drops;
 * from this the page maintains a table of "which members' (`from.userId`, i.e. `username@deviceId`, the same form as `${row.username}@${row.deviceId}` in the member row) Cloud Agent has a round running right now":
 *
 * - Only entries whose source identity carries `service: 'agent'` count (the source is written by the document service from the connection's identity; the page cannot forge it);
 * - **Your own row counts too**: the "your own does not count" filter of `agent:` entries is not applied (that one exists so the AI panel does not list your own local Agent);
 * - One member can have several entries (several chats, several connections); it counts as running as long as one is unexpired and `runs` > 0;
 * - Expired entries stop counting automatically: filtered by current time on read, and subscribers are notified to redraw when the nearest one expires; cleared on project switch and disconnect.
 */

const cloudRuns = new Map<string, { userId: string; runs: number; expiresAt: number }>();
const cloudListeners = new Set<() => void>();
const EMPTY_RUNNING: ReadonlySet<string> = new Set();
let cloudSnapshot: ReadonlySet<string> = EMPTY_RUNNING;
/** Time of the earliest expiring entry in the snapshot; recompute when it is reached */
let cloudSnapshotUntil = Infinity;
let cloudTimer: ReturnType<typeof setTimeout> | null = null;

function recomputeCloudRuns(): boolean {
  const t = Date.now();
  const ids = new Set<string>();
  let until = Infinity;
  for (const [k, v] of cloudRuns) {
    if (v.expiresAt <= t) { cloudRuns.delete(k); continue; }
    ids.add(v.userId);
    if (v.expiresAt < until) until = v.expiresAt;
  }
  cloudSnapshotUntil = until;
  const same = ids.size === cloudSnapshot.size && [...ids].every((x) => cloudSnapshot.has(x));
  if (same) return false;
  cloudSnapshot = ids.size ? ids : EMPTY_RUNNING;
  return true;
}

function emitCloudRuns() {
  recomputeCloudRuns();
  if (cloudTimer !== null) { clearTimeout(cloudTimer); cloudTimer = null; }
  if (Number.isFinite(cloudSnapshotUntil)) {
    // Recompute and notify subscribers when the nearest entry expires (with no subscribers it just idles once)
    cloudTimer = setTimeout(() => { cloudTimer = null; emitCloudRuns(); }, Math.max(0, cloudSnapshotUntil - Date.now()) + 20);
    (cloudTimer as { unref?: () => void }).unref?.();
  }
  for (const l of [...cloudListeners]) l();
}

function ingestCloudRun(e: Record<string, unknown>) {
  const from = (e.from ?? {}) as Record<string, unknown>;
  const userId = typeof from.userId === "string" ? from.userId : "";
  if (!userId || from.service !== "agent") return;
  const id = JSON.stringify([userId, from.deviceId ?? null, from.conversation ?? null, from.session ?? null]);
  const data = e.data as Record<string, unknown> | null;
  const runs = data && typeof data === "object" && data.kind === "cloud-run" && typeof data.runs === "number" ? Math.floor(data.runs) : 0;
  if (!data || runs < 1) {
    cloudRuns.delete(id);
    return;
  }
  cloudRuns.set(id, { userId, runs, expiresAt: typeof e.expiresAt === "number" && e.expiresAt > 0 ? e.expiresAt : Date.now() + 90_000 });
}

/** Fetch the existing presence once; if the connection is not ready yet, retry after 2 seconds (at most 15 times); stop if the connection was replaced */
async function refresh() {
  const c = current;
  for (let i = 0; i < 15; i += 1) {
    if (!c || current !== c || unsupported.has(c.link)) return;
    try {
      const reply = await c.link.request({ type: "presence.list", projectId: c.projectId }, 5000);
      markReply(c.link, reply);
      if (current === c) receivePresence(reply);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** Members whose Cloud Agent has a round running right now (`username@deviceId`). Returns the same object between changes */
export function cloudRunning(): ReadonlySet<string> {
  if (cloudSnapshotUntil <= Date.now()) recomputeCloudRuns();
  return cloudSnapshot;
}

export function subscribeCloudRunning(cb: () => void): () => void {
  cloudListeners.add(cb);
  return () => { cloudListeners.delete(cb); };
}

export function useCloudRunning(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeCloudRunning, cloudRunning, cloudRunning);
}

export function remoteAgents(): RemoteAgent[] {
  return snapshot;
}

export function subscribeRemoteAgents(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useRemoteAgents(): RemoteAgent[] {
  return useSyncExternalStore(subscribeRemoteAgents, remoteAgents, remoteAgents);
}

/** Tests and diagnostics */
export function presenceStatus(): { linked: boolean; unsupported: boolean; remote: number; cloudRunning: number } {
  return { linked: !!current, unsupported: !!current && unsupported.has(current.link), remote: snapshot.length, cloudRunning: cloudRunning().size };
}
