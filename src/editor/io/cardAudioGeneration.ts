import { getState } from "../../store/project";
import { commitCardAudio } from "../../store/actions/cardAudio";
import { findClipInCut } from "../../kernel/cutSegments";
import { cardJson } from "../../kernel/cardGraph.mjs";
import { cardAudioIdentity, cardAudioSourceOffset, clipHasEmbeddedAudio, resolveCardAudioRendition } from "../../kernel/cardAudioRendition.mjs";
import { cardAudioIdentityHooks, renderEmbeddedCardWav } from "../../audio/cardAudio";
import { sha256Hex } from "../../online/snapUploader";
import { hasGeneratedAudio, uploadGeneratedAudio } from "./generatedAudioUpload";
import { isViewOnly } from "./viewOnly";
import { decideClipSound } from "./onlineSoundJudge";

/** 与独立音效一样限制总任务数；任意用户卡仍只在一个小块里求值，不同时攒多份 PCM。 */
export const CARD_AUDIO_JOB_LIMIT = 4;
const pending = new Map<string, AbortController>();
let active = false;
const queue: { start: () => void; signal: AbortSignal; reject: (error: unknown) => void }[] = [];
function acquireSlot(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const abort = () => { const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1); reject(new DOMException("aborted", "AbortError")); };
    const release = () => { active = false; const next = queue.shift(); next?.start(); };
    const item = { signal, reject, start() {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); release(); return; }
      active = true; resolve(release);
    } };
    if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    if (active) { queue.push(item); signal.addEventListener("abort", abort, { once: true }); }
    else item.start();
  });
}
export function cancelCardAudioGeneration(clipId: string): boolean {
  const current = pending.get(clipId); if (!current) return false;
  current.abort(); return true;
}

/**
 * Agent 等待实际入库和提交完成；取消/换项目/新请求不会留下半个片段或覆盖新内容。
 * `cutId`:片段住在哪条剪辑里(缺省激活的那条)。导出前生成被剪辑段引用的剪辑里的有声卡时给(`exportSounds.ts`):
 * 身份、合成都按那条剪辑的序列算(`cutViewProject`),和用户切过去再生成是同一个结果,结果写回那条剪辑。
 */
export async function generateCardAudio(clipId: string, options: { signal?: AbortSignal; force?: boolean; cutId?: string; onProgress?: (done: number, total: number) => void } = {}) {
  if (isViewOnly()) throw new Error("只读页面不能生成卡片声音");
  const state = getState(), root = state.project, hooks = cardAudioIdentityHooks();
  const found = findClipInCut(root, options.cutId, clipId), p = found?.view ?? root, hit = found;
  if (!hit || !clipHasEmbeddedAudio(p, hit.clip, hooks.getCard)) throw new Error("找不到带内嵌声音的动效卡片");
  if (hit.track.locked) throw new Error("请先解锁卡片所在序列");
  const expectedClip = JSON.stringify(hit.clip), frozen = structuredClone(p), clip = findClipInCut(frozen, undefined, clipId)!.clip;
  const identity = cardAudioIdentity(frozen, clip, hooks), sourceOffset = cardAudioSourceOffset(frozen, clip);
  if (new TextEncoder().encode(cardJson(identity)).byteLength > 96 * 1024) throw new Error("卡片声音参数记录过大，请缩短片段或精简输入");
  if (!pending.has(clipId) && pending.size >= CARD_AUDIO_JOB_LIMIT) throw new Error("最多同时排队 4 个卡片声音任务，请等待或取消已有任务");
  pending.get(clipId)?.abort();
  const controller = new AbortController(); pending.set(clipId, controller);
  const abort = () => controller.abort(); options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const check = () => {
    controller.signal.throwIfAborted();
    const current = getState(), now = findClipInCut(current.project, options.cutId, clipId);
    if (pending.get(clipId) !== controller || current.projectLoadToken !== state.projectLoadToken || current.project.id !== root.id ||
        current.project.activeCutId !== root.activeCutId || !now || JSON.stringify(now.clip) !== expectedClip ||
        cardJson(cardAudioIdentity(now.view, now.clip, cardAudioIdentityHooks())) !== cardJson(identity))
      throw new Error("卡片、源码或项目已变化，旧的声音生成结果不会覆盖当前内容");
  };
  let release: (() => void) | undefined;
  try {
    if (!options.force) {
      let reusable;
      try { reusable = resolveCardAudioRendition(p, hit.clip, hooks); } catch { /* 缺失或过期时重新生成 */ }
      if (reusable && await hasGeneratedAudio(reusable.media.hash!, controller.signal)) {
        check();
        return { ok: true as const, clipId, mediaId: reusable.media.id, reused: true };
      }
    }
    // 在线页面:这台设备跑得了、又判轻的才在浏览器里合成(`onlineSoundJudge.ts`;桌面运行环境恒合成)
    const decision = await decideClipSound(frozen, clip, controller.signal);
    check();
    if (!decision.synth) throw new Error(decision.message);
    release = await acquireSlot(controller.signal);
    check();
    const rendered = await renderEmbeddedCardWav(frozen, clip, controller.signal, options.onProgress);
    check();
    const sourceKey = await sha256Hex(new TextEncoder().encode(cardJson({ version: 1, identity, sourceOffset, frames: rendered.frames, sampleRate: 48000 })));
    check();
    const asset = await uploadGeneratedAudio(rendered.wav, controller.signal);
    check();
    const result = commitCardAudio({ projectId: root.id, cutId: root.activeCutId, clipCutId: options.cutId, loadToken: state.projectLoadToken, clipId, expectedClip,
      media: { kind: "audio", name: `${clip.label || hooks.getCard(clip.cardId)?.name || clip.cardId} · 卡片声音.wav`,
        url: `/@media/${asset.hash}`, hash: asset.hash, ext: "wav", size: asset.bytes, duration: rendered.frames / 48000 },
      rendition: { version: 1, cardId: clip.cardId, sourceKey, sourceOffset, duration: rendered.frames / 48000,
        sampleRate: 48000, frames: rendered.frames, channels: rendered.channels, identity } });
    return { ok: true as const, ...result, reused: false };
  } finally {
    release?.();
    options.signal?.removeEventListener("abort", abort);
    if (pending.get(clipId) === controller) pending.delete(clipId);
  }
}
