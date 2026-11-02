import type { PartDef, PartProps } from "../../kernel/partTypes";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * 3D typewriter terminal: displays the process of typing out a piece of code or command character
 * by character.
 * Extracted from terminal-3d, directly calculates character count based on time parameter t rather
 * than internal rAF.
 * Entrance: types character by character according to the given cps.
 */
interface Params {
  file: string;
  lines: string;
  cps: number;
  size: number;
}

function MediaTerminalPart({ params, width, height, t }: PartProps<Params>) {
  const chars = Math.floor(t * (params.cps > 0 ? params.cps : 20));

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

  const numLines = Math.max(1, linesArr.length);
  const size = fitOr(params.size, { width: width - 96, height: (height - 192) * 0.65, text: params.lines, splitter: "|", lines: numLines, lineHeight: 1.6, max: 120 });

  return (
    <div style={{ position: "absolute", inset: 0, width, height, perspective: "1600px", display: "flex", justifyContent: "center", alignItems: "center" }}>
      <style>{`
        @keyframes pc-term-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        .pc-term-cursor {
          display: inline-block;
          width: 0.5em;
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
          width: "100%",
          height: "100%",
          fontFamily: "var(--pc-font-mono, ui-monospace, monospace)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="flex items-center px-8 py-4 bg-[rgba(0,0,0,0.3)] border-b border-[var(--pc-glass-border)]">
          <div className="flex gap-4">
            <div className="w-6 h-6 rounded-full bg-red-500" />
            <div className="w-6 h-6 rounded-full bg-yellow-500" />
            <div className="w-6 h-6 rounded-full bg-green-500" />
          </div>
          <div className="flex-1 text-center text-[var(--pc-fg-muted)]" style={{ fontSize: size * 0.66 }}>{params.file}</div>
        </div>

        <div className="p-12 flex-1 leading-[1.6]" style={{ fontSize: size }}>
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

export const mediaTerminal: PartDef<Params> = {
  id: "media-terminal",
  name: "Terminal 3D",
  description: "3D terminal typewriter",
  useWhen: "Use when demonstrating command lines, code or technical operations. **The leading symbol of a line determines its color** ($ white, # gray, ❯ cyan, ✓ green), and the layout depends on it half the time. Playback duration = total characters / cps, and a clip that is too short will not finish typing. Do not use it for ordinary typewriter text.",
  tags: ["terminal", "command line", "code", "Typewriter"],
  role: "media",
  from: "terminal-3d",
  defaults: {
    file: "deploy.sh",
    lines: "$ npm run build|# 正在构建...|❯ 进度 100%|✓ 构建完成",
    cps: 20,
    size: 0,
  },
  controls: [
    { key: "file", label: "File name", type: "text" },
    { key: "lines", label: "Lines (separated by |)", type: "text" },
    { key: "cps", label: "Characters per second", type: "number", min: 5, max: 100, step: 1 },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 120, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
  ],
  defaultFrame: { x: 960, y: 540, w: 1200, h: 800, anchor: [0.5, 0.5] },
  settleMs: (p) => (p.lines.split("|").reduce((sum, line) => sum + line.length, 0) / (p.cps > 0 ? p.cps : 20)) * 1000,
  after: "evolve",
  Component: MediaTerminalPart,
};

