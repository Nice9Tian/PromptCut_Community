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
  name: "终端3D",
  description: "3D终端打字机",
  useWhen: "演示命令行、代码或技术操作时,用 3D 终端把命令逐字打出来。**行首符号决定颜色**:`$` 白、`#` 灰、`❯` 青、`✓` 绿,排版一半靠它。播放时长等于总字符数除以 cps,clip 太短会打不完。普通文字打字机用 mu-typing。",
  tags: ["终端","命令行","代码","打字机"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
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
    { key: "file", label: "文件名", type: "text" },
    { key: "lines", label: "行(|分隔)", type: "text" },
    { key: "cps", label: "每秒字符", type: "number" },
  ],
  parts: [
    { id: "terminal", label: "终端", role: "list", params: ["file", "lines", "cps"], enterMs: 0, settleMs: 1900 },
  ],
  lifecycle: { settleMs: 1900, after: "evolve", exit: ["fade"] },
  timing: (p) => {
    const chars = p.lines.split("|").reduce((sum, line) => sum + line.length, 0);
    const settle = (chars / (p.cps > 0 ? p.cps : 20)) * 1000;
    return { settleMs: settle, parts: { terminal: { settleMs: settle } } };
  },
  Component: Terminal3dCard,
};
