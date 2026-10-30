import { useAnimationFrame } from "motion/react";
import { useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";

/**
 * K1 两趟布尔探针（`vtOk` / `seekOk`）的**判例卡**。
 *
 * 验收要三张判例：一张只有 CSS / WAAPI 动画的卡 `vtOk: true` 且 `seekOk: true`、
 * 一张粒子卡 `vtOk: true`、一张用 JS 驱动的卡 `vtOk: false`。
 * 粒子卡库里有（`particles-snow` 这些），另外两张卡库里没有**干净**的
 * ——`probe` 那张把 CSS 动画、Motion 元素和一条裸 rAF 计数器混在一张卡上，
 * 判出来的布尔是三者取交，说明不了任何一条判据。所以这里各放一张最小的。
 *
 * 两张卡都**不进审阅表**（`capabilities.json`），所以轴三是 `unknown`、按 `belowDependent` 处理，
 * 探针帧不会被当成预渲染素材存下去（K1 末句）。它们只在探针的验收里被点名加载，
 * 左栏和 Agent 照常看得到，但没人会把它们放进成片。
 */

/**
 * **只有 CSS @keyframes**：一条 `transform` 的线性平移，没有任何 JS 参与。
 *
 * 判例期望：`vtOk: true`（`pinner.syncIn` 把这条动画的 `currentTime` 钉到第 8 帧，
 * 画面就是第 8 帧该有的样子，和全局时钟推 8 帧逐字相同）、`seekOk: true`
 * （一步钉到第 8 帧和逐帧推到第 8 帧结果相同 —— 文档时间线上的动画本来就能直接定位）。
 */
function ProbeCssCard({ playToken }: CardProps<Record<string, never>>) {
  return (
    <div style={{ position: "absolute", inset: 0 }} key={playToken}>
      <style>{"@keyframes pcProbeCssSlide { from { transform: translateX(0px) } to { transform: translateX(960px) } }"}</style>
      <div
        data-pc-probe="css"
        style={{
          position: "absolute", left: 120, top: 420, width: 240, height: 240, borderRadius: 32,
          background: "#2dd4bf", animation: "pcProbeCssSlide 3s linear infinite",
        }}
      />
    </div>
  );
}

/**
 * **JS 驱动**：Motion 的帧循环（`useAnimationFrame`）每帧读全局时间戳、自己写 `transform`。
 *
 * 判例期望：`vtOk: false`。子树虚拟时间那一趟**不动全局时钟**，被 `stageClock` 接管的
 * rAF 队列因此没人排空，这条回调一次都不跑 —— 画面停在挂载帧，和全局时钟推出来的第 8 帧不同。
 * 这正是 K3(b) / K5 要把它交给后台舞台整场景补跑的那一类（pinned 划分轴一第 3 条）。
 */
function ProbeMotionJsCard({ playToken }: CardProps<Record<string, never>>) {
  const boxRef = useRef<HTMLDivElement>(null);
  const startRef = useRef(-1);
  useAnimationFrame((ms) => {
    if (startRef.current < 0) startRef.current = ms;
    const elapsed = ms - startRef.current;
    // 写进内联样式:生成快照时被 inlineDOMStyles 原样读走,两趟比得出差别
    if (boxRef.current) boxRef.current.style.transform = `translateX(${(elapsed / 5).toFixed(3)}px)`;
  });
  return (
    <div style={{ position: "absolute", inset: 0 }} key={playToken}>
      <div
        ref={boxRef}
        data-pc-probe="motion-js"
        style={{
          position: "absolute", left: 120, top: 420, width: 240, height: 240, borderRadius: 32,
          background: "#a78bfa", transform: "translateX(0px)",
        }}
      />
    </div>
  );
}

export const probeCssCard: CardDef<Record<string, never>> = {
  id: "probe-css",
  name: "探针卡 · 纯 CSS",
  description: "K1 布尔探针的判例:只有 CSS @keyframes,应当 vtOk / seekOk 都为 true",
  source: "native",
  // 帧模式:有动画历史,按 stateful 走推帧那条路(布尔探针只对 stepped 卡跑)
  frameMode: "stateful",
  defaults: {},
  controls: [],
  Component: ProbeCssCard,
};

export const probeMotionJsCard: CardDef<Record<string, never>> = {
  id: "probe-motion-js",
  name: "探针卡 · JS 驱动",
  description: "K1 布尔探针的判例:Motion 的帧循环每帧自己写 transform,应当 vtOk 为 false",
  source: "native",
  frameMode: "stateful",
  defaults: {},
  controls: [],
  Component: ProbeMotionJsCard,
};
