import type { PartDef } from "../kernel/partTypes";
import { registerParts, resetParts } from "../kernel/partRegistry";

/**
 * 部件库:src/parts/lib/ 下一个文件一个部件,glob 自动收集,**不用改这个文件**。
 * 从卡片拆出来的部件放这里(文件头写 from: 哪张卡),新写的也放这里。
 * 一个写坏的部件不该让整个编辑器起不来:不像 PartDef 的导出只警告、跳过。
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

// 这个模块会被 HMR 重新执行(新建或修改 lib/ 下的部件就会触发),每次从空开始重装
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
