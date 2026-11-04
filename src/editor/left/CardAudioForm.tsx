import { useRef, useState } from "react";
import type { TrackClip } from "../../kernel/project";
import { clipHasEmbeddedAudio } from "../../kernel/cardAudioRendition.mjs";
import { getCard } from "../../kernel/registry";
import { persistentCardAudio } from "../../audio/cardAudio";
import { actions, useStore } from "../../store/project";
import { cancelCardAudioGeneration, generateCardAudio } from "../io/cardAudioGeneration";
import { onlinePage } from "../../online/pageFlag";
import { clipSoundRunnable } from "../io/onlineSoundJudge";
import { tr } from "../../i18n/index.ts";

/** Audio inside a card attaches to the same clip. Generating is not separating the audio track; on failure the old audio or picture is not replaced. */
export function CardAudioForm({ clip }: { clip: TrackClip }) {
  const project = useStore(s => s.project);
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(0), [error, setError] = useState("");
  const active = useRef(false);
  if (!clipHasEmbeddedAudio(project, clip, getCard)) return null;
  const locked = project.tracks.find(track => track.clips.some(c => c.id === clip.id))?.locked;
  // Online page (`product/platforms.md`, "Platform boundaries for card audio"): audio cards that can run on this page can be synthesized in the browser (judged light); those that can't run keep using only the synced audio as before
  const online = onlinePage(), synthHere = !online || clipSoundRunnable(project, clip);
  let ready = false, status = tr("Card audio not generated yet");
  try { persistentCardAudio(project, clip); ready = true; status = tr("Audio saved; preview and export share the same WAV"); }
  catch (cause) { status = cause instanceof Error ? cause.message : String(cause); }
  const generate = async () => {
    if (active.current) return;
    active.current = true; setBusy(true); setProgress(0); setError("");
    try { await generateCardAudio(clip.id, { force: true, onProgress: (done, total) => setProgress(total ? done / total : 0) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { active.current = false; setBusy(false); }
  };
  return <section className="p-3 pc-left-divider-b text-xs" data-pc="card-audio-controls" aria-label={tr("Motion card audio")}>
    <div className="font-semibold mb-2">{tr("Card embedded audio")}</div>
    <p className="pc-left-muted mb-2">{status}</p>
    <p className="pc-left-muted mb-2">{tr("The audio and visuals belong to the same clip. It can be muted on its own but the audio track cannot be separated.")}</p>
    <div className="flex gap-2 flex-wrap">
      <button type="button" disabled={busy || locked || !synthHere} onClick={() => void generate()}>{ready ? tr("Regenerate audio") : tr("Generate sound")}</button>
      <button type="button" disabled={locked} aria-pressed={!!clip.audioMuted} onClick={() => {
        const result = actions.setClipMuted(clip.id, !clip.audioMuted);
        if (!result.ok) setError(result.error ?? tr("Mute operation failed"));
      }}>{clip.audioMuted ? tr("Restore audio") : tr("Mute card")}</button>
      {busy && <button type="button" onClick={() => cancelCardAudioGeneration(clip.id)}>{tr("Cancel generation")}</button>}
    </div>
    {busy && <p role="status" className="mt-2">{tr("Generating or uploading audio {0}%", Math.round(progress * 100))}</p>}
    {online && !synthHere && <p className="pc-left-muted mt-2">{tr("Generate and sync card audio locally; existing audio can be previewed here.")}</p>}
    {online && synthHere && !ready && <p className="pc-left-muted mt-2">{tr("Audio in the preview is synthesized instantly by the browser; clicking \"Generate audio\" or exporting saves it as synced audio.")}</p>}
    {error && <p role="alert" className="mt-2">{error}</p>}
  </section>;
}
