import { useEffect, useState } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { clockNow } from "../../kernel/clock";
import { HudParams, hudControls, hudDefaults, getPositionClass } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  file: string;
  lines: string;
  cps: number;
}

function Terminal3dCard({ params, playToken }: CardProps<Params>) {
  const [chars, setChars] = useState(0);

  useEffect(() => {
    const start = clockNow();
    let frame: number;
    const tick = () => {
      const now = clockNow();
      setChars(Math.floor(((now - start) / 1000) * params.cps));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [params.cps, playToken]);

  const linesArr = params.lines.split("|");
  let remainingChars = chars;
  const renderedLines = [];
  
  for (const line of linesArr) {
    if (remainingChars <= 0) break;
    if (remainingChars >= line.length) {
      renderedLines.push(line);
      remainingChars -= line.length;
    } else {
      renderedLines.push(line.substring(0, remainingChars));
      remainingChars = 0;
    }
  }


  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`} style={{ perspective: "1600px" }}>
      <style>{`
        @keyframes pc-term-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        .pc-term-cursor {
          display: inline-block;
          width: 24px;
          height: 1.2em;
          background-color: var(--pc-fg);
          vertical-align: middle;
          animation: pc-term-blink 1s step-end infinite;
          margin-left: 8px;
        }
      `}</style>
      <div
        className="hud-glass"
        style={{
          transform: "rotateY(-8deg)",
          padding: 0,
          width: "1200px",
          fontFamily: "var(--pc-font-mono, ui-monospace, monospace)",
          overflow: "hidden",
        }}
      >
        <div className="flex items-center px-8 py-4 bg-[rgba(0,0,0,0.3)] border-b border-[var(--pc-glass-border)]">
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-red-500" />
            <div className="w-6 h-6 rounded-full bg-yellow-500" />
            <div className="w-6 h-6 rounded-full bg-green-500" />
          </div>
          <div className="flex-1 text-center text-[32px] text-[var(--pc-fg-muted)]">{params.file}</div>
        </div>

        <div className="p-12 text-[48px] leading-[1.6]">
          {renderedLines.map((line, i) => {
            const firstChar = linesArr[i][0];
            let color = "var(--pc-fg)";
            if (firstChar === "$") color = "white";
            else if (firstChar === "#") color = "gray";
            else if (firstChar === "❯") color = "#00ffcc";
            else if (firstChar === "✓") color = "#10b981";

            const isLastRendered = i === renderedLines.length - 1;

            return (
              <div key={i} style={{ color }}>
                {line}
                {isLastRendered && <span className="pc-term-cursor" />}
              </div>
            );
          })}
          {renderedLines.length === 0 && (
            <div>
              <span className="pc-term-cursor" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const terminal3d: CardDef<Params> = {
  id: "terminal-3d",
  name: "Terminal 3D",
  description: "3D terminal typewriter",
  useWhen: "When demonstrating command lines, code or technical operations, use the 3D terminal to type commands out character by character. **The leading symbol decides the color**: `$` white, `#` gray, `❯` cyan, `✓` green; the layout depends on it largely. Playback duration equals total characters divided by cps, so a clip that is too short won't finish typing. For a plain-text typewriter use mu-typing.",
  tags: ["terminal","command line","code","Typewriter"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    position: "center",
    file: "deploy.sh",
    lines: "$ npm run build|# 正在构建...|❯ 进度 100%|✓ 构建完成",
    cps: 20,
  },
  controls: [
    ...hudControls,
    { key: "file", label: "File name", type: "text" },
    { key: "lines", label: "Lines (separated by |)", type: "text" },
    { key: "cps", label: "Characters per second", type: "number" },
  ],
  parts: [
    { id: "terminal", label: "terminal", role: "list", params: ["file", "lines", "cps"], enterMs: 0, settleMs: 1900 },
  ],
  lifecycle: { settleMs: 1900, after: "evolve", exit: ["fade"] },
  timing: (p) => {
    const chars = p.lines.split("|").reduce((sum, line) => sum + line.length, 0);
    const settle = (chars / (p.cps > 0 ? p.cps : 20)) * 1000;
    return { settleMs: settle, parts: { terminal: { settleMs: settle } } };
  },
  Component: Terminal3dCard,
};
