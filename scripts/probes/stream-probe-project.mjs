/**
 * R8 轨道流两支探针(`stream-produce-probe.mjs` / `stream-play-probe.mjs`)共用的项目和生产步骤。
 *
 * 三张重卡(都是审阅表里 `independent` 的 stateful 卡,没有成本记录时按声明进预渲染集合):
 *   - 粒子背景铺满全屏(最底层),0～5 秒 —— 10 个分段,「连续生产 10 个分段只付一次换页」那一条靠它;
 *   - 金句药丸,框 640×360 摆在画面中间,和粒子重叠 —— 隔离那一条靠它(药丸是主题蓝的实心胶囊,
 *     绿色粒子流里不该有蓝色);它的框比画面小,收紧矩形那一条也靠它;
 *   - 实体名牌(`entity-chips`,框 800×450),0.5～2 秒 —— 入点不在分段边界上;
 *     (原来放的是通用 Lottie 卡;Lottie 改成 remotion 式〔`frameMode: "direct"`〕以后按声明是轻卡,没有成本记录时不进预渲染集合,
 *     所以换成现在仍声明 `stateful`、审阅表里 `independent` 的 `entity-chips`)
 *   - 里程表(毛玻璃 HUD,`belowDependent`)压在粒子背景左下角,0～5 秒 —— 「毛玻璃卡叠在流
 *     `<canvas>` 上时模糊正确」那一条靠它:播放时它照常活渲,模糊的是下面那块流画布。
 *     **这两支探针里它不进流**:依赖下层的卡判重时现在有自己的流(`kind: below`),而这里要的正是「它活渲着、压在别的卡的流上」
 *     (产品里它判轻时就是这样),所以下面把这种流关掉(`PROMPTCUT_TEST_BELOW_STREAMS=0`,只影响引入本文件的探针进程)。
 *     这种流自己的产与贴在 `stream-below-probe.mjs`、`stream-below-stage-probe.mjs` 里验。
 *
 * **没有用两张粒子卡**:同一时刻挂两张粒子卡时,后挂的那张 `tsParticles.load` 会把先挂的那张的容器
 * 当成同一个 id 销毁掉(容器 id 取自引擎的共享随机数;实测后挂那张一挂上,前一张的 `<canvas>` 就被
 * `CanvasManager.destroy` 摘掉)—— 这是 `particles.tsx` 既有的问题,导出里也一样,和轨道流无关,见报告。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import { FramePipeline } from '../../server/frame-pipeline.mjs';

// 见文件头:这两支探针里毛玻璃卡不进流(活渲着压在流上)
process.env.PROMPTCUT_TEST_BELOW_STREAMS = '0';

export const PROJECT = {
  id: 'r8-stream-probe', name: 'R8 轨道流探针', width: 1920, height: 1080, fps: 30, duration: 5,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-glass', name: 'glass', hidden: false, clips: [
      { id: 'clip-glass', kind: 'card', cardId: 'odometer', start: 0, end: 5, params: {}, frame: { x: 80, y: 600, w: 760, h: 420 } },
    ] },
    { id: 'tr-pill', name: 'pill', hidden: false, clips: [
      { id: 'clip-pill', kind: 'card', cardId: 'punch-pill', start: 0, end: 2, params: { text: '轨道流' }, frame: { x: 960, y: 540, w: 640, h: 360, anchor: [0.5, 0.5] } },
    ] },
    { id: 'tr-red', name: 'chips', hidden: false, clips: [
      { id: 'clip-red', kind: 'card', cardId: 'entity-chips', start: 0.5, end: 2, params: {}, frame: { x: 300, y: 200, w: 800, h: 450 } },
    ] },
    { id: 'tr-bg', name: 'bg', hidden: false, clips: [
      { id: 'clip-bg', kind: 'card', cardId: 'particles', start: 0, end: 5, params: { color: '#30ff60', quantity: 120, speed: 1.5, size: 4, links: 'yes', seed: 3 } },
    ] },
  ],
};

export async function until(fails, label, fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await new Promise(r => setTimeout(r, everyMs));
  }
}

/**
 * 在本进程里起一个 `FramePipeline`(和预渲染进程同一份代码),灌项目,等全部流满密度。
 * 回 `{ pipeline, producer, layers, produceMs }`;`layers` 是就绪索引发出来的 `kind: 'stream'` 层。
 */
export async function produceStreams({ origin, root, project = PROJECT, fails }) {
  const pipeline = new FramePipeline({ root, origin: () => origin, interactive: true, playhead: () => null });
  // 分段字节由探针自己的 http 服务发(`handleStreamRequest`),等于读口已经接上
  pipeline.streamProducer().attachRoute();
  const layers = [];
  pipeline.readyIndex.subscribe(message => { if (message.type === 'layer' && message.kind === 'stream') layers.push(message); });
  const started = Date.now();
  await pipeline.preload(project);
  const producer = await until(fails, '生产者起来', () => pipeline._streams?.streams.size ? pipeline._streams : null, 120000);
  if (!producer) return { pipeline, producer: null, layers, produceMs: Date.now() - started };
  const done = await until(fails, '全部分段满密度', () => {
    const status = producer.status();
    if (!status.streams.length) return null;
    for (const s of status.streams) {
      for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
    }
    return !producer.workers.size && !producer.encoding.size ? status : null;
  }, 600000, 1000);
  return { pipeline, producer: done ? producer : null, layers, produceMs: Date.now() - started };
}

/** 就绪索引里每个 clipId 最后一条 `stream` 层 */
export function latestLayers(layers) {
  const byClip = new Map();
  for (const m of layers) byClip.set(m.clipId, m);
  return [...byClip.values()];
}
