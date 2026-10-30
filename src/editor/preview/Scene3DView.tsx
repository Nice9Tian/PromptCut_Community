import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useBakePrefetch, beginForegroundBake, endForegroundBake, canonFrameT } from "./useBakePrefetch";
import { clipFingerprint, markBaked, momentId } from "./bakeCoverage";
import { measureImageBox, worthCropping } from "./alphaBox";
import { flattenOverlay, type Project } from "../../kernel/project";
import { placeClip3D } from "./place3d";
import { frustum2d } from "./frustum2d";
import { getCard } from "../../kernel/registry";
import { actions, useStore } from "../../store/project";
import {
  addLights, applyTexture, geometryOf, materialOf, poseMesh, radiusFor, shapeOf,
  type Scene3DParams,
} from "../../cards/native/scene3dObject";
import { cameraFor, DEFAULT_FOV_DEG, stageToWorld } from "../../kernel/space3d";
import { motionOf, pickBakeT, sampleTimesFor, texKeyOf, type TimedClip } from "./bakeTime";
import { isScrubbing, subscribeScrub } from "../timeline/useScrub";
import { ONLINE } from "../../online/mode";
import { StreamPlayer, PushedStreamSource, type StreamPlaneRequest } from "../../render/streamPlayer";
import { isStreamOrigin } from "../../render/streamSegments.mjs";
import { currentReadyIndex } from "../snapshotFeed";
import { setPlan3DView } from "../planDispatch";
// 棋盘格底和浮层样式在这儿(.pc-3d-checker / .pc-3d-note)。自己引一次,不指望父组件替它引
import "./preview.css";

/**
 * 3D 视图:把这一刻画面上的每张卡当成一块**立在空间里的板子**,可以像 Blender 那样绕着看。
 *
 * # 它和 2D 视图分工不同
 *
 * 2D 视图的契约是「预览所见 = 导出所得」——那是**成片长什么样**。
 * 这个视图回答的是另一个问题:**这些东西在空间里是怎么摆的**。所以它不追求逐像素等同,
 * 它追求的是"层和层之间的前后、倾斜、间距一眼看得出来"。相机可以随便转,这本来就不是成片的机位。
 *
 * # 板子上贴的是预渲染出来的真图,不是重画一遍
 *
 * 每块板子的贴图来自 `/api/vision/bake-batch`,而那条路画图的就是导出成片的那个渲染器。
 * 所以板子上的内容和成片里的**是同一批像素**,不是这里另外实现一遍卡片。
 * 另实现一遍就等于又开一条会分叉的路 —— 这个项目里那类分叉的代价写在 vite-plugin-vision.ts 开头。
 *
 * # 三维的卡在这里是**真的三维**
 *
 * `scene-3d` 那种本身就是立体物件的卡,不走"贴图平板"那条路 —— 一开始是那么做的,
 * 结果绕着转它还是一张画,而这个视图存在的理由正是"看清东西在空间里怎么摆"。
 * 现在直接用卡片同一份几何构造(`cards/native/scene3dObject.ts`)在这儿造一个真的物件,
 * 连灯光预设都是同一份。两边共用一份构造,才不会出现"检视里看到的和成片里不是一个东西"。
 *
 * # 代理色块只是过渡
 *
 * 贴图没到位之前先画一块半透明色块占位,**渲好了立刻换上**。
 * 预渲染按输入做了缓存(见 bakeOne),同一张卡同样的参数只真渲一次,之后开这个视图是零成本 ——
 * 所以正常情况下你看到的一直是真贴图,色块只在第一次、或者刚改完卡的那几秒出现。
 */

type ThreeMod = typeof import("three");
type OrbitMod = typeof import("three/examples/jsm/controls/OrbitControls.js");

let modsPromise: Promise<[ThreeMod, OrbitMod]> | null = null;
/** three 和 OrbitControls 都只在真的打开 3D 页时才下载 */
const loadMods = (): Promise<[ThreeMod, OrbitMod]> =>
  (modsPromise ??= Promise.all([
    import("three"),
    import("three/examples/jsm/controls/OrbitControls.js"),
  ]));

/** 没贴图时的占位色。半透明,一眼看得出"这块还在渲" */
const PROXY_COLOR = 0x64748b;

/**
 * URL → 已经解码好的贴图。**跨场景重建复用。**
 *
 * # 为什么要有它:两张卡交界处会闪一下色块
 *
 * 场景的重建键 `sig` 是「此刻画面上有哪几张卡」,所以播放头**每跨过一次卡片边界**整个场景
 * 就重建一次,每块板子都是新的 mesh + 新的 material。而 `applyTexture` 一律走
 * `new THREE.TextureLoader().load(url)` —— 哪怕这张图刚刚才贴过、HTTP 缓存里热着,
 * 解码也是异步的。于是新板子先以 PROXY_COLOR 的色块出场,一两帧之后贴图才回来。
 * 用户看到的就是「两张卡之间突然闪一下实体模式」,而其实什么都没缺,只是重解码了一遍。
 *
 * 存下解码结果之后,重建时命中的那张**同一帧就贴上**,中间没有色块。
 *
 * # 为什么要有上限,而且淘汰时要跳过正在用的
 *
 * 一张 1920×1080 的贴图在显存里约 8MB,而预渲染会渲出几百个时刻 —— 不设上限,用户把时间轴
 * 从头拖到尾就能把显存撑爆。上限之外还有一条:**正在板子上的那几张一律不淘汰**,
 * 淘汰时 dispose 掉一张还挂在 material.map 上的贴图,那块板子会直接变黑,而且不报错。
 */
const TEX_CACHE_MAX = 12;
const texCache = new Map<string, any>();
/** 此刻真的挂在板子上的那几个 URL。淘汰要绕开它们 */
const texInUse = new Set<string>();

function cacheTexture(url: string, tex: any) {
  // Map 保持插入顺序,重新 set 一次就等于把它挪到队尾 —— 最久没用的排在队头
  texCache.delete(url);
  texCache.set(url, tex);
  for (const k of [...texCache.keys()]) {
    if (texCache.size <= TEX_CACHE_MAX) break;
    if (texInUse.has(k)) continue;
    texCache.get(k)?.dispose?.();
    texCache.delete(k);
  }
}

interface Props {
  project: Project;
  /** 时间轴当前时刻(秒) */
  t: number;
}

export function Scene3DView({ project, t }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const streamHost = useRef<HTMLDivElement>(null);
  const selected = useStore((s) => s.selection[0]);
  const playing = useStore((s) => s.playing);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    setPlan3DView(true);
    return () => setPlan3DView(false);
  }, []);
  const [mods, setMods] = useState<[ThreeMod, OrbitMod] | null>(null);
  const [pending, setPending] = useState(0);
  /**
   * 正在渲哪一刻。有值 = 板子上现在是**色块**,这一刻的图还没渲出来。
   * 说出来是因为原来那个 bug 最坏的地方不是慢,是**沉默地显示另一个时刻** ——
   * 界面上写着 0.2 秒,板子上是 1.0 秒的画,没有任何提示。
   */
  const [bakingAt, setBakingAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /**
   * 要不要显示「2D 视角框」。默认关:大多数时候用户是来看卡怎么摆的,
   * 多一套线只会挡视线;要判断「这张卡在不在画面里」时才打开。
   *
   * 走 ref 是因为建场景那个 effect 不能把它放进依赖 —— 放进去点一下按钮就重建整个场景。
   * 显隐由渲染循环每帧读这个 ref 来切(和选中描边 selRef 同一套做法)。
   */
  const [frustumOn, setFrustumOn] = useState(false);
  const frustumRef = useRef(frustumOn);
  frustumRef.current = frustumOn;
  /*
   * 「这张卡长什么样」的指纹,只带**决定像素**的东西:哪张卡、什么参数、画布多大。
   * 不带 clipId 之外的身份信息也不带时刻 —— 它管的是**要不要重建场景**,不是贴哪张图。
   *
   * 只用 clipId 有两个错:换个项目 clipId 会重复(都是 c1 / n1 这种),新项目会看到上个项目的
   * 贴图;改了卡片参数之后 clipId 没变,贴图也不会更新,画面停在旧的样子还不报错。
   *
   * 位置和三维变换不在里面 —— 服务端预渲染的时候会把 frame 整个摘掉(见 bakeOne 的说明),
   * 所以转一下卡片、推一下深度,贴图一个像素都不会变。把整个 frame 塞进去的后果是:
   * 在「三维」面板里拖滑杆,每一格都算变了,于是每一格重建一次场景。
   */
  // 指纹只有一份实现(bakeCoverage.clipFingerprint)—— 进度条判断「这段覆盖还算不算数」
  // 用的也是它。两处各写一套的话会出现「条子说还有效、画面已经换了」,而且不报错。
  const texKey = clipFingerprint;
  /**
   * 要不要**重建整个场景**的指纹。只带真正决定**几何**的东西:
   * 哪几张卡、各自是什么卡、板子多大。`scene-3d` 还要带 params —— 它的几何
   * (形状、半径)就是参数算出来的;二维卡的板子只是一块 PlaneGeometry,和参数无关。
   *
   * **二维卡的 params 故意不在里面。** 它们只决定贴图长什么样,而换贴图走的是
   * `swap` / `proxy` 那条路,只改 material.map,不用重建。
   *
   * 放进来的后果实测过:拖一次滑杆连发十几次改动,就**重建十几次整个场景** ——
   * 每次都 new 一个 WebGLRenderer、再 forceContextLoss 掉旧的(浏览器上限约 16,
   * 超了静默丢最老的)。用户看到的就是画面卡住、改了半天毫无反馈。
   */
  const buildKey = (c: { id: string; cardId: string; params?: unknown; frame?: { w?: number; h?: number } | null }) => {
    const box = `${c.frame?.w ?? "-"}x${c.frame?.h ?? "-"}`;
    return c.cardId === "scene-3d"
      ? [c.id, c.cardId, box, JSON.stringify(c.params ?? {})].join("|")
      : [c.id, c.cardId, box].join("|");
  };
  /**
   * **播放头这一刻**该显示哪一刻预渲染出来的图,以及那张图的缓存键。
   *
   * 原来这里只有一个答案:片段中点。于是任何带动画的卡在 3D 里显示的都不是当前这一刻 ——
   * mu-number-ticker(滚动 1.6 秒)放在 [0,2],播放头 0.23 秒时 2D 是 81%,3D 是 100%。
   * 摆位置的人对着的是一张别的时刻的画面,而且不报错。选哪一刻的规则见 bakeTime.ts。
   */
  /*
   * 有原始帧率那一张就用它,没有才退回低帧率那一档。
   *
   * 不这么挑的话,逐帧预渲染出来的那几百张**一张都不会被显示** —— 显示端永远只问 0.25 秒
   * 那个格子要图,渲再多也是白烧。
   *
   * 退回低帧率仍然守着原来那条规矩:`pickBakeT` 只往回取(floor),所以看到的一定是
   * **已经发生过的**那一刻,最多差 0.25 秒,不会把还没播到的画面提前显示出来。
   */
  /** 播放头这一刻对应的**原始帧率**那一格 —— 也就是成片里真会出现的那一帧 */
  const fineTOf = (c: TimedClip) => {
    const motion = motionOf(getCard(c.cardId) as any, c.params);
    const fps = Math.max(1, projRef.current.fps || 30);
    return canonFrameT(pickBakeT(c, motion, t, { stepSec: 1 / fps }), c.start, fps);
  };
  const bakeTOf = (c: TimedClip) => {
    const fine = fineTOf(c);
    if (moments.current.has(texKeyOf(c, fine))) return fine;
    const motion = motionOf(getCard(c.cardId) as any, c.params);
    const fps = Math.max(1, projRef.current.fps || 30);
    return canonFrameT(pickBakeT(c, motion, t), c.start, fps);
  };
  const momentKey = (c: TimedClip) => texKeyOf(c, bakeTOf(c));
  /*
   * 播放头**停住**了没有。停住 = 用户在盯着这一帧看,那就值得把它自己那一帧渲出来。
   *
   * 为什么要分这一下:粗粒度那一档(黄条)是 0.25 秒一格的替身,拖动时它很划算 ——
   * 一张图管一片区域,拖过去不用每落一个位置就渲一次(单张四五秒)。但停下来之后它就
   * 不够了:实测播放头停在第 121 帧,三维要的是第 120 帧,和二维差整整一帧。
   * 拖动中不补(省渲染),停下来才补(要准),两头都占得住。
   */
  /*
   * 前台渲成功一次就 +1。**只有成功才加。**
   *
   * 要它是因为 momentSig 盯不住这件事:贴图缓存是个 ref,粗粒度那张落地之后 momentSig 一个字都没变
   * (bakeTOf 前后都返回同一个粗粒度时刻),效果不重跑,下面「停住了就预渲染重试精确帧」那条路就永远够不着。
   * 失败不加是防死循环:失败后要渲的还是那几张,加了就会一直重试。
   */
  const [bakeGen, setBakeGen] = useState(0);
  /**
   * 手还按在播放头上没有(见 timeline/useScrub 的 isScrubbing)。
   *
   * **按着的时候一张都不渲。** 拖动时播放头每跨过一个 0.25 秒的格子就换一个时刻,
   * 于是按着不放拖过去一路就是一串前台渲染,每一个都占住一个 Chrome 好几秒 ——
   * 而它们渲的全是用户一闪而过、根本没停下来看的位置。等用户真的松手停在某处,
   * 他要的那一张反而排在这堆注定作废的活后面。
   *
   * 用「松手」这个事件而不是防抖 N 毫秒:松手是明确的,不用猜多久算停下;
   * 而点一下卡尺跳过去(按下即松开)也不会因此多等一拍。
   */
  const scrubbing = useSyncExternalStore(subscribeScrub, isScrubbing, isScrubbing);
  const [parked, setParked] = useState(false);
  useEffect(() => {
    setParked(false);
    // 手还按着就不算「停住」——那时候连粗粒度那张都不该渲,更别说补精确帧
    if (scrubbing) return;
    const id = setTimeout(() => setParked(true), 500);
    return () => clearTimeout(id);
  }, [t, scrubbing]);
  /**
   * 按**时刻**存的贴图:`texKeyOf(clip, 那一刻)` → URL。前台现场渲染的和预渲染拿回来的都进这里,
   * 一个键只对应一张图,所以「板子上贴的到底是哪一刻」永远是确定的。
   *
   * 板子上只会出现这个表里、且键正好等于此刻 `momentKey(clip)` 的那一张。别的一律不贴 ——
   * 见下面 apply 的说明:贴一张别的时刻的真实画面,比贴一块色块糟得多。
   */
  const moments = useRef(new Map<string, string>());
  /** 场景那一套,和 scene-3d 卡一样要显式 dispose —— WebGL 资源不归 GC 管 */
  const gl = useRef<{ dispose: () => void; render: () => void } | null>(null);
  /**
   * 贴图到位后要能立刻换上去:clipId → 换图函数。
   *
   * 第二个参数是「这张图确实是此刻该显示的那一刻」。**不带这个标记的一律不上板子** ——
   * 调用方必须先自己对过账,不能指望「随便一张总比色块强」。
   */
  const swap = useRef(new Map<string, (url: string, precise?: boolean) => void>());
  /** 把板子打回色块:clipId → 复位函数。换到了没渲过的时刻就立刻退回去,不留着旧图冒充 */
  const proxy = useRef(new Map<string, () => void>());
  /** 三维物件每帧要按 t 摆姿势(会转的那种)。渲染循环里调,所以要读最新的 t */
  const posers = useRef<((t: number) => void)[]>([]);
  /**
   * 用户转到哪儿了。**跨场景重建保留** —— 这是「拖时间轴相机会弹回去」的修复点。
   *
   * 建场景那个 effect 的依赖里有 `sig`,而 `sig` 是「**这一刻**有哪些卡」算出来的。
   * `t` 已经刻意排除在依赖外了,但 `sig` 会**随时间间接变化**:拖过任意一条 clip 边界,
   * 活跃的卡就换了一批,effect 整段重跑,`new PerspectiveCamera` + `new OrbitControls`
   * 把机位打回默认 —— 用户刚转好的视角,一拖进度条就没了。
   *
   * 存在 ref 里而不是 state:它每次拖动都在变,进 state 会引起重渲染,而这个值
   * 只有重建场景那一刻才被读一次。
   */
  const pose = useRef<{ pos: [number, number, number]; target: [number, number, number] } | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  // 选中变了不该重建场景(重建 = 重新加载所有贴图),所以也走 ref
  const selRef = useRef(selected);
  selRef.current = selected;
  /*
   * 摆位每帧从最新的 project 读,不进建场景那个 effect 的依赖。
   * 否则在「三维」面板里拖一下滑杆就重建一次整个场景(几何全部重建、贴图全部重新加载),
   * 而拖动是连续的 —— 一次拖动几十次重建。
   */
  const projRef = useRef(project);
  projRef.current = project;
  /*
   * 整条片子要预渲染哪几个时刻。**按每张卡自己的动画节奏抽样**(sampleTimesFor),
   * 不是一段一张中点 —— 中点那张多半不是用户正看的那一刻,那正是「3D 里显示的不是当前帧」的病根。
   *
   * 只算一次(project 没变就不重算):这个列表每轮调度都要用,而它只跟项目内容有关,
   * 和播放头无关 —— 播放头只决定**先渲哪个**,那是 bakePlan 的事。
   */
  const wantedMoments = useMemo(() => {
    const out: { clipId: string; t: number; start: number; end: number; tier: "coarse" | "full"; fine: boolean }[] = [];
    const fps = Math.max(1, project.fps || 30);
    for (const c of flattenOverlay(project).clips) {
      // 素材段本来就是位图,不用渲;scene-3d 在这个视图里是真几何,也不用
      if ((c as any).mediaId || c.cardId === "scene-3d") continue;
      const motion = motionOf(getCard(c.cardId) as any, c.params);
      /*
       * 按**量化后的时刻**去重:0.5 秒这种点在两档的格子上都有,不去重会重复排一遍,
       * 而且服务端算出来是同一个键,白问一次。
       */
      const slots = new Map<number, { t: number; tier: "coarse" | "full"; fine: boolean }>();
      // 低帧率那一档(0.25 秒一格):先把整条片子铺满它,成本只有原始帧率的零头
      for (const raw of sampleTimesFor(c as TimedClip, motion)) {
        const t = canonFrameT(raw, c.start, fps);
        slots.set(t, { t, tier: "coarse", fine: false });
      }
      /*
       * 原始帧率那一档:逐帧。**排在低帧率全部铺完之后**才会被渲(顺序由 bakePlan 定)。
       * maxPerClip 按这一段自己的帧数给,不用默认的 12 —— 默认那个是为低帧率定的,
       * 拿它来限制逐帧会把一段两秒的卡抽稀成 12 张,那就不叫原始帧率了。
       */
      const frames = Math.ceil((c.end - c.start) * fps) + 2;
      for (const raw of sampleTimesFor(c as TimedClip, motion, { stepSec: 1 / fps, maxPerClip: frames })) {
        const t = canonFrameT(raw, c.start, fps);
        const had = slots.get(t);
        // 两档都落在这一刻:排队上算低帧率(先渲),但它同时也是逐帧那一档的一格
        if (had) had.fine = true;
        else slots.set(t, { t, tier: "full", fine: true });
      }
      for (const s of slots.values()) out.push({ clipId: c.id, start: c.start, end: c.end, ...s });
    }
    return out;
  }, [project]);
  /*
   * 空闲时把这些时刻预先渲好(排队规则见 bakePlan.ts)。
   * 这个视图挂着的时候才开:预渲染一张要起一个 Chrome、四五秒,
   * 没打开三维页的人不该为它一直付这笔账。
   */
  const prefetch = useBakePrefetch({ project, t, moments: wantedMoments, enabled: !playing });

  useEffect(() => {
    let dead = false;
    loadMods().then((m) => { if (!dead) setMods(m); }).catch((e) => setErr(String(e?.message || e)));
    return () => { dead = true; };
  }, []);

  const timeline = flattenOverlay(project);
  const active = timeline.clips.filter((c) => t >= c.start && t < c.end);
  // 这一刻有哪些卡、各自长什么样 —— 变了才重建场景。**故意不带时刻**:
  // 带上的话在一段卡里拖时间轴,每跨一格就重建一次整个场景(几何全建、贴图全重载、
  // 还要新开一个 WebGL 上下文,浏览器上限约 16)。换时刻只换 material.map,不必重建。
  const sig = active.map(buildKey).join("|");
  // 该显示哪几刻。变了只重新取图,不重建场景
  const momentSig = active.map(momentKey).join("|");

  /* ── 建场景 ───────────────────────────────────────────────────── */
  useEffect(() => {
    const el = host.current;
    if (!mods || !el) return;
    const [THREE, { OrbitControls }] = mods;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    const stage = { width: project.width, height: project.height };

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
    el.replaceChildren(renderer.domElement);

    const scene = new THREE.Scene();
    /*
     * 相机的**初始**位置就是成片的机位(space3d 那台),所以一打开看到的和 2D 视图一样;
     * 之后 OrbitControls 让你从这里转出去。有这个起点,"转偏了"随时能对回来。
     */
    const cam = cameraFor(stage, project.camera3dFov ?? DEFAULT_FOV_DEG);
    const camera = new THREE.PerspectiveCamera(cam.fovDeg, w / h, 1, cam.distance * 40);
    // 转过就接着用上次的机位,没转过才用成片那台的位置(见 pose 那个 ref 的说明)
    camera.position.set(...(pose.current?.pos ?? cam.position));

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(...(pose.current?.target ?? [0, 0, 0]));
    controls.enableDamping = true;
    // 用户一转就记下来。OrbitControls 的 change 在每次相机被它改动时触发,
    // 包括阻尼滑行的那几帧,所以松手后的最终位置一定记的是最后那一下。
    controls.addEventListener("change", () => {
      pose.current = {
        pos: camera.position.toArray() as [number, number, number],
        target: controls.target.toArray() as [number, number, number],
      };
    });
    controls.update();

    scene.add(new THREE.AmbientLight(0xffffff, 2.2));

    /*
     * 屏幕平面(z=0)的轮廓。没有它就完全没有参照 —— 转两下就不知道哪边是"正面"了。
     * 画成线框而不是实面:实面会挡住 z 为负的卡。
     */
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(stage.width, stage.height)),
      new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.5 }),
    );
    scene.add(edge);

    const disposables: { dispose: () => void }[] = [edge.geometry, edge.material as any];

    /*
     * 「2D 视角框」:一个**尖在 2D 那台相机、底在画幅**的四角锥(几何见 frustum2d.ts)。
     *
     * 上面那圈 `edge` 只说了「画幅在这个平面上」,没说**是从哪儿看过去的** ——
     * 而转两下之后,"这张卡到底在不在画面里"恰恰要靠视线方向才判断得了。
     *
     * 整个锥八条线**同一个琥珀色**:底面四条边和四条棱是一样东西的两部分,
     * 分成两个颜色会让人以为是两样东西。琥珀和选中描边的青(0x22d3ee)、
     * 画幅轮廓的灰蓝(0x64748b)都分得开。
     *
     * **建一次就放着,用 visible 开关**,不进 effect 依赖:进依赖的话点一下按钮就要
     * 重建整个场景 —— 几何全建、贴图全重载,还新开一个 WebGL 上下文(上限约 16)。
     */
    const frustum = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(frustum2d(stage, project.camera3dFov).positions, 3),
      ),
      new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.9 }),
    );
    frustum.visible = frustumRef.current;
    scene.add(frustum);
    disposables.push(frustum.geometry, frustum.material as any);
    swap.current = new Map();
    proxy.current = new Map();

    /* 轨道流播放器：从隐藏画布中解码并获取各卡片轨道流 */
    const player = new StreamPlayer({
      root: () => streamHost.current,
      ...(ONLINE ? { source: new PushedStreamSource() } : {}),
    });
    disposables.push({ dispose: () => player.stop() });

    const boards: {
      clipId: string;
      mesh: any;
      mat: any;
      pl: any;
      canvas: HTMLCanvasElement | null;
      canvasTex: any;
      cropped: boolean;
      boundSig: string;
      mode: "proxy" | "stream" | "exact";
    }[] = [];

    const cropToCanvasBound = (b: typeof boards[number], cv: HTMLCanvasElement) => {
      const W = b.pl.size.width;
      const H = b.pl.size.height;
      const bx = parseFloat(cv.style.left) || 0;
      const by = parseFloat(cv.style.top) || 0;
      const bw = cv.width || W;
      const bh = cv.height || H;
      const sig = `${bx},${by},${bw},${bh}`;
      if (b.boundSig === sig && b.cropped) return;
      b.boundSig = sig;

      const nextGeo = new THREE.PlaneGeometry(bw, bh);
      const old = b.mesh.geometry;
      b.mesh.geometry = nextGeo;
      old.dispose();
      disposables.push(nextGeo);

      const dx = (bx + bw / 2) - W / 2;
      const dy = H / 2 - (by + bh / 2);
      b.mesh.position.set(b.pl.meshOffset[0] + dx, b.pl.meshOffset[1] + dy, b.pl.meshOffset[2]);
      b.cropped = true;
    };

    posers.current = [];
    // 拾取用:每块 mesh 记住它属于哪个 clip(three 的 userData 就是干这个的)
    const pickables: any[] = [];
    // 摆位每帧重算,所以要留着这几个 group 的引用
    const placed: { clipId: string; pivot: any; inner: any; spin: any; tilt: any; mesh: any }[] = [];

    /*
     * 画家序的序号。**谁盖住谁只看序列顺序,不看 Z** —— 这是成片那边写死的约定。
     *
     * 成片(Stage.tsx)故意**不加** `transform-style: preserve-3d`,那里有实测三行表:
     * 加了它,兄弟卡片就从「按 DOM 顺序叠」变成「按 z 深度排序」,于是 Agent 把最上层的卡
     * 往里推一点(translateZ 负值)会立刻被下面所有卡盖住 —— 和工具描述承诺的相反。
     *
     * 而这个视图里,板子材质是 transparent,three.js 对透明队列走 reversePainterSortStable:
     * 没有 renderOrder 就**按 z 排**,而 `tilt.position.z = pl.translateZ` 让卡片本来就各有各的 z。
     * 也就是说这里以前是让 translateZ 主导遮挡的,正好和成片相反,而且不报错。
     * 显式钉上画家序,两边才是同一套规矩。
     */
    let order = 0;

    for (const clip of active) {
      // 正负号全在 place3d.ts 里,那边有单测钉着(见它的说明)
      const pl = placeClip3D(clip.frame, stage);
      const renderOrder = order++;

      // 摆位那一串 group 是共用的:平板和真三维物件都挂在它里面
      const pivot = new THREE.Group();
      pivot.position.set(...pl.pivot);
      // 从里到外:roll → scale → spin → tilt → 平移,和 frameCss 的顺序一致
      const inner = new THREE.Group();
      inner.rotation.z = pl.rollZ;
      inner.scale.setScalar(pl.scale);
      const spin = new THREE.Group();
      spin.add(inner);
      spin.rotation.y = pl.spinY;
      const tilt = new THREE.Group();
      tilt.add(spin);
      tilt.rotation.x = pl.tiltX;
      tilt.position.z = pl.translateZ;
      pivot.add(tilt);
      scene.add(pivot);
      placed.push({ clipId: clip.id, pivot, inner, spin, tilt, mesh: null });

      const def = getCard(clip.cardId);

      /*
       * 三维的卡在这里就是**真的三维**,不糊贴图。
       * 用的是卡片同一份构造(scene3dObject.ts):同样的几何、材质、灯光预设、姿势公式。
       * 灯挂在这个物件自己的 group 上,所以同屏几个三维卡各带各的灯,各自和成片对得上。
       */
      if (clip.cardId === "scene-3d" && def) {
        const params = { ...def.defaults, ...clip.params } as Scene3DParams;
        const geo = geometryOf(THREE, shapeOf(params.shape), radiusFor(params, pl.size.height));
        const mat = materialOf(THREE, params);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(...pl.meshOffset);
        // 不带贴图时它是不透明的(走 opaque 队列、自己写深度),renderOrder 只影响绘制先后不影响结果;
        // 一旦 applyTexture 把它转成 transparent,就和板子排在同一个队列里,这时候这一行是必须的
        mesh.renderOrder = renderOrder;
        inner.add(mesh);
        mesh.userData.clipId = clip.id;
        pickables.push(mesh);
        disposables.push(geo, mat);

        // 灯的距离尺度照抄卡片:它用的是自己画布那台相机的距离
        const camD = cameraFor({ width: pl.size.width, height: pl.size.height }, params.fov > 0 ? params.fov : (project.camera3dFov ?? DEFAULT_FOV_DEG)).distance;
        addLights(THREE, inner, params.light, camD);

        if (params.texture) {
          const tex = applyTexture(THREE, mat, params.texture, () => renderer.render(scene, camera));
          if (tex) disposables.push(tex);
        }

        // 会转的物件要跟着时间轴走 —— 姿势是「相对这张卡起点」的秒数的纯函数
        const start = clip.start;
        posers.current.push((now: number) => poseMesh(mesh, params, Math.max(0, now - start)));
        poseMesh(mesh, params, Math.max(0, t - start));
        continue;
      }

      /* 二维的卡:一块贴着「预渲染出来的真图」的板子 */
      const geo = new THREE.PlaneGeometry(pl.size.width, pl.size.height);
      const mat = new THREE.MeshBasicMaterial({
        color: PROXY_COLOR,
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(...pl.meshOffset);
      mesh.renderOrder = renderOrder;   // 见上面「画家序」那段
      inner.add(mesh);
      mesh.userData.clipId = clip.id;
      pickables.push(mesh);
      disposables.push(geo, mat);

      // 轨道流画布与纹理
      const canvas = streamHost.current?.querySelector<HTMLCanvasElement>(
        `[data-pc-clip="${CSS.escape(clip.id)}"] > canvas[data-pc-stream-plane]`,
      );
      let canvasTex: any = null;
      if (canvas) {
        canvasTex = new THREE.CanvasTexture(canvas);
        canvasTex.colorSpace = THREE.SRGBColorSpace;
        canvasTex.minFilter = THREE.LinearFilter;
        canvasTex.magFilter = THREE.LinearFilter;
        canvasTex.generateMipmaps = false;
        disposables.push(canvasTex);
      }

      const boardState: {
        clipId: string;
        mesh: any;
        mat: any;
        pl: any;
        canvas: HTMLCanvasElement | null;
        canvasTex: any;
        cropped: boolean;
        boundSig: string;
        mode: "proxy" | "stream" | "exact";
      } = {
        clipId: clip.id,
        mesh,
        mat,
        pl,
        canvas: canvas ?? null,
        canvasTex,
        cropped: false,
        boundSig: "",
        mode: "proxy",
      };
      boards.push(boardState);

      /** 这块板子此刻挂着哪张贴图。贴图缓存淘汰时要绕开正在用的,靠它记账 */
      let boundUrl: string | null = null;

      /*
       * **只贴当前这一刻的图,别的一律退回色块。**
       *
       * 一度写成「精确的那张没到就先拿预渲染那张垫着,总比一块灰色色块强」——那是错的。
       * 垫上去的是另一个时刻的真实画面,它长得和成片一模一样,没人看得出它是垫的;
       * 而色块**自明**地不是成品(和实体模式同一条道理,见 render/solidMode.ts)。
       * 一张看着像真的、其实是别的时刻的画面,会被当成这一刻的依据传下去 ——
       * 那正是「界面上 0.2 秒、板子上 1.0 秒」这个 bug 的本体,换个时刻再犯一遍没有意义。
       */
      /*
       * **把整屏的板子裁成内容那一块。**
       *
       * 绝大多数卡没写 frame.w/h,它们的框就是整幅舞台 —— 于是每块板子都是屏幕大小、
       * 外形一模一样,里面 70~90% 是全透明的。一摞这样的透明片摆在空间里,
       * 「东西是怎么摆的」根本看不出来,而那正是这个视图存在的理由。
       *
       * 内容框从**贴图自己**量(alpha 包围盒)。预渲染的排版尺寸修对之后,贴图画布和卡片的框
       * 是 1:1 的,所以量出来的相对位置直接就是「四个角在这张卡的框里的位置」——
       * 拿它从这块屏幕平面上裁一小块,再把贴图的对应区域映上去,位置天然是对的。
       *
       * 量不出来、或者本来就铺满(满屏渐变底那种)就保持整块 —— 那种卡**就该**是一整块板子。
       */
      const cropToContent = (tex: any) => {
        const box = measureImageBox(tex.image);
        const W = pl.size.width, H = pl.size.height;
        boardState.boundSig = "";
        if (!worthCropping(box) || !box) {
          if (boardState.cropped) {
            const nextGeo = new THREE.PlaneGeometry(W, H);
            const old = mesh.geometry;
            mesh.geometry = nextGeo;
            old.dispose();
            disposables.push(nextGeo);
            mesh.position.set(...pl.meshOffset);
            tex.repeat.set(1, 1);
            tex.offset.set(0, 0);
            tex.needsUpdate = true;
            boardState.cropped = false;
          }
          return;
        }
        const nextGeo = new THREE.PlaneGeometry(W * box.w, H * box.h);
        const old = mesh.geometry;
        mesh.geometry = nextGeo;
        old.dispose();
        disposables.push(nextGeo);
        /*
         * 把板子挪到内容框的中心。平面自己是以原点为中心的,而内容框多半不在正中,
         * 不挪的话贴图看着就整体偏了 —— 这一步和 UV 那一步必须成对,少一个都会错位。
         */
        const dx = (box.x + box.w / 2) * W - W / 2;
        const dy = H / 2 - (box.y + box.h / 2) * H;   // three 的 y 朝上,图片坐标朝下
        mesh.position.set(pl.meshOffset[0] + dx, pl.meshOffset[1] + dy, pl.meshOffset[2]);
        // 贴图只显示这一块。three 的 UV 原点在左下,所以 y 要翻过来
        tex.repeat.set(box.w, box.h);
        tex.offset.set(box.x, 1 - box.y - box.h);
        tex.needsUpdate = true;
        boardState.cropped = true;
      };

      /** 贴上去之后的收尾:裁到内容框、恢复成不透明的白底(色块那一套的反操作) */
      const dressUp = (tex: any) => {
        cropToContent(tex);
        mat.color.set(0xffffff);
        mat.opacity = 1;
        renderer.render(scene, camera);
      };
      const apply = (url: string, precise = false) => {
        if (!precise) return; // 预渲染那条路不带时刻,它给的图只进缓存,不上板子
        boundUrl = url;
        texInUse.add(url);
        boardState.mode = "exact";
        /*
         * **解码过的直接贴,不再走一遍 TextureLoader。**
         *
         * 这一条就是「两张卡之间闪一下色块」的根治:跨过卡片边界时整个场景重建,
         * 每块板子都是新的 material,而异步加载哪怕命中 HTTP 缓存也要一两帧才回来 ——
         * 那一两帧里板子是 PROXY_COLOR 的色块。命中这里就在同一帧贴完,中间没有空档。
         */
        const hit = texCache.get(url);
        if (hit) {
          mat.map = hit;
          // 预渲染出来的卡是透明底,不开 transparent 四周会变成黑块(和 applyTexture 里同一个理由)
          mat.transparent = true;
          mat.needsUpdate = true;
          cacheTexture(url, hit); // 挪到队尾:它是最近用过的
          dressUp(hit);
          return;
        }
        applyTexture(THREE, mat, url, (loaded: any) => {
          cacheTexture(url, loaded);
          dressUp(loaded);
        });
        /*
         * **不进 disposables。** 贴图的所有权归上面那个缓存,场景重建时连它一起 dispose 掉的话,
         * 下一次重建又得重新解码,缓存就白做了;更糟的是别的板子可能正挂着同一张
         * (相对键之后,同一张卡的两个副本共用同一个文件),dispose 会让那块板子直接变黑。
         */
      };
      /** 退回色块:这一刻的图还没渲出来,或者换到了别的时刻;若流画面可用则保持流画面过渡 */
      const toProxy = () => {
        if (boundUrl) { texInUse.delete(boundUrl); boundUrl = null; }
        if (player.showingClips().has(clip.id) && canvasTex && canvas) {
          cropToCanvasBound(boardState, canvas);
          canvasTex.repeat.set(1, 1);
          canvasTex.offset.set(0, 0);
          canvasTex.needsUpdate = true;
          mat.map = canvasTex;
          mat.color.set(0xffffff);
          mat.opacity = 1;
          mat.transparent = true;
          mat.needsUpdate = true;
          boardState.mode = "stream";
          renderer.render(scene, camera);
          return;
        }
        if (boardState.cropped) {
          const nextGeo = new THREE.PlaneGeometry(pl.size.width, pl.size.height);
          const old = mesh.geometry;
          mesh.geometry = nextGeo;
          old.dispose();
          disposables.push(nextGeo);
          mesh.position.set(...pl.meshOffset);
          boardState.cropped = false;
          boardState.boundSig = "";
        }
        boardState.mode = "proxy";
        if (!mat.map) return;
        mat.map = null;
        mat.color.set(PROXY_COLOR);
        mat.opacity = 0.45;
        mat.needsUpdate = true;
        renderer.render(scene, camera);
      };
      swap.current.set(clip.id, apply);
      proxy.current.set(clip.id, toProxy);
      const exact = moments.current.get(momentKey(clip));
      if (exact) apply(exact, true);
    }

    /*
     * 点选。用射线打中的第一块 mesh,把它的 clip 设成选中 —— 选中之后左边的编辑面板
     * 就是这张卡,可以直接拧「三维」那三个旋钮,所以这一页从"能看"变成"能摆"。
     *
     * 要和 OrbitControls 共存:转视角也是按下+拖动。所以按下时记位置,
     * 松开时只有几乎没动过(< 4px)才当成点击 —— 否则转个视角就把选中改掉了。
     */
    const raycaster = new THREE.Raycaster();
    let downAt: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { downAt = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 4) return;
      const r = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(pickables, false)[0];
      // 点空白处不清选中:清了的话在 3D 页随手一点就丢了左边正在编辑的那张卡
      const id = hit?.object?.userData?.clipId;
      if (id) actions.select([id]);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    /* 选中的那块描一圈边:不改它自己的材质,另加一个线框子物体,取消选中直接删掉 */
    const marks = new Map<string, any>();
    for (const m of pickables) {
      const box = new THREE.BoxHelper(m, 0x22d3ee);
      box.visible = false;
      scene.add(box);
      marks.set(m.userData.clipId, box);
      disposables.push(box.geometry, box.material as any);
    }

    let lastPlanesSig = "";
    const activeIds = new Set(active.filter((c) => c.cardId !== "scene-3d").map((c) => c.id));

    let raf = 0;
    const tick = () => {
      controls.update();

      // 轨道流与 3D 板子同步
      const ready = currentReadyIndex();
      const fps = Math.max(1, projRef.current.fps || 30);
      const streamPlanes: StreamPlaneRequest[] = [];
      for (const [cId, kinds] of ready) {
        if (!activeIds.has(cId)) continue;
        const layer = kinds.get("stream");
        if (!layer || !isStreamOrigin(layer.originFrame) || !layer.key) continue;
        streamPlanes.push({
          clipIds: [cId],
          key: layer.key,
          ranges: layer.ranges.map((r: any) => [r[0], r[1]]),
          originFrame: layer.originFrame,
        });
      }
      const planesSig = streamPlanes.map((p) => `${p.clipIds[0]}:${p.key}:${p.ranges?.length ?? 0}`).join(";");
      if (planesSig !== lastPlanesSig) {
        lastPlanesSig = planesSig;
        player.setPlanes(streamPlanes, fps);
      }
      player.present(tRef.current);
      const showing = player.showingClips();

      const isPlay = playingRef.current;
      for (const b of boards) {
        if (isPlay) {
          if (showing.has(b.clipId) && b.canvasTex && b.canvas) {
            cropToCanvasBound(b, b.canvas);
            if (b.mode !== "stream") {
              b.canvasTex.repeat.set(1, 1);
              b.canvasTex.offset.set(0, 0);
              b.mat.map = b.canvasTex;
              b.mat.color.set(0xffffff);
              b.mat.opacity = 1;
              b.mat.transparent = true;
              b.mat.needsUpdate = true;
              b.mode = "stream";
            }
            b.canvasTex.needsUpdate = true;
          } else {
            if (b.mode !== "proxy") {
              if (b.cropped) {
                const nextGeo = new THREE.PlaneGeometry(b.pl.size.width, b.pl.size.height);
                const old = b.mesh.geometry;
                b.mesh.geometry = nextGeo;
                old.dispose();
                disposables.push(nextGeo);
                b.mesh.position.set(...b.pl.meshOffset);
                b.cropped = false;
                b.boundSig = "";
              }
              b.mat.map = null;
              b.mat.color.set(PROXY_COLOR);
              b.mat.opacity = 0.45;
              b.mat.transparent = true;
              b.mat.needsUpdate = true;
              b.mode = "proxy";
            }
          }
        } else {
          // 暂停态：如果已有精确 PNG 快照，保持 exact；
          // 如果还没有 exact 快照，但流画面可用，保持流画面过渡；
          // 两者都没有则显示半透明占位色块
          if (b.mode === "exact") {
            // 已有精确 PNG 快照，保持
          } else if (showing.has(b.clipId) && b.canvasTex && b.canvas) {
            cropToCanvasBound(b, b.canvas);
            if (b.mode !== "stream") {
              b.canvasTex.repeat.set(1, 1);
              b.canvasTex.offset.set(0, 0);
              b.mat.map = b.canvasTex;
              b.mat.color.set(0xffffff);
              b.mat.opacity = 1;
              b.mat.transparent = true;
              b.mat.needsUpdate = true;
              b.mode = "stream";
            }
            b.canvasTex.needsUpdate = true;
          } else if (b.mode !== "proxy") {
            if (b.cropped) {
              const nextGeo = new THREE.PlaneGeometry(b.pl.size.width, b.pl.size.height);
              const old = b.mesh.geometry;
              b.mesh.geometry = nextGeo;
              old.dispose();
              disposables.push(nextGeo);
              b.mesh.position.set(...b.pl.meshOffset);
              b.cropped = false;
              b.boundSig = "";
            }
            b.mat.map = null;
            b.mat.color.set(PROXY_COLOR);
            b.mat.opacity = 0.45;
            b.mat.transparent = true;
            b.mat.needsUpdate = true;
            b.mode = "proxy";
          }
        }
      }
      // 会转的三维物件跟着时间轴走:姿势是 t 的纯函数,所以每帧照着当前 t 摆一次就行
      /*
       * 每帧按最新的 project 重摆一次。开销就是几个矩阵,但换来的是:
       * 在「三维」面板里拖滑杆时场景**不重建** —— 不重建就不会重新造几何、
       * 不会重新加载贴图,拖起来是连续的。
       */
      for (const q of placed) {
        const c = projRef.current.tracks.flatMap((tr: any) => tr.clips).find((x: any) => x.id === q.clipId);
        if (!c) continue;
        const pl2 = placeClip3D(c.frame, { width: projRef.current.width, height: projRef.current.height });
        q.pivot.position.set(...pl2.pivot);
        q.inner.rotation.z = pl2.rollZ;
        q.inner.scale.setScalar(pl2.scale);
        q.spin.rotation.y = pl2.spinY;
        q.tilt.rotation.x = pl2.tiltX;
        q.tilt.position.z = pl2.translateZ;
      }
      for (const pose of posers.current) pose(tRef.current);
      for (const [id, box] of marks) { box.visible = id === selRef.current; if (box.visible) box.update(); }
      /*
       * 视角框只切显隐,不重建场景(理由见上面建它的地方)。
       *
       * 开着的时候把灰色那圈 `edge` 收起来:锥的底面和它是**同一个矩形**,
       * 两条线重叠在一起会打架(深度一样,谁在上面看显卡心情),而且一圈灰一圈黄
       * 也不该是两个颜色。开了就整个锥都是黄的,关了再把灰圈放回来当常驻参照。
       */
      frustum.visible = frustumRef.current;
      edge.visible = !frustumRef.current;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    // 这个视图是给人转着看的,不进导出,所以用真的 rAF 没有确定性问题
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(() => {
      const nw = Math.max(1, el.clientWidth);
      const nh = Math.max(1, el.clientHeight);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh, false);
    });
    ro.observe(el);

    gl.current = {
      render: () => renderer.render(scene, camera),
      dispose: () => {
        cancelAnimationFrame(raf);
        renderer.domElement.removeEventListener("pointerdown", onDown);
        renderer.domElement.removeEventListener("pointerup", onUp);
        ro.disconnect();
        controls.dispose();
        /*
         * 这一场的板子全没了,所以「正在用的贴图」清空 —— 不清的话这些 URL 会永远挡着淘汰,
         * 缓存只进不出,显存一路涨。贴图本身不在 disposables 里(所有权归 texCache)。
         */
        texInUse.clear();
        for (const d of disposables) d.dispose?.();
        renderer.dispose();
        // dispose() 不释放 WebGL 上下文,浏览器上限约 16,超了静默丢最老的(和 scene-3d 同一个坑)
        renderer.forceContextLoss();
        renderer.domElement.remove();
      },
    };
    return () => { gl.current?.dispose(); gl.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // t 故意不在依赖里:姿势由渲染循环按 tRef 每帧更新,进依赖会让整个场景每帧重建
  }, [mods, sig, project.width, project.height, project.camera3dFov]);

  /* ── 换到哪一刻就贴哪一刻;没有的先退回色块,再去渲 ─────────────── */
  useEffect(() => {
    // 播放中不发前台渲染请求，贴图直接从轨道流走；拖动中也不发
    if (playing || scrubbing) { setPending(0); setBakingAt(null); return; }
    /*
     * 只给**二维的卡**要贴图。scene-3d 那种在这个视图里是真几何,不需要贴图 ——
     * 一开始没排除它,结果每开一次都白渲一张(单张 4.7~6.5 秒),而且渲出来根本没人用。
     */
    const flat = active.filter((c) => c.cardId !== "scene-3d");
    const need: typeof flat = [];
    for (const c of flat) {
      const url = moments.current.get(momentKey(c));
      // 有这一刻的就贴上(这条也覆盖「拖回刚才那一刻」:缓存命中,一张都不用重渲)
      if (url) swap.current.get(c.id)?.(url, true);
      // 没有就打回色块（或留着流画面过渡），并记录需要渲染
      else { proxy.current.get(c.id)?.(); need.push(c); }
    }
    /*
     * 这一轮要渲哪些、各渲哪一刻。两种情形:
     *   need 非空 —— 板子上现在是色块,按 bakeTOf 渲。那可能是粗粒度那一档(0.25 秒一格),
     *                拖动时这很划算:一张图管一片区域,不用每落一个位置就渲四五秒。
     *   need 为空、但播放头**停住**了 —— 画面已经有了,可它可能只是那个替身。
     *                用户在盯着看,预渲染重试播放头自己那一帧(实测停在第 121 帧时,
     *                三维拿的是第 120 帧,和二维差整整一帧)。
     * 拖动中不补(省渲染),停住才补(要准)。
     */
    /*
     * **手还按着就到此为止:贴图照换(缓存里有的立刻贴上),但一张都不渲。**
     *
     * 上面那个循环已经把该贴的贴了、该打回色块的打回了 —— 那是免费的。往下才是花钱的部分:
     * 拖过去的每一个格子都发一次渲染,每个占住一个 Chrome 好几秒,而它们渲的都是
     * 用户一闪而过的位置。松手之后 scrubbing 变 false,这个 effect 会立刻再跑一遍,
     * 那时才真的开渲 —— 用户停在哪儿就渲哪儿,一次都不浪费。
     */
    if (scrubbing) { setPending(0); setBakingAt(null); return; }
    const asks = need.length
      ? need.map((c) => ({ clip: c, at: bakeTOf(c) }))
      : parked
        ? flat.filter((c) => !moments.current.has(texKeyOf(c, fineTOf(c)))).map((c) => ({ clip: c, at: fineTOf(c) }))
        : [];
    if (!asks.length) {
      /*
       * 一张都不用渲(拖回了已经预渲染的地方)。**这里必须把「正在渲」清掉** ——
       * 上一次的 effect 是被 cleanup 掐掉的(dead),它 finally 里那句清理带着 `!dead` 判断,
       * 所以不会执行。不在这儿清的话,画面已经好了,提示却一直挂着"正在渲第 X 秒"。
       */
      setPending(0);
      setBakingAt(null);
      return;
    }
    let dead = false;
    setPending(asks.length);
    setBakingAt(asks[0].at);
    /*
     * **换到别的时刻就把上一次的请求掐掉。**
     *
     * 不掐的后果实测过:在没预渲染的区域连着挪 8 次播放头,发出 9 个前台渲染请求、
     * 同时有 4 个挂着。而浏览器对同一个源只给约 6 条连接 —— 挂满之后,
     * **连取一张已经渲好的贴图的 GET 都排不进去**,于是"拖回已经预渲染的地方也不刷新,
     * 非要等前面那个没渲完的先完成"。
     *
     * 掐掉不浪费:服务端那边不会因此停手,而且同键并发是合并的(见 bakeOne 的 bakeInFlight),
     * 图照样会落盘。下次要它的时候直接命中缓存。
     */
    const ac = new AbortController();
    /*
     * 告诉预渲染让路。服务端渲染是串行的,预渲染要是正占着,这一张 —— 用户此刻正盯着的那张 ——
     * 就得排在它后面多等四五秒。本来是来提速的,反而卡了一下。
     */
    beginForegroundBake();
    (async () => {
      try {
        /*
         * 前台渲染走**编辑器自己的常驻热备渲染器**(两台 Chrome 轮换,见 vite-plugin-vision 的 uiRenderer),
         * 不进预渲染池:用户正盯着的这一张最高优先级,一毫秒都不该排在 Agent 或预渲染后面。
         */
        const res = await fetch("/api/ui-render/bake-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project,
            // 要的是**播放头这一刻**吸附到格子上的那一刻,不是片段中点(见 bakeTime.ts)
            clips: asks.map((a) => ({ clipId: a.clip.id, t: a.at })),
            size: 1024,
            /*
             * 插队。用户正盯着这块板子等它变成真图,而队里可能排着一长串没人等的预渲染 ——
             * 不插队实测要 19.5 秒才出画面,插了队最坏只等正在跑的那一个(约 5 秒)。
             */
            priority: 1,
          }),
          signal: ac.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          if (dead) return;
          throw new Error(data.error || `渲染失败(HTTP ${res.status})`);
        }
        for (const b of data.baked ?? []) {
          const a = asks.find((x) => x.clip.id === b.clipId);
          /*
           * **渲出来的一定进缓存,哪怕播放头已经挪走了**(dead)。花了四五秒渲的这一张,
           * 键就是「那一刻」,扔掉的话拖回去还得再等一遍。
           * 但只有播放头还停在这一刻时才往板子上贴 —— 挪走了还贴,贴的就是别的时刻的画面。
           */
          // 存到**我们要的那一刻**上,不是 momentKey —— 预渲染重试精确帧时这两个键不是同一个
          if (a) moments.current.set(texKeyOf(a.clip, a.at), b.url);
          // 存完再算 momentKey:精确帧一进缓存,bakeTOf 就改口选它,这里正好对上、换上去
          if (!dead && a && texKeyOf(a.clip, a.at) === momentKey(a.clip)) swap.current.get(b.clipId)?.(b.url, true);
          /*
           * **同时告诉时间轴那条进度条。**
           *
           * 前台现场渲染和空闲预渲染是两条路,而覆盖表原来只有预渲染那条会写。于是前台渲完、
           * 画面已经换成真图了,时间轴上那一段还是空的 —— 要等下一轮盘点(最长几秒)才补上,
           * 看起来就是"条子慢半拍"。这里补一句,两条路就都记账了。
           */
          markBaked([momentId(b.clipId, a ? a.at : b.t)]);
        }
        if (dead) return;
        // 渲成了就让这个 effect 再跑一轮:刚落地的可能只是粗粒度那张,停住时还要补精确帧
        if (data.baked?.length) setBakeGen((g) => g + 1);
        if (data.failed?.length) setErr(`${data.failed.length} 张没渲染出来:${data.failed[0].error}`);
      } catch (e: any) {
        // 被 cleanup 掐掉的不算出错:那是用户挪走了播放头,本来就不该再等它
        if (!dead && e?.name !== "AbortError") setErr(String(e?.message || e));
      } finally {
        endForegroundBake();
        if (!dead) { setPending(0); setBakingAt(null); }
      }
    })();
    return () => { dead = true; ac.abort(); };
    // momentSig 在依赖里:拖时间轴换到别的时刻要重新取图。但它**不在建场景那个 effect 的
    // 依赖里**,所以只是换 material.map,场景不重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, momentSig, parked, bakeGen, scrubbing, playing]);

  /* ── 预渲染好的贴图一到就收进「按时刻」的缓存,轮到那一刻就用得上 ───── */
  useEffect(() => {
    if (!prefetch.ready.size) return;
    const all = projRef.current.tracks.flatMap((tr: any) => tr.clips ?? []);
    for (const [id, url] of prefetch.ready) {
      // 预渲染的键是 `<clipId>@<t>`(见 useBakePrefetch 的 momentId)。clipId 里不会有 @
      const at = id.lastIndexOf("@");
      if (at < 0) continue;
      const clipId = id.slice(0, at);
      const mt = Number(id.slice(at + 1));
      const c = all.find((x: any) => x.id === clipId);
      if (!c || !Number.isFinite(mt)) continue;
      const k = texKeyOf(c, mt);
      if (moments.current.get(k) === url) continue;
      moments.current.set(k, url);
      /*
       * **只有它正好就是这块板子此刻该显示的那一刻,才换上去。**
       * 预渲染会把整条片子的很多时刻都渲出来,拿其中任意一张往板子上贴,
       * 贴的就是别的时刻的画面 —— 那正是要修的那个 bug。
       */
      if (k === momentKey(c)) swap.current.get(clipId)?.(url, true);
    }
    // momentSig 在依赖里:预渲染的结果和「此刻该显示哪一刻」是两个都会变的量,
    // 任一个变了都要重新对一次账
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefetch.ready, momentSig]);

  return (
    /*
     * 底是棋盘格,不是黑的。画布 alpha:true,没画到的地方本来直接透出近黑的面板色,
     * 于是「深色的卡」和「这儿什么都没有」长得一模一样 —— 格子把这两件事分开。
     * 格子的灰和边长跟 see_frames 那边逐值对齐(见 .pc-3d-checker 的说明)。
     */
    <div className="pc-3d-checker" style={{ position: "relative", width: "100%", height: "100%", minHeight: 200 }}>
      {/* 隐藏的轨道流画布容器，供 StreamPlayer 解码和提供材质源 */}
      <div
        ref={streamHost}
        aria-hidden="true"
        style={{
          position: "absolute",
          width: 0,
          height: 0,
          overflow: "hidden",
          opacity: 0,
          pointerEvents: "none",
        }}
      >
        {active.filter((c) => c.cardId !== "scene-3d").map((c) => (
          <div key={c.id} data-pc-clip={c.id}>
            <canvas data-pc-stream-plane="" />
          </div>
        ))}
      </div>
      <div ref={host} style={{ position: "absolute", inset: 0 }} />

      {/*
        「2D 视角框」开关。放右上角:左下角那条是预渲染进度,别抢地方。
        只有加载完(mods 到位、场景建起来了)才显示 —— 场景还没有的时候点它什么都不会发生。
      */}
      {mods && (
        <button
          type="button"
          /*
           * **不要再挂 `.pc-3d-note`**(以前挂过)。那个 class 的意思是「浮在格子上的状态提示」,
           * 按它去找「正在渲染…」那条会连这个按钮一起匹配到 —— 已经有人写测试时踩过一次。
           * 长得像不是共用类名的理由:一样的底和圆角在 CSS 里合成一条规则就够了。
           */
          className={`pc-3d-toggle${frustumOn ? " is-on" : ""}`}
          style={{ position: "absolute", right: 10, top: 10 }}
          aria-pressed={frustumOn}
          onClick={() => setFrustumOn((v) => !v)}
          title={
            project.camera3dFov
              ? `画出 2D 页那台相机张开到画幅的四角锥(视角 ${project.camera3dFov}°)—— 用来判断一张卡到底在不在成片画面里`
              : `画出 2D 页那台相机张开到画幅的四角锥。这个项目没设视角,按默认 ${DEFAULT_FOV_DEG}° 画(和 3D 页开场机位同一台相机)`
          }
        >
          2D 视角框
        </button>
      )}
      {(pending > 0 || err) && !playing && (
        <div
          className="pc-3d-note"
          style={{
            position: "absolute", left: 10, bottom: 10, pointerEvents: "none",
            color: err ? "var(--ui-danger, #f87171)" : "var(--ui-text-2, #94a3b8)",
          }}
        >
          {err ?? (bakingAt === null
            ? `正在渲染 ${pending} 张卡的贴图…色块是占位,渲染好会自动换上`
            : `正在渲染第 ${bakingAt.toFixed(2)} 秒的画面(共 ${pending} 张)…色块是占位,不是别的时刻的画面`)}
        </div>
      )}
      {!mods && !err && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
          <span className="pc-3d-note" style={{ color: "var(--ui-text-2, #94a3b8)" }}>正在加载三维视图…</span>
        </div>
      )}
    </div>
  );
}
