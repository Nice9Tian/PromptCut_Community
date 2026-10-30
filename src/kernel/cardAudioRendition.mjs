import { cardJson } from './cardGraph.mjs';
import { cardClockOffset, clipSpeed, speedMutesSource } from './clipTime.mjs';

/** 声画一体卡的声音属于原片段，不能当普通素材分离。纯音频素材效果卡不是声画卡。 */
export const isAudiovisualCard = def => !!def && typeof def.audio === 'function' &&
  (typeof def.Component === 'function' || typeof def.Component === 'object' && def.Component !== null || typeof def.card === 'function');
export function assertAudiovisualCardKind(def) {
  if (isAudiovisualCard(def) && def.kind === 'audio') throw new Error('声画卡不能使用 kind:audio，请声明 animation/filter/transition/emphasis 视觉类型');
}
const nodeOf = (p, c) => p.cardNodes?.find(n => n.id === c.nodeId);
export function clipHasEmbeddedAudio(project, clip, getCard = () => undefined) {
  const node = nodeOf(project, clip);
  return isAudiovisualCard(getCard(clip.cardId || node?.cardId)) || clip.embeddedAudio === true || node?.embeddedAudio === true || !!clip.cardAudio;
}
export function clipHasAudio(project, clip, getCard = () => undefined) {
  // 剪辑段(kernel/cutSegments.ts)带着被引用剪辑的混音:可以独立静音、调音量
  if (typeof clip.cutId === 'string' && clip.cutId) return true;
  const node = nodeOf(project, clip), media = project.media?.find(m => m.id === clip.mediaId);
  return clipHasEmbeddedAudio(project, clip, getCard) || node?.adapter === 'card' && node.kind === 'audio' ||
    typeof getCard(clip.cardId || node?.cardId)?.audio === 'function' || media?.kind === 'video' || media?.kind === 'audio';
}
/**
 * 挂在这一段上的**卡片声音**：声画一体卡、音频素材效果卡，以及已经生成好的那一份。
 * 不含素材自己的原声 —— 问「变速段还出不出声」时，要的正是「除了原声之外还有没有别的声音」，
 * 所以这里和 `clipHasAudio` 差的就是末尾 `media.kind` 那一截（那一截说的是原声）。
 */
export function clipHasCardAudio(project, clip, getCard = () => undefined) {
  const node = nodeOf(project, clip);
  if (clipHasEmbeddedAudio(project, clip, getCard)) return true;
  if (node?.adapter === 'card' && node.kind === 'audio') return true;
  return typeof getCard(clip.cardId || node?.cardId)?.audio === 'function';
}

/**
 * 这一段**一点声音都不出**（时间轴角标的判据，2026-10-23 用户定之后）。
 *
 * 变速的素材段不出原声（`clipTime.mjs` 的 `speedMutesSource`），但那天用户放开了两件事
 * （语义 `docs/semantics/product/project-model.md`「声音」）：声画一体卡挂在变速段上照常出声（「出声。」），
 * 变速段也能当音频素材效果卡的声音输入（「放开。」）。所以「变速」不再等于「没声音」——
 * 只有原声不出、**且**没有任何卡片声音挂在它上面，这一段才真的是哑的。
 *
 * 判的是「挂在这一段上」：别处的卡接走这一段的素材当输入时，声音是从那张卡出来的，不算这一段在出声。
 */
export function clipGoesSilentBySpeed(project, clip, getCard = () => undefined) {
  return speedMutesSource(clip, project) && !clipHasCardAudio(project, clip, getCard);
}

/**
 * 两路共用的源时钟。切分已同时写 mediaOffset/node.timeOffset，绝不能相加。
 * 变速的素材段上按卡片时钟(mediaOffset ÷ speed,`clipTime.mjs` 的 `cardClockOffset`;1 倍逐位就是 mediaOffset):
 * 切分、裁剪只把它推进时间轴上的那几秒,已生成的声音照旧按「当前源时钟 − 区间起点」对位(2026-10-23 用户定「出声。」)。
 */
export function cardAudioSourceOffset(project, clip) {
  return cardClockOffset(clip) ?? nodeOf(project, clip)?.timeOffset ?? 0;
}
export class CardAudioRenditionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, clip, message) => { throw new CardAudioRenditionError(code, `${clip.id} 的卡片声音${message}`); };

/** 同步纯数据身份：参数/事件表、所有上游素材哈希与映射、代码版本。没有源码的在线端只读已存快照。 */
export function cardAudioIdentity(project, clip, hooks = {}, saved = clip.cardAudio?.identity) {
  const getCard = hooks.getCard ?? (() => undefined), versions = hooks.sourceVersionOf;
  const nodes = new Map((project.cardNodes ?? []).map(n => [n.id, n]));
  const clips = (project.tracks ?? []).flatMap(t => t.clips ?? []);
  const root = nodeOf(project, clip) ?? { cardId: clip.cardId, inputs: {} };
  const visit = (node, owner, fallback, seen = new Set()) => {
    if (seen.has(node)) fail('stale', clip, '输入存在循环，无法生成');
    const nextSeen = new Set(seen).add(node), def = getCard(node.cardId);
    const defaults = def?.defaults ?? fallback?.defaults ?? {};
    const sourceVersion = versions?.(node.cardId) ?? fallback?.sourceVersion;
    if (!sourceVersion) fail('missing', clip, '缺少源码版本，请在本地重新生成');
    const inputs = {};
    for (const [name, raw] of Object.entries(node.inputs ?? {})) {
      const ref = typeof raw === 'string' ? { nodeId: raw } : raw;
      const sourceId = /^@clip\/(.+)\/source$/.exec(ref.nodeId)?.[1];
      const sourceClip = sourceId ? clips.find(c => c.id === sourceId) : undefined;
      if (sourceId) {
        const media = project.media?.find(m => m.id === sourceClip?.mediaId);
        if (!media?.hash) fail('missing', clip, '输入素材缺失或没有内容哈希');
        // 自己的素材已经按源时钟访问，split 的边补偿不能再使身份变化。
        const offset = sourceClip === owner ? (ref.offset ?? 0) + (node.timeOffset ?? 0) : (ref.offset ?? 0) + (sourceClip?.mediaOffset ?? 0);
        // 输入素材段变了速,声音跟着变速变调(audioSources.ts 的 varispeedBlock),倍率进身份;1 倍不写,身份逐字不变
        const speed = clipSpeed(sourceClip);
        inputs[name] = { media: media.hash, offset, rate: ref.rate ?? 1, ...(speed !== 1 ? { speed } : {}) };
      } else {
        const upstream = nodes.get(ref.nodeId);
        if (!upstream) fail('missing', clip, '输入节点已删除');
        const upstreamOwner = clips.find(c => c.nodeId === upstream.id);
        inputs[name] = { offset: ref.offset ?? 0, rate: ref.rate ?? 1,
          value: visit(upstream, upstreamOwner, fallback?.inputs?.[name]?.value, nextSeen) };
      }
    }
    return { cardId: node.cardId, sourceVersion, defaults, params: { ...defaults, ...(owner?.params ?? node.params ?? {}) }, inputs,
      ...(owner === clip ? {} : { timeOffset: node.timeOffset ?? 0 }) };
  };
  return JSON.parse(cardJson(visit(root, clip, saved)));
}

/**
 * 剪辑段展开出来的片段(`cutAudio.mjs` 的 `audioProjectOf`,带 `cutOrigin`):它的 id 带了剪辑段路径前缀、起止被平移裁剪,
 * 身份里按片段 id 找的输入素材在展开后的项目里找不到。所以按它在被引用剪辑里的原片段核身份与覆盖范围
 * (和在那条剪辑里生成时同一个口径),找不到原片段(坏数据)时照展开后的片段核。
 */
function cutOriginOf(project, clip) {
  const o = clip.cutOrigin;
  if (!o || typeof o.cutId !== 'string' || typeof o.clipId !== 'string') return null;
  const tracks = project.cuts?.find(c => c.id === o.cutId)?.tracks;
  if (!Array.isArray(tracks)) return null;
  const original = tracks.flatMap(t => t.clips ?? []).find(c => c.id === o.clipId);
  return original ? { project: { ...project, tracks }, clip: original } : null;
}

/** WAV 的 sourceOffset 是它的区间起点；播放偏移是当前源时钟减区间起点。支持原 WAV 覆盖的裁切/切分。 */
export function resolveCardAudioRendition(project, clip, hooks = {}) {
  const origin = cutOriginOf(project, clip);
  if (origin) {
    // 原片段的整段核过,展开后的是它的一截:偏移加上裁掉的那一截(展开时源时钟已往后挪同样多)
    const base = resolveCardAudioRendition(origin.project, origin.clip, hooks);
    const shift = cardAudioSourceOffset(project, clip) - cardAudioSourceOffset(origin.project, origin.clip);
    return { ...base, offset: base.offset + Math.round(shift * base.rendition.sampleRate) / base.rendition.sampleRate };
  }
  const r = clip.cardAudio;
  if (!r) fail('missing', clip, '尚未生成，请先生成卡片声音');
  if (r.version !== 1 || r.cardId !== clip.cardId || r.sampleRate !== 48000 || !Number.isSafeInteger(r.frames) || r.frames < 1 ||
      !Number.isInteger(r.channels) || r.channels < 1 || r.channels > 8 || !Number.isFinite(r.sourceOffset) || !r.identity)
    fail('stale', clip, '记录无效，请重新生成');
  const identity = cardAudioIdentity(project, clip, hooks);
  if (cardJson(identity) !== cardJson(r.identity)) fail('stale', clip, '已过期（参数、事件、输入或源码已变化），请重新生成');
  const offset = cardAudioSourceOffset(project, clip) - r.sourceOffset;
  const frames = Math.round((clip.end - clip.start) * r.sampleRate), start = Math.round(offset * r.sampleRate);
  if (!Number.isFinite(offset) || start < 0 || frames < 1 || start + frames > r.frames)
    fail('stale', clip, '预渲染结果未覆盖当前范围，请重新生成');
  const media = project.media?.find(m => m.id === r.mediaId);
  if (!media || media.kind !== 'audio' || !/^[0-9a-f]{64}$/i.test(media.hash ?? '') || !media.url || /^blob:/.test(media.url) || media.pending)
    fail('missing', clip, '素材缺失，请恢复素材或重新生成');
  return { media, offset: start / r.sampleRate, rendition: r };
}
