/**
 * Turns the parameters of a sound_generate call into a plan of "what to synthesize and where to put
 * it". A pure function: it only reads the project passed in and touches neither the store nor the page.
 * The desktop app (`src/editor/io/soundGeneration.ts`) and the Cloud Agent
 * (`server/agent/service/hosted-sound.mjs`, via `ssr-host.mjs`) use the same copy, so the same
 * parameters get the same recipe on both sides, and the synthesized WAV is identical sample by sample.
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
  /** The sound effect clip to regenerate (when clipId is given) */
  target: { clip: TrackClip; track: Track } | null;
  /** The typewriter card clip that provides text and rhythm */
  source: { clip: TrackClip; track: Track } | null;
  sourceClipId?: string;
  /** The start of the new clip; undefined when regenerating or when only going into the media library */
  start?: number;
  duration: number;
  mediaOffset: number;
  /** Media name (with .wav) */
  name: string;
  /**
   * The full values of the target clip and the source clip at planning time: compared once more
   * before committing, and not applied if they changed
   */
  expectedClip?: string;
  expectedSource?: string;
}

export function planSoundGeneration(p: Project, options: GenerateSoundOptions): SoundGenerationPlan {
  const target = options.clipId ? findClip(p, options.clipId) : null;
  if (options.clipId && !target?.clip.soundEffect) throw new Error("No regenerable sound effect clip found");
  if (target?.track.locked) throw new Error("Unlock the sound effect track first");
  const requestedSourceId = options.sourceClipId ?? target?.clip.soundEffect?.sourceClipId;
  const candidate = requestedSourceId ? findClip(p, requestedSourceId) : null;
  const source = candidate?.clip.cardId === "mu-typing" ? candidate : null;
  if ((options.sourceClipId || options.refreshSource) && !source) throw new Error("sourceClipId must point to a typing card in the current cut");
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
    if (!typing) throw new Error("Keyboard sound requires sourceClipId, or typing.text with a rhythm");
    recipe = createTypingSoundRecipe(typing, { ...(previous?.preset === "keyboard" ? previous.params : {}), ...options.params }, { seed: options.seed ?? previous?.seed ?? typing.seed ?? 0 });
  } else recipe = createNotificationRecipe(options.params, { seed: options.seed ?? 0 });
  // A caller-owned object must not change while an async render is in flight.
  recipe = validateSoundEffectRecipe(structuredClone(recipe));
  const expectedClip = target ? JSON.stringify(target.clip) : undefined;
  const expectedSource = source ? JSON.stringify(source.clip) : undefined;
  const start = target ? undefined : options.start ?? source?.clip.start;
  const mediaOffset = source && recipe.preset === "keyboard" ? Math.max(0, source.clip.mediaOffset ?? 0) : 0;
  const available = recipe.frames / recipe.sampleRate - mediaOffset;
  if (!target && start !== undefined && available <= 0) throw new Error("This typing range has no audio left, please check the media offset");
  if (start !== undefined && (!Number.isFinite(start) || start < 0 || start >= p.duration)) throw new Error("start must be within the project time range");
  const duration = source && recipe.preset === "keyboard" ? Math.min(available, source.clip.end - source.clip.start) : available;
  const name = `${(options.name || (recipe.preset === "keyboard" ? "Keyboard sound" : "Notification sound")).replace(/\.wav$/i, "").slice(0, 100)}.wav`;
  return { recipe, target, source, sourceClipId, start, duration, mediaOffset, name, expectedClip, expectedSource };
}
