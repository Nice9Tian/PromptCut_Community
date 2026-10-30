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

export type { GenerateSoundOptions };

let renderWav: typeof renderSoundEffectWavInWorker = renderSoundEffectWavInWorker;
/** 单测换合成实现(真实页面里恒是 Worker 那一份) */
export function setSoundEffectRenderer(next: typeof renderSoundEffectWavInWorker | null): void { renderWav = next ?? renderSoundEffectWavInWorker; }
// 在线页面:判轻才在浏览器里合成(`onlineSoundJudge.ts`;桌面运行环境恒合成)
const manager = createSoundGenerationManager({ upload: uploadGeneratedAudio, renderWav: async (recipe, options) => {
  const decision = await decideRecipeSound(recipe, options?.signal);
  if (!decision.synth) throw new Error(decision.message);
  return renderWav(recipe, options);
} });

export function soundPresets() {
  return {
    presets: [
      { id: "notification", name: "短提示音", source: "PromptCut 原生 TypeScript 合成", defaults: NOTIFICATION_SOUND_DEFAULTS, controls: getCard("sound-notification")?.controls ?? [], useWhen: "段落结尾、确认或轻提示;无需外部音频素材" },
      { id: "keyboard", name: "合成键盘声", source: "PromptCut 原生 TypeScript 合成", defaults: KEYBOARD_SOUND_DEFAULTS,
        controls: (getCard("sound-keyboard")?.controls ?? []).filter(c => ["tone", "keyDuration", "frequency", "brightness", "variation", "gain", "seed"].includes(c.key)).map(c => c.key === "keyDuration" ? { ...c, key: "duration" } : c),
        typingControls: (getCard("sound-keyboard")?.controls ?? []).filter(c => ["text", "duration", "delayMs", "punctuationPauseMs", "newlinePauseMs", "jitterMs", "punctuationSound", "whitespaceSound"].includes(c.key)),
        useWhen: "mu-typing 逐字同步;传 sourceClipId 复用其文字与节奏" },
    ],
    limits: { ...SOUND_EFFECT_LIMITS, ...SOUND_JOB_LIMITS },
    hint: "先复用这些预设。sound_generate 只生成 WAV 普通音频段,不另挂音频素材效果卡。文字或速度改变后 refreshSource:true 显式重生成;用 sound_status 查进度,sound_cancel 取消。",
  };
}

const implicitRequests = new Map<string, string>();

export function startSoundGeneration(options: GenerateSoundOptions): SoundGenerationJob {
  if (isViewOnly()) throw new Error("只读页面不能生成音效");
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
 * 把一段独立音效(提示音、键盘声)的声音按它片段里存着的配方重新合成、入库(导出前补齐缺失的声音用,
 * `docs/semantics/product/rendering.md`「有声动效卡」)。配方不变,所以合成出来的是同一份声音:
 *
 *   - 项目里的素材记录还在、哈希相同 → 只是把字节补回素材服务,项目不动;
 *   - 素材记录没了或对不上 → 入库后一次提交把记录补回来、片段指过去(不进撤销栈、不改选区)。
 *
 * 取消、片段中途被改都不提交;在线页面判重的不在浏览器里合成(`onlineSoundJudge.ts`)。
 */
export async function restoreSoundEffectAsset(clipId: string, options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<{ clipId: string; mediaId: string; committed: boolean }> {
  if (isViewOnly()) throw new Error("只读页面不能生成音效");
  const state = getState(), p = state.project, hit = findClip(p, clipId);
  const link = hit?.clip.soundEffect;
  if (!hit || !link) throw new Error("找不到这段音效的配方");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const expectedClip = JSON.stringify(hit.clip);
  const check = () => {
    controller.signal.throwIfAborted();
    const now = getState();
    if (now.projectLoadToken !== state.projectLoadToken || now.project.id !== p.id || now.project.activeCutId !== p.activeCutId
        || JSON.stringify(findClip(now.project, clipId)?.clip) !== expectedClip) throw new Error("片段或项目已变化，旧的声音生成结果不会覆盖当前内容");
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
    if (!(await hasGeneratedAudio(asset.hash, controller.signal))) throw new Error("声音入库后素材服务仍然没有它的字节");
    check();
    const current = getState().project;
    const media = current.media.find((m) => m.id === hit.clip.mediaId);
    if (media && media.kind === "audio" && media.hash === asset.hash && media.url && !media.pending) {
      options.onProgress?.(1);
      return { clipId, mediaId: media.id, committed: false };
    }
    if (hit.track.locked) throw new Error("请先解锁音效所在序列");
    const reuseKey = await soundEffectReuseDigest(recipe);
    check();
    const name = hit.clip.label || media?.name || (recipe.preset === "keyboard" ? "键盘声.wav" : "提示音.wav");
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
