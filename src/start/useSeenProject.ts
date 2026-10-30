/**
 * 此刻连着的那个项目:把它的画幅、时长和首帧记下来,开始页那一格下次就显示真画面(规则见 `thumbCache.ts` 文件头)。
 *
 * 首帧的取法和手机版素材格子同一套(`src/mobile/Thumb.tsx` 的 `useThumb`):经素材服务带只读票据的预览地址解码、缩成小 JPEG,
 * 素材服务还没收全就先不取、取不到隔一会儿再试几次。取哪一段:0 秒那一刻(没有就最早出现的)可见的视频 / 图片素材段,
 * 序列越靠上越优先(和舞台上的叠放一致);时间轴上还没有素材段时取素材库里第一份视频 / 图片;
 * 只有卡片、没有素材的项目取不到,开始页那一格退回色块。
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
      // 先比谁先出现(盖住 0 秒的都算 0),再比序列靠上(下标小)
      const rank = Math.max(0, c.start) * 1000 + ti;
      if (!best || rank < best.rank) best = { clip: c, rank };
    }
  });
  if (best) {
    const clip = (best as { clip: TrackClip }).clip;
    const media = p.media.find((m) => m.id === clip.mediaId);
    if (media) return { media, t: Math.max(0, clip.mediaOffset ?? 0) };
  }
  // 时间轴上还没有素材段(刚建的项目只把素材放进了素材库):取素材库里第一份视频 / 图片
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
