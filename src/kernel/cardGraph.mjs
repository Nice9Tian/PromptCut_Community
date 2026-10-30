import { cardCapabilities, COMPOSITING_VALUES } from './frameMode.mjs';

export const CARD_RUNTIME_ABI = 1;
export const CARD_KINDS = ['animation', 'filter', 'transition', 'emphasis', 'audio'];
export const CARD_ADAPTERS = ['card', 'chrome', 'media', 'filter', 'audio', 'emphasis', 'transition'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fail = message => { throw new Error(`Card graph: ${message}`); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = (id, label) => {
  if (typeof id !== 'string' || !id || id.length > 256 || /[\x00-\x1f]/.test(id)) fail(`invalid ${label}`);
  return id;
};

/** Canonical JSON is shared by the browser planner and server cache identity. */
export function cardJson(value) {
  if (Array.isArray(value)) return '[' + value.map(cardJson).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + cardJson(value[k])).join(',') + '}';
  if (typeof value === 'number' && !Number.isFinite(value)) fail('non-finite number');
  const text = JSON.stringify(value);
  if (text === undefined) fail('values must be JSON serializable');
  return text;
}

export function normalizeCardDefinition(raw) {
  if (!object(raw)) fail('definition must be an object');
  const id = identifier(raw.id, 'definition id');
  if (!['tsx', 'builtin'].includes(raw.language)) fail(`${id}: invalid language`);
  if (!CARD_KINDS.includes(raw.kind)) fail(`${id}: invalid kind`);
  if (raw.need_prerendering !== undefined && typeof raw.need_prerendering !== 'boolean') fail(`${id}: need_prerendering must be boolean`);
  if (raw.compositing !== undefined && !COMPOSITING_VALUES.includes(raw.compositing)) fail(`${id}: invalid compositing`);
  const styleKeys = raw.styleKeys ?? null;
  if (styleKeys !== null && (!Array.isArray(styleKeys) || styleKeys.some(k => typeof k !== 'string' || !k))) fail(`${id}: invalid styleKeys`);
  const definition = { ...raw, id, defaults: raw.defaults ?? {}, styleKeys,
    need_prerendering: raw.need_prerendering ?? true, compositing: raw.compositing ?? 'unknown' };
  cardJson(definition);
  return structuredClone(definition);
}

export function selectedCardStyle(definition, style = {}) {
  const keys = definition?.styleKeys;
  return keys == null ? structuredClone(style) : Object.fromEntries(keys.filter(k => own(style, k)).map(k => [k, structuredClone(style[k])]));
}

/** An edge is a query transform, never a mutation of a decoder/playback cursor. */
export function normalizeCardInput(input) {
  if (typeof input === 'string') input = { nodeId: input };
  if (!object(input)) fail('input must reference a node');
  const nodeId = identifier(input.nodeId, 'input node id');
  const offset = input.offset ?? 0, rate = input.rate ?? 1;
  if (!Number.isFinite(offset) || !Number.isFinite(rate)) fail('invalid input time mapping');
  return { nodeId, offset, rate };
}

/** Returns topological batches; nodes within a batch have no mutual dependencies. */
export function validateCardGraph(raw) {
  if (!object(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.outputs)) fail('nodes and outputs are required');
  if (raw.nodes.length > 10000) fail('too many nodes');
  const nodes = new Map();
  for (const value of raw.nodes) {
    const id = identifier(value?.id, 'node id');
    if (nodes.has(id)) fail(`duplicate node ${id}`);
    if (!CARD_ADAPTERS.includes(value.adapter)) fail(`${id}: invalid adapter`);
    const inputs = Object.fromEntries(Object.entries(value.inputs ?? {}).map(([name, ref]) => [name, normalizeCardInput(ref)]));
    nodes.set(id, { ...structuredClone(value), inputs });
  }
  /*
   * 指向已删片段的输入(`@clip/<id>/…`)是「片段被删了」,不是图写错了:丢边、记名字,
   * 不 fail —— 否则「给素材段套滤镜图卡再删掉这段」之后整份图算不出来,所有图卡陪葬。
   *
   * 丢边必须在下面算 dependencies **之前**做:只在循环里 continue 的话 remaining
   * 已经按含悬空边的数量定死,缺失节点永远不进任何 level,最后撞 'dependency cycle'。
   */
  for (const [, node] of nodes) {
    const missing = Object.entries(node.inputs).filter(([, ref]) => !nodes.has(ref.nodeId) && ref.nodeId.startsWith('@clip/')).map(([name]) => name);
    if (!missing.length) continue;
    for (const name of missing) delete node.inputs[name];
    node.missingInputs = [...new Set([...(node.missingInputs ?? []), ...missing])].sort();
  }
  const dependants = new Map(), remaining = new Map();
  for (const [id, node] of nodes) {
    const dependencies = new Set(Object.values(node.inputs).map(ref => ref.nodeId));
    remaining.set(id, dependencies.size);
    for (const dependency of dependencies) {
      if (!nodes.has(dependency)) fail(`${id}: missing input ${dependency}`);
      if (!dependants.has(dependency)) dependants.set(dependency, []);
      dependants.get(dependency).push(id);
    }
  }
  const outputs = raw.outputs.map(out => {
    const nodeId = typeof out === 'string' ? out : out?.nodeId;
    if (!nodes.has(nodeId)) fail(`missing output ${nodeId}`);
    return typeof out === 'string' ? { nodeId } : structuredClone(out);
  });
  const levels = [];
  let level = [...nodes.keys()].filter(id => remaining.get(id) === 0), visited = 0;
  while (level.length) {
    levels.push(level); visited += level.length;
    const next = [];
    for (const id of level) for (const dependent of dependants.get(id) ?? []) {
      remaining.set(dependent, remaining.get(dependent) - 1);
      if (!remaining.get(dependent)) next.push(dependent);
    }
    level = next;
  }
  if (visited !== nodes.size) fail('dependency cycle');
  return { nodes: [...nodes.values()], outputs, levels };
}

/** Adapt the existing project into the same graph used by 图卡 (graph cards).
 * Existing fields stay readable; native effects are adapter nodes, not a
 * separate public effect-definition or scheduling API.
 */
export function projectCardGraph(project, getLegacyCard = () => undefined) {
  const nodes = structuredClone(project.cardNodes ?? []), outputs = [];
  /** 图卡片段(定义来自注册表、写了 card / audio)。判据只看定义,不看节点。 */
  const audiovisual = def => !!def?.audio && !!(def.card || def.Component);
  const graphCard = id => { const def = getLegacyCard(id); return def && (typeof def.card === 'function' || typeof def.audio === 'function') ? def : undefined; };
  const nodeIds = new Set(nodes.map(node => node.id));
  const media = new Map((project.media ?? []).map(value => [value.id, value]));
  const add = node => {
    if (nodeIds.has(node.id)) fail(`reserved node collision ${node.id}`);
    nodeIds.add(node.id); nodes.push(node); return node.id;
  };
  for (const track of [...(project.tracks ?? [])].reverse()) {
    for (const clip of track.clips ?? []) {
      let baseId;
      const graphDef = clip.cardId ? graphCard(clip.cardId) : undefined;
      if (clip.mediaId) {
        const source = media.get(clip.mediaId);
        baseId = add({ id: `@clip/${clip.id}/source`, adapter: 'media', media: source, clipId: clip.id,
          offset: clip.mediaOffset ?? 0, inputs: {}, capabilities: { need_prerendering: false, compositing: 'independent' } });
      } else if (clip.cardId && !graphDef) {
        // 图卡片段**不合成 chrome 基节点**:它的输出就是它自己那个 'card' 节点
        const def = getLegacyCard(clip.cardId);
        baseId = add({ id: `@clip/${clip.id}/source`, adapter: 'chrome', cardId: clip.cardId, clipId: clip.id,
          params: { ...def?.defaults, ...clip.params }, parts: clip.parts, inputs: {}, capabilities: cardCapabilities(def, { ...def?.defaults, ...clip.params }, clip.parts) });
      }
      let nodeId = clip.nodeId || baseId;
      // 面板拖入 / add_clip 建的图卡片段只有 cardId,就地合成一个渲染用的节点。
      // 这个 id 只给渲染用 —— 片段一旦被 apply_card 碰过就由物化规则换成真节点。
      if (!nodeId && graphDef) nodeId = add({ id: `@clip/${clip.id}/card`, adapter: 'card', cardId: clip.cardId,
        kind: graphDef.kind ?? 'animation', ...(audiovisual(graphDef) ? { embeddedAudio: true, timeOffset: clip.mediaOffset ?? 0 } : {}), inputs: {}, params: { ...graphDef.defaults, ...clip.params } });
      if (!nodeId) continue;
      /*
       * 实例参数:节点自己存一份,但**片段指向的那个节点以 clip.params 为准**。
       * 右栏改参数只动最外层那张,链上内层节点保留建卡时那份(要改走 apply_card 传 nodeId)。
       * digest 读的就是图里这份,所以视觉、音频、身份三处同一口径。
       */
      if (clip.nodeId) {
        const instance = nodes.find(node => node.id === clip.nodeId);
        if (instance?.adapter === 'card') {
          const def = getLegacyCard(instance.cardId);
          instance.params = { ...def?.defaults, ...clip.params };
          if (audiovisual(def) || instance.embeddedAudio) {
            instance.embeddedAudio = true;
            const priorOffset = Number(instance.timeOffset) || 0;
            instance.timeOffset = clip.mediaOffset ?? priorOffset;
            // 自己的素材段已按 mediaOffset 裁切；共用时钟只折算一次。
            for (const [name, input] of Object.entries(instance.inputs ?? {})) {
              const ref = normalizeCardInput(input);
              if (ref.nodeId === `@clip/${clip.id}/source`) instance.inputs[name] = { ...ref, offset: ref.offset + priorOffset - instance.timeOffset };
            }
          }
        }
      }
      for (const [field, library, adapter] of [['filter', 'filters', 'filter'], ['audioFx', 'audioFx', 'audio']]) {
        if (!clip[field]) continue;
        const def = project[library]?.find(value => value.id === clip[field].id);
        if (!def) continue; // Existing projects already treat a deleted preset as bypass.
        nodeId = add({ id: `@clip/${clip.id}/${field}`, adapter, definition: def, params: clip[field].params ?? {},
          inputs: { source: { nodeId } } });
      }
      if (clip.emphasis) nodeId = add({ id: `@clip/${clip.id}/emphasis`, adapter: 'emphasis', params: clip.emphasis, inputs: { source: { nodeId } } });
      if (!track.hidden) outputs.push({ nodeId, clipId: clip.id, trackId: track.id, start: clip.start, end: clip.end,
        frame: clip.frame, opacity: clip.opacity, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, motion: clip.motion });
    }
  }
  const graph = validateCardGraph({ nodes, outputs });
  const normalized = new Map(graph.nodes.map(node => [node.id, node]));
  for (const level of graph.levels) for (const id of level) {
    const node = normalized.get(id);
    if (node.adapter === 'card') {
      // 定义没了(用户卡文件被删)不 fail:一张卡的定义没了不能让整份图算不出来。
      // 能力留 unknown,片段由 Stage 的取 def 那一格 return null 处理。
      const def = getLegacyCard(node.cardId);
      node.capabilities = def ? cardCapabilities(def, { ...def.defaults, ...node.params })
        : { need_prerendering: true, compositing: 'unknown' };
    } else if (!node.capabilities) {
      const upstream = Object.values(node.inputs).map(input => normalized.get(input.nodeId).capabilities);
      node.capabilities = { need_prerendering: upstream.some(c => c?.need_prerendering),
        compositing: upstream.length && upstream.every(c => c?.compositing === 'independent') ? 'independent' : 'unknown' };
    }
  }
  for (const output of graph.outputs) output.capabilities = normalized.get(output.nodeId).capabilities;
  return { abi: CARD_RUNTIME_ABI, ...graph };
}
