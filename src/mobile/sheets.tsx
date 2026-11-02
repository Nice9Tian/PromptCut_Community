/**
 * The mobile app's bottom sheets: media library, card library (including transitions), select cut, adjust, conflict merge, members, export (demo rounds 3 to 9).
 * Every button calls real store actions and services, with no fake data; items the business layer does not have are not shown (task brief "Design decisions" 3).
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
import { tr as trText } from "../i18n/index.ts";
import { shownName, shownNameOf } from "../i18n/names.ts";

/* ======================== Media library ======================== */

export type AssetTab = "video" | "image" | "audio" | "cut";
const ASSET_TABS: { id: AssetTab; label: string }[] = [
  { id: "video", label: trText("Video") }, { id: "image", label: trText("Images") }, { id: "audio", label: trText("audio") }, { id: "cut", label: trText("Cut") },
];

/** Videos / images are appended to the end of the main content; sounds are added at the playhead position */
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
  // The cut list is computed once per project (same as the cut group of the desktop media library): a selector must not build an array on the fly, or every read yields a new value and re-renders endlessly
  const project = useStore((s) => s.project);
  const cuts = useMemo(() => listCuts(project), [project]);
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // When the online browser is offline, importing media is grayed out and shows "Currently offline" (user decision, 2026-10-22)
  const importOffline = useImportOffline();
  const list = media.filter((m) => (props.tab === "audio" ? m.kind === "audio" : props.tab === "image" ? m.kind === "image" : m.kind === "video"));
  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const r = await importMediaFiles(files);
      const n = r.counts.video + r.counts.audio + r.counts.image;
      toast(n ? trText("Imported {0} media{1}", n, r.skipped.length ? trText(", skipped {0} unrecognized files", r.skipped.length) : "") : r.rejected[0] ?? trText("No files could be imported"));
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
      title={trText("Media library")}
      tall
      onClose={props.onClose}
      head={props.tab !== "cut" ? <button type="button" className="chip accent" data-pcm="import" disabled={busy || importOffline} title={importOffline ? IMPORT_OFFLINE_TEXT : undefined} onClick={() => { if (!importOffline) input.current?.click(); }}>{busy ? trText("Importing…") : importOffline ? trText("+ Import ({0})", IMPORT_OFFLINE_TEXT) : trText("+ Import")}</button> : null}
      tabs={<div className="seg">{ASSET_TABS.map((t) => <button key={t.id} type="button" className={t.id === props.tab ? "on" : undefined} onClick={() => props.onTab(t.id)}>{t.label}</button>)}</div>}
    >
      <input ref={input} type="file" multiple accept={MEDIA_ACCEPT} hidden data-pcm="import-input" onChange={(e) => void onFiles(e.target.files)} />
      {props.tab === "cut" ? (
        <>
          <div className="hint">{trText("Tap a cut: the compact timeline and the full timeline switch to its contents.")}</div>
          <div className="grid">
            {cuts.map((c) => (
              <button key={c.id} type="button" className={c.active ? "tile picked" : "tile"} data-pcm="asset-cut" onClick={() => { if (!c.active) props.onSwitchCut(c.id); props.onClose(); }}>
                <div className="pic"><Icon name="clip" /></div>
                <div className="cap">{c.name}<small>{trText("Cut")}</small></div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <button type="button" className="dropzone" data-pcm="import-dropzone" disabled={busy || importOffline} onClick={() => { if (!importOffline) input.current?.click(); }}>{importOffline ? trText("+ Import from photos / files ({0})", IMPORT_OFFLINE_TEXT) : trText("+ Import from photos / files")}</button>
          <div className="hint">{props.tab === "audio" ? trText("Tap to add at the playhead position.") : trText("Tap to append to the end of the main content.")}</div>
          {list.length === 0 ? <div className="hint" data-pcm="asset-empty">{trText("This project has no {0} media yet.", ASSET_TABS.find((t) => t.id === props.tab)!.label)}</div> : (
            <div className="grid">
              {list.map((m) => (
                <button key={m.id} type="button" className="tile" data-pcm="asset" data-media={m.id} onClick={() => {
                  const clip = placeMedia(m);
                  if (!clip) { toast(trText("Doesn't fit: no empty track")); return; }
                  props.onPlaced(clip, m);
                }}>
                  <AssetPic m={m} />
                  <div className="cap">{m.name}<small>{m.kind === "audio" ? trText("audio") : m.kind === "image" ? trText("Images") : trText("Video")}</small></div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}

/** Picture of a media cell: a sampled-color background plus a type icon as the base, and once the first frame / thumbnail is obtained it is laid over (`Thumb.tsx`) */
function AssetPic({ m }: { m: MediaAsset }) {
  const thumb = useThumb(m);
  return (
    <div className="pic" data-thumb={thumb.src ? "ready" : undefined} style={{ background: `linear-gradient(135deg, ${tint(m.id)}, var(--shade-art))` }}>
      {m.kind !== "audio" && <ThumbImg thumb={thumb} />}
      <Icon name={m.kind === "audio" ? "audio" : m.kind === "image" ? "image" : "video"} />
      {m.duration ? <span className="dur">{fmtDur(m.duration)}</span> : null}
      {m.pending ? <span className="st">{trText("Uploading")}</span> : m.transcript ? <span className="st">{trText("Transcribed")}</span> : null}
    </div>
  );
}

/* ======================== Card library ======================== */

export type CardTab = "anim" | "text" | "filter" | "transition";
const TRANSITION_KINDS: { kind: TransitionKind; name: string; desc: string }[] = [
  { kind: "crossfade", name: trText("Crossfade"), desc: trText("The previous clip dissolves into the next one") },
  { kind: "fadeOut", name: trText("Fade out"), desc: trText("The end of the previous clip fades to black") },
  { kind: "fadeIn", name: trText("Fade in"), desc: trText("The start of the next clip emerges from black") },
];

/** Whether a clip is a text card: it has a text parameter named text */
const isTextCard = (c: CardDef<any>) => c.controls.some((k) => k.key === "text" && k.type === "text");

/** Where a transition goes: between two clips of main content (add), or replacing an existing one */
export interface TransitionTarget { a: TrackClip; b: TrackClip; replace?: Transition }

/** Put a transition between a and b; with replace, delete it first (one undo step) */
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
    ? tr?.replace ? trText("Swap the transition: tap one to replace the current one.") : tr ? trText("Tap a transition to add it between these two clips.") : trText("First tap the + between two clips on the mini timeline, then pick a transition.")
    : props.tab === "filter" ? null : trText("Tap a card to add it at the playhead.");
  return (
    <Sheet
      id="cards"
      title={trText("Cards (effects / motion graphics)")}
      tall
      onClose={props.onClose}
      tabs={<div className="seg">{([["anim", trText("Motion graphics")], ["text", trText("Text")], ["filter", trText("Filters")], ["transition", trText("Transition")]] as const).map(([id, label]) => <button key={id} type="button" className={id === props.tab ? "on" : undefined} onClick={() => props.onTab(id)}>{label}</button>)}</div>}
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
              toast(tr.replace ? trText("Replaced with \"{0}\"", k.name) : trText("Added \"{0}\"", k.name));
              props.onClose();
            }}>
              <div className="pic"><Icon name="card" /></div>
              <div className="cap">{k.name}<small>{k.desc}</small></div>
            </button>
          ))}
        </div>
      ) : cards.length === 0 ? <div className="hint">{trText("No cards available.")}</div> : (
        <div className="grid">
          {cards.map((c) => (
            <button key={c.id} type="button" className="tile" data-pcm="card" data-card={c.id} onClick={() => {
              const clip = actions.addCardClip(c.id, getState().t);
              if (!clip) { toast(trText("Doesn't fit: no empty track")); return; }
              toast(trText("Added at {0}", fmtTc(clip.start)));
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

/* ======================== Select cut ======================== */

export function ClipsSheet(props: { onClose: () => void; onSwitched: (name: string) => void }) {
  const project = useStore((s) => s.project);
  const cuts = useMemo(() => listCuts(project), [project]);
  const toast = useToast();
  const summary = (c: (typeof cuts)[number]) => {
    if (c.active) { const m = mainClipsOf(project); return trText("{0} clips · {1} total", m.length, fmtDur(m.reduce((s, x) => s + x.end - x.start, 0))); }
    return trText("Total {0}", fmtDur(c.duration));
  };
  return (
    <Sheet id="clips" title={trText("Select cut")} onClose={props.onClose}>
      <div className="hint">{trText("Pick a cut and the mini timeline switches to its content.")}</div>
      {cuts.map((c) => (
        <button key={c.id} type="button" className={c.active ? "crow cur" : "crow"} data-pcm="cut-row" data-cut={c.id} onClick={() => {
          if (!c.active) actions.switchCut(c.id);
          props.onSwitched(c.name);
          props.onClose();
        }}>
          <div className="i"><Icon name="clip" /></div>
          <div style={{ flex: 1, minWidth: 0 }}><b>{c.name}</b><div className="hint" style={{ margin: 0 }}>{summary(c)}</div></div>
          {c.active && <span className="chip accent">{trText("Current")}</span>}
        </button>
      ))}
      <button type="button" className="btn" style={{ width: "100%", marginTop: 6 }} data-pcm="cut-new" onClick={() => {
        actions.addCut(undefined, { switchTo: true });
        const now = getState().project;
        const name = now.cuts?.find((c) => c.id === now.activeCutId)?.name ?? trText("New cut");
        toast(trText("Created \"{0}\"", name));
        props.onSwitched(name);
        props.onClose();
      }}>{trText("+ New cut")}</button>
    </Sheet>
  );
}

/* ======================== Adjust ======================== */

export type ParamsTarget = { clipId: string } | { transitionId: string };

/**
 * The top section of the "Adjust" form: what is attached to this clip (filters, pixel maps, audio effects, media effect cards).
 *
 * It is placed before duration, opacity and volume: what is attached decides how this clip looks right now, so it needs to be seen before the clip's own parameters;
 * and filters were already in this form (`ClipFilterFields` below), so this section just absorbs them.
 *
 * Disabling is a switch: on desktop this item hides in the right-click menu, and a phone has no right click, so one switch per row is the simplest approach.
 * Each row has its own "Quote": the one in the sub-navigation quotes the whole clip, and two filters of the same name on one clip is common,
 * so without saying which one, the Agent can only ask back.
 */
function OverlaySection({ clip, onQuote }: {
  clip: TrackClip;
  onQuote?: (clip: TrackClip, item: OverlayItem) => void;
}) {
  const project = useStore((s) => s.project);
  const toast = useToast();
  const items = useMemo(
    () => overlaysOfClip(project, clip, { cardName: (id) => shownNameOf(getCard(id)?.name) }),
    [project, clip],
  );
  if (!items.length) return null;
  return (
    <div data-pcm="param-overlays">
      <div className="hint">{trText("Overlay cards · {0}, processed from top to bottom", items.length)}</div>
      {items.map((it) => (
        <div key={`${it.kind}:${it.refId}`} className={it.off ? "row is-off" : "row"} data-pcm="param-overlay">
          <div className="t">
            <b>{it.name}</b>
            <small>{OVERLAY_KIND_NAME[it.kind]}{it.value ? ` · ${it.value}` : ""}{it.off ? trText(" · Disabled") : ""}</small>
          </div>
          {onQuote && (
            <button type="button" className="icon-btn ref" data-pcm="param-overlay-ref"
              aria-label={trText("Reference \"{0}\" to the Agent", it.name)} title={trText("Reference this card to the Agent")}
              onClick={() => onQuote(clip, it)}><Icon name="ref" /></button>
          )}
          <button type="button" className="icon-btn danger" data-pcm="param-overlay-detach"
            aria-label={trText("Detach \"{0}\"", it.name)} disabled={!it.canDetach}
            title={it.canDetach ? trText("Detach from this clip") : trText("This card has more than one input, or is itself the content of this clip, so it can't be reattached")}
            onClick={() => {
              try { detachOverlay(actions, clip, it, (id) => getCard(id)); }
              catch (e) { toast(e instanceof Error ? e.message : String(e)); }
            }}><Icon name="trash" /></button>
          <button type="button" className={it.off ? "toggle" : "toggle on"} data-pcm="param-overlay-toggle"
            aria-label={`${it.name}${it.off ? trText(" disabled") : trText(" active")}`}
            disabled={!it.canToggle}
            title={it.canToggle ? undefined : trText("Disabling a media effect card is done in the node graph of the edit section")}
            onClick={() => setOverlayOff(actions, clip, it, !it.off)} />
        </div>
      ))}
    </div>
  );
}

export function ParamsSheet(props: { target: ParamsTarget; onClose: () => void; onAskAgent: (clipId: string) => void;
  /** "Quote" for a single overlay card: the same path as the sub-navigation's "Quote", only one level finer in granularity */
  onQuoteOverlay?: (clip: TrackClip, item: OverlayItem) => void }) {
  const project = useStore((s) => s.project);
  const toast = useToast();
  const undoRow = (clipId?: string) => (
    <div className="undo-row">
      <button type="button" className="btn" data-pcm="params-undo" onClick={() => actions.undo()}><Icon name="undo" />{trText("Undo")}</button>
      {clipId && <button type="button" className="btn" onClick={() => props.onAskAgent(clipId)}>{trText("Have the Agent keep editing")}</button>}
    </div>
  );
  if ("transitionId" in props.target) {
    const tr = transitionsOf(project).find((x) => x.id === (props.target as { transitionId: string }).transitionId);
    if (!tr) return <Sheet id="params" title={trText("Adjust")} light onClose={props.onClose}><div className="hint">{trText("This transition no longer exists.")}</div></Sheet>;
    const name = TRANSITION_KINDS.find((k) => k.kind === tr.kind)!.name;
    return (
      <Sheet id="params" title={name} light onClose={props.onClose} head={<span className="chip plum">{trText("Transition")}</span>}>
        <div className="wrapnote"><b>{trText("Transition:")}</b>{trText("Adjacent clips are bound into a group. To move one on its own, delete the transition first.")}</div>
        <Slider label={trText("Duration")} pcm="param-transition-dur" value={tr.dur} min={MIN_TRANSITION_DUR} max={Math.min(4, MAX_TRANSITION_DUR)} step={0.1} unit="s" onCommit={(v) => {
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
  if (!hit) return <Sheet id="params" title={trText("Adjust")} light onClose={props.onClose}><div className="hint">{trText("This clip no longer exists.")}</div></Sheet>;
  const c = hit.clip;
  const kind = clipKind(project, c);
  const def = c.cardId ? getCard(c.cardId) : undefined;
  const len = c.end - c.start;
  const kindLabel = kind === "card" ? trText("Cards") : kind === "audio" ? trText("audio") : kind === "image" ? trText("Image clip") : kind === "cut" ? trText("Cut segment") : trText("Video clip");
  return (
    <Sheet id="params" title={clipName(project, c, (id) => shownNameOf(getCard(id)?.name))} light onClose={props.onClose} head={<span className={kind === "card" ? "chip plum" : "chip"}>{kindLabel}</span>}>
      <OverlaySection clip={c} onQuote={props.onQuoteOverlay} />
      {def && def.controls.filter((k) => k.type !== "asset").map((k) => (
        <ControlField key={k.key} ctl={k} value={c.params[k.key] ?? (def.defaults as Record<string, unknown>)[k.key]} onCommit={(v) => actions.setClipParams(c.id, { [k.key]: v })} />
      ))}
      <Slider label={trText("Duration")} pcm="param-dur" value={Math.round(len * 10) / 10} min={0.5} max={Math.max(30, Math.ceil(len))} step={0.1} unit="s" onCommit={(v) => {
        const before = getState().project;
        actions.moveClip(c.id, { end: c.start + v });
        if (getState().project === before) toast(trText("Can't change the duration: no room after it, or this clip has a transition attached"));
      }} />
      {kind !== "audio" && <Slider label={trText("Opacity")} pcm="param-opacity" value={Math.round((c.opacity ?? 1) * 100)} min={0} max={100} unit="%" onCommit={(v) => actions.updateClip(c.id, { opacity: v / 100 })} />}
      {filterableClip(project, c) && <ClipFilterFields clip={c} />}
      {(kind === "video" || kind === "audio") && <>
        <Slider label={trText("Volume")} pcm="param-volume" value={Math.round((c.audioVolume ?? 1) * 100)} min={0} max={100} unit="%" onCommit={(v) => actions.setClipVolume(c.id, v / 100)} />
        {kind === "video" && clipSpeed(c) !== 1 && <div className="wrapnote" data-pcm="param-speed-note"><b>{trText("Speed changed {0}:", speedLabel(clipSpeed(c)))}</b>{SPEED_MUTE_NOTE}</div>}
        <div className="row"><div className="t">{trText("Mute this clip")}<small>{trText("The picture is unaffected; the timeline clearly marks it as \"Muted\"")}</small></div>
          <button type="button" className={c.audioMuted ? "toggle on" : "toggle"} aria-label={trText("Muted")} data-pcm="param-mute" onClick={() => actions.setClipMuted(c.id, !c.audioMuted)} /></div>
      </>}
      {undoRow(c.id)}
    </Sheet>
  );
}

/* ======================== Speed ======================== */

/**
 * "Speed" for a video clip (the "Speed" item in the demo's sub-navigation bar; in the business layer it is the store's setClipSpeed, the same action as the desktop editing section).
 * The start stays and the end is recomputed at the new speed; [ruling] in the first version a speed-changed clip has no original sound, stated in the panel (the same SPEED_MUTE_NOTE sentence).
 */
export function SpeedSheet(props: { clipId: string; onClose: () => void }) {
  const project = useStore((s) => s.project);
  const toast = useToast();
  const hit = findClip(project, props.clipId);
  const cur = hit ? clipSpeed(hit.clip) : 1;
  const [text, setText] = useState(String(cur));
  if (!hit) return <Sheet id="speed" title={trText("Speed")} light onClose={props.onClose}><div className="hint">{trText("This clip no longer exists.")}</div></Sheet>;
  const c = hit.clip;
  const presets = CLIP_SPEED_PRESETS.includes(cur) ? CLIP_SPEED_PRESETS : [...CLIP_SPEED_PRESETS, cur].sort((a, b) => a - b);
  const pick = (v: number) => {
    if (Math.abs(v - cur) < 1e-9) return;
    const r = actions.setClipSpeed(c.id, v);
    if (!r.ok) { toast(r.error); return; }
    setText(String(getState().project.tracks.flatMap((t) => t.clips).find((x) => x.id === c.id)?.speed ?? 1));
    const head = v === 1 ? trText("Restored to 1×, original audio restored") : trText("Changed to {0}, this clip has no original audio", speedLabel(clipSpeed({ speed: v })));
    // Transitions shrank with it, who moved along, how many clips were pushed apart (user decision 2026-10-23: "a bubble notice is enough"): the same sentence as desktop (speedChangeNotes in kernel/clipTime.mjs)
    const tail = speedChangeNotes(r, c.id);
    toast(tail ? trText("{0}; {1}", head, tail) : head);
  };
  const commitText = () => {
    const v = Number(text.trim().replace(/[×x]$/i, ""));
    if (!Number.isFinite(v)) { toast(trText("The speed multiplier must be a number")); setText(String(cur)); return; }
    pick(v);
  };
  return (
    <Sheet id="speed" title={clipName(project, c, (id) => shownNameOf(getCard(id)?.name))} light onClose={props.onClose} head={<span className="chip">{trText("Speed")}</span>}>
      <div className="seg" data-pcm="speed-presets" style={{ flexWrap: "wrap", rowGap: 6 }}>
        {presets.map((v) => (
          <button key={v} type="button" className={v === cur ? "on" : undefined} data-pcm="speed-preset" data-speed={v} aria-pressed={v === cur} onClick={() => pick(v)}>{speedLabel(v)}</button>
        ))}
      </div>
      {/* Manually entered rate (user decision 2026-10-23): 0.25~4, decimals allowed; out of range is rejected with a message, not clamped */}
      <div className="field" data-pcm="speed-custom">
        <label>{trText("Custom speed multiplier")}<span><input className="num" data-pcm="speed-input" type="number" inputMode="decimal" min={CLIP_SPEED_MIN} max={CLIP_SPEED_MAX} step={0.01} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") commitText(); }} /> ×</span></label>
        <button type="button" className="btn" data-pcm="speed-apply" onClick={commitText}>{trText("Apply")}</button>
      </div>
      <div className="wrapnote" data-pcm="speed-note"><b>{trText("Sound:")}</b>{SPEED_MUTE_NOTE}</div>
      <div className="hint">{trText("The start point stays; the duration is recalculated at the new speed: {0} (media {1}). If it gets longer, it pushes the following segments back; if shorter, the tail is left empty. When a transition is attached, it follows the clip's two ends, and if it does not fit it is shortened and you are notified.", fmtDur(c.end - c.start), fmtDur((c.end - c.start) * cur))}</div>
      <div className="undo-row">
        <button type="button" className="btn" data-pcm="speed-undo" onClick={() => actions.undo()}><Icon name="undo" />{trText("Undo")}</button>
      </div>
    </Sheet>
  );
}

/* ======================== Conflict merge ======================== */

/**
 * Conflict merge panel: the same set as the desktop "Conflict merge" window (two-level checkable list, "Select conflict-free items", "Clear all checks",
 * "Merge", "Delete selected", "Later / Done"), with state and actions all in `editor/sync/useConflictMerge.ts`; the look follows demo round 9.
 * The pending merge items come from the pending merge table (`mergeItems.ts`, stored per "project × user" in the document service), shared by offline reconnect and the undo conflict of 0.7.20.
 * The rare case "Sync paused" (the offline batch cannot yield per-item differences and falls back to whole-batch handling) still gets a whole-batch "Merge / Delete all" here.
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
    <Sheet id="conflict" title={trText("Merge conflicts")} onClose={close} foot={
      <div className="cf-foot">
        {m.hasItems && <>
          <button type="button" className="btn primary" data-pcm="cf-merge" disabled={!m.selected || !m.online} onClick={m.merge}>{trText("Merge")}</button>
          <button type="button" className="btn" data-pcm="cf-drop" disabled={!m.selected} onClick={m.remove}>{trText("Delete selected")}</button>
        </>}
        <button type="button" className="btn" data-pcm="cf-close" onClick={close}>{m.hasItems ? trText("Later") : trText("Done")}</button>
      </div>
    }>
      {!m.hasItems ? <div className="hint" style={{ textAlign: "center", padding: "30px 0" }}>{trText("All done ✓")}</div> : <>
        <div className="hint" data-pcm="cf-summary">{trText("{0}. Tick the items to process; you can tick them one by one.", mergeBarText(m.counts))}</div>
        <div className="cf-top">
          <button type="button" className="btn" data-pcm="cf-select-clean" onClick={m.selectNonConflict}>{trText("Select non-conflicting items")}</button>
          <button type="button" className="btn" data-pcm="cf-clear" onClick={m.clearAll}>{trText("Clear all selections")}</button>
        </div>
        {m.rows.map((row) => {
          const state = m.check(row);
          return (
            <div key={row.key} className="cf-group" data-pcm="cf-thing" data-key={row.key}>
              <div className="cf-head">
                <label><input type="checkbox" aria-label={trText("Select {0}", row.label)} checked={state === "all"} ref={(el) => { if (el) el.indeterminate = state === "some"; }} onChange={() => m.toggleThing(row)} /></label>
                <span className="nm">{row.label}<small className="cf-kind">{row.changeText}</small></span>
                {row.conflict ? <span className="chip warn">{trText("Conflict")}</span> : <span className="chip">{trText("No conflict")}</span>}
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
        {!m.online && <div className="hint cf-warn" data-pcm="cf-offline">{trText("You are offline: you can \"Delete selected\" for now, then \"Merge\" once connected.")}</div>}
        {m.note && <div className="hint" role="status" data-pcm="cf-note">{m.note}</div>}
      </>}
    </Sheet>
  );
}

/** Fallback when the offline batch cannot yield per-item differences: whole-batch "Merge" (replay) or "Delete all" (discard, saving a local backup first) */
function PausedSheet(props: { onClose: () => void; done: () => void }) {
  const summary = pausedSummary();
  const queued = useSync((v) => v.paused?.queued ?? 0);
  return (
    <Sheet id="conflict" title={trText("Merge conflicts")} onClose={props.onClose} foot={
      <div className="cf-foot">
        <button type="button" className="btn primary" data-pcm="cf-merge" onClick={() => { replayOffline(); props.done(); }}>{trText("Merge")}</button>
        <button type="button" className="btn" data-pcm="cf-drop" onClick={() => { discardOffline(); props.done(); }}>{trText("Delete all")}</button>
        <button type="button" className="btn" data-pcm="cf-close" onClick={props.onClose}>{trText("Not now")}</button>
      </div>
    }>
      <div className="hint">{trText("You have {0} offline changes. The project changed in the meantime in the following ways, which may overlap with your changes:", queued)}</div>
      {summary.map((s, i) => (
        <div key={i} className="cf-group">
          <div className="cf-head"><span className="nm">{s.who}</span>{s.what.length ? <span className="chip warn">{trText("Conflict")}</span> : <span className="chip">{trText("No conflict")}</span>}</div>
          <div className="cf-sub">{s.what.length ? s.what.map((w, j) => <span key={j}>{w}</span>) : <span>{trText("(no specific locations listed)")}</span>}</div>
        </div>
      ))}
    </Sheet>
  );
}

/* ======================== Members ======================== */

export function MembersSheet(props: { info: MembersInfo; onClose: () => void }) {
  const toast = useToast();
  const { info } = props;
  const link = currentAccountProjectLink() ?? currentSharedUrl();
  const [deciding, setDeciding] = useState<string | null>(null);
  /** When "Approve" or "Reject" gets no reply, clicking again reuses the original request ID; once a result arrives it is dropped (`src/account/requestIds.ts`, shared with desktop) */
  const decisionIds = useRef(createRequestIds());
  // Join request (user decision, 2026-10-22): the creator clicks "Approve" or "Reject" in the members panel; the server accepts only the creator in person, and at the moment of approval it rechecks the ban list and whether the request still exists
  const decide = async (op: "approve-join" | "reject-join", row: AccountJoinRequestRow) => {
    const name = row.accountName ?? row.accountId;
    setDeciding(row.joinRequestId);
    try {
      await decisionIds.current.run(`${op}:${row.joinRequestId}`, (requestId) =>
        accountMemberAdmin({ op, accountId: row.accountId, joinRequestId: row.joinRequestId, requestId }));
      toast(op === "approve-join" ? JOIN_REQUEST_TEXT.approvedToast(name) : JOIN_REQUEST_TEXT.rejectedToast(name));
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : trText("Unable to process this request right now. Please try again."));
    } finally { setDeciding(null); info.refresh(); }
  };
  return (
    <Sheet id="members" title={info.unavailable ? trText("Members") : trText("Members: {0} · Agents: {1}", info.people, info.agents)} onClose={props.onClose}>
      {info.unavailable && <div className="hint">{trText("Unable to get project members right now.")}</div>}
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
        <h2 className="sec">{trText("Project members")}</h2>
      </div>}
      {info.lines.map((l) => (
        <div key={l.key} className="list-row" data-pcm="member-row">
          <div className={l.agent ? "i plum" : "i"}><Icon name={l.agent ? "card" : "person"} /></div>
          <div className="grow"><b>{l.name}{l.creator ? trText(" (creator)") : ""}</b><div className="hint" style={{ margin: 0 }}>{l.sub}</div></div>
          {l.agent ? <span className="chip plum">{l.sub === trText("Cloud") ? trText("Cloud") : "Agent"}</span> : <i className={l.online ? "dot" : "dot off"} />}
        </div>
      ))}
      {link && <button type="button" className="btn" style={{ width: "100%", marginTop: 6 }} data-pcm="copy-link" onClick={() => {
        void navigator.clipboard?.writeText(link).then(() => toast(trText("Project link copied")), () => toast(link));
      }}>{trText("Copy project link")}</button>}
    </Sheet>
  );
}

/* ======================== Export ======================== */

interface ExportRun { phase: "running" | "done" | "error" | "cancelled"; done: number; total: number; stage?: string; waiting?: string; message?: string; id?: string }

/** The same path as the desktop top bar's "Export video" (`exportProject` in `TopBar.tsx`, the online-page branch): first pick the method, then the save location, and export frame by frame in the browser */
export function ExportSheet(props: { onClose: () => void }) {
  const [run, setRun] = useState<ExportRun | null>(null);
  const idRef = useRef<string | null>(null);
  const start = async (mode: ExportMode) => {
    const project = getState().project;
    const pending = exportGateNow(project);
    if (pending && pending.length) { setRun({ phase: "error", done: 0, total: 1, message: awaitingUploaderMessage(pending) }); return; }
    let target: FileSystemFileHandle | null = null;
    try {
      target = await pickSaveTarget(`${project.name}.mp4`, trText("MP4 video"), { "video/mp4": [".mp4"] });
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
      setRun((s) => (s ? { ...s, phase: "done", done: s.total, message: note || (target ? trText("Saved as {0}", target.name) : trText("Saved to the browser's download location")) } : s));
    } catch (e) {
      const err = e as Error & { cancelled?: boolean };
      setRun((s) => (s ? { ...s, phase: err.cancelled ? "cancelled" : "error", message: err.message } : s));
    } finally {
      idRef.current = null;
    }
  };
  const pct = run && run.total > 0 ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0;
  return (
    <Sheet id="export" title={trText("Export")} onClose={() => { if (run?.phase !== "running") props.onClose(); }}>
      {(!run || run.phase !== "running") && ([["fast", ONLINE_EXPORT_TEXT.fast, ONLINE_EXPORT_TEXT.fastHint], ["full", ONLINE_EXPORT_TEXT.full, ONLINE_EXPORT_TEXT.fullHint]] as const).map(([mode, name, hint]) => (
        <div key={mode} className="row">
          <div className="t">{name}<small>{hint}</small></div>
          <button type="button" className="btn primary" data-pcm="export-start" data-mode={mode} onClick={() => void start(mode)}>{trText("Start")}</button>
        </div>
      ))}
      {run && (
        <div data-pcm="export-progress" data-phase={run.phase}>
          {run.phase === "running" && <div className="bar"><i style={{ width: `${pct}%` }} /></div>}
          <div className="hint">
            {run.phase === "running" ? (run.waiting ?? `${run.stage === "sound" ? trText("Generate sound") : trText("Rendering")} ${pct}%…`)
              : run.phase === "done" ? trText("Done · {0}", run.message ?? "") : run.phase === "cancelled" ? trText("Export canceled") : trText("Export failed: {0}", run.message ?? "")}
          </div>
          {run.phase === "running" && <button type="button" className="btn" style={{ width: "100%" }} onClick={() => { if (idRef.current) void cancelExport(idRef.current); }}>{trText("Cancel export")}</button>}
        </div>
      )}
    </Sheet>
  );
}


