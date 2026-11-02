/**
 * Online browser mode: whether a piece of sound is synthesized in this page or an existing output is used (no
 * distinction by identity or tier, user decision 2026-10-07; the earlier rule of never synthesizing by tier is
 * revoked the same day) (`docs/semantics/product/platforms.md`, "Platform boundary for card sound";
 * how: `mechanism/rendering.md`, "Light and heavy sound").
 *
 *   - This device cannot run its code → do not synthesize. Built-in cards run in the editor page; synced user
 *     cards and media effect cards run only in an isolated sound thread (`cardAudioRoute` in `cardAudio.ts`):
 *     if this page has no such thread, the card fails to load in the thread, it needs to read the asset's
 *     samples, or it is chained together with a built-in card, it counts as unable to run, and the
 *     explanation gives the reason;
 *   - Otherwise: measure the synthesis time once (silently, `src/audio/soundCost.ts`); only if judged light is
 *     it synthesized in the browser, and if judged heavy the existing output is used.
 *
 * The desktop runtime does not use this judgment: the desktop can always synthesize (`decideClipSound` directly
 * returns "synthesize").
 *
 * Records are stored in the `costs` table of the in-page snapshot store L2 (the same table as the picture cost
 * records, with keys and fields that do not collide, see `soundCost.ts`; wired by `onlineSoundBoot.ts`);
 * if L2 cannot be opened, it falls back to page memory. It measures only when the sound is first needed
 * (preview mounts, generation, export), without showing an overlay.
 */
import type { Project, TrackClip } from "../../kernel/project";
import { renderSoundEffectBlock, soundEffectReuseKey, type SoundEffectRecipe } from "../../kernel/soundEffects";
import { cardAudioIdentity } from "../../kernel/cardAudioRendition.mjs";
import { cardJson } from "../../kernel/cardGraph.mjs";
import { cyrb53 } from "../../render/cyrb53.mjs";
import { CARD_AUDIO_SAMPLE_RATE, cardAudioBlockRenderer, cardAudioIdentityHooks, cardAudioNodeOf, onlineCardAudioBlocker, onlineCardAudioSynthesizable } from "../../audio/cardAudio";
import { createMemorySoundCostStore, createSoundJudge, soundCostStoreKey, soundDeviceString, type SoundCostRecord, type SoundCostStore, type SoundJudge, type SoundJudgeTarget, type SoundVerdict } from "../../audio/soundCost";
import { onlinePage } from "../../online/pageFlag";
import { ONLINE_CARD_AUDIO_BLOCKED } from "../../online/soundPolicy";
import { tr } from "../../i18n/index.ts";

export type SoundDecision =
  | { synth: true; verdict?: SoundVerdict }
  | { synth: false; reason: "not-runnable" | "heavy"; message: string; verdict?: SoundVerdict };

export const ONLINE_SOUND_HEAVY = tr("This sound is too slow to synthesize on this device (duplicate check), so an already generated sound is required. Generate it in PromptCut on a computer, then sync");

interface Env {
  online: () => boolean;
  store: () => SoundCostStore | Promise<SoundCostStore>;
  device: () => string;
}

const memory = createMemorySoundCostStore();
const RUN_MODE = typeof import.meta.env !== "undefined" && import.meta.env.DEV === false ? "build" : "dev";
const defaults: Env = {
  online: onlinePage,
  // The L2 cost table is wired in the page by `onlineSoundBoot.ts` (not wired in Node unit tests); when not wired, record only in page memory
  store: () => memory,
  device: () => soundDeviceString({
    ua: typeof navigator === "undefined" ? "" : navigator.userAgent,
    cores: typeof navigator === "undefined" ? 0 : navigator.hardwareConcurrency,
    mode: RUN_MODE,
  }),
};
let env: Env = defaults;
let judge: SoundJudge | null = null;

/** Unit tests and probes swap the environment (storage, device string, tier); omitted items use defaults. Returns a restore function */
export function configureOnlineSoundJudge(next: Partial<Env>): () => void {
  const before = env, beforeJudge = judge;
  env = { ...env, ...next };
  judge = null;
  return () => { env = before; judge = beforeJudge; };
}

function theJudge(): SoundJudge {
  judge ??= createSoundJudge({
    device: () => env.device(),
    store: {
      async getCost(key) { return (await env.store()).getCost(key); },
      async putCost(key, record) { return (await env.store()).putCost(key, record); },
    },
  });
  return judge;
}

/** Target of a standalone sound effect recipe in the judgment */
export function recipeSoundTarget(recipe: SoundEffectRecipe): SoundJudgeTarget {
  return {
    soundKey: `effect:${cyrb53(soundEffectReuseKey(recipe))}`, kind: "effect", frames: recipe.frames, sampleRate: recipe.sampleRate,
    renderBlock: (start, count) => renderSoundEffectBlock(recipe, { start, count }),
  };
}

/** Target of this clip's sound in the judgment (identity, length, how to synthesize a block); returns null for a clip that does not make sound */
export function soundTargetOf(project: Project, clip: TrackClip): SoundJudgeTarget | null {
  if (clip.soundEffect) return recipeSoundTarget(clip.soundEffect.recipe);
  const nodeId = cardAudioNodeOf(project, clip);
  if (!nodeId) return null;
  const frames = Math.max(1, Math.round((clip.end - clip.start) * CARD_AUDIO_SAMPLE_RATE));
  // Identity: a synced card uses the stand-in's default parameters and the sound source code version in the content store (`cardAudioIdentityHooks`), on the same basis as the identity of persisted outputs
  const identity = cardJson(cardAudioIdentity(project, clip, cardAudioIdentityHooks()));
  /*
   * How to synthesize a block: built-in cards are evaluated in the editor page; synced user cards and media
   * effect cards go to the isolated sound host (`cardAudioBlockRenderer` in `cardAudio.ts`).
   * Measurement goes through this same path — it only takes the sample block and discards it on the spot,
   * without creating an audio context, so measurement makes no sound for either kind of card.
   */
  let block: ((start: number, count: number) => Promise<Float32Array>) | null = null;
  return {
    soundKey: `card:${cyrb53(`${identity}\n${frames}`)}`, kind: "card", frames, sampleRate: CARD_AUDIO_SAMPLE_RATE,
    renderBlock: (start, count) => (block ??= cardAudioBlockRenderer(project, nodeId))(start, count),
  };
}

/** Whether this device can run this clip's sound code on the online page (ignoring light or heavy). A standalone sound effect has only a recipe and no card code, so it can always run */
export function clipSoundRunnable(project: Project, clip: TrackClip): boolean {
  if (clip.soundEffect) return true;
  const nodeId = cardAudioNodeOf(project, clip);
  return !!nodeId && onlineCardAudioSynthesizable(project, nodeId);
}

/** Reason this clip's sound code cannot run on the online page (a hint for the panel and preview); when no specific reason can be given, returns the generic one */
export function clipSoundBlockedMessage(project: Project, clip: TrackClip): string {
  const nodeId = cardAudioNodeOf(project, clip);
  return (nodeId && onlineCardAudioBlocker(project, nodeId)) || ONLINE_CARD_AUDIO_BLOCKED;
}

/**
 * Whether this clip's sound should be synthesized on this page right now. The desktop runtime always
 * answers "synthesize"; an online page decides by the three rules in the file header.
 * When the decision needs a measurement, wait here until it finishes (measuring makes no sound).
 */
export async function decideClipSound(project: Project, clip: TrackClip, signal?: AbortSignal): Promise<SoundDecision> {
  if (!env.online()) return { synth: true };
  if (!clipSoundRunnable(project, clip)) return { synth: false, reason: "not-runnable", message: clipSoundBlockedMessage(project, clip) };
  const target = soundTargetOf(project, clip);
  if (!target) return { synth: false, reason: "not-runnable", message: ONLINE_CARD_AUDIO_BLOCKED };
  const verdict = await theJudge().judge(target, signal);
  return verdict.heavy ? { synth: false, reason: "heavy", message: ONLINE_SOUND_HEAVY, verdict } : { synth: true, verdict };
}

/** Whether a standalone sound effect recipe (no clip yet: a new notification sound or keyboard sound) should be synthesized on this page right now */
export async function decideRecipeSound(recipe: SoundEffectRecipe, signal?: AbortSignal): Promise<SoundDecision> {
  if (!env.online()) return { synth: true };
  const verdict = await theJudge().judge(recipeSoundTarget(recipe), signal);
  return verdict.heavy ? { synth: false, reason: "heavy", message: ONLINE_SOUND_HEAVY, verdict } : { synth: true, verdict };
}

/** Interface for handing sounds that are flagged as duplicates but have no output to the render node. The first stage has no receiver (see "What was not done" in the report); when none is connected it returns false, and the caller shows the usual "no output" notice */
type SoundBackfill = (request: { project: Project; clip: TrackClip; reason: "heavy" | "not-runnable" }) => Promise<boolean>;
let backfill: SoundBackfill | null = null;
export function setSoundBackfillHandler(handler: SoundBackfill | null): void { backfill = handler; }
export async function requestSoundBackfill(request: Parameters<SoundBackfill>[0]): Promise<boolean> {
  if (!backfill) return false;
  try { return await backfill(request); } catch { return false; }
}

/** Probe and diagnostics: decision statistics, device string, the record key of a given clip; `seed` writes one record in the real record shape (used to verify "duplicates take the output path") */
export function onlineSoundJudgeDebug() {
  return {
    stats: () => theJudge().stats(),
    device: () => env.device(),
    keyOf: (project: Project, clip: TrackClip) => soundTargetOf(project, clip)?.soundKey ?? null,
    async seed(record: Pick<SoundCostRecord, "soundKey" | "kind" | "blockMs"> & Partial<SoundCostRecord>) {
      const device = env.device();
      const full: SoundCostRecord = { blockMaxMs: record.blockMs, blockFrames: 4096, sampleRate: 48000, samples: 16, measuredAt: Date.now(), ...record, device };
      await (await env.store()).putCost(soundCostStoreKey(record.soundKey, device), full);
      return full;
    },
    async read(soundKey: string) { return (await env.store()).getCost(soundCostStoreKey(soundKey, env.device())); },
  };
}
if (typeof window !== "undefined") (window as unknown as { __pcSoundJudge?: unknown }).__pcSoundJudge = onlineSoundJudgeDebug();
