import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { actions, useStore } from "../../../store/project";
import { DEFAULT_MEDIA_DUR, type MediaAsset } from "../../../kernel/project";
import { clearDragPayload, MIME_MEDIA, setDragPayload } from "../../dnd";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu";
import { ConfirmDialog } from "../ConfirmDialog";
import { PreviewCard } from "../PreviewCard";
import { requestCaptions } from "../captionsBus";
import { AudioStrip } from "./AudioStrip";
import { useMediaTierPolicy, usePreviewMediaUrl } from "../../media/previewUrl";
import { mediaTierPolicy, originalMediaUrl, previewMediaUrl } from "../../../render/mediaTier";
import { ThumbTile } from "./ThumbTile";
import type { GroupData, GroupItem } from "./groups";
import { onlinePage } from "../../../online/pageFlag";
import { onlineUnsupported } from "../../../online/onlineUnsupported";
import { useReadOnly } from "../../readOnly";
import { tr } from "../../../i18n/index.ts";

/**
 * The three media library groups, video / image / audio: imported media.
 * Video and image use preview cards laid out by media aspect ratio (masonry layout); audio uses
 * audio bars with a waveform, one per row.
 * Dragging to the timeline and the context menu (transcribe captions / create as voice / get ratio /
 * delete media + confirm dialog) are all kept;
 * the context menu and confirm dialog are rendered persistently at the section level (the overlay of
 * useMediaMenu), so they can pop up in the overview, the detail and the search results.
 */

async function measureVideoDimensions(url: string): Promise<{ width: number; height: number }> {
  if (!url) {
    throw new Error(tr("Video URL is empty"));
  }
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.style.display = "none";
    document.body.appendChild(video);

    let finished = false;
    const cleanup = () => {
      if (!finished) {
        finished = true;
        if (video.parentNode) {
          video.parentNode.removeChild(video);
        }
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(tr("Timed out reading video metadata")));
    }, 5000);

    video.onloadedmetadata = () => {
      clearTimeout(timer);
      const width = video.videoWidth;
      const height = video.videoHeight;
      cleanup();
      if (width > 0 && height > 0) {
        resolve({ width, height });
      } else {
        reject(new Error(tr("Could not read a valid video size")));
      }
    };

    video.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(tr("Failed to load video metadata")));
    };

    video.src = url;
  });
}

async function measureImageDimensions(url: string): Promise<{ width: number; height: number }> {
  if (!url) {
    throw new Error(tr("Image URL is empty"));
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error(tr("Timed out reading image size"))), 5000);
    img.onload = () => {
      clearTimeout(timer);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      } else {
        reject(new Error(tr("Could not read a valid image size")));
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error(tr("Failed to load image")));
    };
    img.src = url;
  });
}

/** The wording in the empty state and "No matching…" follows the group, so the audio group does not say "video" */
const KIND_NOUN: Record<MediaAsset["kind"], string> = { video: tr("Video"), audio: tr("Background music"), image: tr("Images") };

/** Duration written as m:ss (0:13), used by both the badge and the audio bar */
export function fmtDur(sec: number | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Height / width; undefined if the size was not measured, layout falls back to 9/16 */
const aspectOf = (m: MediaAsset): number | undefined =>
  m.width && m.height && m.width > 0 && m.height > 0 ? m.height / m.width : undefined;

const transcriptNote = (m: MediaAsset): string | undefined =>
  m.transcript ? tr("Captions: {0} segments", m.transcript.segments.length) : undefined;

function startMediaDrag(e: React.DragEvent, m: MediaAsset) {
  e.dataTransfer.setData(MIME_MEDIA, m.id);
  e.dataTransfer.effectAllowed = "copy";
  setDragPayload({ kind: "media", mediaId: m.id, name: m.name, duration: m.duration ?? DEFAULT_MEDIA_DUR });
}

/**
 * Preview card for video / image. Video: rests on the first frame, loops muted on hover, with an
 * accent-color progress bar on the bottom edge following the playback position (view only, not
 * draggable), duration at the bottom left; image: the whole picture is cropped to fill by aspect
 * ratio, with the size written below.
 */
function MediaTile({ m, onContextMenu }: { m: MediaAsset; onContextMenu: (e: React.MouseEvent) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hot, setHot] = useState(false);
  // On desktop this is m.url; in online browser mode it is replaced by the remote asset service address (media used only at small size gets only the small size); src is not set until ready
  const src = usePreviewMediaUrl(m) || undefined;
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (hot) {
      v.currentTime = 0;
      // If the browser rejects autoplay, never mind, the first frame is still there
      v.play().catch(() => {});
    } else {
      v.pause();
      // Back to the first frame: the next hover starts from the beginning, and when not hovered the card still shows a recognizable frame
      try { v.currentTime = 0; } catch { /* Metadata not loaded yet */ }
      setProgress(null);
    }
  }, [hot]);

  const preview =
    m.kind === "image" ? (
      <img src={src} alt="" draggable={false} />
    ) : (
      <video
        ref={videoRef}
        src={src}
        muted
        loop
        playsInline
        preload="metadata"
        draggable={false}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          if (hot && el.duration > 0) setProgress(el.currentTime / el.duration);
        }}
      />
    );

  const subtitle =
    m.kind === "image" ? (m.width && m.height ? `${m.width}×${m.height}` : undefined) : transcriptNote(m);

  return (
    <PreviewCard
      attrs={{ "data-pc-media": m.id }}
      title={m.name}
      subtitle={subtitle}
      badge={m.kind === "video" ? fmtDur(m.duration) : undefined}
      preview={preview}
      progress={m.kind === "video" && hot ? (progress ?? 0) : null}
      onHover={setHot}
      draggable
      edits
      onDragStart={(e) => startMediaDrag(e, m)}
      onDragEnd={clearDragPayload}
      onContextMenu={onContextMenu}
      titleAttr={m.kind === "video" ? tr("Hover to preview; drag = drag to the timeline; right-click = more") : tr("Drag = drag to the timeline; right-click = more")}
      fill
    />
  );
}

/**
 * Thumbnail in the overview: image / video first frame + duration badge.
 * Video: while the pointer rests on this cell it loops muted from the start; when it moves away it
 * stops and returns to the first frame (only the hovered cell plays);
 * apart from that it takes no interaction, and a click still bubbles up to the group box to open the group.
 * When the cell is hidden as a whole (a group was opened, the section switched away, the drawer
 * collapsed) mouseleave may not be received,
 * so on every timeupdate during playback it also checks whether it still has a layout box, and stops if not.
 */
function MediaThumb({ m }: { m: MediaAsset }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const src = usePreviewMediaUrl(m) || undefined;

  const stop = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    try { v.currentTime = 0; } catch { /* Metadata not loaded yet */ }
  }, []);

  const onHover = useCallback(
    (hot: boolean) => {
      const v = videoRef.current;
      if (!v) return;
      if (!hot) {
        stop();
        return;
      }
      try { v.currentTime = 0; } catch { /* Metadata not loaded yet */ }
      // If the browser rejects autoplay, or the pointer moves away before playback starts (play interrupted by pause), never mind, the first frame is still there
      v.play().catch(() => {});
    },
    [stop],
  );

  if (m.kind === "image") {
    return <ThumbTile preview={<img src={src} alt="" draggable={false} />} />;
  }
  return (
    <ThumbTile
      badge={fmtDur(m.duration)}
      onHover={onHover}
      preview={
        <video
          ref={videoRef}
          src={src}
          muted
          loop
          playsInline
          preload="metadata"
          draggable={false}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            if (!v.paused && v.getClientRects().length === 0) stop();
          }}
        />
      }
    />
  );
}

const audioSub = (m: MediaAsset) => [fmtDur(m.duration), transcriptNote(m)].filter(Boolean).join(" · ");

/** One audio bar: name + duration (+ number of caption segments, if any), with the full waveform as background. The transcribe entry is in the context menu */
function AudioRow({ m, onContextMenu }: { m: MediaAsset; onContextMenu: (e: React.MouseEvent) => void }) {
  const url = usePreviewMediaUrl(m) || undefined;
  return (
    <AudioStrip
      attrs={{ "data-pc-media": m.id }}
      className="is-grab"
      name={m.name}
      sub={audioSub(m)}
      url={url}
      draggable
      edits
      onDragStart={(e) => startMediaDrag(e, m)}
      onDragEnd={clearDragPayload}
      onContextMenu={onContextMenu}
      title={tr("Drag = drop on timeline; right-click = transcribe captions / delete")}
    />
  );
}

function EmptyMedia({ noun }: { noun: string }) {
  return (
    <div className="pc-left-empty">
      <div>
        <div className="pc-left-empty-icon" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M10 9l5 3-5 3z" />
          </svg>
        </div>
        <div className="pc-left-empty-text">
          {tr("No imported {0} yet.", noun)}
          <br />
          {tr("Click the import button above to add some.")}
        </div>
      </div>
    </div>
  );
}

/**
 * Context menu for media + delete confirm dialog. The section calls it once and puts the overlay in
 * the section root node, rendered persistently.
 * Menu items: transcribe / view captions (only with audio), create as voice (video only), get ratio
 * (only with picture), delete.
 */
export function useMediaMenu(flash: (text: string, ms?: number) => void) {
  const [ctx, setCtx] = useState<{ x: number; y: number; media: MediaAsset } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ mediaId: string; name: string } | null>(null);
  // This project only has read-only permission (guest): the context menu keeps only "View captions"; the rest (transcribe, create as voice, change project ratio, delete) are writes, so they are greyed out with an explanation
  const ro = useReadOnly();

  const openMenu = useCallback((e: React.MouseEvent, m: MediaAsset) => {
    e.preventDefault();
    setCtx({ x: e.clientX, y: e.clientY, media: m });
  }, []);
  const closeMenu = useCallback(() => setCtx(null), []);

  const guardMenu = (items: ContextMenuItem[]): ContextMenuItem[] =>
    ro.locked ? items.map((it) => (it.label === tr("View captions") ? it : { ...it, disabled: true, title: ro.why })) : items;

  const handleApplyAspectRatio = async (m: MediaAsset) => {
    try {
      let width = m.width;
      let height = m.height;
      if (!width || !height || width <= 0 || height <= 0) {
        // Images must be measured with <img>; reading them with <video> only reports "failed to load video metadata"
        // The measurement must use the original size (measuring a small size would set the aspect ratio too
        // small): on desktop m.url as is, on the online page the original size on the remote asset service.
        // The lowest tier does not fetch the original size normally: if the media has no recorded width and
        // height, it is not measured, and that is stated honestly
        const policy = mediaTierPolicy();
        const url = policy.smallOnly ? "" : originalMediaUrl(m, policy);
        if (!url) { alert(tr("This media has no recorded resolution and it can't be measured on this device")); return; }
        const measured = m.kind === "image" ? await measureImageDimensions(url) : await measureVideoDimensions(url);
        width = measured.width;
        height = measured.height;
      }
      if (width > 0 && height > 0) {
        actions.setProjectMeta({ width, height });
      } else {
        alert(tr("Could not get a valid video resolution"));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(tr("Failed to get video resolution: {0}", msg));
    }
  };

  const menuItems = (m: MediaAsset): ContextMenuItem[] => guardMenu([
    ...(m.kind === "image"
      ? []
      : [
          {
            label: m.transcript ? tr("View captions") : tr("Transcribe captions"),
            hint: m.transcript ? tr("{0} segments", m.transcript.segments.length) : undefined,
            // Online browser mode has no speech recognition (C10 contract, section 10): media without captions can only be transcribed, greyed out; media that already has captions can be viewed as usual
            ...(!m.transcript && onlinePage() ? { disabled: true, title: onlineUnsupported(tr("Speech recognition")) } : {}),
            // Go through the global entry: the left rail switches to the "Captions" section, expands the drawer, and focuses this media
            onClick: () => requestCaptions(m.id),
          },
        ]),
    // Derive a "sound only" copy from the video: same file, no transcoding; dragged onto the timeline it becomes an audio-only segment
    ...(m.kind === "video"
      ? [
          {
            label: tr("Create as sound"),
            hint: tr("Audio group"),
            onClick: () => {
              const r = actions.audioFromVideo(m.id);
              flash(
                r.ok
                  ? r.created
                    ? tr("Created \"{0}\" in the \"Audio\" group", r.media.name)
                    : tr("\"{0}\" was already created, in the \"Audio\" group", r.media.name)
                  : r.error,
                3000,
              );
            },
          },
        ]
      : []),
    ...(m.kind === "audio"
      ? []
      : [
          {
            label: m.kind === "image" ? tr("Use image aspect ratio as project aspect ratio") : tr("Use video aspect ratio as project aspect ratio"),
            hint: m.width && m.height && m.width > 0 && m.height > 0 ? `${m.width}x${m.height}` : undefined,
            onClick: () => handleApplyAspectRatio(m),
          },
        ]),
    {
      label: tr("Delete media"),
      danger: true,
      onClick: () => setConfirmDelete({ mediaId: m.id, name: m.name }),
    },
  ]);

  const overlay = (
    <>
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={menuItems(ctx.media)} onClose={closeMenu} />}
      {confirmDelete && (
        <ConfirmDialog
          open={true}
          title={tr("Delete media")}
          message={tr("Delete \"{0}\"?\nClips on the timeline that reference it will be deleted too.", confirmDelete.name)}
          onConfirm={() => {
            actions.removeMedia(confirmDelete.mediaId);
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  );

  return { openMenu, overlay };
}

/** Group content for one kind of media. q is the search term, already trimmed and lowercased */
export function useMediaGroup(
  kind: MediaAsset["kind"],
  q: string,
  openMenu: (e: React.MouseEvent, m: MediaAsset) => void,
): GroupData {
  const allMedia = useStore((s) => s.project.media);
  const tierPolicy = useMediaTierPolicy();
  return useMemo(() => {
    const list = allMedia.filter((m) => m.kind === kind);
    const hits = q ? list.filter((m) => m.name.toLowerCase().includes(q)) : list;
    const noun = KIND_NOUN[kind];
    const items: GroupItem[] = hits.map((m) =>
      kind === "audio"
        ? { id: m.id, node: <AudioRow m={m} onContextMenu={(e) => openMenu(e, m)} /> }
        : { id: m.id, aspect: aspectOf(m), node: <MediaTile m={m} onContextMenu={(e) => openMenu(e, m)} /> },
    );
    const thumbs: GroupItem[] = hits.slice(0, 2).map((m) => ({
      id: m.id,
      node: kind === "audio" ? <AudioStrip name={m.name} sub={audioSub(m)} url={previewMediaUrl(m, tierPolicy) || undefined} /> : <MediaThumb m={m} />,
    }));
    return {
      items,
      thumbs,
      emptyDetail: list.length === 0 ? <EmptyMedia noun={noun} /> : <div className="pc-left-note">{tr("No matching {0}", noun)}</div>,
    };
  }, [allMedia, kind, q, openMenu, tierPolicy]);
}
