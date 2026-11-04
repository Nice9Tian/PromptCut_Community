/**
 * The project that is currently connected: record its aspect ratio, duration and first frame, so that
 * the next time its cell on the start page shows the real picture (rules in the header of
 * `thumbCache.ts`).
 *
 * The first frame is taken the same way as the mobile app's media cells (`useThumb` in
 * `src/mobile/Thumb.tsx`): decoded through a preview URL of the asset service that carries a read-only
 * ticket and shrunk to a small JPEG; if the asset service has not received everything yet, it is not
 * taken for now, and if it cannot be taken, it is retried a few times after a pause. Which media clip is
 * used: the visible video / image media clip at second 0 (or, if there is none, the one that appears
 * earliest), with higher tracks taking priority (consistent with the stacking on the stage); when the
 * timeline has no media clip yet, the first video / image in the media library is used; a project with
 * only cards and no media yields nothing, and its cell on the start page falls back to a color block.
 */
import { useEffect, useMemo } from "react";
import type { MediaAsset, Project, TrackClip } from "../kernel/project";
import { useStore } from "../store/project";
import { useThumb } from "../mobile/Thumb";
import { clipKind } from "../mobile/mainContent";
import { ratioOf } from "./format";
import { rememberSeen } from "./thumbCache";

function firstVisual(p: Project): { media: MediaAsset; t: number } | null {
  let best: { clip: TrackClip; rank: number } | null = null;
  p.tracks.forEach((tr, ti) => {
    if (tr.hidden) return;
    for (const c of tr.clips) {
      const k = clipKind(p, c);
      if (k !== "video" && k !== "image") continue;
      // First compare who appears first (anything covering second 0 counts as 0), then compare which track is higher (smaller index)
      const rank = Math.max(0, c.start) * 1000 + ti;
      if (!best || rank < best.rank) best = { clip: c, rank };
    }
  });
  if (best) {
    const clip = (best as { clip: TrackClip }).clip;
    const media = p.media.find((m) => m.id === clip.mediaId);
    if (media) return { media, t: Math.max(0, clip.mediaOffset ?? 0) };
  }
  // The timeline has no media clip yet (a newly created project has only put media into the media library): take the first video / image in the media library
  const lib = p.media.find((m) => m.kind === "video" || m.kind === "image");
  return lib ? { media: lib, t: 0 } : null;
}

export function useSeenProject(projectId: string | null): void {
  const project = useStore((s) => s.project);
  const live = projectId ? project : null;
  const pick = useMemo(() => (live ? firstVisual(live) : null), [live]);
  const thumb = useThumb(pick?.media ?? null, pick?.t ?? 0);

  useEffect(() => {
    if (!projectId) return;
    rememberSeen(projectId, { seenAt: new Date().toISOString() });
  }, [projectId]);
  useEffect(() => {
    if (!projectId) return;
    rememberSeen(projectId, { ratio: ratioOf(project.width, project.height), duration: Number.isFinite(project.duration) ? project.duration : null });
  }, [projectId, project.width, project.height, project.duration]);
  useEffect(() => {
    if (projectId && thumb.src) rememberSeen(projectId, { thumb: thumb.src });
  }, [projectId, thumb.src]);
}
