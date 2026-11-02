import type { PickedSnapshot, ReadyKind, ReadyLayer, ReadyRange } from "./snapshotPick.mjs";
import { cachedClipInputSig, inputSigStale } from "./layerInputSig.mjs";
import { streamInputSig, streamSigStale } from "./streamInputSig.mjs";
import { SEGMENT_FRAMES, type StreamManifest, type StreamRect } from "./streamPlayer.ts";
import { isStreamOrigin, streamSegmentOf } from "./streamSegments.mjs";

/**
 * Snapshot source interface on the stage side for J3.
 *
 * The **two places** consuming snapshots in the page: the C3 ready index SSE subscription and C4
 * fetching snapshot bytes via
 * `GET ${prerenderBase()}/api/frames/snapshot/<kind>/<key>/<localFrame>`, are consolidated into
 * this single file. `StageView` / `Preview` do not `fetch` snapshots directly or `new EventSource`
 * directly: when switching to `IdbSnapshotSource` in online browser mode (L2), consumers do not
 * need to change a single line.
 *
 * The local mode implementation is `HttpSnapshotSource`: **connects directly to the prerender
 * process** (same origin as SSE, routed via `PROMPTCUT_CORS_ORIGINS`; not proxied by the editor
 * process). On disconnect, it backs off at 1s / 2s / 4s / 8s (capped at 8s) to reconnect to
 * **the same SSE**. On successful reconnect, the server follows the F5 practice of sending `reset`
 * first, then a full `layer`: sharing a recovery path with F5, with no polling endpoint.
 *
 * **This layer is only responsible for "getting it"**: the 33 ms DOM swapping throttle,
 * `setSnapshots` delivery baseline, and splitting deliveries to ≤ 2 MB per batch are all the parent
 * page consumer's responsibility (R5). Therefore, the interface is designed as two stateless
 * verbs plus a subscription, allowing consumers to schedule however they want.
 */

export type { ReadyKind, ReadyLayer, ReadyRange, PickedSnapshot };

/** Three message types of C3; shapes are fixed */
export type ReadyMessage =
  | { type: "reset"; localRev: number }
  | { type: "layer"; clipId: string; kind: ReadyKind; key: string; ranges: ReadyRange[]; groupClipIds?: string[];
      /**
       * Only present on `stream` layers: the stream's own first frame (project frame number); segments
       * start from it every 15 frames (`streamSegments.mjs`)
       */
      originFrame?: number;
      /**
       * Only present on below-dependent streams (`belowLayerMark` in `server/frame-stream.mjs`): this
       * stream is produced in stage coordinates, with its plane mounted under the stage root
       */
      streamKind?: "below";
      /**
       * Only present on below-dependent streams: the input signature of the project version that produced
       * this stream (`streamInputSig.mjs`); if it does not match what the parent page computes for the
       * current project, it will not be pasted
       */
      inputSig?: string }
  | { type: "done"; localRev: number };

export interface SnapshotSource {
  /**
   * Subscribe to the ready index. Returns an unsubscribe function; reconnects and `reset` are
   * handled within the implementation
   */
  subscribeReady(session: string, localRev: number, onMessage: (m: ReadyMessage) => void): () => void;
  /**
   * Fetch HTML for a snapshot frame. Throws if the frame is missing (that layer is treated as
   * missing material, and C4 will select an earlier frame)
   */
  fetchSnapshot(kind: ReadyKind, key: string, localFrame: number, signal?: AbortSignal): Promise<string>;
}

/** A3c / J3: page in-memory cache of 64 entries, LRU */
export const SNAPSHOT_CACHE_MAX = 64;
/** J3: backoff for reconnecting on disconnect, capped at 8 seconds */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000];

/**
 * Construct snapshot URL. When `kind` is `local`, `key` is `<entry.key>/<sharedKey>`, which
 * **contains a slash** (C3). Therefore, `encodeURIComponent` per segment; do not encode the
 * entire `key`: encoding the whole thing turns that slash into `%2F`, which fails to match the
 * server's routing regex.
 */
export function snapshotPath(kind: ReadyKind, key: string, localFrame: number): string {
  const segments = String(key).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/api/frames/snapshot/${encodeURIComponent(kind)}/${segments}/${localFrame}`;
}

/**
 * Page-side shape of the ready index (C3): the `stream` table and `html` table for the same heavy
 * card coexist without overwriting each other
 */
export type ReadyIndex = Map<string, Map<ReadyKind, { key: string; ranges: ReadyRange[]; groupClipIds?: string[]; originFrame?: number; streamKind?: "below"; inputSig?: string }>>;

/**
 * Apply a message to the page's `readyIndex`. `reset` clears the table, `layer` replaces the whole
 * layer (C3 uses full semantics: cannot merge, otherwise old intervals linger after card parameters
 * change).
 */
export function applyReadyMessage(index: ReadyIndex, message: ReadyMessage): ReadyIndex {
  if (message.type === "reset") { index.clear(); return index; }
  if (message.type !== "layer") return index;
  let byKind = index.get(message.clipId);
  if (!byKind) { byKind = new Map(); index.set(message.clipId, byKind); }
  // Group stream (R8 / G1) layers carry `groupClipIds`: the parent page synthesizes a
  // `{ clipIds: groupClipIds }` stream plane from it
  // `stream` layers also carry the stream's first frame (`originFrame`): the parent page and stage
  // convert frame numbers to segment numbers using it
  byKind.set(message.kind, { key: message.key, ranges: message.ranges, ...(message.groupClipIds?.length ? { groupClipIds: [...message.groupClipIds] } : {}),
    ...(isStreamOrigin(message.originFrame) ? { originFrame: message.originFrame } : {}),
    // Two items for below-dependent streams (recognized only by `stream` layers): paste in stage
    // coordinates, input signature
    ...(message.kind === "stream" && message.streamKind === "below"
      ? { streamKind: "below" as const, ...(typeof message.inputSig === "string" && message.inputSig ? { inputSig: message.inputSig } : {}) } : {}) });
  return index;
}

/** Get a layer from the ready index; null if absent (that layer is transparent for this tick) */
export function layerOf(index: ReadyIndex, clipId: string, kind: ReadyKind): ReadyLayer | null {
  const hit = index.get(clipId)?.get(kind);
  return hit ? { clipId, kind, key: hit.key, ranges: hit.ranges } : null;
}

/**
 * In-memory LRU: `Map` insertion order is usage order; delete and reinsert on hit.
 *
 * (This file does not use TS "constructor parameter properties" `constructor(private x)`: that is
 * non-type syntax that Node's type erasure cannot run, preventing unit tests from importing it.)
 */
class SnapshotCache {
  private map = new Map<string, string>();
  private max: number;
  constructor(max = SNAPSHOT_CACHE_MAX) { this.max = max; }
  get(id: string): string | undefined {
    const hit = this.map.get(id);
    if (hit === undefined) return undefined;
    this.map.delete(id);
    this.map.set(id, hit);
    return hit;
  }
  set(id: string, html: string) {
    if (this.map.has(id)) this.map.delete(id);
    this.map.set(id, html);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get size() { return this.map.size; }
  clear() { this.map.clear(); }
}

/**
 * Origin of the prerender process. **Import `./prerender.ts` on demand**: that module carries a
 * React hook (`usePrerenderBase`), and a static import would drag React into this path that should
 * only involve fetch (as well as Node-side unit tests). When the caller passes `base` explicitly,
 * this line never runs.
 */
const defaultBase = async (): Promise<string> => (await import("./prerender.ts")).prerenderBase();

/** Local mode: connects directly to the prerender process */
export class HttpSnapshotSource implements SnapshotSource {
  private cache = new SnapshotCache();
  /** Only fly once when the same frame is requested by two places simultaneously */
  private inflight = new Map<string, Promise<string>>();
  private base: () => Promise<string>;

  constructor(base: () => Promise<string> = defaultBase) { this.base = base; }

  subscribeReady(session: string, localRev: number, onMessage: (m: ReadyMessage) => void): () => void {
    let stopped = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = async () => {
      if (stopped) return;
      /*
       * D5 "same-origin fallback removal": if the prerender origin cannot be obtained, **do not
       * connect**; back off and query again. Previously, this fell back to an empty string (same-origin),
       * causing EventSource to connect to the editor's own origin: that endpoint does not exist there, so
       * it failed upon connection, reconnected upon failure, wasting a connection and hiding the real
       * failure.
       */
      let base: string;
      try { base = await this.base(); } catch { return retry(); }
      if (stopped) return;
      const url = `${base}/api/frames/ready?session=${encodeURIComponent(session)}&localRev=${encodeURIComponent(String(localRev))}`;
      try {
        source = new EventSource(url);
      } catch {
        return retry();
      }
      source.onopen = () => { attempt = 0; };
      source.onmessage = (event: MessageEvent) => {
        if (stopped) return;
        try { onMessage(JSON.parse(String(event.data)) as ReadyMessage); }
        catch { /* Partial message: the next full layer will restore this layer */ }
      };
      source.onerror = () => {
        // EventSource reconnects on its own, but it will not query `prerenderBase()` again: if the
        // prerender crashes, it will switch to a new port, so here we close it manually, back off,
        // re-query the address, and reconnect.
        try { source?.close(); } catch { /* Already closed */ }
        source = null;
        retry();
      };
    };

    const retry = () => {
      if (stopped || timer !== null) return;
      const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
      attempt++;
      timer = setTimeout(() => { timer = null; void connect(); }, delay);
    };

    void connect();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      try { source?.close(); } catch { /* Already closed */ }
      source = null;
    };
  }

  async fetchSnapshot(kind: ReadyKind, key: string, localFrame: number, signal?: AbortSignal): Promise<string> {
    const id = `${kind}/${key}/${localFrame}`;
    const hit = this.cache.get(id);
    if (hit !== undefined) return hit;
    const flying = this.inflight.get(id);
    if (flying) return flying;
    const work = (async () => {
      const base = await this.base();
      const res = await fetch(base + snapshotPath(kind, key, localFrame), { signal, cache: "force-cache" });
      if (!res.ok) throw Object.assign(new Error(`Snapshot is not ready yet: ${id}`), { status: res.status });
      const html = await res.text();
      this.cache.set(id, html);
      return html;
    })().finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, work);
    return work;
  }

  /** Drop the cache after a project version change (keys are content-addressed, so this is normally unnecessary) */
  clearCache() { this.cache.clear(); }
  get cacheSize() { return this.cache.size; }
}

/* ======================================================================== *
 * Online browser mode: read prerender small size from asset service
 * (`docs/plan/c10a-contract.md` section 9 "Online page fetch")
 * ======================================================================== */

/**
 * An online page has no prerender process, so it has no SSE ready index and no
 * `/api/frames/snapshot`. It fetches frames for heavy layers like this:
 *
 * 1. **Layer table**: An entry written into the content store when a render node claims the next
 *    card plan (`snapshot-manifest` kind, key `layers:<project id>`, `layerMapOf` in
 *    `server/artifact-transfer.mjs`): the online key, manifest result key, and sampling window for
 *    each heavy card. The page fetches it by project id and fetches it again every
 *    `LAYER_MAP_POLL_MS` (after an edit, the render node rerenders and switches keys, and the page
 *    follows).
 * 2. **Manifest**: Only fetches manifests for segments that fall within "`PREFETCH_SEC` seconds
 *    before and after the current playhead" (`<resultKey>:<from>-<to>`, where segment length is the
 *    layer table's `span`), one per segment; the `small` table in the manifest lists which frames
 *    in this segment have small bitmaps and their respective hashes. Manifests that are not yet
 *    full are fetched again every `MANIFEST_POLL_MS`.
 * 3. **Ready**: The ready interval for each layer = frames with small bitmaps in the retrieved
 *    manifests, delivered to subscribers according to C3's `layer` message (full semantics):
 *    the same consumption path as local mode (without changing a single line of frame selection,
 *    fallback, or delivery in `snapshotFeed`). Original size does not count: small-size readiness is
 *    not original-size readiness, and the online page never pulls original size anyway.
 * 4. **Fetch bytes**: `GET <asset service>/px/<hash>` (read-only ticket, `Authorization` header),
 *    wrapped into an `<img>` that fills the snapshot plane (data URL, not blob URL: the stage is a
 *    separate document, and revoking a blob on the parent page breaks the image on the stage).
 * 5. **Cache**: Stores small size only in memory via LRU, capped at `ONLINE_CACHE_MAX_BYTES`
 *    (64 MiB, contract section 8 [ruling], no IndexedDB). Prefetch: 2 seconds before and after the
 *    playhead for currently visible heavy layers. Released via `clearCache()` before export
 *    (contract section 11.1).
 *
 * 6. **Track stream** (`docs/plan/browser-stream-task.md` item 6; fetched across all tiers, see
 *    item 7 for differences when pasting only the sparse version): The layer table additionally
 *    carries a `streams` table (one row per stream: member, candidate result keys, segment range,
 *    and segments per manifest). The page fetches stream manifests (`render-manifest`, key
 *    `<result key>:<from>-<to>`) from the content store based on segments near the playhead, and
 *    fetches head files and segments listed in the manifest from the asset service into this page's
 *    memory by hash (`px/<hash>`, using the same read-only ticket); **only segments whose bytes have
 *    reached this page are considered ready**, delivered to subscribers according to C3's `layer`
 *    message (`kind: 'stream'`, unit is segment number, group stream includes `groupClipIds`): the
 *    same message as desktop's ready index, requiring no changes to `snapshotFeed`. The stage does
 *    not fetch them on its own: the parent page passes both the manifest and bytes when sending the
 *    stream plane (`streamPlane`, paired with `StreamPlaneSender` in `streamPlayer.ts`). Candidate
 *    qualification and input signature expiration handling follow the rules of the snapshot layer;
 *    if this segment of the stream has not been fetched, this layer continues to switch snapshots
 *    every tick as usual.
 *
 * 7. **Only paste the sparse version of track streams when there is only one stage**
 *    ((user decision, 2026-10-13) "paste only the sparse version when performance is insufficient,
 *    and allocate fewer active decoders"; from 2026-10-22, applies to pages with only one stage
 *    (lite mode and lowest tier), `mechanism/platforms.md` "Three gates" [ruling]): The stream
 *    fetching path is the same as in other tiers (layer table, manifest, segment); on the stage
 *    side, each segment decodes only the first frame (`presentFirst` in `streamPlayer.ts`). There
 *    are only three differences here:
 *      - First asks the browser whether it can decode (`StreamDecodeSupport`): if there is no
 *        `VideoDecoder`, no stream is fetched or sent; if `isConfigSupported` reports that a head
 *        file's encoding configuration is unsupported, segments using it are not fetched and not
 *        counted as ready: on the parent page side, this means "this card has no stream", falling
 *        back to a placeholder;
 *      - Keeps fewer stream bytes in this page's memory (`SPARSE_STREAM_CACHE_MAX_BYTES`);
 *      - Segments are **fetched as whole segments**: only the first frame is needed, but chunks are
 *        accessed by content hash and must be verified after retrieval, so half a chunk cannot be
 *        fetched. A sparse segment originally contains only one image plus a dozen nearly empty
 *        duplicate frames, so the whole segment is roughly equivalent to the first frame; a
 *        full-density segment fetches an extra 14 subsequent delta frames (unused), at the cost of
 *        this extra bandwidth.
 *    The prerender small-size path (`small` in items 2-5 above) is kept as is for transition.
 *    [delete when snapshots are removed: the `small` tier along with the `tier` branch]
 *
 * Both the document service and asset service are accessed via injected dependencies (wired on the
 * page from `Preview` to `docRequest` / `assetAuthHeaders` in `assetTiers.ts`); this file has no
 * knowledge of `/api`, and unit tests inject fakes.
 */

/** Small-size cache cap for online pages (contract section 8 [ruling]) */
export const ONLINE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** Prefetch range: this many seconds before and after the playhead (contract section 9) */
export const PREFETCH_SEC = 2;
/** How often to refetch the layer table */
export const LAYER_MAP_POLL_MS = 3000;
/** How often to refetch manifests that are not yet full */
export const MANIFEST_POLL_MS = 2000;
/** Concurrent in-flight small-bitmap requests */
export const ONLINE_FETCH_CONCURRENCY = 4;
/**
 * Layer table key prefix in the content store (same value as `LAYER_MAP_PREFIX` in
 * `server/artifact-transfer.mjs`)
 */
export const LAYER_MAP_PREFIX = "layers:";
/**
 * Track stream segment bytes retained in this page's memory at most (retained by most recently
 * used; tier-3 numbers: 6 streams, 6 segments before and after each, at most 512 KB per segment is
 * ~18 MiB, keeping 3x headroom)
 */
export const STREAM_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/**
 * When only pasting sparse version: stream bytes retained in this page's memory at most (tier-3
 * numbers: 4 streams, 6 segments before and after the playhead each, at most 512 KB per segment is
 * ~12 MiB)
 */
export const SPARSE_STREAM_CACHE_MAX_BYTES = 16 * 1024 * 1024;
/**
 * Track stream prefetch: this many segments back from the playhead's segment (retaining the segment
 * just played so scrubbing back a bit does not require refetching)
 */
export const STREAM_BEHIND_SEGMENTS = 1;
/**
 * How long to wait before retrying after failing to fetch a stream byte chunk (missing chunks,
 * expired ticket: avoid hitting the asset service on every round)
 */
export const STREAM_RETRY_MS = 2000;

export interface OnlineLayer {
  clipId: string;
  kind: ReadyKind;
  key: string;
  resultKey: string;
  firstFrame: number;
  count: number;
  /**
   * Layer table v2 (C10 contract section 18 item 3): content key for the shared tier; null for v1 or
   * when unavailable
   */
  contentKey?: string | null;
  /** Layer table v2: fingerprint of the environment that produced this layer; null for v1 or when unavailable */
  envFingerprint?: string | null;
  /**
   * Layer table v3 (M7 contract D12): candidates for this layer: the splitter's own, pure browser's,
   * each being a set of keys from one environment; `resultKey` / `envFingerprint` / `key` on the layer
   * is the first candidate. Which one is active is determined by the page based on `task.done` and
   * the manifest (`alive` in `layerRefOf`). v2 does not have this field and is treated as a single
   * candidate (`layerCandidates`).
   */
  candidates?: LayerCandidate[];
  /**
   * [ruling] stale-layer: signature of the clip input that generated this layer
   * (`layerInputSig.mjs`). The page calculates the same signature from the current project; if it
   * does not match, it is a layer with stale parameters and will not be pasted (C10 contract section
   * 9). Layer tables written by older nodes do not have this field: paste as before.
   */
  inputSig?: string | null;
}

/** A candidate for layer table v3 (M7 contract D12): a set of keys produced by one environment */
export interface LayerCandidate {
  envFingerprint: string;
  resultKey: string;
  /** Key on the ready index wire */
  key: string;
}

/**
 * A candidate for a track stream: a stream produced by one environment. The stream's key on the
 * ready index wire is the result key
 */
export interface StreamCandidate {
  envFingerprint: string;
  resultKey: string;
}

/**
 * A row in the layer table's `streams` table (`layerStreamsOf` in `server/artifact-transfer.mjs`): a
 * track stream.
 * Stream manifests are stored in the content store as `<resultKey>:<start>-<end>`, one per
 * `segmentsPerTask` segments starting from segment 0, with the last manifest up to `lastSegment`.
 * The segment number is specific to this stream: one segment every 15 frames starting from its
 * first frame `originFrame` (project frame number) (`streamSegments.mjs`).
 */
export interface OnlineStream {
  /** Which card the ready message attaches to: itself for a single-card stream, topmost card in the group for a group stream */
  topClipId: string;
  /** Members (painter's order, the last one is on top). A below-dependent stream has only the target card (lower layers factored into the key are not listed; the page finds them on its own from the current project) */
  clipIds: string[];
  /**
   * `below`: below-dependent stream (cards like frosted glass; `docs/plan/prerender-products-contract.md`
   * section 5). The stream contains only the layer modified by the target card, produced in stage
   * coordinates (`plane` is `stage`); ready message carries `streamKind: "below"`, based on which the
   * parent page emits a stream plane with `plane: "stage"`.
   */
  kind: "card" | "group" | "below";
  plane: "local" | "stage";
  contentKey: string;
  /** Candidates: environments that actually produced keys during splitting, plus the layer-table-writing node's own. Determining which one is alive follows the snapshot layer */
  candidates: StreamCandidate[];
  /** The first frame of this stream itself (project frame number): carried by that row in the layer table, provided by the side writing the layer table according to the project at that time */
  originFrame: number;
  /** Always 0 (not written in layer table rows; kept because fetching manifests is partitioned by "from firstSegment to lastSegment") */
  firstSegment: number;
  lastSegment: number;
  segmentsPerTask: number;
  /** Signature of the project input that generated this stream (`streamInputSig.mjs`); if what the page calculates does not match, do not play. If this item is absent, play anyway */
  inputSig?: string | null;
}

export interface LayerMap {
  /** Layer table version (`LAYER_MAP_VERSION` in `server/artifact-transfer.mjs`); treated as 1 if omitted */
  v: number;
  projectId: string | null;
  fps: number;
  span: number;
  layers: OnlineLayer[];
  /** Track stream table; layer tables written by older nodes lack this entry, parsed as an empty table (page behavior as before) */
  streams: OnlineStream[];
}

/** Layer table versions recognized by the online page (C10 contract section 18, item 3); recognizes both v 1 and v 2 when pasting sparse version only (`small`) */
export const LAYER_MAP_V2 = 2;
/** Layer table v 3 (M7 contract D12): each layer carries candidates; v 2 fields remain as before (equal to the first candidate), legacy reader still reads as usual */
export const LAYER_MAP_V3 = 3;
/** Layer table versions recognized by the page; if `v` is unrecognized, the entire table is treated as absent */
export const KNOWN_LAYER_MAP_VERSIONS = [1, 2, 3] as const;

export interface OnlineSnapshotDeps {
  /** A request on the document service (`content.get`); throws if connection fails */
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Base API URL for the remote asset service (formatted like `https://host/media/api/asset`); null if not yet available */
  assetBase(): string | null;
  /** Request headers with a read-only asset ticket */
  authHeaders(): Promise<Record<string, string>>;
  fetch?: typeof fetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** Fallback timeout for a single content store request; connection implementations should also time out on their own */
  requestTimeoutMs?: number;
  /** Fallback timeout for fetching a single small bitmap */
  assetTimeoutMs?: number;
  /**
   * Layers that need to know whole-clip coverage (C10 contract section 9: cards that cannot run on
   * this device must check whether prerender output covers the entire clip). Manifests for these
   * layers are fetched not only for the playhead window, but for every segment across the whole
   * clip (slower, `COVERAGE_POLL_MS`); if omitted, fetches only the window.
   */
  coverageLayer?: (clipId: string) => boolean;
}

/**
 * After a layer expires (input signature mismatch, stale-layer), how long to treat it as "new
 * results on the way": during this period the parent page does not confirm missing (user cards and
 * media effect cards show an hourglass, timeline does not show a badge), waiting for the render
 * node to rewrite the layer table based on new inputs; if this duration elapses, confirm missing
 * just like "layer not in layer table" (icon, badge). Level 3 number.
 */
export const STALE_AWAIT_MS = 15_000;

/** Whole-clip coverage: how often to re-fetch manifests that are not yet complete (segments outside the window) */
export const COVERAGE_POLL_MS = 5000;
/** Whole-clip coverage: maximum manifests outside the window fetched per round (long clips fetched across rounds to avoid overwhelming the content store) */
export const COVERAGE_FETCHES_PER_TICK = 16;

/**
 * How much of a clip's prerender output is covered: unknown yet (layer table not fetched, or
 * manifest for some segment was never fetched) / no usable layer / layer exists but does not cover
 * the entire clip / entire clip covered (frames for this tier).
 */
export type LayerCoverage = "unknown" | "none" | "partial" | "full";

/** Candidate table for layer table v 3: keep only entries where all three items are non-empty strings; corrupt entries skipped */
function candidatesOf(raw: unknown): LayerCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: LayerCandidate[] = [];
  for (const c of raw as Record<string, unknown>[]) {
    if (!c || typeof c !== "object") continue;
    const { envFingerprint, resultKey, key } = c;
    if (typeof envFingerprint !== "string" || !envFingerprint || typeof resultKey !== "string" || !resultKey || typeof key !== "string" || !key) continue;
    out.push({ envFingerprint, resultKey, key });
  }
  return out;
}

/**
 * Candidates for this layer (M7 contract D12): `candidates` in v 3; v 2 (or a v 3 layer with no
 * candidates or all candidates corrupt) is treated as one candidate: the layer's own key and
 * fingerprint; v 1 and layers missing fingerprints have no candidates.
 */
export function layerCandidates(layer: OnlineLayer): LayerCandidate[] {
  if (layer.candidates?.length) return layer.candidates.map((c) => ({ ...c }));
  if (layer.envFingerprint && layer.resultKey && layer.key) return [{ envFingerprint: layer.envFingerprint, resultKey: layer.resultKey, key: layer.key }];
  return [];
}

/**
 * The `streams` table in the layer table: rows with incorrect shapes are skipped without throwing;
 * returns an empty table if not an array.
 * Only recognizes rows with `originFrame`: rows lacking it were written by nodes prior to changing
 * segmentation rules (segments counted by project frame numbers); pasting them with current
 * conversion causes visual misalignment.
 * Below-dependent streams (`kind: "below"`) only recognize rows with "one member, stage
 * coordinates": pasting those with incorrect shapes causes wrong positioning, so skip them
 * (treated as if this card has no stream).
 */
export function parseLayerStreams(raw: unknown): OnlineStream[] {
  if (!Array.isArray(raw)) return [];
  const out: OnlineStream[] = [];
  const str = (x: unknown): x is string => typeof x === "string" && !!x;
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const clipIds = Array.isArray(r.clipIds) ? (r.clipIds as unknown[]).filter(str) : [];
    if (!clipIds.length || clipIds.length !== (r.clipIds as unknown[]).length) continue;
    const kind = r.kind === "group" ? "group" : r.kind === "card" ? "card" : r.kind === "below" ? "below" : null;
    const plane = r.plane === "stage" ? "stage" : r.plane === "local" ? "local" : null;
    const firstSegment = 0, lastSegment = Number(r.lastSegment), segmentsPerTask = Number(r.segmentsPerTask);
    const originFrame = r.originFrame;
    if (!kind || !plane || !str(r.contentKey)) continue;
    if (kind === "below" && (clipIds.length !== 1 || plane !== "stage")) continue;
    if (!isStreamOrigin(originFrame) || !Number.isInteger(lastSegment) || lastSegment < firstSegment) continue;
    if (!Number.isInteger(segmentsPerTask) || segmentsPerTask < 1) continue;
    const candidates: StreamCandidate[] = [];
    for (const c of Array.isArray(r.candidates) ? (r.candidates as Record<string, unknown>[]) : []) {
      if (c && typeof c === "object" && str(c.envFingerprint) && str(c.resultKey)) candidates.push({ envFingerprint: c.envFingerprint, resultKey: c.resultKey });
    }
    if (!candidates.length) continue;
    const topClipId = str(r.topClipId) ? r.topClipId : clipIds[clipIds.length - 1];
    out.push({ topClipId, clipIds, kind, plane, contentKey: r.contentKey, candidates, originFrame, firstSegment, lastSegment, segmentsPerTask,
      ...(str(r.inputSig) ? { inputSig: r.inputSig } : {}) });
  }
  return out;
}

/**
 * The range of manifests for a stream falling within segment numbers `[loSeg, hiSeg]` (closed
 * interval): one manifest per `segmentsPerTask` segments starting from `firstSegment`, with the
 * last one reaching `lastSegment` (same splitting approach as `server/render-node/split.mjs` and
 * the push queue).
 */
export function streamSpansInWindow(row: Pick<OnlineStream, "firstSegment" | "lastSegment" | "segmentsPerTask">, loSeg: number, hiSeg: number): Array<[number, number]> {
  const lo = Math.max(row.firstSegment, loSeg), hi = Math.min(row.lastSegment, hiSeg);
  if (hi < lo) return [];
  const per = Math.max(1, row.segmentsPerTask);
  const out: Array<[number, number]> = [];
  for (let from = row.firstSegment + Math.floor((lo - row.firstSegment) / per) * per; from <= hi; from += per) out.push([from, Math.min(row.lastSegment, from + per - 1)]);
  return out;
}

/** Layer table in content store response; returns null if shape is invalid */
export function parseLayerMap(body: unknown): LayerMap | null {
  const b = body as { v?: unknown; kind?: unknown; projectId?: unknown; fps?: unknown; span?: unknown; layers?: unknown; streams?: unknown } | null;
  if (!b || b.kind !== "layer-map" || !Array.isArray(b.layers)) return null;
  // Unrecognized versions treat the entire table as absent (C10 contract section 18, item 3);
  // omitted version is treated as v 1 (shape of C10a)
  const v = b.v === undefined ? 1 : Number(b.v);
  if (!(KNOWN_LAYER_MAP_VERSIONS as readonly number[]).includes(v)) return null;
  const span = Math.max(1, Math.floor(Number(b.span) || 60));
  const layers: OnlineLayer[] = [];
  const str = (x: unknown) => (typeof x === "string" && x ? x : null);
  for (const raw of b.layers as Record<string, unknown>[]) {
    const kind = raw?.kind;
    if (kind !== "html" && kind !== "local") continue;
    const firstFrame = Number(raw.firstFrame), count = Number(raw.count);
    if (typeof raw.clipId !== "string" || typeof raw.key !== "string" || typeof raw.resultKey !== "string") continue;
    if (!Number.isInteger(firstFrame) || firstFrame < 0 || !Number.isInteger(count) || count < 1) continue;
    const candidates = v >= LAYER_MAP_V3 ? candidatesOf(raw.candidates) : [];
    const inputSig = str(raw.inputSig);
    layers.push({ clipId: raw.clipId, kind, key: raw.key, resultKey: raw.resultKey, firstFrame, count,
      ...(v >= LAYER_MAP_V2 ? { contentKey: str(raw.contentKey), envFingerprint: str(raw.envFingerprint) } : {}),
      ...(candidates.length ? { candidates } : {}),
      ...(inputSig ? { inputSig } : {}) });
  }
  // Track stream tables only exist starting from v 3 (concept of candidates introduced in v 3);
  // earlier versions are not read
  const streams = v >= LAYER_MAP_V3 ? parseLayerStreams(b.streams) : [];
  return { v, projectId: typeof b.projectId === "string" ? b.projectId : null, fps: Number(b.fps) || 30, span, layers, streams };
}

/**
 * Whether this layer is usable in this tier (C10 contract section 5, section 18 item 3):
 *   - Fetching original-size prerender (`original`): only recognizes layers that are v 2 and
 *     carry `contentKey` and `envFingerprint`: the page does not compute keys; when deployed
 *     `/editor` and render node code versions mismatch, or layer table lacks these two items, this
 *     layer is treated as "no prerender output" (placeholder, pause live render) without throwing
 *     errors;
 *   - When only pasting sparse version (`small`): recognizes both v 1 and v 2.
 */
export function usableLayer(map: Pick<LayerMap, "v">, layer: OnlineLayer, { anyVersion = false }: { anyVersion?: boolean } = {}): boolean {
  if (anyVersion) return true;
  return map.v >= LAYER_MAP_V2 && !!layer.contentKey && !!layer.envFingerprint;
}

/**
 * The layer for a clip in the layer table (`original` spec):
 * returns `{ …, contentKey, envFingerprint }` if the layer table matches; returns null without
 * throwing if it mismatches (unrecognized version, v 1, missing content key, missing fingerprint,
 * layer absent, corrupt layer table). `table` accepts the content store response body or an
 * already-parsed layer table.
 *
 * Layer table v 3 (M7 contract D12): `opts.alive` is the result key recognized as alive by the page
 * (derived from `task.done` and manifests). If any candidate is alive, replace the whole thing with
 * that candidate (result key, fingerprint, and online key all come from the same candidate, never
 * mixed); returns the one on the layer (the first candidate) if there is no `alive` or it cannot be
 * identified.
 * v 2 ignores `alive`.
 * `opts.inputSig` (stale-layer): input signature for this clip calculated by the page from the
 * current project; returns null if this layer has a signature and it mismatches (layer with
 * outdated parameters).
 */
export function layerRefOf(table: unknown, clipId: string, opts: { anyVersion?: boolean; alive?: ReadonlySet<string>; inputSig?: string | null } = {}): OnlineLayer | null {
  let map: LayerMap | null = null;
  try {
    map = table && typeof table === "object" && Array.isArray((table as LayerMap).layers) && (table as LayerMap).v !== undefined && typeof (table as { kind?: unknown }).kind !== "string"
      ? (table as LayerMap) : parseLayerMap(table);
  } catch { map = null; }
  if (!map) return null;
  const layer = map.layers.find((l) => l.clipId === clipId);
  if (!layer) return null;
  if (inputSigStale(layer.inputSig, opts.inputSig)) return null;
  if (map.v >= LAYER_MAP_V3 && opts.alive && layer.candidates?.length) {
    const pick = layer.candidates.find((c) => opts.alive!.has(c.resultKey));
    if (pick) {
      const chosen: OnlineLayer = { ...layer, resultKey: pick.resultKey, envFingerprint: pick.envFingerprint, key: pick.key };
      return usableLayer(map, chosen, opts) ? chosen : null;
    }
  }
  return usableLayer(map, layer, opts) ? layer : null;
}

/** Segments of a layer falling within `[fromGlobal, toGlobal]` (global frames, closed interval): one segment every `span` frames starting from local frame 0, with the last segment reaching `count - 1` */
export function segmentsInWindow(layer: Pick<OnlineLayer, "firstFrame" | "count">, span: number, fromGlobal: number, toGlobal: number): Array<[number, number]> {
  const lo = Math.max(0, fromGlobal - layer.firstFrame);
  const hi = Math.min(layer.count - 1, toGlobal - layer.firstFrame);
  if (hi < lo) return [];
  const out: Array<[number, number]> = [];
  for (let from = lo - (lo % span); from <= hi; from += span) out.push([from, Math.min(layer.count - 1, from + span - 1)]);
  return out;
}

/** Frame number list → merged closed intervals */
export function framesToRanges(frames: Iterable<number>): ReadyRange[] {
  const sorted = [...new Set(frames)].filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (last && f === last[1] + 1) last[1] = f;
    else out.push([f, f]);
  }
  return out as unknown as ReadyRange[];
}

/** Small bitmap wrapped into an image covering the snapshot plane (snapshot plane is an inset:0 layer in the wrapper layer; small bitmap draws exactly the wrapper layer box) */
export function smallSnapshotHtml(dataUrl: string): string {
  return `<img data-pc-small-snapshot="" alt="" src="${dataUrl}" style="position:absolute;left:0;top:0;width:100%;height:100%;display:block;pointer-events:none">`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

/** Byte-counted LRU (length of data URL is the order of magnitude of its size in memory) */
export class ByteLru {
  private map = new Map<string, string>();
  private bytes = 0;
  private max: number;
  constructor(max: number) { this.max = max; }
  get(id: string): string | undefined {
    const hit = this.map.get(id);
    if (hit === undefined) return undefined;
    this.map.delete(id);
    this.map.set(id, hit);
    return hit;
  }
  set(id: string, value: string): void {
    const old = this.map.get(id);
    if (old !== undefined) { this.bytes -= old.length; this.map.delete(id); }
    this.map.set(id, value);
    this.bytes += value.length;
    while (this.bytes > this.max && this.map.size > 1) {
      const first = this.map.keys().next().value as string;
      this.bytes -= this.map.get(first)!.length;
      this.map.delete(first);
    }
  }
  has(id: string): boolean { return this.map.has(id); }
  get size(): number { return this.map.size; }
  get total(): number { return this.bytes; }
  clear(): void { this.map.clear(); this.bytes = 0; }
}

/** Byte-counted LRU storing raw bytes (head files and segments of track streams) */
export class BlockLru {
  private map = new Map<string, Uint8Array>();
  private bytes = 0;
  private max: number;
  constructor(max: number) { this.max = max; }
  get(id: string): Uint8Array | undefined {
    const hit = this.map.get(id);
    if (hit === undefined) return undefined;
    this.map.delete(id);
    this.map.set(id, hit);
    return hit;
  }
  /** Inserts an entry; returns the key evicted this time */
  set(id: string, value: Uint8Array): string[] {
    const old = this.map.get(id);
    if (old !== undefined) { this.bytes -= old.byteLength; this.map.delete(id); }
    this.map.set(id, value);
    this.bytes += value.byteLength;
    const dropped: string[] = [];
    while (this.bytes > this.max && this.map.size > 1) {
      const first = this.map.keys().next().value as string;
      this.bytes -= this.map.get(first)!.byteLength;
      this.map.delete(first);
      dropped.push(first);
    }
    return dropped;
  }
  has(id: string): boolean { return this.map.has(id); }
  get size(): number { return this.map.size; }
  get total(): number { return this.bytes; }
  clear(): void { this.map.clear(); this.bytes = 0; }
}

/** A head file in a stream manifest (variant) */
interface StreamInitMeta { hash: string; codec: string; width: number; height: number; rect: StreamRect }
/** A segment in a stream manifest */
interface StreamSegMeta { hash: string; init: string; stride: number; samples: number }
/** What a stream manifest (`render-manifest`, `<resultKey>:<start>-<end>`) looks like after being fetched */
interface StreamManifestState {
  resultKey: string;
  header: { kind: "card" | "group" | "below"; plane: "local" | "stage"; clipIds: string[]; fps: number; bound: StreamRect; tight: StreamRect | null } | null;
  inits: Map<string, StreamInitMeta>;
  segments: Map<number, StreamSegMeta>;
  /** Every segment in this manifest is present and full density: no need to fetch again (sparse segments will be replaced by full-density ones later, so they need to be fetched again) */
  full: boolean;
  fetchedAt: number;
  sig: string;
}
/** A stream with a selected candidate */
interface ChosenStream { row: OnlineStream; resultKey: string; envFingerprint: string }

const HASH_RE = /^[0-9a-f]{64}$/;
const rectOf = (r: unknown): StreamRect | null => {
  const o = r as Partial<StreamRect> | null;
  if (!o || typeof o !== "object") return null;
  const { x, y, w, h } = o;
  return [x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n)) && (w as number) > 0 && (h as number) > 0 ? { x: x as number, y: y as number, w: w as number, h: h as number } : null;
};

/** A stream manifest returned by content store → status; head files and segments with invalid shapes skipped. `seg` is the segment range this manifest should cover */
function parseStreamManifest(body: unknown, resultKey: string, seg: [number, number], now: number): StreamManifestState {
  const b = body as { kind?: unknown; resultKey?: unknown; header?: Record<string, unknown>; inits?: Record<string, Record<string, unknown>>; segments?: Record<string, Record<string, unknown>> } | null;
  const state: StreamManifestState = { resultKey, header: null, inits: new Map(), segments: new Map(), full: false, fetchedAt: now, sig: "" };
  if (!b || typeof b !== "object" || b.kind !== "stream" || b.resultKey !== resultKey) return state;
  const h = b.header;
  const bound = rectOf(h?.bound);
  const clipIds = Array.isArray(h?.clipIds) ? (h!.clipIds as unknown[]).filter((x): x is string => typeof x === "string" && !!x) : [];
  if (h && bound && clipIds.length && Number(h.fps) > 0) {
    state.header = { kind: h.kind === "group" ? "group" : h.kind === "below" ? "below" : "card", plane: h.plane === "stage" ? "stage" : "local", clipIds, fps: Number(h.fps), bound, tight: rectOf(h.tight) };
  }
  for (const [id, meta] of Object.entries(b.inits && typeof b.inits === "object" ? b.inits : {})) {
    const rect = rectOf(meta?.rect);
    if (!/^[0-9a-f]{16}$/.test(id) || !HASH_RE.test(String(meta?.hash)) || !rect || typeof meta.codec !== "string") continue;
    state.inits.set(id, { hash: String(meta.hash), codec: meta.codec, width: Number(meta.width) || 0, height: Number(meta.height) || 0, rect });
  }
  for (const [name, meta] of Object.entries(b.segments && typeof b.segments === "object" ? b.segments : {})) {
    const n = Number(name);
    if (!Number.isInteger(n) || n < seg[0] || n > seg[1] || !HASH_RE.test(String(meta?.hash)) || !state.inits.has(String(meta.init))) continue;
    const stride = Number(meta.stride), samples = Number(meta.samples);
    if (!Number.isInteger(stride) || stride < 1 || !Number.isInteger(samples) || samples < 1) continue;
    state.segments.set(n, { hash: String(meta.hash), init: String(meta.init), stride, samples });
  }
  let full = !!state.header;
  for (let n = seg[0]; n <= seg[1] && full; n++) full = state.segments.get(n)?.stride === 1;
  state.full = full;
  state.sig = JSON.stringify([state.header, [...state.inits], [...state.segments]]);
  return state;
}

/** Whether fetched bytes match this hash (not verified when browser lacks WebCrypto; assumed matching) */
async function bytesMatchHash(bytes: Uint8Array, hash: string): Promise<boolean> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) return true;
  try {
    const digest = new Uint8Array(await subtle.digest("SHA-256", bytes as unknown as BufferSource));
    let hex = "";
    for (const v of digest) hex += v.toString(16).padStart(2, "0");
    return hex === hash;
  } catch {
    return true;
  }
}

/** A "stream → signature" cache per project (immutable object) */
const streamSigCache = new WeakMap<object, Map<string, string | null>>();
function cachedStreamSig(project: unknown, row: Pick<OnlineStream, "clipIds" | "kind">): string | null {
  if (!project || typeof project !== "object") return null;
  let byRow = streamSigCache.get(project);
  if (!byRow) { byRow = new Map(); streamSigCache.set(project, byRow); }
  const id = `${row.kind}:${row.clipIds.join(",")}`;
  if (byRow.has(id)) return byRow.get(id) ?? null;
  const sig = streamInputSig(project, row);
  byRow.set(id, sig);
  return sig;
}

interface ManifestState {
  /** Local frame → small bitmap hash */
  small: Map<number, string>;
  /** Local frame → original-size HTML snapshot hash (`frames` table) */
  frames: Map<number, string>;
  /** Every frame in this segment already has this tier: no need to fetch again */
  full: boolean;
  fetchedAt: number;
}

/**
 * Which tier the online source fetches (C10 contract section 5): `original` fetches original-size
 * prerender (HTML snapshots at `snap/<hash>`); `small` is when pasting sparse version only: track
 * streams paste sparse version only (file header item 7), and the snapshot path fetches small
 * bitmaps at `px/<hash>` (small-size prerender was discontinued on 2026-10-13; nothing can be
 * fetched from this path, kept until snapshots are removed).
 */
export type OnlineTier = "small" | "original";

/** Items used by in-page snapshot store L2 (`L2Store` in `src/online/l2.ts`; only lists interfaces here, does not import implementation) */
export interface L2Like {
  putBlock(key: string, bytes: Uint8Array | ArrayBuffer, type?: string): Promise<unknown>;
  getBlock(key: string): Promise<{ bytes: Uint8Array; type: string } | null>;
  hasBlock(key: string): boolean;
  putRange(layerKey: string, from: number, to: number): Promise<Array<[number, number]>>;
  getRanges(layerKey: string): Promise<Array<[number, number]>>;
  subscribeReady(cb: (e: { layerKey: string; ranges: Array<[number, number]> }) => void): () => void;
}

/**
 * Two items used when pasting sparse version only to query "whether this browser can decode track
 * streams" (file header item 7). Other tiers are not queried (as-is). Unit tests inject mocks.
 */
export interface StreamDecodeSupport {
  /** Whether the browser has `VideoDecoder` */
  available(): boolean;
  /** Whether this encoding configuration (the `codec` and encoded aspect ratio of the head file item in the stream manifest) can be decoded */
  supports(config: { codec: string; codedWidth: number; codedHeight: number }): Promise<boolean>;
}
/** Default: queries browser itself. If `isConfigSupported` throws or returns no result, it is considered unsupported; older implementations without this method only check for `VideoDecoder` */
export const browserDecodeSupport: StreamDecodeSupport = {
  available: () => typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === "function",
  supports: async (config) => {
    const VD = (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
    if (typeof VD !== "function") return false;
    const ask = (VD as { isConfigSupported?: (c: unknown) => Promise<{ supported?: boolean }> }).isConfigSupported;
    if (typeof ask !== "function") return true;
    try { return (await ask.call(VD, config))?.supported === true; } catch { return false; }
  },
};

export interface OnlineSourceOptions {
  /** In-memory cache upper limit when there is no L2 (64 MiB in C10a) */
  maxBytes?: number;
  tier?: OnlineTier;
  /** Queries whether browser can decode streams when pasting sparse version only (defaults to `browserDecodeSupport`) */
  decodeSupport?: StreamDecodeSupport;
  /** In-page snapshot store L2 (C10 contract section 4); if provided, chunks are stored into it, keeping only a small recently-used portion in memory */
  store?: L2Like | Promise<L2Like | null> | null;
}

/** Maximum wait time for L2 to open (milliseconds); falls back to memory if it fails to open */
export const STORE_WAIT_MS = 5000;
/** When L2 is present, keep only this many recently used items in memory (to avoid repeatedly decoding / reading the store within the same window) */
export const ONLINE_HOT_CACHE_BYTES = 16 * 1024 * 1024;

const textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

/** Online implementation (see above) */
export class OnlineSnapshotSource implements SnapshotSource {
  private deps: OnlineSnapshotDeps;
  private cache: ByteLru;
  private inflight = new Map<string, Promise<string>>();
  private projectId: string | null = null;
  private map: LayerMap | null = null;
  private mapSig = "";
  private manifests = new Map<string, ManifestState>();
  private manifestFlying = new Set<string>();
  /** Track streams: stream manifests (`<resultKey>:<start>-<end>` → status) */
  private streamManifests = new Map<string, StreamManifestState>();
  /** Track streams: head files and segments fetched to this page (hash → bytes) */
  private streamBlocks = new BlockLru(STREAM_CACHE_MAX_BYTES);
  private streamFlying = new Map<string, Promise<void>>();
  /** Failed chunks: hash → failure timestamp (re-fetched after `STREAM_RETRY_MS`) */
  private streamFailedAt = new Map<string, number>();
  private streamPlaneMemo = new Map<string, { rev: number; plane: { manifest: StreamManifest; blocks: Map<string, Uint8Array> } | null }>();
  /** Incremented whenever stream manifests or bytes change: parent page re-emits stream plane based on this (when files swap for the same segment, ready interval is unchanged, so interval comparison alone cannot detect it) */
  streamRev = 0;
  /** Latest ready emitted by each layer (`<kind>:<clipId>` → signature and key to retract layer); if a layer is unusable (expired, gone), emit an empty layer to retract */
  private emitted = new Map<string, { sig: string; clipId: string; kind: ReadyKind; key: string }>();
  /** Current project on the page (used to calculate input signatures of clips, stale-layer); if omitted, signatures are not compared */
  private inputProject: unknown = null;
  /** Expired layers: clip → timestamp from which it expired (not recalculated if the pair of layer signature and page signature has not changed) */
  private staleSince = new Map<string, { key: string; since: number; expired: boolean }>();
  private listeners = new Set<(m: ReadyMessage) => void>();
  private timer: unknown = null;
  private playhead = { t: 0, fps: 30 };
  private lastMapAt = -Infinity;
  private stopped = false;
  private running: Promise<void> | null = null;
  private again = false;
  private queue: Array<() => Promise<void>> = [];
  private active = 0;
  readonly tier: OnlineTier;
  private store: L2Like | null = null;
  private storeOff: (() => void) | null = null;
  /**
   * Do not fetch while L2 is still opening: otherwise the first round of prefetching is sent before
   * the store opens, causing chunks already in the store to be requested again upon reopening
   * (C10-A2). Waits up to `STORE_WAIT_MS`; falls back to memory if it cannot open.
   */
  private storeWait: Promise<unknown> | null = null;
  /** Original size: local frames already in L2 for each layer (by result key) (mirror of `ranges` table) */
  private inStore = new Map<string, Set<number>>();
  private rangesLoaded = new Set<string>();
  /** Called after fetching a new chunk (host resubmits based on this) */
  onFetched: (() => void) | null = null;
  /** Whether the layer table has ever been fetched (fetched, or content store returned "no such entry"); cannot determine which layers lack artifacts before fetching */
  private mapKnown = false;
  /** Subscribers called when coverage may have changed (layer table changed, manifest arrived) */
  private coverageListeners = new Set<() => void>();
  readonly stats = { mapFetches: 0, manifestFetches: 0, smallFetches: 0, smallBytes: 0, snapFetches: 0, snapBytes: 0, l2Hits: 0, errors: 0,
    streamManifestFetches: 0, streamFetches: 0, streamBytes: 0, streamFailures: 0 };

  private decodeSupport: StreamDecodeSupport;
  /** When pasting sparse version only: whether this browser can decode head file encoding configuration (by hash); null while querying */
  private initDecodable = new Map<string, boolean | null>();

  constructor(deps: OnlineSnapshotDeps, { maxBytes = ONLINE_CACHE_MAX_BYTES, tier = "small", store = null, decodeSupport = browserDecodeSupport }: OnlineSourceOptions = {}) {
    this.deps = deps;
    this.tier = tier;
    this.decodeSupport = decodeSupport;
    if (tier === "small") this.streamBlocks = new BlockLru(SPARSE_STREAM_CACHE_MAX_BYTES);
    this.cache = new ByteLru(store ? Math.min(maxBytes, ONLINE_HOT_CACHE_BYTES) : maxBytes);
    if (store) {
      const opened = Promise.resolve(store).then((s) => {
        if (!s || this.stopped) return;
        this.store = s;
        this.storeOff = s.subscribeReady((e) => this.onStoreReady(e.layerKey, e.ranges));
        this.rangesLoaded.clear();
      }, () => { /* Cannot open L2: fall back to memory */ });
      this.storeWait = Promise.race([opened, new Promise((r) => setTimeout(r, STORE_WAIT_MS))]).then(() => { this.storeWait = null; });
    }
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }
  /** When pasting sparse version only (only one stage; also recognizes layer table v 1) */
  private get sparseOnly(): boolean { return this.tier === "small"; }

  /** Usable layers in this tier at this moment (`original` only recognizes v 2 layers with both items present; outdated layers with mismatching input signatures excluded) */
  private layers(): OnlineLayer[] {
    const map = this.map;
    if (!map) return [];
    return map.layers.map((l) => this.chosen(map, l)).filter((l) => usableLayer(map, l, { anyVersion: this.sparseOnly }) && !this.stale(l));
  }

  /** Input signature calculated by the page for this clip from current project; returns null if project omitted (no comparison) */
  private pageSig(clipId: string): string | null {
    return this.inputProject ? cachedClipInputSig(this.inputProject, clipId) : null;
  }

  /** This layer is the result of outdated inputs (layer carries signature, page can also calculate one, and both differ) */
  private stale(layer: OnlineLayer): boolean {
    return !!layer.inputSig && inputSigStale(layer.inputSig, this.pageSig(layer.clipId));
  }

  /** The layer for this clip in the layer table has expired (originally usable in this tier, but inputs mismatch) */
  private staleLayerOf(clipId: string): OnlineLayer | null {
    const map = this.map;
    if (!map) return null;
    for (const raw of map.layers) {
      if (raw.clipId !== clipId) continue;
      const l = this.chosen(map, raw);
      if (usableLayer(map, l, { anyVersion: this.sparseOnly }) && this.stale(l)) return l;
    }
    return null;
  }

  /** Records which layers have expired and from what timestamp; removes those no longer expired. Returns "whether the expired set has changed" */
  private noteStale(): boolean {
    const map = this.map;
    const now = this.now();
    const seen = new Set<string>();
    let changed = false;
    for (const raw of map?.layers ?? []) {
      if (seen.has(raw.clipId)) continue;
      const l = this.staleLayerOf(raw.clipId);
      if (!l) continue;
      seen.add(l.clipId);
      const key = `${l.inputSig}|${this.pageSig(l.clipId)}`;
      const rec = this.staleSince.get(l.clipId);
      if (!rec || rec.key !== key) { this.staleSince.set(l.clipId, { key, since: now, expired: false }); changed = true; }
    }
    for (const id of [...this.staleSince.keys()]) if (!seen.has(id)) { this.staleSince.delete(id); changed = true; }
    return changed;
  }

  /** Whether the expired layer is still within the "new results on the way" period (`STALE_AWAIT_MS`) */
  private staleAwaiting(clipId: string): boolean {
    if (!this.staleLayerOf(clipId)) return false;
    const rec = this.staleSince.get(clipId);
    if (!rec) return true;
    return this.now() - rec.since < STALE_AWAIT_MS;
  }

  /**
   * The project at this moment on the page (stale-layer): calculate the input signature of each clip
   * from it and compare with `inputSig` of each layer in the layer table; stale layers that do not
   * match are immediately removed (empty ready ranges are emitted, and the page displays placeholders
   * or live renders in fallback order); matching layers (parameters reverted to original) are pasted
   * as usual. Recomputed only when the project becomes a new object.
   */
  setInputs(project: unknown): void {
    const next = project && typeof project === "object" ? project : null;
    if (next === this.inputProject) return;
    this.inputProject = next;
    const changed = this.noteStale();
    // Stream input signatures change with the project: stale streams are removed in publishLayers
    // (emit empty layers), and emitted as usual once they match again
    this.streamPlaneMemo.clear();
    this.publishLayers();
    if (changed) this.coverageChanged();
  }

  /*
   * Candidates of layer table v 3 (M7 contract D12): which copy is alive is determined by this page
   * based on `task.done` (alive) and `task.failed { error: 'superseded' }` (that copy is invalidated:
   * another copy is alive, not a failure) pushed from the queue. Candidates determined to be alive
   * take priority; when none is determined, take the first non-invalidated one; if all are invalidated
   * or there are no candidates, use the one on the layer as before. Once selected, replace the entire
   * thing with that candidate (`alive` of `layerRefOf`; result key, fingerprint, and online key all
   * come from the same candidate).
   */
  private aliveKeys = new Set<string>();
  private deadKeys = new Set<string>();

  private chosen(map: LayerMap, layer: OnlineLayer): OnlineLayer {
    if (map.v < LAYER_MAP_V3 || !layer.candidates?.length) return layer;
    const pick = layer.candidates.find((c) => this.aliveKeys.has(c.resultKey)) ?? layer.candidates.find((c) => !this.deadKeys.has(c.resultKey));
    if (!pick || pick.resultKey === layer.resultKey) return layer;
    return layerRefOf(map, layer.clipId, { anyVersion: this.sparseOnly, alive: new Set([pick.resultKey]) }) ?? layer;
  }

  /**
   * `task.done` / `task.failed` pushed to this page (as publisher) by the queue (M7 D12): completed
   * result keys are determined to be alive, and the copy invalidated by `superseded` is treated as
   * dead. Once the determination changes, immediately re-emit all layers (layers that changed
   * candidates replace keys across the whole layer). Ignore other messages.
   */
  noteQueueEvent(msg: { type?: unknown; id?: unknown; resultKey?: unknown; error?: unknown }): void {
    const id = typeof msg?.id === "string" ? msg.id : "";
    const keyOf = () => {
      if (typeof msg.resultKey === "string" && msg.resultKey) return msg.resultKey;
      // Fine-grained task id: `<kind>:<resultKey>:<from>-<to>`; sparse stream task ids have an extra
      // `:sparse` segment at the end (`taskIdOf` in `server/render-queue/messages.mjs`)
      const m = /^(?:snapshot|stream):(.+):\d+-\d+(?::sparse)?$/.exec(id);
      return m ? m[1] : null;
    };
    let changed = false;
    if (msg?.type === "task.done") {
      const key = keyOf();
      if (key && !this.aliveKeys.has(key)) { this.aliveKeys.add(key); this.deadKeys.delete(key); changed = true; }
    } else if (msg?.type === "task.failed" && msg.error === "superseded") {
      const key = keyOf();
      if (key && !this.deadKeys.has(key) && !this.aliveKeys.has(key)) { this.deadKeys.add(key); changed = true; }
    }
    if (changed) { this.publishLayers(); this.kick(); }
  }

  /** This page produced and completed this segment itself (pure browser node): this result key is alive */
  markAlive(resultKey: string): void {
    this.noteQueueEvent({ type: "task.done", resultKey });
  }

  /** Checks which project (the key of the layer table); if the project changes, clear the table and start over */
  setProject(projectId: string | null): void {
    const next = projectId || null;
    if (next === this.projectId) return;
    this.projectId = next;
    this.map = null;
    this.mapSig = "";
    this.mapKnown = false;
    this.manifests.clear();
    this.streamManifests.clear();
    this.streamFailedAt.clear();
    this.streamPlaneMemo.clear();
    this.streamRev++;
    this.emitted.clear();
    this.staleSince.clear();
    this.lastMapAt = -Infinity;
    this.emit({ type: "reset", localRev: 0 });
    this.coverageChanged();
    this.kick();
  }

  /**
   * The queue reported `task.done` (C10 contract section 7 "Page subscribes to task.done, merged into
   * layer table and ready"): without waiting for the next polling round, immediately re-fetch the
   * layer table and also re-fetch manifests that are not yet full.
   */
  refresh(): void {
    this.lastMapAt = -Infinity;
    for (const st of this.manifests.values()) if (!st.full) st.fetchedAt = -Infinity;
    for (const st of this.streamManifests.values()) if (!st.full) st.fetchedAt = -Infinity;
    this.kick();
  }

  /** Playhead moved: fetch manifests for this window, prefetch chunks for visible heavy layers in this window */
  focus(t: number, fps: number): void {
    this.playhead = { t: Number(t) || 0, fps: Math.max(1, Number(fps) || 30) };
    this.kick();
  }

  subscribeReady(_session: string, _localRev: number, onMessage: (m: ReadyMessage) => void): () => void {
    this.listeners.add(onMessage);
    // New subscriber: reset first, then emit all layers currently in hand once (recovery path in C3)
    try { onMessage({ type: "reset", localRev: 0 }); } catch { /* The subscriber is broken */ }
    for (const layer of this.layers()) {
      try { onMessage(this.layerMessage(layer)); } catch { /* Same as above */ }
    }
    for (const s of this.streamsNow()) {
      const msg = this.streamMessage(s);
      if (msg.type === "layer" && msg.ranges.length) { try { onMessage(msg); } catch { /* Same as above */ } }
    }
    this.kick();
    return () => { this.listeners.delete(onMessage); };
  }

  async fetchSnapshot(kind: ReadyKind, key: string, localFrame: number, signal?: AbortSignal): Promise<string> {
    if (this.storeWait) await this.storeWait;
    if (this.tier === "original") {
      const hit = this.frameOf(kind, key, localFrame);
      if (!hit) throw Object.assign(new Error(`No full-size prerender for this frame: ${kind}/${key}/${localFrame}`), { status: 404 });
      const cached = this.cache.get(`snap/${hit.hash}`);
      if (cached !== undefined) return cached;
      return this.fetchOriginal(hit.hash, hit.layer, localFrame, signal);
    }
    const hash = this.smallHashOf(kind, key, localFrame);
    if (!hash) throw Object.assign(new Error(`No small-size prerender for this frame: ${kind}/${key}/${localFrame}`), { status: 404 });
    const hit = this.cache.get(hash);
    if (hit !== undefined) return smallSnapshotHtml(hit);
    return smallSnapshotHtml(await this.fetchSmall(hash, signal));
  }

  /**
   * How much prerender output covers this clip (C10 contract section 9, used by timeline badge):
   * layer table not yet fetched → `unknown`; no available layer for this tier → `none`; layer exists,
   * but the manifest of some segment has never been fetched → `unknown`; manifests of all segments
   * have been fetched, but some segment has incomplete frames for this tier → `partial`; all segments
   * are complete → `full`.
   * "Complete" checks manifests (results are in the asset service), not whether bytes have been
   * fetched to this page. Manifests for the whole clip are only fetched for layers designated by
   * `coverageLayer` (see `loadWindow`).
   * The badge is only shown when confirmed not covering the whole clip (`none` / `partial`);
   * `unknown` does not show (does not flash when just opening the page).
   */
  coverage(clipId: string): LayerCoverage {
    if (!this.mapKnown) return "unknown";
    const layer = this.layers().find((l) => l.clipId === clipId);
    // Layers with stale input: not yet known while new results are on the way (do not show badge)
    if (!layer) return this.staleAwaiting(clipId) ? "unknown" : "none";
    const span = this.map?.span ?? 60;
    let partial = false;
    for (let from = 0; from < layer.count; from += span) {
      const seg = this.segOf(layer, from);
      const st = this.manifests.get(this.manifestKey(layer, seg));
      if (!st) return "unknown";
      const mine = this.tier === "original" ? st.frames : st.small;
      if (mine.size < seg[1] - seg[0] + 1) partial = true;
    }
    return partial ? "partial" : "full";
  }

  /**
   * Whether the parent page can confirm "there is no applicable prerender output for this frame of
   * this clip" (C10 contract section 9; from 2026-10-21 the stage always displays an hourglass and
   * no longer switches icons based on this): layer table has been fetched and this clip has no
   * available layer; or the manifest of the segment containing this frame has been fetched and this
   * frame (for this tier) is not in it. Layer table not fetched, manifest not arrived, or present in
   * manifest while bytes are still on the way, none count as confirmed (stage displays normal loading
   * placeholder). `localFrame` uses clip-local frames, clamped into the layer's frame count.
   */
  frameConfirmedMissing(clipId: string, localFrame: number): boolean {
    if (!this.mapKnown) return false;
    const layer = this.layers().find((l) => l.clipId === clipId);
    // Layers with stale input (stale-layer): not confirmed (hourglass) while the render node has not
    // rewritten the layer table for the new input; confirmed only after `STALE_AWAIT_MS` has passed
    if (!layer) return !this.staleAwaiting(clipId);
    if (layer.count <= 0) return true;
    const f = Math.min(layer.count - 1, Math.max(0, Math.round(Number(localFrame) || 0)));
    const st = this.manifests.get(this.manifestKey(layer, this.segOf(layer, f)));
    if (!st) return false;
    return !(this.tier === "original" ? st.frames : st.small).has(f);
  }

  /** Calls `cb` when coverage may have changed (layer table changed, manifest arrived); returns unsubscribe function */
  subscribeCoverage(cb: () => void): () => void {
    this.coverageListeners.add(cb);
    return () => { this.coverageListeners.delete(cb); };
  }

  private coverageChanged() {
    for (const l of [...this.coverageListeners]) { try { l(); } catch { /* The subscriber is broken */ } }
  }

  /**
   * Clips listed in the layer table (c10a contract section 17 "Prerender retry" determines artifacts
   * by manifest: for layers classified as heavy not in the layer table, the asset service has no
   * artifacts for them). Returns null if the layer table has never been fetched back (cannot
   * determine); returns an empty set if there is no layer table in the content store (not a single
   * layer).
   */
  layerClipIds(): ReadonlySet<string> | null {
    if (!this.mapKnown) return null;
    return new Set(this.layers().map((l) => l.clipId));
  }

  /** Current layer table (used by probe); returns null if not yet available */
  layerMap(): LayerMap | null {
    return this.map;
  }

  /**
   * Releases cache before export (contract section 11.1): the in-memory copy; L2 is a rebuildable
   * cache store, leave untouched
   */
  clearCache(): void { this.cache.clear(); }
  get cacheBytes(): number { return this.cache.total; }
  get cacheSize(): number { return this.cache.size; }
  /** Used by probe: current layer table and ready frame count of each layer */
  debug() {
    const usable = this.layers();
    return {
      projectId: this.projectId,
      tier: this.tier,
      mapVersion: this.map?.v ?? null,
      store: !!this.store,
      layers: usable.map((l) => ({ clipId: l.clipId, kind: l.kind, key: l.key, resultKey: l.resultKey, envFingerprint: l.envFingerprint ?? null, ready: this.readyFrames(l).length,
        candidates: l.candidates?.length ?? 0, inputSig: l.inputSig ?? null })),
      stale: [...this.staleSince.entries()].map(([clipId, r]) => ({ clipId, sinceMs: this.now() - r.since, awaiting: this.now() - r.since < STALE_AWAIT_MS })),
      aliveKeys: this.aliveKeys.size,
      deadKeys: this.deadKeys.size,
      skipped: (this.map?.layers ?? []).filter((l) => !usable.includes(l)).map((l) => l.clipId),
      manifests: this.manifests.size,
      streams: this.streamsNow().map((s) => ({ clipId: s.row.topClipId, kind: s.row.kind, members: s.row.clipIds.length, resultKey: s.resultKey, envFingerprint: s.envFingerprint,
        candidates: s.row.candidates.length, originFrame: s.row.originFrame, firstSegment: s.row.firstSegment, lastSegment: s.row.lastSegment, ready: this.streamReady(s).length, inputSig: s.row.inputSig ?? null })),
      staleStreams: (this.map?.streams ?? []).filter((r) => this.streamStale(r)).map((r) => r.topClipId),
      streamManifests: this.streamManifests.size, streamBlocks: this.streamBlocks.size, streamBlockBytes: this.streamBlocks.total, streamRev: this.streamRev,
      cacheBytes: this.cache.total, cacheSize: this.cache.size, ...this.stats,
    };
  }

  /* ---------------- Track stream (external) ---------------- */

  /**
   * Items to pass when the parent page sends a stream plane to the stage (queried by
   * `StreamPlaneSender` in `streamPlayer.ts`): the current manifest and bytes for this stream (key on
   * ready index line = result key). The manifest only lists segments whose bytes are already on this
   * page (same criteria as emitted ready ranges); the segment's `file` is its hash, and the head
   * file additionally carries `hash`; `blocks` are all chunks used by the manifest. Returns null if
   * this stream is not in the layer table, is stale, or not a single segment has been fetched.
   */
  streamPlane(key: string): { manifest: StreamManifest; blocks: Map<string, Uint8Array> } | null {
    const memo = this.streamPlaneMemo.get(key);
    if (memo && memo.rev === this.streamRev) {
      // Used chunks count as recently used (preventing segments currently playing from being evicted)
      if (memo.plane) for (const hash of memo.plane.blocks.keys()) this.streamBlocks.get(hash);
      return memo.plane;
    }
    const plane = this.buildStreamPlane(key);
    if (this.streamPlaneMemo.size > 64) this.streamPlaneMemo.clear();
    this.streamPlaneMemo.set(key, { rev: this.streamRev, plane });
    return plane;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
    this.listeners.clear();
    this.coverageListeners.clear();
    this.queue.length = 0;
    this.streamBlocks.clear();
    this.streamPlaneMemo.clear();
    this.storeOff?.();
    this.storeOff = null;
  }

  /** Unit test use: manually run a round (fetch layer table, fetch manifests in window, prefetch) */
  async tickNow(): Promise<void> { await this.tick(); }

  /** Unit test use: wait for all in-flight chunk fetches to settle */
  async idle(): Promise<void> {
    for (let i = 0; i < 50 && (this.inflight.size || this.streamFlying.size || this.active || this.queue.length); i++) {
      await Promise.allSettled([...this.inflight.values(), ...this.streamFlying.values()]);
    }
  }

  /* ---------------- Internal ---------------- */

  private emit(m: ReadyMessage) {
    for (const l of [...this.listeners]) { try { l(m); } catch { /* A broken subscriber must not affect others */ } }
  }

  private manifestKey(layer: OnlineLayer, seg: [number, number]) { return `${layer.resultKey}:${seg[0]}-${seg[1]}`; }

  private segOf(layer: OnlineLayer, localFrame: number): [number, number] {
    const span = this.map?.span ?? 60;
    const from = localFrame - (localFrame % span);
    return [from, Math.min(layer.count - 1, from + span - 1)];
  }

  private readyFrames(layer: OnlineLayer): number[] {
    const out: number[] = [];
    const span = this.map?.span ?? 60;
    const have = this.inStore.get(layer.resultKey);
    for (let from = 0; from < layer.count; from += span) {
      const st = this.manifests.get(this.manifestKey(layer, this.segOf(layer, from)));
      if (!st) continue;
      if (this.tier === "original") {
        // Ready on write (C10 contract section 4): frames count as ready only if present in the manifest
        // and chunks are already written to L2; falls back to "present in the manifest" when without L2
        for (const f of st.frames.keys()) if (!this.store || have?.has(f)) out.push(f);
      } else {
        for (const f of st.small.keys()) out.push(f);
      }
    }
    return out;
  }

  private layerMessage(layer: OnlineLayer): ReadyMessage {
    return { type: "layer", clipId: layer.clipId, kind: layer.kind, key: layer.key, ranges: framesToRanges(this.readyFrames(layer)) };
  }

  /**
   * Emitted only when ready ranges of layers change (full semantics); layers previously emitted but
   * now unusable (mismatched inputs, tier no longer recognized) are removed by emitting empty layers.
   */
  private publishLayers() {
    const live = new Set<string>();
    for (const layer of this.layers()) {
      const msg = this.layerMessage(layer);
      if (msg.type !== "layer") continue;
      const id = `${layer.kind}:${layer.clipId}`;
      live.add(id);
      const sig = `${msg.key}|${JSON.stringify(msg.ranges)}`;
      if (this.emitted.get(id)?.sig === sig) continue;
      this.emitted.set(id, { sig, clipId: layer.clipId, kind: layer.kind, key: layer.key });
      this.emit(msg);
    }
    // Track stream: one layer per stream (`kind: 'stream'`, range unit is segment number). Do not emit
    // if not even a single segment was fetched; previously emitted ones now gone are removed below
    for (const s of this.streamsNow()) {
      const msg = this.streamMessage(s);
      if (msg.type !== "layer" || !msg.ranges.length) continue;
      const id = `stream:${s.row.topClipId}`;
      if (live.has(id)) continue;   // The same card is listed in two rows in the table: recognize only the first row
      live.add(id);
      const sig = `${msg.key}|${JSON.stringify(msg.ranges)}|${msg.groupClipIds?.join(",") ?? ""}|${msg.originFrame ?? ""}|${msg.streamKind ?? ""}|${msg.inputSig ?? ""}`;
      if (this.emitted.get(id)?.sig === sig) continue;
      this.emitted.set(id, { sig, clipId: s.row.topClipId, kind: "stream", key: s.resultKey });
      this.emit(msg);
    }
    for (const [id, prev] of [...this.emitted]) {
      if (live.has(id)) continue;
      this.emitted.delete(id);
      this.emit({ type: "layer", clipId: prev.clipId, kind: prev.kind, key: prev.key, ranges: [] });
    }
  }

  /** L2 `ranges` written (ready on write): update mirror, re-emit readiness */
  private onStoreReady(layerKey: string, ranges: Array<[number, number]>) {
    const set = new Set<number>();
    for (const [a, b] of ranges) for (let f = a; f <= b; f++) set.add(f);
    this.inStore.set(layerKey, set);
    if (this.layers().some((l) => l.resultKey === layerKey)) this.publishLayers();
  }

  /**
   * Layer table arrived: read ranges already in L2 for each layer into the mirror (when closed and
   * reopened, chunks already in store will not be requested again).
   */
  private async loadStoreRanges(): Promise<void> {
    const store = this.store;
    if (!store || this.tier !== "original") return;
    let changed = false;
    for (const layer of this.layers()) {
      if (this.rangesLoaded.has(layer.resultKey)) continue;
      this.rangesLoaded.add(layer.resultKey);
      try {
        const ranges = await store.getRanges(layer.resultKey);
        const set = this.inStore.get(layer.resultKey) ?? new Set<number>();
        for (const [a, b] of ranges) for (let f = a; f <= b; f++) set.add(f);
        this.inStore.set(layer.resultKey, set);
        changed = true;
      } catch { this.rangesLoaded.delete(layer.resultKey); }
    }
    if (changed) this.publishLayers();
  }

  private smallHashOf(kind: ReadyKind, key: string, localFrame: number): string | null {
    for (const layer of this.layers()) {
      if (layer.kind !== kind || layer.key !== key) continue;
      const hash = this.manifests.get(this.manifestKey(layer, this.segOf(layer, localFrame)))?.small.get(localFrame);
      if (hash) return hash;
    }
    return null;
  }

  /**
   * Original size: HTML snapshot hash of this frame and the layer it belongs to. A layer only
   * fetches frames for that environment recorded in the layer table (C10 contract section 5):
   * manifests are fetched by the layer's result key in the layer table, and the result key is
   * "content key × that environment's fingerprint".
   */
  private frameOf(kind: ReadyKind, key: string, localFrame: number): { hash: string; layer: OnlineLayer } | null {
    for (const layer of this.layers()) {
      if (layer.kind !== kind || layer.key !== key) continue;
      const hash = this.manifests.get(this.manifestKey(layer, this.segOf(layer, localFrame)))?.frames.get(localFrame);
      if (hash) return { hash, layer };
    }
    return null;
  }

  private kick() {
    if (this.stopped) return;
    void this.tick();
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    const clear = this.deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
    const set = this.deps.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d));
    if (this.timer !== null) clear(this.timer);
    this.timer = set(() => { this.timer = null; void this.tick(); }, ms);
  }

  /**
   * Run a round; if currently running, record a note and run another round when finished (the
   * playhead or project changed again during this round).
   */
  private tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        try { await this.tickOnce(); } catch { this.stats.errors++; }
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = null;
      this.schedule(MANIFEST_POLL_MS);
    });
    return this.running;
  }

  private async tickOnce(): Promise<void> {
    if (this.storeWait) await this.storeWait;
    const now = this.now();
    // Stale layers waiting for full `STALE_AWAIT_MS` without a new layer: transition from "on the way"
    // to confirmed missing, notifying coverage subscribers to recompute (icons, badges)
    let expired = false;
    for (const rec of this.staleSince.values()) {
      if (!rec.expired && now - rec.since >= STALE_AWAIT_MS) { rec.expired = true; expired = true; }
    }
    if (expired) this.coverageChanged();
    if (this.projectId && now - this.lastMapAt >= LAYER_MAP_POLL_MS) {
      this.lastMapAt = now;
      await this.loadMap();
    }
    await this.loadStoreRanges();
    await this.loadWindow(now);
    await this.loadStreamWindow(now);
    this.prefetchStreams();
  }

  /* ---------------- Track stream (internal) ---------------- */

  /** This stream is the result of stale input (row carries signature, page can also compute it, and the two differ) */
  private streamStale(row: OnlineStream): boolean {
    return !!row.inputSig && !!this.inputProject && streamSigStale(row.inputSig, cachedStreamSig(this.inputProject, row));
  }

  /**
   * When only pasting sparse versions: whether this browser can paste streams using this head file
   * (item 7 in file header). Other tiers are always true. When asked for the first time, query the
   * browser; treat as unsupported until answered (do not fetch those segments yet, not counted as
   * ready), and re-emit readiness once answered "ok".
   */
  private decodable(init: StreamInitMeta): boolean {
    if (!this.sparseOnly) return true;
    const known = this.initDecodable.get(init.hash);
    if (known !== undefined) return known === true;
    this.initDecodable.set(init.hash, null);
    if (this.initDecodable.size > 1024) { this.initDecodable.clear(); this.initDecodable.set(init.hash, null); }
    void Promise.resolve()
      .then(() => this.decodeSupport.supports({ codec: init.codec, codedWidth: init.width, codedHeight: init.height }))
      .catch(() => false)
      .then((ok) => {
        this.initDecodable.set(init.hash, ok === true);
        if (ok === true && !this.stopped) { this.prefetchStreams(); this.streamChanged(); }
      });
    return false;
  }

  /**
   * Currently usable streams (when only pasting sparse versions, requires browser `VideoDecoder`; if
   * missing, treat as no streams), each selecting one candidate: those determined alive take priority;
   * when none determined, take the first non-invalidated one; if all invalidated, use the first as
   * before: same as `chosen` in snapshot layers. Streams with stale input do not count.
   */
  private streamsNow(): ChosenStream[] {
    const map = this.map;
    if (!map || !map.streams.length) return [];
    if (this.sparseOnly && !this.decodeSupport.available()) return [];
    const out: ChosenStream[] = [];
    for (const row of map.streams) {
      if (this.streamStale(row)) continue;
      const pick = row.candidates.find((c) => this.aliveKeys.has(c.resultKey)) ?? row.candidates.find((c) => !this.deadKeys.has(c.resultKey)) ?? row.candidates[0];
      if (pick) out.push({ row, resultKey: pick.resultKey, envFingerprint: pick.envFingerprint });
    }
    return out;
  }

  private streamManifestKey(resultKey: string, seg: [number, number]) { return `${resultKey}:${seg[0]}-${seg[1]}`; }

  /** Which manifest segment n is in (only available if that manifest was fetched) */
  private streamSegment(s: ChosenStream, n: number): { seg: StreamSegMeta; init: StreamInitMeta; state: StreamManifestState } | null {
    const span = streamSpansInWindow(s.row, n, n)[0];
    if (!span) return null;
    const state = this.streamManifests.get(this.streamManifestKey(s.resultKey, span));
    const seg = state?.segments.get(n);
    const init = seg ? state!.inits.get(seg.init) : undefined;
    return state && seg && init ? { seg, init, state } : null;
  }

  /**
   * Ready segment numbers of this stream: listed in manifest, and bytes for both segment and its head
   * file are already on this page.
   */
  private streamReady(s: ChosenStream): number[] {
    const out: number[] = [];
    for (const state of this.streamManifests.values()) {
      if (state.resultKey !== s.resultKey || !state.header) continue;
      for (const [n, seg] of state.segments) {
        if (n < s.row.firstSegment || n > s.row.lastSegment) continue;
        const init = state.inits.get(seg.init);
        if (init && this.streamBlocks.has(seg.hash) && this.streamBlocks.has(init.hash) && this.decodable(init)) out.push(n);
      }
    }
    return out;
  }

  /**
   * Below-dependent streams carry two additional items (same as the layer emitted by desktop
   * prerender process, `belowLayerMark` in `server/frame-stream.mjs`): `streamKind: "below"`:
   * parent page uses this to emit a `plane: "stage"` stream plane (`streamLayers` in
   * `src/editor/snapshotFeed.ts`), and the stage mounts it under stage root and pastes in stage
   * coordinates; `inputSig`: input signature carried by that row in the layer table; parent page
   * compares again against current project in store (removed immediately when project changes,
   * without waiting for this source to receive new project and re-emit readiness).
   */
  private streamMessage(s: ChosenStream): ReadyMessage {
    return { type: "layer", clipId: s.row.topClipId, kind: "stream", key: s.resultKey, ranges: framesToRanges(this.streamReady(s)),
      originFrame: s.row.originFrame, ...(s.row.kind === "group" ? { groupClipIds: [...s.row.clipIds] } : {}),
      ...(s.row.kind === "below" ? { streamKind: "below" as const, ...(s.row.inputSig ? { inputSig: s.row.inputSig } : {}) } : {}) };
  }

  /**
   * Manifest or bytes of stream changed: record a note, re-emit readiness, and ask host to re-emit
   * (stream plane needs to carry newly arrived bytes).
   */
  private streamChanged(): void {
    this.streamRev++;
    this.streamPlaneMemo.clear();
    if (this.stopped) return;
    this.publishLayers();
    try { this.onFetched?.(); } catch { /* The host is broken */ }
  }

  /**
   * Which segments of **this stream** the playhead window falls into: `STREAM_BEHIND_SEGMENTS`
   * segments backward, `PREFETCH_SEC` seconds forward. Returns `[lo, hi, cur]`, where `cur` is the
   * segment number containing the playhead. Segment numbers are specific to each stream (counted from
   * its first frame), so windows are calculated individually per stream; when the playhead has not
   * reached this stream and these forward seconds cannot reach it either, `hi` is negative, and this
   * stream fetches nothing in this round.
   */
  private streamWindow(row: Pick<OnlineStream, "originFrame">): [number, number, number] {
    const fps = this.map?.fps || this.playhead.fps;
    const g = Math.max(0, Math.floor(this.playhead.t * fps + 1e-6));
    const cur = streamSegmentOf(g, row.originFrame);
    return [Math.max(0, cur - STREAM_BEHIND_SEGMENTS), streamSegmentOf(g + Math.ceil(PREFETCH_SEC * fps), row.originFrame), cur];
  }

  /**
   * Fetch manifests for streams in this window (unfetched or not yet full manifests are fetched again
   * every `MANIFEST_POLL_MS`).
   */
  private async loadStreamWindow(now: number): Promise<void> {
    const map = this.map;
    const streams = this.streamsNow();
    if (!map || !streams.length) return;
    const wanted: { resultKey: string; seg: [number, number]; key: string }[] = [];
    for (const s of streams) {
      const [lo, hi] = this.streamWindow(s.row);
      for (const seg of streamSpansInWindow(s.row, lo, hi)) {
        const key = this.streamManifestKey(s.resultKey, seg);
        const st = this.streamManifests.get(key);
        if (st?.full) continue;
        if (st && now - st.fetchedAt < MANIFEST_POLL_MS) continue;
        if (this.manifestFlying.has(`stream|${key}`) || wanted.some((w) => w.key === key)) continue;
        wanted.push({ resultKey: s.resultKey, seg, key });
      }
    }
    if (!wanted.length) return;
    let changed = false;
    await Promise.all(wanted.map(async ({ resultKey, seg, key }) => {
      this.manifestFlying.add(`stream|${key}`);
      try {
        const reply = await this.request({ type: "content.get", kind: "render-manifest", key });
        this.stats.streamManifestFetches++;
        const prev = this.streamManifests.get(key);
        const next = reply?.type === "content.item" && !reply.missing
          ? parseStreamManifest(reply.body, resultKey, seg, this.now())
          : parseStreamManifest(null, resultKey, seg, this.now());
        // Content store returned nothing this time (or returned empty) while we have it in hand: keep what
        // is in hand, and only record the fetch timestamp
        if (!next.segments.size && prev?.segments.size) { prev.fetchedAt = this.now(); return; }
        if (!prev || prev.sig !== next.sig) changed = true;
        this.streamManifests.set(key, next);
      } catch {
        this.stats.errors++;
      } finally {
        this.manifestFlying.delete(`stream|${key}`);
      }
    }));
    if (changed && this.map === map && !this.stopped) this.streamChanged();
  }

  /**
   * Prefetch: segments and head files for each stream in this window, fetching those closer to the
   * playhead first; do not fetch those already on this page, in-flight, or recently failed.
   */
  private prefetchStreams(): void {
    const map = this.map;
    if (!map || !this.deps.assetBase()) return;
    const streams = this.streamsNow();
    if (!streams.length) return;
    const now = this.now();
    const wanted: { hash: string; dist: number }[] = [];
    const want = (hash: string, dist: number) => {
      if (this.streamBlocks.has(hash) || this.streamFlying.has(hash)) return;
      const failed = this.streamFailedAt.get(hash);
      if (failed !== undefined && now - failed < STREAM_RETRY_MS) return;
      wanted.push({ hash, dist });
    };
    for (const s of streams) {
      const [lo, hi, cur] = this.streamWindow(s.row);
      for (let n = Math.max(lo, s.row.firstSegment); n <= Math.min(hi, s.row.lastSegment); n++) {
        const hit = this.streamSegment(s, n);
        if (!hit) continue;
        // When only pasting sparse versions: do not fetch bytes for codecs this browser cannot decode
        // (or has not finished querying)
        if (!this.decodable(hit.init)) continue;
        // The backward segment is ordered after the forward segments
        const dist = n >= cur ? n - cur : hi - cur + (cur - n);
        want(hit.init.hash, dist);
        want(hit.seg.hash, dist);
      }
    }
    wanted.sort((a, b) => a.dist - b.dist);
    const seen = new Set<string>();
    for (const w of wanted) {
      if (seen.has(w.hash)) continue;
      seen.add(w.hash);
      this.fetchStreamBlock(w.hash);
    }
  }

  /**
   * Fetch a chunk of stream bytes (`px/<hash>`, read-only ticket), verify hash and put into page
   * memory; on failure, record timestamp and retry after a short while.
   */
  private fetchStreamBlock(hash: string): void {
    if (this.streamBlocks.has(hash) || this.streamFlying.has(hash)) return;
    const work = new Promise<void>((resolve) => {
      this.queue.push(async () => {
        try {
          const block = await this.fetchAsset("px", hash);
          if (!(await bytesMatchHash(block.bytes, hash))) throw new Error(`Stream bytes do not match the hash: ${hash}`);
          if (this.stopped) return;
          this.stats.streamFetches++;
          this.stats.streamBytes += block.bytes.length;
          this.streamBlocks.set(hash, block.bytes);
          this.streamFailedAt.delete(hash);
          this.streamChanged();
        } catch {
          this.stats.errors++;
          this.stats.streamFailures++;
          this.streamFailedAt.set(hash, this.now());
          if (this.streamFailedAt.size > 4096) this.streamFailedAt.clear();
        } finally {
          resolve();
        }
      });
      this.pump();
    }).finally(() => { this.streamFlying.delete(hash); });
    this.streamFlying.set(hash, work);
  }

  /**
   * Core of `streamPlane`: synthesizes segments from each manifest of this stream whose bytes are
   * already on this page into a manifest recognized by the stage.
   */
  private buildStreamPlane(key: string): { manifest: StreamManifest; blocks: Map<string, Uint8Array> } | null {
    const s = this.streamsNow().find((x) => x.resultKey === key);
    if (!s) return null;
    let header: StreamManifestState["header"] = null;
    let headerAt = -Infinity;
    const inits: StreamManifest["inits"] = {};
    const segments: StreamManifest["segments"] = {};
    const blocks = new Map<string, Uint8Array>();
    for (const state of this.streamManifests.values()) {
      if (state.resultKey !== key || !state.header) continue;
      let used = false;
      for (const [n, seg] of state.segments) {
        if (n < s.row.firstSegment || n > s.row.lastSegment) continue;
        const init = state.inits.get(seg.init);
        if (!init) continue;
        const segBytes = this.streamBlocks.get(seg.hash), initBytes = this.streamBlocks.get(init.hash);
        if (!segBytes || !initBytes || !this.decodable(init)) continue;
        segments[String(n)] = { init: seg.init, file: seg.hash, stride: seg.stride, samples: seg.samples };
        inits[seg.init] = { codec: init.codec, width: init.width, height: init.height, rect: init.rect, hash: init.hash };
        blocks.set(seg.hash, segBytes);
        blocks.set(init.hash, initBytes);
        used = true;
      }
      // Header (rectangle upper bound, tight rectangle) is taken from the most recently fetched manifest
      if (used && state.fetchedAt >= headerAt) { header = state.header; headerAt = state.fetchedAt; }
    }
    if (!header || !blocks.size) return null;
    return {
      manifest: { streamKey: key, kind: s.row.kind, plane: s.row.plane, clipIds: [...s.row.clipIds], fps: header.fps, segmentFrames: SEGMENT_FRAMES,
        originFrame: s.row.originFrame, bound: header.bound, tight: header.tight, inits, segments },
      blocks,
    };
  }

  private request(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ms = this.deps.requestTimeoutMs ?? 12_000;
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      this.deps.request(msg, ms),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Content store request timed out")), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  private async loadMap(): Promise<void> {
    const projectId = this.projectId;
    if (!projectId) return;
    let reply: Record<string, unknown>;
    try {
      reply = await this.request({ type: "content.get", kind: "snapshot-manifest", key: LAYER_MAP_PREFIX + projectId });
    } catch { this.stats.errors++; this.lastMapAt = -Infinity; return; }
    if (this.projectId !== projectId || this.stopped) return;
    this.stats.mapFetches++;
    if (reply?.type !== "content.item" || reply.missing) {
      // Content store explicitly returned "none": render node has not written the layer table yet, and
      // this project has no layer artifacts at all
      if (reply?.type === "content.item") this.mapKnown = true;
      return;
    }
    const map = parseLayerMap(reply.body);
    if (!map) return;
    this.mapKnown = true;
    const sig = `v${map.v}|` + JSON.stringify(map.layers) + `|${map.span}|` + JSON.stringify(map.streams);
    if (sig === this.mapSig) return;
    const prevLayers = this.layers();
    this.map = map;
    this.mapSig = sig;
    const alive = new Set(this.layers().map((l) => `${l.kind}:${l.clipId}`));
    for (const old of prevLayers) {
      const id = `${old.kind}:${old.clipId}`;
      if (alive.has(id)) continue;
      // Card is no longer in layer table (reclassified as light, deleted, tier unrecognized): emit an
      // empty layer to remove stale ranges in the page table
      this.emitted.delete(id);
      this.emit({ type: "layer", clipId: old.clipId, kind: old.kind, key: old.key, ranges: [] });
    }
    this.noteStale();
    this.streamRev++;
    this.streamPlaneMemo.clear();
    // Layers with changed keys (after re-render): ready ranges recomputed by new key and emitted in
    // full; ranges are empty when manifests for new key have not arrived yet, and page displays
    // placeholders in fallback order
    this.publishLayers();
    this.coverageChanged();
  }

  /** Global frame range of playhead window (`PREFETCH_SEC` seconds both before and after) */
  private windowFrames(): [number, number] {
    const fps = this.map?.fps || this.playhead.fps;
    const g = Math.max(0, Math.floor(this.playhead.t * fps + 1e-6));
    const pad = Math.ceil(PREFETCH_SEC * fps);
    return [Math.max(0, g - pad), g + pad];
  }

  private async loadWindow(now: number): Promise<void> {
    const map = this.map;
    if (!map) return;
    const [lo, hi] = this.windowFrames();
    const wanted: { seg: [number, number]; key: string }[] = [];
    for (const layer of this.layers()) {
      for (const seg of segmentsInWindow(layer, map.span, lo, hi)) {
        const key = this.manifestKey(layer, seg);
        const st = this.manifests.get(key);
        if (st?.full) continue;
        if (st && now - st.fetchedAt < MANIFEST_POLL_MS) continue;
        if (this.manifestFlying.has(key) || wanted.some((w) => w.key === key)) continue;
        wanted.push({ seg, key });
      }
    }
    // Full clip coverage (layers designated by `coverageLayer`): segments outside window are also
    // fetched, slower, with a per-round cap
    let extra = 0;
    for (const layer of this.deps.coverageLayer ? this.layers() : []) {
      if (!this.deps.coverageLayer!(layer.clipId)) continue;
      for (let from = 0; from < layer.count && extra < COVERAGE_FETCHES_PER_TICK; from += map.span) {
        const seg = this.segOf(layer, from);
        const key = this.manifestKey(layer, seg);
        const st = this.manifests.get(key);
        if (st?.full) continue;
        if (st && now - st.fetchedAt < COVERAGE_POLL_MS) continue;
        if (this.manifestFlying.has(key) || wanted.some((w) => w.key === key)) continue;
        wanted.push({ seg, key });
        extra++;
      }
    }
    if (!wanted.length) return;
    let changed = false;
    const pick = (list: unknown, seg: [number, number]) => {
      const out = new Map<number, string>();
      for (const item of Array.isArray(list) ? (list as unknown[]) : []) {
        if (!Array.isArray(item) || !Number.isInteger(item[0]) || !/^[0-9a-f]{64}$/.test(String(item[1]))) continue;
        const f = item[0] as number;
        if (f < seg[0] || f > seg[1]) continue;
        out.set(f, String(item[1]));
      }
      return out;
    };
    await Promise.all(wanted.map(async ({ seg, key }) => {
      this.manifestFlying.add(key);
      try {
        const reply = await this.request({ type: "content.get", kind: "snapshot-manifest", key });
        this.stats.manifestFetches++;
        const prev = this.manifests.get(key);
        if (reply?.type !== "content.item" || reply.missing) {
          this.manifests.set(key, { small: prev?.small ?? new Map(), frames: prev?.frames ?? new Map(), full: false, fetchedAt: this.now() });
          return;
        }
        const body = reply.body as { small?: unknown; frames?: unknown } | undefined;
        const small = pick(body?.small, seg);
        const frames = pick(body?.frames, seg);
        const mine = this.tier === "original" ? frames : small;
        const full = mine.size === seg[1] - seg[0] + 1;
        const before = this.tier === "original" ? prev?.frames : prev?.small;
        if (!before || before.size !== mine.size || [...mine].some(([f, h]) => before.get(f) !== h)) changed = true;
        this.manifests.set(key, { small, frames, full, fetchedAt: this.now() });
      } catch {
        this.stats.errors++;
      } finally {
        this.manifestFlying.delete(key);
      }
    }));
    if (changed && this.map === map && !this.stopped) {
      this.publishLayers();
      this.coverageChanged();
    }
  }

  /**
   * Prefetch: visible heavy layers in this window with chunked frames in this tier, fetching those
   * closer to the playhead first; chunks already in L2 will not be requested again.
   */
  private prefetchWindow() {
    const map = this.map;
    if (!map || !this.deps.assetBase()) return;
    const [lo, hi] = this.windowFrames();
    const g = Math.max(0, Math.floor(this.playhead.t * (map.fps || this.playhead.fps) + 1e-6));
    const wanted: { hash: string; dist: number; layer: OnlineLayer; local: number }[] = [];
    for (const layer of this.layers()) {
      const first = Math.max(lo, layer.firstFrame), last = Math.min(hi, layer.firstFrame + layer.count - 1);
      for (let gf = first; gf <= last; gf++) {
        const local = gf - layer.firstFrame;
        if (this.tier === "original") {
          const hit = this.frameOf(layer.kind, layer.key, local);
          if (!hit) continue;
          const id = `snap/${hit.hash}`;
          if (this.store?.hasBlock(id)) {
            // Chunk already in store (fetched by another layer for same content, or on last open): do not
            // request, backfill readiness for this layer
            if (!this.inStore.get(layer.resultKey)?.has(local)) void this.store.putRange(layer.resultKey, local, local).catch(() => {});
            continue;
          }
          if (!this.cache.has(id) && !this.inflight.has(id)) wanted.push({ hash: hit.hash, dist: Math.abs(gf - g), layer, local });
        } else {
          const hash = this.smallHashOf(layer.kind, layer.key, local);
          if (hash && !this.cache.has(hash) && !this.inflight.has(hash)) wanted.push({ hash, dist: Math.abs(gf - g), layer, local });
        }
      }
    }
    wanted.sort((a, b) => a.dist - b.dist);
    const seen = new Set<string>();
    for (const w of wanted) {
      if (seen.has(w.hash)) continue;
      seen.add(w.hash);
      if (this.tier === "original") void this.fetchOriginal(w.hash, w.layer, w.local).catch(() => { /* Fetch in the next round */ });
      else void this.fetchSmall(w.hash).catch(() => { /* Fetch in the next round */ });
    }
  }

  /** Fetch a chunk from asset service (with read-only ticket); both timeout and abort count as failure */
  private async fetchAsset(ns: "px" | "snap", hash: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; type: string }> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const ms = this.deps.assetTimeoutMs ?? 15_000;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        (async () => {
          const base = this.deps.assetBase();
          if (!base) throw new Error("There is no remote asset service yet");
          const headers = await this.deps.authHeaders();
          const f = this.deps.fetch ?? fetch;
          const res = await f(`${base.replace(/\/+$/, "")}/${ns}/${hash}`, { headers, signal: controller.signal, cache: "force-cache" });
          if (!res.ok) throw Object.assign(new Error(`Could not fetch ${ns}/${hash}: ${res.status}`), { status: res.status });
          const bytes = new Uint8Array(await res.arrayBuffer());
          const fallback = ns === "px" ? "image/webp" : "text/html";
          const type = (res.headers.get("content-type") || fallback).split(";")[0].trim() || fallback;
          return { bytes, type };
        })(),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => { controller.abort(); reject(new Error("Asset request timed out")); }, ms); }),
      ]);
    } finally {
      if (deadline !== null) clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
    }
  }

  private fetchSmall(hash: string, signal?: AbortSignal): Promise<string> {
    const flying = this.inflight.get(hash);
    if (flying) return flying;
    const work = new Promise<string>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          let block = this.store ? await this.store.getBlock(`px/${hash}`) : null;
          if (block) this.stats.l2Hits++;
          else {
            block = await this.fetchAsset("px", hash, signal);
            this.stats.smallFetches++;
            this.stats.smallBytes += block.bytes.length;
            // When only pasting sparse versions, L2 only stores small size (C10 contract section 4)
            if (this.store) void this.store.putBlock(`px/${hash}`, block.bytes, block.type).catch(() => {});
          }
          const url = `data:${block.type || "image/webp"};base64,${bytesToBase64(block.bytes)}`;
          this.cache.set(hash, url);
          resolve(url);
          try { this.onFetched?.(); } catch { /* The host is broken */ }
        } catch (e) {
          this.stats.errors++;
          reject(e);
        }
      });
      this.pump();
    }).finally(() => { this.inflight.delete(hash); });
    this.inflight.set(hash, work);
    return work;
  }

  /**
   * Original size (C10 contract section 5 "Flow"): heavy layers in visible range → fetch manifests by
   * layer table → pull missing chunks from asset service with read-only tickets → write to L2 →
   * `ranges` ready → visible stage swaps in on next tick. Chunks in L2 are not requested.
   */
  private fetchOriginal(hash: string, layer: OnlineLayer, localFrame: number, signal?: AbortSignal): Promise<string> {
    const id = `snap/${hash}`;
    const flying = this.inflight.get(id);
    if (flying) return flying;
    const work = new Promise<string>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          let block = this.store ? await this.store.getBlock(id) : null;
          if (block) this.stats.l2Hits++;
          else {
            block = await this.fetchAsset("snap", hash, signal);
            this.stats.snapFetches++;
            this.stats.snapBytes += block.bytes.length;
            if (this.store) await this.store.putBlock(id, block.bytes, block.type || "text/html").catch(() => {});
          }
          const html = textDecoder ? textDecoder.decode(block.bytes) : String.fromCharCode(...block.bytes);
          this.cache.set(id, html);
          // Ready on write: record this frame of this layer into ranges; after L2 notification, this source
          // re-emits readiness (onStoreReady)
          if (this.store && !this.inStore.get(layer.resultKey)?.has(localFrame)) await this.store.putRange(layer.resultKey, localFrame, localFrame).catch(() => {});
          resolve(html);
          try { this.onFetched?.(); } catch { /* The host is broken */ }
        } catch (e) {
          this.stats.errors++;
          reject(e);
        }
      });
      this.pump();
    }).finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, work);
    return work;
  }

  private pump() {
    while (this.active < ONLINE_FETCH_CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void job().finally(() => { this.active--; this.pump(); });
    }
  }
}

/**
 * Online source currently in use (release its small-size cache before export: contract section 11.1);
 * returns null if none.
 */
let activeOnline: OnlineSnapshotSource | null = null;
export function setActiveOnlineSource(src: OnlineSnapshotSource | null): void {
  activeOnline = src;
}
export function activeOnlineSource(): OnlineSnapshotSource | null {
  return activeOnline;
}
