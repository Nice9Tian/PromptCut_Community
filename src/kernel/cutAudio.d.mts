import type { Project } from "./project";
export interface CutEnvelope {
  start: number;
  end: number;
  fadeIn?: number;
  fadeOut?: number;
  /** For visuals only; audio envelope excludes it (segment opacity is not volume) */
  opacity?: number;
}
/** Markers on expanded clips: original clip id, traversed cut segment ids (outer first) */
export interface CutAudioOrigin {
  clipId: string;
  segments: string[];
  /** Which cut the original clip lives in (the referenced one; card audio checks identity per its original clip in that cut) */
  cutId: string;
}
export function envelopeAt(e: CutEnvelope, t: number, withOpacity?: boolean): number;
export function audioProjectOf<P extends Project>(p: P): P;
