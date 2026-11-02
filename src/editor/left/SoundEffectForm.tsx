import { useEffect, useState, useSyncExternalStore } from "react";
import type { TrackClip } from "../../kernel/project";
import { getState } from "../../store/project";
import type { SoundEffectRecipe } from "../../kernel/soundEffects";
import { createTypingSchedule, typingScheduleOptionsFromParams } from "../../kernel/typingEvents";
import { startSoundGeneration, soundGenerationJobs, subscribeSoundGeneration, cancelSoundGeneration } from "../io/soundGeneration";
import { soundJobFinished, type SoundGenerationJob } from "../../audio/soundGeneration";
import { tr } from "../../i18n/index.ts";

const labels: Record<string, string> = { frequency: tr("Frequency Hz"), waveform: tr("Voice"), duration: tr("Sound duration s"), attack: tr("Attack s"), release: tr("Release s"), gain: tr("Volume"), notes: tr("Note sequence (semitones)"), interval: tr("Note interval s"), tone: tr("Keyboard voice"), brightness: tr("Brightness"), variation: tr("Variation") };
const states: Record<SoundGenerationJob["state"], string> = { queued: tr("Waiting to generate"), rendering: tr("Synthesizing"), uploading: tr("Uploading asset"), succeeded: tr("Generated"), failed: tr("Generation failed"), cancelled: tr("Cancelled"), stale: tr("Clip changed, please regenerate") };

/** Kept outside selection so cancellation stays available while users navigate to another clip. */
export function SoundGenerationControls() {
  const jobs = useSyncExternalStore(subscribeSoundGeneration, soundGenerationJobs, soundGenerationJobs);
  const [error, setError] = useState("");
  return <div className="px-3 py-2 text-xs pc-left-divider-b" data-pc="sound-generation">
    <button type="button" className="pc-left-btn" data-pc="sound-notification" onClick={() => {
      try { setError(""); startSoundGeneration({ preset: "notification", start: getState().t }); }
      catch (e) { setError(String((e as Error).message)); }
    }}>{tr("Add notification sound")}</button>
    {error && <div role="alert" className="mt-2">{error}</div>}
    {jobs.slice(-5).map(job => <div key={job.id} className="mt-2" data-pc="sound-job" data-state={job.state}>
      <div className="flex items-center gap-2">
        <span role="status">{states[job.state]} {Math.round(job.progress * 100)}%</span>
        {!soundJobFinished(job) && <button type="button" className="pc-left-btn is-sm" data-pc="sound-cancel" onClick={() => cancelSoundGeneration(job.id)}>{tr("Cancel")}</button>}
      </div>
      {!soundJobFinished(job) && <progress aria-label={tr("Sound effect generation progress")} value={job.progress} max={1} className="w-full" />}
      {job.error && <div role={job.state === "failed" ? "alert" : "status"} className="pc-left-muted mt-1">{job.error}</div>}
    </div>)}
  </div>;
}

export function TypingSoundControls({ clip }: { clip: TrackClip }) {
  const [error, setError] = useState("");
  const generate = (preset: "keyboard" | "notification") => {
    try {
      setError("");
      const settled = createTypingSchedule(typingScheduleOptionsFromParams(clip.params)).settleMs / 1000;
      startSoundGeneration({ preset, sourceClipId: clip.id,
        ...(preset === "notification" ? { start: clip.start + Math.max(0, settled - (clip.mediaOffset ?? 0)) } : {}),
      });
    } catch (e) { setError(String((e as Error).message)); }
  };
  return <div className="px-3 py-3 text-xs pc-left-divider-b" data-pc="typing-sound-controls">
    <div className="pc-left-muted mb-2">{tr("Generate a standalone sound effect clip with the same typing rhythm")}</div>
    <div className="flex gap-2 flex-wrap">
      <button type="button" className="pc-left-btn" data-pc="sound-keyboard" onClick={() => generate("keyboard")}>{tr("Generate keyboard sound")}</button>
      <button type="button" className="pc-left-btn" data-pc="sound-typing-end" onClick={() => generate("notification")}>{tr("Add notification sound at end")}</button>
    </div>
    {error && <div role="alert" className="mt-2">{error}</div>}
  </div>;
}

/** Draft edits never change the project or currently usable WAV; only the explicit regenerate button does. */
export function SoundEffectForm({ clip }: { clip: TrackClip }) {
  const original = clip.soundEffect!;
  const [draft, setDraft] = useState<SoundEffectRecipe>(() => structuredClone(original.recipe));
  const [error, setError] = useState("");
  const [refreshSource, setRefreshSource] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    // A previous job can finish while the user is already drafting another version.
    if (!dirty) setDraft(structuredClone(original.recipe));
    setError("");
  }, [clip.id, original.reuseKey]);
  const updateParam = (key: string, value: unknown) => {
    setDirty(true);
    setDraft(current => ({ ...current, params: { ...current.params, [key]: value } }) as SoundEffectRecipe);
  };
  return <div className="py-3 text-xs pc-left-divider-b" data-pc="sound-effect-form">
    <div className="font-semibold mb-2">{tr("Synthesized sound effect · {0}", draft.preset === "keyboard" ? tr("Keyboard sound") : tr("Notification sound"))}</div>
    <div className="pc-left-muted mb-2">{tr("After editing, click \"Regenerate\". On success it is saved to the library and replaces the old one; on failure or cancel the original sound is kept.")}</div>
    {Object.entries(draft.params).map(([key, value]) => <label key={key} className="flex items-center gap-2 py-1">
      <span className="w-24 shrink-0 pc-left-muted">{labels[key] ?? key}</span>
      {key === "waveform" || key === "tone" ? <select className="pc-left-select flex-1" data-pc-sound-param={key} value={String(value)} onChange={e => updateParam(key, e.target.value)}>
        {(key === "waveform" ? ["sine", "triangle", "bell"] : ["soft", "mechanical"]).map(v => <option key={v} value={v}>{v}</option>)}
      </select> : Array.isArray(value) ? <input className="pc-left-input min-w-0 flex-1" data-pc-sound-param={key} value={value.join(", ")} onChange={e => updateParam(key, e.target.value.split(",").map(Number))} />
        : <input type="number" step="any" className="pc-left-input min-w-0 flex-1" data-pc-sound-param={key} value={Number(value)} onChange={e => updateParam(key, Number(e.target.value))} />}
    </label>)}
    <label className="flex items-center gap-2 py-1"><span className="w-24 shrink-0 pc-left-muted">{tr("Fixed seed")}</span>
      <input type="number" min={0} max={4294967295} step={1} data-pc-sound-param="seed" className="pc-left-input min-w-0 flex-1" value={draft.seed} onChange={e => { setDirty(true); setDraft({ ...draft, seed: Number(e.target.value) }); }} />
    </label>
    {original.sourceClipId && draft.preset === "keyboard" && <label className="flex items-center gap-2 py-2">
      <input type="checkbox" checked={refreshSource} onChange={e => setRefreshSource(e.target.checked)} />{tr("Update text and rhythm from the current typing card")}
    </label>}
    <div className="flex gap-2 mt-2">
      <button type="button" className="pc-left-btn" data-pc="sound-regenerate" onClick={() => {
        try {
          setError("");
          startSoundGeneration({ clipId: clip.id, refreshSource, params: draft.params as unknown as Record<string, unknown>, seed: draft.seed });
          setDirty(false);
        } catch (e) { setError(String((e as Error).message)); }
      }}>{tr("Regenerate")}</button>
      <button type="button" className="pc-left-btn" onClick={() => { setDraft(structuredClone(original.recipe)); setDirty(false); setError(""); }}>{tr("Restore original recipe")}</button>
    </div>
    {error && <div role="alert" className="mt-2">{error}</div>}
    <details className="mt-2 pc-left-muted"><summary>{tr("Original recipe and events")}</summary><pre className="overflow-auto max-h-48 text-[10px]">{JSON.stringify(original.recipe, null, 2)}</pre></details>
  </div>;
}
