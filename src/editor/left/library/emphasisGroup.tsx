import { useMemo, useState } from "react";
import { actions, useStore } from "../../../store/project";
import type { Project, TrackClip } from "../../../kernel/project";
import { describeEmphasis, EMPHASIS_DEFAULTS, EMPHASIS_LABEL, type ClipEmphasis, type EmphasisKind } from "../../../kernel/emphasis";
import { clearDragPayload, MIME_EMPHASIS, setDragPayload } from "../../dnd";
import { PreviewCard } from "../PreviewCard";
import { useReadOnly } from "../../readOnly";
import { ThumbTile } from "./ThumbTile";
import type { GroupData, GroupItem } from "./groups";
import { tr as trText } from "../../../i18n/index.ts";

/**
 * Effects → emphasis group: add a "shadow" or "outline" to a clip.
 *
 * Both **follow the edge of the opaque part of the picture** (CSS drop-shadow works on alpha), so
 * what gets outlined is the edge of text, shapes and cutouts, not the bounding box: cards with a
 * transparent background look good when outlined (kernel/emphasis.ts).
 *
 * Two ways to use it: drag a card onto a segment on the timeline, or select a clip and click once.
 * Below, the clips that already have emphasis are listed, and each can be removed. Thickness and
 * color are chosen above, then drag / click after choosing.
 */

/** Thickness: three tiers are enough; for exact values, have the Agent or the parameters page adjust them */
const SIZES: { key: string; label: string; shadow: number; outline: number }[] = [
  { key: "s", label: trText("Thin"), shadow: 10, outline: 3 },
  { key: "m", label: trText("Medium"), shadow: 18, outline: 6 },
  { key: "l", label: trText("Thick"), shadow: 30, outline: 12 },
];

/** Color: besides black and white, one theme accent color; using it for a "glow edge" outline is very common */
const COLORS: { key: string; label: string; css: string }[] = [
  { key: "black", label: trText("Black"), css: "#000000" },
  { key: "white", label: trText("White"), css: "#ffffff" },
  { key: "accent", label: trText("Accent color"), css: "var(--ui-accent, #00dbdb)" },
];

const KINDS = ["shadow", "outline"] as const;
/** Height-to-width ratio of the schematic card */
const GLYPH_ASPECT = 0.75;

/** Schematic on the card face: a shape on a transparent background plus the shadow / outline it should have, so the difference between the two is clear at a glance */
function EmphasisGlyph({ kind, color, size }: { kind: EmphasisKind; color: string; size: number }) {
  // The schematic uses a 100×100 coordinate system; converting from stage pixels, divide by about 12
  const px = Math.max(1.5, size / 12);
  const filter =
    kind === "shadow"
      ? `drop-shadow(0 ${px}px ${px * 1.6}px ${color})`
      : [0, 45, 90, 135, 180, 225, 270, 315]
          .map((deg) => {
            const a = (deg * Math.PI) / 180;
            return `drop-shadow(${(Math.cos(a) * px).toFixed(2)}px ${(Math.sin(a) * px).toFixed(2)}px 0 ${color})`;
          })
          .join(" ");
  return (
    <svg viewBox="0 0 100 100" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} aria-hidden="true">
      {/* Transparent background: the checkerboard faintly shows through, indicating "the background is transparent, what is outlined is the edge of the shape" */}
      <g style={{ filter }}>
        <text x="50" y="46" textAnchor="middle" fontSize="30" fontWeight="700" fill="var(--ui-fg, #fff)">A a</text>
        <circle cx="50" cy="70" r="11" fill="var(--ui-track-video, #4FB3C9)" />
      </g>
    </svg>
  );
}

/** Clips on the timeline that already have emphasis */
function withEmphasis(p: Project): Array<{ clip: TrackClip; trackName: string }> {
  const out: Array<{ clip: TrackClip; trackName: string }> = [];
  for (const tr of p.tracks) {
    for (const c of tr.clips) if (c.emphasis) out.push({ clip: c, trackName: tr.name });
  }
  return out.sort((a, b) => a.clip.start - b.clip.start);
}

export function useEmphasisGroup(q: string, flash: (text: string, ms?: number) => void): GroupData {
  // This project grants only read-only access (guest): adding emphasis / removing emphasis are both writes
  const ro = useReadOnly();
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const [sizeKey, setSizeKey] = useState("m");
  const [colorKey, setColorKey] = useState("black");

  const size = SIZES.find((s) => s.key === sizeKey) ?? SIZES[1];
  const color = COLORS.find((c) => c.key === colorKey) ?? COLORS[0];
  const marked = useMemo(() => withEmphasis(project), [project]);

  const buildEmphasis = (kind: EmphasisKind): ClipEmphasis => ({
    kind,
    color: color.css,
    size: kind === "shadow" ? size.shadow : size.outline,
    opacity: EMPHASIS_DEFAULTS[kind].opacity,
    dx: EMPHASIS_DEFAULTS[kind].dx,
    dy: kind === "shadow" ? Math.round(size.shadow * 0.45) : 0,
  });

  const clickKind = (kind: EmphasisKind) => {
    const clipId = selection[0];
    if (!clipId) {
      flash(trText("First select a clip on the timeline, then click {0}; or drag the card straight onto that clip", trText(EMPHASIS_LABEL[kind])));
      return;
    }
    const r = actions.setClipEmphasis(clipId, buildEmphasis(kind));
    flash(r.ok ? trText("Added {0}: {1}", trText(EMPHASIS_LABEL[kind]), describeEmphasis(r.emphasis)) : (r.error ?? trText("Can't add")));
  };

  const drag = (kind: EmphasisKind) => (e: React.DragEvent) => {
    e.dataTransfer.setData(MIME_EMPHASIS, kind);
    e.dataTransfer.effectAllowed = "copy";
    setDragPayload({ kind: "emphasis", emphasis: buildEmphasis(kind), name: trText(EMPHASIS_LABEL[kind]), duration: 0 });
  };

  const nameOf = (c: TrackClip) =>
    c.label || project.media.find((m) => m.id === c.mediaId)?.name || c.cardId || c.id;

  const kinds = KINDS.filter((k) => !q || trText(EMPHASIS_LABEL[k]).toLowerCase().includes(q));
  const px = (kind: EmphasisKind) => (kind === "shadow" ? size.shadow : size.outline);

  const items: GroupItem[] = kinds.map((kind) => ({
    id: kind,
    aspect: GLYPH_ASPECT,
    node: (
      <PreviewCard
        attrs={{ "data-pc-emphasis": kind }}
        title={trText(EMPHASIS_LABEL[kind])}
        subtitle={`${px(kind)}px · ${color.label}`}
        preview={<EmphasisGlyph kind={kind} color={color.css} size={px(kind)} />}
        draggable
        edits
        onDragStart={drag(kind)}
        onDragEnd={clearDragPayload}
        onClick={() => clickKind(kind)}
        titleAttr={trText("Drag onto a clip on the timeline (or select a clip and click once). {0}", kind === "shadow" ? trText("The shadow falls beneath the opaque part of the image") : trText("The outline runs once around the edge of the opaque part"))}
        fill
      />
    ),
  }));

  const thumbs: GroupItem[] = kinds.map((kind) => ({
    id: kind,
    node: <ThumbTile title={trText(EMPHASIS_LABEL[kind])} preview={<EmphasisGlyph kind={kind} color={color.css} size={px(kind)} />} />,
  }));

  const detailTop = (
    <div className="pc-lib-block">
      <div className="pc-lib-label">{trText("Thickness")}</div>
      <div className="pc-lib-seg">
        {SIZES.map((s) => (
          <button key={s.key} type="button" className={`pc-chip${sizeKey === s.key ? " is-on" : ""}`} aria-pressed={sizeKey === s.key} onClick={() => setSizeKey(s.key)}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="pc-lib-label is-spaced">{trText("Color")}</div>
      <div className="pc-lib-seg">
        {COLORS.map((c) => (
          <button
            key={c.key}
            type="button"
            title={c.label}
            aria-label={c.label}
            aria-pressed={colorKey === c.key}
            className={`pc-lib-color${colorKey === c.key ? " is-on" : ""}`}
            style={{ background: c.css }}
            onClick={() => setColorKey(c.key)}
          />
        ))}
        <span className="pc-lib-seg-note">{color.label}</span>
      </div>
    </div>
  );

  const detailBottom = (
    <div className="pc-lib-block">
      <div className="pc-lib-label">
        <span>{trText("Emphasis added")}</span>
        <span>({marked.length})</span>
      </div>
      {marked.length === 0 ? (
        <div className="pc-left-note">
          {trText("None added yet. Drag a card from above onto any clip on the timeline, or select a clip and then click a card.")}
          <br />
          {trText("Both follow the edge of the opaque part of the image, so cards with a transparent background and cut-out people show the effect best.")}
        </div>
      ) : (
        <div className="pc-lib-rows">
          {marked.map(({ clip, trackName }) => (
            <div key={clip.id} className="pc-lib-row">
              <span className="pc-lib-row-text" title={`${trackName} · ${describeEmphasis(clip.emphasis)}`}>
                {nameOf(clip)}
                <span className="pc-left-faint"> · {describeEmphasis(clip.emphasis)}</span>
              </span>
              <button
                type="button"
                className="pc-left-btn"
                disabled={ro.locked}
                title={ro.title()}
                onClick={() => {
                  actions.setClipEmphasis(clip.id, null);
                  flash(trText("Emphasis removed"));
                }}
              >
                {trText("Remove")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return { items, thumbs, detailTop, detailBottom, emptyDetail: <div className="pc-left-note">{trText("No matching emphasis")}</div> };
}
