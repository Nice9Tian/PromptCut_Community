export interface IsolatedCardControl {
  clipId: string;
  start: number;
  end: number;
  count: number;
  sampling: { phase: { numerator: number | string; denominator: number | string }; [k: string]: unknown };
}

export function isolatedCardProject<P extends object>(project: P, control: IsolatedCardControl): P;
