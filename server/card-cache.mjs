import fs from 'node:fs/promises';
import path from 'node:path';
import { cardNodeIdentities, cardSampling, cardCacheIdentity, cardSnapshotIdentity, cardSnapshotInputKeys } from './card-identity.mjs';
import { cardCostKey } from '../src/render/cardCostKey.mjs';
import { snapshotCode } from './frame-code.mjs';
import { snapshotTier } from './snapshot-store.mjs';
import { MovFrameStore } from './frame-mov.mjs';
import { findFfmpeg } from './bakery/index.mjs';
import { resultKeyOf } from './render-node/fingerprint.mjs';
import { isFlatClipId } from '../src/kernel/cutFlatten.mjs';

const exists = file => fs.access(file).then(() => true, () => false);

/**
 * Durable cache for cards which have explicitly declared independent
 * compositing.  Each value is a full-stage transparent PNG; placement belongs
 * to the browser compositor, so a cached image is never transformed again.
 *
 * The public shape deliberately contains URLs only.  The browser receives it
 * through project._cardRender and is the sole component allowed to composite
 * it with the live scene.
 */
export class CardFrameCache {
  /** `capture`/`scale` describe the renderer that writes samples. A sample is
   * served only when it was captured by the current capture code for this
   * card key, and an empty sample only after a second render confirmed it.
   *
   * `envFingerprint`(M4,契约 E.3):写这些样本的 Chrome 的环境指纹,字符串或返回字符串的函数
   * (`FramePipeline` 传函数:指纹要等第一个预渲染间开起来、探测过才定)。`plan()` 产出的
   * 键(PNG 缓存键 `key`、共享快照键 `snapshotKey`)都乘上它 —— 不同环境渲出的像素有确定的
   * 差异,不能互相替用(设计 2.1)。 */
  constructor({ root, project, capture = () => undefined, scale = () => 1, envFingerprint }) {
    this.root = root; this.project = project; this.fps = Number(project.fps) || 30;
    this.capture = capture; this.scale = scale;
    this.envFingerprint = envFingerprint;
    this.stores = new Map(); this.meta = new Map();
  }
  expected(key) { return { capture: this.capture() || undefined, cards: key }; }
  async store(key) {
    if (!this.stores.has(key)) {
      const store = new MovFrameStore({ dir: path.join(this.root, 'controls', key), fps: this.fps });
      this.stores.set(key, store); await store.ready;
    }
    return this.stores.get(key);
  }
  /** Accept both the compact browser plan and graph.outputs.  Unknown and
   * context cards are intentionally excluded: they must be rendered in their
   * complete Chrome context. */
  plan(value) {
    // 指纹在开头解析一次,这一趟的所有键用同一个值。没有指纹就抛、不产任何键:不带指纹的键
    // 等于把画面写到「哪种环境都认」的位置,正是 M4 要消灭的混用。现有调用点都包在 try 里,
    // 抛出按「没有 plan」处理。
    const fp = typeof this.envFingerprint === 'function' ? this.envFingerprint() : this.envFingerprint;
    if (typeof fp !== 'string' || !fp) throw new Error('CardFrameCache.plan():还没有环境指纹,不产预渲染键');
    const graph = value?.graph || value;
    if (!graph?.nodes || !graph?.outputs) return [];
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const definitions = new Map((graph.definitions || []).map(definition => [definition.id, definition]));
    const identities = cardNodeIdentities(graph, { style: this.project.style || {}, environment: value?.environment || {}, sourceVersions: value?.sourceVersions || {} });
    // 每个节点的上游在共享快照键里的那一栏(上游的身份不带片段的 id);没有上游的节点是 {}
    const upstreamKeys = cardSnapshotInputKeys(graph, { style: this.project.style || {}, environment: value?.environment || {}, sourceVersions: value?.sourceVersions || {} });
    /*
     * 未知卡片(预渲染间的注册表里查不到定义的卡片段,`__pcCardPlan` 的 `unknownClipIds`):舞台不画它们,不出控件 ——
     * 不排预渲染、不进预渲染集合(否则按「没有定义」的缺省能力 stateful / 要预渲染判重)、层表里也没有它们那一层。
     * 只跳过这些输出;图与节点身份照上面算,别的卡的键逐字不变(未知卡当别的卡的输入时也一样)。
     */
    const unknownClips = new Set(Array.isArray(value?.unknownClipIds) ? value.unknownClipIds : []);
    const controls = [];
    for (const output of graph.outputs) {
      if (output?.clipId && unknownClips.has(output.clipId)) continue;
      const node = nodes.get(output.nodeId);
      const definition = definitions.get(node?.definitionId);
      const caps = output.capabilities || node?.capabilities || node?.definition?.capabilities || definition || {};
      const compositing = caps.compositing || node?.compositing || 'unknown';
      // A Chrome implementation has to opt in.  We retain non-independent
      // records too, because required context/unknown cards need explicit
      // foreground missing state and a full-scene required producer.
      // A3a / C2 备注(第 4 步再放行):转场卡(`sourceDependent`)的快照也是内容寻址
      // 的、也该进共享档,但**这里**不能提前放行。`cacheable` 不只是「能不能存」,
      // 它同时决定两件今天就生效的事:(1) `fillCardControls` 会把这张卡丢进
      // `isolatedCardProject` 单独渲染;(2) `renderState` 会把渲出来的东西当成正确
      // 结果发给前台。而隔离工程今天只平移目标片段、不带依赖链上的源片段(A3a 说
      // 的 `graph` 参数和 `−phase − target.start` 位移量是第 4 步),转场卡在里面
      // 会拿到空输入 —— 现在放行等于把空画面当成死素材存下来并发出去。
      // 所以档位判定(`snapshotTier`)认 `sourceDependent`,`cacheable` 不认;
      // 第 4 步接上隔离工程的依赖链之后,把这里改成
      // `compositing === 'independent' || compositing === 'sourceDependent'`。
      // 剪辑段里摊出来的卡(虚拟片段,`src/kernel/cutFlatten.mjs`):只产单卡轨道流(`soloStreamKind` 的 'flat'),不走这里的整帧 PNG 那一支 ——
      // 那一支的隔离单卡工程按片段 id 在真实项目里找卡,虚拟片段不在那里
      const cacheable = compositing === 'independent' && !isFlatClipId(output.clipId);
      const start = Number(output.start ?? node?.start ?? 0), end = Number(output.end ?? node?.end ?? start);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const sampling = cardSampling(start, this.fps);
      const phase = Number(sampling.phase.numerator) / Number(sampling.phase.denominator);
      // Samples are t = first/fps + local/fps, strictly before clip.end.
      // `phase` is seconds, hence it must be subtracted before multiplying by
      // fps (the old expression mixed seconds and frames).
      const count = Math.max(1, Math.ceil((end - start - phase) * this.fps - 1e-9));
      const nodeKey = identities.get(output.nodeId);
      if (!nodeKey) continue;
      // Output appearance belongs in the key: clipping frame, opacity/fades
      // and motion change pixels even if the underlying node stays identical.
      const appearance = { frame: output.frame, opacity: output.opacity, fadeIn: output.fadeIn, fadeOut: output.fadeOut, motion: output.motion,
        width: this.project.width, height: this.project.height };
      // M4:内容键(只认内容,`card-identity.mjs` 的算法不变)和结果键(内容键 × 环境指纹)分开留。
      // 落盘、路由、就绪索引用结果键;轨道流的成员键和细任务切分用内容键 —— 同一个项目在两种
      // 环境下内容键相同、结果键不同(契约 E.3～E.5)。
      const cacheContentKey = cardCacheIdentity(nodeKey, sampling, end - start, JSON.stringify(appearance));
      const key = resultKeyOf(cacheContentKey, fp);
      // A3a 的共享快照键:和 `key`(CardFrameCache 的 PNG 键,带位置画幅和 clipId)
      // 是两回事 —— 这个剥掉片段身份、不含外观,同一张卡两个片段共用一份快照。
      // 输出节点没有上游的(普通卡)`inputKeys` 是 {},键和原来逐字相同;有上游的(片段挂了强调、滤镜、声音效果时输出节点是
      // 外面那一层,卡片在它的输入后面;素材效果卡的素材在它的输入后面)带上上游的身份 —— 不带的话外面相同、里面不同的两个
      // 片段同键,互相取到对方的快照和流。
      const inputKeys = upstreamKeys.get(output.nodeId) ?? {};
      const contentKey = cardSnapshotIdentity(node ?? {}, {
        definition, style: this.project.style || {}, environment: value?.environment || {},
        sourceVersions: value?.sourceVersions || {}, inputKeys,
        fps: this.fps, sampling, duration: end - start,
        stage: { width: this.project.width, height: this.project.height, camera3dFov: this.project.camera3dFov },
        frame: output.frame, themeId: this.project.themeId,
        fontFingerprint: value?.environment?.fontFingerprint || '', snapshotCode: snapshotCode(),
      });
      const snapshotKey = resultKeyOf(contentKey, fp);
      // 单卡轨道流的成员键(`planStreams` 用):同一份内容身份,只是不带生成快照的代码指纹 ——
      // 流的像素是截图或画布直取来的,和快照 HTML 怎么生成无关;带着它,改一次生成快照的代码所有单卡流都跟着作废
      // (`docs/plan/prerender-products-contract.md` 第 9.3 节)。流自己的代码指纹在 `planStreams` 的 `codeVersion` 里
      const streamMemberKey = cardSnapshotIdentity(node ?? {}, {
        definition, style: this.project.style || {}, environment: value?.environment || {},
        sourceVersions: value?.sourceVersions || {}, inputKeys,
        fps: this.fps, sampling, duration: end - start,
        stage: { width: this.project.width, height: this.project.height, camera3dFov: this.project.camera3dFov },
        frame: output.frame, themeId: this.project.themeId,
        fontFingerprint: value?.environment?.fontFingerprint || '', snapshotCode: '',
      });
      /*
       * K1 / K2 的成本键(R5)。**必须在这里算** —— `cardCostKey` 要的是 graph 的**节点**
       * 和它的源码版本,两样都只在这一层拿得到(`adoptCardPlan` 收到的只是 controls)。
       * 口径逐字对齐页面侧的 `clipCostIndex`(`src/render/pipelinePlan.mjs`):
       * 同一份输入两端算出同一个键,`planPipelines` 才会得出同一张表(K2 末条)。
       */
      const costKey = cardCostKey(node ?? {}, (value?.sourceVersions || {})[node?.cardId] ?? null,
        this.fps, Math.max(1, Math.round((end - start) * this.fps)));
      // `costKey` 不乘指纹:成本记录另有设备口径(`device` 字段),键只认卡和源码版本
      controls.push({ key, snapshotKey, contentKey, streamMemberKey, cacheContentKey, envFingerprint: fp, costKey, frameMode: caps.frameMode, tier: snapshotTier(caps), capabilities: caps,
        clipId: output.clipId || node?.clipId, nodeId: output.nodeId, start, end, count, sampling, compositing, cacheable,
        needPrerendering: caps.need_prerendering === true || caps.needPrerendering === true || node?.need_prerendering === true || node?.needPrerendering === true, appearance });
    }
    return controls;
  }
  async renderState(plan, frames, { urlFor = (key, n) => `/api/frames/control/${encodeURIComponent(key)}/${n}` } = {}) {
    const values = {}, missing = {};
    for (const control of plan) {
      if (!control.cacheable) {
        if (control.needPrerendering) for (const globalFrame of frames) {
          if (globalFrame >= control.sampling.firstFrame && globalFrame / this.fps < control.end - 1e-9) (missing[globalFrame] ||= []).push(control.clipId);
        }
        continue;
      }
      const store = await this.store(control.key);
      for (const globalFrame of frames) {
        const local = globalFrame - control.sampling.firstFrame;
        if (local < 0 || local >= control.count || globalFrame / this.fps >= control.end - 1e-9) continue;
        if (await store.lookup(local, this.expected(control.key))) {
          (values[control.clipId] ||= {})[globalFrame] = urlFor(control.key, local);
        } else if (control.needPrerendering) (missing[globalFrame] ||= []).push(control.clipId);
      }
    }
    return { mode: 'interactive', frames: values, missing };
  }
  async put(key, localFrame, png, guard = () => true) {
    if (!guard()) return false;
    const store = await this.store(key);
    if (!guard()) return false;
    await store.put(localFrame, png, { capture: this.capture() || undefined, scale: this.scale(), cards: key });
    return true;
  }
  async hasComplete(control) {
    const store = await this.store(control.key);
    const expected = this.expected(control.key);
    await store.hydrate(Array.from({ length: control.count }, (_, n) => n));
    for (let n = 0; n < control.count; n++) if (!store.valid(n, expected)) return false;
    return true;
  }
  async finish(control) {
    if (!await this.hasComplete(control)) return false;
    const store = await this.store(control.key);
    // streamPngVideo (used by MovFrameStore) is ProRes 4444 with alpha.  Start
    // only after every local sample exists so a sparse interactive request can
    // never publish a truncated control movie.
    await store.start(await findFfmpeg());
    await store.finish();
    return true;
  }
  async close() { await Promise.all([...this.stores.values()].map(store => store.close())); }
}

export const cardControlPngPath = (root, key, frame) => path.join(root, 'controls', key, 'mov', 'frames', String(frame).padStart(6, '0') + '.png');
