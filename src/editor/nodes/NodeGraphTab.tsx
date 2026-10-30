import { useMemo } from "react";
import { useStore, actions } from "../../store/project";
import { graphOf } from "./layout";
import "./nodeGraph.css";

/** 编辑分区 → 节点:当前播放头处的节点管线(媒体 → 滤镜 / 像素映射 / 音频 → 输出) */
export function NodeGraphTab() {
  const project = useStore((s) => s.project);
  const time = useStore((s) => s.t);
  const graph = useMemo(() => graphOf(project, time), [project, time]);
  return <div className="pc-node-page pc-left-scroll" data-pc="node-graph">
    <div className="pc-node-help">节点管线 · 拖动播放头查看当前连接</div>
    <div className="pc-node-canvas" style={{ minWidth: graph.width, minHeight: graph.height }}>
      <svg className="pc-node-edges" width={graph.width} height={graph.height} aria-hidden="true">
        {graph.edges.map((e) => { const a = graph.nodes.find((n) => n.id === e.from)!; const b = graph.nodes.find((n) => n.id === e.to)!; const x1 = a.x + a.width, y1 = a.y + a.height / 2, x2 = b.x, y2 = b.y + b.height / 2; const bend = (x1 + x2) / 2; return <path key={e.id} className={e.active ? "is-hot" : ""} d={`M${x1},${y1} C${bend},${y1} ${bend},${y2} ${x2},${y2}`} />; })}
      </svg>
      {graph.nodes.map((n) => <div key={n.id} className={`pc-node-card pc-node-${n.kind}${n.active ? " is-active" : ""}`} style={{ left: n.x, top: n.y, width: n.width, height: n.height }}>
        <span className="pc-node-port in" />
        <div className="pc-node-kind">{n.kind === "out" ? "输出" : n.kind === "media" ? "媒体" : n.kind === "filter" ? "滤镜" : n.kind === "pixelmap" ? "像素映射" : "音频"}</div>
        <div className="pc-node-label">{n.label}</div>
        <span className="pc-node-port out" />
      </div>)}
    </div>
    <div className="pc-node-outbar"><span>OUT</span><input aria-label="节点播放头" type="range" min={0} max={project.duration || 1} step={1 / Math.max(1, project.fps)} value={time} onChange={(e) => actions.seek(Number(e.target.value))} /></div>
  </div>;
}
