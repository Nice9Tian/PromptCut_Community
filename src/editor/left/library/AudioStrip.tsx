import { useEffect, useMemo, useState, type HTMLAttributes, type ReactNode } from "react";
import { loadWave } from "../../timeline/AudioWaveform";
import { useReadOnly } from "../../readOnly";

type Wave = { peaks: number[]; duration: number };

/** 波形画多少根竖线:条带只有一两百像素宽,100 根足够看出起伏 */
const BARS = 100;

export interface AudioStripProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  name: ReactNode;
  /** 名字下面那行弱文字(时长、说明、「用在 N 段」……) */
  sub?: ReactNode;
  /** 给了就在背景画整段波形(范围 0..duration),不依赖时间轴片段 */
  url?: string;
  icon?: "play" | "fx" | "plus";
  /** 悬停 / 键盘聚焦时才露出来的操作按钮 */
  actions?: ReactNode;
  /** data-* 之类的自动化钩子 */
  attrs?: Record<string, string>;
  /** 拖它或点它会改项目:这个项目只给了只读权限(游客)时不接拖动、悬停写明原因(同 PreviewCard 的 edits) */
  edits?: boolean;
}

/**
 * 56px 高的圆角音频条:左边图标,中间名字和一行说明,背景是整段波形。
 * 素材库的音频素材、特效里的音频效果 / 预设都用它。
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
        {/* 名字行是 flex(后面可能跟「随时间变化」小标签),纯文字要包一层才截得出省略号 */}
        <span className="pc-lib-strip-name">{typeof name === "string" ? <span className="pc-lib-ellipsis">{name}</span> : name}</span>
        {sub != null && sub !== "" && <span className="pc-lib-strip-sub">{sub}</span>}
      </span>
      {actions && <span className="pc-lib-strip-actions">{actions}</span>}
    </div>
  );
}
