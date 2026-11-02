/**
 * The online page publishes the `plan` task itself (C10 contract section 7, section 18 item 9
 * [ruling]).
 *
 * The online page has no editor process. The page publishes a "manifest plan" via the document
 * service connection: a `plan` with a clip manifest, where the manifest consists of clips
 * classified as heavy by the page itself, normal tier:
 *
 *   `plan:<projectId>@<projectRev>#clips:<sig>`   `input.clips` = manifest (ascending, deduplicated)   `priority: 'normal'`
 *
 * - Do **not write** `envFingerprint` and do **not write** `preferNode` in `requires`: the online
 *   page has no prerender process and no environment of its own; the plan it publishes must be
 *   claimable by any node capable of splitting (desktop app, standalone render host), with the
 *   claiming node splitting using its own fingerprint (supplementary constraint from lead session
 *   2026-09-28; see M6c X4 modifications on the queue side).
 * - `requires.codeVersion`: the online build computes the code version at build time using the same
 *   algorithm as the render node (`frameCode` in `server/frame-code.mjs`, newlines normalized to
 *   LF) and embeds it into the page (online build in `vite.config.ts`); writes it if provided, and
 *   nodes with differing versions will not claim it; if uncomputable (dev build), omit it and rely
 *   on Section 5 "treat mismatched layer table as absent" fallback.
 * - Timing (following C6.6 timing fix): published only after measurement settles; republished after
 *   debounce on each project change (confirmed revision from document service changed); republished
 *   if manifest changes. The queue does not create a new task for the same result key; duplicate
 *   publishes only merge.
 * - `source.userId` is populated by document service based on page connection credentials;
 *   publisher self-reporting does not count (current behavior).
 * - When no node claims it, the plan waits and the page reports no error (heavy layer playback
 *   placeholders, pauses live render).
 * - Page subscribes to `task.done` (publisher automatically subscribes to self-published plan and
 *   fine-grained tasks split from it), merging into layer table and ready index: on receipt, host
 *   tells online source to refetch layer table immediately.
 * - When this page also acts as a pure browser node (M7 contract section 3.3, ruled in lead session
 *   2026-09-28): the manifest plan for this revision waits until node check-in finishes and
 *   receives `node.welcome` fingerprint before publishing, waiting at most `BROWSER_NODE_WAIT_MS`
 *   (3 s, tier-3 number), publishing anyway on timeout. When splitter claims plan, queue assigns
 *   fingerprint based on browser nodes currently online, same user, watching this project
 *   (`claude/rq-m7-queue`); publishing plan earlier means this page would miss out. The plan itself
 *   does not specify browser intent (page self-reporting does not count). Determined by
 *   `nodeReady()`; when node check-in completes, host calls `nodeChanged()`, immediately publishing
 *   waiting revision.
 * - User cards, media effect cards (Block N, `docs/plan/online-card-exec-contract.md` section 7
 *   item 3): when this page can execute synced cards and node has checked in and obtained
 *   `cardEnvFingerprint`, `input.browser` includes `{ cardEnvFingerprint, userCards, graphCards, cardSources }`
 *   (`cardSources`: card id → identity for cards successfully loaded by this page whose code identity
 *   has settled); splitter generates portions for these card types for browser accordingly. If registry
 *   changes (a card transpiled, generation change, capability changed), it becomes another plan
 *   (signature includes its digest) and is republished immediately; omitted if no such cards exist,
 *   leaving plan verbatim identical to original. Registered in `nodeCardInfo.ts`, injected via
 *   `deps.browser` or read from it by default.
 * - Host render node "generate track streams" (task brief `render-refactor-task.md` "Jia-3"): when
 *   this page sees this enabled (`deps.streams()`), the plan includes `input.streams: true` and an
 *   extra segment in signature: for the same project revision and same manifest, having this
 *   enabled represents another plan. When creator first enables it, host calls `streamsOn()` and
 *   republishes immediately: the portion published while disabled is already done, and queue will
 *   not re-split for same result key; with a changed key, render node will split again and produce
 *   its own stream tasks. When disabled (or old document service does not report it), plan is
 *   verbatim identical to original. No need to republish when transitioning from enabled to
 *   disabled (render node claim gate takes effect immediately); when multiple members are online
 *   concurrently, their republishes share the same result key, and queue keeps only one task.
 * - Stream production on this page (task brief "Jia-2", `pageStreams.ts`) needs to know "whether an
 *   online node capable of splitting has claimed this plan": `current()` returns latest
 *   successfully published revision (task id, revision, manifest, publish timestamp); `probe()`
 *   republishes the same task and reads its current status in response (`open` unclaimed, `claimed`
 *   / `done` accepted by a node, `failed`). Queue only merges for same result key; republishing
 *   does not create a new task or change its status.
 * - Before publishing each revision, calls `onPublish(version)`: host keeps confirmed project for
 *   this revision in memory accordingly (M7 D6: executing fine-grained tasks uses the task's
 *   `projectRev` revision).
 *
 * Task shape is field-by-field identical to `clipsPlanTaskOf` in `server/render-queue/messages.mjs`
 * on the queue side (verified against unit tests); duplicated here so page build does not bundle
 * server modules. This module belongs to the render layer (`src/online/`): does not import editor.
 */

/** Marker for manifest plan result key (same as `CLIPS_KEY_MARK` in `messages.mjs`). */
export const CLIPS_KEY_MARK = "#clips:";
/** Debounce: only publish latest revision when project is modified continuously. */
export const PLAN_DEBOUNCE_MS = 800;
/**
 * When this page acts as a pure browser node, manifest plan waits at most this long for node
 * check-in to finish (receive fingerprint) (M7 contract section 3.3; tier-3 number).
 */
export const BROWSER_NODE_WAIT_MS = 3000;
/** How often to check again while waiting for node check-in. */
const NODE_WAIT_POLL_MS = 250;

/**
 * Clip manifest signature: same algorithm as `backfillSig` in `server/render-queue/messages.mjs`
 * (FNV-1a two rounds, base36).
 */
export function clipsSig(clips: readonly string[], extra?: string): string {
  const text = [...new Set(clips)].map(String).sort().join("\n") + (extra ? `\n\u0000${extra}` : "");
  const fnv = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  };
  return fnv(0x811c9dc5).toString(36) + fnv(0x2f4a7c15).toString(36);
}

/**
 * Portion in signature for "this page sees 'generate track streams' enabled", and separator between
 * additional content sections (same as `LIST_STREAMS_SIG` and `SIG_EXTRA_SEP` in `messages.mjs`).
 */
export const LIST_STREAMS_SIG = "streams=1";
const SIG_EXTRA_SEP = "\u0001";

/**
 * Manifest plan `input.browser` (same shape as result of `browserCardsOf` in
 * `server/render-queue/messages.mjs`).
 */
export interface BrowserCards {
  cardEnvFingerprint: string;
  userCards: boolean;
  graphCards: boolean;
  /** Card id → code identity */
  cardSources: Record<string, string>;
}

const HEX16 = /^[0-9a-f]{16}$/;
/**
 * Normalize: item-by-item identical to `browserCardsOf` in `messages.mjs` (fingerprint 16 lowercase
 * hex chars; card ids ascending, each with length limit, max 500 cards); returns null if invalid.
 */
export function browserCardsOf(v: unknown): BrowserCards | null {
  const o = v as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== "object" || Array.isArray(o) || typeof o.cardEnvFingerprint !== "string" || !HEX16.test(o.cardEnvFingerprint)) return null;
  const cardSources: Record<string, string> = {};
  const src = o.cardSources as Record<string, unknown> | null | undefined;
  if (src && typeof src === "object" && !Array.isArray(src)) {
    for (const id of Object.keys(src).sort().slice(0, 500)) {
      const version = src[id];
      if (id === "" || id.length > 256 || typeof version !== "string" || version === "" || version.length > 128) continue;
      cardSources[id] = version;
    }
  }
  return { cardEnvFingerprint: o.cardEnvFingerprint, userCards: o.userCards === true, graphCards: o.graphCards === true, cardSources };
}
/** Same as `browserCardsSig` in `messages.mjs`. */
export function browserCardsSig(cards: BrowserCards): string {
  return [cards.cardEnvFingerprint, cards.userCards ? 1 : 0, cards.graphCards ? 1 : 0, ...Object.keys(cards.cardSources).sort().map((id) => `${id}=${cards.cardSources[id]}`)].join("|");
}

export interface ClipsPlanTask {
  id: string;
  kind: "plan";
  resultKey: string;
  range: null;
  source: { projectId: string; projectRev: number };
  input: { clips: string[]; browser?: BrowserCards; streams?: true };
  weight: { class: "medium"; estMs: null; frames: null };
  requires: { codeVersion?: string };
  priority: "normal";
}

export function clipsPlanTask({ projectId, projectRev, clips, codeVersion, browser, streams }: { projectId: string; projectRev: number; clips: readonly string[]; codeVersion?: string | null; browser?: unknown; streams?: boolean }): ClipsPlanTask {
  const list = [...new Set(clips)].map(String).filter(Boolean).sort();
  const cards = browserCardsOf(browser);
  const on = streams === true;
  const extra = [cards ? browserCardsSig(cards) : null, on ? LIST_STREAMS_SIG : null].filter((x): x is string => x !== null).join(SIG_EXTRA_SEP);
  const resultKey = `${projectId}@${projectRev}${CLIPS_KEY_MARK}${clipsSig(list, extra || undefined)}`;
  return {
    id: `plan:${resultKey}`, kind: "plan", resultKey, range: null,
    source: { projectId, projectRev }, input: { clips: list, ...(cards ? { browser: cards } : {}), ...(on ? { streams: true as const } : {}) }, weight: { class: "medium", estMs: null, frames: null },
    requires: typeof codeVersion === "string" && codeVersion ? { codeVersion } : {}, priority: "normal",
  };
}

import { getNodeCardInfo, subscribeNodeCardInfo, type NodeCardInfo } from "./nodeCardInfo.ts";
import { tr } from "../i18n/index.ts";

/** What editor/sync/link.ts says when the link to the document service is down (in English or the interface language) */
const LINK_DOWN = ["Not connected to the document service", "The document service did not respond", "Connection lost"];

type Request = (msg: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
/** Shape of `createWsEndpoint` (only uses these two). */
export interface EndpointLike {
  send(msg: Record<string, unknown>): boolean;
  onMessage(handler: (msg: Record<string, unknown>) => void): void | (() => void);
}

export interface PlanPublisherDeps {
  /**
   * A request on document service (returns response with matching reqId); mutually exclusive with
   * `endpoint`.
   */
  request?: Request;
  endpoint?: EndpointLike;
  publisherId?: string;
  /** Clips classified as heavy by the page itself at this moment (manifest); not published if empty. */
  clips?: () => readonly string[];
  codeVersion?: string | null;
  debounceMs?: number;
  /** Receives `task.done` / `task.failed` from the queue (forwarded here only in `endpoint` mode; host handles directly in `request` mode) */
  onTaskEvent?: (msg: Record<string, unknown>) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
  /**
   * Whether this page's pure browser node has checked in (M7): `"none"` this page does not act as
   * a node (publish as usual); `"pending"` checking in (wait, at most `BROWSER_NODE_WAIT_MS`);
   * `"ready"` fingerprint obtained (publish). Omitting equals `"none"`.
   */
  nodeReady?: () => "none" | "pending" | "ready";
  /** Called before publishing this version (M7 D6: host retains confirmed project for this version) */
  onPublish?: (v: Version) => void;
  /**
   * User cards and media effect cards runnable on this page (block N): returns content required
   * by `input.browser`, or null if this page cannot execute them or node has not yet obtained
   * `cardEnvFingerprint`. Defaults to reading the registry in `nodeCardInfo.ts`.
   */
  browser?: () => unknown | null;
  /** Notification when above registry changes (subscribes, returns unsubscribe); defaults to subscribing to registry in `nodeCardInfo.ts`. Republishes on change (manifest plan signature includes its digest). */
  subscribeBrowser?: (cb: () => void) => () => void;
  /** Whether "generate track stream" for this project is currently seen as enabled on this page (both host render node and this setting are enabled); omitting equals always off */
  streams?: () => boolean;
}

/** Registry content → `input.browser`: provided only if executable on this page (has runtime version), node obtained cardEnvFingerprint, and at least one capability is declared */
export function browserCardsFromInfo(info: NodeCardInfo): BrowserCards | null {
  if (!info.cardRuntime || !info.cardEnvFingerprint || !(info.userCards || info.graphCards)) return null;
  // No runnable cards on this page: omit this entry (plan is verbatim identical to having no such feature; does not change signature for an empty registry)
  if (Object.keys(info.cardSources).length === 0) return null;
  return browserCardsOf({ cardEnvFingerprint: info.cardEnvFingerprint, userCards: info.userCards, graphCards: info.graphCards, cardSources: info.cardSources });
}

export interface Version { projectId: string | null; projectRev: number | null }

export interface PlanPublisher {
  /** Measurement settled (measured when opening project, or catch-up measurement completed): published only after this */
  measured(v: Version): void;
  /** Project modified (version confirmed by document service changed) or manifest changed: republish after debounce */
  changed(v: Version): void;
  /** Connection changed (reconnect, switch project): re-checks in, publishes as usual next time (queue is in memory only, republish after restart) */
  reset(): void;
  /** Check-in status of this page's pure browser node changed (M7): immediately publish the waiting version */
  nodeChanged(): void;
  /** "generate track stream" changed from off to on: immediately republish this version (result key includes this item, making it a different plan; no debounce, creator is waiting). No need to call when changing from on to off */
  streamsOn(): void;
  /** Latest successfully published manifest plan (used by this page to generate streams); null before first successful publish or after connection change */
  current(): { id: string; projectId: string; projectRev: number; clips: string[]; at: number } | null;
  /**
   * Queries the queue for the current status of the latest successfully published plan: republishes
   * the same task and reads `state` (`open` / `claimed` / `done` / `failed`) in the response.
   * Returns null if unavailable (never successfully published, currently publishing, connection
   * disconnected, or invalid response).
   */
  probe(): Promise<string | null>;
  dispose(): void;
  debug(): { measured: boolean; want: Version | null; last: string | null; lastClips: string[]; helloOk: boolean; nodeWaitMs: number | null; log: { at: number; id: string; clips: number; ok: boolean; error?: string; state?: string; waitedMs?: number; node?: string }[] };
}

/** endpoint → request: wait for response by reqId */
function requestOver(endpoint: EndpointLike, prefix: string, onOther?: (m: Record<string, unknown>) => void): { request: Request; stop: () => void } {
  const waiting = new Map<string, (m: Record<string, unknown>) => void>();
  let seq = 0;
  const off = endpoint.onMessage((m) => {
    const id = m?.reqId !== undefined ? String(m.reqId) : "";
    const w = id ? waiting.get(id) : undefined;
    if (w) { waiting.delete(id); w(m); return; }
    if (m?.type === "task.done" || m?.type === "task.failed") onOther?.(m);
  });
  return {
    request: (msg, timeoutMs = 15_000) => new Promise((resolve, reject) => {
      const reqId = `${prefix}-${++seq}`;
      const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error(tr("{0} did not respond", String(msg.type)))); }, timeoutMs);
      waiting.set(reqId, (m) => { clearTimeout(timer); resolve(m); });
      if (!endpoint.send({ ...msg, reqId })) { waiting.delete(reqId); clearTimeout(timer); reject(new Error("Connection lost")); }
    }),
    stop: () => { if (typeof off === "function") off(); waiting.clear(); },
  };
}

export function createPlanPublisher(deps: PlanPublisherDeps): PlanPublisher {
  const publisherId = deps.publisherId ?? `page-${Math.random().toString(36).slice(2, 10)}`;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const now = deps.now ?? Date.now;
  const debounceMs = deps.debounceMs ?? PLAN_DEBOUNCE_MS;
  const over = !deps.request && deps.endpoint ? requestOver(deps.endpoint, publisherId, deps.onTaskEvent) : null;
  const request: Request | null = deps.request ?? over?.request ?? null;
  let measuredOk = false;
  let want: Version | null = null;
  let last: string | null = null;
  /** Last successfully published manifest (probe checks "which clips the manifest contains"; task id only contains signature) */
  let lastClips: string[] = [];
  /** Last successfully published task and publish timestamp (used by `current()` and `probe()`); cleared when connection changes */
  let lastTask: ClipsPlanTask | null = null;
  let lastAt = 0;
  let helloOk = false;
  let timer: unknown = null;
  let busy = false;
  let again = false;
  let disposed = false;
  /** Timestamp since when this page's node check-in has been awaited (this version not yet published); null = not waiting */
  let waitSince: number | null = null;
  // Runnable cards on this page changed: same manifest becomes a different plan (signature includes its digest); republish after debounce
  const offBrowser = (deps.subscribeBrowser ?? subscribeNodeCardInfo)(() => { if (!disposed && measuredOk && want) schedule(); });
  const log: ReturnType<PlanPublisher["debug"]>["log"] = [];
  const note = (e: (typeof log)[number]) => { log.push(e); if (log.length > 20) log.splice(0, log.length - 20); };

  const publish = async () => {
    timer = null;
    if (disposed || !measuredOk || !want || !request) return;
    if (busy) { again = true; return; }
    const { projectId, projectRev } = want;
    if (!projectId || !Number.isSafeInteger(projectRev)) return;
    const clips = [...(deps.clips?.() ?? [])];
    if (!clips.length) return;
    let browser: unknown = null;
    try { browser = deps.browser ? deps.browser() : browserCardsFromInfo(getNodeCardInfo(now())); } catch { browser = null; }
    let streams = false;
    try { streams = deps.streams?.() === true; } catch { streams = false; }
    const task = clipsPlanTask({ projectId, projectRev: projectRev as number, clips, codeVersion: deps.codeVersion ?? null, browser, streams });
    if (task.id === last) return;
    // M7: When this page acts as a pure browser node, wait for it to check in (obtain fingerprint), up to BROWSER_NODE_WAIT_MS; publish as usual on timeout
    const node = deps.nodeReady?.() ?? "none";
    let waitedMs: number | undefined;
    if (node === "pending") {
      if (waitSince === null) waitSince = now();
      const left = BROWSER_NODE_WAIT_MS - (now() - waitSince);
      if (left > 0) {
        if (timer !== null) clearTimer(timer);
        timer = setTimer(() => { void publish(); }, Math.min(left, NODE_WAIT_POLL_MS));
        return;
      }
    }
    if (waitSince !== null) { waitedMs = now() - waitSince; waitSince = null; }
    busy = true;
    try {
      if (!helloOk) {
        const hello = await request({ type: "publisher.hello", publisherId });
        if (hello?.type !== "publisher.welcome") throw new Error(`publisher.hello:${String(hello?.reason ?? hello?.type ?? "no-reply")}`);
        helloOk = true;
      }
      try { deps.onPublish?.({ projectId, projectRev }); } catch { /* Host failure does not affect publishing */ }
      const reply = await request({ type: "task.publish", tasks: [task] });
      if (reply?.type !== "task.published") {
        helloOk = false;
        throw new Error(`task.publish:${String(reply?.reason ?? reply?.type ?? "no-reply")}`);
      }
      const results = Array.isArray(reply.results) ? (reply.results as { id?: string; error?: string; state?: string }[]) : [];
      const r = results.find((x) => x?.id === task.id);
      if (!r || r.error) throw new Error(`task.publish:${r?.error ?? "no-result"}`);
      last = task.id;
      lastClips = [...task.input.clips];
      lastTask = task;
      lastAt = now();
      note({ at: now(), id: task.id, clips: clips.length, ok: true, state: r.state, node, ...(waitedMs !== undefined ? { waitedMs } : {}) });
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      if (LINK_DOWN.some((m) => error.includes(m) || error.includes(tr(m)))) helloOk = false;
      // Unclaimed or failed publish is not an error (C10 contract section 7): record it, republish on next change or next round
      note({ at: now(), id: task.id, clips: clips.length, ok: false, error });
    } finally {
      busy = false;
      // Version whose debounce expired while awaiting response (again): debounce has already elapsed, publish immediately without waiting for another debounce cycle
      if (again && !disposed) { again = false; void publish(); }
    }
  };

  const schedule = () => {
    if (disposed) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { void publish(); }, debounceMs);
  };

  return {
    measured(v) { measuredOk = true; want = { ...v }; schedule(); },
    changed(v) { want = { ...v }; if (measuredOk) schedule(); },
    reset() { helloOk = false; last = null; lastTask = null; if (measuredOk && want) schedule(); },
    nodeChanged() {
      // Version waiting for node check-in: re-evaluate immediately (publish once check-in finishes)
      if (disposed || waitSince === null || busy) return;
      if (timer !== null) clearTimer(timer);
      timer = null;
      void publish();
    },
    streamsOn() {
      if (disposed || !measuredOk || !want) return;
      if (timer !== null) clearTimer(timer);
      timer = null;
      void publish();
    },
    current() {
      const t = lastTask;
      return t ? { id: t.id, projectId: t.source.projectId, projectRev: t.source.projectRev, clips: [...t.input.clips], at: lastAt } : null;
    },
    async probe() {
      const t = lastTask;
      if (disposed || !request || !t || busy || !helloOk) return null;
      try {
        const reply = await request({ type: "task.publish", tasks: [t] });
        if (reply?.type !== "task.published" || lastTask !== t) return null;
        const results = Array.isArray(reply.results) ? (reply.results as { id?: string; error?: string; state?: string }[]) : [];
        const r = results.find((x) => x?.id === t.id);
        return r && !r.error && typeof r.state === "string" ? r.state : null;
      } catch {
        return null;
      }
    },
    dispose() {
      disposed = true;
      try { offBrowser(); } catch { /* The subscriber is broken */ }
      if (timer !== null) clearTimer(timer);
      timer = null;
      over?.stop();
    },
    debug: () => ({ measured: measuredOk, want, last, lastClips: [...lastClips], helloOk, nodeWaitMs: waitSince === null ? null : now() - waitSince, log: log.slice() }),
  };
}
