import type { ComponentType } from "react";
import type { ClipEmphasis } from "./emphasis.ts";
import type { FrameModeInput } from "./frameMode.mjs";

/**
 * 控件的公共字段。
 * `required` 是给「没有它这张卡就没有意义」的参数用的(例如字幕轨的 lines):
 * 建卡和改参数时会校验,缺了直接报错,而不是悄悄用默认值把演示内容播出去。
 * `hint` 写给人也写给 AI —— 它会出现在 list_cards 的返回里。
 */
interface ControlBase {
  key: string;
  label: string;
  required?: boolean;
  hint?: string;
}

/** 参数面板控件描述。原型阶段只支持这几种。 */
export type Control =
  | (ControlBase & { type: "text" })
  | (ControlBase & { type: "number"; min?: number; max?: number; step?: number })
  | (ControlBase & { type: "select"; options: { value: string; label: string }[] })
  | (ControlBase & { type: "color" })
  /**
   * 素材目录里挑一个(Lottie 动画 / 粒子配置)。value 是同源 URL,直接填进参数;
   * 和 select 的区别:**不限定取值** —— 目录之外的 URL、内联 JSON 照样能填。
   * options 来自 src/cards/catalogAssets.ts,list_cards 原样带出去,AI 看到就知道有哪些素材。
   */
  | (ControlBase & { type: "asset"; kind: "lottie" | "particles"; options: { value: string; label: string }[] });

export interface CardProps<P> {
  params: P;
  /** 每次重播 +1。卡片组件用 key={playToken} 挂载,所以组件内部不需要读它;保留给需要手动重置的卡。 */
  playToken: number;
  /**
   * 普通视觉卡为自 clip 起点起的秒数；带 audio() 的视觉卡为已包含源偏移的秒数(舞台每帧传入)。
   * 声画卡与 audio 的 range.start/sampleRate 同钟，不要再次叠加 sourceOffset。绝大多数卡不需要它(挂载即播);
   * 只有「跟着时间轴走」的卡(章节导航、字幕轨、口播视频 seek)才读它。
   */
  t?: number;
  /** 裁切/切分后的源偏移（秒）。普通 mu-typing 用它补局部 t；有 audio() 的卡其 t 已含此值，只作诊断。 */
  sourceOffset?: number;
  /**
   * 挂载钟:这张卡自挂载起经过的舞台毫秒。**只有平铺时间轴的导出页**(`ExportView` 里不经 `FrameScene` 的那个 `Stage`)
   * 会传,而且只在卡片是在片段起点之前挂上的时候传(舞台提前 `CARD_MOUNT_LEAD` 挂载,30 fps 下就是早一帧)。
   * 旧的「挂载即播」卡从挂载那一刻起计时,在这条路径上比片段起点早走这一段;改成按 `t` 取画面的卡要与旧画面逐帧一致,
   * 就在收到它时用它代替 `t`(mu-typing)。预览、Project 导出、预渲染都不传,那里一律按 `t`。
   */
  mountClockMs?: number;
  /** clip 总时长(秒) */
  duration?: number;
  /**
   * 舞台的画幅和相机。绝大多数卡不需要它 —— 卡片按自己那一格排版,不该关心整个画面多大。
   *
   * 只有**自带三维场景**的卡(scene-3d)需要:它要用和 A 层 CSS 完全同一台相机,
   * 两边的透视强度才对得上。让它自己开一个 fov 参数、再靠人记得填成同一个数,
   * 是必然会对不上的设计 —— 项目一改 fov,那张卡就悄悄不在同一个空间里了。
   */
  stage?: { width: number; height: number; camera3dFov?: number };
}

/**
 * 卡片对外暴露的**部件树**:约定封装的结构一半。
 *
 * 一张卡在外面看不该是一坨扁平参数:要点钉板是「标题 + 副标题 + 一列要点」,每个部件由
 * 哪几个参数驱动、什么时候进场、多久落定,都写在这棵树上。代码页(CodeTab)按这棵树把
 * 参数分组显示,Agent 拿到的封装(kernel/envelope.ts)也按它组织 —— 两边看到的是同一个结构。
 *
 * 部件目前**不是**独立的渲染单元(部件级 frame 还没落地,见 ClipFrame 的说明),所以这里
 * 只有「结构 + 参数归属 + 时序」,没有位置。将来部件级 frame 加进来时就挂在这个节点上。
 */
export interface CardPart {
  /** 稳定 id,卡内唯一,如 "title"、"items" */
  id: string;
  label: string;
  /** 部件是什么:文字 / 媒体(图、动画、canvas)/ 列表 / 装饰 / 分组 */
  role?: "text" | "media" | "list" | "decor" | "group";
  /** 驱动这个部件的参数键(controls 里的 key) */
  params?: string[];
  children?: CardPart[];
  /** 相对 clip 起点,这个部件什么时候开始进场(毫秒);静态可知时填 */
  enterMs?: number;
  /** 进场动画什么时候落定(毫秒);列表类按最后一项算 */
  settleMs?: number;
}

/**
 * 卡片的生命周期声明:约定封装的时间一半。
 *
 * 大多数卡只有进场动画,落定之后就静止到 clip 结束 —— 但这件事以前没处写,Agent 给一张
 * 0.9 秒落定的卡配 3 秒时长时不知道后面 2 秒是死的。这里把它说清楚。退场目前只有 clip 级
 * 的 fadeOut(整体淡出);卡片自己实现的反向退场还没有,所以 exit 里暂时只会出现 "fade"。
 */
export interface CardLifecycle {
  /** 进场动画多久落定(毫秒,按默认参数算);跟着时间轴走或一直在变的卡可以不填 */
  settleMs?: number;
  /** 落定之后:hold 停住不动 / loop 循环重播 / evolve 一直在变(粒子、跟时间轴走的卡) */
  after: "hold" | "loop" | "evolve";
  /** 支持的退场方式。"fade" = 用 clip.fadeOut 整体淡出,所有卡都支持 */
  exit: ("fade" | "reverse")[];
}

/**
 * 按**当前参数**算出来的时序:和 frame 的 local → world 一样,是派生量,不落盘。
 *
 * parts / lifecycle 里写的 settleMs 是按默认参数算的静态值;条目数、字数、间隔一改,
 * 落定时刻就变了。卡片给一个 timing 函数,封装(kernel/envelope.ts)每次读的时候按 clip
 * 实际参数重算,代码页和 get_clip 看到的永远是**这一张**卡此刻的时序,不是默认值的。
 * 没给 timing 的卡照用静态值。
 */
export interface CardTiming {
  /** 整张卡最晚落定(毫秒) */
  settleMs?: number;
  /** 按部件 id 覆盖各部件的进场 / 落定时刻 */
  parts?: Record<string, { enterMs?: number; settleMs?: number }>;
  /** 落定之后的行为随参数变(比如 loop 开关) */
  after?: "hold" | "loop" | "evolve";
}

/**
 * 图卡的一路输入。`at()` 只返回一个**引用**(执行器自己解析,不落像素),
 * `pixels()` 才真的解出像素,`block()` 取音频采样。
 */
export interface GraphCardSource {
  /** 这路输入指向的图节点 id */
  nodeId: string;
  /** 输入在 `t`(缺省 = 本次求值的时间)的结果引用,直接喂给 `glsl()` */
  at(t?: number): import("./cardGpu").SourceValue;
  /** 真的把输入解成像素。比 `at()` 慢得多,只有 CPU 像素算法才用 */
  pixels(t?: number, signal?: AbortSignal): Promise<ImageBitmap>;
  /** 取 [start, start + count) 这段采样(交错多声道) */
  block(start: number, count: number): Promise<Float32Array>;
}

/** 图卡求值时的画幅信息。`stage` 和 CardProps.stage 同一个口径。 */
export interface GraphCardContext {
  fps: number;
  width: number;
  height: number;
  /** 片段时长(秒) */
  duration: number;
  stage?: { width: number; height: number; camera3dFov?: number };
}

/** 音频图卡的采样区间。按采样点算,不按帧取整。 */
export interface GraphAudioRange {
  start: number;
  count: number;
  sampleRate: number;
}

/** 卡片契约。所有卡片(自家写的、Magic UI 适配的、AI 现场建的)都长这样。 */
export interface CardDef<P = Record<string, unknown>> {
  id: string;
  name: string;
  /** 一句话说清这张卡长什么样、播什么动效 */
  description: string;
  /**
   * 来源标签,给面板分组。`user` 是 AI 或用户后来建的,存在 src/cards/user/;
   * `asset` 是从素材目录(Lottie 动画 / 粒子配置)翻译出来的封装卡,见 src/cards/assets/
   */
  source: "magicui" | "native" | "user" | "asset";
  /**
   * 什么时候该选这张卡 —— 写给 AI 看的选卡依据,而不是描述外观。
   * 例:"口播里出现带单位的数字(3 倍、80%)时用它把数字放大成主视觉"。
   * list_cards 的摘要里会带上它,AI 靠它一次扫完所有卡就能选,不用挨个看参数。
   */
  useWhen?: string;
  /** 检索用的关键词,和 useWhen 配合让 list_cards 能按内容筛 */
  tags?: string[];
  defaults: P;
  controls: Control[];
  /**
   * DOM 卡的 React 组件。可同时声明 audio()，声音由宿主统一调度；视觉图卡 card() 由 GraphCard 代渲;
   * 两者都没有的定义既不是 DOM 卡也不是图卡,`Stage` 会整段跳过。
   */
  Component?: ComponentType<CardProps<P>>;
  /** 图卡的类别(同 cardGraph.mjs 的 CARD_KINDS)。缺省 = `animation`。 */
  kind?: "animation" | "filter" | "transition" | "emphasis" | "audio";
  /**
   * 图卡的输入名。缺省按 kind 推:`filter` / `emphasis` / `audio` 是 `{ source: {} }`,
   * `transition` 是 `{ A: {}, B: {} }`,`animation` 没有输入。
   */
  inputs?: Record<string, { description?: string }>;
  /**
   * 视觉图卡:按片段源时间 `t`(秒，含节点 timeOffset)算出一份 GPU 描述,由宿主在 WebGL 上执行。
   * `sources[name]` 见 `src/render/cards/GraphCard.tsx`;帮助函数在 `src/render/cards/graphValues.ts`。
   */
  card?: (
    sources: Record<string, GraphCardSource>,
    t: number,
    params: P,
    ctx: GraphCardContext,
  ) => import("./cardGpu").CardGpuValue | Promise<import("./cardGpu").CardGpuValue>;
  /** 按采样区间产出交错 Float32 采样块。可与 Component/card 共存，使用同一参数与源时间；不得自行播放音频。inputs:{} 表示纯合成。 */
  audio?: (
    sources: Record<string, GraphCardSource>,
    range: GraphAudioRange,
    params: P,
  ) => Float32Array | Promise<Float32Array>;
  /** 部件树(约定封装的结构)。没写 = 整张卡是一个部件,所有参数都归它 */
  parts?: CardPart[];
  /** 生命周期(约定封装的时间)。没写 = 按「有进场动画、之后停住、只支持淡出」处理 */
  lifecycle?: CardLifecycle;
  /** 按当前参数重算时序(见 CardTiming)。参数是和 defaults 合并后的全量 */
  timing?: (params: P) => CardTiming;
  /** direct（直接求值动画）: output depends on params + local t, including transitions.
   * stateful（状态推进动画）: requires Motion/CSS/rAF/simulation history.
   * Independent of React usage. Missing = conservative stateful, except
   * explicitly static (settleMs: 0, after: hold) legacy cards.
   * Old react / non-react declarations remain accepted for .proc compatibility.
   */
  frameMode?: FrameModeInput;
  /** True requires ordered state advancement before arbitrary-time access.
   * Missing declarations use the conservative legacy capability adapter. */
  need_prerendering?: boolean;
  /** Independently reviewed from time access. Background-dependent and unknown
   * cards keep the complete Chrome compositing context. */
  compositing?: import('./frameMode.mjs').CardCompositing;
  /** 画布卡(2D canvas / WebGL):走共享 WebGL 渲染器、快照要先栅格成 img。
   * 缺省 = 纯 DOM 卡。和 frameMode / compositing 一样是审阅结论,不猜源码。 */
  canvasHeavy?: boolean;
}

/**
 * 让一张卡跟着画面里的目标走。
 *
 * 存的是**位移**而不是绝对位置：舞台按 `xy[f] - xy[anchor]` 平移整个 clip 层，
 * 所以卡片仍然待在设计时摆的地方，只是跟着目标一起挪。这样就不需要知道卡片
 * 在它那一层里把自己画在了哪儿 —— 那是卡片组件内部的事，外面看不见。
 *
 * 坐标是**舞台像素**，写入时就从素材原始像素换算好了。之所以在写入时换算而不是
 * 播放时换算：素材以后可能被替换或改分辨率，那时这条轨迹本来就该重新追，
 * 留着换算参数只会让人以为它还准。
 */
/**
 * 一个节点在父坐标系里的框。
 *
 * 卡片级的父坐标系就是舞台(原点左上角、单位像素),所以卡片的 frame 既是「组内相对」
 * 也是「画面绝对」。将来部件级的 frame 相对的是所在卡片的框,画面绝对位置由
 * kernel/layout.ts 逐级合成出来、**从不落盘** —— 只存一种坐标,另一种永远推导,
 * 两边才不会漂。
 *
 * 位置指的是**锚点**所在的位置,不是左上角:anchor [0.5,0.5] + x,y = 960,540 就是居中。
 * 缩放和旋转也绕锚点。没有 frame = 铺满父坐标系(向后兼容,老项目一个字节不变)。
 */
export interface ClipFrame {
  /** 锚点所在的父坐标系位置(像素) */
  x: number;
  y: number;
  /** 框的尺寸(像素)。省略 = 父坐标系的尺寸。注意这是卡片的**画布**,大多数卡按 1920×1080 设计,
   *  缩小画布不等于缩小内容 —— 要整体缩小用 scale */
  w?: number;
  h?: number;
  /** x,y 定位的是框内哪个点:[0,0] 左上、[0.5,0.5] 中心、[1,1] 右下。默认 [0,0] */
  anchor?: [number, number];
  /** 默认 1,绕锚点 */
  scale?: number;
  /** 度,顺时针,默认 0,绕锚点。这是**平面内**的旋转(绕 z 轴) */
  rotate?: number;

  /*
   * ── 三维(可选,不填就完全是老行为,老项目一个字节不变)────────────────
   *
   * 单位和 2D 那几项一致:角度是度,`translateZ` 是**舞台像素**,朝观众为正
   * (和 CSS 的 `translateZ(+)`、和 src/kernel/space3d.ts 的世界 z 同向)。
   *
   * 透视强度不在这里 —— 它是**整个舞台**的属性(一个画面只有一台相机),
   * 存在 project.camera3dFov 上。卡片只说自己在空间里怎么摆,不说别人怎么看它。
   *
   * 旋转的正方向照抄 CSS,不自己发明(否则 frameCss 里就得取反,而那种取反没人记得住)。
   * 两个方向都实测过:perspective 600 下转 40°,近的那条边投影出来更长。
   */
  /** 绕水平轴翻转(度)。正值 = **顶边往里倒、底边朝观众抬起来** */
  rotateX?: number;
  /** 绕垂直轴翻转(度)。正值 = **右边往里转、左边朝观众转过来** */
  rotateY?: number;
  /** 沿深度方向平移(舞台像素),正值朝观众 */
  translateZ?: number;
}

export interface ClipMotion {
  /** 轨迹来自哪段素材、哪一个查询点。只用于说明来源，播放时用不到 */
  mediaId: string;
  pointIndex: number;
  /** 逐帧位移（舞台像素），已经减掉锚点。第 0 项必为 [0, 0] */
  offsets: [number, number][];
  /** 每帧目标是否可见。跟丢的帧按 whenHidden 处理 */
  visible: boolean[];
  /** 轨迹每帧对应的时间步长（秒）。素材帧率和项目帧率不一定一样 */
  frameStep: number;
  /**
   * 目标不可见时怎么办。
   * hold = 停在最后一次看见的位置（短暂遮挡时最不打眼）；
   * hide = 整张卡不渲染（目标真的走了、卡片指着空气时用这个）。
   */
  whenHidden: "hold" | "hide";
}

/**
 * 组合卡里的一个部件实例:引用部件库里的哪个部件、它的参数、相对父框的框、进场时机、子实例。
 * 只存局部框,画面绝对位置由 kernel/parts.ts 的 placeParts 逐级合成。
 * 树的增删改移走 kernel/parts.ts 的纯函数;Agent 走 add_part / set_part / remove_part / move_part。
 */
export interface PartInstance {
  /** 实例 id,一棵树内唯一 */
  id: string;
  /** 部件库里的部件 id(src/parts) */
  partId: string;
  /** 全量参数(写入时就和部件 defaults 合并好) */
  params: Record<string, unknown>;
  /** 相对父框(根实例的父框是组合卡画布)。没有 = 铺满父框 */
  frame?: ClipFrame;
  /** 相对父实例进场的毫秒数;根实例相对 clip 起点 */
  enterMs?: number;
  /** 给人看的名字,没有就用部件名 */
  label?: string;
  children?: PartInstance[];
}

/** 时间轴上的一张卡 */
export interface Clip {
  id: string;
  /** Output node in the project's common card graph, when present. */
  nodeId?: string;
  cardId: string;
  start: number; // 秒
  end: number; // 秒
  params: Record<string, unknown>;
  /** 仅渲染时间轴派生值，不另存配方；事件型卡片的原始时间偏移（秒）。 */
  sourceOffset?: number;
  /** 绑定到一条运动轨迹。没绑就是 undefined，卡片位置固定 */
  motion?: ClipMotion;
  /** 卡片在舞台上的框(位置/尺寸/锚点/缩放/旋转)。没有就铺满舞台。见 ClipFrame */
  frame?: ClipFrame;
  /**
   * 淡入 / 淡出时长(秒)。两段素材在时间上重叠、各自带上淡出淡入,就是交叉溶解——
   * 转场不是独立的对象,而是「重叠 + 淡化」的结果,所以不用往模型里塞 transition 类型。
   * 同一条序列内不允许重叠,所以交叉溶解必然发生在两条序列之间。
   * 卡片 clip 也吃这三个字段(Stage 按 cardOpacityAt 算),以前只有视频层吃。
   */
  fadeIn?: number;
  fadeOut?: number;
  /** 整体不透明度(0-1,默认 1)。音频段用它当音量。 */
  opacity?: number;
  /**
   * 强调:沿着画面里不透明部分的边缘加阴影或描边(kernel/emphasis.ts)。
   * 走 CSS 的 drop-shadow,按 alpha 通道算 —— 描的是文字 / 图形的边,不是那个方框。
   */
  emphasis?: ClipEmphasis;
  /** 组合卡(cardId "composite")的部件实例树。别的卡没有这个字段 */
  parts?: PartInstance[];
}

export interface Timeline {
  width: number;
  height: number;
  fps: number;
  duration: number; // 秒
  clips: Clip[];
  /**
   * 图卡的节点图。**只有两个宿主算它**(ExportView / StageView),`flattenOverlay`
   * 只负责原样带过来 —— 它自己不算图(算了就是每帧每片段重算一遍全图)。
   * 算不出来(片段删了留下悬空输入之类)时是 `undefined`,舞台按「图卡不画」兜底。
   */
  graph?: ReturnType<typeof import("./cardGraph.mjs").projectCardGraph>;
  /**
   * 三维透视强度,从 project.camera3dFov 带过来。不开三维时**这个键根本不存在** ——
   * 老项目的 timeline 对象要逐字段和以前一样。
   *
   * 它必须走 Timeline 而不是各个视图各读各的 project:预览(StageView)和导出(ExportView)
   * 都只拿到 Timeline,漏一处就是「预览有透视、导出没有」,而那种分叉不报错。
   */
  camera3dFov?: number;
  /**
   * 主题 id。**卡片的每一处 `var(--pc-…)` 都靠它**,所以它和 camera3dFov 走同一条路:
   * 放进 Timeline,而不是让预览和导出各自去读 project。
   *
   * 上面那条注释预言的事真发生过一次,漏的就是这个字段:StageView 挂了 themeStyle,
   * ExportView 没挂。默认主题下大部分兜底值和主题值碰巧相同,只有等宽字体露馅 ——
   * 预览是 Consolas,成片是 NSimSun,而且不报错。换个主题就是全线错色。
   */
  themeId?: string;
}
