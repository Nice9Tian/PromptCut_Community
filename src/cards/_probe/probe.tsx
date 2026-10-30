import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";

declare global {
  interface Window {
    __pcProbeMs?: number;
  }
}

function ProbeCard({ playToken }: CardProps<Record<string, never>>) {
  const timeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let startMs = -1;
    let frame = requestAnimationFrame(function loop() {
      const ms = performance.now();
      if (startMs < 0) startMs = ms;
      const elapsed = ms - startMs;
      window.__pcProbeMs = elapsed;
      if (timeRef.current) {
        timeRef.current.textContent = `t=${elapsed.toFixed(1)}ms`;
      }
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="absolute inset-0 grid grid-cols-3 place-items-center text-white pointer-events-none" key={playToken}>
      <style>{`
        @keyframes pcSpin {
          from { transform: rotate(0deg) }
          to { transform: rotate(360deg) }
        }
      `}</style>

      {/* Motion JS */}
      <motion.div
        initial={{ opacity: 0, x: -200 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 1.5, ease: "linear" }}
        className="text-4xl font-bold bg-blue-600 p-8 rounded-xl"
      >
        淡入平移
      </motion.div>

      {/* CSS @keyframes */}
      <div
        className="bg-red-500 rounded-xl flex items-center justify-center text-2xl font-bold"
        style={{ width: 200, height: 200, animation: "pcSpin 2s linear infinite" }}
      >
        CSS 旋转
      </div>

      {/* rAF counter */}
      <div
        ref={timeRef}
        className="text-5xl font-mono bg-gray-800 p-6 rounded-xl border border-gray-600"
      >
        t=0.0ms
      </div>
    </div>
  );
}

export const probeCard: CardDef<Record<string, never>> = {
  id: "probe",
  name: "探针卡",
  description: "测试渲染管线稳定性",
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: {},
  controls: [],
  Component: ProbeCard,
};
