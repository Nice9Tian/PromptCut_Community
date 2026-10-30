import { useEffect, useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";

/**
 * R6(数据面)端到端探针用的四张固定卡。**只给 `scripts/probes/ready-index-probe.mjs` 用**,
 * 不出现在卡片面板的推荐里 —— 和 `probe.tsx` 一样住在 `_probe/`。
 *
 * 四张卡各自钉一条 R6 的判据:
 *
 *   `r6-stateful` stateful 的 DOM 卡,审阅表 `independent` → **共享档**(`kind: 'html'`);
 *   `r6-canvas`   canvas 卡(审阅表 `surface: canvas2d`)→ 共享档,但体积上限走 1 MB 那一档;
 *   `r6-unknown`  **不进审阅表** → `compositing: 'unknown'` → 按下层依赖卡处理、
 *                 只有**本地档**(`kind: 'local'`),不上云、不进流(计划 3.1(2));
 *   `r6-huge`     故意让单帧快照超过 300 KB:照常落盘,但**不进就绪索引**(A3c)。
 */

/** `r6-huge` 撑出多少个节点。每个节点带一段独有的内联样式,差异内联压不掉 */
const HUGE_NODES = 1400;

function StatefulCard({ playToken }: CardProps<Record<string, never>>) {
  return (
    <div className="absolute inset-0 grid place-items-center text-white" key={playToken}>
      <style>{`@keyframes r6Slide { from { transform: translateX(-300px) } to { transform: translateX(300px) } }`}</style>
      <div
        className="rounded-xl bg-emerald-600 px-10 py-6 text-4xl font-bold"
        style={{ animation: "r6Slide 2s linear infinite" }}
      >
        R6 推帧卡
      </div>
    </div>
  );
}

function CanvasCard({ t = 0, playToken }: CardProps<Record<string, never>>) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 按 t 画一圈点:画面随帧变,快照里它是一张 data:image
    for (let i = 0; i < 48; i++) {
      const angle = (i / 48) * Math.PI * 2 + t;
      ctx.fillStyle = `hsl(${(i * 7 + t * 60) % 360} 80% 60%)`;
      ctx.beginPath();
      ctx.arc(160 + Math.cos(angle) * 120, 160 + Math.sin(angle) * 120, 10, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [t]);
  return (
    <div className="absolute inset-0 grid place-items-center" key={playToken}>
      <canvas ref={ref} width={320} height={320} />
    </div>
  );
}

function UnknownCard({ t = 0, playToken }: CardProps<Record<string, never>>) {
  return (
    <div className="absolute inset-0 grid place-items-center text-white" key={playToken}>
      <div className="rounded-xl bg-fuchsia-700 px-10 py-6 text-4xl font-bold" style={{ opacity: 0.4 + 0.6 * (t % 1) }}>
        R6 拿不准的卡
      </div>
    </div>
  );
}

function HugeCard({ t = 0, playToken }: CardProps<Record<string, never>>) {
  const frame = Math.round(t * 1000);
  return (
    <div className="absolute inset-0 overflow-hidden" key={playToken}>
      {Array.from({ length: HUGE_NODES }, (_, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            left: (i * 37) % 1900,
            top: (i * 53) % 1060,
            width: 9 + (i % 7),
            height: 9 + (i % 5),
            borderRadius: 2 + (i % 4),
            letterSpacing: `${i % 3}px`,
            background: `rgb(${(i * 3 + frame) % 256}, ${(i * 5) % 256}, ${(i * 7) % 256})`,
          }}
        >
          {i % 10}
        </span>
      ))}
    </div>
  );
}

export const r6StatefulCard: CardDef<Record<string, never>> = {
  id: "r6-stateful", name: "R6 推帧卡", description: "R6 探针:stateful 的 DOM 卡,走共享档",
  source: "native", frameMode: "stateful", defaults: {}, controls: [], Component: StatefulCard,
};

export const r6CanvasCard: CardDef<Record<string, never>> = {
  id: "r6-canvas", name: "R6 画布卡", description: "R6 探针:canvas 卡,体积上限走 1 MB 那一档",
  source: "native", frameMode: "stateful", defaults: {}, controls: [], Component: CanvasCard,
};

export const r6UnknownCard: CardDef<Record<string, never>> = {
  // **故意不进审阅表**:真实项目里的定制卡就是这个样子
  id: "r6-unknown", name: "R6 未审阅卡", description: "R6 探针:审阅表没覆盖,按下层依赖卡处理、只有本地档",
  source: "native", frameMode: "stateful", defaults: {}, controls: [], Component: UnknownCard,
};

export const r6HugeCard: CardDef<Record<string, never>> = {
  id: "r6-huge", name: "R6 超限卡", description: "R6 探针:单帧快照超过 300 KB,落盘但不进就绪索引",
  source: "native", frameMode: "stateful", defaults: {}, controls: [], Component: HugeCard,
};

export const r6ProbeCards = [r6StatefulCard, r6CanvasCard, r6UnknownCard, r6HugeCard];
