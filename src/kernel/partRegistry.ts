import type { PartDef } from "./partTypes";

/**
 * 部件注册表。和卡片注册表(kernel/registry.ts)一样放在 kernel:
 * envelope.ts 的组合卡逻辑要按 id 查部件定义,注册表留在 src/parts 里的话
 * kernel 就得反过来 import 上层。表本身只是一个 Map,不认识任何部件实现 ——
 * 往里装东西的是 src/parts/index.ts(浏览器侧 glob 收 lib/*.tsx)。
 */
const map = new Map<string, PartDef<any>>();

/** 和卡片注册表一样:同一次调用里 id 撞车是写错了,跨调用同 id 按覆盖(HMR 会重跑 index.ts) */
export function registerParts(defs: PartDef<any>[]) {
  const seen = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.id)) throw new Error(`part id 重复: ${d.id}`);
    seen.add(d.id);
    map.set(d.id, d);
  }
}

export function resetParts() {
  map.clear();
}

export function getPart(id: string): PartDef<any> | undefined {
  return map.get(id);
}

export function allParts(): PartDef<any>[] {
  return [...map.values()];
}
