import { normalizeCardInput, projectCardGraph } from './cardGraph.mjs';
import { isAudiovisualCard, assertAudiovisualCardKind } from './cardAudioRendition.mjs';

/**
 * Media effect card = normal CardDef with `card` or `audio` specified in the registry. Definitions
 * are always fetched from the registry, not stored in the project JSON: like TSX user cards, it is
 * a `src/cards/user/<id>.tsx` file.
 */
const isGraphCard = def => !!def && (typeof def.card === 'function' || typeof def.audio === 'function');

/**
 * Pre-overlay cards (`overlay: "pre"` / `overlayKind: "pre"`, such as camera/lighting overlays on a
 * 3D scene host) inject parameters BEFORE the host scene renders rather than consuming its output
 * bitmap downstream. Attempting to attach a pre-overlay to an ordinary DOM card or media clip has no
 * scene to inspect and is rejected with an actionable message pointing to the cut's camera lane.
 */
const isPreOverlayCard = def => !!def && (def.overlay === 'pre' || def.overlayKind === 'pre');

const isSceneHostClip = (project, clip, getCard) => {
  if (!clip) return false;
  if (clip.cardId === 'scene-3d') return true;
  const hostDef = clip.cardId ? getCard(clip.cardId) : undefined;
  if (hostDef && (hostDef.sceneHost === true || hostDef.kind === 'scene3d')) return true;
  if (typeof clip.cutId === 'string' && clip.cutId) {
    const refCut = (project?.cuts || []).find(c => c.id === clip.cutId);
    if (refCut && refCut.kind === '3d') return true;
  }
  return false;
};

/**
 * Pure DOM card (has components, no card / audio). The first version of media effect cards does
 * not accept its output.
 */
const isDomCard = def => !!def && !isGraphCard(def);

/**
 * Attach a media effect card to a clip (new clip or wrapped over an existing clip); single-step
 * undo is merged by the caller.
 *
 * `getCard` is the registry card lookup function (browser-side `src/kernel/registry`). Definitions
 * are not in the project, so this parameter is not an optional bonus: if omitted, no cards can be
 * found.
 */
export function applyCardDefinition(project, args, getCard = () => undefined) {
  const definition = getCard(args.cardId);
  if (!definition) throw new Error(`Unknown card: ${args.cardId}`);
  if (isPreOverlayCard(definition)) {
    if (!args.clipId) {
      throw new Error(
        `Pre-overlay card "${definition.id}" requires clipId targeting an existing scene host (such as scene-3d or a 3D cut segment). For timeline camera moves on a 2D or 3D cut, use add_camera / update_camera on the cut's camera lane instead.`,
      );
    }
    const next = structuredClone(project);
    const clip = next.tracks?.flatMap(t => t.clips ?? []).find(c => c.id === args.clipId);
    if (!clip) throw new Error(`Unknown clip: ${args.clipId}`);
    if (!isSceneHostClip(next, clip, getCard)) {
      const targetDesc = clip.mediaId
        ? 'a media clip'
        : clip.cutId
          ? 'a 2D cut segment'
          : `card "${clip.cardId || clip.id}"`;
      throw new Error(
        `Pre-overlay card "${definition.id}" can only attach to a scene host (such as scene-3d or a 3D cut segment), not ${targetDesc} (an ordinary card or media clip has no 3D scene to inject into). For timeline camera moves on a 2D or 3D cut, use add_camera / update_camera on the cut's camera lane instead.`,
      );
    }
    const list = Array.isArray(clip.preOverlays) ? [...clip.preOverlays] : [];
    const idx = list.findIndex(entry => (args.nodeId && entry.id === args.nodeId) || entry.cardId === definition.id);
    const nodeId = args.nodeId || (idx >= 0 ? list[idx].id : crypto.randomUUID());
    const entry = {
      id: nodeId,
      cardId: definition.id,
      params: {
        ...(definition.defaults || {}),
        ...(idx >= 0 ? list[idx].params : {}),
        ...(args.params || {}),
      },
    };
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    clip.preOverlays = list;
    return { project: next, clipId: clip.id, nodeId };
  }
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
   * ① Materialize. Media effect card clips created via panel drag-in / add_clip only have cardId;
   * during rendering they rely on `@clip/<id>/card` synthesized on the spot by projectCardGraph to
   * produce visuals: that id exists only on the render path and cannot be referenced by inputs.
   * Therefore, in the target clip and referenced clips, create formal nodes first for any "media
   * effect card clip without nodeId".
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

  // The first version does not connect to DOM cards: neither wraps over DOM card clips, nor
  // references DOM card output.
  if (isDomCard(getCard(clip.cardId))) throw new Error('Media effect cards do not accept DOM card inputs in the first version');
  for (const id of referencedClips) if (isDomCard(getCard(clipById(id)?.cardId))) throw new Error('Media effect cards do not accept DOM card inputs in the first version');

  /*
   * The same clip cannot have both an audio media effect card and a visual media effect card
   * attached: audio media effect cards do not write clip.cardId, so the criterion can only check the
   * kind of the node pointed to by clip.nodeId (and `clip.nodeId = nodeId` below will overwrite it).
   */
  const priorNodeId = clip.nodeId;
  const prior = priorNodeId ? next.cardNodes?.find(node => node.id === priorNodeId) : undefined;
  if (prior?.adapter === 'card' && (prior.kind === 'audio' && !prior.embeddedAudio) !== (definition.kind === 'audio' && !isAudiovisualCard(definition)))
    throw new Error('The same clip cannot have both an audio media effect card and a visual media effect card, duplicate the clip first');

  const nodeId = args.nodeId || crypto.randomUUID();
  const previous = next.cardNodes?.find(node => node.id === nodeId);
  if (previous && clip.nodeId !== nodeId) throw new Error('Node ID is already used by another card instance');
  /**
   * Passing current clip.nodeId = modify this instance's parameters and inputs in place (do not chain;
   * doing so is self-referential and will throw a cycle).
   */
  const inPlace = !!args.nodeId && args.nodeId === priorNodeId;

  // ② Explicit inputs. `clipId` maps to its `@clip/<id>/source` for media clips, and maps to its own
  // output node for media effect card clips (relying on this when one input of a transition card is
  // another media effect card).
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
      throw new Error('Media effect cards do not accept DOM card inputs in the first version');
  }

  /*
   * ③ Inherit / auto-chain, pick one of two. Only this ordering works: if inheritance came after
   * fallback, "modifying in place on a media clip a media effect card whose old inputs are empty"
   * would first have @clip/<id>/source inserted by fallback, then wiped out by empty inputs.
   */
  if (inPlace) {
    // If modifying a card in place does not pass inputs, reuse the old node's upstream edges; otherwise
    // changing parameters each time would cut the chain
    if (!explicit && previous?.inputs) for (const [name, ref] of Object.entries(previous.inputs)) inputs[name] = normalizeCardInput(ref);
  } else if (!explicit && priorNodeId && !(definition.inputs && !Object.keys(definition.inputs).length)) {
    // "Invert then blur": the input of the second card automatically connects to the output of the
    // first card, rather than connecting to that chrome composite node using this card as cardId.
    inputs.source = normalizeCardInput({ nodeId: priorNodeId });
  }

  // ④ Fallback. When apply_card targets the same clip a second time, clip.cardId is already this
  // card's id; without excluding it, a source input pointing to itself would be inserted, and the
  // digest would change accordingly.
  if (!(definition.inputs && !Object.keys(definition.inputs).length) && !Object.keys(inputs).length && (clip.mediaId || (clip.cardId && clip.cardId !== definition.id)))
    inputs.source = normalizeCardInput(`@clip/${clip.id}/source`);

  // ⑤ Create node. Copy kind from definition into node: Node-side scripts cannot read TSX definitions
  // and can only inspect nodes.
  const node = { id: nodeId, adapter: 'card', cardId: definition.id, kind: definition.kind ?? 'animation', ...(isAudiovisualCard(definition) ? { embeddedAudio: true } : {}),
    params: { ...definition.defaults, ...args.params }, inputs };
  next.cardNodes = [...(next.cardNodes || []).filter(node => node.id !== nodeId), node];

  /*
   * ⑥ Write clip fields. **Assignment must happen after fallback**: if written too early, media effect
   * cards without inputs will have a source pointing to themselves inserted by ④. Audio media effect
   * cards are an exception and only write nodeId: they have neither card nor Component, entering Stage
   * as <undefined />; their consumers only look at the node, the clip is still skipped by the media
   * layer as before, and no extra layer is added on screen.
   */
  clip.nodeId = nodeId;
  if (isAudiovisualCard(definition)) clip.embeddedAudio = true;
  else { delete clip.embeddedAudio; delete clip.cardAudio; }
  if (definition.kind !== 'audio' || isAudiovisualCard(definition)) clip.cardId = definition.id;
  // Instance parameters are stored in both the node and the clip: the right rail and setClipParams
  // write clip.params, which Stage also reads; without copying, apply_card params would be silently
  // dropped on screen.
  clip.params = { ...definition.defaults, ...args.params };
  projectCardGraph(next, getCard);
  return { project: next, clipId: clip.id, nodeId };
}

/**
 * Detach the media effect card on the clip.
 *
 * Unlike filters, pixel maps, and audio effects: those three are a single field on the clip,
 * clearing them is all it takes; media effect cards are nodes in the node graph, **connected to
 * inputs and outputs**: directly clearing `clip.nodeId` would invalidate upstream cards on the
 * chain ("invert then blur", removing blur would make invert disappear as well).
 *
 * So removing = **take this single node off the chain and connect downstream to its upstream**:
 *
 *   Media → Invert → Blur (clip terminal)   Remove blur → Media → Invert
 *   Media → Invert (clip terminal)          Remove invert → Media (clip returns to normal media clip)
 *
 * Upstream takes the `source` path. Cards without `source` cannot be detached, with reasons stated
 * in the thrown message: transition cards have A and B paths (removing it is equivalent to tearing
 * down this transition), while cards without inputs are themselves the content of this clip, not
 * overlaid on top.
 *
 * Nodes referenced by other nodes are **not deleted**, only this clip no longer uses it: it is
 * still feeding other nodes.
 *
 * @param {object} project
 * @param {string} clipId
 * @param {(id: string) => any} getCard Registry card lookup function (same as applyCardDefinition)
 * @returns {{ project: object, nodeId: string, nextNodeId: string | null, removed: boolean }}
 */
export function detachCardNode(project, clipId, getCard = () => undefined, targetNodeId = undefined) {
  const next = structuredClone(project);
  const clip = next.tracks?.flatMap(track => track.clips ?? []).find(c => c.id === clipId);
  if (!clip) throw new Error(`Unknown clip: ${clipId}`);
  if (Array.isArray(clip.preOverlays) && clip.preOverlays.length > 0) {
    const preIdx = targetNodeId
      ? clip.preOverlays.findIndex(e => e.id === targetNodeId)
      : !clip.nodeId
        ? clip.preOverlays.length - 1
        : -1;
    if (preIdx >= 0) {
      const [removed] = clip.preOverlays.splice(preIdx, 1);
      if (clip.preOverlays.length === 0) delete clip.preOverlays;
      return { project: next, nodeId: removed.id, nextNodeId: clip.nodeId ?? null, removed: true };
    }
  }
  const nodeId = clip.nodeId;
  if (!nodeId) throw new Error('This segment has no media effect card attached');
  const node = (next.cardNodes || []).find(n => n.id === nodeId);
  if (!node) {
    // Dangling (node was deleted elsewhere): just clear the pointer, no need to block the user
    delete clip.nodeId;
    return { project: next, nodeId, nextNodeId: null, removed: false };
  }

  const inputs = node.inputs || {};
  const names = Object.keys(inputs);
  if (!names.length) throw new Error('This card has no inputs; it is the content of this segment itself, not an overlay. To remove it, delete the segment');
  if (!inputs.source) throw new Error(`This card has more than one input (${names.join(', ')}); detaching it would tear down this composite. Edit it in the node graph in the editing section`);

  const upstream = typeof inputs.source === 'string' ? inputs.source : inputs.source.nodeId;
  const upstreamNode = (next.cardNodes || []).find(n => n.id === upstream);

  // Downstream: connect this clip to upstream. When upstream is a synthetic id like
  // `@clip/<id>/source`, there is no node to connect to, and the clip reverts to a normal media clip /
  // normal card clip
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
    // Media clip: reverts back to unattached state along with cardId and params. A card clip's base is a
    // real node, so it never reaches here
    if (clip.mediaId) { delete clip.cardId; clip.params = {}; }
  }

  // Retain if still referenced by others (it is still feeding others); delete from the store only
  // when unreferenced
  const stillUsed = (next.cardNodes || []).some(n => n.id !== nodeId
    && Object.values(n.inputs || {}).some(ref => (typeof ref === 'string' ? ref : ref?.nodeId) === nodeId))
    || next.tracks?.some(track => track.clips?.some(c => c.nodeId === nodeId));
  if (!stillUsed) next.cardNodes = (next.cardNodes || []).filter(n => n.id !== nodeId);

  // Like applyCardDefinition, traverse the graph before committing: throw immediately if broken,
  // leaving no unrenderable project
  projectCardGraph(next, getCard);
  return { project: next, nodeId, nextNodeId: clip.nodeId ?? null, removed: !stillUsed };
}

/** Clone a clip-owned media effect card instance while deliberately sharing definitions.
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
