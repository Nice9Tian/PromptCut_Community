/** Editor binding: sound recipes become ordinary content-addressed WAV assets, never audio graph clips. */
import { actions, getState } from "../../store/project";
import { getCard } from "../../kernel/registry";
import { findClip, newId } from "../../kernel/project";
import { soundEffectReuseKey, validateSoundEffectRecipe, SOUND_EFFECT_LIMITS, NOTIFICATION_SOUND_DEFAULTS, KEYBOARD_SOUND_DEFAULTS } from "../../kernel/soundEffects";
import { createSoundGenerationManager, type SoundGenerationJob, SOUND_JOB_LIMITS } from "../../audio/soundGeneration";
import { renderSoundEffectWavInWorker } from "../../audio/soundGenerationWorkerClient";
import { hasGeneratedAudio, uploadGeneratedAudio } from "./generatedAudioUpload";
import { decideClipSound, decideRecipeSound } from "./onlineSoundJudge";
import { soundEffectReuseDigest } from "../../audio/soundGeneration";
import { isViewOnly } from "./viewOnly";
import { planSoundGeneration, type GenerateSoundOptions } from "../../audio/soundRequest";
import { tr } from "../../i18n/index.ts";

export type { GenerateSoundOptions };

let renderWav: typeof renderSoundEffectWavInWorker = renderSoundEffectWavInWorker;
/** Unit tests swap the synthesis implementation (in a real page it is always the Worker one) */
export function setSoundEffectRenderer(next: typeof renderSoundEffectWavInWorker | null): void { renderWav = next ?? renderSoundEffectWavInWorker; }
// Online page: synthesize in the browser only if judged light (`onlineSoundJudge.ts`; the desktop runtime always synthesizes)
const manager = createSoundGenerationManager({ upload: uploadGeneratedAudio, renderWav: async (recipe, options) => {
  const decision = await decideRecipeSound(recipe, options?.signal);
  if (!decision.synth) throw new Error(decision.message);
  return renderWav(recipe, options);
} });

export function soundPresets() {
  return {
    presets: [
      { id: "notification", name: tr("Short notification sound"), source: "PromptCut native TypeScript synthesis", defaults: NOTIFICATION_SOUND_DEFAULTS, controls: getCard("sound-notification")?.controls ?? [], useWhen: tr("End of a paragraph, confirmation or light cue; no external audio asset needed") },
      { id: "keyboard", name: tr("Synthesized keyboard sound"), source: "PromptCut native TypeScript synthesis", defaults: KEYBOARD_SOUND_DEFAULTS,
        controls: (getCard("sound-keyboard")?.controls ?? []).filter(c => ["tone", "keyDuration", "frequency", "brightness", "variation", "gain", "seed"].includes(c.key)).map(c => c.key === "keyDuration" ? { ...c, key: "duration" } : c),
        typingControls: (getCard("sound-keyboard")?.controls ?? []).filter(c => ["text", "duration", "delayMs", "punctuationPauseMs", "newlinePauseMs", "jitterMs", "punctuationSound", "whitespaceSound"].includes(c.key)),
        useWhen: tr("Syncs with mu-typing character by character; pass sourceClipId to reuse its text and rhythm") },
    ],
    limits: { ...SOUND_EFFECT_LIMITS, ...SOUND_JOB_LIMITS },
    hint: tr("Reuse these presets first. sound_generate only generates plain WAV audio clips and does not attach an audio media effect card. After the text or speed changes, regenerate explicitly with refreshSource:true; use sound_status to check progress and sound_cancel to cancel."),
  };
}

const implicitRequests = new Map<string, string>();

export function startSoundGeneration(options: GenerateSoundOptions): SoundGenerationJob {
  if (isViewOnly()) throw new Error(tr("Read-only pages cannot generate sound effects"));
  const p = getState().project;
  const projectLoadToken = getState().projectLoadToken;
  const { recipe, target, source, sourceClipId, start, duration, mediaOffset, name, expectedClip, expectedSource } = planSoundGeneration(p, options);
  const implicitKey = JSON.stringify([p.id, p.activeCutId, options.clipId, sourceClipId, options.start ?? source?.clip.start, options.trackId, options.name, soundEffectReuseKey(recipe)]);
  let requestId = options.requestId ?? implicitRequests.get(implicitKey);
  if (!requestId) {
    requestId = newId("sound-request"); implicitRequests.set(implicitKey, requestId);
    if (implicitRequests.size > 32) implicitRequests.delete(implicitRequests.keys().next().value!);
  }
  const projectId = p.id;
  const cutId = p.activeCutId;
  const targetKey = `${projectId}:${projectLoadToken}:${cutId ?? ""}:${target?.clip.id ?? requestId}`;
  return manager.start({
    recipe, requestId, targetKey,
    isCurrent() {
      const current = getState().project;
      return getState().projectLoadToken === projectLoadToken && current.id === projectId && current.activeCutId === cutId
        && (!target || JSON.stringify(findClip(current, target.clip.id)?.clip) === expectedClip)
        && (!source || JSON.stringify(findClip(current, source.clip.id)?.clip) === expectedSource);
    },
    isResultCurrent(result) {
      const current = getState().project;
      return !!current.media.find(m => m.id === result.mediaId) && (!result.clipId || findClip(current, result.clipId)?.clip.mediaId === result.mediaId);
    },
    commit(asset, frozenRecipe, reuseKey) {
      return actions.commitSoundEffect({
        projectId, cutId, expectedClip, expectedSource, replaceClipId: target?.clip.id,
        asset: { kind: "audio", name, hash: asset.hash, url: `/@media/${asset.hash}`, ext: "wav", size: asset.bytes,
          duration: frozenRecipe.frames / frozenRecipe.sampleRate, soundEffect: { recipe: frozenRecipe, reuseKey } },
        link: { recipe: frozenRecipe, reuseKey, requestId, ...(sourceClipId ? { sourceClipId } : {}) },
        start, duration, mediaOffset, trackId: options.trackId,
      });
    },
  });
}

export const soundGenerationJobs = manager.list;
export const subscribeSoundGeneration = manager.subscribe;
export const getSoundGenerationJob = manager.get;
export const cancelSoundGeneration = manager.cancel;
export const waitSoundGeneration = manager.wait;

/**
 * Re-synthesize a standalone sound effect (notification sound, keyboard sound) from the recipe stored in
 * its clip and add it to the store (used to fill in missing sounds before export,
 * `docs/semantics/product/rendering.md` "audible motion graphics card"). The recipe does not change, so
 * the synthesized sound is the same one:
 *
 *   - If the project's media record is still there with the same hash → only put the bytes back into the
 *     asset service; the project is untouched;
 *   - If the media record is gone or does not match → after adding to the store, one commit restores the
 *     record and points the clip at it (not pushed onto the undo stack, selection untouched).
 *
 * Nothing is committed if cancelled or if the clip is edited midway; an online page that judged it
 * heavy does not synthesize in the browser (`onlineSoundJudge.ts`).
 */
export async function restoreSoundEffectAsset(clipId: string, options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<{ clipId: string; mediaId: string; committed: boolean }> {
  if (isViewOnly()) throw new Error(tr("Read-only pages cannot generate sound effects"));
  const state = getState(), p = state.project, hit = findClip(p, clipId);
  const link = hit?.clip.soundEffect;
  if (!hit || !link) throw new Error(tr("Cannot find the recipe for this sound effect"));
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const expectedClip = JSON.stringify(hit.clip);
  const check = () => {
    controller.signal.throwIfAborted();
    const now = getState();
    if (now.projectLoadToken !== state.projectLoadToken || now.project.id !== p.id || now.project.activeCutId !== p.activeCutId
        || JSON.stringify(findClip(now.project, clipId)?.clip) !== expectedClip) throw new Error(tr("The clip or project has changed, the old sound generation result will not overwrite the current content"));
  };
  try {
    const decision = await decideClipSound(p, hit.clip, controller.signal);
    if (!decision.synth) throw new Error(decision.message);
    check();
    const recipe = validateSoundEffectRecipe(structuredClone(link.recipe));
    const wav = await renderWav(recipe, { signal: controller.signal, progress: (fraction) => options.onProgress?.(fraction * 0.8) });
    check();
    const asset = await uploadGeneratedAudio(wav, controller.signal);
    check();
    if (!(await hasGeneratedAudio(asset.hash, controller.signal))) throw new Error(tr("The asset service still does not have the sound's bytes after it was stored"));
    check();
    const current = getState().project;
    const media = current.media.find((m) => m.id === hit.clip.mediaId);
    if (media && media.kind === "audio" && media.hash === asset.hash && media.url && !media.pending) {
      options.onProgress?.(1);
      return { clipId, mediaId: media.id, committed: false };
    }
    if (hit.track.locked) throw new Error(tr("Unlock the track containing the sound effect first"));
    const reuseKey = await soundEffectReuseDigest(recipe);
    check();
    const name = hit.clip.label || media?.name || (recipe.preset === "keyboard" ? tr("keyboard-sound.wav") : tr("notification-sound.wav"));
    const result = actions.commitSoundEffect({
      projectId: p.id, cutId: p.activeCutId, expectedClip, replaceClipId: clipId, silent: true,
      expectedSource: link.sourceClipId ? JSON.stringify(findClip(current, link.sourceClipId)?.clip) : undefined,
      asset: { kind: "audio", name, hash: asset.hash, url: `/@media/${asset.hash}`, ext: "wav", size: asset.bytes,
        duration: recipe.frames / recipe.sampleRate, soundEffect: { recipe, reuseKey } },
      link: { ...link, recipe, reuseKey },
    });
    options.onProgress?.(1);
    return { clipId, mediaId: result.mediaId, committed: true };
  } finally { options.signal?.removeEventListener("abort", abort); }
}
