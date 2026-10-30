import { normalizeCardInput, projectCardGraph } from './cardGraph.mjs';
import { isAudiovisualCard, assertAudiovisualCardKind } from './cardAudioRendition.mjs';

/** 素材效果卡 = 注册表里写了 `card` 或 `audio` 的普通 CardDef。定义永远从注册表取,
 * 不存进项目 JSON —— 它和 TSX 用户卡一样是 `src/cards/user/<id>.tsx` 文件。 */
const isGraphCard = def => !!def && (typeof def.card === 'function' || typeof def.audio === 'function');

/** 纯 DOM 卡(有组件、没有 card / audio)。第一版素材效果卡不接它的输出。 */
const isDomCard = def => !!def && !isGraphCard(def);

/**
 * 把一张素材效果卡挂到片段上(新建片段或套在已有片段上),一步撤销由调用方合并。
 *
 * `getCard` 是注册表的取卡函数(浏览器侧 `src/kernel/registry`)。定义不在项目里,
 * 所以这个参数不是可选的锦上添花 —— 不传就一张卡也找不到。
 */
export function applyCardDefinition(project, args, getCard = () => undefined) {
  const definition = getCard(args.cardId);
  if (!definition) throw new Error(`Unknown card: ${args.cardId}`);
  if (!isGraphCard(definition)) throw new Error('This definition uses the existing card adapter');
  assertAudiovisualCardKind(definition);
  const next = structuredClone(project);
  const clipById = id => next.tracks?.flatMap(track => track.clips ?? []).find(clip => clip.id === id);
  let track, clip;
  if (args.clipId) {
    track = next.tracks.find(track => track.clips.some(clip => clip.id === args.clipId));
    clip = track?.clips.find(clip => clip.id === args.clipId);
    if (!clip) throw new Error(`Unknown clip: ${args.clipId}`);
  } else {
    track = next.tracks.find(track => track.id === args.trackId);
    if (!track || !Number.isFinite(args.start) || !Number.isFinite(args.end) || args.end <= args.start) throw new Error('A new card clip requires trackId and start < end');
    clip = { id: args.newClipId || crypto.randomUUID(), start: args.start, end: args.end, params: {}, ...(args.frame ? { frame: args.frame } : {}) };
    track.clips.push(clip);
    next.duration = Math.max(next.duration, args.end);
  }

  /*
   * ① 物化。面板拖入 / add_clip 建的素材效果卡片段只有 cardId,渲染时靠 projectCardGraph
   * 就地合成的 `@clip/<id>/card` 出画 —— 那个 id 只在渲染路径上存在,不能被 inputs 引用。
   * 所以目标片段和被引用的片段里,凡是「素材效果卡片段但没有 nodeId」的,先建出正式节点。
   */
  const materialize = target => {
    if (!target || target.nodeId || !target.cardId) return;
    const def = getCard(target.cardId);
    if (!isGraphCard(def)) return;
    const id = crypto.randomUUID();
    next.cardNodes = [...(next.cardNodes || []), { id, adapter: 'card', cardId: target.cardId,
      kind: def.kind ?? 'animation', ...(isAudiovisualCard(def) ? { embeddedAudio: true } : {}), inputs: {}, params: { ...def.defaults, ...target.params } }];
    target.nodeId = id;
  };
  const referencedClips = Object.values(args.inputs || {})
    .map(input => (typeof input === 'string' ? undefined : input?.clipId)).filter(Boolean);
  materialize(clip);
  for (const id of referencedClips) materialize(clipById(id));

  // 第一版不接 DOM 卡:既不套在 DOM 卡段上,也不引用 DOM 卡的输出。
  if (isDomCard(getCard(clip.cardId))) throw new Error('素材效果卡第一版不接 DOM 卡输入');
  for (const id of referencedClips) if (isDomCard(getCard(clipById(id)?.cardId))) throw new Error('素材效果卡第一版不接 DOM 卡输入');

  /*
   * 同一片段不能同时挂音频素材效果卡和视觉素材效果卡:音频素材效果卡不写 clip.cardId,所以判据只能看
   * clip.nodeId 指向的那个节点的 kind(而且下面 `clip.nodeId = nodeId` 会把它覆盖掉)。
   */
  const priorNodeId = clip.nodeId;
  const prior = priorNodeId ? next.cardNodes?.find(node => node.id === priorNodeId) : undefined;
  if (prior?.adapter === 'card' && (prior.kind === 'audio' && !prior.embeddedAudio) !== (definition.kind === 'audio' && !isAudiovisualCard(definition)))
    throw new Error('同一片段不能同时挂音频素材效果卡和视觉素材效果卡，先复制片段');

  const nodeId = args.nodeId || crypto.randomUUID();
  const previous = next.cardNodes?.find(node => node.id === nodeId);
  if (previous && clip.nodeId !== nodeId) throw new Error('Node ID is already used by another card instance');
  /** 传当前 clip.nodeId = 原地改这个实例的参数和输入(不接链,接了就是自指、必抛 cycle) */
  const inPlace = !!args.nodeId && args.nodeId === priorNodeId;

  // ② 显式 inputs。`clipId` 对素材段映射成它的 `@clip/<id>/source`,
  // 对素材效果卡片段映射成它自己的输出节点(转场卡的一路输入是另一张素材效果卡就靠这条)。
  const sourceOf = clipId => {
    const target = clipById(clipId);
    return target?.nodeId && isGraphCard(getCard(target.cardId)) ? target.nodeId : `@clip/${clipId}/source`;
  };
  const explicit = !!Object.keys(args.inputs || {}).length;
  const inputs = {};
  for (const [name, input] of Object.entries(args.inputs || {})) {
    const ref = typeof input === 'string' ? { nodeId: input } : input;
    inputs[name] = normalizeCardInput({ ...ref, nodeId: ref.clipId ? sourceOf(ref.clipId) : ref.nodeId });
  }
  for (const ref of Object.values(inputs)) {
    const synthetic = /^@clip\/(.+)\/source$/.exec(ref.nodeId);
    const owner = synthetic ? clipById(synthetic[1]) : undefined;
    const node = next.cardNodes?.find(node => node.id === ref.nodeId);
    if (node?.adapter === 'chrome' || (owner && !owner.mediaId && isDomCard(getCard(owner.cardId))))
      throw new Error('素材效果卡第一版不接 DOM 卡输入');
  }

  /*
   * ③ 继承 / 自动接链,二选一。顺序只有这一种排法成立:继承排在兜底之后的话,
   * 「素材段上原地改一张旧 inputs 为空的素材效果卡」会先被兜底塞进 @clip/<id>/source
   * 再被空 inputs 抹掉。
   */
  if (inPlace) {
    // 原地改卡没传 inputs 就沿用旧节点的上游边,不然每次改参数都会把链剪断
    if (!explicit && previous?.inputs) for (const [name, ref] of Object.entries(previous.inputs)) inputs[name] = normalizeCardInput(ref);
  } else if (!explicit && priorNodeId && !(definition.inputs && !Object.keys(definition.inputs).length)) {
    // 「先套反色再套模糊」:第二张的输入自动接第一张的输出,
    // 而不是接那个以本卡为 cardId 的 chrome 合成节点。
    inputs.source = normalizeCardInput({ nodeId: priorNodeId });
  }

  // ④ 兜底。第二次 apply_card 打同一片段时 clip.cardId 已经是本卡 id,
  // 不排除它就会塞一条指向自己的 source 输入、digest 跟着变。
  if (!(definition.inputs && !Object.keys(definition.inputs).length) && !Object.keys(inputs).length && (clip.mediaId || (clip.cardId && clip.cardId !== definition.id)))
    inputs.source = normalizeCardInput(`@clip/${clip.id}/source`);

  // ⑤ 建节点。kind 从定义抄进节点:Node 侧脚本读不到 TSX 定义,只能看节点。
  const node = { id: nodeId, adapter: 'card', cardId: definition.id, kind: definition.kind ?? 'animation', ...(isAudiovisualCard(definition) ? { embeddedAudio: true } : {}),
    params: { ...definition.defaults, ...args.params }, inputs };
  next.cardNodes = [...(next.cardNodes || []).filter(node => node.id !== nodeId), node];

  /*
   * ⑥ 写片段字段。**赋值必须排在兜底之后**:写早了,无输入的素材效果卡会被 ④ 塞一条指向自己的 source。
   * 音频素材效果卡例外,只写 nodeId ——它没有 card 也没有 Component,进了 Stage 就是 <undefined />;
   * 它的消费方只看节点,片段照旧被素材层跳过、画面上不多一层。
   */
  clip.nodeId = nodeId;
  if (isAudiovisualCard(definition)) clip.embeddedAudio = true;
  else { delete clip.embeddedAudio; delete clip.cardAudio; }
  if (definition.kind !== 'audio' || isAudiovisualCard(definition)) clip.cardId = definition.id;
  // 实例参数节点存一份、片段也存一份:右栏和 setClipParams 写的是 clip.params,
  // Stage 读的也是它,不照抄就是 apply_card 的 params 在画面上静默丢掉。
  clip.params = { ...definition.defaults, ...args.params };
  projectCardGraph(next, getCard);
  return { project: next, clipId: clip.id, nodeId };
}

/**
 * 把片段上那张素材效果卡摘掉。
 *
 * 和滤镜、像素映射、音频效果不一样:那三样是片段上的一个字段,置空就完了;
 * 素材效果卡是节点图里的一个节点,**连着输入和输出** —— 直接清掉 `clip.nodeId`
 * 会让链上游的那几张卡一起失效(「先套反色再套模糊」摘掉模糊,反色也跟着没了)。
 *
 * 所以摘掉 = **把这一个节点从链上取下来,下游接到它的上游**:
 *
 *   素材 → 反色 → 模糊(片段的终端)   摘掉模糊 → 素材 → 反色
 *   素材 → 反色(片段的终端)          摘掉反色 → 素材(片段回到普通素材段)
 *
 * 上游取的是 `source` 那一路。没有 `source` 的卡摘不了,原因写在抛出来的话里:
 * 转场卡有 A、B 两路(摘掉它等于拆掉这处转场),无输入的卡本身就是这一段的内容、不是叠加上去的。
 *
 * 被别的节点引用着的那个节点**不删**,只是这一段不再用它:它还在喂别人。
 *
 * @param {object} project
 * @param {string} clipId
 * @param {(id: string) => any} getCard 注册表的取卡函数(和 applyCardDefinition 同一个)
 * @returns {{ project: object, nodeId: string, nextNodeId: string | null, removed: boolean }}
 */
export function detachCardNode(project, clipId, getCard = () => undefined) {
  const next = structuredClone(project);
  const clip = next.tracks?.flatMap(track => track.clips ?? []).find(c => c.id === clipId);
  if (!clip) throw new Error(`Unknown clip: ${clipId}`);
  const nodeId = clip.nodeId;
  if (!nodeId) throw new Error('这一段没有挂素材效果卡');
  const node = (next.cardNodes || []).find(n => n.id === nodeId);
  if (!node) {
    // 悬空(节点被别处删了):把指针擦掉就是,不用拦着用户
    delete clip.nodeId;
    return { project: next, nodeId, nextNodeId: null, removed: false };
  }

  const inputs = node.inputs || {};
  const names = Object.keys(inputs);
  if (!names.length) throw new Error('这张卡没有输入,它本身就是这一段的内容,不是叠加上去的;要去掉请删掉这一段');
  if (!inputs.source) throw new Error(`这张卡有不止一路输入(${names.join('、')}),摘掉它等于拆掉这处合成;请在编辑分区的节点图里改`);

  const upstream = typeof inputs.source === 'string' ? inputs.source : inputs.source.nodeId;
  const upstreamNode = (next.cardNodes || []).find(n => n.id === upstream);

  // 下游:这一段接到上游去。上游是 `@clip/<id>/source` 这种合成 id 时没有节点可接,
  // 片段回到普通素材段 / 普通卡片段
  if (upstreamNode) {
    clip.nodeId = upstreamNode.id;
    if (upstreamNode.adapter === 'card' && typeof upstreamNode.cardId === 'string') clip.cardId = upstreamNode.cardId;
    clip.params = { ...(getCard(upstreamNode.cardId)?.defaults || {}), ...(upstreamNode.params || {}) };
    if (upstreamNode.embeddedAudio) clip.embeddedAudio = true;
    else { delete clip.embeddedAudio; delete clip.cardAudio; }
  } else {
    delete clip.nodeId;
    delete clip.embeddedAudio;
    delete clip.cardAudio;
    // 素材段:连 cardId 和参数一起回到没挂过的样子。卡片段的底座是真节点,走不到这里
    if (clip.mediaId) { delete clip.cardId; clip.params = {}; }
  }

  // 别人还引用着它就留着(它还在喂别人);没人引用才从库里删
  const stillUsed = (next.cardNodes || []).some(n => n.id !== nodeId
    && Object.values(n.inputs || {}).some(ref => (typeof ref === 'string' ? ref : ref?.nodeId) === nodeId))
    || next.tracks?.some(track => track.clips?.some(c => c.nodeId === nodeId));
  if (!stillUsed) next.cardNodes = (next.cardNodes || []).filter(n => n.id !== nodeId);

  // 和 applyCardDefinition 一样,落地前先把图走一遍:接坏了当场抛,不留一份画不出来的项目
  projectCardGraph(next, getCard);
  return { project: next, nodeId, nextNodeId: clip.nodeId ?? null, removed: !stillUsed };
}

/** Clone a clip-owned 素材效果卡 instance while deliberately sharing definitions.
 * Inputs that address the old clip's synthetic source follow the new clip;
 * other inputs remain external graph references. */
export function cloneCardClipInstance(project, oldClipId, newClipId, nodeId, timeOffset = 0) {
  if (!nodeId) return { project, nodeId };
  const source = project.cardNodes?.find(node => node.id === nodeId);
  if (!source || source.adapter !== 'card') return { project, nodeId };
  const nextId = crypto.randomUUID();
  const oldSource = `@clip/${oldClipId}/source`, newSource = `@clip/${newClipId}/source`;
  const inputs = Object.fromEntries(Object.entries(source.inputs || {}).map(([name, ref]) => {
    const value = typeof ref === 'string' ? { nodeId: ref } : structuredClone(ref);
    // The cloned card clock advances by timeOffset. Its own media source
    // already advances via right.mediaOffset, so subtract the same amount on
    // this edge to avoid applying the split delta twice.
    if (value.nodeId === oldSource) { value.nodeId = newSource; value.offset = (value.offset ?? 0) - timeOffset; }
    return [name, value];
  }));
  return { project: { ...project, cardNodes: [...(project.cardNodes || []), { ...structuredClone(source), id: nextId, inputs, ...(timeOffset ? { timeOffset: (source.timeOffset ?? 0) + timeOffset } : {}) }] }, nodeId: nextId };
}
