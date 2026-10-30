import { useEffect, useState } from "react";
import type { CardDef, CardProps } from "../../kernel/types";

/**
 * E4b 的两张验收卡:**`setInterval` 和 `Date.now()` 在舞台里必须跟着虚拟时间走。**
 *
 * 它们不是给用户用的(所以放在 `_probe/`,和 `probe.tsx` 一起),只由
 * `scripts/probes/stage-content-probe.mjs` 挂进一个临时项目里验两条:
 *
 *   - 打字机卡:每 100 ms 推一格,后台舞台补跑到第 3 秒时**恰好 30 格**;
 *   - 倒计时卡:`advanceToAsync` 推 10 秒之后剩余时间**恰好少 10 秒**。
 *
 * 两条都靠 `render/stageClock.ts` 的 fake timers 和 `kernel/pinEntropy.ts` 钉住的 `Date.now`。
 * 舞台不接管这两样的话:打字机在虚拟时间下一格都不动(墙钟走完 3 秒才 30 格,而补跑是
 * 同步推的、几十毫秒就完了),倒计时按墙钟乱跑、两次探针的读数都不一样。
 */

/** 每格 100 毫秒。和 E4b 验收里写的那个数一致,改了验收就对不上了 */
const CELL_MS = 100;

function ProbeTypewriter({ playToken }: CardProps<Record<string, never>>) {
  const [cells, setCells] = useState(0);
  useEffect(() => {
    // 重挂载(playToken / remountGen 变)就从头数:补跑总是从挂载帧起推
    setCells(0);
    const id = setInterval(() => setCells((n) => n + 1), CELL_MS);
    return () => clearInterval(id);
  }, [playToken]);
  return (
    <div
      data-pc-probe="typewriter"
      data-pc-probe-cells={cells}
      style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#fff", font: "600 40px/1.2 ui-monospace, monospace" }}
    >
      {"█".repeat(cells)}
    </div>
  );
}

function ProbeCountdown({ t, playToken }: CardProps<Record<string, never>>) {
  const [deadline, setDeadline] = useState<number | null>(null);
  useEffect(() => {
    // 挂载那一刻读一次表,之后每帧算「还剩多久」—— 读的是被钉住的 Date.now(虚拟时间)
    setDeadline(Date.now() + 60_000);
  }, [playToken]);
  // `t` 只是「每帧重渲一次」的触发:真正的读数来自 Date.now()
  void t;
  const remaining = deadline === null ? 60_000 : deadline - Date.now();
  return (
    <div
      data-pc-probe="countdown"
      data-pc-probe-remaining={remaining}
      style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#fff", font: "600 40px/1.2 ui-monospace, monospace" }}
    >
      {(remaining / 1000).toFixed(2)}s
    </div>
  );
}

export const probeTimerCards: CardDef<Record<string, never>>[] = [
  {
    id: "probe-typewriter",
    name: "探针卡:打字机(setInterval)",
    description: "E4b 验收用:每 100 ms 推一格",
    source: "native",
    frameMode: "stateful",
    defaults: {},
    controls: [],
    Component: ProbeTypewriter,
  },
  {
    id: "probe-countdown",
    name: "探针卡:倒计时(Date.now)",
    description: "E4b 验收用:按 Date.now() 倒数",
    source: "native",
    frameMode: "stateful",
    defaults: {},
    controls: [],
    Component: ProbeCountdown,
  },
];
