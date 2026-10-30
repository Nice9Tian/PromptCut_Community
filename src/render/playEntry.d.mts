export type PlayRun = { startFrame: number | null; lastFrame: number | null; breaks: number };
export function createPlayRun(): PlayRun;
export function notePlayStart(run: PlayRun, fromSec: number, fps: number): void;
export function notePlayBeat(run: PlayRun, sec: number, fps: number): "continuous" | "repeat" | "break";
export function notePlaySeam(run: PlayRun, sec: number, fps: number): void;
export function enteredNaturally(run: Pick<PlayRun, "startFrame" | "lastFrame">, mountFrame: number): boolean;
