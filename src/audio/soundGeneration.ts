/** Deterministic synthesis jobs. No editor, audio device, graph or wall-clock-dependent samples. */
import { renderSoundEffectBlock, soundEffectReuseKey, validateSoundEffectRecipe, type SoundEffectRecipe } from "../kernel/soundEffects";

export type SoundGenerationState = "queued" | "rendering" | "uploading" | "succeeded" | "failed" | "cancelled" | "stale";
export interface SoundGenerationResult { mediaId: string; clipId?: string; reused?: boolean; }
export interface SoundGenerationJob {
  id: string;
  requestId: string;
  targetKey: string;
  state: SoundGenerationState;
  progress: number;
  error?: string;
  result?: SoundGenerationResult;
}
export interface SoundUploadedAsset { hash: string; bytes: number; }
export interface SoundGenerationRequest {
  requestId: string;
  targetKey: string;
  recipe: SoundEffectRecipe;
  /** Captures project/cut/target revision; checked again after every await and before commit. */
  isCurrent(): boolean;
  isResultCurrent?(result: SoundGenerationResult): boolean;
  /** Synchronous atomic project update, only after successful asset-service upload. */
  commit(asset: SoundUploadedAsset, recipe: SoundEffectRecipe, reuseKey: string): SoundGenerationResult;
}
export interface SoundGenerationDeps {
  upload(wav: Uint8Array, signal: AbortSignal): Promise<SoundUploadedAsset>;
  yield?: () => Promise<void>;
  render?: typeof renderSoundEffectBlock;
  renderWav?: typeof renderSoundEffectWav;
}
const TERMINAL = new Set<SoundGenerationState>(["succeeded", "failed", "cancelled", "stale"]);
export const soundJobFinished = (job: SoundGenerationJob) => TERMINAL.has(job.state);
export const SOUND_RENDER_BLOCK_FRAMES = 4096;

/** PCM16 WAV, bounded to the validated recipe budget. PCM is allocated one block at a time. */
export async function renderSoundEffectWav(recipeInput: SoundEffectRecipe, opts: {
  signal?: AbortSignal; progress?: (fraction: number) => void; yield?: () => Promise<void>; render?: typeof renderSoundEffectBlock;
} = {}): Promise<Uint8Array> {
  const recipe = validateSoundEffectRecipe(recipeInput);
  const bytes = new Uint8Array(44 + recipe.frames * recipe.channels * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, recipe.channels, true);
  view.setUint32(24, recipe.sampleRate, true); view.setUint32(28, recipe.sampleRate * recipe.channels * 2, true);
  view.setUint16(32, recipe.channels * 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, bytes.length - 44, true);
  const pause = opts.yield ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  for (let start = 0; start < recipe.frames; start += SOUND_RENDER_BLOCK_FRAMES) {
    opts.signal?.throwIfAborted();
    const count = Math.min(SOUND_RENDER_BLOCK_FRAMES, recipe.frames - start);
    const pcm = (opts.render ?? renderSoundEffectBlock)(recipe, { start, count });
    if (pcm.length !== count * recipe.channels) throw new Error("音效合成返回了错误的采样长度");
    for (let i = 0; i < pcm.length; i++) {
      const value = pcm[i];
      if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error("音效采样超出安全范围,请降低音量");
      view.setInt16(44 + (start * recipe.channels + i) * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    opts.progress?.((start + count) / recipe.frames);
    await pause();
  }
  opts.signal?.throwIfAborted();
  return bytes;
}

/** SHA-256 of canonical synthesis inputs, deliberately separate from the WAV content hash. */
export async function soundEffectReuseDigest(recipe: SoundEffectRecipe): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(soundEffectReuseKey(recipe)));
  return `sound-effect-sha256:${[...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("")}`;
}
export const SOUND_JOB_LIMITS = Object.freeze({ simultaneousJobs: 1, pendingJobs: 4, historyJobs: 8, maxRecipeBytes: 96 * 1024 });

/** Shared-document patches must stay entity-sized, never force whole-project replacement. */
export function assertSoundRecipeSize(recipe: SoundEffectRecipe): void {
  if (new TextEncoder().encode(JSON.stringify(recipe)).byteLength > SOUND_JOB_LIMITS.maxRecipeBytes) {
    throw new Error("音效配方超过 96 KiB 的共享项目安全上限,请把打字内容拆成多段生成");
  }
}

/** One render/upload at a time bounds memory. Repeated request IDs join the existing job. */
export function createSoundGenerationManager(deps: SoundGenerationDeps) {
  type Entry = { job: SoundGenerationJob; request?: SoundGenerationRequest; abort: AbortController; done: Promise<SoundGenerationJob>; resolve: (job: SoundGenerationJob) => void; signature: string; requestKey: string; };
  const entries = new Map<string, Entry>();
  const requests = new Map<string, string>();
  const latest = new Map<string, string>();
  const listeners = new Set<() => void>();
  let sequence = 0;
  let running = false;
  let snapshot: readonly SoundGenerationJob[] = [];
  const publish = () => { snapshot = [...entries.values()].map(entry => ({ ...entry.job })); for (const fn of listeners) fn(); };
  const set = (entry: Entry, patch: Partial<SoundGenerationJob>) => { entry.job = { ...entry.job, ...patch }; publish(); };
  const current = (entry: Entry) => !!entry.request && latest.get(entry.job.targetKey) === entry.job.id && entry.request.isCurrent();
  const finish = (entry: Entry) => {
    entry.resolve({ ...entry.job });
    entry.request = undefined; // Release recipe, target snapshots and editor closures after all async work exits.
    const terminal = [...entries.values()].filter(e => soundJobFinished(e.job));
    for (const old of terminal.slice(0, Math.max(0, terminal.length - SOUND_JOB_LIMITS.historyJobs))) {
      entries.delete(old.job.id);
      if (requests.get(old.requestKey) === old.job.id) requests.delete(old.requestKey);
      if (latest.get(old.job.targetKey) === old.job.id) latest.delete(old.job.targetKey);
    }
    publish();
  };
  const run = async () => {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const entry = [...entries.values()].find(item => item.job.state === "queued");
        if (!entry) break;
        const request = entry.request!;
        try {
          if (!current(entry)) { set(entry, { state: "stale", error: "项目或片段已改变,旧生成结果未应用" }); continue; }
          set(entry, { state: "rendering" });
          const wav = await (deps.renderWav ?? renderSoundEffectWav)(request.recipe, {
            signal: entry.abort.signal, yield: deps.yield, render: deps.render,
            progress: fraction => { if (!entry.abort.signal.aborted) set(entry, { progress: fraction * 0.8 }); },
          });
          entry.abort.signal.throwIfAborted();
          if (!current(entry)) { set(entry, { state: "stale", error: "项目或片段已改变,旧生成结果未应用" }); continue; }
          set(entry, { state: "uploading", progress: 0.8 });
          const asset = await deps.upload(wav, entry.abort.signal);
          entry.abort.signal.throwIfAborted();
          if (!/^[a-f0-9]{64}$/.test(asset.hash)) throw new Error("素材服务未返回有效内容哈希");
          const reuseKey = await soundEffectReuseDigest(request.recipe);
          entry.abort.signal.throwIfAborted();
          if (!current(entry)) { set(entry, { state: "stale", error: "项目或片段已改变,旧生成结果未应用" }); continue; }
          const result = request.commit(asset, request.recipe, reuseKey);
          set(entry, { state: "succeeded", progress: 1, result });
        } catch (error) {
          if (!soundJobFinished(entry.job)) set(entry, { state: entry.abort.signal.aborted ? "cancelled" : "failed", error: entry.abort.signal.aborted ? "已取消,原音效保持不变" : String((error as Error)?.message ?? error) });
        } finally { finish(entry); }
      }
    } finally { running = false; }
  };
  return {
    start(request: SoundGenerationRequest): SoundGenerationJob {
      if (!request.requestId || request.requestId.length > 200) throw new Error("requestId 必须是 1 到 200 个字符");
      const recipe = validateSoundEffectRecipe(structuredClone(request.recipe));
      assertSoundRecipeSize(recipe);
      const signature = soundEffectReuseKey(recipe);
      const key = `${request.targetKey}\0${request.requestId}`;
      const old = entries.get(requests.get(key) ?? "");
      if (old && !["failed", "cancelled", "stale"].includes(old.job.state) && (old.job.state !== "succeeded" || !old.job.result || !request.isResultCurrent || request.isResultCurrent(old.job.result))) {
        if (old.signature !== signature) throw new Error("requestId 已用于不同配方,修改后请使用新的 requestId");
        return { ...old.job };
      }
      const pending = [...entries.values()].filter(e => !soundJobFinished(e.job) && e.job.targetKey !== request.targetKey);
      if (pending.length >= SOUND_JOB_LIMITS.pendingJobs) throw new Error(`音效任务队列已满(最多 ${SOUND_JOB_LIMITS.pendingJobs} 个),请等待或取消`);
      const id = `sound-${++sequence}`;
      let resolve!: Entry["resolve"];
      const done = new Promise<SoundGenerationJob>(r => { resolve = r; });
      const entry: Entry = { job: { id, requestId: request.requestId, targetKey: request.targetKey, state: "queued", progress: 0 }, request: { ...request, recipe }, abort: new AbortController(), done, resolve, signature, requestKey: key };
      for (const prior of entries.values()) if (prior.job.targetKey === request.targetKey && !soundJobFinished(prior.job)) {
        const queued = prior.job.state === "queued";
        prior.abort.abort(); set(prior, { state: "stale", error: "已有新的生成请求,旧结果未应用" }); prior.resolve({ ...prior.job });
        if (queued) finish(prior);
      }
      entries.set(id, entry); requests.set(key, id); latest.set(request.targetKey, id); publish();
      void Promise.resolve().then(run);
      return { ...entry.job };
    },
    get(id: string) { const entry = entries.get(id); return entry ? { ...entry.job } : null; },
    list: () => snapshot,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async wait(id: string) { const entry = entries.get(id); if (!entry) throw new Error("找不到音效任务"); return entry.done; },
    cancel(id: string) {
      const entry = entries.get(id);
      if (!entry) throw new Error("找不到音效任务");
      if (!soundJobFinished(entry.job)) {
        const queued = entry.job.state === "queued";
        entry.abort.abort(); set(entry, { state: "cancelled", error: "已取消,原音效保持不变" }); entry.resolve({ ...entry.job });
        if (queued) finish(entry);
      }
      return { ...entry.job };
    },
  };
}
