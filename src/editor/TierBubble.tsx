import { useEffect, useState, useSyncExternalStore } from "react";
import { BUBBLE_SHOW_MS, BUBBLE_WAIT_MS, TIER_BUBBLE_TEXT, subscribeTier, tierName, tierState } from "../online/onlineTier";

/** 一个页面会话只出一次 */
let shownThisSession = false;

/**
 * 档位气泡(语义 `product/platforms.md`「在线浏览器」的「名词」,2026-10-08 用户定):舞台闸门走完、正式进入编辑界面后,
 * 在预览窗口上方用气泡告诉用户这台设备处在哪一档,几秒后自动消失。四档都提示,文字照用户定的(`onlineTier.ts` 的 `TIER_BUBBLE_TEXT`)。
 *
 * 等即时渲染闸门的基准卡有了结论再出(基准卡跑不动就是低配模式),最多等 `BUBBLE_WAIT_MS`;出了之后档位再变(运行中握手容错退回单舞台)不再出。
 * 只用主题变量,不引入新的固定配色。只在在线页面挂。
 */
export function TierBubble({ ready }: { ready: boolean }) {
  const t = useSyncExternalStore(subscribeTier, tierState, tierState);
  const [text, setText] = useState<string | null>(null);
  const [waitedOut, setWaitedOut] = useState(false);
  const gateDone = t.online && t.gate === "done" && ready;
  useEffect(() => {
    if (!gateDone || shownThisSession) return;
    const timer = window.setTimeout(() => setWaitedOut(true), BUBBLE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [gateDone]);
  useEffect(() => {
    if (!gateDone || shownThisSession) return;
    if (t.benchmark === "pending" && !waitedOut) return;
    shownThisSession = true;
    setText(TIER_BUBBLE_TEXT[tierName(t)]);
  }, [gateDone, t, waitedOut]);
  useEffect(() => {
    if (!text) return;
    const timer = window.setTimeout(() => setText(null), BUBBLE_SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [text]);
  if (!text) return null;
  return (
    <div
      data-pc="tier-bubble"
      data-tier={tierName(t)}
      role="status"
      aria-live="polite"
      style={{
        position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 30, pointerEvents: "none",
        maxWidth: "min(92%, 520px)", padding: "6px 12px", borderRadius: "var(--ui-radius-lg, 8px)",
        background: "var(--ui-panel-2)", color: "var(--ui-fg)", border: "1px solid var(--ui-border)",
        boxShadow: "0 4px 16px color-mix(in srgb, var(--ui-fg) 18%, transparent)", fontSize: 13, lineHeight: 1.5, textAlign: "center",
      }}
    >
      {text}
    </div>
  );
}

/** 测试用 */
export function resetTierBubbleForTest(): void {
  shownThisSession = false;
}
