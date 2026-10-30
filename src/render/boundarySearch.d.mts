export const BOUNDARY_MARGIN: number;
export const BOUNDARY_EXTRA_MAX: number;

export interface SharedCostLike {
  identityKey: string;
  stepMs: number;
}

export interface LocalCostRecord {
  identityKey: string;
  envFingerprint: string;
  stepMs: number;
  samples: number;
  measuredAt: number;
  mode: string;
}

/** 本地复用（与 L2 的方法同名） */
export interface CostStore {
  getCost(key: string): unknown;
  putCost(key: string, rec: LocalCostRecord): unknown;
}

export interface MeasuredCost {
  ms: number;
  cached: boolean;
  failed: boolean;
}

export interface BoundaryResult {
  heavy: Set<string>;
  light: Set<string>;
  unrecorded: string[];
  order: { key: string; rep: number }[];
  boundary: number;
  threshold: number;
  measured: Map<string, MeasuredCost>;
  measurements: number;
  searchMeasurements: number;
  trace: { index: number; key: string; ms: number | null; cached: boolean }[];
  budgetMs: number;
  scale: number;
  envFingerprint: string;
}

export function median(values: readonly number[]): number | undefined;
export function representativeCosts(records: Iterable<SharedCostLike>): Map<string, number>;
export function localCostKey(identityKey: string, envFingerprint: string | null | undefined): string;
export function maxMeasurements(n: number, margin?: number, extraMax?: number): number;
export function boundarySearch(o: {
  keys: Iterable<string>;
  records: Iterable<SharedCostLike>;
  budgetMs: number;
  measure: (key: string) => Promise<{ stepMs: number; samples?: number } | null>;
  store?: CostStore | null;
  envFingerprint?: string;
  scale?: number;
  margin?: number;
  extraMax?: number;
  mode?: string;
  measureUnrecorded?: boolean;
  now?: () => number;
}): Promise<BoundaryResult>;
export function classifyWithBoundary(result: BoundaryResult | null, keys: Iterable<string>, records: Iterable<SharedCostLike>): { heavy: Set<string>; light: Set<string> };
export function createMemoryCostStore(): CostStore & { size(): number };
