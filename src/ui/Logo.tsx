import { useId } from "react";

/**
 * 产品标识。
 * 标记是一个被斜切开的方形:实心一半代表已渲染,描边一半代表待处理。
 * 两半共用一条品牌渐变(强调色过渡到紫色,和 --ui-accent-grad 同一条),
 * 渐变按整个方形铺,切开的两块拼起来颜色是连续的。停靠色走 CSS 变量,换皮肤、改强调色都会跟着变。
 * 缝宽随字号等比缩放;16px 以下描边加粗到 2.5。字标用条件字体栈里的窄体,字距 .14em。
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
  /** 副标(VIDEO EDITOR),纵向组合时用 */
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
