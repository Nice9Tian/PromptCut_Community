/**
 * 导出前核对、导出中取用**预渲染原尺寸**(`docs/plan/c10a-contract.md` 第 11.1 节「导出前」「逐帧」)。
 *
 * - 哪些片段是重卡:渲染节点写进内容库的层表(`layers:<项目 id>`,`server/artifact-transfer.mjs` 的 `layerMapOf`);
 *   还没有层表时退回页面自己的分派表判重的片段(调用方给 `fallbackHeavy`),它们一律算缺。
 * - 在线浏览器(语义 `product/platforms.md`「在线浏览器」的导出):只有页面判重的卡用预渲染原尺寸,判轻的卡由本机逐帧渲 ——
 *   调用方给 `onlyClips`(页面判重的片段),层表里不在其中的层不算重卡、不核对、不取。
 * - 就绪:每张重卡每一段清单(`<resultKey>:<from>-<to>`)的 `frames` 盖满整段。原尺寸只认 `frames`,
 *   `small`(小尺寸)不算 —— 两档的就绪分开记。
 * - 取用:清单里这一帧的哈希 → 素材服务 `GET snap/<hash>`(凭只读票据)。一次只取当前这一帧,用完不留。
 * - 旧输入的层(stale-layer):给了 `project` 时,层表里带输入签名、又和这一版片段对不上的层(改参数之前的结果)不取,
 *   这张卡算缺 —— 等渲染节点按新输入重写层表、渲完再导。
 */
import { LAYER_MAP_PREFIX, parseLayerMap, type LayerMap, type OnlineLayer } from "../render/snapshotSource";
import { clipInputSig, inputSigStale } from "../render/layerInputSig.mjs";

export interface OriginalsDeps {
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  assetBase(): string | null;
  authHeaders(): Promise<Record<string, string>>;
  fetch?: typeof fetch;
}

export interface OriginalsIndex {
  map: LayerMap | null;
  /** 缺预渲染原尺寸的重卡片段 */
  missing: string[];
  /** 这张卡这一帧(全局帧)的原尺寸哈希;不是重卡回 undefined,是重卡但缺回 null */
  hashAt(clipId: string, globalFrame: number): string | null | undefined;
}

function segmentsOf(layer: OnlineLayer, span: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let from = 0; from < layer.count; from += span) out.push([from, Math.min(layer.count - 1, from + span - 1)]);
  return out;
}

/** 读层表与每一段清单,核对原尺寸是否齐全 */
export async function loadOriginalsIndex(projectId: string | null, deps: OriginalsDeps, { fallbackHeavy = [] as readonly string[], onlyClips = null as readonly string[] | null, project = null as unknown, requiredClips = [] as readonly string[] } = {}): Promise<OriginalsIndex> {
  /*
   * `requiredClips`:导出时**必须**用预渲染原尺寸的片段,不管页面判它轻还是重 —— 同步来的用户卡与素材效果卡
   * (`docs/plan/online-card-exec-contract.md` 第 8 节「在线导出」:导出页与编辑页面同源,不执行它们的代码)。
   * 它们不受 `onlyClips` 限制;层表里没有它们的层、或没有层表,都算缺。
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
  // 必须用原尺寸、层表里却没有层的片段:算缺(等渲染节点渲出来)
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

/** 取一帧原尺寸 HTML 快照(`snap/<hash>`) */
export async function fetchOriginalHtml(hash: string, deps: OriginalsDeps, signal?: AbortSignal): Promise<string> {
  const base = deps.assetBase();
  if (!base) throw new Error("还没有远程素材服务");
  const f = deps.fetch ?? fetch;
  const res = await f(`${base.replace(/\/+$/, "")}/snap/${hash}`, { headers: await deps.authHeaders(), signal });
  if (!res.ok) throw new Error(`取不到预渲染原尺寸 ${hash}:${res.status}`);
  return res.text();
}
