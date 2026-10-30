// mcp-tools.mjs 是纯数据、没有 node 依赖，前端可以直接引；它没有 .d.ts，
// 所以在这里就地声明用到的那点形状。
// @ts-expect-error 无类型声明的 .mjs
import { tools as RAW_TOOL_SPECS } from "../../server/mcp-tools.mjs";
import { modelToolName, pageToolName } from "../../server/tools/ui-names.mjs";
import { webOpen, webView, webClick, webType, webScroll, webRead, webHandoff, webClose } from "./web";
import { requestAgentBrowser, closeAgentBrowser } from "./agentBrowserStore";
import * as agentBus from "./agentBus";
import { applyDesktopSessions } from "./desktopSessions";
import { TOOL_ROUTES } from "../mcp/routes.mjs";
import { getState } from "../store/project";
import { prerenderUrl } from "../render/prerender";
import { flushDataMirror, startDataMirror } from "../render/dataMirror";
import { beginAgentTool, endAgentTool } from "../editor/userEditing";
import { issueAgentTicket, pageOpIdsSince, pageOpMark } from "../editor/sync/syncManager";
import { trackJobs, trackResults } from "../mcp/common";

/**
 * Agent 服务端向页面要只读页面状态用的内部工具名(server/agent/agent-side.mjs 的 PAGE_STATE_TOOL)。
 * 不在工具表里、Agent 看不到,所以不写成字面的分发分支(tool-schema.test.mjs 的对账只认声明过的工具)。
 */
const PAGE_STATE_TOOL = "__page_state";
const TOOL_SPECS = RAW_TOOL_SPECS as { name: string; inputSchema?: { required?: string[] } }[];

/**
 * 按工具自己的 inputSchema 校验必填参数。
 *
 * 为什么要在这一层拦：inputSchema 里写了 required，但**没有任何一层真的执行它**。
 * MCP 协议指望客户端自觉，而 CLI 驱动（claude / codex / agy）并不保证会校验。
 * 于是漏传参数会一路走到实现里：`seek({})` 把 t 设成 null、`set_theme({})` 把
 * themeId 设成 undefined，还都回 `{ok:true}` —— Agent 以为成功了，项目却已经坏了。
 * 沉默地改坏状态，比报错难查得多。
 *
 * API 直连那条路在 harness/agent.mjs 里已经有同样的校验；这里补的是走 MCP 的那条。
 * 只查「必填的在不在」，不做类型推断——过度校验会把合法调用也挡掉。
 */
function missingRequired(tool: string, args: unknown): string[] {
  const spec = TOOL_SPECS.find((t) => t.name === tool);
  const required = spec?.inputSchema?.required ?? [];
  if (required.length === 0) return [];
  const bag = (args ?? {}) as Record<string, unknown>;
  return required.filter((k) => bag[k] === undefined || bag[k] === null);
}

export interface EditorApi {
  soundPresets(): any;
  soundGenerate(args: import("../editor/io/soundGeneration").GenerateSoundOptions): Promise<any>;
  soundStatus(args?: { jobId?: string }): any;
  soundCancel(args: { jobId: string }): any;
  backgroundJobStatus(args: { jobId: string }): any;
  listCards(args?: { cardId?: string; detail?: string }): any;
  getProject(): any;
  listMedia(): any;
  getSelection(): any;
  addClip(args: { cardId: string; start: number; duration?: number; trackId?: string; params?: any }): any;
  updateClip(args: { clipId: string; start?: number; end?: number; cardId?: string; params?: any; opacity?: number; fadeIn?: number; fadeOut?: number; label?: string; trackId?: string }): any;
  /** 卡片级定位(场景图的根节点)。部件级接进来时加 node 参数,签名不用改 */
  setPosition(args: { clipId: string; space?: "world" | "local"; x?: number; y?: number; w?: number; h?: number; anchor?: [number, number]; scale?: number; rotate?: number; rotateX?: number; rotateY?: number; translateZ?: number; clear?: boolean; clamp?: boolean }): any;
  setRect(args: { clipId: string; x1: number; y1: number; x2: number; y2: number; mode?: "fit" | "canvas"; align?: [number, number] }): any;
  align(args: { clipId: string; h?: "left" | "center" | "right"; v?: "top" | "center" | "bottom"; margin?: number }): any;
  nudge(args: { clipId: string; dx?: number; dy?: number; scaleBy?: number; rotateBy?: number; clamp?: boolean }): any;
  /** 异步:contentBox 要问舞台一次往返(D4 页面侧)。写工具仍是同步的 */
  getLayout(args?: { clipId?: string }): Promise<any>;
  getClip(args: { clipId: string }): any;
  listParts(args?: { partId?: string; detail?: string }): any;
  addComposite(args: { start: number; duration?: number; trackId?: string; parts?: unknown[] }): any;
  addPart(args: { clipId: string; partId: string; params?: Record<string, unknown>; frame?: unknown; enterMs?: number; label?: string; parentId?: string; index?: number }): any;
  setPart(args: { clipId: string; partInstanceId: string; params?: Record<string, unknown>; frame?: unknown; enterMs?: number; label?: string }): any;
  removePart(args: { clipId: string; partInstanceId: string }): any;
  movePart(args: { clipId: string; partInstanceId: string; parentId?: string | null; index?: number }): any;
  setClip(args: { clipId: string; envelope: unknown }): any;
  removeClip(args: { clipId: string }): any;
  duplicateClip(args: { clipId: string }): any;
  splitClip(args: { clipId: string; t: number }): any;
  setClipVolume(args: { clipId: string; volume: number }): any;
  setClipMuted(args: { clipId: string; muted: boolean }): any;
  renderCardAudio(args: { clipId: string; force?: boolean }): Promise<any>;
  cancelCardAudio(args: { clipId: string }): any;
  separateAudio(args: { clipId?: string; clipIds?: string[] }): any;
  createAudio(args: { mediaId?: string; clipId?: string }): any;
  setEmphasis(args: { clipId: string; kind: string; color?: string; size?: number; opacity?: number; dx?: number; dy?: number }): any;
  listTransitions(): any;
  addTransition(args: { kind: string; clipId: string; otherClipId?: string; dur?: number }): any;
  removeTransition(args: { transitionId: string }): any;
  // 序列(轨道)。校验和门槛在 mcp/tools/trackTools.ts
  addTrack(args: { name?: string; index?: number }): any;
  listTracks(): any;
  removeTrack(args: { trackId?: string; trackIds?: string[]; force?: boolean; reason?: string }): any;
  updateTrack(args: { trackId: string; name?: string; hidden?: boolean; muted?: boolean; locked?: boolean }): any;
  moveTrack(args: { trackId: string; index: number }): any;
  // 滤镜库。校验和门槛在 editor/right/filterTools.ts,数值和三条管线的翻译在 kernel/filters.mjs
  listFilters(): any;
  createFilter(args: any): any;
  updateFilter(args: any): any;
  removeFilter(args: { filterId: string; force?: boolean; reason?: string }): any;
  applyFilter(args: { clipId: string; filterId: string; params?: Record<string, number> }): any;
  listPixelMaps(): any;
  createPixelMap(args: any): any;
  updatePixelMap(args: any): any;
  removePixelMap(args: { pixelMapId: string; force?: boolean; reason?: string }): any;
  applyPixelMap(args: { clipId: string; pixelMapId?: string }): any;
  listMediaEffects(args?: { mediaId?: string }): any;
  // 音频效果库。校验和门槛在 editor/right/audioFxTools.ts,数值在 kernel/audioFx.mjs,节点图在 src/audio/fxChain.ts
  listAudioFx(): any;
  createAudioFx(args: any): any;
  updateAudioFx(args: any): any;
  removeAudioFx(args: { fxId: string; force?: boolean; reason?: string }): any;
  applyAudioFx(args: { clipId: string; fxId: string; params?: Record<string, number> }): any;
  /** 测响度:服务端 ffmpeg ebur128(server/vite-plugin-audio.ts) */
  measureAudio(args: { clipId?: string; mediaId?: string; scope?: string; series?: boolean }): Promise<any>;
  /** 自定义测量(计划 A6):PCM 交专用 Chrome 的沙箱跑 Agent 写的 JS(server/audio-measure-js.mjs) */
  measureAudioJs(args: { code: string; clipId?: string; mediaId?: string; scope?: string; start?: number; duration?: number; sampleRate?: number; mono?: boolean; timeoutMs?: number }): Promise<any>;
  // 多条剪辑(时间轴)。其余 clip / 序列工具都只作用于当前激活的那条
  listCuts(args?: { cutId?: string }): any;
  switchCut(args: { cutId?: string; name?: string }): any;
  addCut(args?: { name?: string }): any;
  renameCut(args: { cutId: string; name: string }): any;
  removeCut(args: { cutId: string; force?: boolean; reason?: string }): any;
  /** 在激活剪辑里放一个引用别的剪辑的剪辑段(cutId 或 name 二选一);放进自己、循环引用时抛并说明原因 */
  addCutSegment(args: { cutId?: string; name?: string; start: number; duration?: number; cutOffset?: number; trackId?: string }): any;
  /** 改剪辑段引用哪条剪辑(cutId 或 name)、从被引用剪辑的第几秒开始(cutOffset) */
  setCutSegment(args: { clipId: string; cutOffset?: number }): any;
  seek(args: { t: number }): any;
  play(): any;
  pause(): any;
  setTheme(args: { themeId: string }): any;
  setProjectMeta(args: any): any;
  setCamera3d(args: { enabled?: boolean; fovDeg?: number }): any;
  bakeCard(args: { clipId: string; t?: number; size?: number; bg?: string }): Promise<any>;
  // STT 工具
  sttStatus(): Promise<any>;
  sttInstall(args: { engine: string }): Promise<any>;
  transcribeMedia(args: { mediaId: string; engine?: string; model?: string; language?: string }): Promise<any>;
  getTranscript(args: { mediaId: string }): any;
  detectShots(args: { mediaId: string; force?: boolean }): Promise<any>;
  listShots(args: { mediaId: string }): any;
  trackPoints(args: { mediaId: string; points: number[][] }): Promise<any>;
  getTrack(args: { mediaId: string; full?: boolean }): any;
  trackStatus(): Promise<any>;
  trackInstall(): Promise<any>;
  // 主体检测：画面里的人在哪、哪一侧是空的
  detectSubjects(args: { mediaId: string; times?: number[]; prompt?: string; force?: boolean }): Promise<any>;
  listSubjects(args: { mediaId: string }): any;
  subjectStatus(): Promise<any>;
  subjectInstall(): Promise<any>;
  attachClipMotion(args: {
    clipId: string; mediaId: string; pointIndex?: number; whenHidden?: string;
  }): any;
  detachClipMotion(args: { clipId: string }): any;
  autoWorkflow(args: { mediaId: string; style?: string; maxCards?: number }): Promise<any>;
  autoWorkflowStatus(args: { jobId: string }): any;
  fillCaptions(args: { clipId?: string; mediaId?: string; showEn?: boolean }): any;
  listCaptions(args: { clipId?: string }): any;
  editCaption(args: { clipId?: string; op?: string; index?: number; text?: string; en?: string; start?: number; end?: number }): any;
  importMedia(args: { url?: string; name?: string }): Promise<any>;
  // 配音:云端 TTS 生成 mp3 进素材库,给 start 就上时间轴
  voiceList(): Promise<any>;
  voiceGenerate(args: { text: string; start?: number; trackId?: string; provider?: string; voiceId?: string; speed?: number; emotion?: string; name?: string }): Promise<any>;
  collectStatus(): Promise<any>;
  collectSearch(args: { query: string; site?: string; limit?: number }): Promise<any>;
  collectInstall(): Promise<any>;
  collectProbe(args: { url: string; site?: string; quality?: number }): Promise<any>;
  collectDownload(args: { url: string; quality?: number; site?: string; audioOnly?: boolean; allParts?: boolean; cookies?: string }): Promise<any>;
  collectJob(args: { jobId: string }): Promise<any>;
  collectLogin(args: { site?: string; method?: "qr" | "browser"; force?: boolean }): Promise<any>;
  collectLoginCheck(args: { site?: string; hide?: boolean }): Promise<any>;
  collectLogout(args: { site?: string }): Promise<any>;
  createCard(args: { id: string; source: string; overwrite?: boolean }): Promise<any>;
  applyCard(args: any): any;
  getCardSource(args: { cardId: string; file?: string }): Promise<any>;
  editCard(args: { cardId: string; file?: string; find: string; replace: string; replaceAll?: boolean }): Promise<any>;
  /** 只读 DOM 树(inspect_card_dom):每个节点标出源码位置,改动一律走 editCard */
  inspectCardDom(args: { clipId: string; t?: number; ref?: number | string; depth?: number }): Promise<any>;
  seePreview(args: { t?: number; clipId?: string; times?: number[]; cutId?: string }): Promise<any>;
  seeSequences(args: { mediaId: string; page?: number; perPage?: number; grid?: number; scene?: number; from?: number; to?: number }): Promise<any>;
  cardAuthoringGuide(): Promise<any>;
}

/** 这些工具改的是时间轴:做成一次,就值得给 SKILL 悬浮窗下面那张预览图刷新一次 */
const TIMELINE_TOOLS = new Set([
  "add_clip", "update_clip", "remove_clip", "duplicate_clip", "split_clip",
  "add_transition", "remove_transition", "set_clip_volume", "set_clip_muted", "render_card_audio", "separate_audio", "create_audio", "set_emphasis",
  "set_position", "set_rect", "align", "nudge", "fill_captions", "edit_caption", "attach_clip_motion", "detach_clip_motion",
  "add_track", "remove_track", "update_track", "move_track",
  "create_filter", "update_filter", "remove_filter", "apply_filter",
  "create_pixel_map", "update_pixel_map", "remove_pixel_map", "apply_pixel_map",
  "create_audio_fx", "update_audio_fx", "remove_audio_fx", "apply_audio_fx",
  "user_interface_switch_cut", "add_cut", "set_theme", "voice_generate", "sound_generate",
]);

/**
 * 聊天栏的「看得见的结果」。
 *
 * 用户在简洁界面点开一个工具,原来看到的是入参和结果的 JSON —— 那是给调试看的。
 * 看图的工具该看到当时返回的那张图,加卡 / 删卡该看到那张卡,改卡该看到改了哪几个参数
 * 和前后两段动图。这些东西只有执行工具的这个页面拿得到(改之前的工程、返回的位图),
 * 所以在这里交给服务端存一份「可视化记录」,把它的 id 放在结果最前面:四家的工具结果
 * 摘要都保留开头那一截,聊天栏凭这个 id 去取记录。
 *
 * 动图不在这里渲:这里只存「怎么渲」(那张卡当时的样子),用户点开时服务端才渲。
 * 所以 Agent 调工具只多一次本地写文件;交记录最多等 3 秒,超时就不带,工具结果照常返回。
 */
const CLIP_EDIT_TOOLS = new Set([
  "update_clip", "set_clip", "set_position", "set_rect", "align", "nudge", "set_emphasis",
  "add_part", "set_part", "remove_part", "move_part",
]);
const CLIP_CREATE_TOOLS = new Set(["add_clip", "duplicate_clip", "add_composite"]);

function cloneProject<T>(p: T): T {
  try { return structuredClone(p); } catch { return JSON.parse(JSON.stringify(p)); }
}

function visualRequest(tool: string, args: any, result: any, before: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object" || result.ok === false) return null;
  if (tool === "see_frames") {
    const images: { mime?: string; base64: string; label: string }[] = [];
    if (result.__image?.base64) images.push({ mime: result.__image.mime, base64: result.__image.base64, label: typeof result.t === "number" ? `t=${result.t}s` : "" });
    for (const im of Array.isArray(result.__images) ? result.__images : []) {
      if (im?.base64) images.push({ mime: im.mime, base64: im.base64, label: im.label ?? (im.sceneIndex != null ? `镜头 ${im.sceneIndex}` : "") });
    }
    return images.length ? { tool, images } : null;
  }
  if (CLIP_CREATE_TOOLS.has(tool)) {
    const id = result.id || result.clipId;
    return id ? { tool, clipId: id, after: getState().project } : null;
  }
  if (tool === "remove_clip") return before && args?.clipId ? { tool, clipId: args.clipId, before } : null;
  if (CLIP_EDIT_TOOLS.has(tool)) return before && args?.clipId ? { tool, clipId: args.clipId, before, after: getState().project } : null;
  return null;
}

async function withVisual(tool: string, args: any, result: unknown, before: unknown): Promise<unknown> {
  try {
    const body = visualRequest(tool, args, result, before);
    if (!body) return result;
    const res = await fetch(await prerenderUrl("/api/ai/visual"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
    });
    const data = await res.json().catch(() => null);
    if (!data?.ok || !data.visualId) return result;
    return { visualId: data.visualId, ...(result as object) };
  } catch {
    return result; // 可视化是附带的,交不上就算了
  }
}

/** get_gif:把一张卡整段均匀抽 8 帧,用户看动图、模型看 4×2 拼图 */
async function getGif(args: { clipId: string }) {
  // 兜底路径(有数据镜像时服务端直接做,见 vite-plugin-ai 的服务端工具)。发到预渲染的源上,180 秒就放手
  // 两步(cloud-task.md 决议 12):先只写规格,再由 `/render` 渲像素(`user` 角色)
  const post = async (path: string, body: unknown) => {
    const res = await fetch(await prerenderUrl(path), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `做动图失败(HTTP ${res.status})`);
    return data;
  };
  const spec = await post("/api/ai/visual", { tool: "get_gif", clipId: args.clipId, after: getState().project });
  if (!spec.gifKey) throw new Error(`时间轴上没有 id 为 ${args.clipId} 的片段。`);
  const data = await post("/api/ai/visual/render", { key: spec.gifKey });
  return {
    visualId: spec.visualId, ok: true, clipId: args.clipId, times: data.times, gif: data.gifUrl,
    note: `拼图 4×2,第 k 格对应 times 的第 k 个时刻(按行从左到右)。用户在聊天栏点开这一步能看到动图。`,
    ...(data.grid ? { __image: { mime: "image/png", base64: data.grid } } : {}),
  };
}

/** 同一时刻只渲染一张:agent 连着改十张卡,预览跟着渲染十次没意义,只留最后那次 */
let lastActionBusy = false;
let lastActionPending: (() => Promise<void>) | null = null;

/**
 * SKILL 模式的悬浮窗下面显示「桌面 APP 会话上一步做成的动作」的画面。
 *
 * 编辑器进程在桌面会话做成一次操作、SKILL 模式开着时经 SSE 发 `skill.preview`(server/vite-plugin-ai.ts 的
 * requestSkillPreview);这里只对时间轴操作照做:按 see_frames 那条路把那一刻的整屏渲染成 png,POST 给服务端写到
 * skillRoot/last-action.{png,json},壳的 watcher 盯着那两个文件,变了就推给悬浮窗。全程失败静默 —— 预览是锦上添花,
 * 不能反过来影响工具调用。(原来由无头实例的页面做,A4 归档无头实例之后由用户这份页面做。)
 */
function reportLastAction(api: EditorApi, tool: string, clipId: string | null, start: number | null): void {
  if (!TIMELINE_TOOLS.has(tool)) return;
  const run = async () => {
    // 时间点:优先这次动作涉及的那张卡的中点,都没有就让服务端用当前播放头
    let t: number | undefined;
    const clip = clipId ? getState().project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === clipId) : undefined;
    if (clip && typeof clip.start === "number" && typeof clip.end === "number") t = (clip.start + clip.end) / 2;
    else if (typeof start === "number") t = start + 0.5;
    const shot = await api.seePreview(t == null ? {} : { t });
    const base64 = shot?.__image?.base64;
    if (!base64) return;
    await fetch("/api/skill-mode/last-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, clipId: clipId ?? null, t: shot?.t ?? t ?? null, base64 }),
    });
  };
  const kick = () => {
    if (lastActionBusy) { lastActionPending = run; return; }
    lastActionBusy = true;
    run().catch(() => {}).finally(() => {
      lastActionBusy = false;
      const next = lastActionPending;
      lastActionPending = null;
      if (next) { lastActionBusy = true; next().catch(() => {}).finally(() => { lastActionBusy = false; }); }
    });
  };
  kick();
}

/** web_* 的分发。返回体里的 __image 原样往上传,让 harness 把它摘成图片块 */
async function runWebTool(tool: string, args: any): Promise<any> {
  switch (tool) {
    case "web_open": return webOpen(args);
    case "web_view": return webView();
    case "web_click": return webClick(args);
    case "web_type": return webType(args);
    case "web_scroll": return webScroll(args);
    case "web_read": return webRead(args);
    case "web_handoff": {
      const r = await webHandoff(args);
      // 桌面壳模式:agent 的浏览器是主窗口里的子 webview,Node 那边挪不动它,
      // 只回一个 shell 标记。这边**不弹窗打断用户**:点亮顶栏的「浏览器」页签(闪烁 +
      // 「有待操作」气泡),用户自己点过去时面板才把 webview 摆出来。
      if (r && (r as { shell?: boolean }).shell) {
        if (args?.hide) closeAgentBrowser();
        else requestAgentBrowser(typeof args?.reason === "string" ? args.reason : "");
      }
      return r;
    }
    case "web_close": return webClose();
    default: throw new Error(`未知的网页工具: ${tool}`);
  }
}

export function connectMcpExecutor(getApi: () => EditorApi, onStatus?: (s: { connected: boolean }) => void): () => void {
  let source: EventSource | null = null;
  let active = true;

  /*
   * `?observe=1`:只读观看。页面照常渲染项目,但**不连桥**(不会把编辑台从工具通道上挤掉)。
   * 不带 = 编辑台(先来后到、刷新可接管)。
   */
  const params = (() => {
    try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); }
  })();
  const observeOnly = params.has("observe");

  if (observeOnly) {
    // 明确告诉界面「没连桥」,免得状态点显示成绿的、让人以为工具能用
    onStatus?.({ connected: false });
    return () => {};
  }

  /*
   * 这个页面是「编辑台」,由它把项目镜像给服务端(数据管理的只读镜像,见 src/render/dataMirror.ts)。
   * 只读观看页(observe)上面已经 return 了,不会走到这里 —— 两个页面同时推会互相覆盖。
   *
   * **不再等桥连上**(A7):帧请求的 body 里只有 `{session, localRev}`,项目由服务端从镜像取 ——
   * 没有 Agent 连着的时候,编辑页自己的预览也得能画。判据从「连着 MCP 桥」换成「页面角色是编辑页」。
   */
  startDataMirror();
  // 多 Agent:页签变了就报给编辑器进程的公告板(A3)
  const stopTabReports = agentBus.startTabReports();

  const connect = () => {
    if (!active) return;
    source = new EventSource("/api/mcp/events");

    source.onopen = () => {
      onStatus?.({ connected: true });
      // 编辑器进程可能刚重启:页签再报一次,公告板的名单才齐(A3)
      agentBus.resendTabs();
    };

    source.onmessage = async (e) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }

      if (ev.type === "hello") {
        // hello
      } else if (ev.type === "replaced") {
        if (source) source.close();
        source = null;
        onStatus?.({ connected: false });
        window.dispatchEvent(new CustomEvent("ai-chat-error", { detail: "另一个编辑台页面接管了 AI 连接" }));
        active = false;
      } else if (ev.type === "agent.board") {
        // 多 Agent 公告板(编辑器进程里的那份)变了:页签名跟着范围改、标未读(A3)
        agentBus.applyBoard(ev.agents);
      } else if (ev.type === "agent.desktop") {
        // 桌面 APP 会话的分组(A4):厂商、正在进行的操作、进度报告,整份替换
        applyDesktopSessions(ev.sessions);
      } else if (ev.type === "skill.preview") {
        // 桌面会话做成了一次操作、SKILL 模式开着:给悬浮窗刷一张预览(失败静默)
        try { reportLastAction(getApi(), String(ev.tool), typeof ev.clipId === "string" ? ev.clipId : null, typeof ev.start === "number" ? ev.start : null); } catch { /* 预览是附带的 */ }
      } else if (ev.type === "agent.spawn") {
        // spawn_agent 拉起子 Agent:开一个带角色名的新页签(A3)
        void agentBus.handleSpawn(ev);
      } else if (ev.type === "agent.ticket") {
        // Agent 服务端要一张 agent 角色的连接票据(共享项目;server/vite-plugin-ai.ts 的 requestTicket)
        void issueAgentTicket(ev);
      } else if (ev.type === "call" && ev.tool === PAGE_STATE_TOOL) {
        /*
         * Agent 服务端向页面要一次只读的页面状态(c65-integ2 裁定:既读页面状态又写项目的工具改在服务端执行,
         * 见 server/agent/agent-exec.mjs 的 PAGE_STATE_TOOLS):播放头、页面内存里 track_points 跑出来的轨迹。
         * 只读,不改任何状态,不经 EditorApi。
         */
        const q = (ev.args ?? {}) as { keys?: string[]; args?: { mediaId?: unknown } };
        const keys = Array.isArray(q.keys) ? q.keys : [];
        const result: Record<string, unknown> = {};
        if (keys.includes("t")) result.t = getState().t;
        if (keys.includes("track")) {
          const mediaId = typeof q.args?.mediaId === "string" ? q.args.mediaId : null;
          result.track = mediaId ? { mediaId, result: trackResults.get(mediaId) ?? null, running: trackJobs.has(mediaId) } : null;
        }
        fetch("/api/mcp/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: ev.id, ok: true, result }),
        }).catch(() => {});
      } else if (ev.type === "call") {
        const id = ev.id;
        /*
         * 会动用户界面的工具改了名(`user_interface_` 前缀,server/tools/ui-names.mjs):服务端发来的内部操作名保持旧名
         * (0.7.18 桌面版当发起人页面时照常认),这里两种都认,进门统一换成新名再查路由表
         */
        const tool = modelToolName(ev.tool);
        const args = ev.args as any;
        // 多 Agent:服务端把发起这次调用的 Agent 对话 ID 带过来(走 agy 或外部命令行的没有)
        const agent: string | null = typeof ev.agent === "string" && ev.agent ? ev.agent : null;
        // 时间轴操作前后各看一眼项目,算出这次改了哪几条「剪辑->序列」,随回包带给服务端的公告板(没接文档服务时用)
        const before = TIMELINE_TOOLS.has(tool) ? getState().project : null;
        // 聊天栏要画「改之前」的那张卡:只有改卡 / 删卡的工具才拍这一份
        const visualBefore = CLIP_EDIT_TOOLS.has(tool) || tool === "remove_clip" ? cloneProject(getState().project) : null;
        const api = getApi();
        // 一对一转发的工具在路由表里;表外的(公告板、see_frames、get_gif、web_*)各自有分支。
        // 用 Object.hasOwn 查:直接下标的话,tool 叫 "toString" / "constructor" 会摸到
        // Object.prototype 上的东西,本该回「未知工具」的却变成了别的报错。
        const route = Object.hasOwn(TOOL_ROUTES, tool) ? TOOL_ROUTES[tool] : undefined;
        let ok = true;
        let result: unknown;
        let error: string | undefined;
        // 这次调用期间本页面发出的提交(留在页面的写工具):回包里带 opIds,Agent 服务端据此推进这个对话读到的版本
        const opMark = pageOpMark();
        // 这次调用期间本页面的修改是 Agent 让做的,不算「用户动过」(src/editor/userEditing.ts,A2)
        beginAgentTool();

        try {
          const missing = missingRequired(tool, args);
          if (missing.length > 0) {
            throw new Error(`缺少必填参数：${missing.join("、")}。请补齐后重试。`);
          }
          // 一对一转发 EditorApi 的那一百来个工具走路由表(src/mcp/routes.mjs)。
          // await 与否照抄原分发链:表里说 awaited 才 await,不做统一。
          // (多 Agent 的公告板工具在编辑器进程里答,不再到页面来,计划 agent-workflow-plan.md A3)
          if (route) {
            result = route.passArgs ? api[route.method](args) : api[route.method]();
            if (route.awaited) result = await result;
          }
          else if (tool === "see_frames") {
            // 一个工具两种画面:成片(timeline)走 seePreview,素材镜头拼图(media)走 seeSequences
            const { source, ...rest } = (args ?? {}) as any;
            if (source === "media") {
              result = rest.mediaId
                ? await api.seeSequences(rest)
                : { ok: false, error: 'source 为 "media" 时要给 mediaId(list_media 里的素材 id)' };
            } else if (source === "timeline" || source === undefined) {
              result = await api.seePreview(rest);
            } else {
              result = { ok: false, error: `source 只能是 "timeline"(成片画面)或 "media"(素材镜头拼图),收到的是 ${JSON.stringify(source)}` };
            }
          }
          else if (tool === "get_gif") result = await getGif(args);
          // 网页操作不经过 EditorApi:浏览器整个在服务端,这些工具不碰编辑台的任何状态。
          // 挂进 EditorApi 只会逼编辑台那边实现 8 个纯转发的方法。
          else if (tool.startsWith("web_") || tool === "user_interface_web_handoff") result = await runWebTool(pageToolName(tool), args);
          else throw new Error(`未知工具: ${tool}`);
        } catch (err: unknown) {
          ok = false;
          if (err instanceof Error) {
            error = err.message;
          } else {
            error = String(err);
          }
        } finally {
          endAgentTool();
        }

        if (ok && tool !== "get_gif") result = await withVisual(tool, args, result, visualBefore);

        /*
         * 回结果之前把这次改动推给数据镜像:Agent 改完马上 see_frames 时,服务端拿镜像去渲,
         * 必须已经是改完的那一份(读后写一致)。没改动时这一步什么都不发。
         */
        try { await flushDataMirror(); } catch { /* 推不上不影响这次结果;服务端没有新镜像时会退回经页面执行 */ }

        const opIds = pageOpIdsSince(opMark);
        // 这次改了哪几条「剪辑->序列」随回包带回去:没接文档服务时,服务端的公告板靠它记改动(A3;接了就由提交流记)
        let scopes: string[] = [];
        if (ok && before) {
          try { scopes = agentBus.diffScopes(before, getState().project); } catch { scopes = []; }
        }
        fetch("/api/mcp/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, ok, result, error, ...(opIds.length ? { opIds } : {}), ...(scopes.length ? { scopes } : {}) })
        }).catch(() => {});

      }
    };

    source.onerror = () => {
      onStatus?.({ connected: false });
      if (source) source.close();
      if (active) {
        setTimeout(connect, 3000);
      }
    };
  };

  connect();

  return () => {
    active = false;
    stopTabReports();
    if (source) {
      source.close();
      source = null;
    }
  };
}
