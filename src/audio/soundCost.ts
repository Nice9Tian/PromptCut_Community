/**
 * 声音合成的轻重判定:测量、记录、判据(`docs/semantics/mechanism/rendering.md`「声音的轻重」)。
 *
 * 沿用画面那一套(`mechanism/rendering.md`「测量」「分派」):
 *   - 只进判定的数是「合成一块的耗时」的稳健统计值:第 90 百分位、至少 16 块(`pipelineTuning.mjs` 的 `robustStep`,
 *     与画面同一个函数、同一组可调系数);单次最大另记,只作诊断;
 *   - 预算与画面同形:画面是 `1000 / fps × 70%`(一帧的时长的七成),声音是「一块的时长 × 70%」;
 *   - 判重式相同:`blockMs × COST_SCALE > 预算`;
 *   - 身份(配方或卡片声音身份)和设备串都没变,就复用上次的记录,不重测。
 *
 * **测量不出声**:测量只调纯合成函数、把算出来的采样块当场丢掉 —— 不建 `AudioContext`、不建媒体元素、不建可播放的地址,
 * 所以没有任何一条通向扬声器的路(探针 `scripts/probes/sound-ab-probe.mjs` 断言)。
 *
 * 纯模块:不读编辑器、不碰 DOM。存取和时钟都由调用方注入,Node 单测直接跑。
 */
import { resolveTuning, robustStep, type PipelineTuning } from "../render/pipelineTuning.mjs";

/** 测量时一块多少采样帧(48 kHz 下约 85.3 ms;与独立音效的合成块 `SOUND_RENDER_BLOCK_FRAMES` 相同) */
export const SOUND_COST_BLOCK_FRAMES = 4096;
/** 预算占一块时长的比例(与画面预算 `B = 1000 / fps × 70%` 的 70% 是同一个数) */
export const SOUND_BUDGET_SHARE = 0.7;
/** 一次测量的墙钟封顶(同画面计时趟的 `PROBE_MAX_MS`):到了就按已有样本算,样本不足时 `robustStep` 取最大值,偏保守 */
export const SOUND_MEASURE_MAX_MS = 500;

export type SoundKind = "effect" | "card";

/**
 * 一条声音成本记录。字段名故意不叫 `identityKey`:它和画面的成本记录同放在页面内快照库 L2 的 `costs` 表里,
 * 画面那一侧按 `identityKey` + `device` 认记录(`l2Costs.ts` 的 `validRecord`),没有 `identityKey` 的会被它滤掉,两边互不干扰。
 */
export interface SoundCostRecord {
  soundKey: string;
  kind: SoundKind;
  device: string;
  /** 合成一块(折算到 `blockFrames` 帧)的耗时:稳健统计值。唯一进判定的数 */
  blockMs: number;
  /** 单次最大,只作诊断 */
  blockMaxMs: number;
  blockFrames: number;
  sampleRate: number;
  /** 真实采到的块数 */
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

/** `costs` 表里的键。前缀 `sound` 与画面记录(`<identityKey>\n<device>`)、界限搜索的本地记录(`<identityKey>|<指纹>`)都不相撞 */
export const soundCostStoreKey = (soundKey: string, device: string): string => `sound\n${soundKey}\n${device}`;

/**
 * 声音记录的设备串。合成只吃 CPU,所以不带 GPU 与渲染路线;带运行模式和量法(百分位、最少块数),
 * 量法变了旧记录自然不命中(同 `costDevice.mjs` 的理由)。
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

/** 一块的预算(毫秒):块时长 × 70% */
export function soundBudgetMs(blockFrames: number, sampleRate: number): number {
  return (blockFrames / sampleRate) * 1000 * SOUND_BUDGET_SHARE;
}

/** 判重式:`blockMs × COST_SCALE > 预算`(与画面的 `stepMs × COST_SCALE > B` 同形) */
export function soundIsHeavy(record: Pick<SoundCostRecord, "blockMs" | "blockFrames" | "sampleRate">, tuning?: Partial<PipelineTuning> | null): boolean {
  const t = resolveTuning(tuning ?? null);
  if (!Number.isFinite(record.blockMs)) return true;
  return record.blockMs * t.COST_SCALE > soundBudgetMs(record.blockFrames, record.sampleRate);
}

export interface MeasureSoundOptions {
  /** 这段声音一共多少采样帧 */
  frames: number;
  sampleRate: number;
  /**
   * 合成 `[start, start + count)` 这一块。返回值(采样)被当场丢掉,不播放、不保存。
   * 可以是异步的(卡片的 `audio()` 允许返回 Promise)。
   */
  renderBlock(start: number, count: number): unknown | Promise<unknown>;
  tuning?: Partial<PipelineTuning> | null;
  now?: () => number;
  /** 块与块之间让出主线程(缺省 `setTimeout(0)`);让出的时间不计入耗时 */
  yield?: () => Promise<void>;
  signal?: AbortSignal;
  maxMs?: number;
}

/**
 * 测一段声音的合成耗时。从头按块合成,到尾就绕回开头,直到采够 `STEP_MIN_SAMPLES` 块或墙钟到 `SOUND_MEASURE_MAX_MS`。
 * 不足一块的声音按它的实际帧数合成,耗时按比例折算到一整块。
 */
export async function measureSoundBlocks(o: MeasureSoundOptions): Promise<Pick<SoundCostRecord, "blockMs" | "blockMaxMs" | "blockFrames" | "sampleRate" | "samples">> {
  if (!Number.isSafeInteger(o.frames) || o.frames < 1) throw new Error("声音测量的范围无效");
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
  /** 判一段声音轻重:有记录就复用,没有就测(不出声)、记下 */
  judge(target: SoundJudgeTarget, signal?: AbortSignal): Promise<SoundVerdict>;
  /** 诊断与探针:测过几次、复用几次、此刻是不是正在测 */
  stats(): { measured: number; reused: number; measuring: number };
}

/**
 * 同一段声音同时被问到(预览挂上、导出、生成)时只测一次。
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
          try { await deps.store.putCost(key, record); } catch { /* 存不下就下次再测 */ }
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
