import { useId } from "react";

/**
 * The product logo.
 * The mark is a square cut diagonally: the solid half stands for rendered, and the outlined half stands
 * for pending.
 * The two halves share one brand gradient (the emphasis color fading into purple, the same one as
 * --ui-accent-grad); the gradient is laid across the whole square, so the colors of the two cut pieces
 * are continuous when put together. The gradient's stop colors go through CSS variables, so changing the
 * skin or the emphasis color follows along.
 * The seam width scales in proportion to the font size; below 16px the stroke is thickened to 2.5. The
 * wordmark uses the condensed face in the conditional font stack, with letter spacing .14em.
 */
export function LogoMark({ size = 22, mono = false }: { size?: number; mono?: boolean }) {
  const grad = `pc-logo-grad-${useId().replace(/:/g, "")}`;
  const stroke = size < 16 ? 2.5 : 1.5;
  const paint = mono ? "currentColor" : `url(#${grad})`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      {!mono && (
        <defs>
          <linearGradient id={grad} x1="1" y1="1" x2="31" y2="31" gradientUnits="userSpaceOnUse">
            <stop offset="0" style={{ stopColor: "var(--ui-accent, #00DBDB)" }} />
            <stop offset="1" style={{ stopColor: "var(--ui-accent-2, #6F69FC)" }} />
          </linearGradient>
        </defs>
      )}
      <path d="M1 1H17L11 31H1V1Z" fill={paint} />
      <path d="M20 1H31V31H14L20 1Z" stroke={paint} strokeWidth={stroke} />
    </svg>
  );
}

export function Logo({
  size = 22,
  wordmark = true,
  sub = false,
  name = "PromptCut",
}: {
  size?: number;
  wordmark?: boolean;
  /** Subtitle (VIDEO EDITOR), used in the vertical lockup */
  sub?: boolean;
  name?: string;
}) {
  return (
    <span className="pc-logo" style={{ gap: Math.round(size * 0.36) }}>
      <LogoMark size={size} />
      {wordmark && (
        <span className="pc-logo-text">
          <span className="pc-logo-word" style={{ fontSize: Math.round(size * 0.74) }}>
            {name}
          </span>
          {sub && <span className="pc-logo-sub">VIDEO EDITOR</span>}
        </span>
      )}
    </span>
  );
}
