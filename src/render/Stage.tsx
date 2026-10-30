import { AnimClock } from "../kernel/AnimClock";
import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";
import { frameCss } from "../kernel/layout";
import { perspectivePx } from "../kernel/space3d";
import { motionAt } from "../kernel/motion";
import { cardOpacityAt, hasOpacityControls } from "../kernel/project";
import { forgetUnmounted, mountClockMsAt } from "./mountClock";
import { emphasisFilter } from "../kernel/emphasis";
import { getCard, isRuntimeCard } from "../kernel/registry";
import { PartTree } from "./PartTree";
import { GraphCard } from "./cards/GraphCard";
import { RuntimeCardBoundary } from "./cards/RuntimeCardBoundary";
import { frameBox } from "../kernel/layout";
import type { CardDef, CardProps, Timeline } from "../kernel/types";
import { cardMountedAt } from "./frameWindow.mjs";
import { clipFrameMode } from "../kernel/frameMode.mjs";
import { guardCompositing, shouldGuard } from "./capabilityGuard";
import { ensurePlaneStyle } from "./planeStyle";
import { GlPlane } from "./gl/GlPlane";
/* 占位组件(product/rendering.md「兜底顺序」尽头;接口见 `placeholder/contract.ts`) */
import { PlaceholderPlane, PLACEHOLDER_CSS, maxAnimated } from "./placeholder";
import { ensurePlaceholderStyle, exportSyncedMountFor, geometryFor, isCatchingUpClip, onlineBrowserMode, PLACEHOLDER_SLOT_ATTR, placeholderFitFor, placeholdersEnabled, setMaxAnimated, unsupportedHere } from "./placeholderHost";
import { resolveCardParams } from "./mediaTier";
import type { PlaceholderReason } from "./placeholder/contract";
import { CutSegmentScene } from "./CutSegmentScene";
import { cutOf, envelopeAt } from "../kernel/cutSegments";
import { FLAT_SEP } from "../kernel/cutFlatten.mjs";

setMaxAnimated(maxAnimated);

// Keep direct-evaluation cards at the requested time while other cards replay.
// Their CSS/DOM stays in the same stacking tree (including paper/glass styles),
// but their component is not run for each stateful history frame.
const DirectCard = memo(function DirectCard({ def, params, ...props }: CardProps<any> & { def: CardDef<any> }) {
  // 素材效果卡没有 Component,但它在下面的分支顺序里排在这一支**前面**,走到这里必有组件。
  // 这里**不能**改成 `if (!C) return null` —— 分支顺序万一写错,那就是一张静默的空白卡。
  const C = def.Component!;
  return <C {...props} params={resolveCardParams({ ...def.defaults, ...params })} />;
});

/**
 * 实体模式:浏览时把每张卡换成一个色块。给一个「这张卡该画成什么样」的查询函数,
 * Stage 只负责摆位置 —— 颜色怎么来的、什么时候采样,是 render/solidMode.ts 的事。
 *
 * 不传 = 真渲,DOM 和以前**一个字都不差**(导出走的就是这条路)。
 */
export type ProxyRender = (clipId: string) => { color: string; box: { left: number; top: number; width: number; height: number } | null };

/**
 * G1 的一条流分组:长度 1 = 单卡流(或依赖下层的流,看 `plane`),> 1 = 组流(按画家顺序,最后一个是组里最上面那张)。
 * `key` / `ranges` 是 `streamPlayer` 要的(就绪索引里那一层的流键和就绪分段号),`Stage` 只看 `clipIds` 和 `plane`。
 */
export interface StreamPlaneGroup {
  clipIds: string[];
  /**
   * `"stage"`:只有一张卡、但按舞台坐标产的流(依赖下层的流,`docs/plan/prerender-products-contract.md` 第 5.4 节)。
   * 画布不挂进包裹层,挂在舞台根下(和组流同一种平面),层序取这张卡那一层。
   */
  plane?: "stage";
  key?: string;
  ranges?: Array<[number, number]>;
  /** 这条流自己的第一帧(项目帧号);`streamPlayer` 按它把帧号换成分段号,`Stage` 不看 */
  originFrame?: number;
  /**
   * 组流平面挂在哪张卡的那一层(组里**此刻活跃的最上面那张**)。由 `StageView` 按当前时刻算好填进来 ——
   * live 路每个片段一个单片段 `Stage`,单个 `Stage` 不知道别的片段此刻在不在场。不填就取组里最上面那张。
   */
  host?: string;
}

/**
 * 舞台的六个可选 prop(E7)。**一个都不传 = 今天的行为一个字不差**(导出页、legacy 走的就是这条)。
 * 机制统一照 `solidMode.ts` 的实体模式:组件永远挂着,包裹层加一个类、样式表藏掉子树,
 * 要显示的东西是包裹层里的兄弟平面 —— 不改 key、不换子节点类型。
 */
export interface StagePlaneProps {
  /** C3 / C4 的 HTML 快照,按 clipId。挂上 = 包裹层加 `.pc-snapshot` + 一个兄弟快照平面 */
  snapshots?: ReadonlyMap<string, string>;
  /** 播放中的重卡(E7 第 5 条):藏子树、传给组件的 `t` 冻在抑制开始那一刻 */
  suppressed?: ReadonlySet<string>;
  /** G1 的流平面分组(R8 之前恒空,渲染位置和 prop 先就位) */
  streamPlanes?: readonly StreamPlaneGroup[];
  /** K3:按片段重挂载的代数。key 和传给组件的 `playToken` 用的是「整舞台 playToken + 它」,**不传时就是整舞台 playToken** */
  remountGen?: ReadonlyMap<string, number>;
  /** K5 第一路:正在用子树虚拟时间追帧的片段 → 它此刻的**全局舞台毫秒** */
  settling?: ReadonlyMap<string, number>;
  /** E0 的 `setTime({ awaiting })`:这一帧的快照还没到,先藏着等 */
  awaiting?: ReadonlySet<string>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * 运行时载入的卡(在线浏览器里执行的同步来的用户卡与素材效果卡)包一层错误边界:渲染时抛错只撤这一张,不带垮舞台。
 * 构建时就有的卡原样返回 —— 桌面、导出、预渲染的 React 树与以前逐字相同。
 */
function guardRuntimeCard(cardId: string | undefined, body: ReactNode): ReactNode {
  return cardId && isRuntimeCard(cardId) ? <RuntimeCardBoundary cardId={cardId}>{body}</RuntimeCardBoundary> : body;
}

/**
 * 舞台:按当前时刻挑出活跃 clip 并挂载。卡片以 clip.id + playToken 作 key,
 * 进入区间即重新挂载、从头播放(和导出时的行为一致)。
 */
export function Stage({ timeline, t, directT = t, playToken, speed = 1, proxy, snapshots, suppressed, streamPlanes, remountGen, settling, awaiting, mountClock = false, nested = false, flatPrefix }: {
  timeline: Timeline; t: number; directT?: number; playToken: number; speed?: number; proxy?: ProxyRender;
  /**
   * 剪辑段里的嵌套舞台(`CutSegmentScene`):包裹层挂 `data-pc-nested-clip` 而不是 `data-pc-clip`,
   * 命中测试、钉动画、量框这些按舞台顶层片段工作的地方只看得到剪辑段那一层。顶层一律 false,DOM 一个字不变。
   */
  nested?: boolean;
  /**
   * 剪辑段里的嵌套舞台(`CutSegmentScene`):这一层片段在计划一侧的 id 前缀(`<段 id>~`,多层一路接下去;`kernel/cutFlatten.mjs`)。
   * 六个平面 prop 都按「前缀 + 片段 id」查(父页按摊平视图里的虚拟片段发),包裹层另挂 `data-pc-flat-clip`(流平面、占位槽位按它找)。
   * 顶层不传,一律按片段 id 查,DOM 一个字不变。
   */
  flatPrefix?: string;
  /**
   * 给「按挂载时刻计时」的卡传挂载钟(`CardProps.mountClockMs`)。**只有平铺时间轴的导出页传 true**:
   * 那条路径上卡片提前 `CARD_MOUNT_LEAD` 挂载,旧的打字卡从挂载那一帧起计时,导出像素基线(演示项目)就是那样渲出来的。
   * 预览与 Project 导出不传:前者提前多少取决于哪一拍落进提前窗口,后者在起点才挂,都按 `t`。
   */
  mountClock?: boolean;
} & StagePlaneProps) {
  const timeOf = (c: Timeline['clips'][number]) => clipFrameMode(c, getCard(c.cardId)) === 'direct' ? directT : t;
  /** 平面 prop 按哪个 id 查:顶层就是片段 id;嵌套场景里是计划一侧的虚拟片段 id(`flatPrefix`) */
  const pidOf = (c: { id: string }) => (flatPrefix ? flatPrefix + c.id : c.id);
  const active = timeline.clips.filter((c) => cardMountedAt(c, timeOf(c)));

  /*
   * 四种平面的样式表(E7)。只有真的用上这几个 prop 的宿主才注入 ——
   * 导出页和 legacy 一个 prop 都不传,这张表不会出现在它们的文档里。
   */
  const usesPlanes = !!(snapshots || suppressed || streamPlanes || settling || awaiting);
  useEffect(() => {
    if (usesPlanes) ensurePlaneStyle();
  }, [usesPlanes]);
  /*
   * 占位平面(兜底顺序尽头):只有人看的预览(舞台页、`front` 角色)挂 —— `placeholderHost` 的开关
   * 只由 `StageView` 打开;导出页、预渲染、Agent 的查询渲染、后台舞台一个节点都不渲、样式表不注入。
   */
  const placeholders = usesPlanes && placeholdersEnabled();
  useEffect(() => {
    if (placeholders) ensurePlaceholderStyle(PLACEHOLDER_CSS);
  }, [placeholders]);

  /*
   * 被抑制的卡传给组件的那个 `t` 要**冻在抑制开始那一刻**(E7 第 5 条)。
   * 「进入抑制那一刻」用 ref 存上一次 render 的 suppressed 集合、在本次 render 里对比:
   * 从不在到在 → 记当前 `cardT − clip.start`;从在到不在 → 删条目。
   *
   * 只冻**传给组件的那一支**。`cardT` 的其余用途(活跃判据、轨迹、不透明度、
   * `data-pc-local-frame`)照常用实时值 —— 否则被抑制的卡永不下场,包裹层的轨迹停住
   * 而流的 `<canvas>` 跟着错位。
   *
   * 放 Map 而不是单个值:live 路径下每个 clip 一个单片段 Stage、Map 里只有一条,
   * 但同一份代码也服务导出 / legacy 的多片段 Stage。
   */
  /*
   * 挂载钟(记账在 `mountClock.ts`):每张卡这一次挂载(`片段 id:代数`,和包裹层的 key 同一个)第一次渲染时的舞台时刻。
   * 只在 `mountClock` 打开时记;渲染体里按 key 取,这一次渲染没挂的在提交后清掉。
   */
  const mountedAt = useRef(new Map<string, number>());
  const mountKeys = new Set<string>();
  const mountClockMsOf = (key: string, clip: Timeline["clips"][number], now: number): number | undefined => {
    if (!mountClock) return undefined;
    mountKeys.add(key);
    return mountClockMsAt(mountedAt.current, key, clip.start, now);
  };
  useEffect(() => {
    if (mountClock) forgetUnmounted(mountedAt.current, mountKeys);
  });
  const frozenT = useRef(new Map<string, number>());
  const prevSuppressed = useRef<ReadonlySet<string>>(EMPTY_SET);
  const supNow = suppressed ?? EMPTY_SET;
  for (const c of active) {
    const pid = pidOf(c);
    if (supNow.has(pid) && !prevSuppressed.current.has(pid)) frozenT.current.set(pid, Math.max(0, timeOf(c) - c.start));
  }
  for (const id of [...frozenT.current.keys()]) if (!supNow.has(id)) frozenT.current.delete(id);
  prevSuppressed.current = supNow;

  /**
   * 传给组件的那个本地时间。三档,按优先级:
   *   1. 正在追帧(`settling`)—— 读它自己的虚拟时间(值是全局舞台毫秒,这里现算本地);
   *   2. 被抑制 —— 冻在抑制开始那一刻;
   *   3. 平时 —— 实时值。
   * 四支(组合卡 / 素材效果卡 / DirectCard / 普通卡)口径一致,都走这里。
   */
  const localTOf = (clip: Timeline["clips"][number], base: number): number => {
    const ms = settling?.get(pidOf(clip));
    if (ms !== undefined) return Math.max(0, ms / 1000 - clip.start);
    const frozen = frozenT.current.get(pidOf(clip));
    if (frozen !== undefined) return frozen;
    return Math.max(0, base - clip.start);
  };
  /** 占位符为什么显示(诊断用;显隐本身不看它,由 `StageView` 切) */
  const placeholderReasonOf = (id: string): PlaceholderReason =>
    awaiting?.has(id) ? "awaiting" : settling?.has(id) || isCatchingUpClip(id) ? "catching-up" : "no-data";
  // 自带三维场景的卡(scene-3d)要用和 A 层同一台相机,所以把画幅和 fov 一起递下去。
  // 对象整体透传,别的卡收到了也不看。
  const stageInfo = useMemo(() => ({ width: timeline.width, height: timeline.height, camera3dFov: timeline.camera3dFov }), [timeline.width, timeline.height, timeline.camera3dFov]);
  /*
   * 审阅表（src/cards/capabilities.json）说 independent、画面上却量到 backdrop-filter 的卡，
   * 挂上之后报一次警并降级成 belowDependent（render/capabilityGuard.ts）。
   * 每张卡一辈子只量一次，且只在开发态的交互舞台上跑 —— 导出 / 预渲染那条路 shouldGuard() 直接 false，
   * 一个 getComputedStyle 都不会执行，逐像素基线不受影响。DOM 一个字不改（只加了个 ref）。
   */
  const stageRef = useRef<HTMLDivElement>(null);
  const guardKey = active.map((c) => c.cardId).join("|");
  const clipAttr = nested ? "data-pc-nested-clip" : "data-pc-clip";
  useEffect(() => {
    if (!shouldGuard()) return;
    const handle = requestAnimationFrame(() => {
      guardCompositing(stageRef.current, active.map((c) => ({ id: c.id, cardId: c.cardId })));
    });
    return () => cancelAnimationFrame(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardKey]);
  return (
    <div
      ref={stageRef}
      className="pc-stage"
      style={{ position: "relative", width: timeline.width, height: timeline.height, overflow: "hidden", background: "transparent" }}
    >
      {/*
        三维的透视挂在这一层,不是挂在舞台那一格 —— 因为 CSS 的 `perspective`
        **只作用于直接子元素**,而卡片 div 的直接父元素就是 AnimClock 这一层。
        往外挪一格就会静悄悄失效(实测:卡片高度一点不变,rotateY 只剩仿射拉伸),
        而且外面那格还有 overflow:hidden,它会把 transform-style 强制打回 flat。

        放在 Stage 里而不是各个视图里,是为了让预览和导出走同一条路:
        StageView / ExportView 拿到的都只是 Timeline,任何一方漏写就是
        「预览有透视、导出没有」,而那种分叉不报错。

        perspective 的值就是相机到 z=0 平面的距离,和 three.js 那边同一个数、
        同一个单位(见 kernel/space3d.ts)—— A 层和 B 层不用标定就能对齐,靠的就是这个。
        不开三维时一个属性都不加:老项目的导出有逐像素基线。

        **这里没有 transform-style: preserve-3d,是故意的。** 直觉上「开三维就该加上它」,
        实测下来它做的完全是另一件事(perspective 618、一张 translateZ(-300) 的卡):

          无 perspective            卡片投影宽 300.00   画面上在前的是 DOM 靠后那张
          perspective + preserve-3d 卡片投影宽 201.96   画面上在前的变成 z 更近那张
          只有 perspective          卡片投影宽 201.96   画面上在前的仍是 DOM 靠后那张

        投影宽两行一模一样 —— 它**对透视一点贡献都没有**;它唯一的作用是把兄弟卡片
        从「按 DOM 顺序叠」改成「按 z 深度排序」。那正好推翻这套设计写死的两条约定:
        谁盖住谁只看序列(trackId),以及卡片之间不做穿插。加上它的话,Agent 把最上层的卡
        往里推一点(translateZ 负值),它会立刻被下面所有卡盖住 —— 和工具描述承诺的相反。

        它还会顺手改掉**没碰过三维的卡**的像素:一张只有 scale+rotate 的卡,截图 sha256
        在「不开三维」和「只有 perspective」下相同,加了 preserve-3d 就变了。
        也就是说一旦有人调 set_camera3d,画面里另外那些卡全部换了光栅路径。
      */}
      <AnimClock
        speed={speed}
        style={
          timeline.camera3dFov
            ? {
                perspective: `${perspectivePx({ width: timeline.width, height: timeline.height }, timeline.camera3dFov)}px`,
                perspectiveOrigin: "50% 50%",
              }
            : undefined
        }
      >
        {active.map((clip, i) => {
          const def = getCard(clip.cardId);
          /*
           * 这台设备跑不了这张卡(在线浏览器模式下的用户卡、素材效果卡;同步来的用户卡本机连定义都没有):卡片代码不跑,
           * 包裹层照内置重卡的路子挂快照平面、流平面,兜底顺序什么都贴不上时占位符显示 `unsupported`(C10 契约第 9 节)。
           * 模式关着(桌面、导出、预渲染、Agent 看到的画面)恒为 false,下面每一支和以前逐字相同。
           */
          // 剪辑段(kernel/cutSegments.ts):不是注册表里的卡,包裹层里挂被引用剪辑的嵌套场景
          const seg = cutOf(clip);
          const localOnly = !seg && ((onlineBrowserMode() && unsupportedHere(clip.cardId, def)) || exportSyncedMountFor(clip.cardId, def));
          /*
           * 三道都在取 def 这一格剔掉,不放到分支里:
           *  - 定义没了(用户卡文件被删)——素材效果卡的 def 在注册表里必然取得到,挡不住下面两种;
           *  - 既没有 card 也没有 Component:音频素材效果卡万一带着 cardId 进来也不炸;
           *  - 素材效果卡但没有图(projectCardGraph 抛了):没有图解不出输入,画不出东西。
           * 这台设备跑不了的卡不看这三道:它不挂组件,只贴预渲染结果。
           */
          if (!seg && !localOnly && (!def || (!def.card && !def.Component) || (def.card && !timeline.graph))) return null;
          const C = def?.Component!;
          // 声画卡的 DOM/图形由视觉出口选择，audio() 不改变视觉分派。
          const embeddedOffset = def?.audio ? (clip.sourceOffset ?? 0) : 0;
          const cardT = timeOf(clip);
          const unsupported = localOnly;

          // 绑了轨迹的 clip 整层跟着目标平移。平移放在**外层**而不是交给卡片：
          // 卡片不知道自己被绑了，也不该知道——换一张卡，跟随照样生效。
          const m = clip.motion ? motionAt(clip.motion, Math.max(0, cardT - clip.start)) : null;
          if (m && clip.motion!.whenHidden === "hide" && !m.visible) return null;

          // 卡片的框(位置/尺寸/锚点/缩放/旋转)和轨迹平移一样放在外层:卡片不知道自己被摆到了哪儿。
          // 没有 frame 时 frameCss 输出的就是以前那套 inset:0,老项目逐字节不变。
          // 不透明度 / 淡入淡出同理放外层,而且只在设了的时候才写 opacity —— 没设的卡 DOM 一个字不变。
          // 剪辑段的淡入淡出从它真正露出来的起点(`seg.from`)算,预卷那一截不露
          const op = seg
            ? envelopeAt({ start: seg.from, end: clip.end, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, opacity: clip.opacity }, cardT)
            : hasOpacityControls(clip) ? cardOpacityAt(clip, cardT) : 1;
          const prerolling = !!seg && cardT < seg.from;
          // 强调(阴影 / 描边)沿 alpha 边缘走,所以挂在卡片外层这一格上;没设就一个字不写
          const filter = emphasisFilter(clip.emphasis);
          /*
           * K3:重挂载的粒度是片段。key 和**传给组件的 `playToken`** 都换成 `remountGen`,
           * 不传时退回整舞台 `playToken`(导出页、legacy 行为不变)。两处必须一起换:
           * `layoutId` 靠它换新、三维 / 终端卡靠它重播,只换 key 的话 Motion 会把重播当共享布局过渡。
           *
           * **两个代数相加,不是二选一。** 以前写的是 `remountGen ?? playToken`,有两处漏挂(`seek-back-exact-probe.mjs` 在
           * 包裹层节点上留记号量出来的):
           *   - 舞台的 `playToken` 从 1 起,按片段重挂载的代数第一次也是 1 —— 新开的可见舞台上每张卡的第一次按片段重挂载
           *     (向后跳的定位配方、追帧的起步)key 没变,等于没挂;
           *   - 一张卡按片段重挂载过之后,它的 key 就只认 `remountGen`,整舞台的 `playToken` 再涨也不动它 —— 这个舞台转到后台
           *     做整场景补跑(`render(jump)`)、探针复位、生成快照时,这张卡不再跟着整台重挂载。
           * 两个代数都只增不减,和每次重挂载都严格变大;没有按片段的代数时就是 `playToken`(导出页、legacy 一个字不变)。
           */
          const pid = pidOf(clip);
          const gen = playToken + (remountGen?.get(pid) ?? 0);
          const mountClockMs = mountClockMsOf(`${clip.id}:${gen}`, clip, cardT);
          const isSettling = settling?.has(pid) ?? false;
          const cls = [
            proxy ? "pc-proxy" : "",
            !isSettling && supNow.has(pid) ? "pc-suppressed" : "",
            awaiting?.has(pid) ? "pc-awaiting" : "",
            isSettling ? "pc-settling" : "",
          ].filter(Boolean).join(" ");
          // 这张卡该不该挂流平面(G1:单卡流挂在包裹层里;组流和依赖下层的流挂舞台根下的 [data-pc-group-plane])
          const ownStream = streamPlanes?.some((g) => g.clipIds.length === 1 && g.plane !== "stage" && g.clipIds[0] === pid) ?? false;
          /*
           * 流平面露不露:这张卡被抑制着、或正在不可见地追帧时才露。别的时候它也可能挂着 —— 暂停着把播放头下这一帧先解好、
           * 等流画出第一帧再藏活子树 —— 那时活子树还露着,流平面要藏起来(`display: none`:不占框,`solid.ts` 的实体框不算它),
           * 不然两份画面叠在一起。和 `.pc-suppressed` 在同一次提交里翻,画面从活子树换成流中间不空一拍。
           */
          const streamShown = isSettling || supNow.has(pid);
          /*
           * 包裹层的本地帧号。平时按 `cardT` 算;**正在追帧(`settling`)的片段按它自己的虚拟时间算**(R9 M4 的配套):
           * 子树虚拟时间下包裹层的帧号不跟着走的话,gl 平面的 `data-pc-gl-frame` 和它永远对不上,
           * 每张 canvas 卡在 K1 两趟布尔探针 / K5 第一路里都被 `rasterizeCanvas` 误判 `lossy`。
           * `settling` 只在舞台上传,导出页和 legacy 一个字不变。
           */
          const settlingMs = settling?.get(pid);
          const localFrame = Math.round(((settlingMs !== undefined ? settlingMs / 1000 : cardT) - clip.start) * timeline.fps);
          /*
           * canvas 卡(R9 M1):带 `canvas` 契约(`dom2d` 除外)的片段在包裹层里多渲一个 gl 平面,画面由共享渲染器画。
           * 这一拍画不画(M3):「在 `suppressed` 里」的不画（在贴流或占位，没在追）。尺寸 = 片段实体框。
           */
          const glContract = !unsupported && def?.canvas && def.canvas.kind !== "dom2d" ? def.canvas : null;
          const glBox = glContract ? frameBox(clip.frame, timeline) : null;
          // 组流的成员、依赖下层的流的目标卡:包裹层里没有流平面,`hitTest` / `bounds` 对它们退回包裹层框(G1「组流平面的命中与实体框」)
          const groupMember = streamPlanes?.some((g) => (g.clipIds.length > 1 || g.plane === "stage") && g.clipIds.includes(pid)) ?? false;
          return (
            <div
              key={`${clip.id}:${gen}`}
              {...{ [clipAttr]: clip.id }}
              data-pc-flat-clip={flatPrefix ? pid : undefined}
              data-pc-stream-member={groupMember ? "" : undefined}
              data-pc-local-frame={localFrame}
              data-pc-frame-mode={clipFrameMode(clip, def)}
              className={cls || undefined}
              style={{
                ...frameCss(clip.frame, timeline, m ? { dx: m.dx, dy: m.dy } : undefined),
                ...(op < 1 ? { opacity: op } : null),
                ...(filter ? { filter } : null),
                /*
                 * 层序写死在这里,不靠 DOM 顺序。
                 *
                 * `active` 已经是画家顺序(flattenOverlay 倒着遍历 tracks,所以最后一个 =
                 * 时间轴最上面那条序列 = 最上层),但光有 DOM 顺序不够:卡片内部只要有人写了
                 * z-index,而外层又不是层叠上下文,那个 z-index 就会跑到舞台这一级去比,
                 * 越过后面的兄弟。实测 focus-card 内部有 `zIndex: 100`(focus-card.tsx:40),
                 * 于是把三维卡放到最上面那条序列,画面中心仍然是 focus-card ——
                 * Agent 按「靠上的序列盖住靠下的」去排层,结果和承诺相反。
                 *
                 * 所以两件事一起做:显式 z-index 定序,`isolation: isolate` 造一个层叠上下文
                 * 把卡片内部的 z-index 关在里面。这就是设计文档里「每个 A/B 对象带一个遮蔽标识、
                 * 0 在最前面」那条 —— 遮蔽标识就是序列顺序,这里把它翻译成 CSS 的方向
                 * (CSS 是数字越大越靠前,和「0 最前」正好相反,所以只能写死在一处)。
                 */
                zIndex: i + 1,
                isolation: "isolate",
                // 剪辑段:被引用剪辑的整帧只在段的框里露出来;预卷那一截整层藏着(也不让点中)
                ...(seg ? { overflow: "hidden" } : null),
                ...(prerolling ? { pointerEvents: "none" as const } : null),
              }}
            >
              {/*
                clip.params 在写入时就是全量的(见 store 的 addCardClip),
                这里铺一层 defaults 只是兜底:卡片以后新增参数时,先前存下的 clip
                里没有那个键,没有这层就会把 undefined 传进组件。
                正常情况下它一项都不会补 —— 补上了就说明 clip 缺参数。
              */}
              {seg ? (
                <CutSegmentScene seg={seg} start={clip.start} localT={localTOf(clip, t)}
                  localDirectT={settling?.has(pid) || frozenT.current.has(pid) ? localTOf(clip, t) : Math.max(0, directT - clip.start)}
                  playToken={gen} size={frameBox(clip.frame, timeline)}
                  /* 里面的卡各自按「段 id~卡的片段 id」查抑制、流平面、占位(`kernel/cutFlatten.mjs`);导出页、预渲染页不传平面,一个字不变 */
                  flatPrefix={pid + FLAT_SEP}
                  planes={usesPlanes ? { snapshots, suppressed, streamPlanes, remountGen, settling, awaiting } : undefined} />
              ) : guardRuntimeCard(clip.cardId, unsupported ? (
                /* 这台设备跑不了的卡:卡片代码不跑,不挂组件(快照 / 流平面与占位槽位照常挂在下面) */
                null
              ) : clip.cardId === "composite" && clip.parts?.length ? (
                // 组合卡:部件实例树逐级渲染,画布尺寸就是这张卡的框(没有框 = 整个舞台)
                <PartTree parts={clip.parts} size={frameBox(clip.frame, timeline)} t={localTOf(clip, t)} playToken={gen} />
              ) : def!.card ? (
                // 素材效果卡:经 Stage、有包裹层,hitTest / rects / 快照 / 抑制全部照常
                <GraphCard def={def!} clip={clip} graph={timeline.graph} fps={timeline.fps}
                  t={localTOf(clip, cardT)} params={resolveCardParams({ ...def!.defaults, ...clip.params })} stage={stageInfo} />
              ) : clipFrameMode(clip, def) === 'direct' ? (
                <DirectCard def={def!} params={resolveCardParams(clip.params)} playToken={gen} t={localTOf(clip, cardT) + embeddedOffset} sourceOffset={clip.sourceOffset} duration={clip.end - clip.start} stage={stageInfo} />
              ) : (
                <C params={resolveCardParams({ ...def!.defaults, ...clip.params })} playToken={gen} t={localTOf(clip, cardT) + embeddedOffset} sourceOffset={clip.sourceOffset} mountClockMs={mountClockMs} duration={clip.end - clip.start} stage={stageInfo} />
              ))}
              {/*
                gl 平面(R9,E7 的第五种兄弟平面)。它是**活渲的一部分**,不进四条平面选择器的放过名单 ——
                藏子树时它和子树一起被藏。**不加 `data-pc-clip`**(`isSolid` 会把它当包裹层跳过)。
                位图由 `glHost` 在 `done` 时贴上,这里只登记这一拍要画什么。
              */}
              {glContract && glBox ? (
                <GlPlane clipId={pid} cardId={clip.cardId} contract={glContract}
                  w={glBox.width} h={glBox.height} t={localTOf(clip, cardT)} frame={localFrame}
                  params={resolveCardParams({ ...def!.defaults, ...clip.params })} gen={gen}
                  skip={supNow.has(pid)} stage={stageInfo} />
              ) : null}
              {/*
                代理色块是卡片的**兄弟**,不是把卡片包起来 —— 真卡由 .pc-proxy 那条
                CSS 规则藏掉(见 render/solidMode.ts)。包一层 div 的话,切换实体模式那一刻
                React 会重挂载卡片,而重挂载会丢掉 pinAnimations 的锚点:
                用户看到的是「每次暂停,字都重新飞进来一次」。
                box 是「这张卡真正画了东西的那一块」,坐标相对卡片自己的框;
                量不到(或者内容本来就铺满这张卡)就 inset:0。
              */}
              {proxy ? (() => {
                const px = proxy(clip.id);
                return (
                  <div
                    data-pc-proxy-plane=""
                    style={{
                      position: "absolute",
                      ...(px.box ?? { inset: 0 }),
                      background: px.color,
                      borderRadius: 6,
                    }}
                  />
                );
              })() : null}
              {/*
                流平面(E7 第 5 条,R8)。`streamPlayer` 只往这个**已经存在的** `<canvas>` 上画,
                不做外部 `insertBefore` —— 否则会和代理平面、快照平面抢兄弟位置。
                层序、overflow、zIndex、包裹层的框 / 轨迹 / 不透明度 / 强调自动跟着包裹层走:
                单卡流画在包裹层自己的坐标系里(和快照平面一样),所以这块画布是包裹层的普通子元素。
                位置和尺寸由 `streamPlayer` 按流的清单设(流的矩形上界,可能比框大一圈、也可能在框外一点);
                清单到之前先铺满包裹层(背板 0×0、透明)—— 被抑制的卡子树藏着,这一小段时间里点它也要点得中。
              */}
              {ownStream ? (
                <canvas data-pc-stream-plane="" width={0} height={0}
                  style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", ...(streamShown ? null : { display: "none" }) }} />
              ) : null}
              {/*
                占位平面(product/rendering.md「兜底顺序」;和快照 / 流平面同级,坐标、旋转、缩放、层级从包裹层继承)。
                槽位默认 `hidden`,`StageView` 每拍只切它的 `hidden`(contract 的 `setPlaceholderShown`),
                不经 React 提交 —— `hidden` 这个 prop 恒为 true,React 不会把手动切过的值冲掉。
                放在最后:同一包裹层里它盖在快照 / 流平面上面(显示它的时候那两样本来就没画面)。
              */}
              {placeholders ? (() => {
                /*
                 * 在屏幕上多大(`placeholderFit.ts`):沙漏只抵消预览缩放,不超出这一层的框。预览缩放由父页经 `setViewScale`
                 * 发来(桌面与在线都发)。这台设备跑不了的卡同样是沙漏(结果由渲染节点出)。
                 */
                const size = frameBox(clip.frame, timeline);
                const geometry = geometryFor(pid, size);
                const reason = unsupported ? "awaiting" : placeholderReasonOf(pid);
                return (
                  <div {...{ [PLACEHOLDER_SLOT_ATTR]: "" }} hidden style={{ position: "absolute", inset: 0 }}>
                    <PlaceholderPlane clipId={pid} geometry={geometry} reason={reason}
                      fit={placeholderFitFor(pid, reason, geometry, size, clip.frame?.scale ?? 1)} />
                  </div>
                );
              })() : null}
            </div>
          );
        })}
      </AnimClock>
      {/*
        组流平面(G1:一条流盖住相邻的好几张重卡)。它跨片段,挂不进任何一个包裹层,
        所以落在舞台根下、和卡包裹层所在的那一层同级;组流里包裹层的外观已经画进流里,所以不受任何
        包裹层的 `frameCss` / `opacity` / `filter` / `motion` / `isolation` 影响。
        **只渲在组里此刻活跃的最上面那张卡(`host`)所在的那个 `Stage` 里**:live 路每个片段一个
        单片段 `Stage`,每个都渲一块的话同一条组流会叠好几层;z 序取那张卡的那一层。
        `pointer-events: none`:点击落到背后组内被抑制的卡的包裹层上(`solid.ts` 的 `hitTest`)。

        **依赖下层的流**(`plane: "stage"`,只有目标卡一张)也是这种平面:流里是目标卡改动过的那一层(预乘色加不透明度),
        包裹层的位置、不透明度、淡入淡出、轨迹、强调都已经画在里面,所以同样不能挂进包裹层。它和目标卡的包裹层在同一个
        层叠上下文里、层序相同,于是照普通的叠加盖在下面那些活着的层(活渲的卡、别的流、视频)上面,上面的层照常画在它上面:
        毛玻璃后面看到的是舞台上此刻真实的下层。目标卡的子树照抑制的规矩藏着,不会再滤一遍下层。
      */}
      {streamPlanes?.filter((g) => g.clipIds.length > 1 || g.plane === "stage").map((g) => {
        const hostId = g.host ?? g.clipIds[g.clipIds.length - 1];
        const at = active.findIndex((c) => pidOf(c) === hostId);
        if (at < 0) return null;
        // 组里有成员被抑制着 / 在不可见地追帧才露(同单卡流的 `streamShown`:暂停着先解好这一帧时组流平面藏着)
        const shown = g.clipIds.some((id) => supNow.has(id) || (settling?.has(id) ?? false));
        return <canvas key={g.clipIds.join(",")} data-pc-group-plane="" data-pc-stream-group={g.clipIds.join(",")}
          width={0} height={0}
          style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, zIndex: at + 1, pointerEvents: "none", ...(shown ? null : { display: "none" }) }} />;
      })}
    </div>
  );
}
