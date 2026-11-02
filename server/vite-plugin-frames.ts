import type { Plugin } from "vite";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { captureCode, frameCode, invalidateFrameCode } from "./frame-code.mjs";
import { FramePipeline } from "./frame-pipeline.mjs";
import { unpackFrameArchive } from "./frame-archive.mjs";
import { overLimit } from "./http-guard.mjs";
import { prerenderState, proxyToPrerender } from "./prerender-client.mjs";
import { isPrerender } from "./render-role.mjs";
import { prerenderModeOf, modeServesPrerender } from "./prerender-mode.mjs";

/**
 * Prerender mode of this process (`prerender-mode.mjs`; `PROMPTCUT_PRERENDER_MODE`, passed when
 * spawned by the editor process). Only meaningful in prerender processes; the editor process
 * is always `full` (its pipeline has `interactive: false`, and lacks these lanes to begin with).
 */
const prerenderMode = isPrerender ? prerenderModeOf(process.env) : "full";
/** Whether this process performs prerendering: `agent` mode does not: does not start render nodes, does not create push queues, and `/preload` returns `skipped` */
const servesPrerender = modeServesPrerender(prerenderMode);
import { ensureMirror } from "./vite-plugin-mirror";

import { latestPlayhead, reportReadySession } from "./vite-plugin-mirror";
import { readySessionOf } from "./ready-index.mjs";
import { sessionDiagOf, sessionLogger } from "./render-node/session-diag.mjs";
import { mediaSourceOf } from "./vision/ffmpeg-frames";
import { assetServiceOrigin, setMediaFallbackBases, setMediaFallbackTicket } from "./asset-client";
import { renderProject } from "./render-project.mjs";
import { resolvePublishVersion } from "./queue-publish.mjs";
import { createCardCodeIndex } from "./card-code.mjs";
import { cardCodeIdentityOf, onCardSourceChange, overridesRoot } from "./card-overrides.mjs";
import { autoRenderNodeOffReason, createAutoRenderNode } from "./auto-render-node.mjs";
import { foreignAssetEndpoints, selectAssetClient as selectAssetClientImpl } from "./asset-select.mjs";
import { setBakeRemote } from "./bake-store.mjs";
import { ALL as SCOPE_ALL, createPushScope } from "./push-scope.mjs";
import { closeStorage, createExportSummary, storageDataDir, storageFor } from "./frame-library-storage.mjs";
import { createStorageHandler, storageRouteOf } from "./storage-routes.mjs";
import { tr } from "./i18n.mjs";

const services = new Map<string, FramePipeline>();
/**
 * Card code identity (c66-host-cards, `server/card-code.mjs`): one per root. The algorithm is
 * injected by the card plugin (`setCardIdentifier`), and the entire table is cleared whenever card
 * source code changes (after Vite has invalidated the module). The whole-scene key, queue
 * splitting's `requires.cardSources`, and node `cardSourceVersions` are all retrieved from here.
 */
const cardCodes = new Map<string, ReturnType<typeof createCardCodeIndex>>();
function cardCode(root: string) {
  let index = cardCodes.get(root);
  if (!index) {
    index = createCardCodeIndex({ identityOf: (cardId: string) => cardCodeIdentityOf(cardId) });
    cardCodes.set(root, index);
  }
  return index;
}
onCardSourceChange(() => { for (const index of cardCodes.values()) index.invalidate(); });
/** C6.4: how to finalize the push queue on each frame store root (stop queue, close document service connection); roots without push queues are not here */
const pushTeardowns = new Map<string, () => Promise<void>>();

const pushLog = (event: string, fields: object = {}) => {
  // Logging after each pushed segment is too noisy (stdout of the prerender process is captured
  // by the editor process); only log queue creation, skip, retry, and error
  if (event === "push.done" || event === "push.empty") return;
  try { console.info("[artifact-push]", event, JSON.stringify(fields)); } catch { console.info("[artifact-push]", event); }
};

/**
 * Wiring at the end of C6.4 section 4 (`docs/plan/manifest-contract.md`; phase report `docs/reports/REPORT-c6-4.md`):
 * The prerender process creates push queues only when **both** conditions below are met; otherwise
 * nothing is created and behavior is identical to now: this is offline mode.
 *
 *   1. Can resolve the asset service base URL: `assetServiceOrigin()` in `asset-client.ts` (which is
 *      `PROMPTCUT_EDITOR_URL` in the prerender process), API base URL `<origin>/api/asset`; which
 *      machine to actually push to is selected per D7 (`selectAssetClient`, contract J.13);
 *   2. Can connect to document service: `resolveDocservice()` in `render-node` returns `remote`,
 *      `local`, or `editor` (M5b J.3: the instance mounted in the editor, address derived from
 *      `PROMPTCUT_EDITOR_URL`). **`editor` only counts when push is explicitly requested**
 *      (contract J.12): the process sets `PROMPTCUT_QUEUE_NODE=1` or `PROMPTCUT_PUSH=1`. When neither
 *      is set, the instance mounted in the editor does not count, no push queue is created, and
 *      other nodes' results are not pulled before preload, behaving byte-for-byte identical to
 *      before C6.4: default development environments (including user's resident editor) remain
 *      unchanged, and probes can run repeatedly in the same working copy. `remote` and `local`
 *      (explicitly configured address, or started a standalone document service) are created as before.
 *   3. `PROMPTCUT_PUSH=0`: never create, regardless of mode.
 *
 * The content store client `createContentClient` is in `render-node/index.mjs` (C6.4 node side);
 * if this function cannot be obtained, do not create either.
 * Any error in any step only logs and does not affect the prerender process.
 */
/**
 * Asset service client used for pushing and pulling (contract J.13, selects base URL per D7; see
 * `asset-select.mjs` for implementation and waiting for registration before the first call).
 * Here logs are only routed to `[artifact-push]`.
 */
function selectAssetClient(opts: { node: any; endpoint: any; origin: string; ticket: ((opts?: { refresh?: boolean }) => Promise<string | null>) | null; createAssetClient: any; owner: string;
    /** Auto render node: asset service base URL currently used by the page (if provided by the page, takes precedence before registration; fetched fresh, changes on the next call if the page changes base URL) */
    preferred?: () => string | null }) {
  return selectAssetClientImpl({ ...opts, log: pushLog });
}

/**
 * These `resolveDocservice` results count as "connected to document service"; `editor` is newly
 * added in J.3 (document service mounted in editor); `shared` is M6a shared project configuration;
 * `page` is auto render node (shared configuration supplied by the page, `auto-render-node.mjs`).
 */
const DOCSERVICE_MODES = new Set(["remote", "local", "editor", "shared", "page"]);

/**
 * `contentIds`: which project document deliverables this connection pushes (`push-scope.mjs`).
 * When entering via legacy path with `PROMPTCUT_SHARED_CONFIG` and `contentId` is specified in
 * config, it is `[contentId]`; when omitted, or for local identity (no shared project boundary),
 * unset = unlimited.
 */
type DocLink = { mode: string; url: string; tried?: any[]; protocols?: () => Promise<string[]>; shared: boolean; projectId?: string | null; contentIds?: string[] | null };

/**
 * Which document service to connect to and with what credentials to enter (M6a,
 * `docs/plan/auth-contract.md` section 11):
 *   - When `PROMPTCUT_SHARED_CONFIG` is set: use the first item in the configuration (if an
 *     array, take only the first item; multiple projects are reserved for standalone hosts),
 *     enter with proof of shared project, role `render`; asset tickets are fetched via
 *     `auth.ticket` of this connection. If config cannot be read, return `bad-config`;
 *   - When not set: probe liveness via `resolveDocservice` as before (remote → editor → local
 *     loopback), without any credentials: acts as local identity when connecting to loopback;
 *     falls back to local if connection fails. Cluster tokens are no longer used for data plane.
 */
async function resolveDocLink(node: any): Promise<DocLink | { mode: string; tried?: any[]; url?: undefined; shared: false; detail?: string }> {
  if (process.env.PROMPTCUT_SHARED_CONFIG) {
    try {
      const { loadSharedConfig, sharedProtocols }: any = await import("./auth/shared-config.mjs");
      const entries = loadSharedConfig();
      const entry = entries[0];
      return { mode: "shared", url: entry.url, protocols: sharedProtocols(entry, { role: "render" }), shared: true, projectId: entry.projectId ?? null,
        contentIds: entry.contentId ? [entry.contentId] : null };
    } catch (error: any) {
      return { mode: "bad-config", shared: false, detail: String(error?.message ?? error) };
    }
  }
  const resolved = await node.resolveDocservice();
  return { mode: resolved?.mode, url: resolved?.url, tried: resolved?.tried, shared: false };
}

/** Connections entering via shared project fetch asset tickets; local identity requires no ticket */
async function ticketFor(link: DocLink, endpoint: any) {
  if (!link.shared) return null;
  const { createTicketSource }: any = await import("./auth/ticket-source.mjs");
  return createTicketSource(endpoint, { access: "rw" });
}
/**
 * In logs output by the endpoint to document service (`createDocEndpoint`, HT-a contract
 * `docs/plan/http-transport-contract.md` section 9), session events (established, ended, detached,
 * resumed, resume rejected, failed to establish, etc., `SESSION_FORWARD_EVENTS` in
 * `render-node/session-diag.mjs`) are throttled per event and fed into the prerender process
 * log, prefixed with `[queue-node] docservice.session.*` / `[artifact-push] docservice.session.*`;
 * the editor process (`vite-plugin-prerender.ts`) forwards these lines into its own log, and the
 * standalone render host (`cloud/scripts/render-host.mjs`) likewise forwards `[queue-node]`
 * lines. Disconnects and resumes of the transport only enter logs and diagnostics, and do not
 * interrupt the queue.
 */
/** Session state in diagnostics: actual transport used (null when detached), resume count, whether degraded against an old server, plus session count `session` */
const sessionDiag = (endpoint: any) => sessionDiagOf(endpoint);
/**
 * Which document services the push queue recognizes (contract J.12): `remote` and `local` are
 * always recognized; `editor` is recognized only when push is explicitly requested:
 * `PROMPTCUT_QUEUE_NODE=1` or `PROMPTCUT_PUSH=1`.
 */
const pushModeAllowed = (mode: unknown) => mode === "remote" || mode === "local" || mode === "shared"
  || (mode === "editor" && (process.env.PROMPTCUT_QUEUE_NODE === "1" || process.env.PROMPTCUT_PUSH === "1"));
async function startArtifactPush(root: string, service: FramePipeline, auto: AutoLink | null = null) {
  if (!isPrerender) return;
  if (process.env.PROMPTCUT_PUSH === "0") return pushLog("push.skip", { reason: "disabled" });
  // M6b: standalone render hosts have no page and do no preload; deliverables are pushed by each
  // project node's sink (contract render-host-contract section 3 "Deliverables")
  if (hostProfile()) return pushLog("push.skip", { reason: "host-profile" });
  const origin = assetServiceOrigin();
  if (!origin) return pushLog("push.skip", { reason: "no-asset-service" });
  const node: any = await import("./render-node/index.mjs");
  if (typeof node.createContentClient !== "function") return pushLog("push.skip", { reason: "no-content-client" });
  /*
   * Which document service to connect to: auto render node (shared configuration supplied by the
   * page, `auto-render-node.mjs`) uses it directly; otherwise resolves from environment variables
   * as before (the toggle in J.12 only controls this branch).
   */
  let resolved: any;
  if (auto) resolved = autoDocLink(auto);
  else {
    resolved = await resolveDocLink(node);
    if (resolved.mode === "bad-config") return pushLog("push.skip", { reason: "bad-shared-config", detail: (resolved as any).detail });
    if (!DOCSERVICE_MODES.has(resolved?.mode) || !resolved.url) {
      return pushLog("push.skip", { reason: "docservice-offline", tried: (resolved?.tried ?? []).map((t: any) => ({ url: t.url, ok: t.ok, reason: t.reason })) });
    }
    // J.12: document service mounted in the editor; do not create unless push is explicitly
    // requested (identical to before C6.4 when toggle is off)
    if (!pushModeAllowed(resolved.mode)) return pushLog("push.skip", { reason: "editor-docservice-not-enabled", mode: resolved.mode });
  }
  if (services.get(root) !== service || (service as any).closed || (auto && !auto.alive())) return;
  const link = resolved as DocLink;
  const endpoint = node.createDocEndpoint({ url: link.url, ...(link.protocols ? { protocols: link.protocols } : {}),
    log: sessionLogger((event: string, fields: object) => pushLog(`docservice.${event}`, fields)) });
  const content = node.createContentClient(endpoint);
  const { createAssetClient }: any = await import("./asset-store/client.mjs");
  // J.13: select asset service to push to per D7 (environment variable → provided by page
  // (auto render node) → registered by other machines → local)
  // Wait for registration before the first push (when there is no environment variable and
  // the page provided no base URL); do not push to the local asset service first (`asset-select.mjs`)
  const assets = selectAssetClient({ node, endpoint, origin, ticket: await ticketFor(link, endpoint), createAssetClient, owner: "push", preferred: auto ? auto.assetBase : undefined });
  const client = assets.client;
  const { createPushQueue }: any = await import("./artifact-push.mjs");
  // Only push for bound projects (`push-scope.mjs`): auto render nodes follow the project document
  // id supplied by the page (hold off while not yet supplied); legacy path uses `contentId` from config
  const scoped = scopeOf(link, auto);
  const scope = scoped ? createPushScope({ pipeline: service, contentIds: scoped }) : null;
  // settleMs: wait 1.5 s after the last enqueue of the same segment before pushing, preventing a
  // segment from being pushed dozens of times during concurrent render-and-push.
  // Project-scoped queue files are partitioned into directories by project: segments not fully
  // pushed upon teardown are kept for the same project to resume next time, not pushed to other
  // projects' asset services
  const queue = createPushQueue({ pipeline: service, client, content, dir: scoped && link.projectId ? pushDirOf(service, link.url, link.projectId) : service.root,
    log: pushLog, settleMs: 1500, scope });
  queue.start();
  /*
   * Card snapshots (bake_card, textures in 3D view) are also prerender deliverables: after writing
   * to the local asset service, push another copy to this machine (`bake-store.mjs`).
   * When the selected target is the local asset service, bake-store skips automatically.
   */
  const bakeRemote = { get base() { return assets.base(); }, put: (ns: string, bytes: Buffer, o?: any) => client.put(ns, bytes, o) };
  setBakeRemote(() => bakeRemote);
  pushTeardowns.set(root, async () => {
    setBakeRemote(null);
    try { await queue.stop(); } catch {}
    if ((service as any).pushQueue === queue) (service as any).pushQueue = null;
    assets.stop();
    try { endpoint.close(); } catch {}
  });
  pushLog("push.started", { docservice: resolved.mode, url: resolved.url, asset: assets.base(), assetSettled: assets.settled(), restored: queue.stats().restored,
    scope: scope ? scope.describe() : SCOPE_ALL, ...(link.projectId ? { projectId: link.projectId } : {}) });
}

/**
 * Which project document deliverables the push queue pushes; returning null = unlimited.
 *   - Auto render node: project document id supplied by the page (`contentId`, read fresh;
 *     returns null when not yet supplied, and push queue holds off);
 *   - Legacy path entering via `PROMPTCUT_SHARED_CONFIG`: `contentId` from config; unlimited
 *     if omitted (logs a line of `push.scope`);
 *   - Local identity (`editor` / `local` / `remote`, no shared project boundary): unlimited.
 */
function scopeOf(link: DocLink, auto: AutoLink | null): (() => typeof SCOPE_ALL | string[] | null) | null {
  if (auto) return () => (auto.contentId ? [auto.contentId] : null);
  if (link.shared && link.contentIds?.length) { const ids = [...link.contentIds]; return () => ids; }
  if (link.shared) pushLog("push.scope", { scope: SCOPE_ALL, reason: "no-content-id", projectId: link.projectId ?? null });
  return null;
}

/** Link supplied by auto render node (`link` in `auto-render-node.mjs`) */
type AutoLink = { mode: "page"; url: string; shared: true; projectId: string; contentId: string | null; assetBase: () => string | null; protocols: () => Promise<string[]>; alive: () => boolean };
const autoDocLink = (auto: AutoLink): DocLink => ({ mode: "page", url: auto.url, protocols: auto.protocols, shared: true, projectId: auto.projectId });
/** Directory of project-scoped push queue files: `push/<docservice host>-<project id>` under frame store (only safe characters kept); same rule for auto render nodes and legacy path */
function pushDirOf(service: FramePipeline, url: string, projectId: string) {
  let host = "doc";
  try { host = new URL(url).host; } catch { /* Address has already been validated */ }
  const name = `${host}-${projectId}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
  return path.join((service as any).root, "push", name);
}

/* ======================================================================== *
 * Prerender process in queue mode (contract `docs/plan/render-queue-contract.md` J.5)
 * ======================================================================== */

/** Toggle: `PROMPTCUT_QUEUE_NODE=1`, off by default. When off, none of the items below are created, behaving exactly the same as now */
const queueNodeSwitch = () => process.env.PROMPTCUT_QUEUE_NODE === "1";
/**
 * M6b (`docs/plan/render-host-contract.md`): when `PROMPTCUT_NODE_PROFILE=host`, this prerender
 * process is a standalone render host: node `profile: 'host'`, one `render` connection and one
 * node per item in `PROMPTCUT_SHARED_CONFIG`, neither publishing nor claiming `plan`.
 * All other values (including unset) are local PC nodes, with behavior identical to M6a.
 */
const hostProfile = () => process.env.PROMPTCUT_NODE_PROFILE === "host";
/**
 * Test toggle (used by M6b probe H2): the code version reported externally by the host node
 * uses this value instead of taking `frameCode(root)`.
 * Only affects `codeVersions` for `profile: 'host'` (local PC nodes and frame store keys ignore
 * it). Unset in production.
 */
const TEST_CODE_VERSION_ENV = "PROMPTCUT_TEST_CODE_VERSION";
/** projectId recognized by the document service project module (`PROJECT_ID_RE` in `docservice/modules/project.mjs`) */
const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** Maximum wait time for `task.published` after publishing `plan` */
const PUBLISH_TIMEOUT_MS = 10_000;
/** Node tick: lease renewal, claim, and yielding are all evaluated in this tick */
const QUEUE_TICK_MS = 500;
/** Retain this many recent events in diagnostics */
const QUEUE_LOG = 80;
/** Number of claim sequence entries in diagnostics (`claims`, used for acceptance check in c10a contract section 17) */
const CLAIM_LOG = 400;
/** Maximum number of task IDs claimed / completed by local nodes retained per category in diagnostics */
const MINE_MAX = 5000;

const queueLog = (event: string, fields: object = {}) => {
  try { console.info("[queue-node]", event, JSON.stringify(fields)); } catch { console.info("[queue-node]", event); }
};

/**
 * Per-task finalize events enter the log (`docs/archive/agent-reports/AGENT-stall-phases.md`):
 * each of `lost` / `failed` / `discarded` / `completed` / `dedup` from local-node logs one line
 * `[queue-node] node.task-<type> {…}`, with timestamp, task id, reason, current phase, ms since
 * the last frame count change, and ms since claim; the push phase additionally includes chunk count
 * and elapsed time (task-runner `info`). The editor process forwarder (`createSessionLineForwarder`
 * in `session-diag.mjs`) allows these lines, visible in both standalone render host logs
 * (`cloud/scripts/render-host.mjs`) and PC editor logs. Contains only diagnostic fields, without
 * session numbers, tickets, or passphrases.
 */
const TASK_LOG_TYPES = new Set(["lost", "failed", "superseded", "discarded", "completed", "dedup"]);
function taskEventLog(event: any, extra: object = {}) {
  const type = event?.type;
  if (!TASK_LOG_TYPES.has(type)) return;
  const pick: Record<string, unknown> = { at: new Date().toISOString(), id: typeof event.id === "string" ? event.id : null, ...extra };
  for (const k of ["reason", "error", "why", "retryable", "phase", "detail", "done", "sinceDoneMs", "sinceClaimMs", "phaseMs", "push"]) {
    if (event[k] !== undefined) pick[k] = typeof event[k] === "string" ? event[k].slice(0, 300) : event[k];
  }
  queueLog(`node.task-${type}`, pick);
}

type QueueNode = {
  /** Connected to document service and local node has checked in: `/preload` uses queue mode */
  active(): boolean;
  /**
   * The queue half of `/preload`: set version, publish `plan`. Returns true = this version is handed
   * over to the queue; false = produce locally on this machine.
   * `entryKey`: entry for this version (M6c X1 gap: when the splitter cuts out no stream tasks, hand
   * this version's streams back to this machine for automatic production)
   * `raw` is the as-is project pushed from the page (`project` is after `renderProject`): compare it
   * against the canonical copy when the project has a canonical copy in the document service (C6.5).
   */
  publish(session: string, project: any, entryKey?: string, raw?: any): Promise<boolean>;
  describe(): object;
  /** `GET /api/frames/queue` (contract render-host-contract section 3 "Diagnostics"): `{ nodes, codeVersion, envFingerprint, maxConcurrent }` */
  summary(): object;
  /** `POST /api/frames/queue/release`: yield all held claims, stop nodes, close connections (called before host exit). Returns count of yielded items */
  release(): Promise<number>;
  close(): Promise<void>;
};
const queueNodes = new Map<string, QueueNode>();
/**
 * M6c X5: timestamp of the most recent interactive frame request for each frame store root (`user`
 * lane of `/see`, `/playback`). Read by the local queue node's idle gate (`queue-idle.mjs`): if one
 * occurred within the last 500 ms, do not claim new tasks. When switch is off, it only records
 * a count and does nothing else.
 */
const lastInteraction = new Map<string, number>();
const noteInteraction = (root: string) => { lastInteraction.set(root, Date.now()); };

/**
 * Capabilities reported in `node.hello` by local nodes (PC and standalone render host)
 * (M6c X1, `docs/plan/m6c-contract.md`):
 *   - `userCards: true, graphCards: false`: same as M5b / M6b;
 *   - `streams`: reported truthfully: true only if the prerender pipeline has track stream
 *     producers, the switch is on (`PROMPTCUT_STREAMS` is not 0), and a usable H.264 encoder was
 *     probed (`FramePipeline.streamCapable`, probed only once per process);
 *   - `transcode`: same criterion as `streams` (ffmpeg is available locally and encoder is usable).
 *     Node-side filter rule 2 checks both `requires.capabilities.streams` and transcode capability
 *     (B.2) for stream tasks; nodes reporting only `streams` cannot claim stream tasks.
 */
async function nodeCapabilities(service: FramePipeline) {
  let streams = false;
  try { streams = (await (service as any).streamCapable?.()) === true; } catch { streams = false; }
  return { userCards: true, graphCards: false, transcode: streams, streams };
}

/**
 * J.5: when switch is on and document service is reachable, start a local render node in the
 * prerender process and publish `plan` on behalf of the page.
 *
 *   - Node: `createLocalNode` (`profile: 'pc'`, `maxConcurrent: 1`, `capabilities` see
 *     `nodeCapabilities` (includes `streams` starting from M6c X1),
 *     `codeVersions: [frameCode(root)]`; environment fingerprint is probed by leasing a stream
 *     bakery once before check-in); executor is J.4's `createPrerenderExecutor`, asset sink is
 *     C6.2 / C6.4's `createAssetSink({ pipeline, client, content })`;
 *   - Publish: `/preload` calls `publish` before `service.preload(…, { queue: true })`:
 *     `project.announce` gets `projectRev`, `putSnapshot` uploads snapshot, publishes
 *     `plan:<projectId>@<projectRev>` as this node's publisher identity (`requires` carries version
 *     and fingerprint); when the project has a canonical copy in the document service (C6.5), do
 *     not assign a number or upload, publish with the canonical rev (`server/queue-publish.mjs`);
 *   - Receiving `task.done`: manifest of the fine-grained task is pulled and published via C6.2's
 *     `applyResult` (items produced locally are already on disk, treated as "skip if exists");
 *   - Cannot connect to document service (disconnected): `service.leaveQueueMode()` falls back to
 *     producing locally on this machine, yielding running tasks; after reconnecting, new preload
 *     uses the queue again;
 *   - Remote media fallback (J.6): subscribe to `asset` in service address registrations, exclude
 *     self, fill into `setMediaFallbackBases`.
 *
 * M6c (`docs/plan/m6c-contract.md`):
 *   - X2: after `executor.plan`, add local-tier capability gate (`queue-local-media.mjs`) based on
 *     this version's project: fine-grained tasks using media without content hashes are only given
 *     to the publisher's node;
 *   - X4: when publishing `plan`, `requires.preferNode` = local node (the queue gives it an
 *     exclusive window of `PLAN_PREFER_MS`);
 *   - X5: replace idle gate with `queue-idle.mjs` (can claim as long as no interactive frame
 *     requests in the last 500 ms, without waiting for preload to become ready); when busy, do not
 *     claim new tasks, finish what is currently being worked on.
 *
 * `createProjectClient` (J.2) is in `render-node/index.mjs`; if it cannot be retrieved (svc branch
 * not merged yet), do not start, log it, and prerender process runs along the original path.
 * If any step fails, only log it.
 */
async function startQueueNode(root: string, service: FramePipeline, auto: AutoLink | null = null) {
  // Auto render node (shared configuration passed from page) ignores `PROMPTCUT_QUEUE_NODE`:
  // governed by switch in `auto-render-node.mjs`
  if (!isPrerender || (!auto && !queueNodeSwitch())) return;
  const stale = () => services.get(root) !== service || (service as any).closed || (auto !== null && !auto.alive());
  const origin = assetServiceOrigin();
  if (!origin) return queueLog("queue.skip", { reason: "no-asset-service" });
  const node: any = await import("./render-node/index.mjs");
  const missing = ["createProjectClient", "createContentClient", "createLocalNode", "createDocEndpoint", "planTaskOf", "watchServiceEndpoints"]
    .filter(name => typeof node[name] !== "function");
  if (missing.length) return queueLog("queue.skip", { reason: "render-node-exports-missing", missing });
  if (hostProfile() && !auto) return startHostNode(root, service, node, origin);
  const resolved: any = auto ? autoDocLink(auto) : await resolveDocLink(node);
  if (resolved.mode === "bad-config") return queueLog("queue.skip", { reason: "bad-shared-config", detail: (resolved as any).detail });
  if (!DOCSERVICE_MODES.has(resolved?.mode) || !resolved.url) {
    return queueLog("queue.skip", { reason: "docservice-offline", tried: (resolved?.tried ?? []).map((t: any) => ({ url: t.url, ok: t.ok, reason: t.reason })) });
  }
  if (stale()) return;
  const link = resolved as DocLink;
  /** Which project documents to publish plan for (same scope as push queue, `scopeOf`); null = unlimited */
  const publishScope = auto ? () => (auto.contentId ? [auto.contentId] : null)
    : link.shared && link.contentIds?.length ? (() => { const ids = [...link.contentIds!]; return () => ids; })() : null;
  const outOfScopePublishLogged = new Set<string>();

  // Fingerprint: lease a stream bakery once to probe before check-in (starting `leaseStreamBakery`
  // sets this process's environment), release without doing anything
  try {
    const bakery = await (service as any).leaseStreamBakery();
    (service as any).returnStreamBakery(bakery);
  } catch (error: any) {
    return queueLog("queue.skip", { reason: "no-environment", message: String(error?.message ?? error) });
  }
  const envFingerprint: string | null = (service as any).envFingerprint;
  if (!envFingerprint) return queueLog("queue.skip", { reason: "no-environment" });
  if (stale()) return;
  const capabilities = await nodeCapabilities(service);
  if (stale()) return;

  const { createPrerenderExecutor }: any = await import("./prerender-executor.mjs");
  const { createAssetSink, applyResult }: any = await import("./artifact-transfer.mjs");
  const { createAssetClient }: any = await import("./asset-store/client.mjs");

  const endpoint = node.createDocEndpoint({ url: link.url, ...(link.protocols ? { protocols: link.protocols } : {}),
    log: sessionLogger((event: string, fields: object) => queueLog(`docservice.${event}`, fields)) });
  const projects = node.createProjectClient(endpoint);
  const content = node.createContentClient(endpoint);
  // J.13: sink push and task.done pull both use the asset service selected according to D7
  const assetTicket = await ticketFor(link, endpoint);
  const assets = selectAssetClient({ node, endpoint, origin, ticket: assetTicket, createAssetClient, owner: "queue", preferred: auto ? auto.assetBase : undefined });
  // J.6 fallback reads asset services on other machines: carries ticket when entering via shared project
  setMediaFallbackTicket(assetTicket ? () => assetTicket() : null);
  const client = assets.client;
  const events: object[] = [];
  const note = (event: string, fields: object = {}) => {
    events.push({ at: Date.now(), event, ...fields });
    while (events.length > QUEUE_LOG) events.shift();
  };
  const log = (event: string, fields: object = {}) => { note(event, fields); if (!/^executor\.render$/.test(event)) queueLog(event, fields); };
  const sink = createAssetSink({ pipeline: service, client, content, log });
  const baseExecutor = createPrerenderExecutor({ pipeline: service, projects, prepareProject: renderProject, log, codeStamp: () => cardCode(root).epoch });
  const host = String(os.hostname() || "host").replace(/[^A-Za-z0-9._:-]/g, "-");
  let editorPort = "";
  try { editorPort = new URL(origin).port; } catch { /* Omit if there is no port */ }
  // Multiple editors on the same machine may each have a prerender process: distinguish node identity by editor port
  const nodeId = `prerender:${host}${editorPort ? `:${editorPort}` : ""}`.slice(0, 128);
  const { withLocalMedia }: any = await import("./queue-local-media.mjs");
  const { createQueueIdleGate }: any = await import("./queue-idle.mjs");
  /**
   * M6c X2: after computing plan, add local-tier capability gate to PlanContext based on the project in
   * this version's entry: when there are assets without content hashes, fine-grained tasks using them
   * set `requires.localMedia = <plan publisher>` (asset is local to publisher; PC node publisher id
   * is its nodeId). Executor itself does not change (`plan-mismatch` in `prerender-executor.mjs`
   * provides fallback as usual).
   */
  const executor = {
    ...baseExecutor,
    plan: async (planTask: any, opts: any) => {
      const ctx = await baseExecutor.plan(planTask, opts);
      const project = (service as any).entries?.get(ctx?.entryKey)?.project;
      const owner = typeof planTask?.source?.publisher?.id === "string" ? planTask.source.publisher.id : nodeId;
      const gated = withLocalMedia(ctx, { project, owner });
      if (gated !== ctx) log("queue.local-media", { planId: planTask?.id ?? null, owner });
      return gated;
    },
  };
  /**
   * M6c X5 idle gate: claims fine-grained tasks when executor has an open slot (session guards
   * maxConcurrent itself) and there were no interactive frame requests in the last 500 ms, no longer
   * waiting for preload to reach ready. Do not claim new tasks during playback or scrubbing; finish
   * what is currently being worked on (no longer yieldAll).
   */
  const idleGate = createQueueIdleGate({ pipeline: service, lastInteractionAt: () => lastInteraction.get(root) ?? -Infinity });
  /**
   * Claim gate (`queue-agent-spare.mjs`; `mechanism/rendering.md` "Agent priority is just
   * queue-jumping"): when Agent dedicated instance is running and idle, and `'queue'` prerender
   * bakery is currently working on one item, claim an extra snapshot task for the dedicated instance.
   * Do not claim extra when dedicated instance is not running.
   */
  const { createAgentSpareGate }: any = await import("./queue-agent-spare.mjs");
  const spareGate = createAgentSpareGate({ pipeline: service, base: 1 });
  /** Evidence for X5 (diagnostic `queue.firstClaims`): status of each preload generation upon first claim of plan / fine-grained tasks */
  const firstClaims: { plan: object | null, fine: object | null } = { plan: null, fine: null };
  const preloadStatuses = () => [...((service as any).generations?.values?.() ?? [])].map((g: any) => ({
    key: String(g?.key ?? "").slice(0, 12), status: (service as any).entries?.get(g?.key)?.status ?? null, aborted: g?.controller?.signal?.aborted === true,
  }));

  /** Read endpoint for diagnostics and queue-mode-probe */
  const stats = { claimed: 0, completed: 0, dedup: 0, failed: 0, discarded: 0, lost: 0, planSplit: 0, done: 0, failedTasks: 0, applied: 0, applyErrors: 0,
    written: 0, fetched: 0, skipped: 0 };
  const taskState = new Map<string, { state: string, at: number, error?: string }>();
  /** M6b probe H1: how many times `task.done` is received per task (must be exactly once) */
  const doneCounts = new Map<string, number>();
  const planDerived = new Map<string, string[]>();
  /**
   * Task ids claimed and completed by the local node itself (diagnostic `queue.local`): distinguishes
   * which work was done by this machine during W4 cross-machine execution.
   * `claimed` is taken from `task.claimed` sent to this connection, the rest from local-node `onEvent`.
   * Keep at most MINE_MAX per category.
   */
  const mine = { claimed: new Set<string>(), completed: new Set<string>(), dedup: new Set<string>(), failed: new Set<string>() };
  /**
   * Order of claims (c10a contract section 17 acceptance check: prerender retry fine-grained tasks
   * are queued after tasks classified as heavy on this machine): record id, timestamp, priority for
   * each `task.claimed`, keeping at most CLAIM_LOG entries. Visible only to diagnostics and
   * c10a-demo-probe.
   */
  const claimLog: { id: string, at: number, priority: unknown }[] = [];
  const remember = (set: Set<string>, id: unknown) => {
    if (typeof id !== "string") return;
    set.delete(id); set.add(id);
    while (set.size > MINE_MAX) set.delete(set.values().next().value as string);
  };
  /** `<projectId>\0<digest>` → published version */
  const published = new Map<string, { projectId: string, projectRev: number, planId: string, digest: string, at: number, entryKey?: string }>();
  /**
   * M6c X1 gap (integration ruling, m6c-contract "Integration ruling"): the plan published by this
   * node completed, but the splitter cut out no stream tasks at all (streams are disabled on it or
   * no encoder was probed), while this machine can produce streams: this version's streams are
   * returned to this machine for automatic production (without going through queue), while snapshots
   * still go through the queue as usual.
   */
  const streamsFallback = (planId: string, derived: unknown) => {
    if (capabilities.streams !== true || !Array.isArray(derived)) return;
    if (derived.some(id => typeof id === "string" && id.startsWith("stream:"))) return;
    for (const record of published.values()) {
      if (record.planId !== planId || !record.entryKey) continue;
      const released = (service as any).releaseQueueStreams?.(record.entryKey) ?? 0;
      if (released) log("queue.streams-local", { planId, entryKey: record.entryKey.slice(0, 12), derived: derived.length });
    }
  };

  let codeVersion: string = frameCode(root);
  /** For testing only (M7 contract D15): only split, do not claim fine-grained tasks */
  const testPlanOnly: boolean = typeof node.testPlanOnly === "function" && node.testPlanOnly(process.env) === true;
  if (testPlanOnly) log("queue.test-plan-only", { nodeId });
  let localNode: any = null;
  let started = false;
  let closed = false;
  const buildNode = () => {
    localNode?.stop();
    localNode = node.createLocalNode({
      nodeId,
      // cardSourceVersions: card code currently on this machine (on-the-fly computed view),
      // task requires.cardSources is filtered by it (c66-host-cards)
      node: { profile: "pc", envFingerprint, codeVersions: [codeVersion], capabilities, maxConcurrent: 1, cardSourceVersions: cardCode(root).view,
        // For testing only (M7 contract D15): when PROMPTCUT_TEST_PLAN_ONLY=1, only claim plan, do not
        // claim fine-grained tasks (node-side filter rule 8), avoiding competing for cards with pure
        // browser during acceptance check; not set in production
        ...(testPlanOnly ? { planOnly: true } : {}) },
      endpoint, now: Date.now, isIdle: () => idleGate.idle(), maxConcurrent: 1, codeVersion, executor: spareGate.wrap(executor), sink,
      claimLimit: spareGate.claimLimit, canClaim: spareGate.canClaim,
      // M7 D2: locker of queue lock has been idle strictly over 30 s and this card is not finished,
      // split with takeover to take over the whole card based on this machine's fingerprint
      takeoverLocked: node.idleLockTakeover,
      onEvent: (event: any) => {
        const id = event?.id;
        if (event?.type === "completed") { stats.completed++; remember(mine.completed, id); }
        else if (event?.type === "dedup") { stats.dedup++; remember(mine.dedup, id); }
        else if (event?.type === "failed") { stats.failed++; remember(mine.failed, id); }
        else if (event?.type === "discarded") stats.discarded++;
        else if (event?.type === "lost") stats.lost++;
        else if (event?.type === "plan-split") { stats.planSplit++; planDerived.set(id, [...(event.derived ?? [])]); }
        if (event?.type === "quota-paused") queueLog("render.quota", { profile: "host", projectId: event.projectId, until: event.until, detail: "Asset service returned 507 service-quota: render service output reached its capacity limit, pausing claims" });
      if (event?.type && event.type !== "publish-result") note(`node.${event.type}`, { id, ...(event.error ? { error: event.error } : {}), ...(event.derived ? { derived: event.derived.length } : {}) });
        taskEventLog(event);
      },
    });
  };
  buildNode();

  /** Messages returning from queue side: pull and publish on `task.done`, record on `task.failed` */
  let applyChain: Promise<unknown> = Promise.resolve();
  endpoint.onMessage((message: any) => {
    if (message?.type === "task.claimed") {
      stats.claimed++; remember(mine.claimed, message.id);
      if (typeof message.id === "string") {
        claimLog.push({ id: message.id, at: Date.now(), priority: message.task?.priority ?? null });
        if (claimLog.length > CLAIM_LOG) claimLog.splice(0, claimLog.length - CLAIM_LOG);
      }
      const which = typeof message.id === "string" && message.id.startsWith("plan:") ? "plan" : "fine";
      if (!firstClaims[which]) {
        firstClaims[which] = { id: message.id, at: Date.now(), preload: preloadStatuses() };
        log("queue.first-claim", { kind: which, id: message.id, preload: (firstClaims[which] as any).preload.map((p: any) => p.status) });
      }
    }
    if (message?.type === "task.done" && typeof message.id === "string") {
      stats.done++;
      doneCounts.set(message.id, (doneCounts.get(message.id) ?? 0) + 1);
      taskState.set(message.id, { state: "done", at: Date.now() });
      const result = message.result;
      if (message.id.startsWith("plan:") && Array.isArray(result?.derived)) {
        planDerived.set(message.id, [...result.derived]);
        streamsFallback(message.id, result.derived);
      }
      // Only pull fine-grained task manifests (C6.2 shape, `v: 1`); local-node before M5b did not
      // include manifests on completion; items produced locally have layers emitted by executor itself
      if (result && typeof result === "object" && result.v === 1 && (result.kind === "snapshot" || result.kind === "stream")) {
        applyChain = applyChain.catch(() => {}).then(async () => {
          try {
            const applied = await applyResult(service, client, result);
            stats.applied++; stats.written += applied?.written ?? 0; stats.fetched += applied?.fetched ?? 0; stats.skipped += applied?.skipped ?? 0;
          } catch (error: any) {
            stats.applyErrors++;
            log("queue.apply-failed", { id: message.id, code: error?.code ?? null, message: String(error?.message ?? error) });
          }
        });
      }
    } else if (message?.type === "task.failed" && typeof message.id === "string") {
      stats.failedTasks++;
      taskState.set(message.id, { state: "failed", at: Date.now(), error: String(message.error ?? "") });
      log("queue.task-failed", { id: message.id, error: message.error ?? null });
    }
  });
  const onOpen = () => {
    if (closed) return;
    // G.7 convention: check in upon (re)connecting, resume claims still held by this instance
    localNode.start(localNode.session.held().map(({ id, token }: any) => ({ id, token })));
    started = true;
    log("queue.started", { docservice: resolved.mode, url: resolved.url, nodeId, envFingerprint, codeVersion: codeVersion.slice(0, 12), capabilities });
  };
  endpoint.onOpen(onOpen);
  endpoint.onClose(() => {
    if (!started || closed) return;
    started = false;
    // J.5 "Cannot connect to document service midway": fall back to producing locally on this machine,
    // invalidate already queued tasks (yield running ones; republish new preload after reconnecting)
    published.clear();
    try { localNode.yieldAll("offline"); } catch { /* Connection is broken; release messages cannot be sent anyway */ }
    const rerun = (service as any).leaveQueueMode?.() ?? 0;
    log("queue.offline", { rerun });
  });
  // J.6: asset service addresses of other machines, excluding local (same criterion as choosing push base in J.13)
  const stopWatch = node.watchServiceEndpoints(endpoint, ["asset"], (list: any[]) => {
    const urls = foreignAssetEndpoints(list, origin).flatMap(item => item.urls);
    const bases = setMediaFallbackBases(urls);
    note("queue.media-fallback", { bases: bases.length });
  });

  const timer = setInterval(() => {
    if (closed || !started) return;
    try {
      // Code changed (modified src or pipeline): node's code version changes accordingly, check in again,
      // otherwise nobody can claim newly published tasks
      const now = frameCode(root);
      if (now !== codeVersion) {
        codeVersion = now;
        buildNode();
        localNode.start([]);
        log("queue.code-changed", { codeVersion: codeVersion.slice(0, 12) });
      }
      // M6c X5: do not claim new tasks during playback / scrubbing (idle gate governs claims), finish
      // what is currently being worked on: semantics in product/platforms.md "until the batch currently
      // being worked on is finished", no longer release running tasks via yieldAll like M5b
      localNode.tick();
    } catch (error: any) {
      note("queue.tick-error", { message: String(error?.message ?? error) });
    }
  }, QUEUE_TICK_MS);
  timer.unref?.();

  /** Publishing `plan` waits for response with same reqId (`task.published` or `error`); reqId has its own prefix, avoiding collision with local-node */
  let publishSeq = 0;
  const waiting = new Map<string, (message: any) => void>();
  endpoint.onMessage((message: any) => {
    const waiter = message?.reqId != null ? waiting.get(String(message.reqId)) : undefined;
    if (waiter && (message.type === "task.published" || message.type === "error")) waiter(message);
  });
  endpoint.onClose(() => { for (const waiter of [...waiting.values()]) waiter({ type: "error", reason: "disconnected" }); });
  const publishPlan = (task: any) => new Promise<any>((resolve, reject) => {
    const reqId = `${nodeId}#plan-${++publishSeq}`;
    const timeout = setTimeout(() => settle({ type: "error", reason: "timeout" }), PUBLISH_TIMEOUT_MS);
    const settle = (message: any) => {
      if (!waiting.has(reqId)) return;
      waiting.delete(reqId);
      clearTimeout(timeout);
      if (message.type === "task.published") resolve(message.results);
      else reject(Object.assign(new Error(`Publishing plan failed: ${message.reason}`), { code: message.reason }));
    };
    waiting.set(reqId, settle);
    if (!endpoint.send({ type: "task.publish", tasks: [task], reqId })) settle({ type: "error", reason: "disconnected" });
  });

  const handle: QueueNode = {
    active: () => started && !closed && endpoint.connected === true,
    async publish(session, project, entryKey, raw) {
      if (!handle.active()) return false;
      const projectId = typeof project?.id === "string" && PROJECT_ID_RE.test(project.id) ? project.id
        : typeof session === "string" && PROJECT_ID_RE.test(session) ? session : null;
      if (!projectId) { log("queue.publish-skip", { reason: "no-project-id" }); return false; }
      /*
       * Only publish on behalf of bound projects (`push-scope.mjs`): if plans for other local projects
       * are sent into the shared project's queue, they will be rendered by this machine or other nodes,
       * and pushed into the shared project's asset service. Those that do not belong (or if the page has
       * not provided the project document id yet) are produced locally on this machine.
       */
      const allowed = publishScope ? publishScope() : SCOPE_ALL;
      if (allowed !== SCOPE_ALL && !(Array.isArray(allowed) && typeof project?.id === "string" && allowed.includes(project.id))) {
        if (!outOfScopePublishLogged.has(String(project?.id))) {
          outOfScopePublishLogged.add(String(project?.id));
          log("queue.publish-skip", { reason: allowed === null ? "scope-pending" : "out-of-scope", projectId });
        }
        return false;
      }
      const text = JSON.stringify(project);
      const digest = createHash("sha256").update(text, "utf8").digest("hex");
      const key = `${projectId}\u0000${digest}`;
      if (published.has(key)) return true;
      try {
        /*
         * Set version (server/queue-publish.mjs): when project has no canonical copy, follow the old flow
         * to announce, assign a number, and upload snapshot; when it has a canonical copy (C6.5), no longer
         * assign a number or upload, publish with the canonical rev, and the document service sends it back
         * from the canonical copy when nodes fetch the project. If this copy pushed from page differs from
         * the canonical copy (still has unconfirmed edits), do not give it to queue; produce locally.
         */
        const version = await resolvePublishVersion({
          projects, projectId, session: session && session.length <= 128 ? session : undefined,
          text, rawText: raw === undefined ? text : JSON.stringify(raw),
        });
        if ("skip" in version) {
          log("queue.publish-skip", { projectId, reason: version.skip, bodyRev: version.projectRev });
          return false;
        }
        const { projectRev } = version;
        // M6c X4: `preferNode` = local node, only it can claim within PLAN_PREFER_MS after publishing;
        // afterwards any pc matching the fingerprint can
        const task = node.planTaskOf({ projectId, projectRev, codeVersion: frameCode(root), envFingerprint, preferNode: nodeId });
        // `planTaskOf` in J.3 writes into `requires` by itself; versions prior to merge do not recognize
        // these parameters, patched here (both are valid)
        task.requires = { ...(task.requires ?? {}), codeVersion: frameCode(root), envFingerprint, preferNode: nodeId };
        const results = await publishPlan(task);
        const result = Array.isArray(results) ? results.find((r: any) => r?.id === task.id) : null;
        if (!result || result.error) throw Object.assign(new Error(`plan was not published: ${result?.error ?? "no-result"}`), { code: result?.error ?? "no-result" });
        published.set(key, { projectId, projectRev, planId: task.id, digest, at: Date.now(), ...(entryKey ? { entryKey } : {}) });
        // plan had already completed before publish response (someone else published same version):
        // re-evaluate stream gap once based on known split results
        if (planDerived.has(task.id)) streamsFallback(task.id, planDerived.get(task.id));
        if (!taskState.has(task.id)) taskState.set(task.id, { state: result.state ?? "open", at: Date.now() });
        log("queue.published", { planId: task.id, bytes: text.length, via: version.via, state: result.state ?? null, created: result.created ?? null });
        return true;
      } catch (error: any) {
        log("queue.publish-failed", { projectId, code: error?.code ?? error?.reason ?? null, message: String(error?.message ?? error) });
        return false;
      }
    },
    describe() {
      return {
        mode: resolved.mode, url: resolved.url, connected: endpoint.connected === true, ...sessionDiag(endpoint), active: handle.active(), nodeId, envFingerprint, assetBase: assets.base(),
        codeVersion, running: localNode?.running?.() ?? [], held: localNode?.session?.held?.().map(({ id }: any) => id) ?? [],
        stats: { ...stats },
        // M6c X5: idle gate evaluation at this moment (null = can claim) and preload status on first claim
        idle: { reason: idleGate.reason(), lastInteractionAt: Number.isFinite(idleGate.lastInteractionAt) ? idleGate.lastInteractionAt : null },
        // Claim gate: whether the extra slot is open right now, how many snapshot items the executor holds
        spare: spareGate.describe(),
        firstClaims: { ...firstClaims },
        local: { nodeId, claimed: [...mine.claimed], completed: [...mine.completed], dedup: [...mine.dedup], failed: [...mine.failed] },
        claims: claimLog.slice(),
        published: [...published.values()],
        plans: Object.fromEntries(planDerived),
        tasks: Object.fromEntries(taskState),
        doneCounts: Object.fromEntries(doneCounts),
        events: events.slice(-QUEUE_LOG),
      };
    },
    summary() {
      return {
        profile: "pc",
        nodes: [{ projectId: link.projectId ?? "local", nodeId, connected: endpoint.connected === true, ...sessionDiag(endpoint), claimed: stats.claimed, completed: stats.completed,
          dedup: stats.dedup, failed: stats.failed, lost: stats.lost }],
        codeVersion, envFingerprint, maxConcurrent: 1,
      };
    },
    async release() {
      const released = closed ? 0 : (() => { try { return localNode?.yieldAll("shutdown") ?? 0; } catch { return 0; } })();
      await new Promise(resolve => setTimeout(resolve, 300));
      await handle.close();
      return released;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try { stopWatch?.(); } catch {}
      assets.stop();
      try { localNode?.stop(); } catch {}
      try { await localNode?.settled(); } catch {}
      try { endpoint.close(); } catch {}
    },
  };
  queueNodes.set(root, handle);
  // Auto render node was torn down during startup (page left the project): clean up immediately
  if (auto && !auto.alive()) {
    if (queueNodes.get(root) === handle) queueNodes.delete(root);
    await handle.close();
    return;
  }
  // Endpoint connected before attaching onOpen (rare): do a supplementary check-in
  if (endpoint.connected === true && !started) onOpen();
}

/**
 * Asset service client for a host project (contract render-host-contract section 3 "Outputs":
 * pushed to the asset service issued by that project's document service), order:
 *   1. `PROMPTCUT_ASSET_URL` (explicitly specified, for debugging);
 *   2. `asset` in `service.endpoints` on this connection: take first address of the first entry in
 *      lexicographical order of `announcerId`. Only exclude addresses with same host:port as this
 *      host editor: the host is logically another device, so `asset:<hostname>` registered by the
 *      creator on the same machine must also be recognized (PC node `foreignAssetEndpoints` excludes
 *      it as local);
 *   3. If neither: deduce same-process asset service `http(s)://<document service host>/api/asset`
 *      from document service address: LAN mode document service is attached to creator's editor,
 *      and asset service is in the same process (auth-contract section 8 last clause).
 * Does not fall back to host's own asset service: if outputs are pushed there, publisher cannot
 * pull them. Reads and writes both carry the asset ticket obtained from this connection.
 */
function hostAssetClient({ node, endpoint, docUrl, origin, ticket, createAssetClient, owner }:
  { node: any; endpoint: any; docUrl: string; origin: string | null; ticket: any; createAssetClient: any; owner: string }) {
  let derived: string | null = null;
  try {
    const u = new URL(docUrl);
    derived = `${u.protocol === "wss:" || u.protocol === "https:" ? "https:" : "http:"}//${u.host}/api/asset`;
  } catch { /* Invalid address: can only rely on registration */ }
  let selfHost = "";
  try { selfHost = origin ? new URL(origin).host : ""; } catch { /* Do not exclude if not present */ }
  let current: any = null;
  let currentBase: string | null = null;
  const use = (base: string | null, source: "env" | "announced" | "docservice") => {
    if (!base || (base === currentBase && current)) return;
    let next: any;
    try { next = createAssetClient({ base, ticket }); }
    catch (error: any) { pushLog("push.asset-base-error", { source, base, for: owner, message: String(error?.message ?? error) }); return; }
    current = next;
    currentBase = base;
    pushLog("push.asset-base", { source, base, for: owner });
  };
  const envBase = String(process.env.PROMPTCUT_ASSET_URL || "").trim().replace(/\/+$/, "");
  let stop = () => {};
  if (envBase) use(envBase, "env");
  else {
    use(derived, "docservice");
    stop = node.watchServiceEndpoints(endpoint, ["asset"], (list: any[]) => {
      const urls = [...(list ?? [])]
        .filter((item: any) => item?.kind === "asset" && typeof item.announcerId === "string")
        .sort((a: any, b: any) => (a.announcerId < b.announcerId ? -1 : a.announcerId > b.announcerId ? 1 : 0))
        .flatMap((item: any) => (item.urls ?? []).map(String))
        .filter((url: string) => { try { return new URL(url).host !== selfHost; } catch { return false; } });
      if (urls[0]) use(urls[0].replace(/\/+$/, ""), "announced");
      else use(derived, "docservice");
    });
  }
  const client = new Proxy({}, { get: (_target, key) => { const value = current?.[key]; return typeof value === "function" ? value.bind(current) : value; } });
  return { client, stop: () => { try { stop(); } catch { /* Already stopped */ } }, base: () => currentBase };
}

/**
 * M6b standalone render host (`docs/plan/render-host-contract.md` section 3; orchestrated in
 * `render-node/host.mjs`):
 *
 *   - Configuration: `PROMPTCUT_SHARED_CONFIG` (single entry or array, each entry is one shared
 *     project), `maxConcurrent` see `loadHostConfig`;
 *   - Each entry has one `render` connection (via project proof, fetch challenge upon reconnect)
 *     and one node (`profile: 'host'`, `codeVersions: [local frameCode]`, capabilities identical to
 *     PC, fingerprint probed locally);
 *   - All nodes share this process's `FramePipeline` ('queue' lane), total concurrency governed by
 *     global gate in host.mjs; executor and asset sink are per-project: project snapshots are
 *     fetched from that project's connection, outputs pushed to that project's asset service;
 *   - Does not publish `plan`, does not claim `plan` (filter rule 6), does not take `/preload`
 *     queue publishes (`active()` is always false);
 *   - Idle gate is only the global gate; disconnect and reconnect resumes held claims per G.7;
 *   - Diagnostics `GET /api/frames/queue` (`summary()`), and before exit `POST /api/frames/queue/release`
 *     (`release()`).
 *
 * Broker mode (render node on hosted side, `docs/plan/hosted-render-contract.md` section 7.1):
 * when `PROMPTCUT_RENDER_BROKER` is set, configuration files are not read; project manifests and
 * tickets for each connection are requested from management process local broker port
 * (`createBrokerClient` in `render-node/host.mjs`): reconcile once per second, connect immediately
 * to new projects in manifest, disconnect from those not in manifest after yielding claims, disconnect
 * from those marked for draining only after finishing; if management process pauses, do not claim
 * new tasks (backpressure).
 * This process holds no service private key and no project passphrases, only two-minute connection
 * tickets. Node id uses the one given in manifest.
 * `streams` for each manifest entry (whether this project currently produces track streams: render
 * node is running and "Generate track streams" is on, `hosted-render/broker.mjs`) enters `host.add`
 * with config item, updated on each reconciliation: for non-producing projects this host does not
 * claim their stream tasks, and its executor omits its share of streams when splitting manifest
 * plans (`render-node/host.mjs` file header "Whether to produce track streams per project"). Standalone
 * render hosts not using broker port lack this entry and do not manage per project.
 */
async function startHostNode(root: string, service: FramePipeline, node: any, origin: string) {
  const hostMod: any = await import("./render-node/host.mjs");
  const brokerUrl = String(process.env[hostMod.BROKER_URL_ENV] || "").trim();
  const broker: any = brokerUrl ? hostMod.createBrokerClient({ url: brokerUrl, key: String(process.env[hostMod.BROKER_KEY_ENV] || "") }) : null;
  let config: { entries: any[]; maxConcurrent: number } | null;
  if (broker) {
    try {
      const raw = process.env[hostMod.HOST_CONCURRENCY_ENV];
      config = { entries: [], maxConcurrent: raw === undefined || raw === "" ? 1 : hostMod.hostMaxConcurrent(Number(raw)) };
    } catch (error: any) { return queueLog("queue.skip", { reason: "bad-shared-config", profile: "host", detail: String(error?.message ?? error) }); }
  } else {
    try { config = hostMod.loadHostConfig(); }
    catch (error: any) { return queueLog("queue.skip", { reason: "bad-shared-config", profile: "host", detail: String(error?.message ?? error) }); }
  }
  if (!config) return queueLog("queue.skip", { reason: "no-shared-config", profile: "host" });
  if (services.get(root) !== service || (service as any).closed) return;

  // Fingerprint: same as PC node, lease a stream bakery once to probe before check-in
  try {
    const bakery = await (service as any).leaseStreamBakery();
    (service as any).returnStreamBakery(bakery);
  } catch (error: any) {
    return queueLog("queue.skip", { reason: "no-environment", profile: "host", message: String(error?.message ?? error) });
  }
  const envFingerprint: string | null = (service as any).envFingerprint;
  if (!envFingerprint) return queueLog("queue.skip", { reason: "no-environment", profile: "host" });
  if (services.get(root) !== service || (service as any).closed) return;
  // M6c X1: capabilities use same criterion as PC node (`streams` reported truthfully)
  let capabilities = await nodeCapabilities(service);
  if (services.get(root) !== service || (service as any).closed) return;

  const { sharedProtocols }: any = await import("./auth/shared-config.mjs");
  const { createTicketSource }: any = await import("./auth/ticket-source.mjs");
  const { createPrerenderExecutor }: any = await import("./prerender-executor.mjs");
  const { createAssetSink, layerMapOf, layerMapKeyOf }: any = await import("./artifact-transfer.mjs");
  const { createAssetClient }: any = await import("./asset-store/client.mjs");

  const events: object[] = [];
  const note = (event: string, fields: object = {}) => {
    events.push({ at: Date.now(), event, ...fields });
    while (events.length > QUEUE_LOG) events.shift();
  };
  const log = (event: string, fields: object = {}) => { note(event, fields); if (!/^executor\.render$/.test(event)) queueLog(event, fields); };

  /*
   * c66-host-cards: When a host joins a shared project, it pulls down user cards and modified cards
   * via content store `card-source` and loads them into its own overlay layer; when others modify
   * cards, they are synced on the spot via `content.watch` (C6.6 design doc section 5;
   * `createHostCardSync` in `vite-plugin-cards.ts`, read-only). Once loaded, the card code identity
   * changes accordingly (`cardCode(root)`), and tasks requiring this card can be claimed on the next
   * tick. When there is no overlay layer (no data directory set), syncing is disabled: that would
   * directly modify card files in the repository. Disable with `PROMPTCUT_CARD_SYNC=0`.
   */
  const cardSyncOn = process.env.PROMPTCUT_CARD_SYNC !== "0" && !!overridesRoot();
  const cardSyncDir = path.join(process.env.PROMPTCUT_DATA_DIR || path.join(root, ".pc-work"), "host-cards");
  const { createHostCardSync }: any = cardSyncOn ? await import("./vite-plugin-cards") : {};
  if (!cardSyncOn) queueLog("queue.card-sync-skip", { profile: "host", reason: process.env.PROMPTCUT_CARD_SYNC === "0" ? "disabled" : "no-overrides" });
  // Host render node: capability flags are centralized in `hostedRenderCapabilities` in
  // `render-node/host.mjs` (worker processes that do not sync cards do not report userCards)
  if (broker) capabilities = hostMod.hostedRenderCapabilities(capabilities, { cardSync: cardSyncOn });
  /*
   * User card isolation for the host render service (`docs/plan/hosted-render-contract.md`
   * section 7.5); the manager process tells worker processes which type it is via two environment
   * variables:
   *   - Resident worker process (`PROMPTCUT_HOSTED_WORKER=resident`, does not sync cards) and
   *     `PROMPTCUT_HOSTED_HOLD_CARDS=1`: For projects with `card-source` in the content store, it
   *     stays connected and watches the queue, but claims no tasks (`card-presence.mjs`), reporting
   *     "this project requires isolation, how many tasks are waiting" along with diagnostics;
   *   - Isolated worker process (`PROMPTCUT_HOSTED_WORKER=isolated`, card sync enabled): Passes sync
   *     file pre-check before loading cards (`source-gate.mjs`); does not claim until card sync
   *     finishes the first reconciliation and card code identity stabilizes (otherwise the manifest
   *     plan would be split before cards are loaded).
   * Without these two variables (desktop app, ordinary standalone render host), the three variables
   * below are empty, and the wiring is identical item by item to before.
   */
  const { buildExtensions }: any = broker ? await import("./vite-plugin-hosted-gate") : { buildExtensions: {} };
  const hostedKind: string | null = broker ? (buildExtensions.sourceGate?.hostedWorkerKind?.() ?? null) : null;
  const holdCards = hostedKind === "resident" && !cardSyncOn && process.env.PROMPTCUT_HOSTED_HOLD_CARDS === "1";
  const createCardPresence: any = holdCards ? buildExtensions.hostedRender?.createCardPresence : undefined;
  const checkSyncedSource: any = hostedKind === "isolated" ? (buildExtensions.sourceGate?.checkSyncedSource ?? (() => ({ ok: true, errors: [] }))) : undefined;
  const hostedGateStatus: any = hostedKind ? buildExtensions.hostedRender?.hostedGateStatus : undefined;
  if (hostedKind) queueLog("queue.hosted-worker", { kind: hostedKind, cardSync: cardSyncOn, holdCards });

  const override = String(process.env[TEST_CODE_VERSION_ENV] || "").trim() || null;
  let codeVersion: string = override ?? frameCode(root);
  const hostName = String(os.hostname() || "host").replace(/[^A-Za-z0-9._:-]/g, "-");
  let editorPort = "";
  try { editorPort = new URL(origin).port; } catch { /* Omit if there is no port */ }
  const nodeIdBase = `host:${hostName}${editorPort ? `:${editorPort}` : ""}`;

  /** Connection record for each item: used for diagnostics (failure count, asset base URL); closed on exit */
  const wired: { projectId: string | null; endpoint: any; assets: any; ticket: any; connectFailed: number; opens: number; cards: any; presence?: any; cardsSynced?: boolean; closed?: boolean }[] = [];
  const { ticketProtocols }: any = broker ? await import("./auth/client.mjs") : {};
  const host = hostMod.createRenderHost({
    entries: config.entries,
    dynamic: !!broker,
    maxConcurrent: config.maxConcurrent,
    envFingerprint,
    codeVersion,
    capabilities,
    cardSourceVersions: cardCode(root).view,
    now: Date.now,
    nodeIdOf: (entry: any, index: number) => (typeof entry?.nodeId === "string" && entry.nodeId ? entry.nodeId : `${nodeIdBase}/p${index}`).slice(0, 128),
    connect: (entry: any, index: number, live: { streams: () => boolean | null }) => {
      const rec: any = { projectId: entry.projectId ?? null, endpoint: null, assets: null, ticket: null, connectFailed: 0, opens: 0, cards: null, closed: false };
      // Proxy mode: each time a new session is created, request a connection ticket from the manager
      // process (same approach as the desktop app "page provides a render ticket each time")
      const protocols = broker
        ? async () => ticketProtocols(await broker.ticket(entry.projectId))
        : sharedProtocols(entry, { role: "render" });
      // Prints a line on each backoff when failing to connect: throttled by event (`sessionLogger`) to
      // prevent flooding the log
      const sessionLog = sessionLogger((event: string, fields: object) => queueLog(`docservice.${event}`, fields), { extra: { project: index, projectId: rec.projectId } });
      rec.endpoint = node.createDocEndpoint({ url: entry.url, protocols, log: (event: string, fields: object) => {
        if (event === "session.connect-failed") rec.connectFailed++;
        if (event === "session.open") rec.opens++;
        sessionLog(event, fields);
      } });
      const projects = node.createProjectClient(rec.endpoint);
      const content = node.createContentClient(rec.endpoint);
      rec.ticket = createTicketSource(rec.endpoint, { access: "rw" });
      rec.assets = hostAssetClient({ node, endpoint: rec.endpoint, docUrl: entry.url, origin, ticket: rec.ticket, createAssetClient, owner: `host:p${index}` });
      const sink = createAssetSink({ pipeline: service, client: rec.assets.client, content, log });
      /*
       * C10 contract section 18 item 9: When a host claims the online page's manifest plan or prerender
       * retry plan, it writes this version's layer table (`layers:<project doc id>`, which the online
       * page uses to find manifests) via this connection's content store. The host has no push queue,
       * so the pipeline's own `publishLayerMap` cannot write out.
       */
      const publishLayerMap = (entry: any) => {
        const key = layerMapKeyOf(entry?.project?.id);
        if (!key || (service as any).pushQueue) return;
        // M7 D12: Layer table v3 candidates emit keys based on the actual split (recorded by the pipeline's
        // `recordSplitCandidates`); the executor calls here only after splitting finishes
        const body = layerMapOf(entry, { picked: (clipId: string) => (service as any).prerenderPicked(entry, clipId), fingerprint: (service as any).envFingerprint,
          candidatesOf: (control: any) => (service as any).splitCandidatesFor?.(control?.contentKey) ?? null,
          // Track stream: this version's streams and their candidates (hosts do not produce streams by
          // default, in which case this is an empty object and the layer table does not include `streams`)
          ...((service as any).layerMapStreamOptions?.(entry) ?? {}) });
        void content.put("snapshot-manifest", key, body).then(
          () => log("host.layer-map", { project: index, key: key.slice(0, 24), layers: body.layers.length }),
          (error: any) => log("host.layer-map-failed", { project: index, message: String(error?.message ?? error) }),
        );
      };
      // Host render node: whether this project currently produces track streams (read on the fly; if
      // the manager process manifest changes, caught up within one tick). Other hosts are not managed
      // per-project and do not provide this
      const streamsEnabled = broker ? () => live.streams() === true : null;
      const executor = createPrerenderExecutor({ pipeline: service, projects, prepareProject: renderProject, log, codeStamp: () => cardCode(root).epoch, publishLayerMap, streamsEnabled });
      if (createHostCardSync && rec.projectId) {
        try {
          rec.cards = createHostCardSync({
            root, dataDir: cardSyncDir, projectId: rec.projectId, url: entry.url, endpoint: rec.endpoint,
            before: () => cardCode(root).touch(),
            ...(checkSyncedSource ? { precheck: (rel: string, source: string) => checkSyncedSource(rel, source, { rootHas: (p: string) => fs.existsSync(path.join(root, p)) }) } : {}),
            log: (event: string, fields: object = {}) => {
              note(event, { project: index, ...fields });
              if (/installed|rejected|backup-failed|error|skip|put-failed/.test(event)) queueLog(event, { project: index, projectId: rec.projectId, ...fields });
            },
          });
        } catch (error: any) {
          queueLog("queue.card-sync-failed", { project: index, projectId: rec.projectId, message: String(error?.message ?? error) });
        }
      }
      // Resident worker process: whether this project includes card code (lists keys only, does not fetch body)
      if (createCardPresence && rec.projectId) {
        rec.presence = createCardPresence({ endpoint: rec.endpoint, content, log: (event: string, fields: object = {}) => queueLog(event, { project: index, projectId: rec.projectId, ...fields }) });
      }
      // Isolated worker process: after each new session is created, wait until card sync finishes
      // reconciliation (all cards in the list are loaded or rejected) before allowing claims
      if (hostedKind === "isolated" && rec.cards) {
        rec.cardsSynced = false;
        const settle = () => {
          rec.cardsSynced = false;
          // Card sync's own "connected" handler is queued first (registered before this handler); here we
          // wait one tick later for its queue to drain
          setTimeout(() => { void rec.cards.idle().then(() => { if (!rec.closed) { rec.cardsSynced = true; queueLog("queue.cards-synced", { project: index, projectId: rec.projectId }); } }, () => {}); }, 200);
        };
        rec.endpoint.onOpen(settle);
        if (rec.endpoint.connected === true) settle();
      }
      const hold = rec.presence ? () => rec.presence.hold()
        : hostedKind === "isolated" ? () => !(rec.cards ? rec.cardsSynced === true : true) || !cardCode(root).settled()
        : null;
      const cardsInfo = rec.presence ? () => rec.presence.status()
        : hostedKind === "isolated" ? () => ({ state: rec.cardsSynced ? "synced" : "syncing", count: Object.keys(rec.cards?.status?.()?.records ?? {}).length })
        : null;
      wired[index] = rec;
      const close = () => {
        if (rec.closed) return;
        rec.closed = true;
        try { rec.presence?.close(); } catch { /* Closed */ }
        try { rec.cards?.close(); } catch { /* Closed */ }
        try { rec.assets.stop(); } catch { /* Stopped */ }
        try { rec.endpoint.close(); } catch { /* Closed */ }
        log("queue.project-closed", { profile: "host", project: index, projectId: rec.projectId });
      };
      return { endpoint: rec.endpoint, executor, sink, close, ...(hold ? { hold } : {}), ...(cardsInfo ? { cards: cardsInfo } : {}) };
    },
    onEvent: (event: any) => {
      if (event?.type && event.type !== "publish-result") note(`node.${event.type}`, { project: event.index, id: event.id, ...(event.error ? { error: event.error } : {}) });
      taskEventLog(event, { project: event?.index ?? null, projectId: event?.projectId ?? null });
    },
  });

  // J.6 asset fallback (reading assets from other machines): each project's asset service acts as
  // a fallback base URL; tickets are chosen by base URL, using the project belonging to that asset
  // service (tickets are valid only on the asset service that issued them; when multiple projects
  // share the same service, the earlier one in config is used; content-addressed by hash, so valid
  // tickets from any project can read)
  /** Open connection records (projects removed at runtime leave empty slots; indices are not reused) */
  const live = () => wired.filter(rec => rec && !rec.closed);
  let fallbackKey = "";
  const refreshFallback = () => {
    const bases = [...new Set(live().map(rec => rec.assets.base()).filter((b: string | null): b is string => !!b))];
    const key = JSON.stringify(bases);
    if (key === fallbackKey) return;
    fallbackKey = key;
    note("queue.media-fallback", { bases: setMediaFallbackBases(bases).length });
  };
  refreshFallback();
  setMediaFallbackTicket((base: string) => hostMod.fallbackTicketFor(live().map(rec => ({ base: () => rec.assets.base(), ticket: () => rec.ticket() })))(base));
  /*
   * Host render node (proxy mode): Cloud Agent's `bake_card` is routed here via the manager process
   * to render images (`hosted-render/look.mjs`). Card snapshots are first written into this worker
   * process's own media library, and a copy is pushed to the project's asset service (remote in
   * `bake-store.mjs`; members and other render nodes fetch from there via `/api/asset/px/<hash>`).
   * On the hosted side, all projects share the same asset service and are addressed by content hash,
   * so the client of any currently connected project is used (render service identity, writing `px`).
   * Desktop app and ordinary standalone render hosts do not go through here (they have no Agent queries).
   */
  if (broker) {
    setBakeRemote(() => {
      const rec = live().find(r => !!r.assets.base());
      return rec ? { get base() { return rec.assets.base(); }, put: (ns: string, bytes: Buffer, o?: any) => rec.assets.client.put(ns, bytes, o) } : null;
    });
  }

  let closed = false;
  let released = false;
  host.start();
  log("queue.started", { profile: "host", broker: !!broker, projects: config.entries.map((e: any) => e.projectId), maxConcurrent: host.maxConcurrent,
    envFingerprint, codeVersion: codeVersion.slice(0, 12), codeVersionOverride: override !== null, capabilities });

  // Proxy mode: reconciles with the manager process every second (project additions/removals, member
  // presence, pause status), passing along its own diagnostics
  let brokerBusy = false;
  let brokerAt = 0;
  let brokerError = "";
  const syncBroker = async () => {
    if (!broker || brokerBusy || closed || Date.now() - brokerAt < 1000) return;
    brokerBusy = true;
    brokerAt = Date.now();
    try {
      const listing = await broker.projects();
      if (closed) return;
      // `streams` is always a boolean: missing from the manifest (or not true) is treated as not producing
      const diff = hostMod.reconcileHostProjects(host, listing, (item: any) => ({ url: listing.docUrl, projectId: item.projectId, members: item.members === true, nodeId: item.nodeId, streams: item.streams === true }));
      if (diff.added.length || diff.removed.length || diff.drained.length) log("queue.broker-sync", { profile: "host", ...diff, paused: listing.paused === true });
      brokerError = "";
      void broker.report({ pid: process.pid, queue: summary() });
    } catch (error: any) {
      const message = String(error?.code ?? error?.message ?? error);
      if (message !== brokerError) { brokerError = message; log("queue.broker-error", { profile: "host", message }); }
    } finally {
      brokerBusy = false;
    }
  };

  const timer = setInterval(() => {
    if (closed) return;
    void syncBroker();
    try {
      if (override === null) {
        const now = frameCode(root);
        if (now !== codeVersion) {
          codeVersion = now;
          host.setCodeVersion(now);
          log("queue.code-changed", { profile: "host", codeVersion: codeVersion.slice(0, 12) });
        }
      }
      refreshFallback();
      for (const rec of live()) rec.presence?.tick();
      host.tick();
    } catch (error: any) {
      note("queue.tick-error", { message: String(error?.message ?? error) });
    }
  }, QUEUE_TICK_MS);
  timer.unref?.();

  const summary = () => ({
    profile: "host",
    nodes: host.nodes().map((n: any) => { const rec = wired[n.index]; return { ...n, opens: rec?.opens ?? 0, connectFailed: rec?.connectFailed ?? 0, ...sessionDiag(rec?.endpoint), assetBase: rec?.assets.base() ?? null }; }),
    codeVersion, envFingerprint, maxConcurrent: host.maxConcurrent, ...(hostedKind ? { worker: hostedKind, limit: host.limit } : {}), paused: host.paused === true, quotaPausedUntil: host.quotaPausedUntil ?? null, capabilities,
    // c66-host-cards: Card sync for each project (bookkeeping: repo-relative path → loaded cardRev)
    // and card code identity state
    cardSync: live().map((rec) => hostCardSyncSummary(rec.projectId, rec.cards)),
    cardCode: { epoch: cardCode(root).epoch, settled: cardCode(root).settled() },
    // Host worker process: how many were blocked by the page request gate and egress proxy on this
    // prerender Vite (`hosted-render/vite-gate.mjs`)
    ...(hostedGateStatus ? { pageGate: hostedGateStatus() } : {}),
  });
  const closeAll = async () => {
    clearInterval(timer);
    if (broker) setBakeRemote(null);
    for (const rec of live()) { rec.closed = true; try { rec.cards?.close(); } catch { /* Closed */ } rec.assets.stop(); try { rec.endpoint.close(); } catch { /* Closed */ } }
  };
  const handle: QueueNode = {
    active: () => false,
    publish: async () => false,
    describe: () => ({ ...summary(), busy: host.busy(), running: host.running(), events: events.slice(-QUEUE_LOG) }),
    summary,
    async release() {
      if (released || closed) return 0;
      released = true;
      closed = true;
      const count = host.shutdown("shutdown");
      log("queue.release", { profile: "host", released: count });
      // `task.release` has been handed to each connection; allow some time for them to send, then wait
      // for execution to finalize and close connections
      await new Promise(resolve => setTimeout(resolve, 300));
      await Promise.race([host.settled(), new Promise(resolve => setTimeout(resolve, 5000))]);
      await closeAll();
      return count;
    },
    async close() {
      if (!released) { released = true; try { host.shutdown("closing"); } catch { /* Stopped */ } }
      if (closed && live().length === 0) return;
      closed = true;
      await Promise.race([host.settled(), new Promise(resolve => setTimeout(resolve, 5000))]);
      await closeAll();
    },
  };
  queueNodes.set(root, handle);
}
/**
 * Card sync for a project in host diagnostics: connection state, bookkeeping (repo-relative path →
 * cardRev), recent notifications (installed, rejected)
 */
function hostCardSyncSummary(projectId: string | null, cards: any) {
  if (!cards) return { projectId, enabled: false };
  let st: any = {};
  try { st = cards.status() ?? {}; } catch { st = {}; }
  const records = Object.fromEntries(Object.entries(st.records ?? {}).map(([rel, rec]: [string, any]) => [rel, rec?.rev ?? null]));
  const notices = (Array.isArray(st.notices) ? st.notices : []).slice(-10).map((n: any) => ({ type: n?.type ?? null, key: n?.key ?? null, rev: n?.rev ?? null, at: n?.at ?? null, ...(n?.error ? { error: String(n.error).slice(0, 200) } : {}) }));
  return { projectId, enabled: true, connected: st.connected === true, opens: st.opens ?? 0, records, notices };
}
function requestSignal(req: any, res: any) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once?.("aborted", abort);
  res.once?.("close", () => { if (!res.writableEnded) abort(); });
  return controller.signal;
}
/** Export directory and frame store directory (`PROMPTCUT_EXPORT_DIR`, default `<root>/out` in dev) */
const exportRoot = (root: string) => process.env.PROMPTCUT_EXPORT_DIR || path.join(root, "out");
const libraryRoot = (root: string) => path.join(exportRoot(root), "frame-library");
const storageLog = (event: string, fields: object = {}) => {
  try { console.info("[storage]", event, JSON.stringify(fields)); } catch { console.info("[storage]", event); }
};
/**
 * Frame store usage index, cap, and eviction (storage footprint plan part B,
 * `frame-library-storage.mjs`). **Created only in the prerender process**: the editor process
 * pipeline barely writes to the frame store and forwards `/api/storage*` as is.
 * `PROMPTCUT_STORAGE_EVICT=0` only records and measures without deleting;
 * `PROMPTCUT_TEST_STORAGE_MIN_CAP` (bytes) is for testing and probes only, lowering the
 * user-configurable lower limit.
 */
function storageOf(root: string) {
  const testMin = Number(process.env.PROMPTCUT_TEST_STORAGE_MIN_CAP);
  return storageFor({ root: libraryRoot(root), dataDir: storageDataDir(root),
    ...(Number.isSafeInteger(testMin) && testMin > 0 ? { minCapBytes: testMin } : {}),
    evict: process.env.PROMPTCUT_STORAGE_EVICT !== "0", log: storageLog });
}
const exportSummaries = new Map<string, ReturnType<typeof createExportSummary>>();
function exportSummaryOf(root: string) {
  const dir = exportRoot(root);
  let summary = exportSummaries.get(dir);
  if (!summary) { summary = createExportSummary(dir); exportSummaries.set(dir, summary); }
  return summary;
}
export function frameService(root: string, origin: string) {
  root = path.resolve(root);
  let service = services.get(root);
  if (!service) {
    service = new FramePipeline({ root: libraryRoot(root), origin: () => origin,
      code: () => frameCode(root), captureCode: () => captureCode(root),
      // c66-host-cards: Global code version does not include user cards or the overlay layer; identities
      // of custom cards used in this version are computed separately (whole scene key, `requires.cardSources`)
      cardSources: (project: any) => cardCode(root).projectVersions(project),
      // Cost records and adjustable coefficients share the same root as `vite-plugin-costs` (the frame
      // store directory is not their home)
      dataRoot: root,
      /*
       * D5 `interactive` (R7 atomic switch flipped the editor process side).
       *
       * **Prerender process `true`**: The warm pool is here, renamed to `streamPool`, used for G segments
       * and C2 anchor frames; the legacy server scheduler (`acquireUser` / `updatePlayback`) for
       * `?preview=legacy` also stays here: legacy pages send `user` / `playback` lanes just as they do
       * today, but targeting the prerender origin (the default `target` for `frameClient` is already
       * `"prerender"`), and the server reads no extra toggle.
       *
       * **Editor process `false`**: No longer maintains that pair of headless Chromes. The `user` /
       * `playback` lanes immediately return `USE_PRERENDER` without entering `acquireUser`, and neither
       * `prewarmUser` is called. Page-side warm rendering is the visible stage iframe, not the same thing
       * as the Node-side warm pool (second-to-last item of general rules).
       */
      interactive: isPrerender,
      /** Prerender process mode (`user` / `agent` / `full`, see `prerender-mode.mjs`) */
      mode: prerenderMode,
      /** C4: `wanted` is read from mirror plugin (`frame-pipeline` is .mjs, mirror plugin is .ts) */
      playhead: () => latestPlayhead(),
      /**
       * Address to send HEAD to the asset service when stamping assets without content hash (base URL
       * determined by `asset-client.ts`, does not read asset catalog)
       */
      mediaUrl: (m: any) => mediaSourceOf(m),
    });
    services.set(root, service);
    /*
     * Storage footprint: prerender process pipeline connects to the frame store usage index (records
     * usage during preload, determines "open" projects by its sessions)
     */
    if (isPrerender) storageOf(root).attachPipeline(service);
    /*
     * R8: The read port for track stream segments is mounted on `/api/frames/*` below; producers only
     * start work and emit `stream` layers after the read port is attached (`StreamProducer.routeAttached`).
     * The editor process (`interactive: false`) has no producers; this is a no-op here.
     */
    service.streamProducer()?.attachRoute();
    /*
     * F5: When the prerender process starts up, it first scans the disk to rebuild "key → interval".
     * Attached only to keys without emitting `layer`: `clipId` can only be reverse-looked up after
     * the project is ready and the card plan is recomputed (`adoptCardPlan`).
     */
    void service.rescanSnapshots().catch(() => {});
    /*
     * C6.4: Creates a push queue when reachable to asset service and document service (prerender
     * process only; creates nothing if unreachable)
     */
    /* `agent` mode does not prerender: does not create push queue, does not start render nodes (two places below) */
    if (servesPrerender) void startArtifactPush(root, service).catch(error => pushLog("push.skip", { reason: "error", message: String(error?.message ?? error) }));
    else console.info(`[frames] The prerender process is in ${prerenderMode} mode: it only serves Agent queries, and does not prerender or start render nodes`);
    /*
     * J.5: Starts a local render node when `PROMPTCUT_QUEUE_NODE=1` and document service is reachable
     * (returns immediately here creating nothing when the switch is off)
     */
    if (servesPrerender && queueNodeSwitch()) void startQueueNode(root, service).catch(error => queueLog("queue.skip", { reason: "error", message: String(error?.message ?? error) }));
  }
  return service;
}
/* ======================================================================== *
 * Desktop app automatically becomes a render node for shared projects
 * (semantics product/platforms.md "Render Node"; state machine in `auto-render-node.mjs`)
 * ======================================================================== */

const autoLog = (event: string, fields: object = {}) => {
  try { console.info("[queue-node]", event, JSON.stringify(fields)); } catch { console.info("[queue-node]", event); }
};
/** One per frame store root */
const autoNodes = new Map<string, ReturnType<typeof createAutoRenderNode>>();
/**
 * Tick for re-pushing existing layers: entries whose plan calculation only finishes during preload
 * after page handoff must also be pushed
 */
const AUTO_BACKFILL_TICK_MS = 5_000;

/**
 * Request a render connection ticket from the page: via the editor process
 * (`/api/render-node/ticket-request` on `PROMPTCUT_EDITOR_URL`, editor queries page via HMR).
 * Throws if unobtainable (page gone, page cannot sign): retried after session layer backoff;
 * resumes once page returns.
 */
async function requestPageTicket(projectId: string): Promise<string> {
  const editor = String(process.env.PROMPTCUT_EDITOR_URL || "").replace(/\/+$/, "");
  if (!editor) throw new Error("No editor process to query");
  const r = await fetch(`${editor}/api/render-node/ticket-request`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId }), signal: AbortSignal.timeout(15_000) });
  const data: any = await r.json().catch(() => null);
  if (!r.ok || typeof data?.ticket !== "string") throw new Error(`The editor failed to get a connection ticket: ${data?.code ?? r.status}`);
  return data.ticket;
}

/**
 * Re-pushes layers that were already in the local frame store before page handoff (user had opened
 * and rendered this project before handoff): push queue enqueues only when frames are **written into**
 * the frame store; existing frames hit by preload after handoff are not rewritten, and without
 * catch-up they would never reach the asset service, nor would the layer table be written.
 * Only catches up for this project (`entry.project.id === contentId`; not pushed if page has not
 * submitted `contentId` yet, pushed on next tick once submitted), once per entry: writes layer table
 * once (`publishLayerMap`), and existing snapshot frames for each card enter push queue by segment
 * (`enqueueSnapshotPush`, queue deduplicates itself, chunks already on asset service are skipped).
 * Track streams are not pushed: online pages do not use track streams (`product/platforms.md`
 * "online browser mode").
 */
async function backfillPush(service: FramePipeline, auto: AutoLink, done: Set<string>) {
  const pipeline: any = service;
  if (!pipeline.pushQueue || !auto.alive()) return 0;
  // Only push for bound projects: do not push when page has not submitted project doc id yet (unknown
  // which version belongs to it); once submitted, re-evaluate withheld segments first
  if (!auto.contentId) return 0;
  try { pipeline.pushQueue.rescope?.(); } catch { /* Keep withholding if unable to determine */ }
  const live = new Set([...(pipeline.generations?.values?.() ?? [])].filter((g: any) => !g?.controller?.signal?.aborted).map((g: any) => g.key));
  let queued = 0;
  for (const entry of [...(pipeline.entries?.values?.() ?? [])]) {
    if (!auto.alive() || !pipeline.pushQueue) break;
    if (done.has(entry.key) || !live.has(entry.key) || !Array.isArray(entry.cardPlan) || !entry.cardPlan.length) continue;
    if (entry.project?.id !== auto.contentId) continue;
    done.add(entry.key);
    try { pipeline.publishLayerMap(entry); } catch { /* Cannot write layer table */ }
    autoLog("render-node.backfill", { projectId: auto.projectId, entryKey: String(entry.key).slice(0, 12), controls: entry.cardPlan.length, frames: 0, segments: 0 });
  }
  return queued;
}

/**
 * Tear down automatic render node: yield claims, stop node, stop push queue, clear asset fallback;
 * hand running tasks to this machine to produce
 */
async function stopAutoNode(root: string, service: FramePipeline, reason: string) {
  const q = queueNodes.get(root);
  queueNodes.delete(root);
  // Yield claims and stop node: `release()` finally waits for the running batch to finish before
  // closing connections (may take a while), without blocking stopping push queue below; waits at
  // most `AUTO_RELEASE_WAIT_MS`
  const releasing: Promise<number | "pending"> = q ? q.release().catch(() => 0) : Promise.resolve(0);
  const teardown = pushTeardowns.get(root);
  pushTeardowns.delete(root);
  if (teardown) { try { await teardown(); } catch { /* Stopped */ } }
  setMediaFallbackTicket(null);
  setMediaFallbackBases([]);
  let rerun = 0;
  try { rerun = (service as any).leaveQueueMode?.() ?? 0; } catch { /* Pipeline already closed */ }
  const released = await Promise.race([releasing, new Promise<"pending">((r) => { const t = setTimeout(() => r("pending"), AUTO_RELEASE_WAIT_MS); t.unref?.(); })]);
  autoLog("render-node.teardown", { reason, released, rerun, push: !!teardown, node: !!q });
}
/**
 * Maximum time to wait for node finalization upon teardown (finishing running batch, closing
 * connections); returns anyway once expired, node closes itself when done
 */
const AUTO_RELEASE_WAIT_MS = 10_000;

function autoNodeFor(root: string, origin: string) {
  let ctl = autoNodes.get(root);
  if (ctl) return ctl;
  ctl = createAutoRenderNode({
    start: async (link: any) => {
      const auto = link as AutoLink;
      const service = frameService(root, origin);
      await startArtifactPush(root, service, auto);
      if (auto.alive()) await startQueueNode(root, service, auto);
      const done = new Set<string>();
      const tick = () => { if (auto.alive()) void backfillPush(service, auto, done).catch((e: any) => autoLog("render-node.backfill-failed", { message: String(e?.message ?? e) })); };
      tick();
      const timer = setInterval(tick, AUTO_BACKFILL_TICK_MS);
      timer.unref?.();
      autoLog("render-node.started", { projectId: auto.projectId, push: pushTeardowns.has(root), node: queueNodes.has(root) });
      return { service, timer };
    },
    stop: async (handle: any, reason: string) => {
      clearInterval(handle.timer);
      await stopAutoNode(root, handle.service, reason);
    },
    requestTicket: requestPageTicket,
    log: autoLog,
  });
  autoNodes.set(root, ctl);
  return ctl;
}

/**
 * Moved as is to `render-project.mjs` (contract J.5) and re-exported here; callers
 * (`vision/render.ts`, scripts) do not need to change
 */
export { renderProject };
export function framesPlugin(): Plugin {
  return { name: "promptcut-frames", configureServer(server) {
    const root = path.resolve(server.config.root);
    let remoteLease: { owner: string; url: string; at: number; ready: boolean } | null = null;
    const borrow = async (owner: string) => {
      const remote = prerenderState();
      if (isPrerender || !remote.ready || !remote.url) return false;
      if (remoteLease?.owner === owner && remoteLease.url === remote.url && Date.now() - remoteLease.at < 1000) return remoteLease.ready;
      try {
        const response = await fetch(remote.url + "/api/frames/yield", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner, ttl: 5000 }), signal: AbortSignal.timeout(2000) });
        const result = await response.json();
        remoteLease = { owner, url: remote.url, at: Date.now(), ready: response.ok && result.yielded === true };
      } catch { remoteLease = { owner, url: remote.url, at: Date.now(), ready: false }; }
      return remoteLease.ready;
    };
    const release = async (owner: string) => {
      if (remoteLease?.owner !== owner) return;
      const lease = remoteLease; remoteLease = null;
      await fetch(lease.url + "/api/frames/yield", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, ttl: 0 }), signal: AbortSignal.timeout(1500) }).catch(() => {});
    };
    server.watcher.on("change", file => { if (/^(src|scripts)\//.test(path.relative(root, file).replaceAll("\\", "/"))) invalidateFrameCode(root); });
    server.httpServer?.once("close", () => {
      const s = services.get(root); services.delete(root);
      const teardown = pushTeardowns.get(root); pushTeardowns.delete(root);
      const queueNode = queueNodes.get(root); queueNodes.delete(root);
      const auto = autoNodes.get(root); autoNodes.delete(root);
      void (async () => { await auto?.unbind({ reason: "server-close" }).catch(() => {}); await queueNode?.close(); await teardown?.(); await s?.close(); })();
      if (isPrerender) void closeStorage(libraryRoot(root)).catch(() => {});
    });
    /*
     * Storage footprint (plan section 4): `GET /api/storage`, `POST /api/storage/cap`,
     * `POST /api/storage/clear-cache`. Scanning and eviction are handled in the prerender process,
     * forwarded as is by the editor process. See `storage-routes.mjs` for routes and responses.
     */
    const storageHandler = isPrerender ? createStorageHandler({ storage: () => storageOf(root), exports: exportSummaryOf(root) }) : null;
    server.middlewares.use("/api/storage", (req, res, next) => {
      if (!storageRouteOf(req)) return next();
      if (!isPrerender) return proxyToPrerender(req, res);
      return storageHandler!(req, res, next);
    });
    /*
     * D4(b) `/api/cards/layout`: Agent's `get_layout`: measures entity boxes on the **whole scene** at t
     * (pinned architecture 4: Agent queries run in the prerender process; user interaction queries use
     * their own offscreen stage, not here). body `{ session, localRev, t, clipIds? }`, project origin
     * shares the same setup as `/preload` / `/playback` / `/see` (A7 mirror prelude, still accepts
     * `project` during transition period).
     *
     * **Answered only in the prerender process** (T1a review #14; `cloud-task.md` I4(c): `/api/cards/layout`
     * only serves Agent's `get_layout`, using the `'agent'` role). When received by the editor process,
     * forwarded as is to the prerender process; returns `503 NO_AGENT_LANE` if forwarding fails: previously
     * this called `FramePipeline.layout` directly in this process, opening a query Chrome on the editor
     * side. Inside the prerender process, borrows the agent lane bakery via `runAgentTask`, queuing in the
     * same queue as the `see_frames` agent batch.
     */
    server.middlewares.use("/api/cards/layout", (req, res, next) => {
      if (req.method !== "POST") return next();
      if (!isPrerender) return proxyToPrerender(req, res, { unavailable: { status: 503, code: "NO_AGENT_LANE",
        error: "The editor process has no Agent lane; /api/cards/layout is only answered by the prerender process, which is currently unreachable" } });
      const origin = `http://127.0.0.1:${(server.httpServer?.address() as any)?.port}`;
      const json = (status: number, data: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
      let body = "", over = false;
      req.on("data", chunk => { if (!over) { body += chunk; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Layout request too large"); } });
      req.on("end", async () => {
        if (over) return;
        try {
          const input = JSON.parse(body || "{}");
          let source = input.project;
          if (!source) {
            const version = await ensureMirror(String(input.session || ""), input.localRev);
            if (!version) return json(409, { error: `This project version is not in the mirror (session=${input.session}, localRev=${input.localRev}). Push the whole project again and retry.`, code: "MIRROR_MISSING", retryable: true });
            source = version.project;
          }
          const project = renderProject(source);
          if (!Array.isArray(project.tracks) || !Number.isFinite(project.duration) || project.duration <= 0) throw new Error("Invalid project");
          if (input.t !== undefined && !Number.isFinite(input.t)) throw new Error("t must be a number of seconds");
          if (input.clipIds !== undefined && input.clipIds !== null && (!Array.isArray(input.clipIds) || input.clipIds.some((id: unknown) => typeof id !== "string")))
            throw new Error("clipIds must be an array of strings");
          const service = frameService(root, origin);
          return json(200, await service.layout(project, { t: Number(input.t) || 0, clipIds: input.clipIds ?? null, signal: requestSignal(req, res) }));
        } catch (error: any) {
          const timedOut = Boolean(error?.timedOut || error?.code === "PRERENDER_TIMEOUT");
          const cancelled = Boolean(error?.cancelled || error?.name === "AbortError");
          const status = timedOut ? 504 : cancelled ? 499 : Number(error?.status) >= 500 ? Number(error.status) : 400;
          json(status, { ok: false, code: timedOut ? "FRAME_TIMEOUT" : cancelled ? "FRAME_CANCELLED" : (error?.code || "LAYOUT_ERROR"),
            retryable: timedOut || status >= 500, error: error?.message || "Entity box measurement failed" });
        }
      });
    });
    server.middlewares.use("/api/frames", (req, res, next) => {
      const origin = `http://127.0.0.1:${(server.httpServer?.address() as any)?.port}`;
      const json = (status: number, data: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
      /*
       * M6b queue node diagnostics and exit (`docs/plan/render-host-contract.md` sections 2 and 3):
       *   GET  /api/frames/queue          `{ nodes: [{ projectId, connected, claimed, completed, dedup,
       *                                     failed, lost, … }], codeVersion, envFingerprint,
       *                                     maxConcurrent }`;
       *                                     `nodes: []`, `starting: true` before node starts
       *   POST /api/frames/queue/release  Yield all claims, stop node, close connections
       *                                   (called before `cloud/scripts/render-host.mjs` exits)
       * Node is in the prerender process: forwarded as is by the editor process (pipeline is not built
       * on the editor side). Pipeline is built and node is started only on the first hit to
       * `/api/frames/*` in the prerender process, so this GET also acts as "start work".
       */
      const queuePath = (req.url || "/").split("?")[0];
      /*
       * Automatic render node (`auto-render-node.mjs`; editor process relay at `/api/render-node/*`
       * in `vite-plugin-prerender.ts`):
       *   POST /api/frames/render-node          { url, projectId, assetBase?, contentId?, ticket? }  Handoff / ticket renewal
       *   POST /api/frames/render-node/unbind   { projectId?, reason? }  Tear down (returns after teardown finishes)
       *   GET  /api/frames/render-node          Status (excluding tickets)
       */
      if (queuePath === "/render-node" || queuePath === "/render-node/unbind") {
        if (!isPrerender) return proxyToPrerender(req, res);
        const off = autoRenderNodeOffReason(process.env);
        if (req.method === "GET" && queuePath === "/render-node") {
          return json(200, { ok: true, enabled: off === null, off, ...(autoNodes.get(root)?.status() ?? { bound: false }) });
        }
        if (req.method !== "POST") return next();
        let raw = "";
        req.on("data", (c: Buffer) => { raw += c; if (raw.length > 16 * 1024) req.destroy(); });
        req.on("end", async () => {
          let input: any;
          try { input = JSON.parse(raw || "{}"); } catch { return json(400, { ok: false, error: "Request body is not JSON" }); }
          if (queuePath === "/render-node/unbind") {
            const ctl = autoNodes.get(root);
            if (!ctl) return json(200, { ok: true, action: "none" });
            const r = await ctl.unbind({ projectId: typeof input?.projectId === "string" ? input.projectId : null, reason: typeof input?.reason === "string" ? input.reason.slice(0, 40) : "unbind" });
            return json(200, r);
          }
          if (off) return json(200, { ok: true, enabled: false, reason: off });
          // `agent` mode does not prerender, so it does not act as a render node
          if (!servesPrerender) return json(200, { ok: true, enabled: false, reason: `prerender-mode-${prerenderMode}` });
          try {
            const r = autoNodeFor(root, origin).bind(input, { ticket: input?.ticket });
            return json(200, { enabled: true, ...r });
          } catch (e: any) {
            return json(400, { ok: false, error: e?.message || String(e) });
          }
        });
        return;
      }
      if ((req.method === "GET" && queuePath === "/queue") || (req.method === "POST" && queuePath === "/queue/release")) {
        if (!isPrerender) return proxyToPrerender(req, res);
        frameService(root, origin);
        const queueNode = queueNodes.get(root);
        if (req.method === "GET") {
          return json(200, queueNode ? queueNode.summary()
            : { nodes: [], codeVersion: null, envFingerprint: null, maxConcurrent: null, starting: queueNodeSwitch(), profile: hostProfile() ? "host" : "pc",
              auto: autoNodes.get(root)?.status() ?? { bound: false } });
        }
        req.resume();
        if (!queueNode) return json(200, { ok: true, released: 0 });
        void queueNode.release().then(released => json(200, { ok: true, released }), (error: any) => json(500, { ok: false, error: String(error?.message ?? error) }));
        return;
      }
      const service = frameService(root, origin);
      const url = new URL(req.url || "/", origin);
      /*
       * C3 ready index SSE. **Page connects directly to the prerender process** (same origin as J3
       * snapshot bytes, sharing `PROMPTCUT_CORS_ORIGINS`); the editor process does not proxy: it is not
       * in the D5 `/api/frames/*` reserved list, and middleware here passes any unrecognized path to `next()`.
       *
       * Upon connecting, first feeds `reset` + one full `layer` per layer (plus a `done` for layers already
       * done), followed by deltas. On disconnect, the page backs off at 1s / 2s / 4s / 8s to reconnect to the
       * same SSE (J3); reconnection simply goes through here again: shares a single recovery path with F5,
       * with no polling endpoint.
       */
      if (req.method === "GET" && url.pathname === "/ready") {
        // Item 4: Sharded subscription by `session`, only receiving layers for its own page session (without
        // session is the default session)
        const session = readySessionOf(url.searchParams.get("session") ?? undefined);
        if (session === null) return json(400, { error: "Invalid session parameter" });
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Connection", "keep-alive");
        // Both reverse proxies and Vite's compression may buffer without sending; buffering SSE is equivalent
        // to a disconnection
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();
        const send = (message: unknown) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n`); };
        const off = service.ready.subscribe(session, send);
        // Say something before idle connections are cut by intermediate proxies (comment lines are not
        // events, page will not receive them)
        const beat = setInterval(() => { if (!res.writableEnded) res.write(": beat\n\n"); }, 15000);
        beat.unref?.();
        const stop = () => { clearInterval(beat); off(); };
        req.on("close", stop);
        res.on("close", stop);
        return;
      }
      /*
       * Diagnostic read endpoint: oversized frames from A3c (card id, byte count) and batch queue
       * jumping from C4. The prerender process's stdout is captured by the editor process, so end-to-end
       * probes can only inspect these two things from here.
       */
      if (req.method === "GET" && url.pathname === "/diagnostics") {
        // J.5: only queue mode adds a `queue` key (queue-mode-probe reads it); when the switch is off,
        // the shape is unchanged
        const queueNode = queueNodes.get(root);
        return json(200, { ok: true, ...service.diagnostics(), ...(queueNode ? { queue: queueNode.describe() } : {}) });
      }
      if (req.method === "GET") {
        /*
         * Bytes of R8 track streams (manifest / init / segment) share the same origin as snapshot bytes
         * and both follow `PROMPTCUT_CORS_ORIGINS`. Only the prerender process (`interactive: true`) has
         * a producer; the editor process is null here and does not respond.
         */
        const producer = service.streamProducer();
        if (producer && producer.handle(req, res, url.pathname)) return;
        /*
         * Snapshot bytes for J3 / C3: `GET /api/frames/snapshot/<kind>/<key>/<localFrame>`.
         * When `kind` is `local`, `key` = `<entry.key>/<shared-key>`, so there are two key segments.
         * Keys are content-addressed, so they can be cached with immutable for a year.
         */
        const snapshot = /^\/snapshot\/(html|local)\/([a-f0-9]{64})(?:\/([a-f0-9]{64}))?\/(\d{1,8})$/.exec(url.pathname);
        if (snapshot) {
          const local = snapshot[1] === "local";
          if (local && !snapshot[3]) return json(404, { error: "The key for a local tier is <entry.key>/<shared key>" });
          void service.snapshots().readSnapshot({
            tier: local ? "local" : "shared",
            entryKey: local ? snapshot[2] : undefined,
            key: local ? snapshot[3] : snapshot[2],
            localFrame: Number(snapshot[4]),
          }).then((html: string | null) => {
            if (html === null) return json(404, { error: "Snapshot is not ready" });
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            res.end(html);
          }, () => json(404, { error: "Snapshot is not ready" }));
          return;
        }
        const control = /^\/control\/([a-f0-9]{64})\/(\d{1,8})$/.exec(url.pathname);
        if (control) {
          void fsp.readFile(path.join(service.root, 'controls', control[1], 'mov', 'frames', control[2].padStart(6, '0') + '.png')).then(buf => {
            res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'private,max-age=31536000,immutable'); res.end(buf);
          }, () => json(404, { error: 'Control frame is not ready' })); return;
        }
        // The final cumulative render is used by the editor, while the
        // cumulative track renders are useful to callers that want to rebuild
        // only the edited upper part.  Keep both forms behind fixed-length
        // hexadecimal keys; no user supplied path segment reaches the disk.
        const final = /^\/([a-f0-9]{64})\/(preview\.mp4|mov\/full\.mov|mov\/playback-[a-f0-9-]{36}\.mov|mov\/frames\/\d{6}\.png|frames\/\d{6}\.png|preview-frames\/\d{6}\.png)$/.exec(url.pathname);
        const track = /^\/([a-f0-9]{64})\/tracks\/([a-f0-9]{64})\/(preview\.mp4|frames\/\d{6}\.png)$/.exec(url.pathname);
        if (!final && !track) return next();
        const file = final
          ? path.join(service.root, final[1], final[2])
          : path.join(service.root, track![1], "tracks", track![2], track![3]);
        void fsp.stat(file).then(stat => {
          const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
          const start = range ? Number(range[1]) : 0;
          const end = range && range[2] ? Math.min(stat.size - 1, Number(range[2])) : stat.size - 1;
          if (start > end || start >= stat.size) { res.statusCode = 416; return res.end(); }
          res.statusCode = range ? 206 : 200;
          res.setHeader("Content-Type", file.endsWith(".mp4") ? "video/mp4" : file.endsWith(".mov") ? "video/quicktime" : "image/png");
          if (file.includes("playback-")) res.setHeader("Cache-Control", "no-store");
          res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Content-Length", end - start + 1);
          if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
          fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
        }, () => json(404, { error: "Frame is not ready" }));
        return;
      }
      /*
       * K1: **Frames pushed by the probe are stored directly as dead assets**. Whenever the background
       * stage's first pass (global clock pushes frame by frame) generates a snapshot frame, it reports
       * `{ session, localRev, clipId, localFrame, html, environment }`, which is forwarded here via the
       * editor process. `kind` / `key` are computed by the **prerender process** using A3a rules based on
       * the project in the mirror (the shared key requires the `digest` from `card-identity.mjs`, which
       * the page does not compute in local mode).
       *
       * **Only store cards that are `independent` in the review table** (final sentence of pinned
       * render 5): `sourceDependent` (upstream sources on the chain are missing in the reduced project)
       * and `belowDependent` / `unknown` (no lower-layer background) cannot obtain input in the reduced
       * project, so storing them is equivalent to sending out erroneous visuals as dead assets; their
       * local tier is still produced by the C2 whole-scene route.
       *
       * Written into the same directory tree and into the C3 index, prerendering no longer re-prerenders
       * these frames. The key incorporates the page's environment fingerprint, and this card is thereby
       * locked to the page's environment (per-card fingerprint lock, contract F.3); see the
       * `acceptMeasuredSnapshot` section below.
       */
      if (req.method === "PUT" && url.pathname === "/snapshot") {
        return json(200, { ok: true, stored: false, reason: "RETIRED" });
      }
      if (req.method !== "POST") return next();
      let body = "", over = false;
      req.on("data", chunk => { if (!over) { body += chunk; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Frame request too large"); } });
      req.on("end", async () => {
        if (over) return;
        try {
          const input = JSON.parse(body);
          // Item 4: preload takes a ticket for its session upon entry (before waiting for the mirror);
          // when completing out of order, arrival order determines the winner
          let preloadSession: string | null = null, preloadTicket: number | undefined;
          if (url.pathname === "/preload") {
            preloadSession = readySessionOf(input.session);
            if (preloadSession === null) throw new Error("Invalid session parameter");
            preloadTicket = service.ready.request(preloadSession);
          }
          if (url.pathname === "/yield") {
            if (typeof input.owner !== "string" || input.owner.length > 100) throw new Error("Invalid playback owner");
            if (input.ttl === 0) await service.resumeBackground(input.owner);
            else await service.yieldBackground(input.owner, 5000);
            return json(200, { yielded: input.ttl !== 0 });
          }
          /*
           * Where the project comes from (A7). Callers during the transition period (scripts, read-only
           * watch page, stage page, export page) include `project` in the body: use it as before. The editor
           * page only includes `{session, localRev}`: fetch from **this process**'s mirror plugin using this
           * key; if absent in this process, pull back once via PROMPTCUT_EDITOR_URL. If still not found,
           * return 409 MIRROR_MISSING, and the page retries after re-pushing the whole thing.
           */
          let source = input.project;
          if (!source) {
            const version = await ensureMirror(String(input.session || ""), input.localRev);
            if (!version) return json(409, { error: `This project version is not in the mirror (session=${input.session}, localRev=${input.localRev}). Push the whole project again and retry.`, code: "MIRROR_MISSING", retryable: true });
            source = version.project;
          }
          const project = renderProject(source);
          if (!Array.isArray(project.tracks) || !Number.isFinite(project.duration) || project.duration <= 0) throw new Error("Invalid project");
          const entry = await service.entry(project);
          if (url.pathname === "/playback") {
            if (typeof input.owner !== "string" || input.owner.length > 100 || !Number.isSafeInteger(input.sequence)
              || !Number.isFinite(input.t) || typeof input.playing !== "boolean" || (input.rate !== undefined && (!Number.isFinite(input.rate) || input.rate <= 0 || input.rate > 8))
              || (input.deliveryMs !== undefined && (!Number.isFinite(input.deliveryMs) || input.deliveryMs < 0 || input.deliveryMs > 5000))) throw new Error("Invalid playback clock");
            noteInteraction(root);   // M6c X5: playback clock is an interactive frame request; local queue nodes do not claim new tasks within 500 ms
            return json(200, await service.updatePlayback(project, input, { borrow, release }));
          }
          if (url.pathname === "/see") {
            const lane = input.lane === "agent" ? "agent" : input.lane === "background" ? "background" : "user";
            if (lane === "user") noteInteraction(root);   // M6c X5: scrubbing to fetch frames is an interactive frame request
            const frames = await service.see_frames(project, input.times || [0], { lane, signal: requestSignal(req, res) });
            // `mov` is always null: full.mov for the whole scene is no longer produced (legacy full-frame
            // channel Proposal B [ruling]); the field is kept for legacy pages and probes to recognize the shape
            return json(200, { key: entry.key, incomplete: [...frames.values()].some((value: any) => value.incomplete),
              frames: [...frames].map(([frame, value]: any) => ({ frame, source: value.source, incomplete: !!value.incomplete, missing: value.missing || [],
                url: `/api/frames/${entry.key}/${value.incomplete ? 'preview-frames' : value.source === "mov" ? "mov/frames" : "frames"}/${String(frame).padStart(6, "0")}.png` })), mov: null });
          }
          // Sole source of the session's "current version" (Item 4): the page's preload carries its
          // `{ session, localRev }`
          if (url.pathname === "/preload" && !servesPrerender) {
            // `agent` mode does not prerender (cloud-task.md I1): explicitly skipped, does not schedule
            // work, and does not register session versions
            return json(200, { ok: true, skipped: prerenderMode, key: entry.key });
          }
          if (url.pathname === "/preload") {
            /*
             * J.5 queue mode: when the node is connected to the document service, it first reports the digest,
             * uploads snapshots, and publishes `plan` on behalf of the page; if successful, snapshots for this
             * version are handed off to the queue to produce (`queue: true`); if unsuccessful (publish failed,
             * no usable projectId), produce locally on this machine (`queue: false`). When the switch is off,
             * `queueNodes` is empty, and calls here remain verbatim as before.
             */
            const queueNode = queueNodes.get(root);
            const viaQueue = queueNode?.active() ? await queueNode.publish(preloadSession!, project, entry.key, source) : undefined;
            await service.preload(project, { session: preloadSession!, localRev: input.localRev, ticket: preloadTicket, ...(viaQueue === undefined ? {} : { queue: viaQueue }) });
            // Report to the editor process to register (Proposal A): after this process crashes and restarts,
            // the editor replays preload according to the table.
            // Only report the version actually accepted by this session right now: requests superseded by
            // newer preloads are not reported.
            if (preloadSession && service.ready.current(preloadSession) === entry.key) reportReadySession(preloadSession, input.localRev);
          }
          else if (url.pathname === "/import" && typeof input.snapshots === "string") {
            try {
              // Restore the control index together with the HTML.  It is built from
              // the same snapshots and lets callers address a component at its
              // local frame without sampling the whole project again.
              const archive = unpackFrameArchive(input.snapshots, entry.key, { spillDir: path.join(entry.dir, "html-cache") });
              entry.html = archive.frames;
              entry.controls = archive.controls;
              entry.createControl = archive.createControl;
              entry.disposeArchive?.(); entry.disposeArchive = archive.dispose;
              entry.recordVersion = (entry.recordVersion || 0) + 1;
              await service.save(entry);
            }
            catch { return json(200, { discarded: true }); }
          } else if (url.pathname === "/archive") {
            const snapshots = await service.portableArchive(entry);
            return json(200, { key: entry.key, snapshots, localOnly: snapshots === null });
          } else if (url.pathname !== "/status") return json(404, { error: "Unknown frame operation" });
          await entry.mov?.ready;
          // `video` and `mov` are always null: preview.mp4 and full.mov for the whole scene are no longer
          // produced and never had any consumers (legacy full-frame channel Proposal B [ruling],
          // AGENT-maint-3). The fields are not removed, keeping the response shape seen by legacy pages
          // and probes unchanged.
          return json(200, { key: entry.key, status: entry.status, sampled: entry.html.size, movSampled: entry.mov ? [...(entry.mov.frames || [])].length : 0, total: Math.max(1, Math.floor(project.duration * (project.fps || 30))), error: entry.error,
            video: null, mov: null });
        } catch (error: any) {
          const timedOut = Boolean(error?.timedOut || error?.code === "PRERENDER_TIMEOUT");
          const cancelled = Boolean(error?.cancelled || error?.name === "AbortError");
          const status = timedOut ? 504 : cancelled ? 499 : Number(error?.status) >= 500 ? Number(error.status) : 400;
          const code = timedOut ? "FRAME_TIMEOUT" : error?.superseded ? "FRAME_SUPERSEDED" : cancelled ? "FRAME_CANCELLED" : (error?.code || "FRAME_ERROR");
          if (status >= 500) console.error(`[frames] ${code}:`, error?.stack || error?.message || error);
          json(status, {
            ok: false,
            code,
            retryable: timedOut || status >= 500,
            error: error?.message || tr("Frame render failed"),
          });
        }
      });
    });
  } };
}
