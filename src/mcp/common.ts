import { type TrackResult } from "../ai/track";
import { getState, actions } from "../store/project";
import { getCard } from "../kernel/registry";
import { assertNo3dOnMedia, envelopeOf, isComposite } from "../kernel/envelope";
import type { PartInstance } from "../kernel/types";
import { CAPTION_CARD_ID } from "../kernel/captions";
import { findClip, suggestPosition, type SubjectBox, type SubjectRangeInfo } from "../kernel/project";
import { createClipGuard, lookHint } from "./tools/toolEcho";
import { createTrackTools } from "./tools/trackTools";
import { createFilterTools } from "../editor/right/filterTools";
import { createAudioFxTools } from "../editor/right/audioFxTools";
import { createPixelMapTools } from "./tools/pixelMapTools";
import { audioPlanOf, soundingAt } from "../kernel/audioPlan.mjs";
import { mediaSpanOf } from "../kernel/clipTime.mjs";
import { worldOf, rectForSafeSide, frameBox, type Size } from "../kernel/layout";
import { backRole, backStage, syncProject } from "../editor/stageBridge";
import { runBackJob } from "../editor/stageJobs";
import type { RectWithBounds } from "../render/solid";
import { invalidateScopes, loadScopes, type ScopeEntry } from "../editor/cardScope";

import type { ClipFrame } from "../kernel/types";
import { type CollectJob } from "../ai/collect";
import { apiUrl } from "./apiUrl";

/** 舞台尺寸:卡片级 frame 的父坐标系 */
export function stageSize(): Size {
  const p = getState().project;
  return { width: p.width, height: p.height };
}

type ContentBox = { left: number; top: number; width: number; height: number } | null;
export const roundBox = (b: { left: number; top: number; width: number; height: number }): ContentBox =>
  ({ left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) });

/**
 * 卡片的**实体内容**框:文字、图片、有底色的盒子这些真正画了东西的元素的并集,透明容器穿过去。
 * 判「会不会盖住人」要看它,不是画布框 —— 默认卡的画布 1920 宽,拿画布判永远是"会盖住"。
 *
 * **批量、一次往返**(D4 页面侧):把全部 clipId 一起问后台舞台(pinned 架构 4:用户交互的查询
 * 跑在自己的离屏舞台,不打预渲染)——
 *   先把当前 project 同步过去、setTime 到播放头,再 rectsWithBounds({ pixels: 'all' }) 一次拿回全部实体框。
 * 素材段的 contentBox 一律等于其 frameCss 框(不在舞台里,按项目数据算)。
 * 卡片此刻不在画面上(播放头不在它的区间)就量不到:contentBox 为 null 并附 contentNote,别当成"没内容"。
 *
 * **整段排进后台舞台的单飞队列**(D4):后台舞台的项目有三种占用者(补跑 / 这里的测量 / 探针),
 * 测量排在补跑后面、探针前面。开工前由队列发 `setRole('back', { job: 'catchup' })` 把探针挂起,
 * 量完交还给下一个占用者 —— 不这么做的话,探针的缩水项目会在两句 RPC 之间把舞台换掉,
 * 量回来的是另一台戏的框。legacy 的单舞台下队列不发 `setRole`,行为和以前一样。
 */
export async function measureContentBoxes(clipIds: string[]): Promise<Map<string, { contentBox: ContentBox; contentNote?: string }>> {
  const st = getState();
  const out = new Map<string, { contentBox: ContentBox; contentNote?: string }>();
  const stage = stageSize();
  const cardIds: string[] = [];
  for (const id of clipIds) {
    const hit = findClip(st.project, id);
    if (!hit) { out.set(id, { contentBox: null, contentNote: `找不到 clip ${id}` }); continue; }
    if (!hit.clip.cardId) { out.set(id, { contentBox: roundBox(frameBox(hit.clip.frame, stage)) }); continue; }
    cardIds.push(id);
  }
  if (!cardIds.length) return out;
  /*
   * 舞台还没就绪就当场说清楚,**不排队等** —— 队列会一直等到有舞台为止,而这条路上
   * 接着的是 Agent 的 get_layout:与其把一次工具调用挂在那里,不如让它拿到这句话再来一次。
   */
  if (!backStage()) {
    for (const id of cardIds) out.set(id, { contentBox: null, contentNote: "预览窗口没就绪,量不到内容框;稍后再 get_layout" });
    return out;
  }
  const list = await runBackJob("measure", async ({ stage: s }) => {
    let rects: RectWithBounds[] = [];
    try {
      await syncProject(backRole(), st.project);
      // 量之前先退出实体模式:播放中画面上是色块,量到的就是色块的框而不是内容的框(只在 ?proxy=1 的页面有效)
      await s.setProxy(false);
      await s.setTime(st.t);
      rects = await s.rectsWithBounds({ pixels: "all", clipIds: cardIds });
    } finally {
      try { await s.setProxy(st.playing); } catch { /* 恢复失败不该让工具失败 */ }
    }
    return rects;
  }).catch((err: unknown) => {
    for (const id of cardIds) out.set(id, { contentBox: null, contentNote: `舞台没回应,量不到内容框:${err instanceof Error ? err.message : String(err)}` });
    return null;
  });
  if (!list) return out;
  for (const id of cardIds) {
    const r = list.find((x) => x.clipId === id);
    if (!r) {
      const hit = findClip(st.project, id);
      const range = hit ? `${hit.clip.start}~${hit.clip.end}s` : "?";
      out.set(id, { contentBox: null, contentNote: `这张卡此刻不在画面上(播放头 ${st.t}s 不在它的 ${range} 区间内),先 seek 进它的时段再读` });
      continue;
    }
    out.set(id, { contentBox: roundBox(r.bounds ?? r.rect) });
  }
  return out;
}

/**
 * 定位工具返回的布局(**纯计算**,不打舞台):local 是存下来的框(没设过为 null),world 是算出来的画面
 * 绝对位置(box 画布、visualBox 缩放旋转后)。写工具(set_position / set_rect / align / nudge)只回这个;
 * 实体内容框 contentBox 要另调 get_layout(contentLayoutOf)。
 */
export function frameLayoutOf(clipId: string) {
  const hit = findClip(getState().project, clipId);
  const frame = (hit?.clip as { frame?: ClipFrame } | undefined)?.frame;
  return { clipId, local: frame ?? null, world: worldOf(frame, stageSize(), getState().project.camera3dFov) };
}

/** frameLayoutOf + 量出来的 contentBox(一次往返量全部 clipIds,见 measureContentBoxes) */
export async function contentLayoutOf(clipIds: string[]) {
  const measured = await measureContentBoxes(clipIds);
  const out: Record<string, ReturnType<typeof frameLayoutOf> & { contentBox: ContentBox; contentNote?: string }> = {};
  for (const id of clipIds) out[id] = { ...frameLayoutOf(id), ...(measured.get(id) ?? { contentBox: null }) };
  return out;
}

/**
 * 定位工具的公共骨架:找到 clip → 用现有框算出新框 → 存 → 回 layout + look。
 * set_position / set_rect / align / nudge 四个只是 next 不同 —— 它们改的是同一个框。
 */
/**
 * 组合卡部件树工具的公共骨架:找到 clip → 确认是组合卡 → 用纯函数算新树 → 存 → 回封装 + look。
 * add_part / set_part / remove_part / move_part 只是 next 不同。
 */
export function withParts<R extends { tree: PartInstance[] }>(clipId: string, next: (tree: PartInstance[]) => R, extra?: (r: R) => Record<string, unknown>) {
  const hit = findClip(getState().project, clipId);
  if (!hit) throw new Error(`找不到 clip ${clipId}`);
  if (!isComposite(hit.clip)) throw new Error(`clip ${clipId} 不是组合卡(cardId 要是 composite);先 add_composite 建一张,或 update_clip 把它换成 composite`);
  const r = next(hit.clip.parts ?? []);
  actions.setClipParts(clipId, r.tree);
  const after = findClip(getState().project, clipId)!;
  return { ok: true, clipId, ...(extra ? extra(r) : {}), envelope: envelopeOf(getState().project, after.clip, getCard(after.clip.cardId), stageSize()), look: lookHint(clipId) };
}

export function withFrame(clipId: string, next: (prev: ClipFrame | undefined, stage: Size) => ClipFrame | undefined) {
  const hit = findClip(getState().project, clipId);
  if (!hit) throw new Error(`找不到 clip ${clipId}`);
  const prev = (hit.clip as { frame?: ClipFrame }).frame;
  actions.setClipFrame(clipId, next(prev, stageSize()));
  return { ok: true, clipId, layout: frameLayoutOf(clipId), look: lookHint(clipId) };
}

/**
 * set_position 那条路上的素材三维拦截。规则本身在 kernel/envelope.ts 的 assertNo3dOnMedia,
 * 那里同时守着 set_clip 那条路 —— 两条路共用一份判断和一份措辞,免得以后只改一处。
 */
export function reject3dOnMedia(clipId: string, args: { rotateX?: number; rotateY?: number; translateZ?: number }) {
  const hit = findClip(getState().project, clipId);
  if (hit) assertNo3dOnMedia(hit.clip, args as ClipFrame);
}

/** 后台 STT 任务的状态(MCP 工具立即返回 jobId,结果靠轮询) */
interface SttJob { done: boolean; ok: boolean; error?: string; logTail?: string[]; segments?: number }
/**
 * 归属表的同步快照。`list_cards` 是同步的,没法 await —— 所以模块加载时先拉一次,
 * 建卡 / 改档位之后再刷新。拉不到就是空表,而空表在 isCardVisible 里一律放行:
 * 宁可多给几张卡,也不能因为一次网络抖动让 Agent 突然一张卡都看不见。
 */
export let cardScopes: Record<string, ScopeEntry> = {};
export const refreshScopes = () => { invalidateScopes(); loadScopes(true).then((m) => { cardScopes = m; }).catch(() => {}); };
loadScopes().then((m) => { cardScopes = m; }).catch(() => {});
export const sttJobs = new Map<string, SttJob>();

/** 素材收集拓展的安装作业。和 sttJobs 分开,理由同 trackInstallJobs。 */
export const collectInstallJobs = new Map<string, { done: boolean; ok: boolean; error?: string; logTail: string[] }>();
/**
 * 下载作业:服务端那份进度 + 这边登记进素材库的结果。
 * 登记只做一次(imported 标记),collect_job 被轮询多少次都不会重复加素材。
 */
export const collectJobs = new Map<string, {
  job?: CollectJob; imported: boolean; mediaIds: string[]; error?: string;
}>();

/** 时间轴工具的删除门槛。见 toolEcho.ts 头注释里那份复盘。 */
export const clipGuard = createClipGuard();
/** 序列工具(list/remove/update/move_track)的校验和门槛。见 trackTools.ts 头注释 */
export const trackTools = createTrackTools({ getState, actions });
/** 滤镜库工具(list/create/update/remove/apply_filter)。见 filterTools.ts 头注释 */
export const filterTools = createFilterTools({ getState, actions });
/** 音频效果库工具(list/create/update/remove/apply_audio_fx)。见 audioFxTools.ts 头注释 */
export const audioFxTools = createAudioFxTools({ getState, actions });
export const pixelMapTools = createPixelMapTools({ getState, actions });

/**
 * 「测谁」:measure_audio 与 measure_audio_js 共用。回服务端要的那几项(素材、片段在素材里的起点和长度、时间轴的混音清单),
 * timeline 档另回 kernel/audioPlan 的清单(给逐秒曲线标出声的是谁);时间轴上没有会出声的片段回 empty。
 */
function audioTargetOf(args: { clipId?: string; mediaId?: string; scope?: string }) {
  const p = getState().project;
  const scope = args.scope || (args.clipId ? "clip" : args.mediaId ? "media" : "timeline");
  const mediaOf = (id: string) => {
    const m = p.media.find((x) => x.id === id);
    if (!m) throw new Error(`找不到素材 ${id}`);
    if (m.kind === "image") throw new Error(`「${m.name}」是图片,没有声音`);
    return { id: m.id, name: m.name, kind: m.kind, url: m.url, path: (m as { path?: string }).path };
  };
  if (scope === "clip") {
    const hit = findClip(p, String(args.clipId || ""));
    if (!hit) throw new Error(`当前剪辑里没有片段 ${args.clipId || "(没给 clipId)"}`);
    if (!hit.clip.mediaId || hit.clip.cardId) throw new Error("卡片没有声音;要测的是视频 / 声音片段");
    // 变速段量的是它用到的那截素材(时间轴时长 × 片段速度,kernel/clipTime.mjs;缺省 1 逐位不变)
    return { scope, plan: null, body: { scope, media: mediaOf(hit.clip.mediaId), offset: hit.clip.mediaOffset ?? 0, duration: mediaSpanOf(hit.clip) } as Record<string, unknown> };
  }
  if (scope === "media") {
    return { scope, plan: null, body: { scope, media: mediaOf(String(args.mediaId || "")) } as Record<string, unknown> };
  }
  const plan = audioPlanOf(p);
  if (!plan.length) return { scope, plan, body: null, empty: true };
  return {
    scope,
    plan,
    body: {
      scope: "timeline",
      duration: p.duration,
      entries: plan.map((e) => ({ clipId: e.clipId, media: mediaOf(e.mediaId), start: e.start, dur: e.dur, offset: e.offset, ...(e.speed ? { speed: e.speed } : null), volume: e.volume, fadeIn: e.fadeIn, fadeOut: e.fadeOut })),
    } as Record<string, unknown>,
  };
}

const NO_SOUND_NOTE = "时间轴上没有会出声的片段(隐藏 / 静音的序列和静音的片段不算)";

/**
 * 自定义测量(measure_audio_js,计划 A6;只在创造力等级「高」开放,闸在 server/agent/creativity-gate.mjs)。
 * 「测谁」与 measure_audio 相同;服务端把那段声音解成 PCM,在专用 Chrome 的沙箱里跑 Agent 写的函数体,只回 JSON
 * (server/audio-measure-js.mjs、server/audio-sandbox.mjs)。代码自己的错(语法、抛错、超时、结果太大)原样回给 Agent,不当成工具故障。
 */
export async function measureAudioJs(args: {
  code: string; clipId?: string; mediaId?: string; scope?: string;
  start?: number; duration?: number; sampleRate?: number; mono?: boolean; timeoutMs?: number;
}) {
  const target = audioTargetOf(args);
  if (!target.body) return { ok: true, scope: target.scope, empty: true, note: NO_SOUND_NOTE };
  const tb = target.body;
  const body = {
    ...tb,
    // timeline 档的 duration 是时间轴时长,换个名字,duration 留给片段
    ...(target.scope === "timeline" ? { duration: undefined, total: tb.duration } : null),
    start: args.start, length: args.duration, sampleRate: args.sampleRate, mono: args.mono, timeoutMs: args.timeoutMs,
    code: args.code,
    meta: { clipId: args.clipId, mediaId: target.scope === "media" ? args.mediaId : (tb.media as { id?: string } | undefined)?.id },
  };
  const res = await fetch(apiUrl("/api/audio/measure-js"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(85000) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error(data?.error || `自定义测量失败(HTTP ${res.status})`);
  const out: Record<string, unknown> = { ...data, scope: target.scope };
  if (target.plan) {
    const withFx = target.plan.filter((e) => e.fx).map((e) => e.clipId);
    if (withFx.length) out.notes = [...(Array.isArray(data.notes) ? data.notes : []), `${withFx.join("、")} 挂着音频效果,这里测的不含效果`];
  }
  return out;
}

/**
 * 测响度(measure_audio):素材、时间轴片段、或整条时间轴的混音。ffmpeg 在服务端跑(server/vite-plugin-audio.ts),
 * 这里只把「测谁、从第几秒到第几秒」算清楚。timeline 档把 kernel/audioPlan 的清单整份发过去,回来的逐秒曲线
 * 再按同一份清单标上那一秒谁在出声 —— Agent 拿到「第 19 秒 -8 LUFS,出声的是配乐 + 配音 04」才能归因。
 */
export async function measureAudio(args: { clipId?: string; mediaId?: string; scope?: string; series?: boolean }) {
  const req = measureAudioRequest(args);
  if (!req.body) return req.empty;
  const res = await fetch(apiUrl("/api/audio/measure"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body), signal: AbortSignal.timeout(55000) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok === false) throw new Error(data?.error || `测响度失败(HTTP ${res.status})`);
  return measureAudioFinish(req, data);
}

/**
 * measure_audio 的前半:按此刻 store 里的项目算出「测谁、从第几秒到第几秒」。桌面版把 `body` 发给编辑器进程的 `/api/audio/measure`;
 * 云端 Agent(`server/agent/service/hosted-audio.mjs`)拿同一份 `body` 在对话的工作目录里量。没有会出声的片段时 `body` 是 null、回 `empty`。
 */
export function measureAudioRequest(args: { clipId?: string; mediaId?: string; scope?: string; series?: boolean }) {
  const target = audioTargetOf(args);
  const scope = target.scope;
  if (!target.body) return { scope, plan: target.plan, body: null, empty: { ok: true, scope, empty: true, note: NO_SOUND_NOTE } };
  const body: Record<string, unknown> = scope === "timeline" ? target.body : { ...target.body, series: !!args.series };
  return { scope, plan: target.plan, body, empty: null };
}

/** measure_audio 的后半:给量出来的数标上「那一秒谁在出声」与注意事项 */
export function measureAudioFinish(req: { scope: string; plan: ReturnType<typeof audioPlanOf> | null }, data: Record<string, any>) {
  const { scope, plan } = req;
  const notes: string[] = Array.isArray(data.notes) ? [...data.notes] : [];
  const out: Record<string, unknown> = { ...data, scope };
  if (plan) {
    if (Array.isArray(data.series)) out.series = data.series.map((s: { t: number }) => ({ ...s, sounding: soundingAt(plan!, s.t) }));
    const withFx = plan.filter((e) => e.fx).map((e) => e.clipId);
    if (withFx.length) notes.push(`${withFx.join("、")} 挂着音频效果,这里测的不含效果(效果在 Chrome 里算,导出时才混进去)`);
    out.clips = plan.map((e) => ({ clipId: e.clipId, mediaId: e.mediaId, start: e.start, end: +(e.start + e.dur).toFixed(3), volume: +e.volume.toFixed(3), ...(e.fx ? { fxId: e.fx.def.id } : null) }));
  } else if (scope === "clip") {
    notes.push("测的是这一段用到的那截素材的原声;片段音量、淡入淡出和音频效果都不含");
  }
  if (notes.length) out.notes = notes;
  return out;
}

/** 正在跑的镜头识别作业,按 mediaId 索引。结果落进 store 后就删掉。 */
export const shotJobs = new Map<string, { jobId: string; percent: number; engine: string; error?: string }>();
/** 进行中的追踪作业,以及跑完的轨迹。都只在内存里,刷新页面就没了 */
// engine 可以是 undefined:哪一档在跑由 Python 侧决定,作业跑完前 Node 不知道。
// 之前这里写死 "bootstapir",于是没装拓展时会把兜底档的进度报成神经网络档。
// 拓展安装的后台作业。和 sttJobs 分开:两者的 jobId 各自生成,混在一张表里
// 只会让「找不到这个 jobId」这类问题更难查。
export const trackInstallJobs = new Map<string, {
  done: boolean; ok: boolean; error?: string; logTail: string[];
}>();

export const trackJobs = new Map<string, {
  jobId: string; percent: number; engine?: "bootstapir" | "template"; error?: string;
}>();
export const trackResults = new Map<string, TrackResult>();

/** 正在跑的主体检测作业,按 mediaId 索引。结果落进 store(MediaAsset.subjects)后就删掉。 */
export const subjectJobs = new Map<string, {
  jobId: string; percent: number; engine?: "light" | "full"; error?: string;
}>();
/** 主体检测拓展的安装作业。理由同 trackInstallJobs:jobId 各自生成,不混表 */
export const subjectInstallJobs = new Map<string, {
  done: boolean; ok: boolean; error?: string; logTail: string[];
}>();

/** 一段区间上最有代表性的几个框。全量吐给模型太长,一个镜头三次采样就是三份重复的人 */
/**
 * 找那张字幕卡。不给 clipId 时:时间轴上只有一张就用它,有多张要求说清楚是哪张
 * (和 fill_captions 一个口径 —— 猜错了会改到另一段视频的字幕上,不如报错)。
 */
export function findCaptionClip(clipId?: string) {
  const project = getState().project;
  if (!clipId) {
    const hits = project.tracks.flatMap((t) => t.clips.filter((c) => c.cardId === CAPTION_CARD_ID));
    if (hits.length === 0) throw new Error("时间轴上没有字幕卡。先 add_clip 建一张 caption-track,再用 fill_captions 灌进文字稿。");
    if (hits.length > 1) throw new Error(`时间轴上有 ${hits.length} 张字幕卡,请用 clipId 指明是哪一张:${hits.map((c) => c.id).join(", ")}`);
    clipId = hits[0].id;
  }
  const hit = findClip(project, clipId);
  if (!hit) throw new Error(`找不到 clip ${clipId}`);
  if (hit.clip.cardId !== CAPTION_CARD_ID) throw new Error(`clip ${clipId} 是 ${hit.clip.cardId || "素材段"},不是字幕卡。`);
  return hit;
}

export function topBoxes(boxes: SubjectBox[], limit = 4): SubjectBox[] {
  return [...boxes]
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, limit)
    .map((b) => ({
      label: b.label,
      x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h),
      conf: Math.round(b.conf * 100) / 100,
    }));
}

/** 把 subjectForRange 的结果折成给模型看的形状:带能直接填进 params.position 的建议 */
export function subjectDigest(info: SubjectRangeInfo | null) {
  if (!info) return null;
  const round2 = (v: number) => Math.round(v * 100) / 100;
  // suggestedPosition 是「剩下三档里最不坏的」,不等于「保证不遮」。把被选中那一侧的
  // 占用率一并报出来,占过一半就置 null 并给 warning —— 正面说话人半身镜头
  // (safeSide=top)最常见的情况是四侧全被占,以前这里会给出一个 89.5% 是人的 right,
  // 模型照着填,卡片正好压在脸上,而返回里没有任何字段透出这件事。
  const sug = suggestPosition(info.safeSide, info.occupancy);
  return {
    safeSide: info.safeSide,
    ...sug,
    // 空的那一侧直接给成矩形,喂给 set_rect 就能把任何卡放过去 —— 不再受卡片自带 position
    // 档位限制(safeSide 是 top 也能用了,以前 top 没有对应档位只能作罢)。四侧全被占(sug 置 null)
    // 时这里也 null:那一刻没有不遮人的矩形,别硬放。
    suggestedRect: sug.suggestedPosition == null ? null : rectForSafeSide(info.safeSide, stageSize(), 40),
    occupancy: {
      left: round2(info.occupancy.left), right: round2(info.occupancy.right),
      top: round2(info.occupancy.top), bottom: round2(info.occupancy.bottom),
    },
    sampledAt: info.times,
    boxCount: info.boxes.length,
    boxes: topBoxes(info.boxes),
    ...(info.approximate
      ? { approximate: true, note: "这段区间里没有采样点,数字来自时间上最近的一次采样,只是近似" }
      : null),
  };
}

