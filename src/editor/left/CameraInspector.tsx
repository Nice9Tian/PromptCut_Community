import { useEffect, useState } from "react";
import {
  activeCutEntry,
  cameraDistanceForStage,
  defaultCutFovDeg,
  resolveCamera2DAt,
  resolveCamera3DAt,
  type CameraClip,
  type CutKind,
} from "../../kernel/camera.mjs";
import { actions, useStore } from "../../store/project";
import { NumberField } from "../fields/NumberField";
import { tr } from "../../i18n/index.ts";

interface ParamMeta {
  key: string;
  label: string;
  placeholder: string;
  unit: string;
}

function parseParamInput(raw: string): number | string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

function ParamExprInput({
  camId,
  meta,
  rawValue,
  liveValue,
}: {
  camId: string;
  meta: ParamMeta;
  rawValue: number | string | undefined;
  liveValue: number;
}) {
  const formatted = rawValue === undefined ? "" : String(rawValue);
  const [draft, setDraft] = useState(formatted);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(formatted);
    setErr(null);
  }, [camId, formatted]);

  const commit = () => {
    const parsed = parseParamInput(draft);
    const prev = rawValue === undefined ? null : rawValue;
    if (parsed === prev) {
      setErr(null);
      return;
    }
    try {
      actions.updateCamera(camId, { params: { [meta.key]: parsed } });
      setErr(null);
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  };

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 pc-left-muted">{meta.label}</span>
        <input
          data-pc={`camera-param-${meta.key}`}
          value={draft}
          placeholder={meta.placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(formatted);
              setErr(null);
            }
          }}
          className="flex-1 min-w-0 pc-left-input is-sm font-mono"
        />
        <span className="w-16 shrink-0 text-right pc-left-faint font-mono text-[10px]">
          {Math.round(liveValue * 100) / 100}{meta.unit}
        </span>
      </div>
      {err && <div className="text-[10px] text-rose-400 leading-snug pl-16">{err}</div>}
    </div>
  );
}

export function CameraInspector({ camera, cutKind }: { camera: CameraClip; cutKind: CutKind }) {
  const project = useStore((s) => s.project);
  const t = useStore((s) => s.t);
  const [nameDraft, setNameDraft] = useState(camera.name ?? "");
  const [timeErr, setTimeErr] = useState<string | null>(null);

  useEffect(() => {
    setNameDraft(camera.name ?? "");
    setTimeErr(null);
  }, [camera.id, camera.name]);

  const cut = activeCutEntry(project);
  const defFov = defaultCutFovDeg(project, cut);
  const defZ = Math.round(cameraDistanceForStage(project.height, defFov));

  const live2d = resolveCamera2DAt(cut?.cameras, t);
  const live3d = resolveCamera3DAt(cut?.cameras, { width: project.width, height: project.height }, t, defFov);

  const fields2D: ParamMeta[] = [
    { key: "x", label: tr("Pan X"), placeholder: "0  |  1920 * p", unit: "px" },
    { key: "y", label: tr("Pan Y"), placeholder: "0", unit: "px" },
    { key: "zoom", label: tr("Zoom"), placeholder: "1  |  1 + 0.3 * p", unit: "×" },
    { key: "rotate", label: tr("Rotate"), placeholder: "0", unit: "°" },
  ];

  const fields3D: ParamMeta[] = [
    { key: "x", label: tr("Pos X"), placeholder: "0", unit: "px" },
    { key: "y", label: tr("Pos Y"), placeholder: "0", unit: "px" },
    { key: "z", label: tr("Pos Z"), placeholder: `${defZ}  |  1500 - 2200 * p`, unit: "px" },
    { key: "rx", label: tr("Pitch X"), placeholder: "0", unit: "°" },
    { key: "ry", label: tr("Yaw Y"), placeholder: "0", unit: "°" },
    { key: "rz", label: tr("Roll Z"), placeholder: "0", unit: "°" },
    { key: "fovDeg", label: tr("FOV"), placeholder: `${defFov}`, unit: "°" },
  ];

  const fields = cutKind === "3d" ? fields3D : fields2D;
  const rawParams = (camera.params ?? {}) as Record<string, number | string | undefined>;
  const liveRecord: Record<string, number> =
    cutKind === "3d"
      ? { x: live3d.x, y: live3d.y, z: live3d.z, rx: live3d.rx, ry: live3d.ry, rz: live3d.rz, fovDeg: live3d.fovDeg }
      : { x: live2d.x, y: live2d.y, zoom: live2d.zoom, rotate: live2d.rotate };

  const safeUpdate = (patch: Parameters<typeof actions.updateCamera>[1]) => {
    try {
      actions.updateCamera(camera.id, patch);
      setTimeErr(null);
    } catch (e: any) {
      setTimeErr(e?.message || String(e));
    }
  };

  return (
    <div data-pc="camera-inspector" className="flex-1 min-h-0 overflow-y-auto pc-left-scroll flex flex-col p-3 gap-2.5 text-xs">
      <div className="flex items-center justify-between gap-2 pb-2 pc-left-divider-b">
        <div className="font-semibold pc-left-strong truncate">
          {cutKind === "3d" ? tr("3D Camera Clip") : tr("2D Camera Clip")}
        </div>
        <label className="flex items-center gap-1.5 pc-left-muted shrink-0">
          <input
            data-pc="camera-enabled"
            type="checkbox"
            checked={camera.enabled !== false}
            onChange={(e) => safeUpdate({ enabled: e.target.checked })}
          />
          <span>{tr("Enabled")}</span>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 pc-left-muted">{tr("Name")}</span>
        <input
          data-pc="camera-name"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => {
            if (nameDraft.trim() && nameDraft.trim() !== camera.name) {
              safeUpdate({ name: nameDraft.trim() });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && nameDraft.trim()) safeUpdate({ name: nameDraft.trim() });
          }}
          className="flex-1 min-w-0 pc-left-input is-sm"
        />
      </div>

      <div className="flex items-center gap-2 pc-left-muted">
        <span>{tr("Start")}</span>
        <NumberField
          attrs={{ "data-pc": "camera-start" }}
          step={0.1}
          min={0}
          value={camera.start}
          onCommit={(v) => safeUpdate({ start: v })}
          className="w-16 pc-left-input is-sm"
        />
        <span>{tr("End")}</span>
        <NumberField
          attrs={{ "data-pc": "camera-end" }}
          step={0.1}
          min={0.05}
          value={camera.end}
          onCommit={(v) => safeUpdate({ end: v })}
          className="w-16 pc-left-input is-sm"
        />
        <span className="pc-left-faint ml-auto">{(camera.end - camera.start).toFixed(2)}s</span>
      </div>

      <div className="flex items-center gap-2 pc-left-muted" title={tr("Higher row overrides lower row when intervals overlap")}>
        <span className="w-14 shrink-0">{tr("Row")}</span>
        <NumberField
          attrs={{ "data-pc": "camera-row" }}
          step={1}
          min={0}
          digits={0}
          value={camera.row ?? 0}
          onCommit={(v) => safeUpdate({ row: Math.max(0, Math.round(v)) })}
          className="w-16 pc-left-input is-sm"
        />
        <span className="text-[10px] pc-left-faint">{tr("Upper row overrides lower row")}</span>
      </div>

      {timeErr && (
        <div className="text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/25 rounded px-2 py-1">
          {timeErr}
        </div>
      )}

      <div className="pt-2 pc-left-divider flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="font-semibold pc-left-strong">{tr("Pose & Expressions")}</span>
          <span className="text-[10px] pc-left-faint font-mono">t, d, p</span>
        </div>
        <div className="text-[10px] pc-left-faint leading-relaxed">
          {tr("Enter a number or an expression in t (clip seconds), d (clip duration), p (0..1 progress).")}
        </div>
        {fields.map((m) => (
          <ParamExprInput
            key={m.key}
            camId={camera.id}
            meta={m}
            rawValue={rawParams[m.key]}
            liveValue={liveRecord[m.key]}
          />
        ))}
      </div>

      <div className="pt-2 pc-left-divider flex justify-between items-center">
        <button
          type="button"
          data-pc="delete-camera"
          onClick={() => actions.removeCamera(camera.id)}
          className="text-rose-400 hover:text-rose-300 text-[11px]"
        >
          {tr("Delete camera")}
        </button>
      </div>
    </div>
  );
}
