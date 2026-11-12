import { useRef, useState } from "react";
import { activeCutKind } from "../../kernel/project";
import { activeCutEntry, sortCameraClips, type CameraClip } from "../../kernel/camera.mjs";
import { atFrameGrid } from "../../render/frameGrid.ts";
import { actions, getState, useStore } from "../../store/project";
import { useTimelineContext } from "./TimelineContext";
import { ContextMenu } from "./ContextMenu";
import { snapTime, xOfTime } from "./utils";
import { IconPlus } from "../../ui/icons";
import { useReadOnly } from "../readOnly";
import { tr } from "../../i18n/index.ts";

function IconCamera({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="4" width="9.5" height="8" rx="1.5" />
      <path d="M11 6.6l3.5-2v6.8L11 9.4z" />
    </svg>
  );
}

export function useCameraLaneLayout() {
  const project = useStore((s) => s.project);
  const { trackH } = useTimelineContext();
  const cut = activeCutEntry(project);
  const cutKind = activeCutKind(project);
  const cameras = sortCameraClips(cut?.cameras);
  const maxRow = cameras.reduce((m, c) => Math.max(m, c.row ?? 0), 0);
  const rowCount = Math.max(1, maxRow + 1);
  const subRowH = Math.max(24, Math.min(34, Math.round(trackH * 0.72)));
  return { cameras, rowCount, subRowH, laneH: rowCount * subRowH, cutKind };
}

function findFreeCameraPlacement(cameras: CameraClip[], playhead: number, fps: number, duration: number) {
  const step = 1 / Math.max(1, fps);
  const start = Math.max(0, atFrameGrid(playhead, fps));
  const defaultDur = Math.max(step * 5, Math.min(5, Math.max(2, duration - start)));
  const end = atFrameGrid(start + defaultDur, fps);
  for (let row = 0; row < 16; row++) {
    const conflict = cameras.some(
      (c) => (c.row ?? 0) === row && start < c.end - 1e-6 && end > c.start + 1e-6,
    );
    if (!conflict) return { start, end: Math.max(start + step, end), row };
  }
  return { start, end: Math.max(start + step, end), row: 0 };
}

function summarizeCameraParams(cam: CameraClip): string {
  const entries = Object.entries(cam.params ?? {}).filter(([, v]) => v !== undefined);
  if (!entries.length) return "";
  return entries
    .slice(0, 3)
    .map(([k, v]) => (typeof v === "string" ? `${k}=f(t)` : `${k}:${Math.round(Number(v) * 10) / 10}`))
    .join(" ");
}

export function CameraLaneHeader() {
  const { laneH, cutKind } = useCameraLaneLayout();
  const ro = useReadOnly();

  const handleAdd = () => {
    if (ro.locked) return;
    const st = getState();
    const cut = activeCutEntry(st.project);
    const cams = sortCameraClips(cut?.cameras);
    const fps = Math.max(1, st.project.fps || 30);
    const slot = findFreeCameraPlacement(cams, st.t, fps, st.project.duration);
    actions.addCamera(slot);
  };

  return (
    <div
      data-pc="camera-lane-header"
      className="pc-tl-row pc-tl-camera-hdr select-none touch-none flex-shrink-0"
      style={{ height: laneH }}
      title={tr("Camera lane ({0} cut): upper row overrides lower row; uncovered moments use the default straight-on view", cutKind.toUpperCase())}
    >
      <span className="pc-tl-camera-icon"><IconCamera size={12} /></span>
      <div className="pc-tl-row-name flex items-center gap-1.5">
        <span>{tr("Camera")}</span>
        <span className="pc-tl-camera-kind">{cutKind.toUpperCase()}</span>
      </div>
      <div className="pc-tl-row-acts" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          data-pc="add-camera"
          disabled={ro.locked}
          onClick={handleAdd}
          title={ro.title(tr("Add camera clip at playhead"))}
          aria-label={tr("Add camera clip")}
        >
          <IconPlus size={12} />
        </button>
      </div>
    </div>
  );
}

export function CameraLaneRow() {
  const { cameras, rowCount, subRowH, laneH } = useCameraLaneLayout();
  const selectedCameraId = useStore((s) => s.selectedCameraId);
  const { pxPerSec } = useTimelineContext();
  const ro = useReadOnly();
  const [menu, setMenu] = useState<{ x: number; y: number; cam: CameraClip } | null>(null);
  const dragRef = useRef<{
    camId: string;
    mode: "move" | "left" | "right";
    startX: number;
    origStart: number;
    origEnd: number;
    row: number;
  } | null>(null);

  const beginDrag = (
    e: React.PointerEvent,
    cam: CameraClip,
    mode: "move" | "left" | "right",
  ) => {
    if (e.button !== 0 || ro.locked) return;
    e.stopPropagation();
    actions.selectCamera(cam.id);
    const targetEl = e.currentTarget as HTMLElement;
    targetEl.setPointerCapture(e.pointerId);
    const row = cam.row ?? 0;
    dragRef.current = {
      camId: cam.id,
      mode,
      startX: e.clientX,
      origStart: cam.start,
      origEnd: cam.end,
      row,
    };

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const st = getState();
      const fps = Math.max(1, st.project.fps || 30);
      const minLen = 1 / fps;
      const cut = activeCutEntry(st.project);
      const peers = (cut?.cameras ?? []).filter((c) => c.id !== d.camId && (c.row ?? 0) === d.row);
      let loBound = 0;
      let hiBound = Infinity;
      for (const p of peers) {
        if (p.end <= d.origStart + 1e-6) loBound = Math.max(loBound, p.end);
        if (p.start >= d.origEnd - 1e-6) hiBound = Math.min(hiBound, p.start);
      }
      const dt = (ev.clientX - d.startX) / pxPerSec;
      let nextStart = d.origStart;
      let nextEnd = d.origEnd;
      if (d.mode === "move") {
        const len = d.origEnd - d.origStart;
        const rawStart = snapTime(Math.max(loBound, d.origStart + dt), ev.altKey, st.project, st.t, undefined, pxPerSec);
        nextStart = Math.max(loBound, Math.min(hiBound - len, rawStart));
        nextEnd = atFrameGrid(nextStart + len, fps);
      } else if (d.mode === "left") {
        const rawStart = snapTime(d.origStart + dt, ev.altKey, st.project, st.t, undefined, pxPerSec);
        nextStart = Math.max(loBound, Math.min(d.origEnd - minLen, rawStart));
      } else {
        const rawEnd = snapTime(d.origEnd + dt, ev.altKey, st.project, st.t, undefined, pxPerSec);
        nextEnd = Math.min(hiBound, Math.max(d.origStart + minLen, rawEnd));
      }
      if (nextEnd - nextStart >= minLen - 1e-6 && (Math.abs(nextStart - cam.start) > 1e-6 || Math.abs(nextEnd - cam.end) > 1e-6)) {
        try {
          actions.updateCamera(d.camId, { start: nextStart, end: nextEnd });
        } catch {
          // Ignore transient overlap during fast pointer steps
        }
      }
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      data-pc="camera-lane"
      className="pc-tl-camera-lane relative flex-shrink-0"
      style={{ height: laneH }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && selectedCameraId) {
          actions.selectCamera(null);
        }
      }}
    >
      {rowCount > 1 &&
        Array.from({ length: rowCount - 1 }, (_, i) => (
          <div
            key={i}
            className="pc-tl-camera-subsep"
            style={{ top: (i + 1) * subRowH }}
            aria-hidden="true"
          />
        ))}
      {cameras.map((cam) => {
        const row = cam.row ?? 0;
        // Upper visual row corresponds to higher `row` index ("upper row overrides lower row")
        const top = (rowCount - 1 - row) * subRowH + 3;
        const left = xOfTime(cam.start, pxPerSec);
        const width = Math.max(10, (cam.end - cam.start) * pxPerSec);
        const isSelected = selectedCameraId === cam.id;
        const summary = summarizeCameraParams(cam);
        const disabled = cam.enabled === false;
        return (
          <div
            key={cam.id}
            data-pc="camera-clip"
            data-pc-camera-clip={cam.id}
            data-selected={isSelected ? "true" : undefined}
            className={`pc-camera-clip${isSelected ? " is-selected" : ""}${disabled ? " is-disabled" : ""}`}
            style={{ left, top, width, height: subRowH - 6 }}
            title={`${cam.name || tr("Camera")} (${cam.start.toFixed(2)}s – ${cam.end.toFixed(2)}s${row > 0 ? `, ${tr("Row")} ${row}` : ""})`}
            onPointerDown={(e) => beginDrag(e, cam, "move")}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              actions.selectCamera(cam.id);
              setMenu({ x: e.clientX, y: e.clientY, cam });
            }}
          >
            <div
              className="pc-camera-handle is-left"
              onPointerDown={(e) => beginDrag(e, cam, "left")}
            />
            <div className="pc-camera-body">
              <IconCamera size={11} />
              <span className="pc-camera-name">{cam.name || tr("Camera")}</span>
              {summary && <span className="pc-camera-summary">{summary}</span>}
            </div>
            <div
              className="pc-camera-handle is-right"
              onPointerDown={(e) => beginDrag(e, cam, "right")}
            />
          </div>
        );
      })}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: menu.cam.enabled === false ? tr("Enable camera") : tr("Disable camera"),
              disabled: ro.locked,
              action: () => actions.updateCamera(menu.cam.id, { enabled: menu.cam.enabled === false }),
            },
            {
              label: tr("Duplicate on upper override row"),
              disabled: ro.locked,
              action: () =>
                actions.addCamera({
                  name: `${menu.cam.name || tr("Camera")} (R${(menu.cam.row ?? 0) + 1})`,
                  row: (menu.cam.row ?? 0) + 1,
                  start: menu.cam.start,
                  end: menu.cam.end,
                  params: { ...(menu.cam.params as Record<string, number | string>) },
                }),
            },
            {
              label: ro.locked ? ro.why : tr("Delete camera"),
              disabled: ro.locked,
              action: () => actions.removeCamera(menu.cam.id),
            },
          ]}
        />
      )}
    </div>
  );
}
