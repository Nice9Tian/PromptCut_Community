import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropClose } from "../ui/backdropClose";
import { actions, useStore } from "../store/project";
import "./ProjectSettingsDialog.css";
import { CollabSection, type CollabHandle } from "./sync/CollabSection";
import { ReadOnlyFence } from "./ReadOnlyFence";
import { useReadOnly } from "./readOnly";
import { CREATIVITY_HINT, CREATIVITY_LABEL, CREATIVITY_LEVELS, CREATIVITY_SHORT, DEFAULT_CREATIVITY, normalizeCreativity, projectCreativity, type CreativityLevel } from "../kernel/creativity.mjs";
import { tr } from "../i18n/index.ts";

export interface ProjectSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

type AspectRatio = "16:9" | "4:3";
/** pinned architecture 7: frame rates selectable in the project options. New projects default to 30 (`src/kernel/project.ts`) */
const FPS_OPTIONS = [24, 25, 30, 60] as const;
type Fps = (typeof FPS_OPTIONS)[number];
const FALLBACK_FPS: Fps = 30;
/** If the project's stored frame rate is not among the options (project file edited by hand), fall back to 30, and do not silently change anything beyond the user's value */
const asFps = (value: number): Fps => (FPS_OPTIONS as readonly number[]).includes(value) ? (value as Fps) : FALLBACK_FPS;
type Orientation = "horizontal" | "vertical";

const RESOLUTION_MAP: Record<AspectRatio, Record<Orientation, { width: number; height: number }>> = {
  "16:9": {
    horizontal: { width: 1920, height: 1080 },
    vertical: { width: 1080, height: 1920 },
  },
  "4:3": {
    horizontal: { width: 1440, height: 1080 },
    vertical: { width: 1080, height: 1440 },
  },
};

/** Derive ratio and orientation from the current aspect ratio size; if derivation fails, default to 16:9 landscape */
function inferSettings(w: number, h: number): { ratio: AspectRatio; orientation: Orientation } {
  if (w === 1920 && h === 1080) return { ratio: "16:9", orientation: "horizontal" };
  if (w === 1080 && h === 1920) return { ratio: "16:9", orientation: "vertical" };
  if (w === 1440 && h === 1080) return { ratio: "4:3", orientation: "horizontal" };
  if (w === 1080 && h === 1440) return { ratio: "4:3", orientation: "vertical" };
  if (w > 0 && h > 0) {
    const isHorizontal = w >= h;
    const r = isHorizontal ? w / h : h / w;
    if (Math.abs(r - 16 / 9) < 0.05) {
      return { ratio: "16:9", orientation: isHorizontal ? "horizontal" : "vertical" };
    }
    if (Math.abs(r - 4 / 3) < 0.05) {
      return { ratio: "4:3", orientation: isHorizontal ? "horizontal" : "vertical" };
    }
  }
  return { ratio: "16:9", orientation: "horizontal" };
}

/**
 * Project settings dialog: configures the video aspect ratio and orientation, with a live resolution preview;
 * a "multi-user collaboration" section at the bottom (C10a contract section 6, `sync/CollabSection.tsx`).
 * The room link and the project metadata are saved separately: "OK" writes the project metadata first, then
 * hands over to the collaboration section to enable / cancel; while it has an action in progress, the dialog
 * stays open to show progress and result.
 */
export function ProjectSettingsDialog({ open, onClose }: ProjectSettingsDialogProps) {
  const curW = useStore((s) => s.project.width);
  const curH = useStore((s) => s.project.height);
  const curName = useStore((s) => s.project.name);
  const curFps = useStore((s) => s.project.fps);
  const curDuration = useStore((s) => s.project.duration);
  const curGlRoute = useStore((s) => s.project.glRoute);
  const curCreativity = useStore((s) => projectCreativity(s.project));

  const [name, setName] = useState("");
  const [ratio, setRatio] = useState<AspectRatio>("16:9");
  const [orientation, setOrientation] = useState<Orientation>("horizontal");
  const [fps, setFps] = useState<Fps>(FALLBACK_FPS);
  const [duration, setDuration] = useState("");
  /** R9: which route the shared WebGL renderer of canvas cards takes; empty string = by host capability (shared in the low-memory tier, otherwise perDocument) */
  const [glRoute, setGlRoute] = useState<"" | "perDocument" | "shared">("");
  /** Project default for the creativity level (user-workflow.md "creativity level"): every chat in the AI panel defaults to it, and the desktop app's session follows it */
  const [creativity, setCreativity] = useState<CreativityLevel>(DEFAULT_CREATIVITY);
  const durationInputRef = useRef<HTMLInputElement>(null);
  const collabRef = useRef<CollabHandle>(null);
  // This project was given read-only permission (guest): settings are shown as usual but cannot be changed, "OK" is greyed out, and only "Close" remains
  const ro = useReadOnly();

  const currentRes = RESOLUTION_MAP[ratio][orientation];

  const handleConfirm = async () => {
    if (ro.locked) { onClose(); return; }
    if (!durationInputRef.current?.reportValidity()) return;
    const requestedDuration = Number(duration);
    if (!Number.isFinite(requestedDuration) || requestedDuration < 1) return;
    // The name may be left empty, but it must not end up as a truly empty title: if empty, fall back to "Untitled"
    actions.setProjectMeta({
      name: name.trim() || tr("Untitled"),
      width: currentRes.width,
      height: currentRes.height,
      // pinned architecture 7: all step sizes are 1/fps. The cost key includes fps (`cardCostKey`), so after a
      // frame rate change every card's record mismatches. `probeRunner` re-covers the mask and re-measures once.
      fps,
      // Route switched: both stages rebuild their connections on the new effective route; the `device` string changes
      // too, and probeRunner re-covers the mask and re-measures (same as an fps switch)
      glRoute: glRoute || undefined,
      // The factory default "High" is not written to the field: old projects have no such field, so the saved result
      // is the same as if it was never changed
      creativity: creativity === DEFAULT_CREATIVITY ? undefined : creativity,
    });
    if (requestedDuration !== curDuration) actions.setDurationManual(requestedDuration);
    // Multi-user collaboration: check and save = enable, uncheck and save = disable; the dialog stays open while
    // this section is busy
    if (await collabRef.current?.apply(name.trim() || tr("Untitled"))) return;
    onClose();
  };

  const handleCancel = () => {
    onClose();
  };

  const confirmRef = useRef(handleConfirm);
  const cancelRef = useRef(handleCancel);

  // Follow ConfirmDialog.tsx: sync the ref in a dependency-less useEffect, with no side effects during render
  useEffect(() => {
    confirmRef.current = handleConfirm;
    cancelRef.current = handleCancel;
  });

  useEffect(() => {
    if (open) {
      const initial = inferSettings(curW, curH);
      setRatio(initial.ratio);
      setOrientation(initial.orientation);
      setName(curName);
      setFps(asFps(curFps));
      setDuration(String(curDuration));
      setGlRoute(curGlRoute ?? "");
      setCreativity(curCreativity);
    }
  }, [open, curW, curH, curName, curFps, curDuration, curGlRoute, curCreativity]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // The input box inside "Multi-user collaboration" handles Enter itself (invalidating and regenerating needs the
      // creator password), so it is not treated as the whole dialog's "OK"
      if ((e.target as HTMLElement | null)?.closest?.(".pc-collab")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        cancelRef.current();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void confirmRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Backdrop: close only when both press and release land on the backdrop, so dragging to select text inside an
  // input does not close it by mistake (see ui/backdropClose.ts)
  const backdrop = useBackdropClose(handleCancel);
  if (!open) return null;

  return createPortal(
    <div className="pc-dialog-mask" {...backdrop}>
      <div
        className="pc-dialog pc-dialog--collab"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pc-dialog-title-settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div id="pc-dialog-title-settings" className="pc-dialog-title">
          {tr("Project settings")}
        </div>
        <div className="pc-dialog-body">
          {ro.locked && <div className="pc-dialog-row" data-pc="settings-readonly-note">{ro.why}</div>}
          <ReadOnlyFence>
          <div className="pc-dialog-row">
            <label className="pc-dialog-label" htmlFor="pc-proj-name">{tr("Project name")}</label>
            <input
              id="pc-proj-name"
              className="pc-dialog-input"
              type="text"
              value={name}
              maxLength={80}
              placeholder={tr("Untitled")}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="pc-dialog-row">
            <span className="pc-dialog-label">{tr("Aspect ratio")}</span>
            <div className="pc-dialog-options">
              <button
                type="button"
                className={`pc-dialog-opt${ratio === "16:9" ? " pc-dialog-opt--on" : ""}`}
                onClick={() => setRatio("16:9")}
              >
                16:9
              </button>
              <button
                type="button"
                className={`pc-dialog-opt${ratio === "4:3" ? " pc-dialog-opt--on" : ""}`}
                onClick={() => setRatio("4:3")}
              >
                4:3
              </button>
            </div>
          </div>
          <div className="pc-dialog-row">
            <span className="pc-dialog-label">{tr("Orientation")}</span>
            <div className="pc-dialog-options">
              <button
                type="button"
                className={`pc-dialog-opt${orientation === "horizontal" ? " pc-dialog-opt--on" : ""}`}
                onClick={() => setOrientation("horizontal")}
              >
                {tr("Landscape")}
              </button>
              <button
                type="button"
                className={`pc-dialog-opt${orientation === "vertical" ? " pc-dialog-opt--on" : ""}`}
                onClick={() => setOrientation("vertical")}
              >
                {tr("Portrait")}
              </button>
            </div>
          </div>
          <div className="pc-dialog-row">
            <label className="pc-dialog-label" htmlFor="pc-proj-fps">{tr("Frame rate")}</label>
            <select
              id="pc-proj-fps"
              data-pc="fps-select"
              className="pc-dialog-select"
              value={fps}
              onChange={(e) => setFps(asFps(Number(e.target.value)))}
            >
              {FPS_OPTIONS.map((n) => (
                <option key={n} value={n}>{n} fps</option>
              ))}
            </select>
          </div>
          <div className="pc-dialog-row">
            <label className="pc-dialog-label" htmlFor="pc-proj-gl-route">{tr("3D rendering")}</label>
            <select
              id="pc-proj-gl-route"
              data-pc="gl-route-select"
              className="pc-dialog-select"
              value={glRoute}
              onChange={(e) => setGlRoute(e.target.value as "" | "perDocument" | "shared")}
            >
              <option value="">{tr("Auto (by local memory)")}</option>
              <option value="perDocument">{tr("One per stage")}</option>
              <option value="shared">{tr("One shared by both stages (saves memory)")}</option>
            </select>
          </div>
          <div className="pc-dialog-row">
            <label className="pc-dialog-label" htmlFor="pc-proj-creativity">{tr("Creativity level")}</label>
            <select
              id="pc-proj-creativity"
              data-pc="creativity-select"
              className="pc-dialog-select"
              value={creativity}
              title={tr("{0}: {1}. Each chat in the AI panel uses this level by default and can override it; desktop app sessions follow it", tr(CREATIVITY_LABEL[creativity]), tr(CREATIVITY_HINT[creativity]))}
              onChange={(e) => setCreativity(normalizeCreativity(e.target.value) ?? DEFAULT_CREATIVITY)}
            >
              {CREATIVITY_LEVELS.map((lv) => (
                <option key={lv} value={lv} title={tr(CREATIVITY_HINT[lv])}>{tr(CREATIVITY_LABEL[lv])} · {tr(CREATIVITY_SHORT[lv])}</option>
              ))}
            </select>
          </div>
          <div className="pc-dialog-row">
            <label className="pc-dialog-label" htmlFor="pc-proj-duration">{tr("Total duration (seconds)")}</label>
            <input
              ref={durationInputRef}
              id="pc-proj-duration"
              className="pc-dialog-input"
              type="number"
              min="1"
              step="any"
              required
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>
          <div className="pc-dialog-row">
            <span className="pc-dialog-label">{tr("Apply resolution")}</span>
            <span className="pc-dialog-res">
              {currentRes.width} × {currentRes.height}
            </span>
          </div>
          </ReadOnlyFence>
          <CollabSection ref={collabRef} open={open} />
        </div>
        <div className="pc-dialog-foot">
          <button type="button" className="pc-btn" onClick={handleCancel}>
            {ro.locked ? tr("Close") : tr("Cancel")}
          </button>
          <button
            type="button"
            className="pc-btn pc-btn--primary"
            disabled={ro.locked}
            title={ro.title()}
            onClick={() => void handleConfirm()}
          >
            {tr("OK")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
