import { AudioWaveform } from "./AudioWaveform";
import { ClipVolumeDialog } from "./ClipVolumeDialog";
import { ClipMuteBadge, clipMuteReason, reportClipAudioResult } from "./ClipMuteBadge";
import { clipHasAudio, clipHasEmbeddedAudio } from "../../kernel/cardAudioRendition.mjs";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useTimelineContext } from "./TimelineContext";
import { actions, useStore, getState } from "../../store/project";
import { cardRunStatesGen, getCard, knownCardName, onCardRunStatesChanged, onSyncedUserCardsChanged, syncedCardView, syncedUserCardsGen } from "../../kernel/registry";
import { clipSubtitleOf, paramsCardView } from "../left/paramsView";
import { clipCardLabel } from "./localPcBadge";
import { onlinePage, onlineUnsupported } from "../../online/pageFlag";
import { snapTime, isOccupied, getGap, xOfTime, formatTime, ROW_SIZE_H } from "./utils";
import { BAND_H, OVERLAY_KIND_NAME, overlayGlyph, overlaysOfClip, planClipLayout, type OverlayItem } from "./overlays";
import { OverlayBand, OverlayPill } from "./OverlayBand";
import { detachOverlay, overlayQuoteId, setOverlayOff } from "./overlayActions";
import type { ContextMenuItem } from "./types";
import { requestQuote } from "../quoteBus";
import { ShotMarkers } from "./ShotMarkers";
import { TrackClip, Track } from "../../kernel/project";
import { useDrag } from "./useDrag";
import { useUserEditing } from "../userEditing";
import { ContextMenu } from "./ContextMenu";
import { clipTrackKind } from "../../kernel/trackKind";
import { describeTransition, timingLock, transitionsOfClip } from "../../kernel/transitions";
import { describeEmphasis } from "../../kernel/emphasis";
import { requestCaptions } from "../left/captionsBus";
import { CaptionLines } from "./CaptionLines";
import { captionsOf, isCaptionClip } from "../../kernel/captions";
import { cutDuration } from "../../kernel/cutSegments";
import { clipSpeed, isSpeedChanged, speedLabel } from "../../kernel/clipTime.mjs";
import { openCutInTimeline } from "./CutTabs";
import { useReadOnly } from "../readOnly";

export function ClipView({ clip, track }: { clip: TrackClip; track: Track }) {
  const [volumeOpen, setVolumeOpen] = useState(false);
  // 这个项目只给了只读权限(游客):拖、改时长、右键里改项目的项都不给,和锁定的序列一个待遇(但还能选中、看参数、打开剪辑)
  const ro = useReadOnly();
  const frozen = track.locked || ro.locked;
  const { pxPerSec, trackAreaRef, setDraggingClipId, setDraggingTrackId, rowSize, quoteClip, quoteOverlay } = useTimelineContext();
  const media = useStore((s) => s.project.media.find((m) => m.id === clip.mediaId));
  const selection = useStore((s) => s.selection);
  const isSelected = selection.includes(clip.id);
  // 副标题看的参数视图:先查定义,没有再看同步来的用户卡的只读视图(源码里解析出的默认值与控件)
  const paramsView = clip.cardId ? paramsCardView(clip.cardId, { getCard, syncedCardView }) : undefined;
  // 同步来的用户卡(在线页面从内容库卡片源码认出来的)表变了要重绘:标签换成真名
  useSyncExternalStore(onSyncedUserCardsChanged, syncedUserCardsGen);
  // 同步来的卡的运行状态变了也重绘(标签、轻重跟着它)
  useSyncExternalStore(onCardRunStatesChanged, cardRunStatesGen);
  // 标签:构建时定义的名字 → 同步表里的名字 →「未知卡片」(C10 契约第 9 节)
  // 剪辑段(kernel/cutSegments.ts):标签跟着被引用剪辑现在的名字走;找不到(悬空引用)就写明
  const cutName = useStore((s) => (clip.cutId ? s.project.cuts?.find((c) => c.id === clip.cutId)?.name ?? null : null));
  const cutTotal = useStore((s) => (clip.cutId ? cutDuration(s.project, clip.cutId) : 0));
  const label = clip.cutId ? (cutName ? `剪辑 · ${cutName}` : "剪辑 · (已不存在)") : clip.cardId ? clipCardLabel(knownCardName(clip.cardId)) : clip.label;
  // 变速的视频段:名字后面带上倍数(kernel/clipTime.mjs),一眼看得出这段改过速度
  const shownLabel = isSpeedChanged(clip) && clip.mediaId ? `${label ?? ""} · ${speedLabel(clipSpeed(clip))}` : label;
  // 这台设备跑不了的卡不挂任何「本地 PC 辅助渲染」的徽标(2026-10-21 用户定:没有这种情况;画面由渲染节点出)
  // 按素材类型上色:文字 / 视频 / 转场… 各一档,一眼读得出片段是什么
  const trackKind = clipTrackKind(clip, (id) => getState().project.media.find((m) => m.id === id));
  // 这一段是不是「有画面的素材」:只有它能转成声音(卡片、图片、已经是声音的都不行)
  const canBecomeAudio = !!clip.mediaId && getState().project.media.find((m) => m.id === clip.mediaId)?.kind === "video";
  const embeddedAudio = clipHasEmbeddedAudio(getState().project, clip, getCard);
  const hasAudio = clipHasAudio(getState().project, clip, getCard);
  const muteReason = clipMuteReason(clip, track, getState().project);
  const selectedAudioIds = selection.includes(clip.id) ? selection : [clip.id];
  const reportAudio = (result: { ok: boolean; error?: string }) => reportClipAudioResult(result, message => window.alert(message));

  // 字幕卡不走「标题 + 副标题」那一套:它的内容是一条条字幕,直接在色块里画出来
  const isCaption = isCaptionClip(clip);
  const capCount = useMemo(() => (isCaption ? captionsOf(clip).length : 0), [isCaption, clip.params?.lines]);

  let subtitle = "";
  if (isCaption) {
    subtitle = capCount > 0 ? `${capCount} 条字幕` : "还没有字幕,右键素材去转写";
  } else if (clip.cardId && paramsView) {
    // 第一个文字控件的值 → 卡片说明;同步来的用户卡(在线页面没有定义)用源码里解析出的视图
    subtitle = clipSubtitleOf(paramsView, clip.params);
  } else if (clip.mediaId) {
    subtitle = "时长 " + formatTime(clip.end - clip.start);
  } else if (clip.cutId) {
    subtitle = `${(clip.cutOffset ?? 0) > 0 ? `从 ${formatTime(clip.cutOffset ?? 0)} 起 · ` : ""}时长 ${formatTime(clip.end - clip.start)} · 双击打开`;
  }
  // 被引用剪辑事后变短:超出它总时长的那一截透明无声(段的起止不动),斜线标出来
  const cutOverSec = clip.cutId && cutName ? Math.max(0, (clip.end - clip.start) - Math.max(0, cutTotal - (clip.cutOffset ?? 0))) : 0;

  // 挂在这段上的转场:画出淡化区间、右键能删,而且它锁着这段的时间关系(单独拖会被 store 挡回来,整组一起走)
  const allTransitions = useStore((s) => s.project.transitions);
  const myTransitions = useMemo(() => transitionsOfClip(getState().project, clip.id), [allTransitions, clip.id]);
  const lock = myTransitions.length > 0 ? timingLock(getState().project, clip.id) : null;

  // 挂在这一段上的东西(滤镜、像素映射、音频效果、素材效果卡)收成一张清单,带和菜单都只认它
  const filterLib = useStore((s) => s.project.filters);
  const pixelMapLib = useStore((s) => s.project.pixelMaps);
  const audioFxLib = useStore((s) => s.project.audioFx);
  const nodeLib = useStore((s) => s.project.cardNodes);
  const overlays = useMemo(
    () => overlaysOfClip(getState().project, clip, { cardName: (id) => knownCardName(id) ?? undefined }),
    [filterLib, pixelMapLib, audioFxLib, nodeLib, clip.filter, clip.pixelMap, clip.audioFx, clip.nodeId],
  );

  const [dragState, setDragState] = useState<{ start: number; end: number; trackId: string; forbidden: boolean } | null>(null);
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; items?: ContextMenuItem[]; head?: { title: string; of?: string; trackKind?: string } | null } | null
  >(null);

  // 拖动 / 改时长中:告诉 Agent 用户正在编辑这一段(A2;真的动起来才算,只点一下不算)
  useUserEditing(`timeline-clip:${clip.id}`, dragState ? clip.id : null, "drag");

  const displayStart = dragState ? dragState.start : clip.start;
  const displayEnd = dragState ? dragState.end : clip.end;

  const dragRef = useDrag(
    (e) => {
      // 只读:点一下照样能选中(要看参数),但不开始拖
      if (ro.locked && !track.locked) {
        if (!e.shiftKey) {
          if (!selection.includes(clip.id)) actions.select([clip.id]);
        } else {
          actions.select([...selection, clip.id]);
        }
        return;
      }
      if (track.locked) return;
      if (!e.shiftKey) {
        if (!selection.includes(clip.id)) actions.select([clip.id]);
      } else {
        actions.select([...selection, clip.id]);
      }
      setDraggingClipId(clip.id);
      setDraggingTrackId(track.id);
    },
    (e, delta, rawEvent) => {
      if (frozen) return;
      const state = getState();
      const tDelta = delta.x / pxPerSec;
      const originalDur = clip.end - clip.start;
      
      let newStartRaw = clip.start + tDelta;
      let newStart = snapTime(newStartRaw, rawEvent.altKey, state.project, state.t, clip.id, pxPerSec);
      let newEnd = newStart + originalDur;

      let newTrackId = track.id;
      if (trackAreaRef.current) {
        const elements = document.elementsFromPoint(rawEvent.clientX, rawEvent.clientY);
        const row = elements.find((el) => el.hasAttribute("data-track-id"));
        if (row) {
          const hoverTrackId = row.getAttribute("data-track-id")!;
          const hoverTrack = state.project.tracks.find((t) => t.id === hoverTrackId);
          if (hoverTrack && !hoverTrack.locked) {
            newTrackId = hoverTrackId;
          }
        }
      }

      setDraggingTrackId(newTrackId);

      let forbidden = false;
      if (newTrackId !== track.id) {
        const targetTrack = state.project.tracks.find((t) => t.id === newTrackId);
        if (targetTrack) {
          forbidden = isOccupied(targetTrack, clip.id, newStart, newEnd);
        }
      } else {
        const gap = getGap(track, clip.id, Math.max(state.project.duration, 10000));
        if (newStart < gap.start) {
          newStart = gap.start;
          newEnd = newStart + originalDur;
        }
        if (newEnd > gap.end) {
          newEnd = gap.end;
          newStart = newEnd - originalDur;
        }
      }

      setDragState({ start: newStart, end: newEnd, trackId: newTrackId, forbidden });
    },
    (e) => {
      if (frozen) return;
      setDraggingClipId(null);
      setDraggingTrackId(null);
      setDragState((prev) => {
        if (prev) {
          if (!prev.forbidden) {
            actions.moveClip(clip.id, { start: prev.start, end: prev.end, trackId: prev.trackId });
          }
        }
        return null;
      });
    }
  );

  const resizeLeftRef = useDrag(
    (e) => {
      if (frozen) return;
      e.stopPropagation();
    },
    (e, delta, rawEvent) => {
      if (frozen) return;
      const state = getState();
      const tDelta = delta.x / pxPerSec;
      const newStartRaw = clip.start + tDelta;
      let newStart = snapTime(newStartRaw, rawEvent.altKey, state.project, state.t, clip.id, pxPerSec);
      
      const gap = getGap(track, clip.id, Math.max(state.project.duration, 10000));
      newStart = Math.max(gap.start, Math.min(newStart, clip.end - 0.1));
      
      setDragState({ start: newStart, end: clip.end, trackId: track.id, forbidden: false });
    },
    () => {
      if (frozen) return;
      setDragState((prev) => {
        if (prev) actions.moveClip(clip.id, { start: prev.start, end: prev.end });
        return null;
      });
    }
  );

  const resizeRightRef = useDrag(
    (e) => {
      if (frozen) return;
      e.stopPropagation();
    },
    (e, delta, rawEvent) => {
      if (frozen) return;
      const state = getState();
      const tDelta = delta.x / pxPerSec;
      const newEndRaw = clip.end + tDelta;
      let newEnd = snapTime(newEndRaw, rawEvent.altKey, state.project, state.t, clip.id, pxPerSec);
      
      const gap = getGap(track, clip.id, Math.max(state.project.duration, 10000));
      newEnd = Math.min(gap.end, Math.max(newEnd, clip.start + 0.1));
      
      setDragState({ start: clip.start, end: newEnd, trackId: track.id, forbidden: false });
    },
    () => {
      if (frozen) return;
      setDragState((prev) => {
        if (prev) actions.moveClip(clip.id, { start: prev.start, end: prev.end });
        return null;
      });
    }
  );

  const handleContextMenu = (e: React.MouseEvent) => {
    if (track.locked && !ro.locked) return;
    e.preventDefault();
    e.stopPropagation();
    if (!selection.includes(clip.id)) actions.select([clip.id]);
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  // 只读项目里右键只给不改项目的项:已有字幕的素材段能查看字幕;最后一行灰着,说明为什么别的都没有
  const readOnlyItems = (() => {
    const m = clip.mediaId ? getState().project.media.find((x) => x.id === clip.mediaId) : null;
    return [
      ...(m && m.kind !== "image" && m.transcript
        ? [{ label: `查看字幕(${m.transcript.segments.length} 段)`, action: () => requestCaptions(m.id) }]
        : []),
      { label: ro.why, disabled: true, action: () => {} },
    ];
  })();

  const isCrossTrackDrag = dragState && dragState.trackId !== track.id;

  /* ── 叠加卡:带怎么画、菜单里有什么 ────────────────────────────────── */
  const widthPx = (displayEnd - displayStart) * pxPerSec;
  const plan = planClipLayout(widthPx, rowSize, overlays.length);

  /** 停用 / 摘掉这两项:动作本身在 `overlayActions.ts`,手机版「调整」表单用的是同一份 */
  const lockNote = frozen ? { title: ro.locked ? ro.why : "这条序列锁着" } : null;
  const detachItem = (it: OverlayItem): ContextMenuItem =>
    it.canDetach
      ? {
          label: "摘掉",
          danger: true,
          disabled: frozen,
          ...lockNote,
          action: () => {
            // 素材效果卡要重接节点图,接不回去时 detachCardNode 抛出写明原因的话,原样给用户看
            try { detachOverlay(actions, clip, it, getCard); }
            catch (e) { window.alert(e instanceof Error ? e.message : String(e)); }
          },
        }
      : {
          label: "摘掉",
          danger: true,
          disabled: true,
          title: "这张卡不止一路输入、或者本身就是这一段的内容，接不回去；请在编辑分区的节点图里改",
          action: () => {},
        };

  /*
   * 「引用到输入框」两条路:
   * 氛围式的详细编辑自己有输入框,传 quoteClip / quoteOverlay 进来;
   * 传统式的输入框在右边的 AI 栏里(本机和云端两块),走 `editor/quoteBus.ts` 那条总线 ——
   * 预览右键「引用到 AI」用的就是它。两边写出来的引用块是同一份 `quoteToken`。
   */
  const quoteThisClip = () =>
    quoteClip ? quoteClip(clip, label || "片段") : requestQuote({ clipId: clip.id, label: label || "片段" });
  const quoteThisOverlay = (it: OverlayItem) =>
    quoteOverlay
      ? quoteOverlay(clip, it)
      : requestQuote({ clipId: overlayQuoteId(clip, it), label: it.name, kind: "叠加卡" });

  /**
   * 停用 / 启用:挂载和逐段参数都留着,只翻 `off` —— 调不出想要的效果时先关掉比一比,
   * 不用摘掉再回左栏的库里找回来重填参数。生不生效由各自的解析口判(kernel/filters.mjs 等)。
   * 素材效果卡是节点图里的一个节点,绕不过去,所以这一项对它置灰。
   */
  const toggleItem = (it: OverlayItem): ContextMenuItem =>
    it.canToggle
      ? {
          label: it.off ? "启用" : "停用",
          disabled: frozen,
          ...lockNote,
          action: () => setOverlayOff(actions, clip, it, !it.off),
        }
      : { label: "停用", disabled: true, title: "素材效果卡的停用要在编辑分区的节点图里改", action: () => {} };

  /** 这一张能做的事(菜单最里面那一级) */
  const overlayActions = (it: OverlayItem): ContextMenuItem[] => [
    { label: "引用到输入框", action: () => quoteThisOverlay(it) },
    { label: "改参数…", hint: it.value, action: () => actions.select([clip.id]) },
    toggleItem(it),
    detachItem(it),
  ];

  /** 这一段挂的全部(中间那一级) */
  const overlayList = (): ContextMenuItem[] =>
    overlays.length
      ? overlays.map((it) => ({
          label: `${overlayGlyph(it)} ${it.name}`,
          hint: it.off ? "已停用" : it.value,
          title: it.off ? `${OVERLAY_KIND_NAME[it.kind]}：已停用，这一段上不生效` : OVERLAY_KIND_NAME[it.kind],
          dim: it.off,
          action: () => {},
          sub: overlayActions(it),
        }))
      : [{ label: "这一段还没有挂东西", disabled: true, action: () => {} }];

  /*
   * 菜单头只在**自己就是整张菜单**的时候写:点带里某一张卡,那一张的菜单是孤零零弹出来的,
   * 头(填底、底色取那一段的轨道色)是「在动谁」的唯一凭据,而「摘掉」就在下面两行。
   * 从片段菜单一级一级走下来的那两级不写头 —— 上一级面板还在屏幕上,片段名、卡片名都看得见,
   * 再写一遍只是占一行(2026-10-24 用户定)。
   */
  const openOverlayList = (at: { x: number; y: number }) =>
    setContextMenu({ ...at, head: null, items: overlayList() });
  const openOverlayOne = (index: number, at: { x: number; y: number }) => {
    const it = overlays[index];
    if (!it) return;
    setContextMenu({ ...at, head: { title: it.name, of: label || "片段", trackKind }, items: overlayActions(it) });
  };

  const clipClasses = [
    ro.locked ? "is-readonly" : "",
    "pc-clip absolute top-1 bottom-1 rounded flex flex-col text-xs overflow-hidden select-none border",
    frozen ? "" : "cursor-pointer",
    isSelected ? "is-selected z-20" : "z-10",
    muteReason ? "is-audio-muted" : "",
    dragState?.forbidden ? "is-forbidden bg-red-500/50 border-red-500 border-dashed" : "",
  ].join(" ");

  // 计算跨轨拖动时的垂直偏移量，视觉上把色块移到目标轨道
  let translateY = 0;
  if (isCrossTrackDrag && trackAreaRef.current) {
     const targetTrackEl = trackAreaRef.current.querySelector(`[data-track-id="${dragState.trackId}"]`);
     const originalTrackEl = trackAreaRef.current.querySelector(`[data-track-id="${track.id}"]`);
     if (targetTrackEl && originalTrackEl) {
        translateY = targetTrackEl.getBoundingClientRect().top - originalTrackEl.getBoundingClientRect().top;
     }
  }

  return (
    <>
      <div
        ref={dragRef}
        data-clip-id={clip.id}
        data-track-kind={clip.cutId ? "video" : trackKind}
        data-pc-cut-segment={clip.cutId ? clip.cutId : undefined}
        data-audio-muted={muteReason ? "true" : undefined}
        aria-label={muteReason ? `${label || "片段"}，${muteReason}` : undefined}
        title={muteReason ? `${label || "片段"}：${muteReason}` : undefined}
        className={clipClasses}
        style={{
          left: `${xOfTime(displayStart, pxPerSec)}px`,
          width: `${(displayEnd - displayStart) * pxPerSec}px`,
          transform: `translateY(${translateY}px)`,
          transition: dragState ? 'none' : 'width 0.1s, left 0.1s',
        }}
        onContextMenu={handleContextMenu}
        // 剪辑段:双击在时间轴上方打开被引用的剪辑(Argon 审核意见决定 3 补充)
        onDoubleClick={clip.cutId && cutName ? (e) => { e.stopPropagation(); openCutInTimeline(clip.cutId!); } : undefined}
      >
        <div
          ref={resizeLeftRef}
          className={`absolute left-0 top-0 bottom-0 w-2 z-30 ${frozen ? "" : "cursor-col-resize pc-clip-trim"}`}
        />
        
        {/* 叠加带:这一格每个片段都留着(小行高那一档不画),没挂东西时透明 —— 只给挂了东西的片段留,
            同一行里的名字会一高一低。见 overlays.ts 文件头 */}
        {plan.band && (
          <OverlayBand
            items={overlays}
            rowSize={rowSize}
            avail={plan.bandAvail}
            countOnly={plan.countOnly}
            frozen={frozen}
            onOpenOne={openOverlayOne}
            onOpenAll={openOverlayList}
          />
        )}
        {isCaption && capCount > 0 ? (
          // 字幕卡:色块里画出一条条字幕,点它跳过去、拖它挪时间、双击改字
          <CaptionLines clip={clip} height={ROW_SIZE_H[rowSize] - (plan.band ? BAND_H[rowSize] : 0)} />
        ) : (
          // 名字和时长排同一行:分两行的话,中行高扣掉叠加带只剩 23px,两行放不下、标题会被切掉上半截
          <div className="pc-clip-body">
            {plan.name && (
              <span className="pc-clip-line" data-pc-clip-speed={isSpeedChanged(clip) ? clipSpeed(clip) : undefined}>
                <span className="nm">{shownLabel}</span>
                {plan.duration && subtitle ? <span className="du">{` · ${subtitle}`}</span> : null}
              </span>
            )}
            {plan.pill && overlays.length > 0 && <OverlayPill count={overlays.length} onOpenAll={openOverlayList} />}
          </div>
        )}
        
        {media && media.kind !== "image" && <AudioWaveform media={media} clip={clip} width={(displayEnd - displayStart) * pxPerSec} />}
        {/* 转场:两端的淡化区间铺一层渐变,成组的再挂一个链条角标 —— 一眼看出这段被绑着 */}
        {(clip.fadeIn ?? 0) > 0 && (
          <div className="pc-clip-fade is-in" style={{ width: (clip.fadeIn ?? 0) * pxPerSec }} aria-hidden="true" />
        )}
        {(clip.fadeOut ?? 0) > 0 && (
          <div className="pc-clip-fade is-out" style={{ width: (clip.fadeOut ?? 0) * pxPerSec }} aria-hidden="true" />
        )}
        {cutOverSec > 0.01 && (
          <div className="pc-clip-cut-over" style={{ width: cutOverSec * pxPerSec }} title="被引用的剪辑变短了:这一截透明、无声" aria-hidden="true" />
        )}
        {lock && (
          <span className="pc-clip-link" title={lock.message}>
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4.6 7.4L7.4 4.6M5 2.6l.9-.9a2.3 2.3 0 013.3 3.3l-.9.9M7 9.4l-.9.9a2.3 2.3 0 01-3.3-3.3l.9-.9" />
            </svg>
          </span>
        )}

        {muteReason && (displayEnd - displayStart) * pxPerSec >= 76 && <ClipMuteBadge reason={muteReason} label={label} />}

        {/* 镜头切换标记画在文字之上、把手之下:把手要能拖，标记只是看的 */}
        <ShotMarkers clip={clip} rowHeight={ROW_SIZE_H[rowSize]} />

        <div
          ref={resizeRightRef}
          className={`absolute right-0 top-0 bottom-0 w-2 z-30 ${frozen ? "" : "cursor-col-resize pc-clip-trim"}`}
        />
      </div>

      {muteReason && (displayEnd - displayStart) * pxPerSec < 76 && <ClipMuteBadge reason={muteReason} label={label} compact
        style={{ left: xOfTime(displayStart, pxPerSec) + Math.max(0, ((displayEnd - displayStart) * pxPerSec - 18) / 2), top: 5, right: "auto", transform: `translateY(${translateY}px)`, zIndex: 25 }} />}

      {volumeOpen && <ClipVolumeDialog clip={clip} track={track} onClose={() => setVolumeOpen(false)} />}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          // 带里点出来的菜单自带头和条目(叠加卡那一支);右键片段走下面这份
          head={contextMenu.head === undefined ? { title: label || "片段" } : contextMenu.head ?? undefined}
          onClose={() => setContextMenu(null)}
          items={contextMenu.items ?? [
            /*
             * 「引用到输入框」放最上面,而且**只读也给** —— 它不改任何东西,只是把这一段说给 Agent 听,
             * 恰恰是只读成员唯一能做的事。氛围式进 DetailEdit 的输入框,传统式进右边 AI 栏(quoteBus)。
             */
            { label: "引用到输入框", action: quoteThisClip },
            ...(ro.locked ? readOnlyItems : [
            // 转场在最上面:被绑住的时候用户第一件想做的事就是解开它
            ...myTransitions.map((tr) => ({
              label: `删除转场:${describeTransition(getState().project, tr)}`,
              action: () => actions.removeTransition(tr.id),
            })),
            ...(clip.emphasis
              ? [{ label: `去掉强调:${describeEmphasis(clip.emphasis)}`, action: () => actions.setClipEmphasis(clip.id, null) }]
              : []),
            ...(clip.cutId && cutName ? [{ label: `打开剪辑「${cutName}」`, action: () => openCutInTimeline(clip.cutId!) }] : []),
            // 叠加卡在这里只占一项:停上去才列出这一段挂的全部,再停一张才是它能做的事
            {
              label: "叠加卡",
              hint: overlays.length ? `${overlays.length} 张` : "还没有",
              action: () => {},
              sub: overlayList(),
            },
            { label: "复制", action: () => actions.duplicateClip(clip.id) },
            ...(hasAudio ? [
              { label: clip.audioMuted ? "恢复片段声音" : "静音片段", disabled: !!track.locked, action: () => reportAudio(actions.setClipMuted(clip.id, !clip.audioMuted)) },
              { label: "调整声音音量…", disabled: !!track.locked, action: () => setVolumeOpen(true) },
            ] : []),
            // 只要声音:画面没了,位置、长度、素材内偏移、淡入淡出都留着;素材库里同时多一份声音素材
            ...(canBecomeAudio || embeddedAudio ? [{ label: selectedAudioIds.length > 1 ? `分离所选音轨（${selectedAudioIds.length} 段）` : "音画分离", disabled: !!track.locked,
              action: () => reportAudio(actions.separateAudios(selectedAudioIds)) }] : []),
            ...(canBecomeAudio && !embeddedAudio ? [{ label: "转换为声音", action: () => reportAudio(actions.convertClipToAudio(clip.id)) }] : []),
            // 有声音的素材段可以直接去转写(图片没有声音,不给这一项)
            ...(() => {
              const media = clip.mediaId ? getState().project.media.find((m) => m.id === clip.mediaId) : null;
              if (!media || media.kind === "image") return [];
              return [{
                label: media.transcript ? `查看字幕(${media.transcript.segments.length} 段)` : "转写字幕",
                action: () => requestCaptions(media.id),
                // 在线浏览器模式没有语音识别(C10 契约第 10 节):只能转写的置灰,已有字幕的照常查看
                ...(!media.transcript && onlinePage() ? { disabled: true, title: onlineUnsupported("语音识别") } : {}),
              }];
            })(),
            {
              label: lock ? "在播放头处分割(先删转场)" : "在播放头处分割",
              action: () => actions.splitClip(clip.id, getState().t),
              disabled: !!lock || getState().t <= clip.start || getState().t >= clip.end,
            },
            {
              label: "置顶",
              action: () => {
                const tracks = getState().project.tracks;
                // 最上面那条序列就是最上层(和时间轴上看到的一致)
                if (tracks.length > 0) actions.moveClip(clip.id, { trackId: tracks[0].id });
              }
            },
            {
              label: "置底",
              action: () => {
                const tracks = getState().project.tracks;
                if (tracks.length > 0) actions.moveClip(clip.id, { trackId: tracks[tracks.length - 1].id });
              }
            },
            { label: "删除", action: () => actions.removeClip(clip.id) },
            ]),
          ]}
        />
      )}
    </>
  );
}
