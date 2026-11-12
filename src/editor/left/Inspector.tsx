import { useSyncExternalStore } from "react";
import { useStore, actions } from "../../store/project";
import { activeCutKind, findClip } from "../../kernel/project";
import { activeCutEntry, defaultCutFovDeg } from "../../kernel/camera.mjs";
import { getCard, allCards, onSyncedUserCardsChanged, syncedCardView, syncedUserCardsGen } from "../../kernel/registry";
import { paramsCardView } from "./paramsView";
import { ParamsForm } from "./ParamsForm";
import { PartsForm } from "./PartsForm";
import { isComposite } from "../../kernel/envelope";
import { CodeTab } from "./CodeTab";
import { Frame3DForm } from "./Frame3DForm";
import { CameraInspector } from "./CameraInspector";
import { ClipFilterForm } from "./ClipFilterForm";
import { ClipSpeedForm } from "./ClipSpeedForm";
import { ClipAudioFxForm } from "./ClipAudioFxForm";
import { SoundEffectForm, TypingSoundControls } from "./SoundEffectForm";
import { CardAudioForm } from "./CardAudioForm";
import { CutSegmentForm } from "./CutSegmentForm";
import { isCutSegment } from "../../kernel/cutSegments";
import { NumberField } from "../fields/NumberField";
import { ReadOnlyFence } from "../ReadOnlyFence";
import { tr } from "../../i18n/index.ts";

/**
 * The parameters / code pages of the edit section. Which page is shown is decided by the pill tabs
 * in the section header (tab),
 * but **both pages stay mounted** here and only toggle display: an uncommitted draft in the code
 * box is still there after switching to the parameters page and back.
 * The clip header (card name, change card, start / end) is shared by both pages.
 */
export function Inspector({ tab }: { tab: "form" | "code" }) {
  const selId = useStore(s => s.selection[0]);
  const selectedCameraId = useStore(s => s.selectedCameraId);
  const project = useStore(s => s.project);
  // The user card table synced from the online browser changed (a new card was synced, or a control changed in the source): the parameters panel follows
  useSyncExternalStore(onSyncedUserCardsChanged, syncedUserCardsGen);

  const cutEntry = activeCutEntry(project);
  const cutKind = activeCutKind(project);
  const selectedCam = selectedCameraId ? (cutEntry?.cameras ?? []).find(c => c.id === selectedCameraId) : null;
  if (selectedCam) {
    return <ReadOnlyFence><CameraInspector key={selectedCam.id} camera={selectedCam} cutKind={cutKind} /></ReadOnlyFence>;
  }

  const hit = selId ? findClip(project, selId) : null;

  if (!hit) {
    return (
      <div className="flex-1 flex flex-col justify-between p-4 text-xs pc-left-muted">
        <div className="flex-1 flex items-center justify-center text-center">
          {tr("Click a clip on the timeline, or click a card under \"Animation\" to add one")}
        </div>
        <ReadOnlyFence>
          <div data-pc="cut-space-inspector" className="pt-3 pc-left-divider flex flex-col gap-2 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="font-semibold pc-left-strong">{tr("Active cut")}</span>
              <span className="pc-left-faint font-mono">{cutKind.toUpperCase()}</span>
            </div>
            {cutKind === "2d" ? (
              <div className="flex items-center gap-2">
                <span className="shrink-0">{tr("Canvas space")}</span>
                <NumberField
                  attrs={{ "data-pc": "cut-space-width" }}
                  step={10}
                  min={64}
                  digits={0}
                  value={cutEntry?.spaceWidth ?? project.width}
                  onCommit={(v) => actions.setCutMeta(undefined, { spaceWidth: v === project.width ? null : v })}
                  className="w-16 pc-left-input is-sm"
                />
                <span>×</span>
                <NumberField
                  attrs={{ "data-pc": "cut-space-height" }}
                  step={10}
                  min={64}
                  digits={0}
                  value={cutEntry?.spaceHeight ?? project.height}
                  onCommit={(v) => actions.setCutMeta(undefined, { spaceHeight: v === project.height ? null : v })}
                  className="w-16 pc-left-input is-sm"
                />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="shrink-0">{tr("Default 3D FOV")}</span>
                <NumberField
                  attrs={{ "data-pc": "cut-default-fov" }}
                  step={1}
                  min={15}
                  max={90}
                  digits={0}
                  value={defaultCutFovDeg(project, cutEntry)}
                  onCommit={(v) => actions.setCutMeta(undefined, { camera3dFov: Math.max(15, Math.min(90, v)) })}
                  className="w-16 pc-left-input is-sm"
                />
                <span className="pc-left-faint">°</span>
              </div>
            )}
          </div>
        </ReadOnlyFence>
      </div>
    );
  }

  const { clip } = hit;

  // Cut segment: has no card and no media; its properties are which cut it references, the offset, plus frame, opacity, fade in / out, volume and mute
  if (isCutSegment(clip)) return <ReadOnlyFence><CutSegmentForm key={clip.id} clip={clip} /></ReadOnlyFence>;

  if (clip.mediaId && !clip.cardId) {
    const media = project.media.find(m => m.id === clip.mediaId);
    // The whole parameters panel goes into a read-only guard: when this project grants only read-only access (guest), values show as usual and controls are all greyed out (hover shows viewOnlyText())
    return (
      <div className="flex-1 min-h-0 overflow-y-auto pc-left-scroll flex flex-col p-3 text-xs">
        <ReadOnlyFence>
        <div className="pc-left-muted mb-2">{tr("Label:")}{" "} <span className="pc-left-strong">{clip.label || tr("none")}</span></div>
        <div className="flex items-center gap-2 mb-2 pc-left-muted">
          <span>{tr("Start")}</span>
          <NumberField attrs={{ "data-pc": "clip-start" }} step={0.1} min={0} value={clip.start} onCommit={v => actions.moveClip(clip.id, { start: v })} className="w-16 pc-left-input is-sm" />
          <span>{tr("End")}</span>
          <NumberField attrs={{ "data-pc": "clip-end" }} step={0.1} min={0} value={clip.end} onCommit={v => actions.moveClip(clip.id, { end: v })} className="w-16 pc-left-input is-sm" />
          <span className="pc-left-faint">{(clip.end - clip.start).toFixed(2)}s</span>
        </div>
        {clip.soundEffect && <SoundEffectForm key={clip.id} clip={clip} />}
        {(media?.kind === "video" || media?.kind === "audio") && <ClipSpeedForm key={clip.id} clip={clip} />}
        {media && (media.kind === "video" || media.kind === "image") && <ClipFilterForm clip={clip} />}
        {media && (media.kind === "video" || media.kind === "audio") && <ClipAudioFxForm clip={clip} />}
        {media && (media.kind === "video" || media.kind === "image") && <Frame3DForm clip={clip} />}
        </ReadOnlyFence>
      </div>
    );
  }

  // Look up a runnable definition first; a user card synced from the online browser has no definition, so use the read-only view parsed from the source (name, defaults, controls)
  const cardDef = paramsCardView(clip.cardId, { getCard, syncedCardView });
  const magic = allCards().filter(c => c.source === "magicui");
  const native = allCards().filter(c => c.source === "native");
  const user = allCards().filter(c => c.source === "user");
  const asset = allCards().filter(c => c.source === "asset");

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ReadOnlyFence><CardAudioForm key={clip.id} clip={clip} /></ReadOnlyFence>
      <ReadOnlyFence>
      <div className="px-3 pb-2 pc-left-divider-b flex flex-col gap-2 shrink-0">
        <div className="flex items-center justify-between">
          <div className="font-semibold text-xs pc-left-strong truncate pr-2">{cardDef?.name ?? clip.cardId}</div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] pc-left-faint shrink-0">{tr("Changing the card clears its parameters")}</span>
            <select
              data-pc="switch-card"
              value={clip.cardId}
              onChange={e => actions.setClipCard(clip.id, e.target.value)}
              className="pc-left-select is-sm w-24 shrink-0"
            >
              {user.length > 0 && (
                <optgroup label={tr("New")}>
                  {user.map(c => <option key={c.id} value={c.id}>{tr(c.name)}</option>)}
                </optgroup>
              )}
              {asset.length > 0 && (
                <optgroup label={tr("Motion assets")}>
                  {asset.map(c => <option key={c.id} value={c.id}>{tr(c.name)}</option>)}
                </optgroup>
              )}
              <optgroup label="Magic UI">
                {magic.map(c => <option key={c.id} value={c.id}>{tr(c.name)}</option>)}
              </optgroup>
              <optgroup label={tr("Built-in")}>
                {native.map(c => <option key={c.id} value={c.id}>{tr(c.name)}</option>)}
              </optgroup>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs pc-left-muted">
          <span>{tr("Start")}</span>
          <NumberField attrs={{ "data-pc": "clip-start" }} step={0.1} min={0} value={clip.start} onCommit={v => actions.moveClip(clip.id, { start: v })} className="w-16 pc-left-input is-sm" />
          <span>{tr("End")}</span>
          <NumberField attrs={{ "data-pc": "clip-end" }} step={0.1} min={0} value={clip.end} onCommit={v => actions.moveClip(clip.id, { end: v })} className="w-16 pc-left-input is-sm" />
          <span className="pc-left-faint ml-auto">{(clip.end - clip.start).toFixed(2)}s</span>
        </div>
        {/* A video segment wrapped in a media effect card (the clip carries both cardId and mediaId): speed can still be changed, and frame fetching uses the media node's rate */}
        {clip.mediaId && project.media.find(m => m.id === clip.mediaId)?.kind === "video" && <ClipSpeedForm key={`speed-${clip.id}`} clip={clip} />}
      </div>
      </ReadOnlyFence>

      <div className="flex-1 min-h-0 overflow-y-auto pc-left-scroll" style={{ display: tab === "form" ? "block" : "none" }}>
        <ReadOnlyFence>
        {clip.cardId === "mu-typing" && <TypingSoundControls key={clip.id} clip={clip} />}
        {isComposite(clip) ? <PartsForm clip={clip} /> : <ParamsForm clip={clip} cardDef={cardDef} />}
        {/* 3D goes after the card parameters: it changes "where this card is placed", not the card's own content */}
        <Frame3DForm clip={clip} />
        </ReadOnlyFence>
      </div>
      <div className="flex-1 min-h-0 flex flex-col" style={{ display: tab === "code" ? "flex" : "none" }}>
        {/* Keyed by clip id: switching clips switches to a separate draft, so uncommitted content from the previous clip is not carried over */}
        <CodeTab key={clip.id} clip={clip} />
      </div>
    </div>
  );
}
