/**
 * Mobile app editor (semantics `workflow/editing.md` "Mobile app UI"; for interaction, `prototypes/mobile-ui-demo/` is authoritative).
 *
 * The bottom navigation bar has three tabs: thumbnail preview (default), timeline, Agent. Back hierarchy: tab → thumbnail preview → project list, and browser back follows the same rule
 * (entering a tab pushes one history entry; switching between tabs only replaces the current one).
 * The editor's infrastructure (document service sync, stage and preview, measurement mask, sync overlay) is the same set that the desktop `Editor.tsx` mounts, only arranged differently.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import "../cards";
import { actions, getState, onLocalCommit, useStore, withMerge } from "../store/project";
import { findClip, type TrackClip } from "../kernel/project";
import { transitionsOf, type Transition } from "../kernel/transitions";
import { getCard } from "../kernel/registry";
import { listCuts } from "../kernel/cuts";
import { Preview } from "../editor/Preview";
import { ProbeGate } from "../editor/ProbeGate";
import { MediaMigrationDialog } from "../editor/MediaMigrationDialog";
import { MissingMaterialsDialog } from "../editor/MissingMaterialsDialog";
import { CloudGoneDialog } from "../editor/sync/CloudGoneDialog";
import { SyncOverlays } from "../editor/sync/SyncOverlays";
import { DependencyPrompt } from "../editor/DependencyPrompt";
import { resumeShared, startSync, useSync } from "../editor/sync/syncManager";
import { unsentAtRisk, UNSENT_LEAVE_BODY } from "../editor/sync/onlineStatus";
import { useCloudRunning } from "../editor/sync/presence";
import { useReadOnly } from "../editor/readOnly";
import { ReadOnlyMarker } from "../editor/ReadOnlyFence";
import { AgentPage } from "./AgentPage";
import { overlayQuoteId } from "../editor/timeline/overlayActions";
import type { OverlayItem } from "../editor/timeline/overlays";
import { clipKind, clipName, mainClipsOf, mainTrackOf, planReorder } from "./mainContent";
import { ThumbStrip } from "./ThumbStrip";
import { FullTimeline, type FullTimelineHandle } from "./FullTimeline";
import { Icon } from "./icons";
import { StageButton, SubNav, fmtTc, useConfirm, useToast, type SubItem } from "./ui";
import {
  AssetsSheet, CardsSheet, ClipsSheet, ConflictSheet, ExportSheet, MembersSheet, ParamsSheet, SpeedSheet,
  conflictBarText, useConflicts, type AssetTab, type CardTab, type ParamsTarget, type TransitionTarget,
} from "./sheets";
import { useMembers } from "./useMembers";
import { useUploadRejectedNotice } from "../editor/left/uploadRejectedNotice";
import { tr as trText } from "../i18n/index.ts";
import { OVERLAY_QUOTE_KIND } from "./agentView";
import { shownName, shownNameOf } from "../i18n/names.ts";

// Hook for probes and tests to read and write the store (the desktop timeline module installs the same one; the mobile app does not mount the timeline module, so it installs it here)
(window as unknown as { __pcStore?: unknown }).__pcStore = { getState, actions };

type Page = "preview" | "timeline" | "agent";
type SheetState =
  | { kind: "assets"; tab: AssetTab }
  | { kind: "cards"; tab: CardTab; transition: TransitionTarget | null }
  | { kind: "clips" }
  | { kind: "params"; target: ParamsTarget }
  | { kind: "speed"; clipId: string }
  | { kind: "conflict" }
  | { kind: "members" }
  | { kind: "export" }
  | null;

const TRANSITION_NAME: Record<Transition["kind"], string> = { crossfade: trText("Crossfade"), fadeIn: trText("Fade in"), fadeOut: trText("Fade out") };
const cardName = (id: string) => shownNameOf(getCard(id)?.name);

/** This UI's level in the history: 1 thumbnail preview, 2 timeline / Agent tab */
interface NavState { pcm: 1; lvl: 1 | 2; page?: Page }
const navState = (): NavState | null => {
  const s = history.state as NavState | null;
  return s && s.pcm === 1 ? s : null;
};

export function MobileEditor() {
  const project = useStore((s) => s.project);
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  const selection = useStore((s) => s.selection);
  const toast = useToast();
  // Online uploads rejected by the quota (e.g. a guest's 4th video): show a short message that explains it clearly (`uploadRejectedNotice.ts`)
  useUploadRejectedNotice(toast);
  // This project is read-only for this user (guest): operations that change the project (reorder, split, copy, delete, mute, drag, align, undo/redo, add media / cards, parameters)
  // are never offered; the whole sub-navigation bar is grayed out and hovering shows viewOnlyText(); playback, preview, selecting in the thumbnail timeline, reading the Agent chat and export work as usual
  const ro = useReadOnly();
  const confirm = useConfirm();
  const [page, setPage] = useState<Page>("preview");
  const [sheet, setSheet] = useState<SheetState>(null);
  const [selTr, setSelTr] = useState<string | null>(null);
  const [quote, setQuote] = useState<{ clipId: string; cardId?: string; label: string; kind?: string } | null>(null);
  const timeline = useRef<FullTimelineHandle>(null);
  const conflicts = useConflicts();
  const offlineOpen = useSync((v) => v.offlineOpen && v.status === "paused");
  /**
   * Changes accumulated offline exist only in this page (the browser cannot store them, see `unsentAtRisk` in `onlineStatus.ts`): ask before leaving the editor.
   * The criterion is the same as the top bar's and the browser's native leave confirmation. The mobile app intercepts **in-app back**: system back and the top bar's home button both go through here.
   */
  const unsentRisk = useSync((v) => unsentAtRisk(v.status, v.unconfirmed, v.offlineStore));
  const running = useCloudRunning();
  const members = useMembers(sheet?.kind === "members");

  const main = useMemo(() => mainClipsOf(project), [project]);
  const mainTrack = mainTrackOf(project);
  const selClip = selection[0] && findClip(project, selection[0]) ? selection[0] : null;
  const tr = selTr ? transitionsOf(project).find((x) => x.id === selTr) ?? null : null;
  const cutName = useMemo(() => listCuts(project).find((c) => c.active)?.name ?? trText("Cut"), [project]);

  /* ---------- Editor infrastructure: same as Editor.tsx (no demo cards: the mobile app does not put in fake data) ---------- */
  useEffect(() => { void startSync().then(() => resumeShared()); }, []);
  // On reconnect, found that the project was changed while offline: open the conflict merge panel (same as the desktop offline dialog)
  useEffect(() => { if (offlineOpen) setSheet({ kind: "conflict" }); }, [offlineOpen]);

  /* ---------- Back hierarchy and browser back ---------- */
  const pushedBase = useRef(false);
  /** popstate arrives only **after** the back has happened and cannot see the latest props, so whether to intercept at this moment is kept in a ref */
  const riskRef = useRef(false);
  useEffect(() => { riskRef.current = unsentRisk; }, [unsentRisk]);
  /** Already asked, and the user chose "Leave": the next popstate is not intercepted */
  const leaving = useRef(false);
  /** A back we initiated ourselves (tab → thumbnail preview): the page has already been switched on the spot, so skip the matching popstate when it arrives, to avoid closing a panel opened after that */
  const ownBack = useRef(0);
  useEffect(() => {
    const s = navState();
    if (!s) { history.pushState({ pcm: 1, lvl: 1 } satisfies NavState, ""); pushedBase.current = true; }
    else if (s.lvl !== 1) history.replaceState({ pcm: 1, lvl: 1 } satisfies NavState, "");
    const onPop = () => {
      if (ownBack.current > 0) { ownBack.current--; return; }
      const st = navState();
      if (!st) {
        // About to leave the editor. If changes accumulated offline exist only in this page, ask first. The back has already happened and cannot be stopped,
        // so push the level that was just popped back (the user stays in place), then ask with the mobile app's own confirm box; only "Leave" really leaves
        if (riskRef.current && !leaving.current) {
          history.pushState({ pcm: 1, lvl: 1 } satisfies NavState, "");
          askLeave.current();
          return;
        }
        leaving.current = false;
        window.dispatchEvent(new Event("pc-go-home"));
        return;
      }
      setSheet(null);
      setPage(st.lvl === 2 && st.page ? st.page : "preview");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const goPage = (next: Page) => {
    setSheet(null);
    if (next === page) return;
    if (next === "preview") {
      if (navState()?.lvl === 2) { ownBack.current++; history.back(); }
      setPage("preview");
      return;
    }
    const st: NavState = { pcm: 1, lvl: 2, page: next };
    if (page === "preview") history.pushState(st, ""); else history.replaceState(st, "");
    setPage(next);
  };
  /** Really leave: from here on, do not ask a second time (`history.back()` triggers another popstate) */
  const leaveNow = () => {
    leaving.current = true;
    if (navState()?.lvl === 1 && pushedBase.current) history.back();
    else { leaving.current = false; window.dispatchEvent(new Event("pc-go-home")); }
  };
  /** Ask that question. It is also needed inside popstate, so it goes into a ref: that handler is attached only once and cannot capture the new closure */
  const askLeave = useRef<() => void>(() => {});
  askLeave.current = () => confirm({ text: UNSENT_LEAVE_BODY, ok: trText("Leave"), danger: true, run: leaveNow });
  const goHome = () => {
    if (unsentRisk) { askLeave.current(); return; }
    leaveNow();
  };

  /* ---------- "✕ Discard this edit" on the timeline tab: record how many changes this page has landed since entering ---------- */
  const editCount = useRef(0);
  useEffect(() => {
    if (page !== "timeline") return;
    editCount.current = 0;
    return onLocalCommit(() => { editCount.current++; });
  }, [page]);
  const discardEdits = () => {
    const n = editCount.current;
    for (let i = 0; i < n && actions.canUndo(); i++) actions.undo();
    editCount.current = 0;
    if (n) toast(trText("This edit was discarded"));
  };

  /* ---------- Selection ---------- */
  const selectClip = (id: string | null) => { setSelTr(null); actions.select(id ? [id] : []); };
  const selectTransition = (x: Transition | null) => { actions.select([]); setSelTr(x?.id ?? null); };
  // In the thumbnail preview, clicking anywhere outside the thumbnail timeline: clear the selection
  useEffect(() => {
    if (page !== "preview") return;
    const off = (e: PointerEvent) => {
      if (!selClip && !selTr) return;
      if ((e.target as HTMLElement).closest(".mblock, .mark, .subnav, .pager, .topbar, .cfbar, .sheet, .scrim, .confirm, .transport, .stage-btns")) return;
      selectClip(null);
    };
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  });

  /* ---------- Quote: switch to the Agent and bring this item into the input box ---------- */
  const refClip = (c: TrackClip) => {
    setQuote({ clipId: c.id, cardId: c.cardId || undefined, label: clipName(project, c, cardName) });
    goPage("agent");
  };
  /** A single overlay card: the quote block is one level finer than the whole clip (`@overlay-card name(clip id#kind:definition id)`, see editor/quoteBus.ts) */
  const refOverlay = (c: TrackClip, item: OverlayItem) => {
    setQuote({ clipId: overlayQuoteId(c, item), label: item.name, kind: OVERLAY_QUOTE_KIND });
    goPage("agent");
  };
  const refTransition = (x: Transition) => {
    setQuote({ clipId: x.id, label: trText("Transition {0}", TRANSITION_NAME[x.kind]) });
    goPage("agent");
  };
  useEffect(() => {
    if (page !== "agent" || !quote) return;
    const q = quote;
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("pc-quote-clip", { detail: q }));
      toast(trText("Quoted: {0}", q.label));
      setQuote(null);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [page, quote, toast]);

  /* ---------- Operations ---------- */
  const seek = (x: number) => { if (getState().playing) actions.pause(); actions.seek(Math.max(0, x)); };
  const reorder = (order: string[]) => {
    if (ro.locked) { toast(ro.why); return; }
    const p = getState().project;
    const plan = planReorder(p, order);
    if ("error" in plan) { toast(plan.error); return; }
    if (!plan.moves.length) return;
    const track = mainTrackOf(p)!;
    const far = Math.max(...track.clips.map((c) => c.end)) + 1000;
    withMerge({ key: `pcm-reorder-${Date.now()}`, windowMs: Infinity }, () => {
      // First move everything far away to make room, then place them one by one from the front at the new start points, so they never block each other midway
      plan.moves.forEach((m, i) => {
        const c = findClip(getState().project, m.id)!.clip;
        const s = far + i * 1000;
        actions.moveClip(m.id, { start: s, end: s + (c.end - c.start) });
      });
      [...plan.moves].sort((a, b) => a.start - b.start).forEach((m) => {
        const c = findClip(getState().project, m.id)!.clip;
        actions.moveClip(m.id, { start: m.start, end: m.start + (c.end - c.start) });
      });
    });
    const done = plan.moves.every((m) => Math.abs((findClip(getState().project, m.id)?.clip.start ?? -1) - m.start) < 1e-6);
    toast(done ? trText("Order changed") : trText("Reordering did not fully succeed, you can undo"));
  };
  const split = (c: TrackClip) => {
    if (ro.locked) { toast(ro.why); return; }
    if (t <= c.start + 0.05 || t >= c.end - 0.05) { toast(trText("Move the playhead to the middle of the clip first")); return; }
    const r = actions.splitClip(c.id, t);
    toast(r ? trText("Split at the playhead") : trText("Can't split: this segment has a transition, or its track is locked"));
  };
  const dup = (c: TrackClip) => { if (ro.locked) { toast(ro.why); return; } const r = actions.duplicateClip(c.id); if (r) { selectClip(r.id); toast(trText("Copied")); } };
  const del = (c: TrackClip) => ro.locked ? toast(ro.why) : confirm({ text: trText("Delete \"{0}\"?", clipName(project, c, cardName)), ok: trText("Delete"), danger: true, run: () => { actions.removeClip(c.id); toast(trText("Deleted, can be undone")); } });
  const mute = (c: TrackClip) => { if (ro.locked) { toast(ro.why); return; } actions.setClipMuted(c.id, !c.audioMuted); toast(c.audioMuted ? trText("Sound restored") : trText("Muted")); };
  const align = (which: "start" | "end") => {
    if (ro.locked) { toast(ro.why); return; }
    const c = selClip ? findClip(project, selClip)?.clip : undefined;
    if (!c) { toast(trText("Select a clip first")); return; }
    if (main.some((m) => m.id === c.id)) { toast(trText("The position of main content is set by its order. Long-press on the thumbnail timeline to reorder")); return; }
    const len = c.end - c.start;
    const start = which === "start" ? t : Math.max(0, t - len);
    const before = getState().project;
    actions.moveClip(c.id, { start, end: start + len });
    if (getState().project === before) toast(trText("Doesn't fit: there is already another clip there"));
  };
  const commitMove = (id: string, patch: { start: number; end: number }) => {
    if (ro.locked) { toast(ro.why); return; }
    const before = getState().project;
    actions.moveClip(id, patch);
    toast(getState().project === before ? trText("Doesn't fit: it overlaps another clip, or this segment has a transition") : trText("Adjusted (one drag = one undo step)"));
  };
  const delTransition = (x: Transition) => ro.locked ? toast(ro.why) : confirm({ text: trText("Delete transition \"{0}\"?", TRANSITION_NAME[x.kind]), ok: trText("Delete"), danger: true, run: () => {
    const r = actions.removeTransition(x.id);
    setSelTr(null);
    toast(r.ok ? (r.note ?? trText("Transition deleted, the related clips are unlocked")) : r.error);
  } });
  const boundaryOf = (x: Transition): TransitionTarget | null => {
    const i = main.findIndex((c) => c.id === x.aId || c.id === x.bId);
    if (i < 0) return null;
    const a = x.kind === "fadeIn" ? main[i - 1] : main[i];
    const b = x.kind === "fadeIn" ? main[i] : main[i + 1];
    return a && b ? { a, b, replace: x } : null;
  };

  const STD: SubItem[] = [
    { icon: "video", label: trText("Video"), pcm: "sub-video", run: () => setSheet({ kind: "assets", tab: "video" }) },
    { icon: "image", label: trText("Images"), pcm: "sub-image", run: () => setSheet({ kind: "assets", tab: "image" }) },
    { icon: "audio", label: trText("audio"), pcm: "sub-audio", run: () => setSheet({ kind: "assets", tab: "audio" }) },
    { icon: "clip", label: trText("Cut"), pcm: "sub-cut", run: () => setSheet({ kind: "clips" }) },
    { icon: "card", label: trText("Cards"), pcm: "sub-card", run: () => setSheet({ kind: "cards", tab: "anim", transition: null }) },
    { icon: "text", label: trText("Text"), pcm: "sub-text", run: () => setSheet({ kind: "cards", tab: "text", transition: null }) },
  ];
  const selClipObj = selClip ? findClip(project, selClip)?.clip ?? null : null;
  const refItem = (run: () => void): SubItem => ({ icon: "ref", label: trText("Quote"), ref: true, pcm: "sub-ref", run });
  const transitionItems = (x: Transition): SubItem[] => [
    refItem(() => refTransition(x)),
    { icon: "time", label: trText("Duration · intensity"), pcm: "sub-tr-time", run: () => setSheet({ kind: "params", target: { transitionId: x.id } }) },
    { icon: "swap", label: trText("Change transition"), pcm: "sub-tr-swap", run: () => setSheet({ kind: "cards", tab: "transition", transition: boundaryOf(x) }) },
    { icon: "trash", label: trText("Delete"), pcm: "sub-tr-del", run: () => delTransition(x) },
  ];
  const clipTools = (c: TrackClip): SubItem[] => {
    const kind = clipKind(project, c);
    const items: SubItem[] = [
      refItem(() => refClip(c)),
      { icon: "split", label: trText("Split"), pcm: "sub-split", run: () => split(c) },
      { icon: "copy", label: trText("Duplicate"), pcm: "sub-dup", run: () => dup(c) },
    ];
    const params = () => setSheet({ kind: "params", target: { clipId: c.id } });
    const muteItem: SubItem = { icon: "mute", label: c.audioMuted ? trText("Restore audio") : trText("Muted"), pcm: "sub-mute", run: () => mute(c) };
    if (kind === "card") items.push({ icon: "style", label: trText("Style"), pcm: "sub-style", run: params }, { icon: "opacity", label: trText("Opacity"), pcm: "sub-opacity", run: params });
    else if (kind === "audio") items.push(muteItem, { icon: "volume", label: trText("Volume"), pcm: "sub-volume", run: params });
    // Video clip: mute, speed, adjust (order from the demo's toolsFor); "Speed" opens the speed panel (the store's setClipSpeed, [ruling] a speed-changed clip has no original sound)
    else items.push(...(kind === "video" ? [muteItem, { icon: "speed", label: trText("Speed"), pcm: "sub-speed", run: () => setSheet({ kind: "speed", clipId: c.id }) } as SubItem] : []), { icon: "adjust", label: trText("Adjust"), pcm: "sub-adjust", run: params });
    // Overlay: the badge on the narrowest clips does not take clicks, so this is the only entry (`mobile/overlayBadge.ts`)
    items.push({ icon: "layers", label: trText("Overlays"), pcm: "sub-overlays", run: params });
    items.push({ icon: "trash", label: trText("Delete"), pcm: "sub-del", run: () => del(c) });
    return items;
  };
  // When read-only, the whole sub-navigation bar is grayed out (all of them are entries for adding media / changing clips / sending messages to the Agent), and hovering states the reason
  const lockItems = (items: SubItem[]): SubItem[] => (ro.locked ? items.map((it) => ({ ...it, disabled: true, title: ro.why })) : items);
  const previewItems: SubItem[] = lockItems(tr ? transitionItems(tr) : selClipObj ? [refItem(() => refClip(selClipObj)), ...STD] : STD);
  const timelineItems: SubItem[] = lockItems(selClipObj ? clipTools(selClipObj) : STD);

  const timelineTitle = selClipObj
    ? `${({ card: trText("Cards"), audio: trText("audio"), image: trText("Image clip"), cut: trText("Cut segment"), video: trText("Video clip") } as const)[clipKind(project, selClipObj)]} · ${clipName(project, selClipObj, cardName)}`
    : trText("Timeline · {0}", cutName);
  const aspect = `${project.width} / ${project.height}`;
  const memberLabel = members.unavailable ? trText("Members") : trText("{0} people · {1} Agent", members.people, members.agents);

  return (
    <div className={`editor${page === "timeline" ? " is-timeline" : ""}`} data-pcm="editor" data-page={page} data-readonly={ro.locked ? "1" : undefined}>
      <ReadOnlyMarker />
      <MediaMigrationDialog />
      <MissingMaterialsDialog />
      <CloudGoneDialog />
      <SyncOverlays offlineDialog={false} />
      <DependencyPrompt />

      {page === "timeline" ? (
        <div className="topbar edit-head" data-pcm="topbar">
          <button type="button" className="icon-btn" data-pcm="tl-discard" title={trText("Exit (discard this edit)")} aria-label={trText("Exit")} onClick={() => { discardEdits(); goPage("preview"); }}><Icon name="close" /></button>
          <h1 data-pcm="edit-title">{timelineTitle}</h1>
          <button type="button" className="icon-btn ok" data-pcm="tl-done" title={trText("Done")} aria-label={trText("Done")} onClick={() => goPage("preview")}><Icon name="ok" /></button>
        </div>
      ) : (
        <div className="topbar" data-pcm="topbar">
          {page === "agent"
            ? <button type="button" className="icon-btn" data-pcm="top-back" title={trText("Back to thumbnail preview")} aria-label={trText("Back")} onClick={() => goPage("preview")}><Icon name="back" /></button>
            : <button type="button" className="icon-btn" data-pcm="top-home" title={trText("Home")} aria-label={trText("Home")} onClick={goHome}><Icon name="home" /></button>}
          <h1 data-pcm="project-name">{project.name}</h1>
          <button type="button" className="btn primary" style={{ height: 30, padding: "0 12px" }} data-pcm="top-export" onClick={() => setSheet({ kind: "export" })}>{trText("Export")}</button>
        </div>
      )}

      {/* Read-only project (guest): hover text is not visible on a phone, so a grayed-out button needs one sentence explaining why (playback, preview, export, reading the Agent chat work as usual) */}
      {ro.locked && <div className="robar" data-pcm="ro-bar">{ro.why}</div>}

      {conflicts.pending && (
        <div className="cfbar" data-pcm="cfbar">
          <Icon name="warn" />
          <span className="txt" data-pcm="cfbar-text">{conflictBarText(conflicts)}</span>
          <button type="button" data-pcm="cfbar-open" onClick={() => setSheet({ kind: "conflict" })}>{trText("Resolve")}</button>
        </div>
      )}

      {/*
        In the Agent tab, the preview is hidden but not unmounted: stage iframe cannot be display:none
        (<video> and rAF inside would stop, layout resets to zero, as noted for background stage in
        Preview.tsx), so it is moved out of flow, made transparent, and ignores pointer events.
      */}
      <div className="preview-area" data-pcm="preview-area" inert={page === "agent"}
        style={page === "agent" ? { position: "absolute", left: 0, right: 0, top: 0, opacity: 0, pointerEvents: "none" } : undefined}>
        <div className="stage-wrap">
          <div className="stage" data-pcm="stage" style={{ aspectRatio: aspect }}>
            <Preview variant="mobile" />
            <ProbeGate />
            <div className="stage-btns">
              {/* Without an account there are no members, so the whole entry is not drawn (`product/platforms.md` "The second screen on the LAN": the phone does not show members) */}
              {!members.unavailable && (
                <StageButton className="sbtn" pcm="members-btn" title={trText("Members")} onTap={() => setSheet({ kind: "members" })}>
                  {page === "timeline" ? <><Icon name="members" />{`${members.people}·${members.agents}`}</> : memberLabel}
                  {/* A numeric badge appears when there are new join requests (only the creator can see requests; user decision, 2026-10-22) */}
                  {members.requests.length > 0 && <span className="badge-n" data-pcm="members-request-badge">{members.requests.length}</span>}
                </StageButton>
              )}
            </div>
            {running.size > 0 && <div className="agent-flag" data-pcm="agent-flag">{trText("Agent is editing")}</div>}
          </div>
        </div>
      </div>

      {page !== "agent" && (
        <div className="transport" data-pcm="transport">
          <button type="button" className="play" data-pcm="play" aria-label={playing ? trText("Pause") : trText("Play")} onClick={() => actions.togglePlay()}><Icon name={playing ? "pause" : "play"} /></button>
          <div className="tc"><b data-pcm="tc-now">{fmtTc(t)}</b> / <span data-pcm="tc-total">{fmtTc(project.duration)}</span></div>
          <span className="spacer" />
          <button type="button" className="icon-btn" data-pcm="undo" aria-label={trText("Revoke")} disabled={!actions.canUndo() || ro.locked} title={ro.title(trText("Revoke"))} onClick={() => { actions.undo(); if (editCount.current > 0) editCount.current--; }}><Icon name="undo" /></button>
          <button type="button" className="icon-btn" data-pcm="redo" aria-label={trText("Redo")} disabled={!actions.canRedo() || ro.locked} title={ro.title(trText("Redo"))} onClick={() => actions.redo()}><Icon name="redo" /></button>
        </div>
      )}

      {page === "preview" && (
        <div className="pane-default" data-pcm="pane-preview">
          <ThumbStrip
            project={project}
            clips={main}
            t={t}
            playing={playing}
            selected={tr?.id ?? selClip}
            onSelect={(s) => {
              if (!s) { selectClip(null); return; }
              if ("clipId" in s) { selectClip(s.clipId); toast(trText("Selected segment {0} · long-press this card again and drag to reorder", main.findIndex((c) => c.id === s.clipId) + 1)); }
              else { selectTransition(s.transition); toast(trText("Selected transition \"{0}\"", TRANSITION_NAME[s.transition.kind])); }
            }}
            onReorder={reorder}
            onScrub={seek}
            onAddMedia={() => { if (!ro.locked) setSheet({ kind: "assets", tab: "video" }); }}
            onAddTransition={(a, b) => { if (!ro.locked) setSheet({ kind: "cards", tab: "transition", transition: { a, b } }); }}
            locked={ro.locked}
          />
          <SubNav items={previewItems} pcm="subnav-preview" />
        </div>
      )}

      {page === "timeline" && (
        <>
          <FullTimeline
            ref={timeline}
            project={project}
            t={t}
            playing={playing}
            selected={selClip}
            mainTrackId={mainTrack?.id}
            cardName={cardName}
            onSelect={selectClip}
            onScrub={seek}
            onCommitMove={commitMove}
            onAlign={align}
            onOverlays={(id) => { selectClip(id); setSheet({ kind: "params", target: { clipId: id } }); }}
            locked={ro.locked}
            lockedWhy={ro.why}
          />
          <SubNav items={timelineItems} pcm="subnav-timeline" />
        </>
      )}

      <div className="pane-agent" data-pcm="pane-agent" style={page === "agent" ? undefined : { display: "none" }}>
        <AgentPage active={page === "agent"} />
      </div>

      <div className="pager" data-pcm="pager">
        <button type="button" className={page === "preview" ? "on" : undefined} data-pcm="pg-preview" onClick={() => goPage("preview")}><span className="ico"><Icon name="pgPreview" /></span><span className="lbl">{trText("Thumbnail preview")}</span></button>
        <button type="button" className={page === "timeline" ? "on" : undefined} data-pcm="pg-timeline" onClick={() => goPage("timeline")}><span className="ico"><Icon name="pgTimeline" /></span><span className="lbl">{trText("Timeline")}</span></button>
        <button type="button" className={page === "agent" ? "on" : undefined} data-pcm="pg-agent" onClick={() => goPage("agent")}><span className="ico"><span className="disc"><Icon name="sparkle" /></span></span><span className="lbl">Agent</span></button>
      </div>

      {sheet?.kind === "assets" && <AssetsSheet tab={sheet.tab} onTab={(tab) => setSheet({ kind: "assets", tab })} onClose={() => setSheet(null)}
        onSwitchCut={(id) => { actions.switchCut(id); toast(trText("Switched to another cut")); }}
        onPlaced={(clip, m) => { setSheet(null); if (m.kind !== "audio") selectClip(null); toast(m.kind === "audio" ? trText("Added at {0}", fmtTc(clip.start)) : trText("Added to the end of the main content (segment {0})", mainClipsOf(getState().project).length)); }} />}
      {sheet?.kind === "cards" && <CardsSheet tab={sheet.tab} transition={sheet.transition} onTab={(tab) => setSheet({ ...sheet, tab })} onClose={() => setSheet(null)}
        onAdded={(clip) => { setSheet(null); selectClip(clip.id); if (page !== "timeline") goPage("timeline"); }} />}
      {sheet?.kind === "clips" && <ClipsSheet onClose={() => setSheet(null)} onSwitched={(name) => { selectClip(null); toast(trText("Compact timeline switched to \"{0}\"", name)); if (page === "timeline") requestAnimationFrame(() => timeline.current?.fit()); }} />}
      {sheet?.kind === "params" && <ParamsSheet target={sheet.target} onClose={() => setSheet(null)}
        onAskAgent={(id) => { const c = findClip(getState().project, id)?.clip; if (c) refClip(c); }}
        onQuoteOverlay={(c, item) => { setSheet(null); refOverlay(c, item); }} />}
      {sheet?.kind === "speed" && <SpeedSheet clipId={sheet.clipId} onClose={() => setSheet(null)} />}
      {sheet?.kind === "conflict" && <ConflictSheet onClose={() => setSheet(null)} />}
      {sheet?.kind === "members" && !members.unavailable && <MembersSheet info={members} onClose={() => setSheet(null)} />}
      {sheet?.kind === "export" && <ExportSheet onClose={() => setSheet(null)} />}
    </div>
  );
}
