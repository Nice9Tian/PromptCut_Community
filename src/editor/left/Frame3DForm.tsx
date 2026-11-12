import { useEffect, useState } from "react";
import { actions, useStore } from "../../store/project";
import { resolveFrame } from "../../kernel/layout";
import { clampFov, DEFAULT_FOV_DEG, MAX_FOV_DEG, MIN_FOV_DEG, perspectivePx } from "../../kernel/space3d";
import { activeCutEntry, defaultCutFovDeg } from "../../kernel/camera.mjs";
import { activeCutKind, type TrackClip } from "../../kernel/project";
import type { ClipFrame } from "../../kernel/types";
import { NumberField } from "../fields/NumberField";
import { RangeField } from "../fields/RangeField";
import { tr } from "../../i18n/index.ts";

const RESET: Partial<ClipFrame> = { rotateX: 0, rotateY: 0, translateZ: 0 };

function ExprRow({
  clipId,
  fieldKey,
  label,
  value,
  placeholder,
}: {
  clipId: string;
  fieldKey: string;
  label: string;
  value: string | undefined;
  placeholder: string;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value ?? "");
    setErr(null);
  }, [clipId, value]);

  const commit = () => {
    const trimmed = draft.trim();
    const prev = value ?? "";
    if (trimmed === prev) {
      setErr(null);
      return;
    }
    try {
      actions.setClipFrameExpr(clipId, { [fieldKey]: trimmed || null });
      setErr(null);
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  };

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 pc-left-muted font-mono text-[11px]">{label}</span>
        <input
          data-pc={`frame-expr-${fieldKey}`}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(value ?? "");
              setErr(null);
            }
          }}
          className="flex-1 min-w-0 pc-left-input is-sm font-mono"
        />
      </div>
      {err && <div className="text-[10px] text-rose-400 pl-16 leading-snug">{err}</div>}
    </div>
  );
}

export function Frame3DForm({ clip }: { clip: TrackClip }) {
  const project = useStore((s) => s.project);
  const stage = { width: project.width, height: project.height };
  const f = resolveFrame(clip.frame, stage);
  const is3DCut = activeCutKind(project) === "3d";
  const cutEntry = activeCutEntry(project);
  const on = is3DCut || !!project.camera3dFov;
  const fov = is3DCut ? defaultCutFovDeg(project, cutEntry) : (project.camera3dFov ?? DEFAULT_FOV_DEG);
  const isPureMedia = Boolean(clip.mediaId && !clip.cardId);
  const canPlace3D = !isPureMedia || is3DCut;

  const hasExpr = Boolean(clip.frameExpr && Object.keys(clip.frameExpr).length > 0);
  const [exprOpen, setExprOpen] = useState(hasExpr);
  useEffect(() => {
    if (hasExpr) setExprOpen(true);
  }, [clip.id, hasExpr]);

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

  const exprFields: { key: string; label: string; placeholder: string }[] = [
    { key: "x", label: "x", placeholder: `${Math.round(f.x)} + 200 * p` },
    { key: "y", label: "y", placeholder: `${Math.round(f.y)}` },
    { key: "w", label: "w", placeholder: `${Math.round(f.w)}` },
    { key: "h", label: "h", placeholder: `${Math.round(f.h)}` },
    { key: "scale", label: "scale", placeholder: "1 + 0.1 * sin(t)" },
    { key: "rotate", label: "rotate", placeholder: "15 * p" },
    ...(canPlace3D
      ? [
          { key: "rotateX", label: "rotateX", placeholder: "0" },
          { key: "rotateY", label: "rotateY", placeholder: "30 * p" },
          { key: "translateZ", label: "translateZ", placeholder: "-400 * p" },
        ]
      : []),
  ];

  return (
    <div className="px-3 py-2 flex flex-col gap-2 text-xs pc-left-divider">
      {canPlace3D && (
        <>
          <div className="flex items-center justify-between">
            <span className="font-semibold pc-left-strong">{tr("3D")}</span>
            {is3DCut ? (
              <span className="text-[10px] pc-left-faint">{tr("3D cut board")}</span>
            ) : (
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
            )}
          </div>

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
                onValue={(v) => {
                  const clamped = clampFov(v);
                  if (is3DCut) actions.setCutMeta(undefined, { camera3dFov: clamped });
                  else actions.setProjectMeta({ camera3dFov: clamped });
                }}
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

          {on && !cutEntry?.cameras?.length && f.translateZ >= perspectivePx(stage, fov) && (
            <div className="text-[11px] leading-relaxed text-rose-400/90">
              {tr("Depth has passed the camera ({0}px), so this card is now behind the camera. Pull it back a bit.", Math.round(perspectivePx(stage, fov)))}
            </div>
          )}
        </>
      )}

      <div data-pc="frame-expr-section" className={canPlace3D ? "pt-2 pc-left-divider flex flex-col gap-1.5" : "flex flex-col gap-1.5"}>
        <div className="flex items-center justify-between">
          <button
            type="button"
            data-pc="toggle-frame-expr"
            onClick={() => setExprOpen((o) => !o)}
            className="font-semibold pc-left-strong flex items-center gap-1 text-left"
          >
            <span>{exprOpen ? "▾" : "▸"}</span>
            <span>{tr("Keyframe expressions")}</span>
            {hasExpr && <span className="text-[10px] text-sky-400 font-mono">f(t)</span>}
          </button>
          {hasExpr && (
            <button
              type="button"
              data-pc="clear-frame-expr"
              onClick={() => actions.setClipFrameExpr(clip.id, null)}
              className="pc-left-link text-[10px]"
            >
              {tr("Clear")}
            </button>
          )}
        </div>
        {exprOpen && (
          <div className="flex flex-col gap-1.5 pt-1">
            <div className="text-[10px] pc-left-faint leading-relaxed">
              {tr("Animate placement deterministically using t (local seconds), d (clip duration), p (0..1).")}
            </div>
            {exprFields.map((ef) => (
              <ExprRow
                key={ef.key}
                clipId={clip.id}
                fieldKey={ef.key}
                label={ef.label}
                value={(clip.frameExpr as Record<string, string | undefined> | undefined)?.[ef.key]}
                placeholder={ef.placeholder}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
