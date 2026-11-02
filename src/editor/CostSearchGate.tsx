import { useEffect, useState } from "react";
import { costSearchState, onCostSearch, type CostSearchState } from "./costSearch";
import "./ProbeGate.css";
import { tr } from "../i18n/index.ts";

/**
 * The loading mask for boundary search when there is only one stage (`costSearch.ts`). It uses the
 * same styles as the desktop `ProbeGate` (theme variables only): it appears only when a real
 * measurement in the stage is needed; it does not appear when fetching records, classifying, or
 * when local reuse hits everything. With only one stage, the picture is switched to the shrunk
 * project during measurement; the mask blocks this stretch of picture and editing operations
 * (semantics `product/rendering.md`, "Measurement": measure under the loading mask when the project opens).
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
      <div className="pc-probe-gate-title">{tr("Measuring which cards this device can play smoothly (card {0}, at most {1})", Math.min(done + 1, total), total)}</div>
      <div className="pc-probe-gate-bar" aria-hidden="true"><i style={{ width: `${(done / total) * 100}%` }} /></div>
      {s.card && <div className="pc-probe-gate-card">{s.card}</div>}
    </div>
  );
}

export default CostSearchGate;
