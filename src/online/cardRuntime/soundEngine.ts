/**
 * 声音线程里求一段采样(`docs/plan/online-card-exec-contract.md` 3.5)。纯逻辑:不碰 Worker 的消息、不碰网络,
 * 所以声音线程(`soundWorker.ts`)与单测用同一份。
 *
 * 同步来的用户卡与素材效果卡的 `audio()` 只在这里执行(舞台起的专用后台线程里)。求值照桌面那一套:
 * `projectCardGraph` 把项目摊成图 → `evaluateCardAudio` 找节点、调定义的 `audio(sources, range, params)`,上游素材效果卡递归。
 *
 * 不做的(本期范围,见契约 3.5 与第 13 节第 4 条):
 *   - 读素材采样的输入(片段素材、素材节点):远程素材服务没有取采样块的路由,浏览器解码与桌面的 ffmpeg 不逐样本相同;
 *     这类节点求值前就拒掉,编辑页面那一侧本来也不会把它派过来(`cardAudio.ts` 的 `onlineCardAudioSynthesizable`);
 *   - 上游是内置卡的节点:声音线程里只有载入的同步卡,没有内置卡的定义(内置卡的模块一载入就要 DOM)。
 */
import type { CardDef } from "../../kernel/types.ts";
import { projectCardGraph } from "../../kernel/cardGraph.mjs";
import { withMediaRates } from "../../kernel/clipTime.mjs";
import { evaluateCardAudio, type AudioSourceContext } from "../../render/cards/audioSources.ts";

export interface SoundRenderRequest {
  /** 项目(时间轴、素材表、卡片图);同一个 `projectKey` 只传一次 */
  project: unknown;
  nodeId: string;
  start: number;
  count: number;
  sampleRate: number;
}

/** 一次最多求多少帧(同编辑页面 `CARD_AUDIO_MAX_BLOCK_FRAMES`) */
export const SOUND_MAX_BLOCK_FRAMES = 1_048_576;
export const SOUND_NEEDS_MEDIA = "这张卡要读素材的声音采样,在线页面取不到";

interface GraphNode { id: string; adapter?: string; cardId?: string; inputs?: Record<string, unknown> }

/** 这个节点连同上游:全是有定义的素材效果卡节点才求得了;不行回原因 */
export function soundBlocker(nodes: readonly GraphNode[], nodeId: string, getCard: (id: string) => CardDef<any> | undefined): string | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const visit = (id: string): string | null => {
    if (seen.has(id)) return null;
    seen.add(id);
    const node = byId.get(id);
    if (!node) return `找不到节点 ${id}`;
    if (node.adapter !== "card") return SOUND_NEEDS_MEDIA;
    const def = typeof node.cardId === "string" ? getCard(node.cardId) : undefined;
    if (typeof def?.audio !== "function") return `声音线程里没有 ${node.cardId ?? id} 的声音代码`;
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
  /** 卡片换代了:丢掉记着的图(图里有按旧定义算的默认参数与能力) */
  reset(): void;
}

export function createSoundEngine(getCard: (id: string) => CardDef<any> | undefined): SoundEngine {
  /** 最近一个项目的图(同一个项目对象连着求很多块) */
  let last: { project: unknown; ctx: AudioSourceContext } | null = null;
  return {
    reset() { last = null; },
    async render(req, signal) {
      if (!req || typeof req.nodeId !== "string" || !Number.isSafeInteger(req.start) || !Number.isSafeInteger(req.count) || req.count < 1 || req.count > SOUND_MAX_BLOCK_FRAMES
        || !Number.isFinite(req.sampleRate) || req.sampleRate < 8000 || req.sampleRate > 192_000) throw new Error("声音请求的范围不对");
      if (!last || last.project !== req.project) {
        // 与编辑页面同一份图(`audio/cardAudio.ts` 的 audioGraphOf):变速素材段上的声画一体卡按卡片时钟走(kernel/clipTime.mjs 的 cardClockOffset)
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
