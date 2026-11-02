import type { CSSProperties } from "react";
import type { Project, Track, TrackClip } from "../../kernel/project";
import { IconVolumeMute } from "../../ui/icons";
import { clipSpeed, speedLabel } from "../../kernel/clipTime.mjs";
import { clipMakesNoSound } from "./clipSilence";
import { tr } from "../../i18n/index.ts";

export function clipMuteReason(clip: Pick<TrackClip, "audioMuted" | "audioVolume"> & Partial<Pick<TrackClip, "speed" | "mediaId">>, track: Pick<Track, "muted">, project?: Pick<Project, "cardNodes" | "media">): string | null {
  if (clip.audioMuted) return tr("Clip muted");
  // 变速段不出原声,但挂在它上面的声画一体卡照常出声、音频素材效果卡也出声(2026-10-23 用户定,
  // 语义 `product/project-model.md`「声音」)。所以只有**一点声音都不出**时才标,别把在出声的段标成没声音
  if (project && clipMakesNoSound(project, clip)) return tr("Speed changed to {0}, the retimed segment has no original sound", speedLabel(clipSpeed(clip)));
  if (track.muted) return tr("Track muted");
  if (clip.audioVolume === 0) return tr("Clip volume is 0, muted");
  return null;
}

/** 短片段把图标画在裁切框外；标记不改变片段宽度与鼠标命中区域。 */
export function ClipMuteBadge({ reason, label, compact = false, style }: { reason: string; label?: string; compact?: boolean; style?: CSSProperties }) {
  const title = tr("{0}: {1}", label || tr("Clips"), reason);
  return <span className={`pc-clip-mute-badge${compact ? " is-compact" : ""}`} data-pc="clip-muted" title={title} role="img" aria-label={title} style={style}>
    <IconVolumeMute size={12} />
    <span className={compact ? "sr-only" : ""}>{tr("Muted")}</span>
  </span>;
}

export function reportClipAudioResult(result: { ok: boolean; error?: string }, notify: (message: string) => void): boolean {
  if (!result.ok) notify(result.error || tr("Audio operation failed, clip not modified"));
  return result.ok;
}
