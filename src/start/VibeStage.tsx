/**
 * Vibe 模式里的真画面:右侧拓展栏「画面」那一格、「详细编辑」上面那块舞台都用它。
 *
 * 就是编辑界面的预览(`src/editor/Preview.tsx`,手机版用的那一种只出画面的样子 `variant="mobile"`)加它的测量遮罩
 * (`ProbeGate`,打开项目时把卡片测一遍;成本记录全命中时一帧都不出现)—— 和手机版编辑界面挂的同一套
 * (`src/mobile/MobileEditor.tsx`)。播放、跳转走 store 的同一套动作,所以「画面」和「详细编辑」看的是同一个播放头。
 *
 * 同一时刻只挂一个(舞台是 iframe,挂两份就是两套舞台):「详细编辑」展开时拓展栏那一格换成一行字。
 * 项目还没连上(store 里不是云端项目)时不挂,调用方给空态。
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

/** 秒写成 mm:ss */
export const mmss = (sec: number): string => {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
