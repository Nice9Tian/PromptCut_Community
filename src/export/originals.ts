/**
 * Pre-export check and export consumption of **prerendered original size**
 * (`docs/plan/c10a-contract.md` Section 11.1 "Before export", "Frame-by-frame").
 *
 * - Which clips are heavy cards: layer table written to content store by render nodes
 *   (`layers:<project id>`, `layerMapOf` in `server/artifact-transfer.mjs`); when layer table is
 *   not yet available, falls back to clips classified as heavy by the page's own dispatch table
 *   (caller provides `fallbackHeavy`), all counted as missing.
 * - Online browser (semantics of `product/platforms.md` "Online browser" export): only cards
 *   classified as heavy by the page use prerendered original size; cards classified as light are
 *   rendered frame-by-frame locally: caller provides `onlyClips` (clips classified as heavy by the
 *   page), layers in the layer table not among them are not counted as heavy cards, not checked,
 *   and not fetched.
 * - Ready: for each heavy card, `frames` in each segment manifest (`<resultKey>:<from>-<to>`) must
 *   cover the entire segment. Original size only recognizes `frames`, not `small` (small size):
 *   readiness of the two tiers is tracked separately.
 * - Retrieval: frame hash in manifest → asset service `GET snap/<hash>` (with read-only ticket).
 *   Fetches only the current frame at a time, discarding after use.
 * - Stale-input layer (stale-layer): when `project` is provided, layers in the layer table carrying
 *   an input signature that mismatches this clip version (results prior to parameter changes) are
 *   omitted, counting this card as missing: wait for render nodes to rewrite layer table with new
 *   inputs and finish rendering before exporting.
 */
import { LAYER_MAP_PREFIX, parseLayerMap, type LayerMap, type OnlineLayer } from "../render/snapshotSource";
import { clipInputSig, inputSigStale } from "../render/layerInputSig.mjs";
import { tr } from "../i18n/index.ts";

export interface OriginalsDeps {
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  assetBase(): string | null;
  authHeaders(): Promise<Record<string, string>>;
  fetch?: typeof fetch;
}

export interface OriginalsIndex {
  map: LayerMap | null;
  /** Heavy card clips missing prerendered original size */
  missing: string[];
  /** Original-size hash for this card at this frame (global frame); returns undefined if not a heavy card, null if heavy card but missing */
  hashAt(clipId: string, globalFrame: number): string | null | undefined;
}

function segmentsOf(layer: OnlineLayer, span: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let from = 0; from < layer.count; from += span) out.push([from, Math.min(layer.count - 1, from + span - 1)]);
  return out;
}

/** Reads the layer table and each segment manifest to verify whether original sizes are complete */
export async function loadOriginalsIndex(projectId: string | null, deps: OriginalsDeps, { fallbackHeavy = [] as readonly string[], onlyClips = null as readonly string[] | null, project = null as unknown, requiredClips = [] as readonly string[] } = {}): Promise<OriginalsIndex> {
  /*
   * `requiredClips`: clips that **must** use prerendered original size during export, regardless of
   * whether the page classifies them as light or heavy: synced user cards and media effect cards
   * (`docs/plan/online-card-exec-contract.md` Section 8 "Online export": export page shares origin
   * with editor page and does not execute their code).
   * They are not restricted by `onlyClips`; if their layer is missing in layer table, or there is no
   * layer table, they are counted as missing.
   */
  const required = new Set(requiredClips);
  const only = onlyClips ? new Set([...onlyClips, ...required]) : null;
  let map: LayerMap | null = null;
  if (projectId) {
    try {
      const r = await deps.request({ type: "content.get", kind: "snapshot-manifest", key: LAYER_MAP_PREFIX + projectId });
      if (r?.type === "content.item" && !r.missing) map = parseLayerMap(r.body);
    } catch { map = null; }
  }
  if (!map) {
    const missing = [...new Set([...fallbackHeavy, ...required])].filter((id) => !only || only.has(id));
    return { map: null, missing, hashAt: (clipId) => (missing.includes(clipId) ? null : undefined) };
  }
  const byClip = new Map<string, { layer: OnlineLayer; frames: Map<number, string> }>();
  const missing: string[] = [];
  for (const layer of map.layers) {
    if (only && !only.has(layer.clipId)) continue;
    if (project && inputSigStale(layer.inputSig, clipInputSig(project, layer.clipId))) {
      missing.push(layer.clipId);
      byClip.set(layer.clipId, { layer, frames: new Map() });
      continue;
    }
    const frames = new Map<number, string>();
    let complete = true;
    for (const seg of segmentsOf(layer, map.span)) {
      let body: { frames?: unknown } | undefined;
      try {
        const r = await deps.request({ type: "content.get", kind: "snapshot-manifest", key: `${layer.resultKey}:${seg[0]}-${seg[1]}` });
        body = r?.type === "content.item" && !r.missing ? (r.body as { frames?: unknown }) : undefined;
      } catch { body = undefined; }
      for (const item of Array.isArray(body?.frames) ? (body!.frames as unknown[]) : []) {
        if (Array.isArray(item) && Number.isInteger(item[0]) && /^[0-9a-f]{64}$/.test(String(item[1]))) frames.set(item[0] as number, String(item[1]));
      }
      for (let f = seg[0]; f <= seg[1] && complete; f++) if (!frames.has(f)) complete = false;
    }
    if (!complete) missing.push(layer.clipId);
    byClip.set(layer.clipId, { layer, frames });
  }
  // Clips that must use original size but have no layer in the layer table: counted as missing (waiting for render nodes to render them)
  const requiredMissing = new Set([...required].filter((id) => !byClip.has(id)));
  for (const id of requiredMissing) if (!missing.includes(id)) missing.push(id);
  return {
    map,
    missing,
    hashAt(clipId, globalFrame) {
      const hit = byClip.get(clipId);
      if (!hit) return requiredMissing.has(clipId) ? null : undefined;
      const local = globalFrame - hit.layer.firstFrame;
      if (local < 0 || local >= hit.layer.count) return undefined;
      return hit.frames.get(local) ?? null;
    },
  };
}

/** Fetches a single frame original-size HTML snapshot (`snap/<hash>`) */
export async function fetchOriginalHtml(hash: string, deps: OriginalsDeps, signal?: AbortSignal): Promise<string> {
  const base = deps.assetBase();
  if (!base) throw new Error(tr("There is no remote asset service yet"));
  const f = deps.fetch ?? fetch;
  const res = await f(`${base.replace(/\/+$/, "")}/snap/${hash}`, { headers: await deps.authHeaders(), signal });
  if (!res.ok) throw new Error(tr("Cannot fetch the prerender original size {0}: {1}", hash, res.status));
  return res.text();
}
