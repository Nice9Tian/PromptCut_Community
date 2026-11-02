import { useEffect, useMemo, useState, type HTMLAttributes, type ReactNode } from "react";
import { loadWave } from "../../timeline/AudioWaveform";
import { useReadOnly } from "../../readOnly";

type Wave = { peaks: number[]; duration: number };

/** How many vertical bars the waveform draws: the strip is only one or two hundred pixels wide, and 100 bars are enough to show the ups and downs */
const BARS = 100;

export interface AudioStripProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  name: ReactNode;
  /** The muted text line under the name (duration, description, "used in N segments"...) */
  sub?: ReactNode;
  /** If given, draws the whole waveform in the background (range 0..duration), independent of timeline clips */
  url?: string;
  icon?: "play" | "fx" | "plus";
  /** Action buttons that only show on hover / keyboard focus */
  actions?: ReactNode;
  /** Automation hooks such as data-* */
  attrs?: Record<string, string>;
  /** Dragging or clicking it changes the project: when this project grants only read-only access (guest), dragging is not accepted and hover states the reason (same as edits in PreviewCard) */
  edits?: boolean;
}

/**
 * A 56px-high rounded audio strip: icon on the left, name and a description line in the middle,
 * the whole waveform in the background.
 * Used by audio media in the media library and by audio effects / presets under effects.
 */
export function AudioStrip({ name, sub, url, icon = "play", actions, attrs, className, edits, ...rest }: AudioStripProps) {
  const [wave, setWave] = useState<Wave | null>(null);
  const ro = useReadOnly();
  const frozen = !!edits && ro.locked;

  useEffect(() => {
    if (!url) {
      setWave(null);
      return;
    }
    let alive = true;
    void loadWave(url).then((w) => {
      if (alive) setWave(w);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  const path = useMemo(() => {
    if (!wave || wave.peaks.length === 0) return "";
    const n = wave.peaks.length;
    const parts: string[] = [];
    for (let i = 0; i < BARS; i++) {
      const from = Math.floor((i / BARS) * n);
      const to = Math.max(from + 1, Math.ceil(((i + 1) / BARS) * n));
      let peak = 0;
      for (let j = from; j < to && j < n; j++) peak = Math.max(peak, wave.peaks[j]);
      const h = Math.max(0.6, peak * 24);
      parts.push(`M${i + 0.5},${28 - h}V${28 + h}`);
    }
    return parts.join("");
  }, [wave]);

  return (
    <div
      {...rest}
      {...attrs}
      {...(frozen ? { draggable: false, onClick: undefined, onDragStart: undefined, title: ro.why, "aria-disabled": true } : {})}
      className={`pc-lib-strip${className && !frozen ? ` ${className}` : ""}${frozen ? " is-readonly" : ""}`}
    >
      {path && (
        <svg className="pc-lib-strip-wave" viewBox={`0 0 ${BARS} 56`} preserveAspectRatio="none" aria-hidden="true">
          <path d={path} stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      <span className="pc-lib-strip-icon" aria-hidden="true">
        {icon === "play" ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        ) : icon === "plus" ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
          </svg>
        )}
      </span>
      <span className="pc-lib-strip-text">
        {/* The name row is flex (it may be followed by a small "Varies over time" label), so plain text needs a wrapper to be truncated with an ellipsis */}
        <span className="pc-lib-strip-name">{typeof name === "string" ? <span className="pc-lib-ellipsis">{name}</span> : name}</span>
        {sub != null && sub !== "" && <span className="pc-lib-strip-sub">{sub}</span>}
      </span>
      {actions && <span className="pc-lib-strip-actions">{actions}</span>}
    </div>
  );
}
