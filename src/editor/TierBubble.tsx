import { useEffect, useState, useSyncExternalStore } from "react";
import { BUBBLE_SHOW_MS, BUBBLE_WAIT_MS, TIER_BUBBLE_TEXT, subscribeTier, tierName, tierState } from "../online/onlineTier";

/** Shown only once per page session */
let shownThisSession = false;

/**
 * Tier bubble (semantics: the "Nouns" part of "Online browser" in `product/platforms.md`, user decision,
 * 2026-10-08): after the stage gate has passed and the editor is formally entered, a bubble above the
 * preview window tells the user which tier this device is in, and disappears by itself after a few
 * seconds. All four tiers show it, with the text set by the user (`TIER_BUBBLE_TEXT` in `onlineTier.ts`).
 *
 * It appears once the benchmark card of the on-demand render gate has a verdict (if the benchmark card
 * cannot run, it is low-spec mode), waiting at most `BUBBLE_WAIT_MS`. After it has appeared, later tier
 * changes (the runtime handshake fault tolerance falling back to a single stage) do not show it again.
 * Uses theme variables only, no new fixed colors. Mounted only on online pages.
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

/** For tests */
export function resetTierBubbleForTest(): void {
  shownThisSession = false;
}
