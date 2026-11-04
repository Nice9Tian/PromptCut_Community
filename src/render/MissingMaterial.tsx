import type React from "react";
import type { MediaAsset } from "../kernel/project";

/** Shared visual proxy used by the editor and frame-rendering paths. */
export function MissingMaterial({ name, style }: { name: string; style?: React.CSSProperties }) {
  return <div data-pc-missing-material="1" role="img" aria-label={`Media not found: ${name}`}
    style={{ display: "grid", placeItems: "center", boxSizing: "border-box", width: "100%", height: "100%", padding: 24,
      color: "#fff", background: "#20242b", font: "600 24px/1.4 system-ui, sans-serif", textAlign: "center", ...style }}>
    {`Media not found: ${name}`}
  </div>;
}
