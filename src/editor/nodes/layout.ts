import type { Project, TrackClip } from "../../kernel/project";

export interface GraphNode { id: string; label: string; kind: "media" | "filter" | "audio" | "pixelmap" | "out"; clipId?: string; trackId?: string; width: number; height: number; depth: number; x: number; y: number; active?: boolean; }
export interface GraphEdge { id: string; from: string; to: string; active: boolean; }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number; }

const W = 172, H = 72, GAP_X = 92, GAP_Y = 22;
const node = (id: string, label: string, kind: GraphNode["kind"], depth: number, extra: Partial<GraphNode> = {}): GraphNode => ({ id, label, kind, depth, width: W, height: H, x: 0, y: 0, ...extra });

/** 从当前激活剪辑建立确定性的 DAG；同一个 clip 的媒体→滤镜→像素映射→Out。 */
export function graphOf(project: Project, time = 0): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const visual = project.tracks.flatMap((t) => t.clips.map((c) => ({ t, c }))).filter(({ c }) => c.mediaId || c.cardId);
  for (const { t, c } of visual) {
    const media = c.mediaId ? project.media.find((m) => m.id === c.mediaId) : null;
    const baseId = `clip:${c.id}`;
    nodes.push(node(baseId, media?.name ?? c.cardId ?? "卡片", "media", 0, { clipId: c.id, trackId: t.id, active: time >= c.start && time < c.end }));
    let prev = baseId; let depth = 1;
    if (c.filter) { const f = project.filters?.find((x) => x.id === c.filter!.id); const id = `filter:${c.id}`; nodes.push(node(id, f?.name ?? "滤镜", "filter", depth, { clipId: c.id, active: time >= c.start && time < c.end })); edges.push({ id: `${prev}->${id}`, from: prev, to: id, active: nodes.at(-1)?.active ?? false }); prev = id; depth++; }
    if (c.pixelMap) { const f = project.pixelMaps?.find((x) => x.id === c.pixelMap!.id); const id = `pixelmap:${c.id}`; nodes.push(node(id, f?.name ?? "像素映射", "pixelmap", depth, { clipId: c.id, active: time >= c.start && time < c.end })); edges.push({ id: `${prev}->${id}`, from: prev, to: id, active: nodes.at(-1)?.active ?? false }); prev = id; depth++; }
    if (c.audioFx) { const f = project.audioFx?.find((x) => x.id === c.audioFx!.id); const id = `audio:${c.id}`; nodes.push(node(id, f?.name ?? "音频效果", "audio", depth, { clipId: c.id, active: time >= c.start && time < c.end })); edges.push({ id: `${prev}->${id}`, from: prev, to: id, active: nodes.at(-1)?.active ?? false }); prev = id; depth++; }
    edges.push({ id: `${prev}->out`, from: prev, to: "out", active: time >= c.start && time < c.end });
  }
  nodes.push(node("out", "OUT", "out", Math.max(1, ...nodes.map((n) => n.depth)) + 1, { width: 300, height: 86 }));
  const maxDepth = Math.max(0, ...nodes.map((n) => n.depth));
  const layers = Array.from({ length: maxDepth + 1 }, (_, d) => nodes.filter((n) => n.depth === d));
  for (const [d, layer] of layers.entries()) {
    layer.sort((a, b) => (a.trackId ?? "").localeCompare(b.trackId ?? "") || a.id.localeCompare(b.id));
    const total = layer.length * H + Math.max(0, layer.length - 1) * GAP_Y;
    layer.forEach((n, i) => { n.x = 24 + d * (W + GAP_X); n.y = Math.max(24, 230 - total / 2 + i * (H + GAP_Y)); });
  }
  const maxX = Math.max(...nodes.map((n) => n.x + n.width), 520);
  const maxY = Math.max(...nodes.map((n) => n.y + n.height), 300);
  return { nodes, edges, width: maxX + 32, height: maxY + 32 };
}
