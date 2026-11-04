import type { CSSProperties } from "react";
import type { Project, Track, TrackClip } from "../../kernel/project";
import { IconVolumeMute } from "../../ui/icons";
import { clipSpeed, speedLabel } from "../../kernel/clipTime.mjs";
import { clipMakesNoSound } from "./clipSilence";
import { tr } from "../../i18n/index.ts";

export function clipMuteReason(clip: Pick<TrackClip, "audioMuted" | "audioVolume"> & Partial<Pick<TrackClip, "speed" | "mediaId">>, track: Pick<Track, "muted">, project?: Pick<Project, "cardNodes" | "media">): string | null {
  if (clip.audioMuted) return tr("Clip muted");
  // A speed-changed clip plays no original sound, but an audio-visual card attached to it still plays,
  // and so does an audio media effect card (user decision, 2026-10-23, semantics `product/project-model.md`
  // "Sound"). So mark it only when **no sound at all** is produced; do not mark a clip that does play as silent
  if (project && clipMakesNoSound(project, clip)) return tr("Speed changed to {0}, the retimed segment has no original sound", speedLabel(clipSpeed(clip)));
  if (track.muted) return tr("Track muted");
  if (clip.audioVolume === 0) return tr("Clip volume is 0, muted");
  return null;
}

/** For short clips the icon is drawn outside the crop box; the badge does not change clip width or the mouse hit area. */
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
