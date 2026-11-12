export const CANDIDATE_PHASES: readonly number[];
export const CANONICAL_PHASE: number;
export const DEFAULT_WINDOW_SEC: number;
export const MIN_WINDOW_SEC: number;
export const MAX_WINDOW_SEC: number;

export interface SampleWindowMeta {
  settleMs?: number | null;
  durationSec?: number | null;
  catalogSeconds?: number | null;
  kind?: "card" | "part" | "lottie" | "particles" | "graph";
}

export interface SampleWindow {
  windowSec: number;
  settleSec?: number;
}

export interface CandidatePoint {
  t: number;
  phase: number;
}

export interface FrameSample {
  t: number;
  phase?: number;
  opacityMass: number;
  coverage: number;
  spread?: number;
  detail?: number;
  contrast?: number;
  blurPx?: number;
}

export interface RepresentativeSelection {
  index: number;
  t: number;
  phase: number;
  score: number;
  scores: number[];
}

export function resolveSampleWindow(meta?: SampleWindowMeta): SampleWindow;

export function candidateTimestamps(
  windowSec: number,
  options?: {
    settleSec?: number;
    phases?: readonly number[];
    fps?: number;
  },
): CandidatePoint[];

export function pickRepresentativeFrame(
  samples: readonly FrameSample[],
  options?: {
    canonicalPhase?: number;
  },
): RepresentativeSelection;
