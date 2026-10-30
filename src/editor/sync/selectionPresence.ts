/** Ephemeral selection publisher for an authenticated account-project document link.
 * The caller must explicitly enable this on cloud-account connections. LAN/local
 * links continue to use their established page-only get_selection behavior.
 */
interface SelectionLink {
  request(message: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

export interface SelectionSource {
  readSelection(): readonly string[];
  subscribe(listener: () => void): () => void;
}

type SelectionMessage = { type: "selection.set"; projectId: string; pageId: string; revision: number;
  selection: { clipIds: string[] } };
type Bound = { link: SelectionLink; projectId: string; pageId: string; revision: number; last: string;
  desired: SelectionMessage | null; attempt: number; retryStep: number;
  retryTimer: ReturnType<typeof setTimeout> | null; hardTimer: ReturnType<typeof setTimeout> | null };
let bound: Bound | null = null;
let stopStore: (() => void) | null = null;
let source: SelectionSource | null = null;
const unsupported = new WeakSet<SelectionLink>();
const identities = new WeakMap<SelectionLink, Map<string, { pageId: string; revision: number }>>();
const retryDelays = [250, 500, 1000, 2000, 5000];

function clearTimers(current: Bound): void {
  if (current.retryTimer) clearTimeout(current.retryTimer);
  if (current.hardTimer) clearTimeout(current.hardTimer);
  current.retryTimer = null;
  current.hardTimer = null;
}

function retry(current: Bound): void {
  if (bound !== current || unsupported.has(current.link)) return;
  const delay = retryDelays[Math.min(current.retryStep++, retryDelays.length - 1)];
  current.retryTimer = setTimeout(() => {
    current.retryTimer = null;
    transmit(current);
  }, delay);
}

function transmit(current: Bound): void {
  if (bound !== current || !current.desired || unsupported.has(current.link)) return;
  clearTimers(current);
  const message = current.desired;
  const attempt = ++current.attempt;
  let settled = false;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  const finish = (reply?: Record<string, unknown>) => {
    if (settled) return;
    settled = true;
    if (hardTimer) clearTimeout(hardTimer);
    if (current.hardTimer === hardTimer) current.hardTimer = null;
    if (bound !== current || current.attempt !== attempt || current.desired !== message) return;
    if (reply?.type === "selection.ok" && reply.selectionRevision === message.revision &&
        reply.projectId === message.projectId && reply.pageId === message.pageId) {
      current.retryStep = 0;
      return;
    }
    if (reply?.type === "error" && reply.reason === "unsupported") {
      unsupported.add(current.link);
      return;
    }
    if (reply?.type === "error" && ["forbidden", "principal-mismatch", "connection-closed",
      "page-mismatch", "invalid-selection", "stale-revision", "revision-conflict"].includes(String(reply.reason))) return;
    retry(current);
  };
  hardTimer = setTimeout(() => finish(), 5200);
  current.hardTimer = hardTimer;
  try { void current.link.request(message, 5000).then(finish, () => finish()); }
  catch { finish(); }
}

function publish(force = false): void {
  const current = bound;
  if (!current || !source || unsupported.has(current.link)) return;
  const clipIds = source.readSelection().filter((id): id is string => typeof id === "string");
  const key = JSON.stringify(clipIds);
  if (!force && current.last === key) return;
  current.last = key;
  const revision = ++current.revision;
  identities.get(current.link)?.set(current.projectId, { pageId: current.pageId, revision });
  current.desired = { type: "selection.set", projectId: current.projectId,
    pageId: current.pageId, revision, selection: { clipIds } };
  current.retryStep = 0;
  transmit(current);
}

/** Explicit cloud-account hookup; passing null detaches. Each page owns one ID. */
export function setSelectionLink(link: SelectionLink | null, projectId: string | null, selectionSource?: SelectionSource): void {
  if (bound) {
    const old = bound;
    clearTimers(old);
    old.attempt++;
    const revision = ++old.revision;
    identities.get(old.link)?.set(old.projectId, { pageId: old.pageId, revision });
    // A still-open link retains an online member with an empty selection.
    // A late clear cannot undo a new binding's higher-revision set.
    try { void old.link.request({ type: "selection.clear", projectId: old.projectId,
      pageId: old.pageId, revision }, 5000).catch(() => {}); } catch { /* link already closed */ }
  }
  stopStore?.();
  stopStore = null;
  source = null;
  let identity: { pageId: string; revision: number } | null = null;
  if (link && projectId) {
    let byProject = identities.get(link);
    if (!byProject) { byProject = new Map(); identities.set(link, byProject); }
    identity = byProject.get(projectId) ?? { pageId: crypto.randomUUID(), revision: 0 };
    byProject.set(projectId, identity);
  }
  bound = link && projectId && identity ? { link, projectId, pageId: identity.pageId,
    revision: identity.revision, last: "", desired: null, attempt: 0, retryStep: 0,
    retryTimer: null, hardTimer: null } : null;
  if (bound) {
    const binding = bound;
    const useSource = (provided: SelectionSource) => {
      if (bound !== binding) return;
      source = provided;
      stopStore = provided.subscribe(() => publish());
      publish(true); // Online pages with an empty selection must still be visible.
    };
    if (selectionSource) useSource(selectionSource);
    else void import("../../store/project").then(store => useSource({
      readSelection: () => store.getState().selection,
      subscribe: store.subscribe,
    }), () => {});
  }
}

/**
 * 连接换了一条(断线重连、账号项目到期前换会话):文档服务按连接记选区,新连接上只有一条合成的空选区,旧连接一关原来那条就没了。
 * 在新连接上把当前选区原样再发一次(同一个页面号、版本号加一)。不发的话别的成员和云端 Agent 看到这个页面没有选中,
 * 带选区快照给云端 Agent 发消息也会被拒(服务端要求恰好有一条这个页面号的非合成选区)。
 */
export function republishSelection(): void {
  publish(true);
}

export function selectionPresenceStatus(): { linked: boolean; pageId: string | null; revision: number; unsupported: boolean } {
  return { linked: !!bound, pageId: bound?.pageId ?? null,
    revision: bound?.revision ?? 0, unsupported: !!bound && unsupported.has(bound.link) };
}
