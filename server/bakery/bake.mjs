/**
 * 在一个已经开着的 bakery 上逐帧预渲染。
 *
 * 从 scripts/export-frames.mjs 拆出来(纯重构,逐字搬运);预渲染间本身在 ./chrome.mjs。
 */

import path from 'path';
import fs from 'fs/promises';
import { captureSnapshot } from './capture-snapshot.mjs';
import { captureFrame, forgetCaptureClip, applyCaptureClip } from './capture-frame.mjs';
import { framesInWindow } from '../../src/render/frameWindow.mjs';
import { waitFrameReady } from './frame-ready.mjs';
import { prepareFrameMedia } from './frame-media.mjs';

/**
 * 推帧补画:推过去、不取图的那一帧也真的画一拍,把图丢掉。
 *
 * 为什么(2026-10-14 在导出页上量出来的,`scripts/probes/push-draw-probe.mjs` 能复跑):
 *   - 不带截图的 `beginFrame` 不保证渲染器会跑这一拍的主线程帧。页面上已经有东西画过以后,连着两三拍不带截图,
 *     `requestAnimationFrame` 就一次都不再触发,直到下一次带截图的那一拍(逐步数过原始 rAF:挂上一张卡以后
 *     1 1 1 0 0 0 … 一直是 0;每步后面跟一张丢掉的截图就恢复成每拍都跑)。
 *   - Motion 建动画要等挂载之后的下一次 rAF。所以这种时候挂载的 motion 式卡,动画到下一次真的画帧才建出来:
 *     JS 驱动的那些从那一刻起算(Motion 规定建晚了 40 ms 以上就不追溯),交给 WAAPI 的那些被 `__pcSyncAnims`
 *     锚在更晚的一帧。之后一直落后那么多帧,没有任何检查拦得住。
 *   - 中招的条件不是「上面压着别的层」,是「这张卡挂载的那一拍没有 rAF」:页面上先有一张更早挂载的卡(在上面、
 *     在下面、不重叠都一样),再推过一张中途进场的卡。只导一段(`--frames a-b`)、抽帧(`targetFrames`)、
 *     流的回放段和稀疏那一趟(一页上不止一张卡时)都是这样推的。整段导出每帧都截图,不受影响。
 *
 * 量到的规律(同一支探针的记录):带截图的一拍之后,渲染器还能再跑两三次「画面有变化」的主线程帧,之后就停住等下一次带截图的
 * 一拍;画面没有变化的拍不占这个余量。整段导出每帧一张截图,永远在余量里。
 *
 * 做法:推过去的帧在 `step` 之后补一拍带截图的 `beginFrame`(最便宜的 JPEG,立刻丢掉),和「这一帧取了图」时多出来的那一拍
 * 一样。于是页面经历的拍子与整段导出相同,取图的那几帧和整段导出里的同一帧逐像素一致。
 *   - **这一帧画面没有变化就不补**(`pushDrawNeeded`):`step` 判了静止(没有在跑的动画、DOM 没动、没有新的 rAF 请求、
 *     没有可见的 canvas 和视频,见 `ExportView` 的 `__pcStaticProbe`),这一拍也没有报告画面有变化(`hasDamage`),而且这一趟里
 *     前面已经画过一拍。真的画一帧不便宜(1920×1080 的重场景每帧几十毫秒,和取一张图差不多),静止的那些帧不用付。
 *     实际上页面上挂着卡的帧几乎都判「在变」(卡挂着时每帧至少有一处 DOM 改动),省下来的主要是没有卡的那些帧;
 *   - 每帧都取图的那些路(整段导出、接着租约产的满密度分段)一拍都不多走,逐字节不变;
 *   - 预热(`warmUpAt`)不动;预热留下没画的东西由这一趟的第一帧收掉(第一帧一定画,而且和取图的第一帧一样画两拍);
 *   - 素材不在补画的帧上加载(`prepareFrameMedia` 只在真取图的帧前面);丢掉的图不交给 `onFrame`、不写盘、不进编码器。
 *
 * 并行导出的分片不补(`export-unified.mjs`、`shards.mjs` 给它们传 `pushDraw: false`):分片只在「没有有状态的卡跨着」的帧上切
 * (`src/render/shardPlan.mjs`),切点前面推过去的卡到切点都已经卸掉,不补也对(探针的 shards 一项核对);补的话每个分片要把
 * 前面的帧真的再画一遍,三片比单进程还慢(量过,见报告)。
 *
 * `PROMPTCUT_PUSH_DRAW=0`(或 `opts.pushDraw === false`)关掉,只给探针对照「修之前」用,产品里不设。
 */
export const PUSH_DRAW_SHOT = Object.freeze({ format: 'jpeg', quality: 0 });
export function pushDrawEnabled(opts = {}, env = process.env) {
  if (typeof opts?.pushDraw === 'boolean') return opts.pushDraw;
  return String(env?.PROMPTCUT_PUSH_DRAW ?? '1').trim() !== '0';
}
/**
 * 推过去的这一帧要不要补画(见文件头)。`isStatic`:`step` 的返回值;`damaged`:这一帧的拍子里有没有哪一拍报告了画面有变化
 * (`step.last.damaged`);`drawnBefore`:这一趟(或这份租约)里前面画过没有 —— 没画过的第一帧一定画;
 * `previousDrawn`:紧挨着的上一帧画过没有。
 *
 * 报告的变化只在上一帧没画过时才算:带截图的一拍之后,下一拍不带截图的总会报告一次变化(量到的,空页面上也是),那是上一拍的回声。
 * 它是给 `__pcStaticProbe` 看不见的变化(会动的图片之类)兜底的:这样的页面每隔一帧补一拍,渲染器的余量用不完。
 */
export function pushDrawNeeded({ isStatic, damaged, drawnBefore, previousDrawn }) {
  return !drawnBefore || !isStatic || (!!damaged && !previousDrawn);
}
/**
 * 画一拍丢掉。`prime`:先多画一拍 —— 只在这一趟的第一帧用(取图的第一帧就是画两拍,见 `captureFrame` 的 `prime`)。
 * 和 `captureFrame` 一样,这一拍没交回画面就在同一个时间点再发,最多四拍;交不回来不报错(这张图本来就不要)。
 * 回一共发了几拍。
 */
export async function drawDiscarded(bakery, prime, signal) {
  const cancelled = () => Object.assign(new Error('已取消'), { cancelled: true });
  let ticks = 0;
  if (prime) {
    if (signal?.aborted) throw cancelled();
    await bakery.beginFrame({ screenshot: PUSH_DRAW_SHOT });
    ticks++;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw cancelled();
    const result = await bakery.beginFrame({ screenshot: PUSH_DRAW_SHOT });
    ticks++;
    if (result?.screenshotData) break;
  }
  return ticks;
}

/**
 * 在一个已经开着的 bakery 上渲一段帧。返回给 ffmpeg 用的那些参数。
 *
 * opts:
 *   format/quality —— 'png' 带 alpha(导出交付物要),'jpeg' 不带(预览用的预渲染够用)。
 *                     PNG 走 optimizeForSpeed:仍然无损(实测逐字节解码后与普通 PNG 相同),只是压得快、文件大一倍。
 *   staticSkip     —— 画面静止的帧直接复用上一张,连截都不截。判据见 ExportView 的 __pcStaticProbe
 *   verifyEvery    —— 连续复用多少帧就强制真截一张比对一次
 *   targetFrames   —— 只截这几帧; fullFrame 时只回推目标所需卡片的历史
 *   seekFromActiveClips —— false 保留从 0 推进的参考路径,用于逐像素回归比对
 *   glassFrames    —— Set<帧号>:这些帧底下有素材,截完卡片再截一张毛玻璃遮罩(PAGE_PRELUDE 的 __bfGlassOn)
 *                     到 <out>/glass/%06d.png。没有玻璃的帧不写文件;返回值的 glass 里有写了几张、玻璃的模糊量
 */
export async function bakeFrames(bakery, opts = {}) {
  const { page, client, beginFrame, waitNet } = bakery;
  const outDir = opts.out || 'out';
  const warmFrames = opts.warm ?? 3;
  const format = opts.format === 'jpeg' ? 'jpeg' : 'png';
  const quality = opts.quality ?? 80;
  const wantStaticSkip = opts.staticSkip ?? false;
  const verifyEvery = opts.verifyEvery ?? 10;
  const ext = format === 'jpeg' ? 'jpg' : 'png';

  const framesDir = path.join(outDir, 'frames');
  // PC_EXPORT_TRACE=1 时每帧记录页面时钟和全部动画状态到 <out>/trace.json,排查确定性问题用
  const trace = process.env.PC_EXPORT_TRACE ? [] : null;
  await fs.mkdir(framesDir, { recursive: true });

  const timeline = await page.evaluate(() => window.__pcTimeline);
  if (!timeline) throw new Error('Timeline not found');

  const width = timeline.width || 1920;
  const height = timeline.height || 1080;
  const fps = opts.fps || timeline.fps || 30;
  let startFrame = 0;
  let endFrame = Math.floor((timeline.duration || 20) * fps) - 1;
  if (opts.frames) {
    const [a, b] = opts.frames.split('-').map(Number);
    startFrame = a;
    endFrame = b;
  }
  /*
   * 只截这几帧(离散取样)。完整画面从目标所需卡片的最早历史帧顺推;HTML 采样仍覆盖全部历史。
   * 保留卡片的原始挂载时刻,不跳过区间内的帧,避免按 delta 积分的动画走样。一趟推进沿途截图。
   * 静态跳过在这种模式下必须关死:lastBuf 可能是几十帧之前的,直接复用就是把时间轴压扁。
   */
  const targetFrames = Array.isArray(opts.targetFrames) && opts.targetFrames.length
    ? new Set(opts.targetFrames.map((n) => Math.max(0, Math.round(Number(n)))))
    : null;
  if (targetFrames) {
    startFrame = Math.min(...targetFrames);
    endFrame = Math.max(...targetFrames);
  }
  const staticSkip = targetFrames ? false : wantStaticSkip;
  const frameWindow = opts.fullFrame && targetFrames && opts.seekFromActiveClips !== false && !opts.snapshotOnly && !opts.domCache
    ? await page.evaluate(({ frames, fps }) => {
      if (!window.__pcPlanFrameWindow) throw new Error('Frame window planner is unavailable');
      return window.__pcPlanFrameWindow(frames, fps);
    }, { frames: [...targetFrames], fps }) : null;
  const advanceStartFrame = frameWindow?.startFrame ?? 0;
  const renderRanges = frameWindow?.ranges ?? [[advanceStartFrame, endFrame]];
  const sortedTargets = targetFrames ? [...targetFrames].sort((a, b) => a - b) : [];
  const directFrameAt = frame => frameWindow ? (sortedTargets.find(n => n >= frame) ?? frame) : frame;
  // Mount after planning, including the full-history / HTML paths. This also
  // clears the selection when a bakery is reused for a different kind of pass.
  await page.evaluate(({ clipIds, time, directTime }) => {
    if (!window.__pcSetFrameWindow) throw new Error('Frame window API is unavailable');
    window.__pcSetFrameWindow(clipIds, time, directTime);
  }, { clipIds: frameWindow?.clipIds ?? null, time: advanceStartFrame / fps, directTime: directFrameAt(advanceStartFrame) / fps });
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  // 透明底一次性打开,不用 puppeteer 的 omitBackground(那个每截一张开关一次,开关本身会触发重绘)
  if (format !== 'jpeg') {
    await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  }
  const shotParams = format === 'jpeg'
    ? { format: 'jpeg', quality }
    : { format: 'png', optimizeForSpeed: true };

  /*
   * 生成快照前把 Motion 的 JS 帧循环推一拍。
   *
   * 卡片上有两种动画,定住的办法不一样:
   *   - 交给 WAAPI 的那些(opacity、tween 的 transform)由 __pcSyncAnims 每帧显式钉 currentTime,
   *     getComputedStyle 立刻反映,快照拿到的就是对的;
   *   - Motion 自己的 JS 帧循环驱动的那些(spring、MotionValue)只在批处理跑一拍时才把新值
   *     写进 inline style,没有任何东西钉它。
   * 而这一拍**只有真正画一帧才会跑**:实测不带截图的 beginFrame(包括 noDisplayUpdates、
   * 先制造 DOM damage 再发)一律推不动 Motion 的 frameData.timestamp,带 screenshot 的能。
   * 于是整帧路每帧截图、DOM 总是当前帧的;HTML 快照在截图之前生成,拿到的是上一次画帧时
   * 写下的旧值 —— 纯采样的 snapshotOnly 一趟里一张图都不截,整段冻在第一帧的相位上
   * (punch-pill 的弹簧:第 1 帧之后永远是 scale(0.933311),而导出是正确的 1.0678 → 1.0037 → …)。
   *
   * 所以生成快照之前先画一拍、把图丢掉。只加在快照这一侧:整帧导出不生成快照,
   * 一步也不多走,逐字节基线不受影响。图要最便宜的(jpeg quality 0),反正立刻扔掉。
   *
   * `prime`:上一个时间点没画过(没截图、也没推过这一拍)时要**画两拍**。只画一拍,
   * Motion 的值还停在上一次画帧时的相位 —— 实测 punch-pill 只取第 8 帧(前面 0～7 帧只推时间、
   * 不截图),推一拍后快照里药丸仍是第 1 帧的 `scale(0.933311)`,活渲已经是 `none`。
   * 和 `captureFrame` 的 `prime` 是同一件事、同一个判据:紧挨着的上一帧画过才能省。
   */
  const FLUSH_SHOT = { format: 'jpeg', quality: 0 };
  const flushFrameLoop = async (prime) => {
    if (prime) await beginFrame({ screenshot: FLUSH_SHOT });
    await beginFrame({ screenshot: FLUSH_SHOT });
  };

  /** 截一张:发一拍并要这一拍的截图。此刻动画已钉住、页面时钟已量化,这一拍里画面不会再变
   *  prime:上一个时间点没截过图时先截一张丢掉,见 captureFrame。primeCapture:false 只给回归对照用 */
  const shoot = async (prime = true) => {
    const captureOpts = { prime: prime && opts.primeCapture !== false };
    // MOV/full-scene cache: keep the live scene (including video/image media)
    // visible. HTML snapshots deliberately remove video sources, so they can
    // never be used as the full-frame movie source.
    if (opts.fullFrame) {
      await prepareFrameMedia(bakery);
      return captureFrame(bakery, shotParams, opts.signal, captureOpts);
    }
    if (!opts.glassFrames) {
      // Pixel maps rasterize a hidden source video into a canvas. Load only the
      // requested frame before creating the HTML snapshot; otherwise __pcCreateSnapshot would copy
      // an empty canvas into the snapshot and every cache replay would stay blank.
      const hasPixelMap = await page.evaluate(() => !!document.querySelector("canvas[data-pc-pixel-map]"));
      if (hasPixelMap) {
        await prepareFrameMedia(bakery);
        await beginFrame();
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      // prime 只按「上一帧截没截过图」判,不知道 renderPass 这一帧是不是已经推过 —— 宁可多画一拍(幂等)
      await flushFrameLoop(prime);
      const snapshot = await page.evaluate(() => window.__pcCreateSnapshot());
      if (snapshot.lossy) throw new Error(`Cannot snapshot ${snapshot.lossy} canvas elements`);
      return captureSnapshot(bakery, snapshot.html, shotParams);
    }
    await prepareFrameMedia(bakery);
    return captureFrame(bakery, shotParams, opts.signal, captureOpts);
  };

  // 一帧怎么推由 createStepper 给(和 bakeStream 共用同一份);截不截图由调用方决定
  const step = createStepper(bakery, { fps, directFrameAt, signal: opts.signal, trace });

  // 预热停在本次推帧起点;`frameWindow` 留在这个闭包里,由这里传给 warmUpAt
  const warmUp = () => warmUpAt(bakery, step, { startFrame: advanceStartFrame, warmFrames, frameWindow, signal: opts.signal });

  const totalFrames = targetFrames ? targetFrames.size : endFrame - startFrame + 1;
  const durationSec = (totalFrames / fps).toFixed(3);
  let reused = 0;
  // 推帧补画:开没开,以及这一趟为推过去的帧一共多发了几拍(只为诊断和单测)
  const pushDraw = pushDrawEnabled(opts);
  let pushDrawn = 0;

  /*
   * HTML 采样缓存(opts.domCache):每截完一帧顺手把舞台生成 HTML 快照,gzip 后写到 <out>/dom/%06d.html.gz。
   * 之后要重截(换格式、渐进铺开、多进程并行)就走 scripts/replay-frames.mjs,不必再从第 0 帧顺推。
   * 实测生成快照 10~36 ms/帧,gzip 后 8~15 KB/帧。静态跳过复用的帧,快照也复用上一份。
   */
  const domDir = opts.domCache ? path.join(outDir, 'dom') : null;
  const gzip = domDir ? (await import('node:zlib')).gzipSync : null;
  if (domDir) await fs.mkdir(domDir, { recursive: true });
  let domLossy = 0;

  const glassFrames = opts.glassFrames instanceof Set && opts.glassFrames.size ? opts.glassFrames : null;
  const glassDir = glassFrames ? path.join(outDir, 'glass') : null;
  if (glassDir) await fs.mkdir(glassDir, { recursive: true });
  const glass = { dir: glassDir, list: [], blurs: new Set() };
  /** 这一帧的毛玻璃遮罩;没有可见的玻璃返回 null。多出来的这一拍时间戳照旧钉着,rAF 循环空转(见 exportClock.ts) */
  const shootGlass = async () => {
    const info = await page.evaluate(() => window.__bfGlassOn());
    if (!info) return null;
    for (const b of info.blurs) glass.blurs.add(b);
    try {
      // 同一时间点刚截过卡片图,画面已是最新,不用再预热
      return await shoot(false);
    } finally {
      await page.evaluate(() => window.__bfGlassOff());
    }
  };

  /** 跑一遍全部帧。allowSkip 为假时每帧老老实实真截。返回判错的帧号;没判错返回 null。 */
  const renderPass = async (allowSkip) => {
    let lastBuf = null;  // 上一张**真截**出来的图
    let lastShotFrame = null; // 上一张真截对应的帧号:紧挨着的上一帧截过图才能省掉预热
    let lastDrawnFrame = null; // 上一次带截图的一拍落在哪一帧(真截和生成快照前推的那一拍都算),见 flushFrameLoop
    let lastDom = null;  // 上一份生成快照的舞台(gzip 过的)
    let runLen = 0;      // 已经连续复用了几帧
    // 上一张真截对应的遮罩:undefined = 还没截过(null = 截了,没有玻璃)。静止帧复用卡片图时遮罩也一起复用
    let lastGlass;
    reused = 0;
    pushDrawn = 0;
    domLossy = 0;
    glass.list = [];
    glass.blurs.clear();
    // Keep disk writes streaming with a small bounded queue.  The old code
    // appended one fs.writeFile Promise per frame; each pending Promise kept
    // its PNG Buffer alive until the whole movie finished, so a long export
    // grew to several gigabytes before ffmpeg even started.
    const writes = [];
    const queueWrite = async (file, data) => {
      writes.push(fs.writeFile(file, data));
      if (writes.length >= 4) await Promise.all(writes.splice(0));
    };
    for (const i of framesInWindow(renderRanges)) {
      /*
       * 取消只在两帧之间生效:这时上一帧的推进、排空、截图都已经做完,页面不在半路上。
       * 调用方(render-worker)据此只换一张新页,不必把整个浏览器当成可疑的重开。
       */
      if (opts.signal?.aborted) throw Object.assign(new Error('已取消'), { cancelled: true });
      const wantShot = targetFrames ? targetFrames.has(i) : i >= startFrame;
      const isStatic = await step(i, wantShot);
      const snapshotWanted = domDir || (opts.onSnapshot && (!opts.snapshotFrames || opts.snapshotFrames.has(i)));
      if (snapshotWanted) {
        await flushFrameLoop(lastDrawnFrame !== i - 1);
        lastDrawnFrame = i;
        const { html, lossy, controls } = await page.evaluate(() => window.__pcCreateSnapshot());
        if (lossy) throw new Error('HTML snapshot contains unreadable canvases');
        if (opts.onSnapshot && snapshotWanted) await opts.onSnapshot(i, html, controls);
        if (domDir) await fs.writeFile(path.join(domDir, String(i).padStart(6, '0') + '.html.gz'), gzip(Buffer.from(html, 'utf8')));
      }
      // Unified export first runs a complete HTML sampling pass (B).  That
      // pass intentionally does not write PNGs, but it still has to report
      // progress; otherwise the UI remains at its initial 0/1 for the whole
      // sampling pass and looks frozen on long projects.
      if (opts.onProgress) opts.onProgress(i, totalFrames, { sampled: true });
      if (!opts.quiet && opts.onProgressLog && ((i - startFrame + 1) % 10 === 0 || i === endFrame)) {
        console.log(`Exported frame ${i} (${i - startFrame + 1}/${totalFrames})`);
      }
      if (!wantShot || opts.snapshotOnly) {
        // 推帧补画(见文件头):这一帧不取图,也没有为生成快照画过,画面又有变化,就画一拍丢掉。当它「截过」记账,下一帧不用再先丢一张
        if (pushDraw && lastDrawnFrame !== i && pushDrawNeeded({ isStatic, damaged: step.last.damaged, drawnBefore: lastDrawnFrame !== null, previousDrawn: lastDrawnFrame === i - 1 })) {
          pushDrawn += await drawDiscarded(bakery, lastDrawnFrame === null, opts.signal);
          lastShotFrame = lastDrawnFrame = i;
        }
        continue;
      }

      let buf;
      let fresh = true;
      if (allowSkip && isStatic && lastBuf) {
        runLen++;
        if (runLen % verifyEvery === 0) {
          // 便宜的保险:连续复用到第 verifyEvery 帧就强制真截一张比一次。对不上就整趟作废重跑
          const real = await shoot(lastShotFrame !== i - 1);
          lastShotFrame = lastDrawnFrame = i;
          if (!real.equals(lastBuf)) { await Promise.all(writes.splice(0)); return i; }
          lastBuf = real;
          buf = real;
        } else {
          buf = lastBuf;
          reused++;
          fresh = false;
        }
      } else {
        runLen = 0;
        buf = await shoot(lastShotFrame !== i - 1);
        lastShotFrame = lastDrawnFrame = i;
        lastBuf = buf;
      }
      const name = String(i).padStart(6, '0');
      // A full export can hand the PNG straight to a local ffmpeg pipe.  The
      // callback is awaited before the next frame, so the screenshot Buffer is
      // released as soon as ffmpeg accepts it and never accumulates in Node.
      if (opts.onFrame) await opts.onFrame(i, buf);
      // 写盘不挡下一帧 (streaming exports may deliberately skip PNG files)
      if (opts.writeFrames !== false) await queueWrite(path.join(framesDir, `${name}.${ext}`), buf);
      if (fresh) lastGlass = undefined;
      if (glassFrames && glassFrames.has(i)) {
        if (lastGlass === undefined) lastGlass = await shootGlass();
        if (lastGlass) {
          glass.list.push(i);
          await queueWrite(path.join(glassDir, `${name}.png`), lastGlass);
        }
      }
      if (!opts.quiet && (process.env.PC_EXPORT_VERBOSE || (i - startFrame + 1) % 10 === 0 || i === endFrame)) {
        console.log(`Exported frame ${i} (${i - startFrame + 1}/${totalFrames})`);
      }
    }
    await Promise.all(writes.splice(0));
    return null;
  };

  const startTime = Date.now();
  let mismatchAt = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      console.warn(`静态跳过在第 ${mismatchAt} 帧判错(复用的和真截的不一致),禁用跳过重跑一遍`);
    }
    await warmUp();
    mismatchAt = await renderPass(staticSkip && attempt === 0);
    if (mismatchAt === null) break;
  }

  if (trace) await fs.writeFile(path.join(outDir, 'trace.json'), JSON.stringify(trace, null, 1));
  if (domDir) {
    // 重放要知道画幅、帧率,以及去哪个导出页拿字体和样式表(去掉 timeline 参数:内容全在快照里)
    const exportUrl = page.url().replace(/([?&])timeline=[^&]*&?/, '$1').replace(/[?&]$/, '');
    await fs.writeFile(path.join(domDir, 'manifest.json'), JSON.stringify({
      width, height, fps, startFrame, endFrame, themeId: timeline.themeId ?? null, exportUrl, lossyCanvases: domLossy,
    }, null, 1));
    if (domLossy) console.warn(`HTML 采样缓存:${domLossy} 个画布读不出像素,重放时这些画布是空的`);
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Export finished in ${elapsed}s (${totalFrames} frames${reused ? `, ${reused} reused` : ''}${glass.list.length ? `, ${glass.list.length} glass masks` : ''}).`);
  return {
    framesDir, ext, fps, width, height, startFrame, endFrame, advanceStartFrame,
    advancedFrames: renderRanges.reduce((sum, [a, b]) => sum + b - a + 1, 0),
    totalFrames, durationSec, reused, elapsed, domDir, pushDrawn,
    glass: { dir: glass.dir, list: glass.list, blurs: [...glass.blurs] },
  };
}

/**
 * 一帧怎么推(从 `bakeFrames` 抽出来,**逐字搬运**,给 `bakeFrames` 和 `bakeStream` 两处复用 —— G4 第一步)。
 *
 * 一帧 = 下发时间 → 等网络 → 排空 → 推一拍(React 提交后的 rAF、Motion 建动画都在这一拍里)→ 等网络
 *       → 排空 → 钉动画 → 排空 → 探针 → 等素材。截不截图由调用方决定。返回这一帧画面静不静止。
 *
 * 闭包实际用到的外层量正好是这个签名:`bakery` 解构出的 `page` / `beginFrame` / `waitNet`、
 * `waitFrameReady(bakery, signal)`、`fps`、`directFrameAt` 和 `trace`。`staticSkip` 和
 * `frameWindow` 留在调用方。
 */
export function createStepper(bakery, { fps, directFrameAt = frame => frame, signal, trace = null }) {
  const { page, waitNet } = bakery;
  // 推帧补画要知道这一帧的拍子里有没有哪一拍报告了画面有变化(`hasDamage`);拍子本身照旧,只是把回执看一眼
  const beginFrame = async (extra) => { const result = await bakery.beginFrame(extra); if (result?.hasDamage) step.last.damaged = true; return result; };
  const readyHost = { page, beginFrame, waitNet };
  const step = async (frameIndex, wantTrace) => {
    step.last = { frame: frameIndex, damaged: false };
    // 两个计数器要在推进之前取、推进之后比;取值和下发时间合并成一次 evaluate
    const before = await page.evaluate(({ sec, directSec }) => {
      const n = { raf: window.__pcRafCount ?? 0, mut: window.__pcMutationCount ?? 0 };
      window.__pcHideFrameMedia?.();
      window.__pcSetT(sec, directSec);
      return n;
    }, { sec: frameIndex / fps, directSec: directFrameAt(frameIndex) / fps });
    // 挂载时发出的请求(动态 import、素材)先落地,再推这一拍
    await waitNet();
    await page.evaluate(() => window.__bfSettle());
    await beginFrame();
    await waitNet();
    /*
     * 排空 → 钉动画 → 再排空 → 探针,一次页面内调用做完。
     * 钉之前排空:这一拍里排队的提交要先落地,新建的动画 __pcSyncAnims 才看得见。
     * 钉之后再排空:__pcSyncAnims 对越过终点的动画调 finish(),Motion 在 onfinish 回调里把终态写进 style ——
     * 那是排队的任务,排空后探针的 mut 才看得见它。
     */
    let probe = await page.evaluate(async () => {
      await window.__bfSettle();
      if (window.__pcSyncAnims) window.__pcSyncAnims();
      await window.__bfSettle();
      return window.__pcStaticProbe ? window.__pcStaticProbe() : null;
    });
    if (probe?.finished) {
      // WAAPI finish events and AnimatePresence's replacement child need a
      // compositor tick, then a React commit and a second tick to create the
      // entering animation. Drain these at the SAME timeline time. Otherwise
      // taking an intermediate screenshot supplies those ticks by accident,
      // and a random seek differs from a sequential export by one subtitle frame.
      const finished = probe.finished;
      for (let pass = 0; pass < 2; pass++) {
        await beginFrame();
        probe = await page.evaluate(async () => {
          await window.__bfSettle();
          window.__pcSyncAnims?.();
          await window.__bfSettle();
          return window.__pcStaticProbe?.();
        });
      }
      if (probe) probe.finished += finished;
    }
    if (trace && wantTrace) trace.push(await page.evaluate((i) => ({
      i, perfNow: performance.now(), timelineNow: document.timeline.currentTime, probeMs: window.__pcProbeMs,
      anims: document.getAnimations().map((a) => [a.playState, a.currentTime, a.startTime, a.effect && a.effect.target && a.effect.target.className && String(a.effect.target.className).slice(0, 24)]),
    }), frameIndex));
    // 再等一次网络:这一拍里新挂的组件发出的请求,requestWillBeSent 事件和 beginFrame 的回复谁先到 Node 没有保证,
    // 上面那次 waitNet 可能正好看见 0 个在途。经过一次页面内往返,事件已经追上;没有请求时这里不花时间。
    await waitNet();
    // 等就绪时补发的拍子(异步的加载器要靠它们往前走)也经同一个包装:它们报告的画面变化一样要记
    await waitFrameReady(readyHost, signal);
    // 四个条件同时成立才算静止,少一个都会渲出坏帧 —— 理由见 ExportView 的 __pcStaticProbe。
    // finished:这一帧被 __pcSyncAnims 收束的动画数。动画在这一帧跳到终态,画面变了,但收束后 anims 里
    // 已经没有它、DOM 也没动 —— 只看 anims 会在动画结束那一帧误判静止。
    const isStatic = !!probe && probe.anims === 0 && probe.finished === 0 && probe.mut === before.mut
      && probe.raf === before.raf && !probe.video && !probe.canvas;
    if (process.env.PC_STATIC_TRACE) {
      console.log(`  静态判定 帧${frameIndex}: anims=${probe?.anims} finished=${probe?.finished} mut=${before.mut}->${probe?.mut} raf=${before.raf}->${probe?.raf} video=${probe?.video} canvas=${probe?.canvas} => ${isStatic ? '静止' : '在变'}`);
    }
    step.last.isStatic = isStatic;
    return isStatic;
  };
  /** 最近一次推的那一帧:`{ frame, damaged, isStatic }`(给推帧补画用) */
  step.last = { frame: null, damaged: false, isStatic: false };
  return step;
}

/**
 * 预热(从 `bakeFrames` 的 `warmUp` 闭包抽出来,逐字搬运)。
 *
 * 预热停在本次推帧起点,不能回到 0 挂载无关卡片、重置目标卡的入场相位。
 * 重挂载之后再走一整帧并丢掉:重挂载会让整页失效重绘,让这一次落在丢掉的帧上。
 * `frameWindow` 由调用方传进来(`bakeFrames` 的帧窗规划;`bakeStream` 恒为 null)。
 */
export async function warmUpAt(bakery, step, { startFrame, warmFrames = 3, frameWindow = null, signal }) {
  const { page, beginFrame } = bakery;
  // Direct React cards need a layout/capture at t, not animation warm-up or
  // a restart from their clip start. The ordinary step below commits them.
  if (frameWindow && !frameWindow.replayClipIds.length) return;
  console.log(`Warm-up ${warmFrames} frames...`);
  for (let i = 0; i < warmFrames; i++) {
    // 预热也看取消:不看的话,取消要等预热走完、进了逐帧循环才生效,这段时间 worker 其实还占着
    if (signal?.aborted) throw Object.assign(new Error('已取消'), { cancelled: true });
    await step(startFrame, false);
    await beginFrame();
  }
  await page.evaluate(() => { window.__pcRestartCards && window.__pcRestartCards(); window.__pcResetAnims && window.__pcResetAnims(); });
  await drawDiscarded(bakery, true, signal);
  await step(startFrame, false);
  await drawDiscarded(bakery, false, signal);
}

/** 轨道流的截图参数:带 alpha 的 PNG(ffmpeg 的 image2pipe 吃它),照 bakeFrames 的 PNG 口径 */
const STREAM_SHOT = { format: 'png', optimizeForSpeed: true };

/**
 * 轨道流的连续出帧(G4 第二步;与 `bakeFrames` 并列,**`bakeFrames` 的行为一字不改**)。
 *
 * bakery 上挂一份「流租约」`{ streamSignature, lastFrame, stepper, dirty }`:
 *
 *   - **租约匹配**(同一条流、`fromFrame === lastFrame + 1`、没被别人弄脏):跳过
 *     `__pcSetFrameWindow` 和预热,用租约里的 `stepper` 从页面当前状态接着逐帧推
 *     (`window.__pcExportMs` 就是上一帧的值,`__pcSetT` 照常推)。连续生产 N 个分段只付一次换页;
 *   - **否则**(首次、换流、跳段、签名变、`dirty`):走 `bakeFrames` 那套重挂载 ——
 *     `__pcSetFrameWindow(null, …)`(**`clipIds` 恒为 null**:挂载交给 `FrameScene` 的活跃判据,
 *     连续模式里后来才进入的卡照常挂)、预热、从挂载帧起付一次完整回放(不截图)。
 *
 * 页面上加载的是**该流的隔离工程**(由调用方在断租约时 `bakery.reset` 进来),所以全员挂载时
 * 页面里也只有这条流的像素;`clip` 再把截图限在 G1 的外扩矩形里。
 *
 * opts:
 *   streamSignature  流签名(换了就断租约)
 *   fromFrame / toFrame  这一趟要出的**全局**帧(闭区间;一个分段就是 15 帧)
 *   stride           每隔几帧截一张(G2 稀疏分段;1 = 满密度)
 *   mountFrame       这条流各卡最早的挂载帧(`mountFrameOf`);断租约时从 min(它, fromFrame) 起回放
 *   clip             截图矩形 `{ x, y, w, h }`(偶数宽高),见 `captureFrame`
 *   hasMedia         隔离工程里有没有素材层(有才在截图前 `prepareFrameMedia`)
 *   beforeCapture    `(frame) => Promise`:截图之前的钩子(实测实体框用,G1)
 *   capture          `(frame, shoot, { primed }) => Promise`:这一帧怎么取由调用方定(`./capture-canvas.mjs` 的画布直取):
 *                    回什么,`onFrame` 就收到什么;`shoot()` 是原来那一次截图(回 PNG),`primed` 说它会不会先丢一张。
 *                    不给 = 每帧截图
 *   onFrame          `(frame, png) => Promise`:逐帧交出,`await` 就是背压(G4:编码器双缓冲靠它)
 *   signal           只在两帧之间生效
 *
 * 回 `{ reset, replayed, captured, captureMs, stepMs, pushDrawn, pushDrawMs }`(给调度器量 `firstMs` / `frameMs` 用;
 * 后两个是推帧补画多发的拍数和花的毫秒,见文件头)。
 */
export async function bakeStream(bakery, opts) {
  const { page, client } = bakery;
  const { streamSignature, fromFrame, toFrame, signal } = opts;
  if (!streamSignature) throw new Error('bakeStream 要流签名');
  if (!Number.isInteger(fromFrame) || !Number.isInteger(toFrame) || fromFrame < 0 || toFrame < fromFrame) throw new Error(`bakeStream 帧区间不对:${fromFrame}..${toFrame}`);
  const stride = Math.max(1, Math.round(Number(opts.stride) || 1));
  const cancelled = () => Object.assign(new Error('已取消'), { cancelled: true });
  let lease = bakery.streamLease;
  // 页面换过(`bakery.reset` 换了一个新 page)也算断:租约里的 stepper 绑的是旧页面
  const continues = !!lease && !lease.dirty && lease.page === page && lease.streamSignature === streamSignature && fromFrame === lease.lastFrame + 1;
  let reset = false;
  if (!continues) {
    const timeline = await page.evaluate(() => window.__pcTimeline);
    if (!timeline) throw new Error('Timeline not found');
    const fps = opts.fps || timeline.fps || 30;
    const width = timeline.width || 1920;
    const height = timeline.height || 1080;
    const startFrame = Math.max(0, Math.min(fromFrame, Number.isInteger(opts.mountFrame) ? opts.mountFrame : fromFrame));
    const stepper = createStepper(bakery, { fps, directFrameAt: frame => frame, signal, trace: null });
    // 挂载交给 FrameScene 的活跃判据:clipIds 恒为 null(任务书「不做」:bakeStream 带非空 clipIds)
    await page.evaluate(({ time }) => {
      if (!window.__pcSetFrameWindow) throw new Error('Frame window API is unavailable');
      window.__pcSetFrameWindow(null, time, time);
    }, { time: startFrame / fps });
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    forgetCaptureClip(bakery);
    await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    // 截图矩形在预热之前就定下来:改设备度量会让合成面换尺寸,预热那几拍正好把它推稳
    if (opts.clip !== undefined) await applyCaptureClip(bakery, opts.clip);
    await warmUpAt(bakery, stepper, { startFrame, warmFrames: opts.warm ?? 3, frameWindow: null, signal });
    lease = bakery.streamLease = { streamSignature, lastFrame: startFrame - 1, lastShot: null, stepper, dirty: false, fps, page };
    reset = true;
  }
  const stats = { reset, replayed: 0, captured: 0, captureMs: 0, stepMs: 0, pushDrawn: 0, pushDrawMs: 0 };
  const pushDraw = pushDrawEnabled(opts);
  /** 推帧补画(见文件头):回放的帧、稀疏分段里不取图的帧,画面有变化的各画一拍丢掉;当它「截过」记账,下一帧不用再先丢一张 */
  const drawPushed = async (frame, isStatic) => {
    if (!pushDraw) return;
    const drawnBefore = lease.lastShot !== null;
    if (!pushDrawNeeded({ isStatic, damaged: lease.stepper.last?.damaged, drawnBefore, previousDrawn: lease.lastShot === frame - 1 })) return;
    const started = Date.now();
    stats.pushDrawn += await drawDiscarded(bakery, !drawnBefore, signal);
    lease.lastShot = frame;
    stats.pushDrawMs += Date.now() - started;
  };
  for (let frame = lease.lastFrame + 1; frame <= toFrame; frame++) {
    if (signal?.aborted) throw cancelled();
    const stepStarted = Date.now();
    const isStatic = await lease.stepper(frame, false);
    stats.stepMs += Date.now() - stepStarted;
    lease.lastFrame = frame;
    if (frame < fromFrame) { stats.replayed++; await drawPushed(frame, isStatic); continue; }
    if ((frame - fromFrame) % stride !== 0) { await drawPushed(frame, isStatic); continue; }
    const shotStarted = Date.now();
    await opts.beforeCapture?.(frame);
    if (opts.hasMedia) await prepareFrameMedia(bakery);
    // prime 只看「紧挨着的上一帧截没截过」(和 bakeFrames 同一个判据),跨趟也算
    const primed = lease.lastShot !== frame - 1;
    const shoot = async () => {
      const shot = await captureFrame(bakery, STREAM_SHOT, signal, { prime: primed, clip: opts.clip ?? null });
      lease.lastShot = frame;
      return shot;
    };
    // 调用方给了 `capture` 就由它定这一帧怎么取(画布直取,或者调 `shoot()` 照旧截图);没给就是原来那一次截图
    const png = opts.capture ? await opts.capture(frame, shoot, { primed }) : await shoot();
    stats.captureMs += Date.now() - shotStarted;
    stats.captured++;
    await opts.onFrame?.(frame, png);
  }
  return stats;
}

/**
 * 别的调用(锚帧的 `bakery.reset`、任何 `bakeFrames`)在这个会话上跑过:租约作废(D5 的 `dirty` 位),
 * 下一次 `bakeStream` 当断租约处理、付一次完整回放。
 */
export function dirtyStreamLease(bakery) {
  if (bakery?.streamLease) bakery.streamLease.dirty = true;
}
