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
import { onlinePage } from "../../online/pageFlag";
import { onlineUnsupported } from "../../online/onlineUnsupported";
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
import { tr as trText } from "../../i18n/index.ts";
import { OVERLAY_QUOTE_KIND } from "../../mobile/agentView";
import { shownName, shownNameOf } from "../../i18n/names.ts";

export function ClipView({ clip, track }: { clip: TrackClip; track: Track }) {
  const [volumeOpen, setVolumeOpen] = useState(false);
  // This project grants read-only access only (guest): no dragging, no duration changes, and no
  // project-modifying items in the right-click menu, the same treatment as a locked track (but it can
  // still be selected, its parameters viewed, and the cut opened)
  const ro = useReadOnly();
  const frozen = track.locked || ro.locked;
  const { pxPerSec, trackAreaRef, setDraggingClipId, setDraggingTrackId, rowSize, quoteClip, quoteOverlay } = useTimelineContext();
  const media = useStore((s) => s.project.media.find((m) => m.id === clip.mediaId));
  const selection = useStore((s) => s.selection);
  const isSelected = selection.includes(clip.id);
  // Parameter view for the subtitle: look up the definition first; if none, use the read-only view of the
  // synced user card (defaults and controls parsed from the source)
  const paramsView = clip.cardId ? paramsCardView(clip.cardId, { getCard, syncedCardView }) : undefined;
  // Redraw when the table of synced user cards (recognized by online pages from the content store card
  // source) changes: the label switches to the real name
  useSyncExternalStore(onSyncedUserCardsChanged, syncedUserCardsGen);
  // Also redraw when the runtime state of a synced card changes (label, light/heavy follow it)
  useSyncExternalStore(onCardRunStatesChanged, cardRunStatesGen);
  // Label: name defined at build time → name in the sync table → "Unknown card" (C10 contract, section 9)
  // Cut segment (kernel/cutSegments.ts): the label follows the current name of the referenced cut; if it
  // cannot be found (dangling reference), say so explicitly
  const cutName = useStore((s) => (clip.cutId ? s.project.cuts?.find((c) => c.id === clip.cutId)?.name ?? null : null));
  const cutTotal = useStore((s) => (clip.cutId ? cutDuration(s.project, clip.cutId) : 0));
  const label = clip.cutId ? (cutName ? trText("Cut · {0}", shownName(cutName)) : trText("Cut · (no longer exists)")) : clip.cardId ? clipCardLabel(shownNameOf(knownCardName(clip.cardId)) ?? null) : clip.label;
  // Speed-changed video clip: append the multiplier after the name (kernel/clipTime.mjs), so it is clear
  // at a glance that this clip's speed was changed
  const shownLabel = isSpeedChanged(clip) && clip.mediaId ? `${label ?? ""} · ${speedLabel(clipSpeed(clip))}` : label;
  // A card this device cannot run gets no "local PC assisted render" badge (user decision, 2026-10-21:
  // this case does not exist; the render node produces the picture)
  // Color by media type: text / video / transition... one tier each, so what the clip is reads at a glance
  const trackKind = clipTrackKind(clip, (id) => getState().project.media.find((m) => m.id === id));
  // Whether this clip is "media with picture": only it can be turned into sound (cards, images and
  // things that are already sound cannot)
  const canBecomeAudio = !!clip.mediaId && getState().project.media.find((m) => m.id === clip.mediaId)?.kind === "video";
  const embeddedAudio = clipHasEmbeddedAudio(getState().project, clip, getCard);
  const hasAudio = clipHasAudio(getState().project, clip, getCard);
  const muteReason = clipMuteReason(clip, track, getState().project);
  const selectedAudioIds = selection.includes(clip.id) ? selection : [clip.id];
  const reportAudio = (result: { ok: boolean; error?: string }) => reportClipAudioResult(result, message => window.alert(message));

  // A captions card does not use the "title + subtitle" scheme: its content is individual captions,
  // drawn directly in the color block
  const isCaption = isCaptionClip(clip);
  const capCount = useMemo(() => (isCaption ? captionsOf(clip).length : 0), [isCaption, clip.params?.lines]);

  let subtitle = "";
  if (isCaption) {
    subtitle = capCount > 0 ? trText("{0} captions", capCount) : trText("No captions yet, right-click the media to transcribe");
  } else if (clip.cardId && paramsView) {
    // Value of the first text control → card description; for a synced user card (no definition on online
    // pages) use the view parsed from the source
    subtitle = clipSubtitleOf(paramsView, clip.params);
  } else if (clip.mediaId) {
    subtitle = trText("Duration ") + formatTime(clip.end - clip.start);
  } else if (clip.cutId) {
    subtitle = trText("{0}Duration {1} · double-click to open", (clip.cutOffset ?? 0) > 0 ? trText("From {0} · ", formatTime(clip.cutOffset ?? 0)) : "", formatTime(clip.end - clip.start));
  }
  // The referenced cut later became shorter: the part beyond its total duration is transparent and silent
  // (the clip's start and end do not move), marked with diagonal lines
  const cutOverSec = clip.cutId && cutName ? Math.max(0, (clip.end - clip.start) - Math.max(0, cutTotal - (clip.cutOffset ?? 0))) : 0;

  // Transition attached to this segment: draws the fade interval, can be deleted by right-click, and it
  // locks this segment's timing relationship (dragging alone is blocked by the store; the whole group moves together)
  const allTransitions = useStore((s) => s.project.transitions);
  const myTransitions = useMemo(() => transitionsOfClip(getState().project, clip.id), [allTransitions, clip.id]);
  const lock = myTransitions.length > 0 ? timingLock(getState().project, clip.id) : null;

  // Everything attached to this segment (filters, pixel maps, audio effects, media effect cards) is
  // collected into one manifest; the strip and the menu both use only it
  const filterLib = useStore((s) => s.project.filters);
  const pixelMapLib = useStore((s) => s.project.pixelMaps);
  const audioFxLib = useStore((s) => s.project.audioFx);
  const nodeLib = useStore((s) => s.project.cardNodes);
  const overlays = useMemo(
    () => overlaysOfClip(getState().project, clip, { cardName: (id) => shownNameOf(knownCardName(id)) }),
    [filterLib, pixelMapLib, audioFxLib, nodeLib, clip.filter, clip.pixelMap, clip.audioFx, clip.nodeId],
  );

  const [dragState, setDragState] = useState<{ start: number; end: number; trackId: string; forbidden: boolean } | null>(null);
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; items?: ContextMenuItem[]; head?: { title: string; of?: string; trackKind?: string } | null } | null
  >(null);

  // During drag / duration change: tell the Agent the user is editing this segment (A2; counts only when
  // it really moves, a single click does not count)
  useUserEditing(`timeline-clip:${clip.id}`, dragState ? clip.id : null, "drag");

  const displayStart = dragState ? dragState.start : clip.start;
  const displayEnd = dragState ? dragState.end : clip.end;

  const dragRef = useDrag(
    (e) => {
      // Read-only: a click can still select it (to view parameters), but dragging does not start
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

  // In a read-only project the right-click menu offers only items that do not modify the project: a media
  // clip that already has captions can view them; the last row is greyed out and explains why nothing else is there
  const readOnlyItems = (() => {
    const m = clip.mediaId ? getState().project.media.find((x) => x.id === clip.mediaId) : null;
    return [
      ...(m && m.kind !== "image" && m.transcript
        ? [{ label: trText("View captions ({0} segments)", m.transcript.segments.length), action: () => requestCaptions(m.id) }]
        : []),
      { label: ro.why, disabled: true, action: () => {} },
    ];
  })();

  const isCrossTrackDrag = dragState && dragState.trackId !== track.id;

  /* ── Overlay cards: how the strip is drawn, what is in the menu ────────────────────────────────── */
  const widthPx = (displayEnd - displayStart) * pxPerSec;
  const plan = planClipLayout(widthPx, rowSize, overlays.length);

  /** Disable / remove these two items: the actions themselves are in `overlayActions.ts`, and the mobile app's "Adjust" form uses the same one */
  const lockNote = frozen ? { title: ro.locked ? ro.why : trText("This track is locked") } : null;
  const detachItem = (it: OverlayItem): ContextMenuItem =>
    it.canDetach
      ? {
          label: trText("Detach"),
          danger: true,
          disabled: frozen,
          ...lockNote,
          action: () => {
            // A media effect card needs its node graph rewired; when it cannot be reconnected, detachCardNode
            // throws with the reason spelled out, and it is shown to the user as is
            try { detachOverlay(actions, clip, it, getCard); }
            catch (e) { window.alert(e instanceof Error ? e.message : String(e)); }
          },
        }
      : {
          label: trText("Detach"),
          danger: true,
          disabled: true,
          title: trText("This card has more than one input, or is itself the content of this segment, so it cannot be reconnected; change it in the node graph of the edit section"),
          action: () => {},
        };

  /*
   * Two paths for "quote into the input box":
   * Vibe mode's detail editing has its own input box and is passed quoteClip / quoteOverlay;
   * Classic mode's input box is in the AI panel on the right (local and cloud, two of them) and goes
   * through the bus in `editor/quoteBus.ts` ——
   * the preview right-click "Quote to AI" uses it too. Both sides write the same `quoteToken` quote block.
   */
  const quoteThisClip = () =>
    quoteClip ? quoteClip(clip, label || trText("Clips")) : requestQuote({ clipId: clip.id, label: label || trText("Clips") });
  const quoteThisOverlay = (it: OverlayItem) =>
    quoteOverlay
      ? quoteOverlay(clip, it)
      : requestQuote({ clipId: overlayQuoteId(clip, it), label: it.name, kind: OVERLAY_QUOTE_KIND });

  /**
   * Disable / enable: the mount and the per-segment parameters are kept, only `off` is flipped. When you
   * cannot get the effect you want, turn it off first to compare, instead of removing it and finding it
   * again in the library in the left rail and refilling the parameters. Whether it takes effect is decided
   * by each resolver (kernel/filters.mjs etc.).
   * A media effect card is a node in the node graph and cannot be bypassed, so this item is greyed out for it.
   */
  const toggleItem = (it: OverlayItem): ContextMenuItem =>
    it.canToggle
      ? {
          label: it.off ? trText("Enable") : trText("Disable"),
          disabled: frozen,
          ...lockNote,
          action: () => setOverlayOff(actions, clip, it, !it.off),
        }
      : { label: trText("Disable"), disabled: true, title: trText("Disabling a media effect card is done in the node graph of the edit section"), action: () => {} };

  /** What can be done with this one (the innermost level of the menu) */
  const overlayActions = (it: OverlayItem): ContextMenuItem[] => [
    { label: trText("Quote into input box"), action: () => quoteThisOverlay(it) },
    { label: trText("Edit parameters…"), hint: it.value, action: () => actions.select([clip.id]) },
    toggleItem(it),
    detachItem(it),
  ];

  /** Everything attached to this segment (the middle level) */
  const overlayList = (): ContextMenuItem[] =>
    overlays.length
      ? overlays.map((it) => ({
          label: `${overlayGlyph(it)} ${it.name}`,
          hint: it.off ? trText("Disabled") : it.value,
          title: it.off ? trText("{0}: disabled, has no effect on this segment", OVERLAY_KIND_NAME[it.kind]) : OVERLAY_KIND_NAME[it.kind],
          dim: it.off,
          action: () => {},
          sub: overlayActions(it),
        }))
      : [{ label: trText("Nothing is attached to this segment yet"), disabled: true, action: () => {} }];

  /*
   * The menu header is written only when it **is the whole menu**: clicking a card in the strip pops up
   * that card's menu on its own, and the header (filled background, in the track color of that segment)
   * is the only evidence of "what is being changed", while "Remove" is two rows below.
   * The two levels reached step by step from the clip menu get no header: the panel of the previous level
   * is still on screen, and the clip name and card name are both visible,
   * writing them again just wastes a row (user decision, 2026-10-24).
   */
  const openOverlayList = (at: { x: number; y: number }) =>
    setContextMenu({ ...at, head: null, items: overlayList() });
  const openOverlayOne = (index: number, at: { x: number; y: number }) => {
    const it = overlays[index];
    if (!it) return;
    setContextMenu({ ...at, head: { title: it.name, of: label || trText("Clips"), trackKind }, items: overlayActions(it) });
  };

  const clipClasses = [
    ro.locked ? "is-readonly" : "",
    "pc-clip absolute top-1 bottom-1 rounded flex flex-col text-xs overflow-hidden select-none border",
    frozen ? "" : "cursor-pointer",
    isSelected ? "is-selected z-20" : "z-10",
    muteReason ? "is-audio-muted" : "",
    dragState?.forbidden ? "is-forbidden bg-red-500/50 border-red-500 border-dashed" : "",
  ].join(" ");

  // Compute the vertical offset during a cross-track drag, visually moving the block to the target track
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
        aria-label={muteReason ? trText("{0}, {1}", label || trText("Clips"), muteReason) : undefined}
        title={muteReason ? trText("{0}: {1}", label || trText("Clips"), muteReason) : undefined}
        className={clipClasses}
        style={{
          left: `${xOfTime(displayStart, pxPerSec)}px`,
          width: `${(displayEnd - displayStart) * pxPerSec}px`,
          transform: `translateY(${translateY}px)`,
          transition: dragState ? 'none' : 'width 0.1s, left 0.1s',
        }}
        onContextMenu={handleContextMenu}
        // Cut segment: double-click opens the referenced cut above the timeline (Argon review decision 3, addendum)
        onDoubleClick={clip.cutId && cutName ? (e) => { e.stopPropagation(); openCutInTimeline(clip.cutId!); } : undefined}
      >
        <div
          ref={resizeLeftRef}
          className={`absolute left-0 top-0 bottom-0 w-2 z-30 ${frozen ? "" : "cursor-col-resize pc-clip-trim"}`}
        />
        
        {/* Overlay strip: this slot is reserved for every clip (not drawn in the low row-height tier),
            transparent when nothing is attached: reserving it only for clips with attachments would make names
            in the same row vertically uneven. See overlays.ts file header */}
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
          // Captions card: individual captions are drawn in the block; click to jump there, drag to move the time, double-click to edit text
          <CaptionLines clip={clip} height={ROW_SIZE_H[rowSize] - (plan.band ? BAND_H[rowSize] : 0)} />
        ) : (
          // Name and duration share one row: with two rows, the middle row height minus the overlay strip leaves
          // only 23px, two rows do not fit and the top half of the title would be cut off
          <div className="pc-clip-body">
            {plan.name && (
              <span className="pc-clip-line" data-pc-clip-speed={isSpeedChanged(clip) ? clipSpeed(clip) : undefined}>
                <span className="nm">{shownLabel}</span>
                {plan.duration && subtitle ? <span className="du" data-i18n-data>{` · ${subtitle}`}</span> : null}
              </span>
            )}
            {plan.pill && overlays.length > 0 && <OverlayPill count={overlays.length} onOpenAll={openOverlayList} />}
          </div>
        )}
        
        {media && media.kind !== "image" && <AudioWaveform media={media} clip={clip} width={(displayEnd - displayStart) * pxPerSec} />}
        {/* Transition: a gradient over the fade interval at both ends, and a grouped one also gets a chain corner mark: shows at a glance that this segment is bound */}
        {(clip.fadeIn ?? 0) > 0 && (
          <div className="pc-clip-fade is-in" style={{ width: (clip.fadeIn ?? 0) * pxPerSec }} aria-hidden="true" />
        )}
        {(clip.fadeOut ?? 0) > 0 && (
          <div className="pc-clip-fade is-out" style={{ width: (clip.fadeOut ?? 0) * pxPerSec }} aria-hidden="true" />
        )}
        {cutOverSec > 0.01 && (
          <div className="pc-clip-cut-over" style={{ width: cutOverSec * pxPerSec }} title={trText("The referenced cut got shorter: this part is transparent and silent")} aria-hidden="true" />
        )}
        {lock && (
          <span className="pc-clip-link" title={lock.message}>
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4.6 7.4L7.4 4.6M5 2.6l.9-.9a2.3 2.3 0 013.3 3.3l-.9.9M7 9.4l-.9.9a2.3 2.3 0 01-3.3-3.3l.9-.9" />
            </svg>
          </span>
        )}

        {muteReason && (displayEnd - displayStart) * pxPerSec >= 76 && <ClipMuteBadge reason={muteReason} label={label} />}

        {/* The shot-change marker is drawn above the text and below the handles: handles must be draggable, the marker is only for viewing */}
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
          // The menu popped from the strip brings its own header and entries (the overlay card branch); right-clicking the clip uses the one below
          head={contextMenu.head === undefined ? { title: label || trText("Clips") } : contextMenu.head ?? undefined}
          onClose={() => setContextMenu(null)}
          items={contextMenu.items ?? [
            /*
             * "Quote to the input box" goes at the very top, and is **given in read-only too**: it changes nothing,
             * it only tells the Agent about this segment, which is exactly the one thing a read-only member can do.
             * Vibe mode goes into the DetailEdit input box, Classic mode into the AI panel on the right (quoteBus).
             */
            { label: trText("Quote into input box"), action: quoteThisClip },
            ...(ro.locked ? readOnlyItems : [
            // Transition at the very top: when bound, the first thing the user wants to do is unbind it
            ...myTransitions.map((tr) => ({
              label: trText("Delete transition: {0}", describeTransition(getState().project, tr)),
              action: () => actions.removeTransition(tr.id),
            })),
            ...(clip.emphasis
              ? [{ label: trText("Remove emphasis: {0}", describeEmphasis(clip.emphasis)), action: () => actions.setClipEmphasis(clip.id, null) }]
              : []),
            ...(clip.cutId && cutName ? [{ label: trText("Open cut \"{0}\"", cutName), action: () => openCutInTimeline(clip.cutId!) }] : []),
            // Overlay cards take only one item here: hover to list everything attached to this segment, hover one more to get what it can do
            {
              label: trText("Overlay card"),
              hint: overlays.length ? trText("{0} cards", overlays.length) : trText("None yet"),
              action: () => {},
              sub: overlayList(),
            },
            { label: trText("Duplicate"), action: () => actions.duplicateClip(clip.id) },
            ...(hasAudio ? [
              { label: clip.audioMuted ? trText("Unmute clip") : trText("Mute clip"), disabled: !!track.locked, action: () => reportAudio(actions.setClipMuted(clip.id, !clip.audioMuted)) },
              { label: trText("Adjust volume…"), disabled: !!track.locked, action: () => setVolumeOpen(true) },
            ] : []),
            // Sound only: the picture is gone; position, length, in-media offset and fades are all kept; the media library also gets an extra sound asset
            ...(canBecomeAudio || embeddedAudio ? [{ label: selectedAudioIds.length > 1 ? trText("Separate selected audio tracks ({0} segments)", selectedAudioIds.length) : trText("Separate audio from video"), disabled: !!track.locked,
              action: () => reportAudio(actions.separateAudios(selectedAudioIds)) }] : []),
            ...(canBecomeAudio && !embeddedAudio ? [{ label: trText("Convert to audio"), action: () => reportAudio(actions.convertClipToAudio(clip.id)) }] : []),
            // A media clip with sound can go straight to transcription (images have no sound, so this item is not offered)
            ...(() => {
              const media = clip.mediaId ? getState().project.media.find((m) => m.id === clip.mediaId) : null;
              if (!media || media.kind === "image") return [];
              return [{
                label: media.transcript ? trText("View captions ({0} segments)", media.transcript.segments.length) : trText("Transcribe captions"),
                action: () => requestCaptions(media.id),
                // Online browser mode has no speech recognition (C10 contract, section 10): items that can only transcribe are greyed out, and ones that already have captions are viewed as usual
                ...(!media.transcript && onlinePage() ? { disabled: true, title: onlineUnsupported(trText("Speech recognition")) } : {}),
              }];
            })(),
            {
              label: lock ? trText("Split at playhead (delete transition first)") : trText("Split at playhead"),
              action: () => actions.splitClip(clip.id, getState().t),
              disabled: !!lock || getState().t <= clip.start || getState().t >= clip.end,
            },
            {
              label: trText("Bring to front"),
              action: () => {
                const tracks = getState().project.tracks;
                // The topmost track is the top layer (consistent with what is seen on the timeline)
                if (tracks.length > 0) actions.moveClip(clip.id, { trackId: tracks[0].id });
              }
            },
            {
              label: trText("Send to back"),
              action: () => {
                const tracks = getState().project.tracks;
                if (tracks.length > 0) actions.moveClip(clip.id, { trackId: tracks[tracks.length - 1].id });
              }
            },
            { label: trText("Delete"), action: () => actions.removeClip(clip.id) },
            ]),
          ]}
        />
      )}
    </>
  );
}
