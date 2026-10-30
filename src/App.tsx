import { useEffect, useRef, useState } from "react";
import { Stage } from "./render/Stage";
import { allCards } from "./kernel/registry";
import type { Timeline } from "./kernel/types";
import { demoTimeline } from "./demo";
import "./cards";

/** 原型预览:播放/暂停/拖动 + 每张卡单独重播。时间轴是 demo.ts 里写死的。 */
export default function App() {
  const [timeline] = useState<Timeline>(demoTimeline);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playToken, setPlayToken] = useState(1);
  const [scale, setScale] = useState(0.5);
  const tRef = useRef(0);
  tRef.current = t;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const nt = tRef.current + (now - last) / 1000;
      last = now;
      if (nt >= timeline.duration) {
        setT(0);
        setPlaying(false);
        return;
      }
      setT(nt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, timeline.duration]);

  useEffect(() => {
    const onResize = () =>
      setScale(Math.min((window.innerWidth - 48) / timeline.width, (window.innerHeight - 220) / timeline.height));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [timeline.width, timeline.height]);

  const seek = (sec: number) => {
    setT(sec);
    setPlayToken((k) => k + 1);
  };
  const activeClip = timeline.clips.find((c) => t >= c.start && t < c.end);

  return (
    <div className="flex flex-col h-full p-3 gap-3 select-none">
      <div className="flex items-center gap-3 text-sm">
        <span className="font-semibold">PromptCut 原型</span>
        <button className="px-3 py-1 rounded bg-neutral-700 hover:bg-neutral-600" onClick={() => setPlaying((p) => !p)}>
          {playing ? "暂停" : "播放"}
        </button>
        <button
          className="px-3 py-1 rounded bg-neutral-700 hover:bg-neutral-600"
          onClick={() => seek(activeClip ? activeClip.start : 0)}
        >
          重播本卡
        </button>
        <span className="tabular-nums w-24">{t.toFixed(2)} s</span>
        <span className="text-neutral-400">{activeClip ? activeClip.cardId : "—"}</span>
        <span className="ml-auto text-neutral-500">已注册 {allCards().length} 张卡</span>
      </div>
      <input
        type="range"
        min={0}
        max={timeline.duration}
        step={1 / timeline.fps}
        value={t}
        onChange={(e) => seek(Number(e.target.value))}
        className="w-full"
      />
      <div className="flex flex-wrap gap-1 text-xs">
        {timeline.clips.map((c) => (
          <button
            key={c.id}
            className={`px-2 py-1 rounded ${activeClip?.id === c.id ? "bg-sky-600" : "bg-neutral-800 hover:bg-neutral-700"}`}
            onClick={() => {
              setPlaying(false);
              seek(c.start);
            }}
          >
            {c.cardId}
          </button>
        ))}
      </div>
      <div className="flex-1 grid place-items-center overflow-hidden">
        <div
          style={{
            width: timeline.width * scale,
            height: timeline.height * scale,
            backgroundImage:
              "linear-gradient(45deg,#1b1b1b 25%,transparent 25%,transparent 75%,#1b1b1b 75%),linear-gradient(45deg,#1b1b1b 25%,#222 25%,#222 75%,#1b1b1b 75%)",
            backgroundSize: "32px 32px",
            backgroundPosition: "0 0,16px 16px",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0", position: "absolute", left: 0, top: 0 }}>
            <Stage timeline={timeline} t={t} playToken={playToken} />
          </div>
        </div>
      </div>
    </div>
  );
}
