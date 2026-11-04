/**
 * The real picture in Vibe mode: used both by the "Picture" cell of the right side panel and by the stage
 * above "Detail editing".
 *
 * It is the editor's preview (`src/editor/Preview.tsx`, the picture-only form the mobile app uses,
 * `variant="mobile"`) plus its measurement overlay (`ProbeGate`, which measures the cards when a project
 * opens; when the cost records all hit, it does not appear for even one frame): the same set that the
 * mobile app's editor mounts (`src/mobile/MobileEditor.tsx`). Playback and seeking go through the same
 * actions of the store, so "Picture" and "Detail editing" watch the same playhead.
 *
 * Only one is mounted at any moment (the stage is an iframe, so mounting two copies means two stages):
 * when "Detail editing" is expanded, that cell of the side panel is replaced by a line of text.
 * When the project is not connected yet (the store does not hold a cloud project) it is not mounted, and
 * the caller supplies an empty state.
 */
import type { JSX, ReactNode } from "react";
import { Preview } from "../editor/Preview";
import { ProbeGate } from "../editor/ProbeGate";
import { useStore } from "../store/project";

export function VibeStage(props: { className?: string; children?: ReactNode; pc?: string }): JSX.Element {
  const w = useStore((s) => s.project.width);
  const h = useStore((s) => s.project.height);
  return (
    <div className={`ps-stage${props.className ? ` ${props.className}` : ""}`} data-pc={props.pc ?? "start-stage"} style={{ aspectRatio: `${w > 0 ? w : 16} / ${h > 0 ? h : 9}` }}>
      <Preview variant="mobile" />
      <ProbeGate />
      {props.children}
    </div>
  );
}

/** Seconds written as mm:ss */
export const mmss = (sec: number): string => {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
