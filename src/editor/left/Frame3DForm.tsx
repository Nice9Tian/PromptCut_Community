import { actions, useStore } from "../../store/project";
import { resolveFrame } from "../../kernel/layout";
import { clampFov, DEFAULT_FOV_DEG, MAX_FOV_DEG, MIN_FOV_DEG, perspectivePx } from "../../kernel/space3d";
import type { ClipFrame } from "../../kernel/types";
import type { TrackClip } from "../../kernel/project";
import { NumberField } from "../fields/NumberField";
import { RangeField } from "../fields/RangeField";
import { tr } from "../../i18n/index.ts";

/**
 * Edit → 3D: place this card in space.
 *
 * # Why the camera switch is here too
 *
 * 3D is **one tier for the whole project** (a picture has only one camera), while these three knobs are **per card**.
 * If they were split across two places, this scene would inevitably occur: the user drags rotateY to 40°, the picture
 * just shears, with no perspective foreshortening, and then they think the feature doesn't work well -- in fact the
 * camera just isn't on.
 * So the switch goes on the same screen, and when it is off we say so directly.
 *
 * # What about a card with no frame
 *
 * Most cards have no frame (they fill the aspect ratio). To add 3D to one you first need a frame,
 * and what gets filled in here is `{x:0, y:0}` -- resolveFrame fills w/h to the whole aspect ratio and the anchor to the top-left corner,
 * which is exactly the same position as "no frame". So adding this frame doesn't move the picture,
 * it just gives it a place to store the three 3D values.
 */

const RESET: Partial<ClipFrame> = { rotateX: 0, rotateY: 0, translateZ: 0 };

export function Frame3DForm({ clip }: { clip: TrackClip }) {
  const project = useStore((s) => s.project);
  const stage = { width: project.width, height: project.height };
  const f = resolveFrame(clip.frame, stage);
  const on = !!project.camera3dFov;
  const fov = project.camera3dFov ?? DEFAULT_FOV_DEG;

  /** Change only the items passed in and keep the rest; if there is no frame, fill in one equivalent to "fill" */
  const patch = (p: Partial<ClipFrame>) => {
    const prev = clip.frame ?? { x: 0, y: 0 };
    actions.setClipFrame(clip.id, { ...prev, ...p } as ClipFrame);
  };

  const row = (
    label: string,
    key: "rotateX" | "rotateY" | "translateZ",
    min: number,
    max: number,
    step: number,
    unit: string,
    hint: string,
  ) => (
    <div className="flex items-center gap-2" key={key} title={hint}>
      <span className="w-14 shrink-0 pc-left-muted">{label}</span>
      <RangeField
        attrs={{ "data-pc": `frame3d-${key}` }}
        min={min}
        max={max}
        step={step}
        value={f[key]}
        onValue={(v) => patch({ [key]: v })}
        className="flex-1 min-w-0 pc-left-range"
      />
      <NumberField
        step={step}
        digits={2}
        value={f[key]}
        onCommit={(v) => patch({ [key]: v })}
        className="w-16 pc-left-input is-sm"
      />
      <span className="w-6 shrink-0 pc-left-faint">{unit}</span>
    </div>
  );

  const is3D = f.rotateX !== 0 || f.rotateY !== 0 || f.translateZ !== 0;

  return (
    <div className="px-3 py-2 flex flex-col gap-2 text-xs pc-left-divider">
      <div className="flex items-center justify-between">
        <span className="font-semibold pc-left-strong">{tr("3D")}</span>
        <label className="flex items-center gap-1 pc-left-muted" title={tr("One setting for the whole project: a frame has only one camera")}>
          <input
            data-pc="frame3d-camera"
            type="checkbox"
            className="pc-left-range"
            checked={on}
            onChange={(e) =>
              actions.setProjectMeta({ camera3dFov: e.target.checked ? (project.camera3dFov ?? DEFAULT_FOV_DEG) : undefined })
            }
          />
          <span>{tr("Perspective camera")}</span>
        </label>
      </div>

      {/*
        The knob was turned without turning on the camera: this is the state most prone to making people
        think the "feature is broken": the visual indeed changed (affine shear), but lacks perspective.
        So state it plainly and provide a one-click enable button.
      */}
      {!on && is3D && (
        <button
          type="button"
          onClick={() => actions.setProjectMeta({ camera3dFov: DEFAULT_FOV_DEG })}
          className="text-left text-[11px] leading-relaxed text-amber-400/90 bg-amber-500/10 border border-amber-500/25 rounded px-2 py-1"
        >
          {tr("The camera is off, so the card is only skewed, with no perspective scaling. Click here to turn on perspective.")}
        </button>
      )}

      {row(tr("Around horizontal axis"), "rotateX", -180, 180, 1, "°", tr("Positive = top edge tilts inward, bottom edge lifts toward the viewer"))}
      {row(tr("Around vertical axis"), "rotateY", -180, 180, 1, "°", tr("Positive = right side turns inward, left side turns toward the viewer"))}
      {row(tr("Depth"), "translateZ", -2000, 1200, 10, "px", tr("Positive moves toward the viewer (larger), negative moves inward (smaller)"))}

      {on && (
        <div className="flex items-center gap-2 pc-left-muted" title={tr("Smaller means weaker perspective (closer to orthographic), larger is more exaggerated. Camera distance is derived from this and the frame size, not set separately")}>
          <span className="w-14 shrink-0">{tr("Field of view")}</span>
          <RangeField
            attrs={{ "data-pc": "frame3d-fov" }}
            min={MIN_FOV_DEG}
            max={MAX_FOV_DEG}
            step={1}
            value={fov}
            onValue={(v) => actions.setProjectMeta({ camera3dFov: clampFov(v) })}
            className="flex-1 min-w-0 pc-left-range"
          />
          <span className="w-16 text-right pc-left-faint">{fov}°</span>
          <span className="w-6" />
        </div>
      )}

      <div className="flex items-center justify-between text-[10px] pc-left-faint">
        <span>
          {on
            ? tr("Camera is {0}px from the frame", Math.round(perspectivePx(stage, fov)))
            : tr("One camera shared by the whole project")}
        </span>
        {is3D && (
          <button type="button" onClick={() => patch(RESET)} className="pc-left-link">
            {tr("Reset")}
          </button>
        )}
      </div>

      {/*
        Pushing depth too far will pass beyond the camera: at that point, this card on screen expands to
        fill the entire frame or even larger, looking like it "blew up". Rather than making users guess,
        state it directly when out of bounds.
      */}
      {on && f.translateZ >= perspectivePx(stage, fov) && (
        <div className="text-[11px] leading-relaxed text-rose-400/90">
          {tr("Depth has passed the camera ({0}px), so this card is now behind the camera. Pull it back a bit.", Math.round(perspectivePx(stage, fov)))}
        </div>
      )}
    </div>
  );
}
