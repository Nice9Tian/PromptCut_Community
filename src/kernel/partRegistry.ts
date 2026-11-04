import type { PartDef } from "./partTypes";

/**
 * Parts registry. Placed in kernel, just like the card registry (kernel/registry.ts):
 * composite card logic in envelope.ts needs to look up part definitions by id; if the registry
 * stayed in src/parts, kernel would have to inversely import upper layers. The registry itself
 * is just a Map and has no knowledge of any part implementation:
 * it is populated by src/parts/index.ts (browser-side glob collecting lib/*.tsx).
 */
const map = new Map<string, PartDef<any>>();

/**
 * Same as card registry: id collision in the same call is a bug; across calls, same id overwrites
 * (HMR reruns index.ts).
 */
export function registerParts(defs: PartDef<any>[]) {
  const seen = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.id)) throw new Error(`Duplicate part id: ${d.id}`);
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
