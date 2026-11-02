import type { PartDef } from "../kernel/partTypes";
import { registerParts, resetParts } from "../kernel/partRegistry";

/**
 * Parts library: one part per file under src/parts/lib/, automatically collected by glob, **no need
 * to modify this file**.
 * Parts extracted from cards go here (file header specifies from: which card), and newly written
 * ones go here too.
 * A broken part should not prevent the whole editor from launching: exports not resembling PartDef
 * only warn and skip.
 */
const modules = import.meta.glob<Record<string, unknown>>("./lib/*.tsx", { eager: true });

function isPartDef(value: unknown): value is PartDef<any> {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<PartDef<any>>;
  return (
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.role === "string" &&
    typeof p.defaults === "object" &&
    Array.isArray(p.controls) &&
    typeof p.Component === "function"
  );
}

export const libraryParts: PartDef<any>[] = Object.entries(modules).flatMap(([path, mod]) => {
  const found = Object.values(mod).filter(isPartDef);
  if (found.length === 0) console.warn(`[parts] ${path} 里没有找到 PartDef 具名导出,已跳过`);
  return found;
});

// This module is re-executed by HMR (triggered when creating or modifying parts under lib/), reinstalled from scratch each time
resetParts();
const seen = new Set<string>();
registerParts(
  libraryParts.filter((p) => {
    if (seen.has(p.id)) {
      console.warn(`[parts] 部件 id "${p.id}" 重复,已跳过后一个`);
      return false;
    }
    seen.add(p.id);
    return true;
  }),
);

export { getPart, allParts } from "../kernel/partRegistry";
export type { PartDef, PartProps } from "../kernel/partTypes";
