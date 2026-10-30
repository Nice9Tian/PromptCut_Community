type PlanControl = { clipId?: string; count?: number; compositing?: string; capabilities?: { compositing?: string } | Record<string, any>; sampling?: { firstFrame?: number } | null };
type PlanClip = { id?: string; start: number; end: number; cardId?: string; nodeId?: string; frame?: any; flat?: unknown };
type PlanTrack = { hidden?: boolean; sourceOnly?: boolean };
export function frame3d(frame: { rotateX?: number; rotateY?: number; translateZ?: number } | null | undefined): boolean;
export function streamEligible(control: PlanControl | null | undefined, clip: PlanClip | null | undefined, track: PlanTrack | null | undefined): boolean;
export function cardNodeOf(project: unknown, nodeId: unknown): Record<string, any> | null;
export function graphCardWithInputs(project: unknown, clip: PlanClip | null | undefined): boolean;
export function soloStreamKind(control: PlanControl | null | undefined, clip: PlanClip | null | undefined, track: PlanTrack | null | undefined, project: unknown): 'source' | 'spatial' | 'flat' | null;
export const BELOW_STREAM_RULES: Readonly<{ sourceDependent: boolean; frame3d: boolean }>;
export function belowStreamEligible(control: PlanControl | null | undefined, clip: PlanClip | null | undefined, track: PlanTrack | null | undefined, rules?: { sourceDependent?: boolean; frame3d?: boolean }): boolean;
export function belowTargets<C extends PlanControl, K extends PlanClip>(
  plan: readonly C[],
  o: { picked: (clipId: string) => boolean; where: ReadonlyMap<string, { clip: K; track: PlanTrack }>; fps: number; total: number; orderOf: ReadonlyMap<string, number>; taken?: ReadonlySet<string> | null },
): { control: C; clip: K; order: number; firstFrame: number; from: number; to: number }[];
export function mountClipOf<K extends PlanClip>(clip: K): K;
