/**
 * 在线浏览器模式:没有有效声音产物时,判轻的内置声音在浏览器里合成成预览的播放源
 * (`docs/semantics/product/platforms.md`「卡片声音的平台边界」;轻重见 `onlineSoundJudge.ts`)。
 *
 * 合成出来的是页面里的一份临时 WAV(blob 地址),只给本页预览听,不入库、不改项目;
 * 持久的声音产物仍由「生成声音」或导出开始时那一步产出。有了有效产物,预览就改用产物,不会两份同时出声
 * (`product/rendering.md`「有声动效卡」)。
 *
 * 桌面运行环境不走这里(预览里未生成的声音照旧提示)。
 */
import type { Project, TrackClip } from "../../kernel/project";
import { acquireCardAudioClipUrl, type CardAudioLease } from "../../audio/cardAudio";
import { renderSoundEffectWavInWorker } from "../../audio/soundGenerationWorkerClient";
import { onlinePage } from "../../online/pageFlag";
import { decideClipSound, requestSoundBackfill } from "./onlineSoundJudge";

/**
 * 卡片声音(内置有声卡、内置音频卡)的在线播放源。
 * 回 null = 不归这里管(桌面运行环境,或这台设备跑不了它的代码),调用方照原来的办法提示;
 * 判重抛出说明原因的错误。
 */
export async function onlineLiveCardAudio(project: Project, clip: TrackClip, nodeId: string, frames: number): Promise<CardAudioLease | null> {
  if (!onlinePage()) return null;
  const decision = await decideClipSound(project, clip);
  if (decision.synth) return acquireCardAudioClipUrl({ project, nodeId, frames });
  // 这台设备不合成:交给渲染节点(第一段没有接收方,见 `onlineSoundJudge.ts` 的 `setSoundBackfillHandler`)
  void requestSoundBackfill({ project, clip, reason: decision.reason });
  if (decision.reason === "not-runnable") return null;
  throw new Error(decision.message);
}

interface CachedEffect { promise: Promise<string>; url?: string; refs: number }
const effects = new Map<string, CachedEffect>();

/**
 * 独立音效(提示音、键盘声)的在线播放源:素材服务里取不到它的 WAV 时,按片段里存着的配方在浏览器里合成同一份声音。
 * 回 null = 不归这里管或这台设备不合成(调用方保持原样:这一段没有声音)。
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
