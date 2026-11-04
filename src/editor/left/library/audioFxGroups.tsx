import { useState } from "react";
import { actions, getState, useStore } from "../../../store/project";
import { findClip } from "../../../kernel/project";
import { AUDIO_FX_KINDS, AUDIO_FX_PRESETS, describeAudioFx, isAudioFxAnimated } from "../../../kernel/audioFx.mjs";
import { createAudioFxTools, audioFxUsesOf } from "../../right/audioFxTools";
import { AudioStrip } from "./AudioStrip";
import { useReadOnly } from "../../readOnly";
import type { GroupData, GroupItem } from "./groups";
import { tr } from "../../../i18n/index.ts";

/** The same validation as the Agent's apply_audio_fx / remove_audio_fx */
const tools = createAudioFxTools({ getState, actions });

/** Whether the selected clip can take an audio effect: it must be a video or sound media segment; images and card clips have no sound */
function useSelectedAudioClip() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const sel = selection[0] ? findClip(project, selection[0]) : null;
  const selClip = sel && sel.clip.mediaId && !sel.clip.cardId ? sel.clip : null;
  const selMedia = selClip ? project.media.find((m) => m.id === selClip.mediaId) : null;
  return { project, selClip, selMedia };
}

/**
 * Effects → audio effects group: the project's audio effects library.
 * Most effects are created by the Agent with create_audio_fx; here people can see them, attach
 * them to the selected video / audio clip for reuse, and delete them.
 * "Attach to selection / Delete" on each entry only shows on hover or keyboard focus.
 */
export function useAudioFxGroup(q: string, flash: (text: string, ms?: number) => void): GroupData {
  // This project grants only read-only access (guest): attaching / detaching audio effects and deleting effects are all writes
  const ro = useReadOnly();
  const { project, selClip, selMedia } = useSelectedAudioClip();
  const [armed, setArmed] = useState<string | null>(null);
  const canApply = selClip && selMedia && selMedia.kind !== "image";

  const run = (fn: () => unknown, ok: string) => {
    try {
      fn();
      flash(ok, 2000);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 2000);
    }
  };

  const rawFx = project.audioFx ?? [];
  const filtered = q
    ? rawFx.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          (f.description && f.description.toLowerCase().includes(q)) ||
          describeAudioFx(f).toLowerCase().includes(q),
      )
    : rawFx;

  const items: GroupItem[] = filtered.map((f) => {
    const uses = audioFxUsesOf(project, f.id);
    const on = !!selClip && selClip.audioFx?.id === f.id;
    return {
      id: f.id,
      node: (
        <AudioStrip
          attrs={{ "data-pc-audiofx": f.id }}
          icon="fx"
          className={armed === f.id ? "is-armed" : undefined}
          title={`${f.description ?? f.name}\n${describeAudioFx(f)}`}
          name={
            <>
              <span className="pc-lib-ellipsis">{f.name}</span>
              {isAudioFxAnimated(f) && <span className="pc-lib-tag">{tr("Changes over time")}</span>}
            </>
          }
          sub={`${describeAudioFx(f)}${uses.length ? tr(" · used in {0} segments", uses.length) : ""}`}
          actions={
            <>
              <button
                type="button"
                className="pc-left-btn"
                disabled={!canApply || ro.locked}
                title={ro.locked ? ro.why : canApply ? (on ? tr("Detach from the selected clip") : tr("Attach to the selected clip (one per segment, replaces the existing one)")) : tr("First select a video or audio segment on the timeline")}
                onClick={() =>
                  canApply &&
                  (on
                    ? run(() => tools.applyAudioFx({ clipId: selClip.id, fxId: "" }), tr("Detached \"{0}\" from the selected clip", f.name))
                    : run(() => tools.applyAudioFx({ clipId: selClip.id, fxId: f.id }), tr("Attached \"{0}\" to the selected clip", f.name)))
                }
              >
                {on ? tr("Detach") : tr("Attach to selection")}
              </button>
              <button
                type="button"
                className={`pc-left-btn${armed === f.id ? " is-danger" : ""}`}
                disabled={ro.locked}
                title={ro.title(uses.length ? tr("Used in {0} segments, deleting it detaches it from all of them", uses.length) : tr("Delete from effects library"))}
                onClick={() => {
                  if (uses.length && armed !== f.id) {
                    setArmed(f.id);
                    flash(tr("\"{0}\" is used in {1} segments; click \"Confirm delete\" again to detach it from those segments as well", f.name, uses.length), 2000);
                    return;
                  }
                  setArmed(null);
                  run(() => tools.removeAudioFx({ fxId: f.id, force: uses.length > 0, reason: "User deleted it in the media library" }), tr("Deleted \"{0}\"", f.name));
                }}
              >
                {armed === f.id ? tr("Confirm delete") : tr("Delete")}
              </button>
            </>
          }
        />
      ),
    };
  });

  const thumbs: GroupItem[] = filtered.slice(0, 2).map((f) => ({
    id: f.id,
    node: <AudioStrip icon="fx" name={f.name} sub={describeAudioFx(f)} />,
  }));

  const detailTop = (
    <div className="pc-left-hint">
      {tr("Most effects are created by the Agent with create_audio_fx; here you can view, reuse and delete them; preview and export use the same Web Audio, so what you hear is what gets exported.")}
    </div>
  );

  // Reference notes for effect types: what each effect does, which parameters it has and their value ranges
  const detailBottom = (
    <details className="pc-lib-details">
      <summary>{tr("Effect types (click to expand)")}</summary>
      <div className="pc-lib-details-body">
        {Object.entries(AUDIO_FX_KINDS).map(([kind, spec]) => (
          <div key={kind}>
            <div className="pc-lib-details-kind">
              {kind} <span className="pc-left-faint">{spec.label}</span>
            </div>
            <div className="pc-lib-details-hint">{spec.hint}</div>
            <div className="pc-lib-details-params">
              {Object.entries(spec.params).map(([pk, ps]) => (
                <span key={pk}>
                  {pk} ({ps.min}~{ps.max}
                  {ps.unit ? ` ${ps.unit}` : ""})
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  );

  return {
    items,
    thumbs,
    detailTop,
    detailBottom,
    emptyHint: tr("Ask the AI assistant to create an audio effect, or create one from \"Audio presets\""),
    emptyDetail:
      rawFx.length === 0 ? (
        <div className="pc-left-note">
          {tr("No audio effects yet. Ask the Agent to create one (for example \"duck the music under the voice\", \"add hall reverb to the closing text\"), or create one from the \"Audio presets\" group.")}
        </div>
      ) : (
        <div className="pc-left-note">{tr("No matching effects found.")}</div>
      ),
  };
}

/** Effects → audio presets group: AUDIO_FX_PRESETS; clicking an entry = create from the preset (and attach it right away if a clip that can take it is selected) */
export function useAudioPresetsGroup(q: string, flash: (text: string, ms?: number) => void): GroupData {
  const ro = useReadOnly();
  const { selClip, selMedia } = useSelectedAudioClip();
  const canApply = selClip && selMedia && selMedia.kind !== "image";

  const run = (fn: () => unknown, ok: string) => {
    try {
      fn();
      flash(ok, 2000);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 2000);
    }
  };

  const hits = AUDIO_FX_PRESETS.map((preset, idx) => ({ preset, idx })).filter(
    ({ preset }) =>
      !q || preset.name.toLowerCase().includes(q) || (preset.description ?? "").toLowerCase().includes(q),
  );

  const create = (preset: (typeof AUDIO_FX_PRESETS)[number]) =>
    ro.locked ? undefined : run(
      () => tools.createAudioFx({ ...preset, createdBy: "user", ...(canApply ? { clipId: selClip.id } : null) }),
      canApply ? tr("Created \"{0}\" and attached it to the selected clip", preset.name) : tr("Created \"{0}\"", preset.name),
    );

  const items: GroupItem[] = hits.map(({ preset, idx }) => ({
    id: `preset-${idx}`,
    node: (
      <AudioStrip
        attrs={{ "data-pc-audio-preset": String(idx) }}
        icon="plus"
        className="is-click"
        edits
        role="button"
        tabIndex={0}
        title={canApply ? tr("Click: create from \"{0}\" and attach to the selected clip", preset.name) : tr("Click: create from \"{0}\"", preset.name)}
        name={preset.name}
        sub={preset.description}
        onClick={() => create(preset)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            create(preset);
          }
        }}
        actions={<span className="pc-left-btn is-label">{canApply ? tr("Create and attach to selection") : tr("New")}</span>}
      />
    ),
  }));

  const thumbs: GroupItem[] = hits.slice(0, 2).map(({ preset, idx }) => ({
    id: `preset-${idx}`,
    node: <AudioStrip icon="plus" name={preset.name} sub={preset.description} />,
  }));

  return {
    items,
    thumbs,
    detailTop: <div className="pc-left-hint">{tr("Create from preset: click one to create a copy in the audio effects library; if a video / audio clip is selected, it is attached too.")}</div>,
    emptyDetail: <div className="pc-left-note">{tr("No matching presets found.")}</div>,
  };
}
