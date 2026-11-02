import { useId, useMemo, useState } from "react";
import { actions, useStore } from "../../../store/project";
import type { MediaAsset, Project, TrackClip } from "../../../kernel/project";
import {
  describeTransition, transitionsOf, transitionsOfClip, TRANSITION_LABEL,
  type TransitionKind,
} from "../../../kernel/transitions";
import { clearDragPayload, MIME_TRANSITION, setDragPayload } from "../../dnd";
import { PreviewCard } from "../PreviewCard";
import { useReadOnly } from "../../readOnly";
import { usePreviewMediaUrl } from "../../media/previewUrl";
import { ThumbTile } from "./ThumbTile";
import type { GroupData, GroupItem } from "./groups";
import { tr as trText } from "../../../i18n/index.ts";

/**
 * Effects → transitions group.
 *
 * A transition is an **object**: adding one writes a record into the project that binds the clips it
 * references into a group. Their relative timing is locked; to move one on its own, change its
 * length, or cut it, you must first delete the transition (the rules are in kernel/transitions.ts).
 *
 * This group does three things:
 *   1. The three cards are the transitions themselves, dragged onto the timeline: dropped where two
 *      clips meet end to end = crossfade, dropped at the start / end of a clip = fade in / fade out.
 *      With a clip selected, a click also adds one directly;
 *   2. Below, the **existing transitions** are listed, and each can be deleted (after deleting, those
 *      clips are unlocked);
 *   3. Below that, the seams where clips meet end to end on the timeline are listed, with one click to
 *      join them into a crossfade.
 *
 * Overlap is not allowed within one track, so a crossfade pulls the later clip forward and, if
 * necessary, moves it to another track; when the transition is deleted it tries to put it back.
 */

const DURATIONS = [0.3, 0.5, 1, 1.5, 2];
const KINDS = ["crossfade", "fadeIn", "fadeOut"] as const;
/** Aspect ratio of the diagram card: the shapes all sit in a band in the middle, so a square is not needed */
const GLYPH_ASPECT = 0.75;

type Pair = { a: TrackClip; aTrack: string; b: TrackClip; bTrack: string };

/** Two media clips adjacent in time (or already overlapping), given in order */
function findPairs(p: Project): Pair[] {
  const all: Array<{ clip: TrackClip; trackId: string }> = [];
  for (const tr of p.tracks) {
    for (const c of tr.clips) {
      if (!c.mediaId) continue;
      const m = p.media.find((x) => x.id === c.mediaId);
      if (!m) continue;
      // Audio counts too: two overlapping music clips, each faded, make an audible crossfade, done the same way as for video
      all.push({ clip: c, trackId: tr.id });
    }
  }
  all.sort((x, y) => x.clip.start - y.clip.start);
  const pairs: Pair[] = [];
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i];
    const b = all[i + 1];
    // Only accept "end to end" or already overlapping: too far apart is not a transition point
    if (b.clip.start - a.clip.end > 0.001) continue;
    pairs.push({ a: a.clip, aTrack: a.trackId, b: b.clip, bTrack: b.trackId });
  }
  return pairs;
}

/** Static picture of a media clip: an image is placed directly, a video takes its first frame, audio has no picture so gets a flat color (the transition card only shows the dissolve, no playback) */
function Still({ media, style }: { media: MediaAsset | undefined; style?: React.CSSProperties }) {
  // On desktop this is media.url; in online browser mode it is replaced by the remote asset service address (media used only at small size gets only the small size); src is not set until ready
  const src = usePreviewMediaUrl(media) || undefined;
  if (!media) return <div style={{ ...style, background: "var(--ui-panel-2)" }} />;
  if (media.kind === "audio") {
    return (
      <div style={{ ...style, background: "var(--ui-panel-2)", display: "grid", placeItems: "center", color: "var(--ui-fg-faint)", fontSize: 10 }}>
        {trText("Sound")}
      </div>
    );
  }
  if (media.kind === "image") return <img src={src} alt="" draggable={false} style={style} />;
  return <video src={src} muted playsInline preload="metadata" draggable={false} style={style} />;
}

const layer: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" };

/**
 * Diagrams for the three transition cards: two color bands + a gradient, so you can see at a glance
 * whether it is "dissolving over" or "coming out of black".
 * Each instance uses its own gradient id: the overview thumbnail and the detail card are in the DOM
 * at the same time (the overview is only hidden),
 * and with duplicate names url(#id) would point at the hidden one, and the gradient would not draw.
 */
function TransitionGlyph({ kind }: { kind: TransitionKind }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const A = "var(--ui-accent)";
  const B = "var(--ui-track-video, #4FB3C9)";
  if (kind === "crossfade") {
    const id = `pc-xf-${uid}`;
    return (
      <svg viewBox="0 0 100 100" style={{ ...layer }} aria-hidden="true">
        <rect x="6" y="26" width="52" height="48" rx="4" fill={B} opacity="0.85" />
        <rect x="42" y="26" width="52" height="48" rx="4" fill={A} opacity="0.85" />
        <defs>
          <linearGradient id={id} x1="0" x2="1">
            <stop offset="0%" stopColor="#000" stopOpacity="0.55" />
            <stop offset="50%" stopColor="#000" stopOpacity="0" />
            <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
          </linearGradient>
        </defs>
        <rect x="42" y="26" width="16" height="48" fill={`url(#${id})`} />
      </svg>
    );
  }
  const id = `pc-${kind}-${uid}`;
  const dir = kind === "fadeIn" ? { x1: "0", x2: "1" } : { x1: "1", x2: "0" };
  return (
    <svg viewBox="0 0 100 100" style={{ ...layer }} aria-hidden="true">
      <defs>
        <linearGradient id={id} {...dir}>
          <stop offset="0%" stopColor={A} stopOpacity="0.05" />
          <stop offset="100%" stopColor={A} stopOpacity="0.95" />
        </linearGradient>
      </defs>
      <rect x="6" y="26" width="88" height="48" rx="4" fill={`url(#${id})`} />
    </svg>
  );
}

const KIND_HINT: Record<TransitionKind, string> = {
  crossfade: trText("Drag to where two clips meet end to end; the two clips will be bound as a group"),
  fadeIn: trText("Drag to the start of a clip (or select a clip and click once)"),
  fadeOut: trText("Drag to the end of a clip (or select a clip and click once)"),
};

/** q is the search term, already trimmed and lowercased; flash is the hint bar at the bottom of the section */
export function useTransitionsGroup(q: string, flash: (text: string, ms?: number) => void): GroupData {
  // This project only has read-only permission (guest): adding / deleting a transition are both writes
  const ro = useReadOnly();
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const [dur, setDur] = useState(0.5);
  const [hotIndex, setHotIndex] = useState<number | null>(null);

  const pairs = useMemo(() => findPairs(project), [project]);
  const transitions = transitionsOf(project);
  const mediaOf = (c: TrackClip) => project.media.find((m) => m.id === c.mediaId);
  const nameOf = (c: TrackClip) => mediaOf(c)?.name ?? trText("media");

  const apply = (pair: Pair) => {
    const r = actions.addTransition({ kind: "crossfade", clipId: pair.a.id, otherClipId: pair.b.id, dur });
    flash(r.ok ? trText("Added {0}s crossfade, these two clips are now a group", dur) : r.error);
  };

  /** Click a card: fade in / out is added to the selected clip; a crossfade needs two clips, so the user is told to drag or use the seam list below */
  const clickKind = (kind: TransitionKind) => {
    if (kind === "crossfade") {
      flash(trText("A crossfade needs two clips: drag this card to where two clips meet on the timeline, or use the seam list below"));
      return;
    }
    const clipId = selection[0];
    if (!clipId) {
      flash(trText("First select a clip on the timeline, then click {0}; or drag the card straight to the clip's {1}", trText(TRANSITION_LABEL[kind]), kind === "fadeIn" ? trText("Start") : trText("end")));
      return;
    }
    const r = actions.addTransition({ kind, clipId, dur });
    flash(r.ok ? trText("Added {0}s {1}", dur, trText(TRANSITION_LABEL[kind])) : r.error);
  };

  const drag = (kind: TransitionKind) => (e: React.DragEvent) => {
    e.dataTransfer.setData(MIME_TRANSITION, kind);
    e.dataTransfer.effectAllowed = "copy";
    setDragPayload({ kind: "transition", transition: kind, name: trText(TRANSITION_LABEL[kind]), duration: dur });
  };

  const kinds = KINDS.filter((k) => !q || trText(TRANSITION_LABEL[k]).toLowerCase().includes(q) || KIND_HINT[k].includes(q));

  const items: GroupItem[] = kinds.map((kind) => ({
    id: kind,
    aspect: GLYPH_ASPECT,
    node: (
      <PreviewCard
        attrs={{ "data-pc-transition": kind }}
        title={trText(TRANSITION_LABEL[kind])}
        subtitle={`${dur}s`}
        preview={<TransitionGlyph kind={kind} />}
        draggable
        edits
        onDragStart={drag(kind)}
        onDragEnd={clearDragPayload}
        onClick={() => clickKind(kind)}
        titleAttr={KIND_HINT[kind]}
        fill
      />
    ),
  }));

  const thumbs: GroupItem[] = kinds.map((kind) => ({
    id: kind,
    node: <ThumbTile title={trText(TRANSITION_LABEL[kind])} preview={<TransitionGlyph kind={kind} />} />,
  }));

  const detailTop = (
    <div className="pc-lib-block">
      <div className="pc-lib-label">{trText("Transition duration")}</div>
      <div className="pc-lib-seg">
        {DURATIONS.map((d) => (
          <button key={d} type="button" className={`pc-chip${dur === d ? " is-on" : ""}`} aria-pressed={dur === d} onClick={() => setDur(d)}>
            {d}s
          </button>
        ))}
      </div>
    </div>
  );

  const detailBottom = (
    <>
      {/* Transitions already added: each can be deleted, and after deleting those clips are unlocked */}
      {transitions.length > 0 && (
        <div className="pc-lib-block">
          <div className="pc-lib-label">
            <span>{trText("Existing transitions")}</span>
            <span>({transitions.length})</span>
          </div>
          <div className="pc-lib-rows">
            {transitions.map((tr) => (
              <div key={tr.id} className="pc-lib-row">
                <span className="pc-lib-row-text" title={describeTransition(project, tr)}>
                  {describeTransition(project, tr)}
                </span>
                <button
                  type="button"
                  className="pc-left-btn"
                  disabled={ro.locked}
                  title={ro.title(trText("Remove this transition and unlock the related clips"))}
                  onClick={() => {
                    const r = actions.removeTransition(tr.id);
                    flash(r.ok ? trText("Removed transition{0}", r.note ? `(${r.note})` : trText(", related clips unlocked")) : r.error);
                  }}
                >
                  {trText("Delete")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Seams where clips meet end to end on the timeline: one click to join into a crossfade */}
      <div className="pc-lib-block">
        <div className="pc-lib-label">{trText("Adjoining clips")}</div>
        {pairs.length === 0 ? (
          <div className="pc-left-note">
            {trText("No adjoining clips found.")}
            <br />
            {trText("Place two videos back to back on the timeline and their join points will be listed here.")}
          </div>
        ) : (
          <div className="pc-lib-grid">
            {pairs.map((pair, i) => {
              const has = transitionsOfClip(project, pair.a.id).some((tr) => tr.kind === "crossfade" && tr.bId === pair.b.id);
              const hot = hotIndex === i;
              // On hover, the later clip fades in and out over the earlier one back and forth, with period = the currently selected transition duration (one round trip each)
              const fadeStyle: React.CSSProperties = hot
                ? { ...layer, animation: `pc-xfade ${Math.max(0.3, dur) * 2}s ease-in-out infinite` }
                : { ...layer, opacity: 0 };
              return (
                <PreviewCard
                  key={`${pair.a.id}-${pair.b.id}`}
                  title={`${nameOf(pair.a)} → ${nameOf(pair.b)}`}
                  subtitle={has ? trText("Already grouped · {0}s", pair.a.end.toFixed(1)) : trText("Joined at {0}s", pair.a.end.toFixed(1))}
                  onHover={(v) => setHotIndex(v ? i : (cur) => (cur === i ? null : cur))}
                  preview={
                    <>
                      <Still media={mediaOf(pair.a)} style={layer} />
                      <Still media={mediaOf(pair.b)} style={fadeStyle} />
                    </>
                  }
                  titleAttr={has ? trText("These two clips are already bound as a group with a crossfade") : trText("Hover to preview the crossfade; click the button below to add it")}
                  footer={
                    <div className="pc-lib-card-foot">
                      <button type="button" className="pc-left-btn is-block" disabled={has || ro.locked} title={ro.title()} onClick={() => apply(pair)}>
                        {has ? trText("Transition added") : trText("Add crossfade")}
                      </button>
                    </div>
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </>
  );

  return { items, thumbs, detailTop, detailBottom, emptyDetail: <div className="pc-left-note">{trText("No matching transitions")}</div> };
}
