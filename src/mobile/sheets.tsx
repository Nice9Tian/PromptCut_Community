/**
 * 手机版的底部面板:素材库、卡片库(含转场)、选剪辑、调整、冲突合并、成员、导出(演示稿第三～九轮)。
 * 每个按钮都调真实的 store 动作与服务,不写假数据;业务层里没有的项不显示(任务书「设计决定」3)。
 */
import { useMemo, useRef, useState } from "react";
import { actions, getState, useStore, withMerge } from "../store/project";
import { findClip, type MediaAsset, type Project, type TrackClip } from "../kernel/project";
import { MAX_TRANSITION_DUR, MIN_TRANSITION_DUR, transitionsOf, type Transition, type TransitionKind } from "../kernel/transitions";
import { getCard } from "../kernel/registry";
import { CLIP_SPEED_MAX, CLIP_SPEED_MIN, CLIP_SPEED_PRESETS, SPEED_MUTE_NOTE, clipSpeed, speedChangeNotes, speedLabel } from "../kernel/clipTime.mjs";
import { listCuts } from "../kernel/cuts";
import type { CardDef } from "../kernel/types";
import { importMediaFiles, MEDIA_ACCEPT } from "../editor/left/importAssets";
import { useCardLibrary } from "../editor/left/library/cardGroups";
import { accountMemberAdmin, currentAccountProjectLink, currentSharedUrl, discardOffline, pausedSummary, replayOffline, setMergeOpen, setOfflineOpen, useSync } from "../editor/sync/syncManager";
import type { AccountJoinRequestRow } from "../editor/sync/accountExtensions";
import { JOIN_REQUEST_TEXT, requestedAtText } from "../editor/sync/joinRequestText";
import { createRequestIds } from "../editor/sync/requestIds";
import { mergeBarText, useConflictMerge, useMergeCounts } from "../editor/sync/useConflictMerge";
import { mergeBlockedText } from "../editor/sync/ConflictMerge";
import { IMPORT_OFFLINE_TEXT, useImportOffline } from "../editor/sync/useImportOffline";
import "./conflictMerge.css";
import { exportVideo, cancelExport, streamExportFile } from "../editor/io";
import { pickSaveTarget } from "../editor/io/proc";
import { exportGateNow } from "../editor/media/assetTiers";
import { awaitingUploaderMessage } from "../render/mediaTier";
import { exportSkippedMessage } from "../editor/io/exportSkipped";
import { ONLINE_EXPORT_TEXT } from "../export/text";
import type { ExportMode } from "../export/cardLayers";
import { OVERLAY_KIND_NAME, overlaysOfClip, type OverlayItem } from "../editor/timeline/overlays";
import { detachOverlay, setOverlayOff } from "../editor/timeline/overlayActions";
import { clipKind, clipName, mainClipsOf, mainTrackOf } from "./mainContent";
import { Icon } from "./icons";
import { Sheet, fmtDur, fmtTc, tint, useToast } from "./ui";
import { ControlField, Slider } from "./controls";
import { ClipFilterFields, FiltersGrid, filterableClip } from "./filters";
import { ThumbImg, useThumb } from "./Thumb";
import type { MembersInfo } from "./useMembers";

/* ======================== 素材库 ======================== */

export type AssetTab = "video" | "image" | "audio" | "cut";
const ASSET_TABS: { id: AssetTab; label: string }[] = [
  { id: "video", label: "视频" }, { id: "image", label: "图片" }, { id: "audio", label: "音频" }, { id: "cut", label: "剪辑" },
];

/** 视频 / 图片接到主要内容末尾;声音加到播放头位置 */
export function placeMedia(m: MediaAsset): TrackClip | null {
  const p = getState().project;
  if (m.kind === "audio") return actions.addMediaClip(m.id, getState().t);
  const main = mainClipsOf(p);
  const track = mainTrackOf(p);
  const end = main.length ? Math.max(...main.map((c) => c.end)) : 0;
  return actions.addMediaClip(m.id, end, track ? { trackId: track.id } : {});
}

export function AssetsSheet(props: { tab: AssetTab; onTab: (t: AssetTab) => void; onClose: () => void; onSwitchCut: (name: string) => void; onPlaced: (clip: TrackClip, m: MediaAsset) => void }) {
  const media = useStore((s) => s.project.media);
  // 剪辑列表按项目算一次(同桌面素材库的剪辑组):选择器里不能现造数组,否则每次读都是新值、无限重渲
  const project = useStore((s) => s.project);
  const cuts = useMemo(() => listCuts(project), [project]);
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // 在线浏览器断网时导入媒体置灰、提示「当前离线」(2026-10-22 用户定)
  const importOffline = useImportOffline();
  const list = media.filter((m) => (props.tab === "audio" ? m.kind === "audio" : props.tab === "image" ? m.kind === "image" : m.kind === "video"));
  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const r = await importMediaFiles(files);
      const n = r.counts.video + r.counts.audio + r.counts.image;
      toast(n ? `已导入 ${n} 个素材${r.skipped.length ? `，跳过 ${r.skipped.length} 个认不出的文件` : ""}` : r.rejected[0] ?? "没有能导入的文件");
      if (r.firstKind) props.onTab(r.firstKind);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <Sheet
      id="assets"
      title="素材库"
      tall
      onClose={props.onClose}
      head={props.tab !== "cut" ? <button type="button" className="chip accent" data-pcm="import" disabled={busy || importOffline} title={importOffline ? IMPORT_OFFLINE_TEXT : undefined} onClick={() => { if (!importOffline) input.current?.click(); }}>{busy ? "导入中…" : importOffline ? `＋ 导入（${IMPORT_OFFLINE_TEXT}）` : "＋ 导入"}</button> : null}
      tabs={<div className="seg">{ASSET_TABS.map((t) => <button key={t.id} type="button" className={t.id === props.tab ? "on" : undefined} onClick={() => props.onTab(t.id)}>{t.label}</button>)}</div>}
    >
      <input ref={input} type="file" multiple accept={MEDIA_ACCEPT} hidden data-pcm="import-input" onChange={(e) => void onFiles(e.target.files)} />
      {props.tab === "cut" ? (
        <>
          <div className="hint">点剪辑：缩略时间轴和完整时间轴换成它的内容。</div>
          <div className="grid">
            {cuts.map((c) => (
              <button key={c.id} type="button" className={c.active ? "tile picked" : "tile"} data-pcm="asset-cut" onClick={() => { if (!c.active) props.onSwitchCut(c.id); props.onClose(); }}>
                <div className="pic"><Icon name="clip" /></div>
                <div className="cap">{c.name}<small>剪辑</small></div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <button type="button" className="dropzone" data-pcm="import-dropzone" disabled={busy || importOffline} onClick={() => { if (!importOffline) input.current?.click(); }}>{importOffline ? `＋ 从相册 / 文件导入（${IMPORT_OFFLINE_TEXT}）` : "＋ 从相册 / 文件导入"}</button>
          <div className="hint">{props.tab === "audio" ? "点一下加到播放头位置。" : "点一下接到主要内容末尾。"}</div>
          {list.length === 0 ? <div className="hint" data-pcm="asset-empty">这个项目里还没有{ASSET_TABS.find((t) => t.id === props.tab)!.label}素材。</div> : (
            <div className="grid">
              {list.map((m) => (
                <button key={m.id} type="button" className="tile" data-pcm="asset" data-media={m.id} onClick={() => {
                  const clip = placeMedia(m);
                  if (!clip) { toast("放不下：没有空着的序列"); return; }
                  props.onPlaced(clip, m);
                }}>
                  <AssetPic m={m} />
                  <div className="cap">{m.name}<small>{m.kind === "audio" ? "音频" : m.kind === "image" ? "图片" : "视频"}</small></div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}

/** 素材格子的画面:取色底色 + 类型图标打底,取到首帧 / 缩略图就盖上去(`Thumb.tsx`) */
function AssetPic({ m }: { m: MediaAsset }) {
  const thumb = useThumb(m);
  return (
    <div className="pic" data-thumb={thumb.src ? "ready" : undefined} style={{ background: `linear-gradient(135deg, ${tint(m.id)}, var(--shade-art))` }}>
      {m.kind !== "audio" && <ThumbImg thumb={thumb} />}
      <Icon name={m.kind === "audio" ? "audio" : m.kind === "image" ? "image" : "video"} />
      {m.duration ? <span className="dur">{fmtDur(m.duration)}</span> : null}
      {m.pending ? <span className="st">上传中</span> : m.transcript ? <span className="st">已转写</span> : null}
    </div>
  );
}

/* ======================== 卡片库 ======================== */

export type CardTab = "anim" | "text" | "filter" | "transition";
const TRANSITION_KINDS: { kind: TransitionKind; name: string; desc: string }[] = [
  { kind: "crossfade", name: "交叉溶解", desc: "前一段叠着化到后一段" },
  { kind: "fadeOut", name: "淡出", desc: "前一段结尾淡到黑" },
  { kind: "fadeIn", name: "淡入", desc: "后一段开头从黑里出来" },
];

/** 一段是不是文字卡:有一个叫 text 的文字参数 */
const isTextCard = (c: CardDef<any>) => c.controls.some((k) => k.key === "text" && k.type === "text");

/** 转场要落在哪:两段主要内容之间(加),或者换掉某一处已有的 */
export interface TransitionTarget { a: TrackClip; b: TrackClip; replace?: Transition }

/** 在 a、b 之间放一种转场;有 replace 时先删掉它(一步撤销) */
export function applyTransition(target: TransitionTarget, kind: TransitionKind, dur?: number): { ok: true } | { ok: false; error: string } {
  const run = () => {
    if (target.replace) {
      const r = actions.removeTransition(target.replace.id);
      if (!r.ok) return r;
    }
    const args = kind === "crossfade" ? { kind, clipId: target.a.id, otherClipId: target.b.id } : { kind, clipId: kind === "fadeOut" ? target.a.id : target.b.id };
    const r = actions.addTransition({ ...args, ...(dur ? { dur } : {}) });
    return r.ok ? { ok: true as const } : r;
  };
  return withMerge({ key: `pcm-transition-${Date.now()}`, windowMs: Infinity }, run);
}

export function CardsSheet(props: { tab: CardTab; onTab: (t: CardTab) => void; transition: TransitionTarget | null; onClose: () => void; onAdded: (clip: TrackClip) => void }) {
  const lib = useCardLibrary("");
  const toast = useToast();
  const all = [...lib.user, ...lib.magic, ...lib.native, ...lib.lottie, ...lib.particles].filter((c) => !c.kind || c.kind === "animation");
  const cards = props.tab === "text" ? all.filter(isTextCard) : all.filter((c) => !isTextCard(c));
  const tr = props.transition;
  const hint = props.tab === "transition"
    ? tr?.replace ? "换一个转场：点一种，替换当前这一处。" : tr ? "点一种转场，加到这两段之间。" : "先在缩略时间轴上点两段之间的 ＋，再选转场。"
    : props.tab === "filter" ? null : "点一张卡片，加到播放头所在位置。";
  return (
    <Sheet
      id="cards"
      title="卡片（特效 / 动效）"
      tall
      onClose={props.onClose}
      tabs={<div className="seg">{([["anim", "动效"], ["text", "文字"], ["filter", "滤镜"], ["transition", "转场"]] as const).map(([id, label]) => <button key={id} type="button" className={id === props.tab ? "on" : undefined} onClick={() => props.onTab(id)}>{label}</button>)}</div>}
    >
      {hint && <div className="hint" data-pcm="cards-hint">{hint}</div>}
      {props.tab === "filter" ? <FiltersGrid /> : props.tab === "transition" ? (
        <div className="grid">
          {TRANSITION_KINDS.map((k) => (
            <button key={k.kind} type="button" className={tr?.replace?.kind === k.kind ? "tile picked" : "tile"} data-pcm="transition-kind" data-kind={k.kind} disabled={!tr} onClick={() => {
              if (!tr) return;
              if (tr.replace?.kind === k.kind) { props.onClose(); return; }
              const r = applyTransition(tr, k.kind, tr.replace?.dur);
              if (!r.ok) { toast(r.error); return; }
              toast(tr.replace ? `已换成「${k.name}」` : `已加上「${k.name}」`);
              props.onClose();
            }}>
              <div className="pic"><Icon name="card" /></div>
              <div className="cap">{k.name}<small>{k.desc}</small></div>
            </button>
          ))}
        </div>
      ) : cards.length === 0 ? <div className="hint">没有可用的卡片。</div> : (
        <div className="grid">
          {cards.map((c) => (
            <button key={c.id} type="button" className="tile" data-pcm="card" data-card={c.id} onClick={() => {
              const clip = actions.addCardClip(c.id, getState().t);
              if (!clip) { toast("放不下：没有空着的序列"); return; }
              toast(`已加到 ${fmtTc(clip.start)}`);
              props.onAdded(clip);
            }}>
              <div className="pic" style={{ background: `linear-gradient(135deg, ${tint(c.id)}, var(--shade-art))` }}><Icon name={isTextCard(c) ? "text" : "card"} /></div>
              <div className="cap">{c.name}<small>{c.description}</small></div>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/* ======================== 选剪辑 ======================== */

export function ClipsSheet(props: { onClose: () => void; onSwitched: (name: string) => void }) {
  const project = useStore((s) => s.project);
  const cuts = useMemo(() => listCuts(project), [project]);
  const toast = useToast();
  const summary = (c: (typeof cuts)[number]) => {
    if (c.active) { const m = mainClipsOf(project); return `${m.length} 段 · 共 ${fmtDur(m.reduce((s, x) => s + x.end - x.start, 0))}`; }
    return `共 ${fmtDur(c.duration)}`;
  };
  return (
    <Sheet id="clips" title="选择剪辑" onClose={props.onClose}>
      <div className="hint">选一个剪辑，缩略时间轴就换成它的内容。</div>
      {cuts.map((c) => (
        <button key={c.id} type="button" className={c.active ? "crow cur" : "crow"} data-pcm="cut-row" data-cut={c.id} onClick={() => {
          if (!c.active) actions.switchCut(c.id);
          props.onSwitched(c.name);
          props.onClose();
        }}>
          <div className="i"><Icon name="clip" /></div>
          <div style={{ flex: 1, minWidth: 0 }}><b>{c.name}</b><div className="hint" style={{ margin: 0 }}>{summary(c)}</div></div>
          {c.active && <span className="chip accent">当前</span>}
        </button>
      ))}
      <button type="button" className="btn" style={{ width: "100%", marginTop: 6 }} data-pcm="cut-new" onClick={() => {
        actions.addCut(undefined, { switchTo: true });
        const now = getState().project;
        const name = now.cuts?.find((c) => c.id === now.activeCutId)?.name ?? "新剪辑";
        toast(`已新建“${name}”`);
        props.onSwitched(name);
        props.onClose();
      }}>＋ 新建剪辑</button>
    </Sheet>
  );
}

/* ======================== 调整 ======================== */

export type ParamsTarget = { clipId: string } | { transitionId: string };

/**
 * 「调整」表单最上面的一节:这一段挂着什么(滤镜、像素映射、音频效果、素材效果卡)。
 *
 * 放在时长、不透明度、音量之前:挂着的东西决定这一段现在长什么样,比它自己的参数更先要看;
 * 而且滤镜本来就已经在这张表单里(下面的 `ClipFilterFields`),这一节正好把它收编进来。
 *
 * 停用做成开关:桌面上这一项藏在右键菜单里,手机上没有右键,一行一个开关是最省事的做法。
 * 每一行各有一个「引用」—— 子导航那个引的是整段,一段上挂两张同名的滤镜很常见,
 * 不指明哪一张 Agent 只能反问。
 */
function OverlaySection({ clip, onQuote }: {
  clip: TrackClip;
  onQuote?: (clip: TrackClip, item: OverlayItem) => void;
}) {
  const project = useStore((s) => s.project);
  const toast = useToast();
  const items = useMemo(
    () => overlaysOfClip(project, clip, { cardName: (id) => getCard(id)?.name }),
    [project, clip],
  );
  if (!items.length) return null;
  return (
    <div data-pcm="param-overlays">
      <div className="hint">叠加卡 · {items.length} 张，从上到下就是处理顺序</div>
      {items.map((it) => (
        <div key={`${it.kind}:${it.refId}`} className={it.off ? "row is-off" : "row"} data-pcm="param-overlay">
          <div className="t">
            <b>{it.name}</b>
            <small>{OVERLAY_KIND_NAME[it.kind]}{it.value ? ` · ${it.value}` : ""}{it.off ? " · 已停用" : ""}</small>
          </div>
          {onQuote && (
            <button type="button" className="icon-btn ref" data-pcm="param-overlay-ref"
              aria-label={`引用「${it.name}」给 Agent`} title="把这一张引用给 Agent"
              onClick={() => onQuote(clip, it)}><Icon name="ref" /></button>
          )}
          <button type="button" className="icon-btn danger" data-pcm="param-overlay-detach"
            aria-label={`摘掉「${it.name}」`} disabled={!it.canDetach}
            title={it.canDetach ? "从这一段上摘掉" : "这张卡不止一路输入、或者本身就是这一段的内容，接不回去"}
            onClick={() => {
              try { detachOverlay(actions, clip, it, (id) => getCard(id)); }
              catch (e) { toast(e instanceof Error ? e.message : String(e)); }
            }}><Icon name="trash" /></button>
          <button type="button" className={it.off ? "toggle" : "toggle on"} data-pcm="param-overlay-toggle"
            aria-label={`${it.name}${it.off ? " 已停用" : " 生效中"}`}
            disabled={!it.canToggle}
            title={it.canToggle ? undefined : "素材效果卡的停用要在编辑分区的节点图里改"}
            onClick={() => setOverlayOff(actions, clip, it, !it.off)} />
        </div>
      ))}
    </div>
  );
}

export function ParamsSheet(props: { target: ParamsTarget; onClose: () => void; onAskAgent: (clipId: string) => void;
  /** 单张叠加卡的「引用」:和子导航那个「引用」同一条路,只是粒度细一级 */
  onQuoteOverlay?: (clip: TrackClip, item: OverlayItem) => void }) {
  const project = useStore((s) => s.project);
  const toast = useToast();
  const undoRow = (clipId?: string) => (
    <div className="undo-row">
      <button type="button" className="btn" data-pcm="params-undo" onClick={() => actions.undo()}><Icon name="undo" />撤销</button>
      {clipId && <button type="button" className="btn" onClick={() => props.onAskAgent(clipId)}>让 Agent 接着改</button>}
    </div>
  );
  if ("transitionId" in props.target) {
    const tr = transitionsOf(project).find((x) => x.id === (props.target as { transitionId: string }).transitionId);
    if (!tr) return <Sheet id="params" title="调整" light onClose={props.onClose}><div className="hint">这处转场已经不在了。</div></Sheet>;
    const name = TRANSITION_KINDS.find((k) => k.kind === tr.kind)!.name;
    return (
      <Sheet id="params" title={name} light onClose={props.onClose} head={<span className="chip plum">转场</span>}>
        <div className="wrapnote"><b>转场：</b>把相邻的段绑成一组，想单独挪动先删掉转场。</div>
        <Slider label="时长" pcm="param-transition-dur" value={tr.dur} min={MIN_TRANSITION_DUR} max={Math.min(4, MAX_TRANSITION_DUR)} step={0.1} unit="s" onCommit={(v) => {
          const a = findClip(project, tr.aId)?.clip, b = tr.bId ? findClip(project, tr.bId)?.clip : undefined;
          const target: TransitionTarget | null = tr.kind === "crossfade" ? (a && b ? { a, b, replace: tr } : null)
            : tr.kind === "fadeOut" ? (a ? { a, b: a, replace: tr } : null) : (a ? { a, b: a, replace: tr } : null);
          if (!target) return;
          const r = applyTransition(target, tr.kind, v);
          if (!r.ok) toast(r.error);
        }} />
        {undoRow()}
      </Sheet>
    );
  }
  const hit = findClip(project, props.target.clipId);
  if (!hit) return <Sheet id="params" title="调整" light onClose={props.onClose}><div className="hint">这个片段已经不在了。</div></Sheet>;
  const c = hit.clip;
  const kind = clipKind(project, c);
  const def = c.cardId ? getCard(c.cardId) : undefined;
  const len = c.end - c.start;
  const kindLabel = kind === "card" ? "卡片" : kind === "audio" ? "音频" : kind === "image" ? "图片段" : kind === "cut" ? "剪辑段" : "视频段";
  return (
    <Sheet id="params" title={clipName(project, c, (id) => getCard(id)?.name)} light onClose={props.onClose} head={<span className={kind === "card" ? "chip plum" : "chip"}>{kindLabel}</span>}>
      <OverlaySection clip={c} onQuote={props.onQuoteOverlay} />
      {def && def.controls.filter((k) => k.type !== "asset").map((k) => (
        <ControlField key={k.key} ctl={k} value={c.params[k.key] ?? (def.defaults as Record<string, unknown>)[k.key]} onCommit={(v) => actions.setClipParams(c.id, { [k.key]: v })} />
      ))}
      <Slider label="时长" pcm="param-dur" value={Math.round(len * 10) / 10} min={0.5} max={Math.max(30, Math.ceil(len))} step={0.1} unit="s" onCommit={(v) => {
        const before = getState().project;
        actions.moveClip(c.id, { end: c.start + v });
        if (getState().project === before) toast("改不了时长：后面放不下，或这一段挂着转场");
      }} />
      {kind !== "audio" && <Slider label="不透明度" pcm="param-opacity" value={Math.round((c.opacity ?? 1) * 100)} min={0} max={100} unit="%" onCommit={(v) => actions.updateClip(c.id, { opacity: v / 100 })} />}
      {filterableClip(project, c) && <ClipFilterFields clip={c} />}
      {(kind === "video" || kind === "audio") && <>
        <Slider label="音量" pcm="param-volume" value={Math.round((c.audioVolume ?? 1) * 100)} min={0} max={100} unit="%" onCommit={(v) => actions.setClipVolume(c.id, v / 100)} />
        {kind === "video" && clipSpeed(c) !== 1 && <div className="wrapnote" data-pcm="param-speed-note"><b>已变速 {speedLabel(clipSpeed(c))}：</b>{SPEED_MUTE_NOTE}</div>}
        <div className="row"><div className="t">静音此片段<small>画面不受影响；时间轴会醒目标出“已静音”</small></div>
          <button type="button" className={c.audioMuted ? "toggle on" : "toggle"} aria-label="静音" data-pcm="param-mute" onClick={() => actions.setClipMuted(c.id, !c.audioMuted)} /></div>
      </>}
      {undoRow(c.id)}
    </Sheet>
  );
}

/* ======================== 速度 ======================== */

/**
 * 视频段的「速度」(演示稿子导航栏里的「速度」一项;业务层是 store 的 setClipSpeed,和桌面编辑分区同一个动作)。
 * 起点不动、终点按新速度重算;〔裁〕第一版变速段不出原声,面板里写明(同一句 SPEED_MUTE_NOTE)。
 */
export function SpeedSheet(props: { clipId: string; onClose: () => void }) {
  const project = useStore((s) => s.project);
  const toast = useToast();
  const hit = findClip(project, props.clipId);
  const cur = hit ? clipSpeed(hit.clip) : 1;
  const [text, setText] = useState(String(cur));
  if (!hit) return <Sheet id="speed" title="速度" light onClose={props.onClose}><div className="hint">这个片段已经不在了。</div></Sheet>;
  const c = hit.clip;
  const presets = CLIP_SPEED_PRESETS.includes(cur) ? CLIP_SPEED_PRESETS : [...CLIP_SPEED_PRESETS, cur].sort((a, b) => a - b);
  const pick = (v: number) => {
    if (Math.abs(v - cur) < 1e-9) return;
    const r = actions.setClipSpeed(c.id, v);
    if (!r.ok) { toast(r.error); return; }
    setText(String(getState().project.tracks.flatMap((t) => t.clips).find((x) => x.id === c.id)?.speed ?? 1));
    const head = v === 1 ? "已恢复 1×，原声恢复" : `已改成 ${speedLabel(clipSpeed({ speed: v }))}，这一段不出原声`;
    // 转场跟着缩了、谁跟着挪了、推开了几段(用户 2026-10-23 定「气泡提示即可」):和桌面同一句(kernel/clipTime.mjs 的 speedChangeNotes)
    const tail = speedChangeNotes(r, c.id);
    toast(tail ? `${head}；${tail}` : head);
  };
  const commitText = () => {
    const v = Number(text.trim().replace(/[×x]$/i, ""));
    if (!Number.isFinite(v)) { toast("倍率要是数字"); setText(String(cur)); return; }
    pick(v);
  };
  return (
    <Sheet id="speed" title={clipName(project, c, (id) => getCard(id)?.name)} light onClose={props.onClose} head={<span className="chip">速度</span>}>
      <div className="seg" data-pcm="speed-presets" style={{ flexWrap: "wrap", rowGap: 6 }}>
        {presets.map((v) => (
          <button key={v} type="button" className={v === cur ? "on" : undefined} data-pcm="speed-preset" data-speed={v} aria-pressed={v === cur} onClick={() => pick(v)}>{speedLabel(v)}</button>
        ))}
      </div>
      {/* 手动输入倍率(用户 2026-10-23 定):0.25～4,可带小数;超出范围拒绝并提示,不夹 */}
      <div className="field" data-pcm="speed-custom">
        <label>自定义倍率<span><input className="num" data-pcm="speed-input" type="number" inputMode="decimal" min={CLIP_SPEED_MIN} max={CLIP_SPEED_MAX} step={0.01} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") commitText(); }} /> ×</span></label>
        <button type="button" className="btn" data-pcm="speed-apply" onClick={commitText}>应用</button>
      </div>
      <div className="wrapnote" data-pcm="speed-note"><b>声音：</b>{SPEED_MUTE_NOTE}</div>
      <div className="hint">起点不动，时长按新速度重算：{fmtDur(c.end - c.start)}（素材 {fmtDur((c.end - c.start) * cur)}）。变长碰到后面的段会把它们一起往后推，变短尾部留空；挂着转场时转场跟着片段两端走，装不下时转场跟着缩短并提示。</div>
      <div className="undo-row">
        <button type="button" className="btn" data-pcm="speed-undo" onClick={() => actions.undo()}><Icon name="undo" />撤销</button>
      </div>
    </Sheet>
  );
}

/* ======================== 冲突合并 ======================== */

/**
 * 冲突合并面板:与桌面的「冲突合并」窗口同一套(两级可勾选列表、「选中无冲突项」「取消全部勾选」、
 * 「合并」「删除选中」「下次再说 / 完成」),状态与动作都在 `editor/sync/useConflictMerge.ts`;样子照演示稿第九轮。
 * 待合并项来自待合并表(`mergeItems.ts`,按「项目 × 用户」存在文档服务),离线重连与 0.7.20 的撤销冲突共用。
 * 「同步已暂停」(离线批次算不出逐项差异、退回整份处理)这种少见情形仍在这里给整份「合并 / 删除全部」。
 */
export function useConflicts(): { pending: boolean; queued: number; conflicts: number } {
  const c = useMergeCounts();
  const paused = useSync((v) => (v.status === "paused" ? v.paused : null));
  if (c.total) return { pending: true, queued: c.total, conflicts: c.conflicts };
  if (paused) return { pending: true, queued: paused.queued, conflicts: pausedSummary().reduce((n, s) => n + s.what.length, 0) };
  return { pending: false, queued: 0, conflicts: 0 };
}

export function conflictBarText(c: { queued: number; conflicts: number }): string {
  return mergeBarText({ total: c.queued, conflicts: c.conflicts });
}

export function ConflictSheet(props: { onClose: () => void }) {
  const paused = useSync((v) => v.status === "paused" && !!v.paused);
  const m = useConflictMerge();
  const close = () => { setOfflineOpen(false); setMergeOpen(false); props.onClose(); };
  if (paused && !m.hasItems) return <PausedSheet onClose={close} done={props.onClose} />;
  return (
    <Sheet id="conflict" title="冲突合并" onClose={close} foot={
      <div className="cf-foot">
        {m.hasItems && <>
          <button type="button" className="btn primary" data-pcm="cf-merge" disabled={!m.selected || !m.online} onClick={m.merge}>合并</button>
          <button type="button" className="btn" data-pcm="cf-drop" disabled={!m.selected} onClick={m.remove}>删除选中</button>
        </>}
        <button type="button" className="btn" data-pcm="cf-close" onClick={close}>{m.hasItems ? "下次再说" : "完成"}</button>
      </div>
    }>
      {!m.hasItems ? <div className="hint" style={{ textAlign: "center", padding: "30px 0" }}>全部处理完了 ✓</div> : <>
        <div className="hint" data-pcm="cf-summary">{mergeBarText(m.counts)}。勾选要处理的项，可以逐项勾。</div>
        <div className="cf-top">
          <button type="button" className="btn" data-pcm="cf-select-clean" onClick={m.selectNonConflict}>选中无冲突项</button>
          <button type="button" className="btn" data-pcm="cf-clear" onClick={m.clearAll}>取消全部勾选</button>
        </div>
        {m.rows.map((row) => {
          const state = m.check(row);
          return (
            <div key={row.key} className="cf-group" data-pcm="cf-thing" data-key={row.key}>
              <div className="cf-head">
                <label><input type="checkbox" aria-label={`勾选${row.label}`} checked={state === "all"} ref={(el) => { if (el) el.indeterminate = state === "some"; }} onChange={() => m.toggleThing(row)} /></label>
                <span className="nm">{row.label}<small className="cf-kind">{row.changeText}</small></span>
                {row.conflict ? <span className="chip warn">有冲突</span> : <span className="chip">无冲突</span>}
              </div>
              <div className="cf-sub">
                {row.props.map((p) => (
                  <label key={p.prop} className={p.conflict ? "is-conflict" : undefined} data-pcm="cf-prop">
                    <input type="checkbox" checked={!!m.sel.get(row.key)?.has(p.prop)} onChange={() => m.toggleProp(row, p.prop)} />
                    <span>{p.text}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
        {m.blocked && <div className="hint cf-warn" data-pcm="cf-blocked">{mergeBlockedText(m.blocked)}</div>}
        {!m.online && <div className="hint cf-warn" data-pcm="cf-offline">当前离线：可以先「删除选中」，连上后再「合并」。</div>}
        {m.note && <div className="hint" role="status" data-pcm="cf-note">{m.note}</div>}
      </>}
    </Sheet>
  );
}

/** 离线批次算不出逐项差异时的退路:整份「合并」(重放)或「删除全部」(丢弃,先存本地备份) */
function PausedSheet(props: { onClose: () => void; done: () => void }) {
  const summary = pausedSummary();
  const queued = useSync((v) => v.paused?.queued ?? 0);
  return (
    <Sheet id="conflict" title="冲突合并" onClose={props.onClose} foot={
      <div className="cf-foot">
        <button type="button" className="btn primary" data-pcm="cf-merge" onClick={() => { replayOffline(); props.done(); }}>合并</button>
        <button type="button" className="btn" data-pcm="cf-drop" onClick={() => { discardOffline(); props.done(); }}>删除全部</button>
        <button type="button" className="btn" data-pcm="cf-close" onClick={props.onClose}>下次再说</button>
      </div>
    }>
      <div className="hint">你有 {queued} 步断网期间的修改。这段时间项目有以下改动，可能会和你的修改重叠：</div>
      {summary.map((s, i) => (
        <div key={i} className="cf-group">
          <div className="cf-head"><span className="nm">{s.who}</span>{s.what.length ? <span className="chip warn">有冲突</span> : <span className="chip">无冲突</span>}</div>
          <div className="cf-sub">{s.what.length ? s.what.map((w, j) => <span key={j}>{w}</span>) : <span>（没有列出具体位置）</span>}</div>
        </div>
      ))}
    </Sheet>
  );
}

/* ======================== 成员 ======================== */

export function MembersSheet(props: { info: MembersInfo; onClose: () => void }) {
  const toast = useToast();
  const { info } = props;
  const link = currentAccountProjectLink() ?? currentSharedUrl();
  const [deciding, setDeciding] = useState<string | null>(null);
  /** 「通过」「拒绝」没收到回包时,再点沿用原请求号;收到结论就丢掉(`src/account/requestIds.ts`,与桌面共用) */
  const decisionIds = useRef(createRequestIds());
  // 申请加入(2026-10-22 用户定):创建者在成员面板里「通过」「拒绝」;服务端只认创建者本人,通过那一刻现核禁入与申请还在不在
  const decide = async (op: "approve-join" | "reject-join", row: AccountJoinRequestRow) => {
    const name = row.accountName ?? row.accountId;
    setDeciding(row.joinRequestId);
    try {
      await decisionIds.current.run(`${op}:${row.joinRequestId}`, (requestId) =>
        accountMemberAdmin({ op, accountId: row.accountId, joinRequestId: row.joinRequestId, requestId }));
      toast(op === "approve-join" ? JOIN_REQUEST_TEXT.approvedToast(name) : JOIN_REQUEST_TEXT.rejectedToast(name));
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : "暂时无法处理这条申请，请重试。");
    } finally { setDeciding(null); info.refresh(); }
  };
  return (
    <Sheet id="members" title={info.unavailable ? "成员" : `成员：${info.people} 人 · Agent：${info.agents} 个`} onClose={props.onClose}>
      {info.unavailable && <div className="hint">暂时无法获取项目成员。</div>}
      {info.requests.length > 0 && <div data-pcm="join-requests">
        <h2 className="sec" style={{ marginTop: 0 }}>{JOIN_REQUEST_TEXT.requestsTitle(info.requests.length)}</h2>
        {info.requests.map((row) => (
          <div key={row.joinRequestId} className="list-row" data-pcm="join-request-row" data-account-id={row.accountId}>
            <div className="i"><Icon name="person" /></div>
            <div className="grow"><b>{row.accountName ?? row.accountId}</b><div className="hint" style={{ margin: 0 }}>{requestedAtText(row.createdAt)}</div></div>
            <button type="button" className="btn primary" style={{ height: 32, padding: "0 12px" }} data-pcm="join-request-approve" disabled={deciding !== null}
              onClick={() => void decide("approve-join", row)}>{JOIN_REQUEST_TEXT.approve}</button>
            <button type="button" className="btn" style={{ height: 32, padding: "0 12px" }} data-pcm="join-request-reject" disabled={deciding !== null}
              onClick={() => void decide("reject-join", row)}>{JOIN_REQUEST_TEXT.reject}</button>
          </div>
        ))}
        <h2 className="sec">项目成员</h2>
      </div>}
      {info.lines.map((l) => (
        <div key={l.key} className="list-row" data-pcm="member-row">
          <div className={l.agent ? "i plum" : "i"}><Icon name={l.agent ? "card" : "person"} /></div>
          <div className="grow"><b>{l.name}{l.creator ? "（创建者）" : ""}</b><div className="hint" style={{ margin: 0 }}>{l.sub}</div></div>
          {l.agent ? <span className="chip plum">{l.sub === "云端" ? "云端" : "Agent"}</span> : <i className={l.online ? "dot" : "dot off"} />}
        </div>
      ))}
      {link && <button type="button" className="btn" style={{ width: "100%", marginTop: 6 }} data-pcm="copy-link" onClick={() => {
        void navigator.clipboard?.writeText(link).then(() => toast("项目链接已复制"), () => toast(link));
      }}>复制项目链接</button>}
    </Sheet>
  );
}

/* ======================== 导出 ======================== */

interface ExportRun { phase: "running" | "done" | "error" | "cancelled"; done: number; total: number; stage?: string; waiting?: string; message?: string; id?: string }

/** 和桌面顶栏的「导出视频」同一条路(`TopBar.tsx` 的 `exportProject`,在线页面那一支):先选方式,再选保存位置,浏览器里逐帧导出 */
export function ExportSheet(props: { onClose: () => void }) {
  const [run, setRun] = useState<ExportRun | null>(null);
  const idRef = useRef<string | null>(null);
  const start = async (mode: ExportMode) => {
    const project = getState().project;
    const pending = exportGateNow(project);
    if (pending && pending.length) { setRun({ phase: "error", done: 0, total: 1, message: awaitingUploaderMessage(pending) }); return; }
    let target: FileSystemFileHandle | null = null;
    try {
      target = await pickSaveTarget(`${project.name}.mp4`, "MP4 视频", { "video/mp4": [".mp4"] });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setRun({ phase: "error", done: 0, total: 1, message: (e as Error).message });
      return;
    }
    setRun({ phase: "running", done: 0, total: Math.max(1, Math.floor(project.duration * (project.fps || 30))) });
    try {
      const { id, written, skippedMedia } = await exportVideo({
        target, mode,
        onWaiting: (message) => setRun((s) => (s ? { ...s, waiting: message ?? undefined } : s)),
        onStart: (jobId) => { idRef.current = jobId; setRun((s) => (s ? { ...s, id: jobId } : s)); },
        onProgress: (done, total, stage) => setRun((s) => (s && s.phase === "running" ? { ...s, done, total, stage } : s)),
      });
      if (target && !written) {
        const w = await target.createWritable();
        try { await streamExportFile(id, "preview.mp4", w); await w.close(); } catch (error) { await w.abort?.(); throw error; }
      }
      const note = skippedMedia?.length ? exportSkippedMessage(skippedMedia) : "";
      setRun((s) => (s ? { ...s, phase: "done", done: s.total, message: note || (target ? `已保存为 ${target.name}` : "已存到浏览器的下载位置") } : s));
    } catch (e) {
      const err = e as Error & { cancelled?: boolean };
      setRun((s) => (s ? { ...s, phase: err.cancelled ? "cancelled" : "error", message: err.message } : s));
    } finally {
      idRef.current = null;
    }
  };
  const pct = run && run.total > 0 ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0;
  return (
    <Sheet id="export" title="导出" onClose={() => { if (run?.phase !== "running") props.onClose(); }}>
      {(!run || run.phase !== "running") && ([["fast", ONLINE_EXPORT_TEXT.fast, ONLINE_EXPORT_TEXT.fastHint], ["full", ONLINE_EXPORT_TEXT.full, ONLINE_EXPORT_TEXT.fullHint]] as const).map(([mode, name, hint]) => (
        <div key={mode} className="row">
          <div className="t">{name}<small>{hint}</small></div>
          <button type="button" className="btn primary" data-pcm="export-start" data-mode={mode} onClick={() => void start(mode)}>开始</button>
        </div>
      ))}
      {run && (
        <div data-pcm="export-progress" data-phase={run.phase}>
          {run.phase === "running" && <div className="bar"><i style={{ width: `${pct}%` }} /></div>}
          <div className="hint">
            {run.phase === "running" ? (run.waiting ?? `${run.stage === "sound" ? "生成声音" : "渲染中"} ${pct}%…`)
              : run.phase === "done" ? `完成 · ${run.message ?? ""}` : run.phase === "cancelled" ? "已取消导出" : `导出失败：${run.message ?? ""}`}
          </div>
          {run.phase === "running" && <button type="button" className="btn" style={{ width: "100%" }} onClick={() => { if (idRef.current) void cancelExport(idRef.current); }}>取消导出</button>}
        </div>
      )}
    </Sheet>
  );
}


