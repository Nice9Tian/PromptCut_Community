import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { cardJson } from "../../kernel/cardGraph.mjs";
import type { CardNode } from "../../kernel/cardGraph.mjs";
import { beginFrameWork } from "../../kernel/frameReady";
import { getCard } from "../../kernel/registry";
import type { CardDef, Clip, GraphCardSource, Timeline } from "../../kernel/types";
import { CARD_AUDIO_SAMPLE_RATE } from "../../audio/cardAudio";
import { blockOf, resolveAudioRef, type AudioSourceContext } from "./audioSources";
import { sourceValueAt } from "./graphValues";
import { CardSurface } from "./CardSurface";
import { CardGpuExecutor, type CardGpuError, type CardGpuValue, type PixelsValue, type SourceValue, type ValueResolver } from "./gpuExecutor";
import { CardMediaSource } from "./mediaSource";
import { noteGraphCardError, noteGraphCardOk } from "./cardTrouble";

type Graph = Timeline["graph"];

/** Look only at the node: if this node is in the graph, is a media effect card node, and is not
 * an audio card: this clip's visuals are produced by GraphCard, and the original media layer is no
 * longer drawn (otherwise filter cards would stack into two layers: "original media + filter"). */
export function graphVisualNode(graph: Graph, nodeId?: string) {
  if (!nodeId) return false;
  const node = graph?.nodes.find((node) => node.id === nodeId);
  return !!node && node.adapter === "card" && node.kind !== "audio";
}

/** Maximum upstream recursion depth. Cycles are blocked by hierarchy validation in
 * validateCardGraph; this only guards against depth. */
const MAX_DEPTH = 8;

/**
 * Host component for media effect cards: `card()` runs in the page (without any server round-trips),
 * and the computed `CardGpuValue` is passed to `CardSurface` for execution on WebGL.
 *
 * Resolves inputs locally: asset nodes go through browser's `CardMediaSource`, while upstream media
 * effect card nodes recursively execute into bitmaps on an offscreen canvas. Not a single request
 * is sent along the entire path (media fetched via `/@media` continues as usual).
 */
export function GraphCard({ def, clip, graph, fps, t, params, stage }: {
  def: CardDef<any>;
  clip: Clip;
  graph: Graph;
  fps: number;
  t: number;
  params: Record<string, unknown>;
  stage?: { width: number; height: number; camera3dFov?: number };
}) {
  const [value, setValue] = useState<{ value: CardGpuValue; evaluatedTime: number; evaluatedGraph: Graph; evaluatedNodeId: string } | null>(null);
  const [failure, setFailure] = useState("");
  const ticket = useRef<ReturnType<typeof beginFrameWork> | null>(null);
  const bitmaps = useRef(new Map<string, Promise<ImageBitmap>>());
  const decoder = useRef(new CardMediaSource());
  /** One offscreen canvas + one executor per depth, living with this card to avoid creating
   * a new WebGL context every frame */
  const upstream = useRef(new Map<number, { canvas: OffscreenCanvas; executor: CardGpuExecutor }>());

  const width = stage?.width ?? 1920;
  const height = stage?.height ?? 1080;
  // Media effect card clips dragged from the panel or created by add_clip have no nodeId;
  // in the graph, it is the render node composited in place
  const nodeId = clip.nodeId ?? `@clip/${clip.id}/card`;
  const duration = clip.end - clip.start;

  const nodeAt = useCallback((id: string) => graph?.nodes.find((node) => node.id === id), [graph]);

  /** A node's visual at `time`, decoded into a bitmap. Asset nodes go through the decoder;
   * media effect card nodes execute recursively. */
  const renderNode = useCallback(async (id: string, time: number, depth: number, signal?: AbortSignal): Promise<ImageBitmap> => {
    if (depth > MAX_DEPTH) throw new Error("Media effect card inputs are nested too deeply");
    const node = nodeAt(id);
    if (!node) throw new Error(`Media effect card input node does not exist: ${id}`);
    const media = node.adapter === "media" ? (node.media as { url?: string } | undefined) : undefined;
    // Asset node frame-fetch time = intra-clip time * clip speed (`rate`, only on speed-changed clips,
    // `kernel/cardGraph.mjs`) + trim start. When rate is absent, do not multiply, bit-identical to before
    const rate = Number(node.rate);
    const mediaAt = (Number.isFinite(rate) && rate > 0 && rate !== 1 ? time * rate : time) + (Number(node.offset) || 0);
    const key = media?.url
      ? `media:${media.url}:${mediaAt}`
      : `node:${id}:${time}:${depth}`;
    if (!bitmaps.current.has(key)) {
      const pending = media?.url
        ? decoder.current.frame(media as any, mediaAt, signal)
        : renderUpstream(node, time, depth, signal);
      bitmaps.current.set(key, pending.catch((error) => { bitmaps.current.delete(key); throw error; }));
    }
    const bitmap = await bitmaps.current.get(key)!;
    // Keep a small seek window rather than every full-resolution input frame.
    if (bitmaps.current.size > 12) {
      const oldest = bitmaps.current.keys().next().value!;
      if (oldest !== key) { const prior = bitmaps.current.get(oldest); bitmaps.current.delete(oldest); void prior?.then((b) => b.close(), () => {}); }
    }
    return bitmap;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeAt, width, height]);

  const renderUpstream = useCallback(async (node: CardNode, time: number, depth: number, signal?: AbortSignal): Promise<ImageBitmap> => {
    if (node.adapter !== "card") throw new Error(`Media effect card input node is not a media effect card: ${node.id}`);
    const upstreamDef = getCard(node.cardId as string);
    if (typeof upstreamDef?.card !== "function") throw new Error(`Definition of the upstream media effect card not found: ${node.cardId}`);
    const upstreamParams = { ...upstreamDef.defaults, ...(node.params as Record<string, unknown>) };
    const sourceTime = time + (Number(node.timeOffset) || 0);
    const upstreamValue = await upstreamDef.card(sourcesOf(node, sourceTime, depth), sourceTime, upstreamParams,
      { fps, width, height, duration, stage });
    let slot = upstream.current.get(depth);
    if (!slot) {
      const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
      const executor = new CardGpuExecutor(canvas, (source, requestedTime, innerSignal) =>
        resolveValue(source, requestedTime, depth + 1, innerSignal));
      slot = { canvas, executor };
      upstream.current.set(depth, slot);
    }
    if (slot.canvas.width !== Math.max(1, width) || slot.canvas.height !== Math.max(1, height)) {
      slot.canvas.width = Math.max(1, width); slot.canvas.height = Math.max(1, height);
    }
    await slot.executor.execute(upstreamValue, sourceTime, signal);
    return createImageBitmap(slot.canvas);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fps, width, height, duration, stage]);

  const resolveValue = useCallback(async (source: SourceValue | PixelsValue, requestedTime: number, depth: number, signal?: AbortSignal) => {
    if (source.type !== "source") throw new Error("A media effect card does not produce pixel results that the host needs to download");
    return renderNode(source.nodeId, requestedTime, depth, signal);
  }, [renderNode]);

  /** A node's `sources`: `at()` only gives references, `pixels()` actually yields pixels,
   * and `block()` fetches samples. */
  const sourcesOf = useCallback((node: CardNode, time: number, depth: number): Record<string, GraphCardSource> => {
    const audioContext: AudioSourceContext = { graph, project: { tracks: [], media: [] }, getCard, sampleRate: CARD_AUDIO_SAMPLE_RATE };
    const sources: Record<string, GraphCardSource> = {};
    for (const [name, input] of Object.entries(node.inputs ?? {})) {
      const ref = typeof input === "string" ? { nodeId: input, offset: 0, rate: 1 } : { offset: 0, rate: 1, ...input };
      sources[name] = {
        nodeId: ref.nodeId,
        at: (at?: number) => sourceValueAt(ref, time, at),
        pixels: (at?: number, signal?: AbortSignal) =>
          renderNode(ref.nodeId, (at ?? time) * (ref.rate ?? 1) + (ref.offset ?? 0), depth + 1, signal),
        block: (start: number, count: number) => blockOf(audioContext, resolveAudioRef(audioContext, input), start, count),
      };
    }
    /*
     * When an input clip is deleted, validateCardGraph drops that edge and leaves its name
     * in missingInputs. Attach a getter here that throws on read: it throws only when `card()`
     * accesses it, caught by .catch in evaluate below to become an error state:
     * a broken card should not bring down the entire graph or the whole stage.
     */
    for (const name of (node.missingInputs as string[] | undefined) ?? []) {
      Object.defineProperty(sources, name, { enumerable: true, configurable: true,
        get() { throw new Error("Input clip was deleted: " + name); } });
    }
    return sources;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, renderNode]);

  useLayoutEffect(() => {
    if (!graph) return;
    const controller = new AbortController();
    ticket.current?.dispose();
    const work = beginFrameWork(`Media effect card ${nodeId} @ ${t}`); ticket.current = work;
    setFailure("");
    const evaluate = (async () => {
      const node = nodeAt(nodeId);
      if (!node) throw new Error(`Media effect card node does not exist: ${nodeId}`);
      if (typeof def.card !== "function") throw new Error(`${def.id} is not a visual media effect card`);
      const sourceTime = t + (Number(node.timeOffset) || 0);
      return def.card(sourcesOf(node, sourceTime, 0), sourceTime, params, { fps, width, height, duration, stage });
    })();
    void evaluate
      .then((result) => { if (!controller.signal.aborted) setValue({ value: result, evaluatedTime: t, evaluatedGraph: graph, evaluatedNodeId: nodeId }); })
      // Trouble is only recorded once (`cardTrouble.ts`): the online stage uses this to revert
      // this media effect card to the original approach; documents without subscribers (desktop, export)
      // do not change behavior
      .catch((error) => { if (!controller.signal.aborted) { noteGraphCardError(def.id, error); work.fail(error); setFailure(error instanceof Error ? error.message : String(error)); } });
    return () => { controller.abort(); work.dispose(); };
    // `params` is a new object on every render; putting it directly in dependencies causes
    // effect → setValue → rerender → self-reinforcing infinite loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, clip.nodeId, graph, t, cardJson(params)]);

  const resolveSource: ValueResolver = useCallback((source, requestedTime, signal) =>
    resolveValue(source, requestedTime, 1, signal), [resolveValue]);

  useLayoutEffect(() => {
    decoder.current = new CardMediaSource();
    const cache = bitmaps.current, executors = upstream.current;
    return () => {
      decoder.current.dispose();
      for (const bitmap of cache.values()) void bitmap.then((b) => b.close(), () => {});
      cache.clear();
      for (const slot of executors.values()) slot.executor.dispose();
      executors.clear();
    };
  }, [graph]);

  // This frame rendered / error uploading to GPU or resolving inputs: record each entry
  // (`cardTrouble.ts`; the online stage uses this to revert media effect cards that cannot decode
  // inputs or repeatedly error to the original approach)
  const ready = useCallback(() => { noteGraphCardOk(def.id); ticket.current?.ready(); }, [def.id]);
  const failed = useCallback((error: CardGpuError) => { noteGraphCardError(def.id, error); ticket.current?.fail(error); setFailure(error.message); }, [def.id]);

  if (!graph) return null;
  return <div data-pc-graph-node={nodeId} data-pc-card-error={failure || undefined} style={{ width: "100%", height: "100%" }}>
    {value && <CardSurface value={value.value} width={width} height={height}
      time={t + (Number(nodeAt(nodeId)?.timeOffset) || 0)} enabled={value.evaluatedTime === t && value.evaluatedGraph === graph && value.evaluatedNodeId === nodeId}
      resolveSource={resolveSource} onReady={ready} onError={failed} />}
    {failure && <span role="status">{failure}</span>}
  </div>;
}
