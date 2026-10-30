export declare const K6_WINDOW_MS: number;

export declare function beatAt(fromFrame: number, n: number, fps: number, duration: number): { sec: number; frame: number; ended: boolean };

export declare function scheduleNextBeat(playStart: number, n: number, period: number, workEnd: number): { playStart: number; nextDue: number; late: boolean };

export interface K6Beat {
  at: number;
  over: number;
  byClip: Map<string, number>;
}

export interface K6State {
  beats: K6Beat[];
  pending: ReadonlySet<string>;
}

export declare function createK6State(): K6State;

export declare function noteK6Beat(
  state: K6State,
  beat: { at: number; beatCost: number; byClip: Map<string, number>; fps: number; sec: number; plan: unknown },
): string | null;
