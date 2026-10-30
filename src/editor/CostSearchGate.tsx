import { useEffect, useState } from "react";
import { costSearchState, onCostSearch, type CostSearchState } from "./costSearch";
import "./ProbeGate.css";

/**
 * 只有一个舞台时界限搜索的加载遮罩(`costSearch.ts`)。与桌面的 `ProbeGate` 同一套样式(只用主题变量):
 * 只在真要在舞台里测的时候出现 —— 取记录、判定、本地复用全命中都不出现。
 * 只有一个舞台,测量时画面被拨到缩水项目上;遮罩挡住这段画面和编辑操作
 * (语义 `product/rendering.md`「测量」:打开项目时在加载遮罩下测)。
 */
export function CostSearchGate() {
  const [s, setS] = useState<CostSearchState>(costSearchState);
  useEffect(() => onCostSearch(setS), []);
  if (!s.measuring) return null;
  const total = Math.max(1, s.estimate);
  const done = Math.min(s.done, total);
  return (
    <div
      className="pc-probe-gate"
      data-pc="cost-search-gate"
      role="status"
      aria-live="polite"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="pc-probe-gate-ring" aria-hidden="true" />
      <div className="pc-probe-gate-title">正在测量这台设备能流畅播放哪些卡(第 {Math.min(done + 1, total)} 张,至多 {total} 张)</div>
      <div className="pc-probe-gate-bar" aria-hidden="true"><i style={{ width: `${(done / total) * 100}%` }} /></div>
      {s.card && <div className="pc-probe-gate-card">{s.card}</div>}
    </div>
  );
}

export default CostSearchGate;
