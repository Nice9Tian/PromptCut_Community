import { useEffect, useMemo, useState } from "react";
import { actions, useStore } from "../../store/project";
import type { MediaAsset, Project, TranscriptSegment } from "../../kernel/project";
import { timelineTimeAt } from "../../kernel/clipTime.mjs";
import { TranscribePanel } from "./TranscribePanel";
import { onlinePage } from "../../online/pageFlag";
import { onlineUnsupported } from "../../online/onlineUnsupported";
import { ReadOnlyFence } from "../ReadOnlyFence";
import { useReadOnly } from "../readOnly";
import { tr as trText } from "../../i18n/index.ts";

/**
 * Main body of the captions section: a two-level tree.
 * Parent nodes are "which video the transcript came from", child nodes are the paragraphs.
 * This way one search scans all media without having to pick a media first; clicking a paragraph
 * still moves the playhead to the matching position on the timeline.
 */

/** A media node + the paragraphs it should currently show (after a search it may keep only the matching ones) */
interface CaptionNode {
  media: MediaAsset;
  /** Carries the original index: click-to-seek and debug attributes use the original index, unaffected by filtering */
  rows: { seg: TranscriptSegment; index: number }[];
  total: number;
  /** Whether this media should still appear in the tree during a search */
  matched: boolean;
}

export function CaptionsTab({
  search,
  mediaId,
  onPick,
  onGoImport,
  revealToken = 0,
}: {
  search: string;
  mediaId: string | null;
  onPick: (id: string | null) => void;
  /** "Go to import" in the empty state: switch to the media library section */
  onGoImport?: () => void;
  /** Incremented when something outside (right-click "Transcribe captions") asks for focus: expands the mediaId item and scrolls it into view */
  revealToken?: number;
}) {
  const project = useStore((s) => s.project);
  const t = useStore((s) => s.t);
  /** Media being re-transcribed: its paragraphs give way to TranscribePanel for now */
  const [retranscribeId, setRetranscribeId] = useState<string | null>(null);
  /** Result notice for "Lay out as captions track", which disappears on its own after a few seconds */
  const [flash, setFlash] = useState<string | null>(null);
  /** Record of manual collapse/expand. Browse mode and search mode keep separate copies so they don't interfere */
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const [searchOpenMap, setSearchOpenMap] = useState<Record<string, boolean>>({});

  const q = search.trim().toLowerCase();
  // Images have no sound, so transcribing them is meaningless: the captions page lists only videos and soundtracks
  const spoken = useMemo(() => project.media.filter((m) => m.kind !== "image"), [project.media]);

  useEffect(() => {
    // If the selected media was deleted (or is an image), fall back to the first one
    if (mediaId && !spoken.some((m) => m.id === mediaId)) onPick(spoken[0]?.id ?? null);
  }, [mediaId, spoken, onPick]);

  useEffect(() => {
    // Clear manual collapses when the search term changes, otherwise nodes collapsed in the previous round would hide this round's hits
    setSearchOpenMap({});
  }, [q]);

  useEffect(() => {
    // External focus request: expand even if it was manually collapsed before, and scroll to that item
    if (!revealToken || !mediaId) return;
    setOpenMap((prev) => ({ ...prev, [mediaId]: true }));
    setSearchOpenMap((prev) => ({ ...prev, [mediaId]: true }));
    const raf = requestAnimationFrame(() => {
      const sel = `[data-pc-caption-media="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(mediaId) : mediaId}"]`;
      document.querySelector(sel)?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
  }, [revealToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(id);
  }, [flash]);

  /** Lay a transcript out as a captions track on the timeline (create/reuse a captions track + one captions card) */
  const build = (id: string) => {
    const r = actions.buildCaptions(id);
    setFlash(r.ok ? trText("Placed {0} captions on the \"Captions\" track", r.count) : r.reason);
  };

  const nodes = useMemo<CaptionNode[]>(
    () =>
      spoken.map((media) => {
        const segments = media.transcript?.segments ?? [];
        const all = segments.map((seg, index) => ({ seg, index }));
        if (!q) return { media, rows: all, total: segments.length, matched: true };
        // If the media name matches, keep the whole media, so a user who searches a video name doesn't see its paragraphs vanish
        const nameHit = media.name.toLowerCase().includes(q);
        const rows = nameHit ? all : all.filter(({ seg }) => seg.text.toLowerCase().includes(q));
        return { media, rows, total: segments.length, matched: nameHit || rows.length > 0 };
      }),
    [spoken, q],
  );

  if (spoken.length === 0) {
    return (
      <div className="pc-left-empty">
        <div>
          <div className="pc-left-empty-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M7 15h7M7 11h4" />
            </svg>
          </div>
          <div className="pc-left-empty-text">
            {trText("No media yet.")}
            <br />
            {trText("First import video or audio in the \"Media library\",")}
            <br />
            {trText("then come back to transcribe captions.")}
          </div>
          {onGoImport && (
            <button type="button" className="pc-left-empty-btn" onClick={onGoImport}>
              {trText("Go to import")}
            </button>
          )}
        </div>
      </div>
    );
  }

  // mediaId also decides "where the imported .srt attaches"; if none was ever selected, fall back to the first media that has a transcript
  const focusId = mediaId ?? spoken.find((m) => m.transcript)?.id ?? spoken[0]?.id ?? null;
  const visible = q ? nodes.filter((n) => n.matched) : nodes;
  const nothingTranscribed = spoken.every((m) => !m.transcript);

  /** By default only the currently focused one is expanded; during a search it becomes "expand if there are hits", so even with lots of media and paragraphs it never fills the whole screen */
  const isOpen = (n: CaptionNode) =>
    q ? (searchOpenMap[n.media.id] ?? n.rows.length > 0) : (openMap[n.media.id] ?? n.media.id === focusId);

  const setOpen = (id: string, open: boolean) => {
    const set = q ? setSearchOpenMap : setOpenMap;
    set((prev) => ({ ...prev, [id]: open }));
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {flash && <div className="pc-left-flash is-top">{flash}</div>}

      {nothingTranscribed && !q && (
        <div className="pc-left-hint is-bar">{trText("No captions yet. Click a media item below to start transcribing, or use \"Import .srt / .vtt\" above to import captions.")}</div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto pc-left-scroll" role="tree">
        {visible.length === 0 ? (
          <div className="p-4 text-center text-xs pc-left-muted">{trText("No matching captions")}</div>
        ) : (
          visible.map((node) => (
            <MediaNode
              key={node.media.id}
              node={node}
              open={isOpen(node)}
              focused={node.media.id === focusId}
              filtering={q.length > 0}
              project={project}
              t={t}
              retranscribing={retranscribeId === node.media.id}
              onToggle={(open) => {
                // Expanding / clicking the parent node must also claim focus, so importing an srt knows who to attach to
                onPick(node.media.id);
                setOpen(node.media.id, open);
              }}
              onRetranscribe={() => {
                onPick(node.media.id);
                setRetranscribeId(node.media.id);
                setOpen(node.media.id, true);
              }}
              onBuild={() => {
                onPick(node.media.id);
                build(node.media.id);
              }}
              onCloseTranscribe={() => setRetranscribeId(null)}
              onPickSelf={() => onPick(node.media.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** A media parent node: the first row is the video name + paragraph count, and expanding it shows its paragraphs (or the transcribe panel) */
function MediaNode({
  node,
  open,
  focused,
  filtering,
  project,
  t,
  retranscribing,
  onToggle,
  onRetranscribe,
  onBuild,
  onCloseTranscribe,
  onPickSelf,
}: {
  node: CaptionNode;
  open: boolean;
  focused: boolean;
  filtering: boolean;
  project: Project;
  t: number;
  retranscribing: boolean;
  onToggle: (open: boolean) => void;
  onRetranscribe: () => void;
  /** Lay this transcript out as a captions track on the timeline */
  onBuild: () => void;
  onCloseTranscribe: () => void;
  onPickSelf: () => void;
}) {
  const { media, rows, total } = node;
  // This project only grants read-only access (guest): the transcript can be read and paragraphs clicked to seek as usual, but transcribing, laying out a captions track and re-transcribing are all writes
  const ro = useReadOnly();
  const transcript = media.transcript;
  // Expanding media that has no transcript goes straight to the transcribe panel, so the original entry point isn't lost
  const showPanel = !transcript || retranscribing;

  const count = filtering && rows.length !== total ? trText("{0}/{1} segments", rows.length, total) : trText("{0} segments", total);

  return (
    <div className="pc-left-cap-node" role="treeitem" aria-expanded={open}>
      <button
        type="button"
        data-pc-caption-media={media.id}
        className={`pc-left-cap-head${focused ? " is-focused" : ""}`}
        onClick={() => onToggle(!open)}
        title={media.name}
      >
        <svg
          className={`shrink-0 pc-left-faint ${open ? "rotate-90" : ""}`}
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden="true"
        >
          <path d="M3.5 1.5 L7 5 L3.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="shrink-0 pc-left-faint" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M7 15h7M7 11h4" />
          </svg>
        </span>
        <span className="flex-1 truncate">{media.name}</span>
        <span className="shrink-0 tabular-nums text-[10px] pc-left-faint">
          {transcript ? count : trText("Not transcribed")}
          {media.duration ? ` · ${fmt(media.duration)}` : ""}
        </span>
      </button>

      {open &&
        (showPanel ? (
          <div className="p-2 pl-5">
            <ReadOnlyFence><TranscribePanel mediaId={media.id} onClose={onCloseTranscribe} /></ReadOnlyFence>
          </div>
        ) : (
          <div role="group">
            <div className="flex items-center gap-2 pl-5 pr-2 py-1 text-[10px] pc-left-faint">
              <span className="truncate">
                {transcript.engine} · {transcript.model}
                {transcript.language ? ` · ${transcript.language}` : ""}
              </span>
              {/* After transcription is complete, the next step is "place onto timeline". Previously only the AI
                  could do this step, leaving humans with no way forward after reading the transcript here: now
                  one click creates caption cards, and the timeline gets a captions track. */}
              <button
                type="button"
                className="ml-auto pc-left-btn is-sm"
                onClick={onBuild}
                disabled={ro.locked}
                title={ro.title(trText("Lay this transcript out as a captions track on the timeline"))}
              >
                {trText("Lay out as captions track")}
              </button>
              <button type="button" className="pc-left-btn is-sm" onClick={onRetranscribe} disabled={onlinePage() || ro.locked} title={ro.locked ? ro.why : onlinePage() ? onlineUnsupported(trText("Speech recognition")) : undefined}>
                {trText("Transcribe again")}
              </button>
            </div>
            {rows.length === 0 ? (
              <div className="pl-5 pr-2 pb-1.5 text-[11px] pc-left-faint">{trText("No matching passages in this transcript")}</div>
            ) : (
              <div className="pb-1">
                {rows.map(({ seg, index }) => {
                  const tl = timelineTimeOf(project, media.id, seg.start);
                  const active = tl != null && t >= tl && t < tl + Math.max(0.1, seg.end - seg.start);
                  return (
                    <button
                      key={index}
                      type="button"
                      data-pc-caption-seg={index}
                      className={`pc-left-cap-seg${active ? " is-active" : ""}${tl == null ? " is-offline" : ""}`}
                      title={tl == null ? trText("This media has not been placed on the timeline yet") : trText("Click to move the playhead there")}
                      onClick={() => {
                        onPickSelf();
                        if (tl != null) actions.seek(tl);
                      }}
                    >
                      <span className="shrink-0 tabular-nums pc-left-faint w-10">{fmt(seg.start)}</span>
                      <span className="flex-1 whitespace-pre-wrap break-words">{seg.text}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Seconds within the media → seconds on the timeline (find the clip that references it and convert by mediaOffset); returns null if it isn't on the timeline */
function timelineTimeOf(p: Project, mediaId: string, mediaSec: number): number | null {
  for (const tr of p.tracks) {
    for (const c of tr.clips) {
      if (c.mediaId !== mediaId) continue;
      const tl = timelineTimeAt(c, mediaSec); // Includes clip speed (kernel/clipTime.mjs)
      if (tl >= c.start - 1e-6 && tl < c.end) return tl;
    }
  }
  return null;
}
