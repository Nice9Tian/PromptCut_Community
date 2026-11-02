/**
 * Computes a sample range in the sound thread (`docs/plan/online-card-exec-contract.md` 3.5).
 * Pure logic: does not touch Worker messages or the network, so the sound thread (`soundWorker.ts`)
 * and unit tests share the same implementation.
 *
 * `audio()` of synced user cards and media effect cards runs only here (in the dedicated background
 * thread spawned by the stage). Evaluation follows the desktop setup: `projectCardGraph` flattens
 * the project into a graph → `evaluateCardAudio` finds nodes and calls defined
 * `audio(sources, range, params)`, recursing into upstream media effect cards.
 *
 * Excluded (current scope, see contract 3.5 and Section 13 Item 4):
 *   - Inputs reading media samples (clip media, media nodes): remote asset service has no route
 *     to fetch sample chunks, and browser decoding is not sample-identical to desktop ffmpeg;
 *     such nodes are rejected before evaluation, and the editor page would not dispatch them
 *     anyway (`onlineCardAudioSynthesizable` in `cardAudio.ts`);
 *   - Nodes whose upstream is a built-in card: the sound thread only contains loaded synced cards,
 *     not built-in card definitions (built-in card modules require DOM as soon as they load).
 */
import type { CardDef } from "../../kernel/types.ts";
import { projectCardGraph } from "../../kernel/cardGraph.mjs";
import { withMediaRates } from "../../kernel/clipTime.mjs";
import { evaluateCardAudio, type AudioSourceContext } from "../../render/cards/audioSources.ts";

export interface SoundRenderRequest {
  /** Project (timeline, asset table, card graph); same `projectKey` is transferred only once */
  project: unknown;
  nodeId: string;
  start: number;
  count: number;
  sampleRate: number;
}

/** Maximum frames computed per batch (same as editor page `CARD_AUDIO_MAX_BLOCK_FRAMES`) */
export const SOUND_MAX_BLOCK_FRAMES = 1_048_576;
export const SOUND_NEEDS_MEDIA = "This card needs to read the media's audio samples, which the online page cannot get";

interface GraphNode { id: string; adapter?: string; cardId?: string; inputs?: Record<string, unknown> }

/** This node and its upstream: computable only if all are defined media effect card nodes; returns reason on failure */
export function soundBlocker(nodes: readonly GraphNode[], nodeId: string, getCard: (id: string) => CardDef<any> | undefined): string | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const visit = (id: string): string | null => {
    if (seen.has(id)) return null;
    seen.add(id);
    const node = byId.get(id);
    if (!node) return `Node ${id} not found`;
    if (node.adapter !== "card") return SOUND_NEEDS_MEDIA;
    const def = typeof node.cardId === "string" ? getCard(node.cardId) : undefined;
    if (typeof def?.audio !== "function") return `The sound thread has no sound code for ${node.cardId ?? id}`;
    for (const ref of Object.values(node.inputs ?? {})) {
      const next = typeof ref === "string" ? ref : (ref as { nodeId?: unknown; clipId?: unknown } | null)?.nodeId;
      if (typeof next !== "string") return SOUND_NEEDS_MEDIA;
      const bad = visit(next);
      if (bad) return bad;
    }
    return null;
  };
  return visit(nodeId);
}

export interface SoundEngine {
  render(req: SoundRenderRequest, signal?: AbortSignal): Promise<Float32Array>;
  /** Card generation changed: discard cached graph (graph contains default parameters and capabilities computed from old definitions) */
  reset(): void;
}

export function createSoundEngine(getCard: (id: string) => CardDef<any> | undefined): SoundEngine {
  /** Graph of the most recent project (same project object computing multiple chunks consecutively) */
  let last: { project: unknown; ctx: AudioSourceContext } | null = null;
  return {
    reset() { last = null; },
    async render(req, signal) {
      if (!req || typeof req.nodeId !== "string" || !Number.isSafeInteger(req.start) || !Number.isSafeInteger(req.count) || req.count < 1 || req.count > SOUND_MAX_BLOCK_FRAMES
        || !Number.isFinite(req.sampleRate) || req.sampleRate < 8000 || req.sampleRate > 192_000) throw new Error("Sound request is out of range");
      if (!last || last.project !== req.project) {
        // Same graph as editor page (audioGraphOf in `audio/cardAudio.ts`): audio-visual cards on
        // speed-changed media clips follow card clock (cardClockOffset in kernel/clipTime.mjs)
        const graph = withMediaRates(req.project, projectCardGraph(req.project, getCard));
        last = { project: req.project, ctx: { graph, project: req.project as AudioSourceContext["project"], getCard, sampleRate: req.sampleRate } };
      }
      const ctx: AudioSourceContext = { ...last.ctx, sampleRate: req.sampleRate, signal };
      const nodes = (Array.isArray(ctx.graph) ? ctx.graph : ctx.graph?.nodes ?? []) as GraphNode[];
      const bad = soundBlocker(nodes, req.nodeId, getCard);
      if (bad) throw new Error(bad);
      return evaluateCardAudio(ctx, req.nodeId, { start: req.start, count: req.count, sampleRate: req.sampleRate });
    },
  };
}
