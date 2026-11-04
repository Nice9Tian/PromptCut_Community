/**
 * Online browser mode: when there is no valid sound output, built-in sounds judged light are synthesized
 * in the browser into a playback source for the preview
 * (`docs/semantics/product/platforms.md` "Platform boundaries of card sounds"; for light vs. heavy see `onlineSoundJudge.ts`).
 *
 * What gets synthesized is a temporary WAV inside the page (a blob URL), heard only by this page's preview;
 * it is not stored in the library and does not change the project. The persistent sound output is still
 * produced by "Generate sound" or by the step at the start of export. Once a valid output exists, the
 * preview switches to it, so the two never play at the same time
 * (`product/rendering.md` "Motion graphics cards with sound").
 *
 * The desktop runtime does not go through here (ungenerated sounds in the preview are reported as before).
 */
import type { Project, TrackClip } from "../../kernel/project";
import { acquireCardAudioClipUrl, type CardAudioLease } from "../../audio/cardAudio";
import { renderSoundEffectWavInWorker } from "../../audio/soundGenerationWorkerClient";
import { onlinePage } from "../../online/pageFlag";
import { decideClipSound, requestSoundBackfill } from "./onlineSoundJudge";

/**
 * Online playback source for card sounds (built-in sound cards, built-in audio cards).
 * Returns null = not handled here (desktop runtime, or this device cannot run its code); the caller
 * reports it the original way. A duplicate check throws an error that states the reason.
 */
export async function onlineLiveCardAudio(project: Project, clip: TrackClip, nodeId: string, frames: number): Promise<CardAudioLease | null> {
  if (!onlinePage()) return null;
  const decision = await decideClipSound(project, clip);
  if (decision.synth) return acquireCardAudioClipUrl({ project, nodeId, frames });
  // This device does not synthesize: hand it to the render node (the first stage has no receiver, see `setSoundBackfillHandler` in `onlineSoundJudge.ts`)
  void requestSoundBackfill({ project, clip, reason: decision.reason });
  if (decision.reason === "not-runnable") return null;
  throw new Error(decision.message);
}

interface CachedEffect { promise: Promise<string>; url?: string; refs: number }
const effects = new Map<string, CachedEffect>();

/**
 * Online playback source for standalone sound effects (notification sounds, keyboard sounds): when its WAV
 * cannot be fetched from the asset service, synthesize the same sound in the browser from the recipe stored in the clip.
 * Returns null = not handled here, or this device does not synthesize (the caller keeps things as they are: this segment has no sound).
 */
export async function onlineLiveEffectAudio(project: Project, clip: TrackClip): Promise<CardAudioLease | null> {
  const link = clip.soundEffect;
  if (!onlinePage() || !link) return null;
  const decision = await decideClipSound(project, clip);
  if (!decision.synth) {
    void requestSoundBackfill({ project, clip, reason: decision.reason });
    return null;
  }
  const key = link.reuseKey;
  let cached = effects.get(key);
  if (!cached) {
    const entry: CachedEffect = { refs: 0, promise: renderSoundEffectWavInWorker(link.recipe).then((wav) => URL.createObjectURL(new Blob([wav as BlobPart], { type: "audio/wav" }))) };
    cached = entry;
    effects.set(key, entry);
    entry.promise.then((url) => { entry.url = url; }, () => { if (effects.get(key) === entry) effects.delete(key); });
  }
  const entry = cached;
  const url = await entry.promise;
  entry.refs++;
  let released = false;
  return {
    url,
    release() {
      if (released) return;
      released = true;
      if (--entry.refs === 0 && entry.url) { URL.revokeObjectURL(entry.url); if (effects.get(key) === entry) effects.delete(key); }
    },
  };
}
