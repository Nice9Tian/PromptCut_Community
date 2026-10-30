/**
 * 把一次 sound_generate 的参数变成「合成什么、放到哪」的计划。纯函数:只读传进来的项目,不碰 store、不碰页面。
 * 桌面版(`src/editor/io/soundGeneration.ts`)与云端 Agent(`server/agent/service/hosted-sound.mjs`,经 `ssr-host.mjs`)
 * 用的是同一份,所以同一组参数在两边得到同一份配方,合成出的 WAV 逐样本相同。
 */
import { findClip, type Project, type TrackClip, type Track } from "../kernel/project";
import { createNotificationRecipe, createTypingSoundRecipe, validateSoundEffectRecipe, type SoundEffectRecipe, type TypingScheduleOptions } from "../kernel/soundEffects";
import { typingScheduleOptionsFromParams } from "../kernel/typingEvents";

export interface GenerateSoundOptions {
  preset?: "notification" | "keyboard";
  recipe?: SoundEffectRecipe;
  params?: Record<string, unknown>;
  typing?: TypingScheduleOptions;
  sourceClipId?: string;
  clipId?: string;
  start?: number;
  trackId?: string;
  seed?: number;
  name?: string;
  requestId?: string;
  /** Regeneration can explicitly rebuild the schedule from the current typing card. */
  refreshSource?: boolean;
}

export interface SoundGenerationPlan {
  recipe: SoundEffectRecipe;
  /** 要重生成的音效片段(给了 clipId 时) */
  target: { clip: TrackClip; track: Track } | null;
  /** 提供文字与节奏的打字机卡片片段 */
  source: { clip: TrackClip; track: Track } | null;
  sourceClipId?: string;
  /** 新片段的起点;重生成或只进素材库时是 undefined */
  start?: number;
  duration: number;
  mediaOffset: number;
  /** 素材名(带 .wav) */
  name: string;
  /** 计划时目标片段、来源片段的整段取值:提交前再比一次,变了就不应用 */
  expectedClip?: string;
  expectedSource?: string;
}

export function planSoundGeneration(p: Project, options: GenerateSoundOptions): SoundGenerationPlan {
  const target = options.clipId ? findClip(p, options.clipId) : null;
  if (options.clipId && !target?.clip.soundEffect) throw new Error("找不到可重生成的音效片段");
  if (target?.track.locked) throw new Error("请先解锁音效序列");
  const requestedSourceId = options.sourceClipId ?? target?.clip.soundEffect?.sourceClipId;
  const candidate = requestedSourceId ? findClip(p, requestedSourceId) : null;
  const source = candidate?.clip.cardId === "mu-typing" ? candidate : null;
  if ((options.sourceClipId || options.refreshSource) && !source) throw new Error("sourceClipId 必须指向当前剪辑中的打字机卡片");
  // Removing the visual card does not erase the persisted sound recipe; ordinary regeneration detaches the orphan link.
  const sourceClipId = source?.clip.id;
  const previous = target?.clip.soundEffect?.recipe;
  const preset = options.preset ?? options.recipe?.preset ?? previous?.preset ?? "notification";
  let recipe: SoundEffectRecipe;
  if (options.recipe) recipe = validateSoundEffectRecipe(options.recipe);
  else if (previous && !options.refreshSource) {
    const params = { ...previous.params, ...options.params };
    const naturalFrames = (r: SoundEffectRecipe, duration = r.params.duration) => Math.max(1,
      r.events.length ? r.events.at(-1)!.frame + Math.ceil(duration * r.sampleRate) : 0,
      r.preset === "keyboard" ? Math.ceil((r.typingSource?.settleMs ?? 0) * r.sampleRate / 1000) : 0);
    const hadNaturalRange = previous.frames === naturalFrames(previous);
    if (previous.preset === "notification") {
      const notesChanged = options.params?.notes !== undefined && JSON.stringify(options.params.notes) !== JSON.stringify(previous.params.notes);
      const intervalChanged = options.params?.interval !== undefined && options.params.interval !== previous.params.interval;
      const durationChanged = params.duration !== previous.params.duration;
      // Sound-only edits preserve an explicitly supplied event table and padded/cropped asset range.
      const rebuilt = createNotificationRecipe(params, { seed: options.seed ?? previous.seed, sampleRate: previous.sampleRate, channels: previous.channels });
      const events = notesChanged || intervalChanged ? rebuilt.events : previous.events;
      const candidate = { ...rebuilt, events };
      const frames = hadNaturalRange && (notesChanged || intervalChanged || durationChanged) ? naturalFrames(candidate) : previous.frames;
      recipe = validateSoundEffectRecipe({ ...candidate, frames });
    } else {
      const frames = hadNaturalRange && params.duration !== previous.params.duration ? naturalFrames(previous, Number(params.duration)) : previous.frames;
      recipe = validateSoundEffectRecipe({ ...previous, frames, seed: options.seed ?? previous.seed, params });
    }
  } else if (preset === "keyboard") {
    const typing = source ? typingScheduleOptionsFromParams(source.clip.params) : options.typing ?? (previous?.preset === "keyboard" ? previous.typingSource?.source : undefined);
    if (!typing) throw new Error("键盘声需要 sourceClipId 或 typing.text 与节奏");
    recipe = createTypingSoundRecipe(typing, { ...(previous?.preset === "keyboard" ? previous.params : {}), ...options.params }, { seed: options.seed ?? previous?.seed ?? typing.seed ?? 0 });
  } else recipe = createNotificationRecipe(options.params, { seed: options.seed ?? 0 });
  // A caller-owned object must not change while an async render is in flight.
  recipe = validateSoundEffectRecipe(structuredClone(recipe));
  const expectedClip = target ? JSON.stringify(target.clip) : undefined;
  const expectedSource = source ? JSON.stringify(source.clip) : undefined;
  const start = target ? undefined : options.start ?? source?.clip.start;
  const mediaOffset = source && recipe.preset === "keyboard" ? Math.max(0, source.clip.mediaOffset ?? 0) : 0;
  const available = recipe.frames / recipe.sampleRate - mediaOffset;
  if (!target && start !== undefined && available <= 0) throw new Error("这段打字范围没有剩余声音,请检查素材偏移");
  if (start !== undefined && (!Number.isFinite(start) || start < 0 || start >= p.duration)) throw new Error("start 必须在项目时间范围内");
  const duration = source && recipe.preset === "keyboard" ? Math.min(available, source.clip.end - source.clip.start) : available;
  const name = `${(options.name || (recipe.preset === "keyboard" ? "键盘声" : "提示音")).replace(/\.wav$/i, "").slice(0, 100)}.wav`;
  return { recipe, target, source, sourceClipId, start, duration, mediaOffset, name, expectedClip, expectedSource };
}
