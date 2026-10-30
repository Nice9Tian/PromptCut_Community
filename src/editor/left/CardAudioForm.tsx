import { useRef, useState } from "react";
import type { TrackClip } from "../../kernel/project";
import { clipHasEmbeddedAudio } from "../../kernel/cardAudioRendition.mjs";
import { getCard } from "../../kernel/registry";
import { persistentCardAudio } from "../../audio/cardAudio";
import { actions, useStore } from "../../store/project";
import { cancelCardAudioGeneration, generateCardAudio } from "../io/cardAudioGeneration";
import { onlinePage } from "../../online/pageFlag";
import { clipSoundRunnable } from "../io/onlineSoundJudge";

/** 卡内声音依附同一片段。生成不是分离音轨；失败不把旧声音或画面替掉。 */
export function CardAudioForm({ clip }: { clip: TrackClip }) {
  const project = useStore(s => s.project);
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(0), [error, setError] = useState("");
  const active = useRef(false);
  if (!clipHasEmbeddedAudio(project, clip, getCard)) return null;
  const locked = project.tracks.find(track => track.clips.some(c => c.id === clip.id))?.locked;
  // 在线页面(`product/platforms.md`「卡片声音的平台边界」):本页能运行的有声卡可以在浏览器里合成(判轻的);跑不了的照旧只用同步来的声音
  const online = onlinePage(), synthHere = !online || clipSoundRunnable(project, clip);
  let ready = false, status = "尚未生成卡片声音";
  try { persistentCardAudio(project, clip); ready = true; status = "声音已保存，预览和导出共用同一份 WAV"; }
  catch (cause) { status = cause instanceof Error ? cause.message : String(cause); }
  const generate = async () => {
    if (active.current) return;
    active.current = true; setBusy(true); setProgress(0); setError("");
    try { await generateCardAudio(clip.id, { force: true, onProgress: (done, total) => setProgress(total ? done / total : 0) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { active.current = false; setBusy(false); }
  };
  return <section className="p-3 pc-left-divider-b text-xs" data-pc="card-audio-controls" aria-label="动效卡片声音">
    <div className="font-semibold mb-2">卡片内嵌声音</div>
    <p className="pc-left-muted mb-2">{status}</p>
    <p className="pc-left-muted mb-2">声音和画面属于同一片段，可单独静音，不能分离音轨。</p>
    <div className="flex gap-2 flex-wrap">
      <button type="button" disabled={busy || locked || !synthHere} onClick={() => void generate()}>{ready ? "重新生成声音" : "生成声音"}</button>
      <button type="button" disabled={locked} aria-pressed={!!clip.audioMuted} onClick={() => {
        const result = actions.setClipMuted(clip.id, !clip.audioMuted);
        if (!result.ok) setError(result.error ?? "静音操作失败");
      }}>{clip.audioMuted ? "恢复声音" : "静音卡片"}</button>
      {busy && <button type="button" onClick={() => cancelCardAudioGeneration(clip.id)}>取消生成</button>}
    </div>
    {busy && <p role="status" className="mt-2">正在生成或上传声音 {Math.round(progress * 100)}%</p>}
    {online && !synthHere && <p className="pc-left-muted mt-2">请在本地生成并同步卡片声音；这里可以预览已有声音。</p>}
    {online && synthHere && !ready && <p className="pc-left-muted mt-2">预览里的声音由浏览器即时合成；点「生成声音」或导出时会保存成同步的声音。</p>}
    {error && <p role="alert" className="mt-2">{error}</p>}
  </section>;
}
