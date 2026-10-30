import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Stage, type ProxyRender, type StagePlaneProps } from "./Stage";
import { flattenOverlay, isImageMedia, nextVideoLayerAfter, opacityAt, videoLayersAt, type MediaAsset, type Project, type TrackClip } from "../kernel/project";
import type { Timeline } from "../kernel/types";
import { frameCss } from "../kernel/layout";
import { emphasisFilter } from "../kernel/emphasis";
import { clipFilterOpsAt, cssFilter } from "../kernel/filters.mjs";
import { pixelMapOfClip } from "../kernel/pixelMap.mjs";
import { clipSpeed, mediaTimeAt } from "../kernel/clipTime.mjs";
import { type PixelMapDef } from "../kernel/pixelMap.mjs";
import { drawPixelMap } from "./pixelMapGl";
import { graphVisualNode } from "./cards/GraphCard";
import { cardMountedAt } from "./frameWindow.mjs";
import { clipFrameMode } from "../kernel/frameMode.mjs";
import { getCard } from "../kernel/registry";
import { VideoTrack } from "./VideoTrack";
import { driveMedia, filterOf, releaseMedia, targetTimeOf } from "./mediaDrive";
import { playbackUrl } from "./mediaTier";
import { confirmedMissingVisual, missingMaterialLabel } from "../audio/missingMaterial";
import { MissingMaterial } from "./MissingMaterial";
import { SceneHostContext } from "./CutSegmentScene";

const NO_HASHES: readonly string[] = [];

/**
 * 导出 / 预渲染取帧的素材时刻(`data-pc-media-time`,截图那一步 `frameMedia.ts` 按它 seek)。
 * 变速段按 `kernel/clipTime.mjs` 的统一换算;缺省 1 时保留这里原来的运算顺序 `(mediaOffset + t) − start` ——
 * 浮点加减不满足结合律,换成 `mediaOffset + (t − start)` 可能差最后一位,导出取帧要逐位不变。
 */
function exportMediaTime(clip: TrackClip, t: number): number {
  return Math.max(0, clipSpeed(clip) === 1 ? (clip.mediaOffset ?? 0) + t - clip.start : mediaTimeAt(clip, t));
}

/**
 * 素材层上的像素映射。画面由 WebGL2 片元着色器算(render/pixelMapGl.ts):表达式在
 * kernel/pixelMap.mjs 里翻译成 GLSL,视频 / 图片帧当纹理,`to` 是另一段素材时用第二张纹理。
 * 这张 <canvas> 只有 bitmaprenderer 上下文 —— 着色器画完整块位图转移过来。
 * 原先的逐像素 CPU 循环(getImageData → mapRgba → putImageData)已整体删除、不留退路:
 * 实测 1080p 每帧 416～483 ms,超 30 fps 的每拍预算约二十倍。
 */
function PixelMappedMedia({ media, clip, t, project, style, def, live = false, playing = false, scrubbing = false, localHashes = NO_HASHES }: { media: any; clip: any; t: number; project: Project; style: React.CSSProperties; def: PixelMapDef; live?: boolean; playing?: boolean; scrubbing?: boolean; localHashes?: readonly string[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useRef<HTMLVideoElement | HTMLImageElement>(null);
  const targetSource = useRef<HTMLVideoElement | HTMLImageElement>(null);
  // stage=after_filters 时先把滤镜套在一张中转画布上,再当纹理上传(滤镜由合成器在 GPU 上做,
  // 不读回像素)。stage=origin 直接上传素材元素,少一次重采样。
  const staged = useRef<HTMLCanvasElement | null>(null);
  const draw = useCallback(() => {
    const c = canvas.current; const s = source.current;
    const ready = (el: HTMLVideoElement | HTMLImageElement) => el instanceof HTMLVideoElement ? el.readyState >= 2 : el.complete && el.naturalWidth > 0;
    if (!c || !s || !ready(s)) return;
    const w = Math.max(1, Math.round(project.width)); const h = Math.max(1, Math.round(project.height));
    let src: CanvasImageSource = s;
    if (def.source.stage === "after_filters" && clip.filter) {
      const ops = project.filters?.length ? clipFilterOpsAt(project, clip, t) : null;
      const css = ops ? cssFilter(ops) : "";
      if (css) {
        const mid = staged.current ?? (staged.current = document.createElement("canvas"));
        if (mid.width !== w || mid.height !== h) { mid.width = w; mid.height = h; }
        const mx = mid.getContext("2d");
        if (mx) { mx.clearRect(0, 0, w, h); mx.filter = css; mx.drawImage(s, 0, 0, w, h); mx.filter = "none"; src = mid; }
      }
    }
    const ts = targetSource.current;
    const target = def.to?.kind === "media" && ts && ready(ts) ? ts : null;
    try {
      drawPixelMap(c, { def, source: src as TexImageSource, target: target as TexImageSource | null, width: w, height: h, t });
      c.removeAttribute("data-pc-pixel-error");
    } catch (err) {
      // 画不出来就让这一层空着,别把整个场景树拖垮;属性留给验收脚本和排错看
      c.setAttribute("data-pc-pixel-error", err instanceof Error ? err.message : String(err));
      console.error("[pixelMap]", err);
    }
  }, [def, clip, project, t]);
  useEffect(() => {
    // Source images/videos load only at capture time. Draw synchronously when
    // all decoders are ready; a wall-clock timer can miss the screenshot.
    document.addEventListener("pc:frame-media-ready", draw);
    return () => document.removeEventListener("pc:frame-media-ready", draw);
  }, [draw]);
  /*
   * live(舞台)路:源素材是**真的在放的** `<video>` / `<img>`,不是导出页那种等截图时才装 src 的占位。
   * 所以这里自己跟播放头对齐、每次渲染都重画一次;视频再补一次 rVFC —— 解出新的一帧时
   * 画面要跟着换,而暂停时没有播放循环推着重渲。
   */
  useLayoutEffect(() => {
    if (!live) return;
    const v = source.current;
    if (v instanceof HTMLVideoElement) {
      driveMedia(v, { target: targetTimeOf(clip, t), playing, volume: 0, scrubbing, rate: clipSpeed(clip) });
      v.requestVideoFrameCallback(() => draw());
    }
    const tv = targetSource.current;
    if (tv instanceof HTMLVideoElement) {
      driveMedia(tv, { target: Math.max(0, t), playing, volume: 0, scrubbing });
      tv.requestVideoFrameCallback(() => draw());
    }
    draw();
  });
  useLayoutEffect(() => {
    if (!live) return;
    const a = source.current;
    const b = targetSource.current;
    return () => {
      if (a instanceof HTMLVideoElement) releaseMedia(a);
      if (b instanceof HTMLVideoElement) releaseMedia(b);
    };
  }, [live]);
  // 源素材藏起来(画面由下面那张 canvas 出)。visibility:hidden 的视频照样解码、照样回调 rVFC
  // (实测 Chrome 152,同 VideoTrack 的隐藏槽位),`texImage2D` 也照样读得到它解出来的帧。
  const hidden: React.CSSProperties = { ...style, visibility: "hidden", position: "absolute" };
  const targetMedia = def.to?.kind === "media" ? project.media.find((m) => m.id === (def.to as Extract<PixelMapDef["to"], { kind: "media" }>).mediaId) : null;
  const targetHidden: React.CSSProperties = { ...hidden, pointerEvents: "none" };
  /*
   * 导出页(placeholder)刻意**不给 src**:推进 React 的过程中绝不能去 seek / 解码素材,
   * 截图那一步才由 `__pcPrepareFrameMedia` 按 `data-pc-media-*` 把这一帧装回来。
   * live(舞台)路正相反 —— 素材是真的在放的,所以这时候才挂 `src` 并 `preload="auto"`。
   */
  // live 的 src 经换档判据(`mediaTier.ts` 的 playbackUrl,T1a 审查 #5);`data-pc-media-src` 仍是 `media.url`(身份、素材原尺寸)
  //
  // 拿到空串要回 `undefined`,不能把 "" 挂进 `src`。`playbackUrl` 的文件头写明「调用方拿到 "" 就不挂 src、不发请求」,
  // 而 `<video src="">` 会被浏览器当成「再下载一遍当前页面」,React 也会报
  // 「An empty string ("") was passed to the src attribute」。素材正在入库时(`pending`,还没有地址)就是这种情形:
  // 本地导入的 pending 窗口只有毫秒级,看不出来;从网盘导入要拉几十秒到几分钟,这一段预览就是坏的。
  // (2026-10-23 跑网盘连接器端到端时发现,用户报「添加的时候预览失败」。)
  const srcOf = (m?: MediaAsset | null) => (live && m ? playbackUrl(m, localHashes) || undefined : undefined);
  const load = live ? "auto" : "none";
  return <>
    {isImageMedia(media) ? <img ref={source as any} src={srcOf(media)} onLoad={live ? () => draw() : undefined} data-pc-media-src={media.url} data-pc-media-hidden="true" alt="" style={hidden} /> :
      <video ref={source as any} muted playsInline preload={load} src={srcOf(media)} data-pc-media-src={media.url} data-pc-media-hidden="true"
        data-pc-media-time={exportMediaTime(clip, t)} style={hidden} />}
    {targetMedia ? (isImageMedia(targetMedia) ? <img ref={targetSource as any} src={srcOf(targetMedia)} onLoad={live ? () => draw() : undefined} data-pc-media-src={targetMedia.url} data-pc-media-hidden="true" alt="" style={targetHidden} /> :
      <video ref={targetSource as any} muted playsInline preload={load} src={srcOf(targetMedia)} data-pc-media-src={targetMedia.url} data-pc-media-hidden="true"
        data-pc-media-time={Math.max(0, t)} style={targetHidden} />) : null}
    <canvas ref={canvas} width={Math.max(1, Math.round(project.width))} height={Math.max(1, Math.round(project.height))}
      data-pc-pixel-map={JSON.stringify(def)} data-pc-pixel-time={t} style={style} />
  </>;
}

/**
 * K6 的每卡耗时:**靠渲染顺序给一个片段的子树掐表**。
 *
 * 不能用 React 的 `<Profiler>`:它的 `actualDuration` 读 `performance.now()`,而舞台把
 * `performance.now` 换成了虚拟时钟(`stageClock`)—— 一拍之内它是个常数,所以 `Profiler`
 * 报的每一张卡都是 0(实测)。量耗时一律用 `__pcRealNow`(接管前存下的真墙钟)。
 *
 * 做法:在这个片段的 `Stage` **前后各放一个只跑一次回调、不产生 DOM 的兄弟组件**。
 * React 的渲染是深度优先、兄弟从左到右,所以「前面那个的回调 → 整棵子树渲染 → 后面那个的回调」
 * 顺序是确定的(同步 `flushSync` 下没有中断)。两次 `__pcRealNow()` 之差就是这张卡这一拍的
 * 渲染耗时;子树因为 props 没变而跳过时自然就接近 0 —— 那本来就是它这一拍的真实成本。
 *
 * **只量渲染阶段**,不含提交到 DOM 的那一段。见报告里的更正建议。
 */
const realNow = (): number => (typeof window !== "undefined" && window.__pcRealNow ? window.__pcRealNow() : performance.now());
/** 上一个 `CostMark` 记下的时刻。渲染是单线程顺序的,一个模块级变量就够 */
let costMarkAt = 0;
function CostMark({ at }: { at: (now: number) => void }) {
  at(realNow());
  return null;
}

/**
 * One browser stacking tree, ordered from the bottom track upwards.
 *
 * # 两个素材变体(E7)
 *
 * `mediaMode: 'placeholder'`(缺省,导出页和 legacy 走这条):视频占位**刻意不给 src** ——
 * 推进 React 的过程中绝不能去 seek / 解码素材;截图那一步才由 `__pcPrepareFrameMedia`
 * 按 `data-pc-media-*` 把这一帧装回来。**这条路的 DOM 一个字都不许变**(导出有逐像素基线)。
 *
 * `mediaMode: 'live'`(舞台页):素材层是真的在放的 —— 每条序列一个 `VideoTrack`
 * (双 `<video>` 轮换,见 `render/VideoTrack.tsx`),`cur` / `next` 由这里按 `mediaT` 算好;
 * 卡片活跃判据换成 `cardMountedAt`(含 LEAD,和 `Stage` 内部同一个口径);
 * `Stage` 的六个可选 prop(快照 / 抑制 / 流平面 / 重挂载代数 / 追帧 / 等待)原样透传。
 */
export function FrameScene({
  project, sourceProject = project, t, directT = t, playToken, graph,
  mediaMode = "placeholder", mediaT = t, scrubbing = false, playing = false, proxy,
  suppressed, streamPlanes, snapshots, remountGen, settling, awaiting, localHashes, onMediaFrame, onCardCost, nested = false, flatPrefix,
}: {
  project: Project; sourceProject?: Project; t: number; directT?: number; playToken: number; graph?: Timeline["graph"];
  /**
   * 剪辑段里的嵌套场景(`CutSegmentScene`):序列层不挂 `data-pc-track`、片段层挂 `data-pc-nested-clip`
   * (预渲染按轨道前缀拆层、命中测试、钉动画只认舞台顶层)。顶层一律 false,DOM 一个字不变。
   */
  nested?: boolean;
  /** 剪辑段里的嵌套场景:片段在计划一侧的 id 前缀(`Stage` 的 `flatPrefix`;`kernel/cutFlatten.mjs`)。顶层不传 */
  flatPrefix?: string;
  /** 素材层怎么画:导出页 / legacy 的占位,还是舞台里真的在放的那套(E7 第 1 条) */
  mediaMode?: "placeholder" | "live";
  /** 素材层跟的时刻(秒)。平时等于 `t`;K5 第二路的补跑里父页会单独给 `back` 下发目标拍 */
  mediaT?: number;
  scrubbing?: boolean;
  playing?: boolean;
  proxy?: ProxyRender;
  /**
   * A1 的 `localHashes`:当前连接的素材服务报 `complete` 的哈希。**只有 live 路消费**(`VideoTrack` 与
   * 像素映射素材的 src 经 `mediaTier.ts` 的 playbackUrl 换档,T1a 审查 #5);placeholder 路(导出页 / legacy)
   * 一律 `media.url`,传了也不改一个像素。集合为空 = 一律素材原尺寸,和没接换档之前一样。
   */
  localHashes?: readonly string[];
  /** live:后台舞台的素材层画出一帧了(K5 第 (4) 步的 `mediaReady`) */
  onMediaFrame?: (mediaTime: number) => void;
  /**
   * K6:这一拍这张卡花了多少毫秒。**只有 live 路有**,`<Profiler>` 报的
   * `actualDuration`(这个片段的子树这一次提交渲染花的时间)。
   *
   * 为什么用 `Profiler` 而不是自己掐表:一拍是一次 `flushSync`,整棵树一起提交,
   * 外面掐表只量得到总数;而 K6 要的是「本窗口实测累计耗时最大的那张轻卡」。
   * live 路每个片段本来就是一个独立的单片段 `Stage`,套一层 `Profiler` 不产生任何 DOM。
   *
   * **限制**:它量的是 React 渲染 / 提交,不含卡片自己 rAF 回调里的时间
   * (那些跑在 `clock.tick` 里,回调和片段之间没有可靠的归属关系)。
   * 见报告里的更正建议。
   */
  onCardCost?: (clipId: string, ms: number) => void;
} & StagePlaneProps) {
  const live = mediaMode === "live";
  const hashes = live ? localHashes ?? NO_HASHES : NO_HASHES;
  const layers = videoLayersAt(project, live ? mediaT : t);
  const frame = Math.round(directT * (project.fps || 30));
  const runtime = (sourceProject as any)._cardRender as { frames?: Record<string, Record<number, string>>; missing?: Record<number, string[]> } | undefined;
  const cached = (id: string) => runtime?.frames?.[id]?.[frame];
  const missing = new Set(runtime?.missing?.[frame] || []);
  const replaced = (id: string) => !!cached(id) || missing.has(id);
  const tracks = [...project.tracks].reverse().filter((tr) => !tr.hidden);
  /*
   * 卡片按自身时间口径判定活跃:直接求值卡走 directT,时序卡走 t。
   * 开窗取帧(see_frames / 局部导出)下 t 还在片段起点之前时,时序卡不能因 directT 越过起点而提前挂载(否则早一帧)。
   * live 下用 cardMountedAt(含 50ms 提前量),placeholder(导出)下用 [start, end) 区间。
   */
  const clipTime = (clip: TrackClip) =>
    clipFrameMode(clip, getCard(clip.cardId)) === "direct" ? directT : t;
  const active = live
    ? (clip: TrackClip) => cardMountedAt(clip, clipTime(clip))
    : (clip: TrackClip) => {
        const ct = clipTime(clip);
        return ct >= clip.start && ct < clip.end;
      };
  /*
   * 素材效果卡接管的素材段、带像素映射的素材段都不进 `VideoTrack`:前者由 `Stage` 里的素材效果卡画,
   * 后者由 `PixelMappedMedia` 画 —— 不滤掉的话同一段素材会被画两遍。
   * **过滤必须下推进 `nextVideoLayerAfter`**(它每条序列只回一段,事后滤等于这条序列没有 `next`)。
   */
  // 停用的像素映射按没挂算(`pixelMapOfClip`),这一段退回普通素材层,不走 PixelMappedMedia
  const takenByOther = (clip: TrackClip) =>
    graphVisualNode(graph, clip.nodeId) || !!pixelMapOfClip(project, clip);
  const nexts = live ? nextVideoLayerAfter(project, mediaT, takenByOther) : [];
  /*
   * E7 第 7 条:`legacyTimeline` 按 `(project, tr, clip)` 引用 memo。
   * 不 memo 的话每帧给每个片段新建一个 `timeline` 对象,`Stage` 的 `useMemo`、
   * `GraphCard` 的输入解算全部按新引用重算 —— 播放时这是每拍都要付的。
   * WeakMap 以 clip 对象为键:store 是不可变更新,没动过的 clip 引用不变。
   */
  const timelineCache = useRef(new WeakMap<object, { project: Project; tr: unknown; graph: unknown; timeline: Timeline }>());
  const legacyTimeline = (tr: Project["tracks"][number], clip: Project["tracks"][number]["clips"][number]): Timeline => {
    const hit = timelineCache.current.get(clip);
    if (hit && hit.project === project && hit.tr === tr && hit.graph === graph) return hit.timeline;
    // 图**不能**从裁剪版算(只留一条轨道一个片段,跨片段输入解不出)—— 由宿主算好、原样带进来。
    const timeline = { ...flattenOverlay({ ...project, tracks: [{ ...tr, clips: [clip] }] }), graph } as Timeline;
    timelineCache.current.set(clip, { project, tr, graph, timeline });
    return timeline;
  };
  const stageSize = { width: project.width, height: project.height };
  const clipAttr = nested ? "data-pc-nested-clip" : "data-pc-clip";
  // 嵌套的剪辑段场景照同一种素材变体渲(CutSegmentScene)
  const host = { live, mediaT, playing, scrubbing, localHashes: hashes };
  return <SceneHostContext.Provider value={host}>{tracks.map((tr, index) => {
    const curOf = (trackId: string) => layers.find((l) => l.trackId === trackId && !takenByOther(l.clip) && !replaced(l.clip.id)) ?? null;
    // 这条序列上有没有画面段(视频 / 图片)。没有就不挂 VideoTrack,免得多两个空 <video>
    const hasVisual = tr.clips.some((c) => {
      if (!c.mediaId || takenByOther(c)) return false;
      const m = project.media.find((x) => x.id === c.mediaId);
      return !!m && m.kind !== "audio";
    });
    return <div key={tr.id} {...(nested ? { "data-pc-nested-track": tr.id } : { "data-pc-track": tr.id })} style={{ position: "absolute", inset: 0, zIndex: index }}>
      {live && hasVisual ? (
        <VideoTrack
          project={project}
          cur={curOf(tr.id)}
          next={nexts.find((n) => n.trackId === tr.id) ?? null}
          t={mediaT}
          playing={playing}
          scrubbing={scrubbing}
          // 舞台恒 muted:音频留在编辑器主文档(MediaLayers 的 audioOnly)
          muted
          stage={stageSize}
          filters={project.filters}
          onMediaFrame={onMediaFrame}
          localHashes={hashes}
        />
      ) : null}
      {live ? layers.filter((l) => l.trackId === tr.id && !graphVisualNode(graph, l.clip.nodeId) && !replaced(l.clip.id) && !confirmedMissingVisual(l.media)
        && !!pixelMapOfClip(project, l.clip)).map(({ clip, media, opacity }) => {
        const def = pixelMapOfClip(project, clip)!;
        const ops = project.filters?.length ? clipFilterOpsAt(project, clip, mediaT) : null;
        const filter = [ops ? cssFilter(ops) : "", emphasisFilter(clip.emphasis) || ""].filter(Boolean).join(" ");
        const style = { display: "block", width: "100%", height: "100%", objectFit: "cover" as const, opacity, filter: filter || undefined };
        return <div key={clip.id} {...{ [clipAttr]: clip.id }} data-pc-media="" data-pc-local-frame={Math.round((mediaT - clip.start) * project.fps)} style={{ position: "absolute", overflow: "hidden", ...frameCss(clip.frame, project) }}>
          <PixelMappedMedia media={media as MediaAsset} clip={clip} t={mediaT} project={project} style={style} def={def} live playing={playing} scrubbing={scrubbing} localHashes={hashes} />
        </div>;
      }) : null}
      {!live && layers.filter(l => l.trackId === tr.id && !graphVisualNode(graph, l.clip.nodeId) && !replaced(l.clip.id) && !confirmedMissingVisual(l.media)).map(({ clip, media, opacity }) => {
        const ops = project.filters?.length ? clipFilterOpsAt(project, clip, t) : null;
        const filter = [ops ? cssFilter(ops) : "", emphasisFilter(clip.emphasis) || ""].filter(Boolean).join(" ");
        const style = { display: "block", width: "100%", height: "100%", objectFit: "cover" as const, opacity, filter: filter || undefined };
        // data-pc-media:生成快照时 controls 的选择器靠它把素材层排除掉(见 render/createSnapshot.ts)
        return <div key={clip.id} {...{ [clipAttr]: clip.id }} data-pc-media="" data-pc-local-frame={Math.round((t - clip.start) * project.fps)} style={{ position: "absolute", overflow: "hidden", ...frameCss(clip.frame, project) }}>
          {pixelMapOfClip(project, clip) ? (() => {
            const def = pixelMapOfClip(project, clip)!;
            return <PixelMappedMedia media={media} clip={clip} t={t} project={project} style={style} def={def} />;
          })() : isImageMedia(media) ? <img data-pc-media-src={media.url} alt="" style={{ ...style, visibility: "hidden" }} /> :
            <video muted playsInline preload="none" data-pc-media-src={media.url}
              data-pc-media-time={exportMediaTime(clip, t)}
              style={{ ...style, visibility: "hidden" }} />}
        </div>;
      })}
      {tr.clips.map((clip, clipIndex) => {
        // 剪辑段:活跃判据看 flattenOverlay 交出的那份(起点含预卷、推帧口径取被引用剪辑的),不看序列上的原段
        if (clip.cutId) {
          const seg = legacyTimeline(tr, clip).clips[0];
          if (!seg || !active(seg as TrackClip)) return null;
        } else if (!active(clip)) return null;
        const layerStyle: React.CSSProperties = { position: "absolute", inset: 0, zIndex: clipIndex };
        const media = clip.mediaId ? project.media.find((item) => item.id === clip.mediaId) : undefined;
        if (media && confirmedMissingVisual(media)) {
          if (live && !takenByOther(clip)) return null; // The live VideoTrack owns ordinary visual media layers.
          const sceneTime = live ? mediaT : t;
          return <div key={clip.id} {...{ [clipAttr]: clip.id }} data-pc-media="" data-pc-confirmed-missing="1"
            style={{ ...layerStyle, ...frameCss(clip.frame, project), opacity: opacityAt(clip, sceneTime), filter: filterOf(clip, project.filters, sceneTime), pointerEvents: "none" }}>
            <MissingMaterial name={missingMaterialLabel(media)} />
          </div>;
        }
        if (replaced(clip.id)) {
          const url = cached(clip.id);
          // Cached controls are full-stage PNGs. Their placement and motion have
          // already been baked by the capture, so applying frameCss here would
          // transform them twice. Opacity and fades are baked there as well.
          return url
            ? <div key={clip.id} {...{ [clipAttr]: clip.id }} style={layerStyle}>
              <img data-pc-cached-control={clip.id} src={url} alt="" style={{ display: "block", width: "100%", height: "100%" }} />
            </div>
            : <div key={clip.id} {...{ [clipAttr]: clip.id }} data-pc-incomplete={clip.id} style={{ ...layerStyle, ...frameCss(clip.frame, project), border: "2px dashed #dcb66a", boxSizing: "border-box", display: "grid", placeItems: "center", background: "#1e273050", opacity: opacityAt(clip, directT) }}>
              <span style={{ color: "#fff", fontSize: 28 }}>⌛</span>
            </div>;
        }
        const timeline = legacyTimeline(tr, clip);
        // Media has already been painted below this block. A one-clip Stage
        // keeps each legacy card at its original track position while retaining
        // Stage's direct-child perspective and glass/backdrop context.
        // E7 第 3～5 条:`proxy` 和六个平面 prop 原样透传给每个内部单片段 `Stage`。
        // `placeholder` 路一个都不传(宿主本来就不给),DOM 一个字不变。
        if (!timeline.clips.length) return null;
        const stage = (
          <Stage timeline={timeline} t={t} directT={directT} playToken={playToken} nested={nested} flatPrefix={flatPrefix}
            proxy={proxy} snapshots={snapshots} suppressed={suppressed} streamPlanes={streamPlanes}
            remountGen={remountGen} settling={settling} awaiting={awaiting} />
        );
        /*
         * K6 的每卡耗时。**加不加这两个兄弟由 `live` 决定、不由 `onCardCost` 在不在决定** ——
         * 中途多一个 / 少一个兄弟会让 React 按位置重新对账、把卡片重挂载,锚点就丢了。
         * `placeholder`(导出 / legacy)永远不加,DOM 和渲染路径一个字不变
         * (`CostMark` 本身回 `null`,live 路的 DOM 也一个节点都不多)。
         */
        return (
          <div key={clip.id} {...(nested ? null : { "data-pc-native-layer": clip.id })} style={layerStyle}>
            {live ? <CostMark at={(now) => { costMarkAt = now; }} /> : null}
            {stage}
            {live ? <CostMark at={(now) => onCardCost?.(clip.id, now - costMarkAt)} /> : null}
          </div>
        );
      })}
    </div>;
  })}</SceneHostContext.Provider>;
}
