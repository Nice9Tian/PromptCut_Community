import type { Clip, Timeline } from "./types";
import type { SoundEffectRecipe } from "./soundEffects";
import { cutSegmentRender, CUT_SEGMENT_CARD, type CutRenderProject, type TimelineCutClip } from "./cutSegments.ts";
import { envelopeAt } from "./cutAudio.mjs";
import { cardClockOffset, clipSpeed } from "./clipTime.mjs";

/** 可重生成的音效配方。reuseKey 是合成输入身份,不是 WAV 内容哈希。 */
export interface SoundEffectLink {
  recipe: SoundEffectRecipe;
  reuseKey: string;
}

export interface SoundEffectClipLink extends SoundEffectLink {
  requestId: string;
  /** 声画共享时间锚点,音频仍只消费普通 WAV 素材。 */
  sourceClipId?: string;
}


/**
 * 项目文档模型(多轨)。这是编辑器、时间轴、左右栏、MCP 工具、导入导出共用的唯一真源。
 * 保存到磁盘的 .promptcut.json 就是 Project 的 JSON。
 */

/** 语音转文字的一段 */
export interface TranscriptSegment {
  start: number; // 秒(素材内时间)
  end: number;
  text: string;
}

export interface Transcript {
  engine: string; // "faster-whisper" | "whisper"
  model: string;
  language?: string;
  createdAt: string; // ISO
  segments: TranscriptSegment[];
}

export type TransitionKind = "cut" | "dissolve";

/** 一次转场。硬切的 start/end 几乎相等；溶解是整段渐变的起止 */
export interface ShotTransition {
  kind: TransitionKind;
  start: number;
  end: number;
  /** 置信度最高的那一帧的时间，画标记时对准它 */
  time: number;
  confidence: number;
  /** 缩略图文件名。溶解有两张（渐变前后各一），时间轴上叠着画 */
  thumbs?: string[];
}

/** 镜头划分结果，由镜头识别工具写入 */
export interface Shots {
  /** transnetv2 认得溶解；scdet 是没装拓展时的兜底，只认硬切 */
  engine: "transnetv2" | "scdet";
  createdAt: string;
  transitions: ShotTransition[];
  shots: { start: number; end: number; inTransition: TransitionKind | null; outTransition: TransitionKind | null }[];
}

/** 画面里的一个目标框。坐标是**素材原始像素**,和 width/height 同一套 */
export interface SubjectBox {
  /** light 档只有 person / face;full 档是提示词里的名词 */
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

/** 四个方位各被目标框覆盖了多少(0~1)。left/right 是左右半屏,top/bottom 是上下 1/3 带 */
export interface SubjectOccupancy {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type SafeSide = "left" | "right" | "top" | "bottom";

/** 某一时刻抽一帧检测出来的结果 */
export interface SubjectSample {
  /** 素材内的秒数 */
  t: number;
  boxes: SubjectBox[];
  /** occupancy 最小的那一侧 —— 把卡片放这边最不容易遮住人 */
  safeSide: SafeSide;
  occupancy: SubjectOccupancy;
  /**
   * true 表示这一帧**没抽出来**(seek 超出时长、文件那一段坏了),上面的 boxes 是空的、
   * occupancy 四个 0、safeSide 是个占位值。
   *
   * 这个标记非有不可:抽帧失败的样本和「这一帧真的没有人」在 JSON 里逐字段相同,
   * 不标出来的话 subjectForRange 会把一串 0 平均进去,给出「这段没人、right 侧安全」
   * 的伪结论 —— 恰好是这个功能最该避免的那种错。读取侧一律先过滤掉 failed。
   */
  failed?: boolean;
  /** failed 为 true 时的原因(Python 侧给的那句),用来让人看出是哪一帧、为什么 */
  reason?: string;
}

/** 主体检测结果,由 detect_subjects 写入 */
export interface Subjects {
  /** light = YuNet + RT-DETR(只认 person/face);full = 再加 Grounding DINO(认提示词) */
  engine: "light" | "full";
  createdAt: string;
  /** 检测时用的提示词。light 档忽略它,但原样存着,免得以后分不清这批结果是怎么来的 */
  prompt: string;
  /** 素材原始宽高,boxes 的坐标系 */
  width: number;
  height: number;
  samples: SubjectSample[];
  /** samples 里 failed 的个数。0 或缺省表示每一帧都抽出来了 */
  failedCount?: number;
  /**
   * 本来该跑 full 档、但中途退回了 light 时填 "full"(比如 DINO 目录缺分词器文件)。
   * engine 字段记的是**实际**跑的那一档,所以只看 engine 会以为用户本来就只装了 light。
   */
  fellBackFrom?: "full";
  /** fellBackFrom 时的原因,原样透给调用方 —— 不说原因用户没法修 */
  fallbackReason?: string;
}

/**
 * 同一份素材的两档(A1 第 5 步:先小后大),值是各自的内容哈希。
 * `original` 就是 MediaAsset.hash;`small` 是 800×600 以内的 H.264 档。
 * 换档判据在 src/render/mediaTier.ts 的 playbackUrl(只看素材服务报 complete 的哈希)。素材小尺寸由导入方本机生成(C6.6,server/media-tiers.mjs)。
 * 「这台设备放不放得了素材原尺寸」不是项目级的事实,不在这里记,见 src/render/playability.ts。
 */
export interface MediaTiers {
  small?: string;
  original: string;
}

export interface MediaAsset {
  soundEffect?: SoundEffectLink;
  /** 镜头切换识别结果(可选,由 detect_shots 写入) */
  shots?: Shots;
  /** 主体检测结果(可选,由 detect_subjects 写入) */
  subjects?: Subjects;
  /** 语音转文字结果(可选,由 STT 工具写入) */
  transcript?: Transcript;
  id: string;
  kind: "video" | "audio" | "image";
  name: string;
  /** 浏览器里可播的 URL(blob: 或 /media/xxx);保存项目时存相对路径 */
  url: string;
  /** 服务端可读的绝对磁盘路径，由导入时上传得到，可能不存在 */
  path?: string;
  /**
   * 素材键 = 文件内容的 sha256(64 位小写 hex),导入时由服务端边落盘边算
   * (server/vite-plugin-media.ts 的 storeMediaStream)。有它就一律走
   * /@media/<hash>:换了文件名、改了 mtime、拷到另一台机器都还是同一个键。
   * 没有 hash 的是迁移期的老 .proc —— 那种继续按 path / 文件名找文件。
   */
  hash?: string;
  /** 原文件扩展名(不含点,小写)。内容库里存成 <hash>.<ext>,回放靠它定 Content-Type */
  ext?: string;
  /** 原文件字节数 */
  size?: number;
  /**
   * 还在入库(上传 / 算哈希)中:这一层先画「上传中」占位,不挂空 src。
   * 只在编辑器会话内有意义,存盘再打开时由 restoreMediaUrls 清掉。
   */
  pending?: boolean;
  /** A1:同一素材的两档(先小后大)。只有视频有;素材小尺寸由导入方本机生成(C6.6),换档见 src/render/mediaTier.ts */
  tiers?: MediaTiers;
  duration?: number; // 秒
  width?: number;
  height?: number;
  /**
   * 「只要声音」的那一份是从哪段视频派生的(soundAssetFrom)。
   * 两份指着同一个文件,只是 kind 不同 —— 不做转码,所以「创建为声音」是瞬间的。
   * 导出上传本地文件时靠它找回源文件(见 editor/io/index.ts)。
   */
  soundOf?: string;
  /** Only an explicit, serialized recovery result may activate a missing-material proxy. */
  missingMaterial?: {
    v: 1;
    mediaId: string;
    original: { kind: "video" | "audio" | "image"; name: string; url: string; hash?: string; path?: string };
    reason: "confirmed-missing";
    visual: boolean;
    audio: boolean;
  };
}

/**
 * 老项目曾把图片统一登记成 kind:"video"。渲染时不能只相信 kind，
 * 否则 JPG/PNG 会被挂到 <video> 上，Chrome 会在首帧后报解码错误。
 * 文件名、路径和 URL 都参与判断，兼容存盘前后的三种地址形态。
 */
const IMAGE_MEDIA_EXT = /\.(?:png|jpe?g|gif|webp|bmp|avif|tiff?|svg|heic|heif)(?:[?#]|$)/i;
export function isImageMedia(media: Pick<MediaAsset, "kind" | "name" | "path" | "url">): boolean {
  if (media.kind === "image") return true;
  return [media.name, media.path, media.url].some((value) =>
    typeof value === "string" && IMAGE_MEDIA_EXT.test(value.split(/[?#]/, 1)[0]),
  );
}

/**
 * 从一段视频派生出「只要声音」的素材:同一个文件、同一段时长,kind 换成 audio。
 * 不转码 —— 浏览器用 <audio> 播 mp4 只出声音,ffmpeg 混音也只取音轨,没必要先切一份文件出来。
 */
export function soundAssetFrom(src: MediaAsset, id: string): MediaAsset {
  return {
    id,
    kind: "audio",
    name: `${src.name.replace(/\.[^.]+$/, "")} · 声音`,
    url: src.url,
    ...(src.path ? { path: src.path } : {}),
    ...(src.duration != null ? { duration: src.duration } : {}),
    // 转写是对同一条音轨做的,派生的这份直接继承,省得再转一遍
    ...(src.transcript ? { transcript: src.transcript } : {}),
    soundOf: src.id,
  };
}

/** 这段素材已经派生过声音了吗(派生是幂等的,同一段只留一份) */
export function findSoundAsset(p: Project, mediaId: string): MediaAsset | undefined {
  return p.media.find((m) => m.kind === "audio" && m.soundOf === mediaId);
}

/**
 * 序列(以前分「动效轨 / 视频轨」两种,现在不分了):
 * 一条序列里既能放卡片段(cardId),也能放素材段(mediaId),不重叠、按 start 排序。
 * 叠放顺序跟着时间轴上看到的来:**靠上的序列画在上层**(tracks[0] 是最上面那一行,
 * 也就是最上层)。渲染时把数组倒过来遍历,DOM 里靠后的仍然压住靠前的,
 * 所以下游(Stage、MediaLayers、videoClipAt、命中测试)统一按「列表最后一个 = 最上层」理解。
 * 旧项目文件里的 kind 字段读进来就忽略掉。
 */
export interface Track {
  id: string;
  name: string;
  hidden?: boolean;
  muted?: boolean;
  locked?: boolean;
  /** 同一条序列内 clip 不重叠,按 start 排序 */
  clips: TrackClip[];
}

/** 轨道上的一段。overlay 轨用 cardId+params;video 轨用 mediaId(+ 素材内偏移)。 */
export interface TrackClip extends Clip {
  /** 视觉卡内带声音的持久能力标记，让无卡片运行时的导出也能拒绝缺失的声音。 */
  embeddedAudio?: boolean;
  /** 同片段视觉卡的持久 WAV 声音产物,由 AV 卡生成流程维护。 */
  cardAudio?: import("./cardAudioRendition.mjs").CardAudioRendition;
  soundEffect?: SoundEffectClipLink;
  mediaId?: string;
  /** 视频段从素材的第几秒开始播(默认 0) */
  mediaOffset?: number;
  /**
   * 视频段的播放速度(缺省 1;0.5 慢放、2 快放,范围见 kernel/clipTime.mjs)。素材时刻 = mediaOffset + (t − start) × speed,
   * 各处一律调 `clipTime.mjs` 换算。等于 1 时**不写这个字段**(改回 1 就删掉),身份键才逐字不变。
   * 〔裁〕第一版变速的视频段不出原声(`speedMutesSource`),界面写明;声音段(含音画分离出来的)变速时随倍率变调照常出声。
   */
  speed?: number;
  audioMuted?: boolean;
  /** 独立声音音量，0~1；缺省为原声 1。 */
  audioVolume?: number;
  label?: string;
  /** 挂着的滤镜:引用 project.filters 里的一条 + 这一段的参数值。只有素材段有。见 kernel/filters.mjs */
  filter?: import("./filters.mjs").ClipFilter;
  /** 通用像素映射:引用 project.pixelMaps 里的一条。只有视频 / 图片段有。 */
  pixelMap?: import("./pixelMap.mjs").ClipPixelMap;
  /** 挂着的音频效果:引用 project.audioFx 里的一条 + 这一段的参数值。只有视频 / 声音段有。见 kernel/audioFx.mjs */
  audioFx?: import("./audioFx.mjs").ClipAudioFx;
  // fadeIn / fadeOut / opacity 挪到了 kernel/types.ts 的 Clip 上:卡片 clip 现在也吃它们,
  // 不再是素材段专属。
  /**
   * 剪辑段:引用的剪辑 id(见 kernel/cutSegments.ts)。有它的段 cardId 为空串、没有 mediaId。
   * 0.7.18 及更早的页面不认它,只是不画、不出声,字段原样保留。
   */
  cutId?: string;
  /** 剪辑段从被引用剪辑的第几秒开始(缺省 0)。切分时后半段累加前半段的长度 */
  cutOffset?: number;
  /**
   * **只在渲染派生出来的片段上有,不落盘**:外层剪辑段一层层的包络(父剪辑时间)。
   * `opacityAt` 乘上去;混音器(`audioPlan.mjs`)照同一组包络算增益。见 kernel/cutSegments.ts 的 audioProjectOf。
   */
  cutEnv?: import("./cutAudio.mjs").CutEnvelope[];
  /** **只在渲染派生出来的片段上有,不落盘**:展开前的片段 id 和经过的剪辑段 */
  cutOrigin?: import("./cutAudio.mjs").CutAudioOrigin;
}

/**
 * 一条剪辑(一整条时间轴)。项目里可以有多条,时间轴顶部的选项栏切换。
 *
 * 内容只存一份:**当前激活的那条**的 tracks / duration 住在 Project.tracks / Project.duration 里
 * (和只有一条剪辑的时候一模一样,所以全项目七十来处读 project.tracks 的地方一处不用改),
 * 它在 cuts 里的条目只有 id 和 name;**停放的**那些各自带着自己的 tracks / duration / t。
 * 切换 = 把当前内容存回它的条目、把目标条目的内容换进来(kernel/cuts.ts)。
 *
 * 命名:代码里 Track 已经叫「序列」了,这一层叫 Cut、界面上叫「剪辑」,别撞名。
 */
import type { Transition } from "./transitions.ts";

export interface Cut {
  id: string;
  name: string;
  /** 停放时才有;激活的那条为 undefined,内容在 Project.tracks */
  tracks?: Track[];
  duration?: number;
  /** 停放时才有:这条剪辑的转场记录 */
  transitions?: Transition[];
  /** 上次离开时的播放头,切回来接着看 */
  t?: number;
}

export interface Project {
  version: 1;
  /** 素材效果卡的实例节点。定义不在项目里 —— 它是 `src/cards/user/<id>.tsx` 文件,从注册表取。 */
  cardNodes?: import('./cardGraph.mjs').CardNode[];
  style?: Record<string, unknown>;
  /**
   * 项目自己的身份,跟着 .proc 走。定制卡的归属表(src/cards/user/_scopes.json)认的就是它。
   *
   * 以前归属认的是**草稿 id** —— 那是存放位置,不是身份:从桌面双击打开、另存为、换台机器,
   * 草稿 id 都会变(甚至是 null),于是 Agent 给这个项目写的卡在它自己的卡库里也看不见了。
   * 老文件没有这个字段:从草稿打开时拿草稿 id 顶上(和归属表里的老条目对得上),其余现生成一个。
   */
  id?: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number; // 秒
  themeId: string;
  /**
   * 三维透视强度(垂直视场角,度)。**一个画面只有一台相机**,所以它在项目上,不在卡片上。
   *
   * 不填 = 不开三维:舞台不加 perspective,所有卡片的渲染和以前一模一样。
   * 只有卡片真的用了 rotateX/rotateY/translateZ 时才需要它 —— 没有 perspective 的话
   * 那几个变换会退化成仿射拉伸(平行线仍然平行),看着像"歪了"而不是"立起来了"。
   *
   * 为什么存 fov 而不是相机距离:距离和画幅绑死(竖屏 H 从 1080 变 1920,同一个距离
   * 透视强度就变了),而 fov 跨画幅稳定。换算见 src/kernel/space3d.ts。
   */
  camera3dFov?: number;
  /**
   * canvas 卡的共享 WebGL 渲染器走哪条路线(R9 M2,项目选项)。
   *   - `perDocument`:每个舞台各一个 Worker 和上下文(桌面默认);
   *   - `shared`:编辑界面只开一个 Worker 和上下文,两个舞台共用。
   * 不填 = `perDocument`(生效值见 `render/costDevice.mjs` 的 `resolveGlRoute`)。只管桌面版;在线页面的路线由舞台闸门定,不看这一项
   * (`online/onlineTier.ts` 的 `tierGlRoute`:到达第三级各一套,其余共用)。
   * 导出页在预渲染进程里没有父页,永远走 `perDocument`,不看这一项。
   */
  glRoute?: "perDocument" | "shared";
  /**
   * 创造力等级的项目默认(`user-workflow.md`「创造力等级」,定义见 `kernel/creativity.mjs`)。
   * 在项目设置里选;AI 栏每个对话默认取它、可以单独改,桌面 APP 的会话跟随它。
   * 不填 = 出厂的「高」(旧项目没有这个字段)。Agent 不能写它:`set_project_meta` 只收声明过的字段。
   */
  creativity?: import("./creativity.mjs").CreativityLevel;
  media: MediaAsset[];
  tracks: Track[];
  /** 全部剪辑,按选项栏顺序。老文件没有这个字段,加载时 normalizeCuts 补成三条 */
  cuts?: Cut[];
  /**
   * 转场记录(当前激活的这条剪辑的)。一条转场绑住它引用的那几段:
   * 相对时间关系锁住,想单独改先删转场。见 kernel/transitions.ts。
   */
  transitions?: Transition[];
  /** 当前激活的剪辑。tracks / duration 就是它的内容 */
  activeCutId?: string;
  /**
   * 滤镜库(素材库「转场/滤镜」页列的那些)。项目级,所有剪辑共用;片段用 clip.filter 引用其中一条。
   * 见 kernel/filters.mjs。
   */
  filters?: import("./filters.mjs").FilterDef[];
  /** 通用像素映射库。片段通过 pixelMap 引用其中一条。 */
  pixelMaps?: import("./pixelMap.mjs").PixelMapDef[];
  /**
   * 音频效果库(素材库「音频效果」页列的那些)。项目级,所有剪辑共用;片段用 clip.audioFx 引用其中一条。
   * 见 kernel/audioFx.mjs。
   */
  audioFx?: import("./audioFx.mjs").AudioFxDef[];
}

/** 新拖上时间轴的卡片默认时长(秒);落点预览和真正落卡用的是同一个值 */
export const DEFAULT_CARD_DUR = 3;

/** 素材没有时长信息时,视频段的兜底时长(秒) */
export const DEFAULT_MEDIA_DUR = 5;

/** 新项目的身份。只求不撞,不求好看 */
export function newProjectId(): string {
  const rand = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `p-${Date.now().toString(36)}-${rand}`;
}

export function createEmptyProject(name = "未命名"): Project {
  return {
    version: 1,
    id: newProjectId(),
    name,
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 30,
    themeId: "midnight",
    media: [],
    tracks: [
      { id: "t-1", name: "序列 1", clips: [] },
      { id: "t-2", name: "序列 2", clips: [] },
    ],
  };
}

/**
 * 把项目压平成 Stage 需要的 Timeline(所有序列里的卡片段,跳过 hidden 的序列)。
 * 序列顺序 = 叠放顺序:**时间轴上靠上的序列在上层**,所以这里倒着遍历 tracks ——
 * 产出的数组仍然是「靠后的画在上面」,Stage 直接按顺序渲染即可。
 * 素材段(有 mediaId)不进舞台,走视频层。
 */
/**
 * `graph` 原样放进返回的 Timeline,**这里自己不算图** —— 算图要遍历全项目,
 * 而 FrameScene 每个片段都会调一次这个函数(还是拿只剩一条轨道的裁剪版调的)。
 * 图只在两个宿主算:ExportView 和 StageView。
 */
export function flattenOverlay(p: Project, graph?: Timeline["graph"]): Timeline {
  const clips: Clip[] = [];
  for (const tr of [...p.tracks].reverse()) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (c.cutId) {
        // 剪辑段:交成一张「卡」(注册表里没有它,舞台按 clip.cut 认),包裹层照卡片的规矩摆框、
        // 算不透明度与淡入淡出、定层序,里面挂被引用剪辑的嵌套场景(kernel/cutSegments.ts 文件头)。
        // 悬空引用、循环引用:这一段不画,不抛。
        const cut = cutSegmentRender(p as CutRenderProject, c);
        if (!cut) continue;
        // 预卷:时间轴片段的起点比段的起点早(cut.from − (cutOffset − cut.offset)),露出来的仍从 cut.from 起
        const seg: TimelineCutClip = {
          id: c.id, cardId: CUT_SEGMENT_CARD, start: c.start - (Math.max(0, c.cutOffset ?? 0) - cut.offset), end: c.end, params: {}, cut,
          ...(c.frame ? { frame: c.frame } : null),
          ...(c.opacity !== undefined ? { opacity: c.opacity } : null),
          ...(c.emphasis ? { emphasis: c.emphasis } : null),
          ...(c.fadeIn ? { fadeIn: c.fadeIn } : null),
          ...(c.fadeOut ? { fadeOut: c.fadeOut } : null),
        };
        clips.push(seg);
        continue;
      }
      if (!c.cardId) continue; // 素材段交给视频层
      // motion 必须带过来:它是**播放时**才用得上的东西,漏在这里的话
      // 绑定看起来存下了、时间轴上也显示绑了,可预览和导出都一动不动。
      clips.push({
        id: c.id, cardId: c.cardId, start: c.start, end: c.end, params: c.params,
        // 打字的画面与 WAV 共用源事件时间；切开后不能从第一个字重来。
        // 变速的素材段上按卡片时钟(mediaOffset ÷ speed,kernel/clipTime.mjs 的 cardClockOffset):与卡片声音同一个时钟,切开后接得上
        ...((c.cardId === "mu-typing" || c.embeddedAudio || c.cardAudio || p.cardNodes?.some(n => n.id === c.nodeId && n.embeddedAudio))
          ? c.mediaOffset !== undefined ? { sourceOffset: clipSpeed(c) === 1 ? c.mediaOffset : cardClockOffset(c) } : c.nodeId ? { sourceOffset: Number(p.cardNodes?.find(n => n.id === c.nodeId)?.timeOffset) || 0 } : null
          : null),
        ...(c.nodeId ? { nodeId: c.nodeId } : null),
        ...(c.motion ? { motion: c.motion } : null),
        // frame 同理:它是 Stage 摆卡片时才用的,漏在这里 set_position 就成了写了不生效。
        ...(c.frame ? { frame: c.frame } : null),
        // 不透明度 / 淡入淡出也要带过来:以前只有视频层吃这三个字段,卡片 clip 上设了等于没设,
        // 模型「降不透明度避开人物」这一招在卡片上是空操作。Stage 现在按 cardOpacityAt 应用。
        ...(c.opacity !== undefined ? { opacity: c.opacity } : null),
        // 强调(阴影 / 描边)同理:Stage 渲染时才用得上,漏在这里就成了设了不生效
        ...(c.emphasis ? { emphasis: c.emphasis } : null),
        ...(c.fadeIn ? { fadeIn: c.fadeIn } : null),
        ...(c.fadeOut ? { fadeOut: c.fadeOut } : null),
        // 组合卡的部件树:Stage 靠它渲染,漏了组合卡就是一张空卡
        ...(c.parts?.length ? { parts: c.parts } : null),
      });
    }
  }
  // 三维只在真开了的时候才带这个键:老项目的 timeline 对象要和以前完全一样
  return { width: p.width, height: p.height, fps: p.fps, duration: p.duration, clips, ...(p.camera3dFov ? { camera3dFov: p.camera3dFov } : null), ...(p.themeId ? { themeId: p.themeId } : null), ...(graph ? { graph } : null) };
}

/** 某时刻该播哪一段素材(按序列顺序找第一条命中的素材段) */
/** 片段在 t 时刻的不透明度:淡入淡出算进去。超出区间返回 0。 */
export function opacityAt(clip: Clip, t: number): number {
  if (t < clip.start || t >= clip.end) return 0;
  let a = clip.opacity ?? 1;
  const fin = clip.fadeIn ?? 0;
  const fout = clip.fadeOut ?? 0;
  if (fin > 0 && t < clip.start + fin) a *= (t - clip.start) / fin;
  if (fout > 0 && t > clip.end - fout) a *= (clip.end - t) / fout;
  // 剪辑段展开出来的片段(只在声音那份派生项目里有):外层各段的包络乘上去
  const env = (clip as TrackClip).cutEnv;
  if (env) for (const e of env) a *= envelopeAt(e, t);
  return Math.max(0, Math.min(1, a));
}

/** 这个 clip 有没有设过不透明度或淡入淡出。没设过的卡片 Stage 一个字都不碰,老项目的导出逐字节不变 */
export function hasOpacityControls(clip: Clip): boolean {
  return clip.opacity !== undefined || (clip.fadeIn ?? 0) > 0 || (clip.fadeOut ?? 0) > 0;
}

/**
 * 卡片 clip 在 t 时刻的不透明度。和 opacityAt 的区别只有一处:Stage 会把卡片提前 LEAD 秒挂载
 * (让进场动画的第一帧正卡在 start 上),那几帧 t 还在 start 之前 —— 按 opacityAt 算是 0,
 * 会把进场动画的头一帧吞掉。所以把 t 夹进 [start, end) 再算:提前挂载期按 start 那一刻的值,
 * 有淡入就是 0(淡入本来就从 0 起),没淡入就是 opacity 本身。
 */
export function cardOpacityAt(clip: Clip, t: number): number {
  const tt = Math.max(clip.start, Math.min(t, clip.end - 1e-6));
  return opacityAt(clip, tt);
}

/**
 * 某时刻画面上的所有素材层,按序列顺序排(数组靠后 = 画在上面),带算好的不透明度。
 * 两段重叠且各自带淡化时,这里会同时返回它们 —— 交叉溶解就是这么来的。
 * 音频段不在其中(它们走 audioClipsAt)。
 */
export function videoLayersAt(
  p: Project,
  t: number,
): Array<{ trackId: string; clip: TrackClip; media: MediaAsset; opacity: number }> {
  const layers: Array<{ trackId: string; clip: TrackClip; media: MediaAsset; opacity: number }> = [];
  // 和 flattenOverlay 一个口径:倒着走,产出的最后一个就是最上层(= 时间轴最上面那条序列)
  for (const tr of [...p.tracks].reverse()) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (!c.mediaId || t < c.start || t >= c.end) continue;
      const media = p.media.find((m) => m.id === c.mediaId);
      if (!media || media.kind === "audio") continue;
      const opacity = opacityAt(c, t);
      if (opacity <= 0) continue;
      // trackId:预览按序列挂播放器(每条序列两个 <video> 轮换),要靠它把这一段对到它那一对上
      layers.push({ trackId: tr.id, clip: c, media, opacity });
    }
  }
  return layers;
}

/**
 * 每条序列上**严格在 t 之后**开始的第一段画面(视频/图片),口径和 videoLayersAt 一样:
 * 跳过隐藏序列、音频段、卡片段、找不到素材的段,顺序也是「最后一个 = 最上层」。
 * 这条序列后面没有画面了就不出条目。
 *
 * # 为什么要知道「下一段」
 *
 * 预览每切一段视频,原来是新建一个 <video> 再从文件中段 seek。素材每 5 秒一个关键帧,
 * 中段 seek 要先解出最多 150 帧才出画,切一次就黑/卡一两百毫秒;真实项目 88.7 秒里切了 25 次,
 * 而且同一个文件内部的切换在源文件里**没有一次是连续的**,光复用播放器也省不掉那次 seek。
 * 所以预览每条序列备两个播放器,离下一段起点还有一点时间时就把它装进空着的那个、
 * seek 到起点停好(见 render/VideoTrack.tsx)—— 这里就是回答「下一段是谁」。
 *
 * 不看不透明度:下一段开头若是淡入,起点那一刻是 0,但要提前装好的恰恰是它。
 *
 * `skip`:**过滤必须下推进来**(E7 第 1 条)。这个函数每条序列只回一段,事后在外面滤掉
 * (比如素材效果卡接管的素材段)就等于这条序列没有 `next` —— 双 `<video>` 预装整条失效。
 * 给了谓词就接着往后找这条序列上的下一段。
 */
export function nextVideoLayerAfter(
  p: Project,
  t: number,
  skip?: (clip: TrackClip) => boolean,
): Array<{ trackId: string; clip: TrackClip; media: MediaAsset }> {
  const out: Array<{ trackId: string; clip: TrackClip; media: MediaAsset }> = [];
  for (const tr of [...p.tracks].reverse()) {
    if (tr.hidden) continue;
    let best: { clip: TrackClip; media: MediaAsset } | null = null;
    // 不假设 clips 已按 start 排好:读进来的老文件未必排过,找最早的那段就是
    for (const c of tr.clips) {
      if (!c.mediaId || c.start <= t || skip?.(c)) continue;
      if (best && c.start >= best.clip.start) continue;
      const media = p.media.find((m) => m.id === c.mediaId);
      if (!media || media.kind === "audio") continue;
      best = { clip: c, media };
    }
    if (best) out.push({ trackId: tr.id, ...best });
  }
  return out;
}

/** 某时刻该出声的所有音频段(opacity 当音量用) */
export function audioClipsAt(
  p: Project,
  t: number,
): Array<{ clip: TrackClip; media: MediaAsset; volume: number }> {
  const out: Array<{ clip: TrackClip; media: MediaAsset; volume: number }> = [];
  for (const tr of p.tracks) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (!c.mediaId || t < c.start || t >= c.end) continue;
      const media = p.media.find((m) => m.id === c.mediaId);
      // 声音段变速照常出声(随倍率变调,预览里 playbackRate = speed、不保调;kernel/clipTime.mjs)
      if (!media || media.kind !== "audio" || tr.muted || c.audioMuted) continue;
      out.push({ clip: c, media, volume: opacityAt(c, t) * (c.audioVolume ?? 1) });
    }
  }
  return out;
}

/**
 * 某时刻最上面那一层画面。只认视频/图片——以前它把音频段也当画面返回,
 * 拖一首曲子进序列就会让 <video> 去 seek 一个 mp3。
 */
export function videoClipAt(p: Project, t: number): { clip: TrackClip; media: MediaAsset } | null {
  const layers = videoLayersAt(p, t);
  if (layers.length === 0) return null;
  const top = layers[layers.length - 1];
  return { clip: top.clip, media: top.media };
}

export function findClip(p: Project, clipId: string): { track: Track; clip: TrackClip; index: number } | null {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}

let seq = 0;
export function newId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

// ── 主体检测的读取侧 ────────────────────────────────────────────────
// 检测结果是「一串时刻的采样」,而调用方问的永远是「这个镜头(一段区间)里人在哪」。
// 这段负责把前者折成后者,纯函数、无副作用,单测在 src/kernel/subject.test.mjs。

/** 一段区间上的主体情况。由 subjectForRange 把区间内的采样合并出来 */
export interface SubjectRangeInfo {
  /** 参与合并的采样时刻(素材内秒数),按时间排好 */
  times: number[];
  /**
   * true 表示这段区间里**一个采样都没有**,下面的数字来自时间上最近的那一次采样。
   * 调用方要把这件事透出去 —— 拿邻近镜头的人物位置当本镜头的结论会出错。
   */
  approximate: boolean;
  /** 区间内所有采样的框合在一起(同一个人在三个采样里就会出现三次) */
  boxes: SubjectBox[];
  /** 众数:区间内出现次数最多的那一侧 */
  safeSide: SafeSide;
  /** 各侧占用率的平均值 */
  occupancy: SubjectOccupancy;
}

/**
 * safeSide 并列时的取舍顺序。
 *
 * 先左右后上下:横向留白是真的能把卡片挪过去(左右半屏各占一半画面),
 * 而上下只是 1/3 的窄带,同样"空"的情况下放侧边更稳妥。
 * right 排在 left 前面是因为字幕、台标这类常驻元素习惯占左下,右侧更常是空的。
 */
const SAFE_SIDE_PRIORITY: SafeSide[] = ["right", "left", "bottom", "top"];

/**
 * 取一段区间上的主体情况。
 *
 * 优先用落在 [start, end] 内的采样;一个都没有(镜头太短、采样密度不够)就退回
 * 时间上最近的一次,并把 approximate 标成 true。整份 subjects 为空时返回 null。
 */
export function subjectForRange(
  subjects: Subjects | null | undefined,
  start: number,
  end: number,
): SubjectRangeInfo | null {
  // 抽帧失败的样本先扔掉。它们的 boxes 是空的、occupancy 四个 0,混进平均里会
  // 把「这一帧没抽出来」洗成「这一侧是空的」。全都失败时返回 null —— 宁可让调用方
  // 看到「没检测结果」,也不要给一个凭空造出来的 right。
  const all = (subjects?.samples ?? []).filter((s) => !s.failed);
  if (all.length === 0) return null;

  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  let picked = all.filter((s) => s.t >= lo && s.t <= hi);
  const approximate = picked.length === 0;
  if (approximate) {
    // 距离区间最近的那一个。距离相等时取靠前的,保证结果是确定的
    let best = all[0];
    let bestD = Infinity;
    for (const s of all) {
      const d = s.t < lo ? lo - s.t : s.t > hi ? s.t - hi : 0;
      if (d < bestD) { best = s; bestD = d; }
    }
    picked = [best];
  }
  picked = [...picked].sort((a, b) => a.t - b.t);

  const counts = new Map<SafeSide, number>();
  for (const s of picked) counts.set(s.safeSide, (counts.get(s.safeSide) ?? 0) + 1);
  let safeSide: SafeSide = SAFE_SIDE_PRIORITY[0];
  let bestCount = -1;
  for (const side of SAFE_SIDE_PRIORITY) {
    const c = counts.get(side) ?? 0;
    if (c > bestCount) { bestCount = c; safeSide = side; }
  }

  const n = picked.length;
  const occupancy: SubjectOccupancy = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const s of picked) {
    occupancy.left += s.occupancy?.left ?? 0;
    occupancy.right += s.occupancy?.right ?? 0;
    occupancy.top += s.occupancy?.top ?? 0;
    occupancy.bottom += s.occupancy?.bottom ?? 0;
  }
  for (const k of ["left", "right", "top", "bottom"] as const) {
    occupancy[k] = occupancy[k] / n;
  }

  return {
    times: picked.map((s) => s.t),
    approximate,
    boxes: picked.flatMap((s) => s.boxes ?? []),
    safeSide,
    occupancy,
  };
}

/**
 * 把 safeSide 翻成能直接填进卡片 params.position 的值。
 *
 * 卡片那一侧只有 center / bottom / left / right 四档(见 src/cards/native/hud.ts 的
 * getPositionClass),**没有 top**。所以 safeSide 是 top 时不能原样传 —— 传过去
 * getPositionClass 会掉进 default 分支变成 center,而 center 正是人脸最常在的地方,
 * 等于把"上面是空的"这条信息用成了"糊人脸上"。这里改成在剩下三个合法档里挑
 * 占用率最低的那个,宁可放侧边也不要放中间。
 */
export function positionForSafeSide(
  safeSide: SafeSide,
  occupancy?: SubjectOccupancy | null,
): CardPosition {
  if (safeSide !== "top") return safeSide;
  const occ = occupancy ?? { left: 1, right: 1, top: 1, bottom: 1 };
  const legal: CardPosition[] = ["right", "left", "bottom"];
  let best: CardPosition = "right";
  let bestV = Infinity;
  for (const side of legal) {
    const v = occ[side] ?? 1;
    if (v < bestV) { bestV = v; best = side; }
  }
  return best;
}

/**
 * positionForSafeSide 的值域。
 *
 * **不含 center**:safeSide 只可能是 right/left/bottom/top(见 safezone.py 的
 * SIDE_PRIORITY),前三个原样返回,top 又只在这三个里挑 —— center 不可达。
 * 文档里以前写成 "center/bottom/left/right",会让模型以为居中是个合法建议,
 * 而居中正是人脸所在。
 */
export type CardPosition = "left" | "right" | "bottom";

/** 某一侧被人物盖住多少就算「占住了」。半屏一半以上是人,卡片放上去必然压到 */
export const OCCUPIED_THRESHOLD = 0.5;

export interface PositionSuggestion {
  /** 能填进卡片 params.position 的值;四档全被占住时为 null(此时别硬填) */
  suggestedPosition: CardPosition | null;
  /** 被选中那一侧的占用率(0~1)。suggestedPosition 为 null 时是那个最不坏档位的占用率 */
  suggestedOccupancy: number;
  /** 只在 suggestedPosition 为 null 时有 */
  warning?: string;
}

/**
 * 把 safeSide + occupancy 折成「卡片放哪」的建议,并说清这条建议靠不靠谱。
 *
 * 为什么要单独有这一层:positionForSafeSide 是在**剩下三个合法档里挑最不坏的**,
 * 正面说话人半身镜头(safeSide=top)最常见的情况是四侧都被占住,它照样会返回一个
 * 侧边,而那一侧实测占用率 0.895 —— 卡片就压在脸上。实测 out/media/talker.mp4
 * t=2.75:occupancy {left:0.895, right:0.895, top:0.692, bottom:0.993},
 * safeSide="top",挑出来的 right 有 89.5% 是人。这种时候必须说「这个镜头没有
 * 不遮人的位置」,而不是给一个看起来言之凿凿的 right。
 */
export function suggestPosition(
  safeSide: SafeSide,
  occupancy?: SubjectOccupancy | null,
): PositionSuggestion {
  const pos = positionForSafeSide(safeSide, occupancy);
  const occ = occupancy?.[pos] ?? 0;
  if (occ > OCCUPIED_THRESHOLD) {
    return {
      suggestedPosition: null,
      suggestedOccupancy: Math.round(occ * 100) / 100,
      warning: `四个档位都被人物占住(最空的 ${pos} 也有 ${Math.round(occ * 100)}% 是人),`
        + "这个镜头没有不遮人的位置,考虑缩小卡片、降低不透明度,或者换一个镜头放。",
    };
  }
  return { suggestedPosition: pos, suggestedOccupancy: Math.round(occ * 100) / 100 };
}

/**
 * 一次检测最多抽多少帧。
 *
 * **两处共用**:服务端 /api/subject/detect 拿它当硬上限(超了 400),这边算采样时刻时
 * 也拿它夹住。以前是服务端一个 200、kernel 这边没有上限,于是「不传 times 就自动算」
 * 这条默认路径在稍长或稍碎的素材上必然被 400 拒掉 —— 常数只写一份就不会再对不上。
 * 每帧一次 ffmpeg seek 加一次前向,full 档实测 2.7 s/帧,200 帧已经是 9 分钟。
 */
export const MAX_SUBJECT_TIMES = 200;

/**
 * 给一段素材算主体检测的采样时刻(素材内秒数)。
 *
 * 有镜头划分就每个镜头取 20% / 50% / 80% 三点 —— 一个镜头里人物通常会走动,
 * 只取中点会把「开头在左、结尾在右」压成一个瞬间的结论,而卡片是要覆盖整个镜头的。
 * 镜头短于 1 秒只取中点:那点时长里三次抽帧抽到的几乎是同一帧,白花三次前向。
 * 没做过镜头识别就退回每 2 秒一点。
 *
 * 结果去重、排序、并夹在素材时长之内 —— ffmpeg seek 到超出时长的位置抽不到帧,
 * 那条采样白丢,还看不出是为什么。
 *
 * 总数硬夹在 max(默认 MAX_SUBJECT_TIMES=200,和服务端同一个常数)以内,分两步降:
 * 先把每镜头三点降成只取中点(镜头一个不少,只是位置估得糙),仍超再等距抽稀。
 * 调用方想知道降没降精度,拿 subjectSampleTimes(media, Number.MAX_SAFE_INTEGER)
 * 的长度和这里的长度一比就有了。
 */
export function subjectSampleTimes(
  media: Pick<MediaAsset, "duration" | "shots">,
  max: number = MAX_SUBJECT_TIMES,
): number[] {
  const dur = media.duration ?? 0;
  const shots = media.shots?.shots ?? [];
  const limit = Math.max(1, Math.floor(max));

  /** 夹进时长、保留两位、去重、排序 */
  const tidy = (raw: number[]): number[] => {
    const seen = new Set<string>();
    return raw
      .map((t) => Math.max(0, dur > 0 ? Math.min(t, Math.max(0, dur - 0.05)) : t))
      .map((t) => Math.round(t * 100) / 100)
      .filter((t) => (seen.has(t.toFixed(2)) ? false : (seen.add(t.toFixed(2)), true)))
      .sort((a, b) => a - b);
  };

  let out: number[];
  if (shots.length > 0) {
    const three: number[] = [];
    const mid: number[] = [];
    for (const s of shots) {
      const len = s.end - s.start;
      if (len <= 0) continue;
      mid.push(s.start + len / 2);
      if (len < 1) three.push(s.start + len / 2);
      else three.push(s.start + len * 0.2, s.start + len * 0.5, s.start + len * 0.8);
    }
    out = tidy(three);
    // 超限的第一步是**降精度而不是丢镜头**,但也别一步降到底:只超一点点就整体塌成
    // 每镜头一个中点,会把 240 点砍到 80 点,20%/80% 那两点存在的理由(人物在镜头内走动)
    // 全丢了(复查实测)。先按镜头分组抽稀 —— 每个镜头保底留中点,剩余名额在各镜头的
    // 20%/80% 点里等距分;只有中点本身都超限时才退到「每镜头一个中点」,再交给下面的等距抽稀。
    if (out.length > limit) {
      if (mid.length > limit) {
        out = tidy(mid);
      } else {
        const extras: number[] = [];
        for (const s of shots) {
          const len = s.end - s.start;
          if (len >= 1) extras.push(s.start + len * 0.2, s.start + len * 0.8);
        }
        const room = Math.max(0, limit - mid.length);
        const picked: number[] = [];
        if (room > 0 && extras.length > 0) {
          const stride = extras.length / Math.min(room, extras.length);
          for (let i = 0; i < Math.min(room, extras.length); i++) picked.push(extras[Math.floor(i * stride)]);
        }
        out = tidy([...mid, ...picked]);
      }
    }
  } else {
    const grid: number[] = [];
    for (let t = 1; t < dur; t += 2) grid.push(t);
    // 素材短于 1 秒(或压根没有时长信息)时上面一个点都排不出来,至少给一个中点,
    // 否则调用方拿到空数组只能报「算不出采样时刻」,而这段素材其实是能检测的。
    if (grid.length === 0) grid.push(dur > 0 ? dur / 2 : 0);
    out = tidy(grid);
  }

  // 还超就等距抽稀。**必须夹在这里**,不能指望调用方分批:setMediaSubjects 是整体
  // 替换,第二批会把第一批冲掉,所谓「请分批」在客户端根本做不成。
  // 实测三个会超限的真实场景(校验员的 verify-agent-ux-sampletimes.mjs):
  // 7 分钟无镜头 210 点、5 分钟 80 镜头 240 点、3 分钟 90 个 2 秒镜头 270 点。
  if (out.length > limit) {
    const n = out.length;
    const seen = new Set<number>();
    const thinned: number[] = [];
    for (let i = 0; i < limit; i++) {
      const idx = limit === 1 ? Math.floor((n - 1) / 2) : Math.round((i * (n - 1)) / (limit - 1));
      if (seen.has(idx)) continue;
      seen.add(idx);
      thinned.push(out[idx]);
    }
    out = thinned;
  }
  return out;
}
