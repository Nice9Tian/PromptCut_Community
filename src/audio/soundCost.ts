/**
 * Light/heavy classification of sound synthesis: measurement, records, criteria
 * (`docs/semantics/mechanism/rendering.md` "Light and heavy sound").
 *
 * It follows the picture's scheme (`mechanism/rendering.md` "Measurement" and "Dispatch"):
 *   - The only number that enters the classification is a robust statistic of "time to synthesize one
 *     chunk": the 90th percentile, at least 16 chunks (`robustStep` in `pipelineTuning.mjs`, the same
 *     function and the same set of tunable coefficients as the picture); the single-run maximum is
 *     recorded separately, for diagnostics only;
 *   - The budget has the same shape as the picture's: for the picture it is `1000 / fps × 70%`
 *     (seventy percent of a frame's duration), for sound it is "chunk duration × 70%";
 *   - The heavy-classification formula is the same: `blockMs × COST_SCALE > budget`;
 *   - If the identity (the recipe or the card sound identity) and the device string are both
 *     unchanged, the last record is reused and no re-measurement is made.
 *
 * **Measurement makes no sound**: measurement only calls the pure synthesis function and throws the
 * computed sample chunks away on the spot: it creates no `AudioContext`, no media element, and no
 * playable address, so there is no path at all leading to the speakers (asserted by the probe
 * `scripts/probes/sound-ab-probe.mjs`).
 *
 * Pure module: it does not read the editor and does not touch the DOM. Storage and the clock are both
 * injected by the caller, and Node unit tests run it directly.
 */
import { resolveTuning, robustStep, type PipelineTuning } from "../render/pipelineTuning.mjs";

/**
 * How many sample frames one chunk has during measurement (about 85.3 ms at 48 kHz; the same as the
 * synthesis chunk of a standalone sound effect, `SOUND_RENDER_BLOCK_FRAMES`)
 */
export const SOUND_COST_BLOCK_FRAMES = 4096;
/**
 * The fraction of a chunk's duration that the budget takes (the same number as the 70% in the
 * picture budget `B = 1000 / fps × 70%`)
 */
export const SOUND_BUDGET_SHARE = 0.7;
/**
 * The wall-clock cap of one measurement (same as `PROBE_MAX_MS` of the picture's timing pass): when
 * reached, compute from the samples collected so far; when samples are insufficient `robustStep`
 * takes the maximum, erring on the conservative side
 */
export const SOUND_MEASURE_MAX_MS = 500;

export type SoundKind = "effect" | "card";

/**
 * One sound cost record. The field is deliberately not named `identityKey`: it sits in the `costs`
 * table of the in-page snapshot store L2 together with the picture's cost records, and the picture
 * side recognizes records by `identityKey` + `device` (`validRecord` in `l2Costs.ts`), filtering out
 * any without `identityKey`, so the two sides do not interfere with each other.
 */
export interface SoundCostRecord {
  soundKey: string;
  kind: SoundKind;
  device: string;
  /**
   * Time to synthesize one chunk (converted to `blockFrames` frames): a robust statistic. The only
   * number that enters the classification
   */
  blockMs: number;
  /** Single-run maximum, for diagnostics only */
  blockMaxMs: number;
  blockFrames: number;
  sampleRate: number;
  /** Number of chunks actually collected */
  samples: number;
  measuredAt: number;
}

export interface SoundCostStore {
  getCost(key: string): unknown | Promise<unknown>;
  putCost(key: string, record: unknown): unknown | Promise<unknown>;
}

export function createMemorySoundCostStore(): SoundCostStore & { size(): number } {
  const map = new Map<string, unknown>();
  return { getCost: (key) => map.get(key) ?? null, putCost: (key, record) => { map.set(key, record); }, size: () => map.size };
}

/**
 * The key in the `costs` table. The prefix `sound` collides with neither the picture records
 * (`<identityKey>\n<device>`) nor the local records of bounds search (`<identityKey>|<fingerprint>`)
 */
export const soundCostStoreKey = (soundKey: string, device: string): string => `sound\n${soundKey}\n${device}`;

/**
 * The device string of a sound record. Synthesis uses only the CPU, so it carries no GPU or render
 * route; it carries the run mode and the measuring method (percentile, minimum number of chunks), so
 * when the method changes old records naturally miss (the same reason as in `costDevice.mjs`).
 */
export function soundDeviceString(parts: { ua?: string; cores?: number; mode?: string; tuning?: Partial<PipelineTuning> | null }): string {
  const tuning = resolveTuning(parts.tuning ?? null);
  return [
    String(parts.ua ?? ""),
    `cores=${Number.isFinite(parts.cores) ? Number(parts.cores) : 0}`,
    `mode=${parts.mode === "build" ? "build" : "dev"}`,
    `stepP=${tuning.STEP_PERCENTILE}`,
    `stepN=${tuning.STEP_MIN_SAMPLES}`,
  ].join(" | ");
}

/** The budget of one chunk (milliseconds): chunk duration × 70% */
export function soundBudgetMs(blockFrames: number, sampleRate: number): number {
  return (blockFrames / sampleRate) * 1000 * SOUND_BUDGET_SHARE;
}

/**
 * Heavy-classification formula: `blockMs × COST_SCALE > budget` (the same shape as the picture's
 * `stepMs × COST_SCALE > B`)
 */
export function soundIsHeavy(record: Pick<SoundCostRecord, "blockMs" | "blockFrames" | "sampleRate">, tuning?: Partial<PipelineTuning> | null): boolean {
  const t = resolveTuning(tuning ?? null);
  if (!Number.isFinite(record.blockMs)) return true;
  return record.blockMs * t.COST_SCALE > soundBudgetMs(record.blockFrames, record.sampleRate);
}

export interface MeasureSoundOptions {
  /** How many sample frames this sound has in total */
  frames: number;
  sampleRate: number;
  /**
   * Synthesizes the chunk `[start, start + count)`. The return value (samples) is thrown away on the
   * spot, neither played nor saved.
   * It may be asynchronous (a card's `audio()` is allowed to return a Promise).
   */
  renderBlock(start: number, count: number): unknown | Promise<unknown>;
  tuning?: Partial<PipelineTuning> | null;
  now?: () => number;
  /**
   * Yield the main thread between chunks (default `setTimeout(0)`); the yielded time does not count
   * toward the elapsed time
   */
  yield?: () => Promise<void>;
  signal?: AbortSignal;
  maxMs?: number;
}

/**
 * Measures the synthesis time of a piece of sound. It synthesizes chunk by chunk from the start,
 * wraps back to the beginning at the end, until `STEP_MIN_SAMPLES` chunks are collected or the wall
 * clock reaches `SOUND_MEASURE_MAX_MS`.
 * A sound shorter than one chunk is synthesized at its actual frame count, and the time is scaled
 * proportionally to a full chunk.
 */
export async function measureSoundBlocks(o: MeasureSoundOptions): Promise<Pick<SoundCostRecord, "blockMs" | "blockMaxMs" | "blockFrames" | "sampleRate" | "samples">> {
  if (!Number.isSafeInteger(o.frames) || o.frames < 1) throw new Error("Invalid range for audio measurement");
  const tuning = resolveTuning(o.tuning ?? null);
  const now = o.now ?? (() => performance.now());
  const pause = o.yield ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const maxMs = o.maxMs ?? SOUND_MEASURE_MAX_MS;
  const samples: number[] = [];
  let spent = 0, start = 0;
  while (samples.length < tuning.STEP_MIN_SAMPLES && spent < maxMs) {
    if (o.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const count = Math.min(SOUND_COST_BLOCK_FRAMES, o.frames - start);
    const t0 = now();
    await o.renderBlock(start, count);
    const ms = Math.max(0, now() - t0);
    spent += ms;
    samples.push(ms * (SOUND_COST_BLOCK_FRAMES / count));
    start += count;
    if (start >= o.frames) start = 0;
    await pause();
  }
  if (o.signal?.aborted) throw new DOMException("aborted", "AbortError");
  return { blockMs: robustStep(samples, tuning), blockMaxMs: Math.max(...samples), blockFrames: SOUND_COST_BLOCK_FRAMES, sampleRate: o.sampleRate, samples: samples.length };
}

const validRecord = (r: unknown): r is SoundCostRecord =>
  !!r && typeof r === "object" && typeof (r as SoundCostRecord).soundKey === "string" && typeof (r as SoundCostRecord).device === "string"
  && Number.isFinite((r as SoundCostRecord).blockMs) && Number.isFinite((r as SoundCostRecord).blockFrames) && Number.isFinite((r as SoundCostRecord).sampleRate);

export interface SoundVerdict { heavy: boolean; record: SoundCostRecord; reused: boolean }

export interface SoundJudgeDeps {
  store: SoundCostStore;
  device: () => string;
  tuning?: () => Partial<PipelineTuning> | null;
  now?: () => number;
  wallClock?: () => number;
  yield?: () => Promise<void>;
}

export interface SoundJudgeTarget {
  soundKey: string;
  kind: SoundKind;
  frames: number;
  sampleRate: number;
  renderBlock(start: number, count: number): unknown | Promise<unknown>;
}

export interface SoundJudge {
  /**
   * Classify a piece of sound as light or heavy: reuse the record if there is one, otherwise measure
   * (silently) and record it
   */
  judge(target: SoundJudgeTarget, signal?: AbortSignal): Promise<SoundVerdict>;
  /**
   * Diagnostics and probes: how many times measured, how many times reused, and whether a measurement
   * is in progress right now
   */
  stats(): { measured: number; reused: number; measuring: number };
}

/**
 * When the same piece of sound is asked about simultaneously (preview attached, export, generation),
 * it is measured only once.
 */
export function createSoundJudge(deps: SoundJudgeDeps): SoundJudge {
  const inflight = new Map<string, Promise<SoundVerdict>>();
  const stats = { measured: 0, reused: 0, measuring: 0 };
  return {
    judge(target, signal) {
      const device = deps.device(), key = soundCostStoreKey(target.soundKey, device), tuning = deps.tuning?.() ?? null;
      const running = inflight.get(key);
      if (running) return running;
      const task = (async (): Promise<SoundVerdict> => {
        let saved: unknown = null;
        try { saved = await deps.store.getCost(key); } catch { saved = null; }
        if (validRecord(saved) && saved.soundKey === target.soundKey && saved.device === device) {
          stats.reused++;
          return { heavy: soundIsHeavy(saved, tuning), record: saved, reused: true };
        }
        stats.measuring++;
        try {
          const measured = await measureSoundBlocks({ frames: target.frames, sampleRate: target.sampleRate, renderBlock: target.renderBlock, tuning, now: deps.now, yield: deps.yield, signal });
          const record: SoundCostRecord = { soundKey: target.soundKey, kind: target.kind, device, ...measured, measuredAt: (deps.wallClock ?? Date.now)() };
          try { await deps.store.putCost(key, record); } catch { /* If it cannot be stored, measure again next time */ }
          stats.measured++;
          return { heavy: soundIsHeavy(record, tuning), record, reused: false };
        } finally { stats.measuring--; }
      })();
      inflight.set(key, task);
      const clear = () => { if (inflight.get(key) === task) inflight.delete(key); };
      task.then(clear, clear);
      return task;
    },
    stats: () => ({ ...stats }),
  };
}
