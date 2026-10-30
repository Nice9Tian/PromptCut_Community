import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReadOnly } from "../readOnly";

/**
 * 左栏统一的预览卡:动效卡片、部件、转场、强调、视频、图像都长这样。
 *
 * 一张卡 = 画面区 + 压在底边的标题条 + (可选)贴着底边的强调色进度条。
 * 画面区放什么由调用方决定(`preview`),这里只负责壳:尺寸、悬停、拖拽、右键、
 * 标题、角标、进度条、错误提示。悬停状态由这里维护并回传(`onHover`),视频要在悬停时
 * 才播、动效卡要在悬停时才起动画,都靠这一个信号。
 *
 * 尺寸两种给法:`fill` 铺满外面给的格子(瀑布流按 tileHeight 定好了高),否则按 `aspect`(高 / 宽,默认正方形)。
 * 媒体用 object-fit: cover 居中裁切。
 *
 * 样式在 left.css 的 .pc-lib-card*。**不复用** `.cursor-grab.bg-neutral-900` 那套皮肤规则:
 * 它悬停时往卡片左边画一道 3px 的强调色内阴影,预览一铺满就成了漏进画面里的一条色边,
 * 这里的悬停态只描边、不画内阴影。
 */
export interface PreviewCardProps {
  title: string;
  subtitle?: string;
  /** 画面区内容。null 时只显示标题和说明(动效卡不悬停时就是这样) */
  preview: ReactNode;
  /** 0..1,给底边画强调色进度条;null / undefined 不画 */
  progress?: number | null;
  /** 悬停延迟(毫秒):动效卡要等一下再起动画,免得鼠标扫过去就全体开演 */
  hoverDelayMs?: number;
  onHover?: (hot: boolean) => void;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  /** 一闪而过的错误提示(比如「没有动效轨」),非空就显示 */
  error?: string | null;
  /** 画面区下面再接一行(转场页接缝卡的操作按钮) */
  footer?: ReactNode;
  /** 挂在根节点上的 data-* 之类,自动化测试靠它们定位 */
  attrs?: Record<string, string>;
  titleAttr?: string;
  /** 标题条什么时候显示:一直 / 只在悬停时(动效卡不悬停时名字已经写在画面区里) */
  caption?: "always" | "hover";
  /** 高 / 宽;不给是正方形。fill 时不看它 */
  aspect?: number;
  /** 左下角的深色小胶囊(视频时长 0:13) */
  badge?: ReactNode;
  /** 铺满父容器(瀑布流的格子) */
  fill?: boolean;
  /**
   * 点它或拖它会改项目(加到时间轴、加进组合卡、给片段套强调 / 转场)。这个项目只给了只读权限(游客)时,
   * 带这一项的卡不接点击和拖动,悬停写明原因;悬停预览、右键菜单这类只看的照常。
   */
  edits?: boolean;
}

export function PreviewCard(props: PreviewCardProps) {
  const {
    title, subtitle, preview, progress, hoverDelayMs = 0, onHover, onClick, onContextMenu, draggable, onDragStart, onDragEnd,
    error, footer, attrs, titleAttr, caption = "always", aspect, badge, fill, edits,
  } = props;
  const ro = useReadOnly();
  const frozen = !!edits && ro.locked;
  const [hot, setHot] = useState(false);
  const timer = useRef<number | null>(null);
  const hotRef = useRef(false);

  const setHotBoth = (v: boolean) => {
    if (hotRef.current === v) return;
    hotRef.current = v;
    setHot(v);
    onHover?.(v);
  };

  const enter = () => {
    if (timer.current) window.clearTimeout(timer.current);
    if (hoverDelayMs > 0) {
      timer.current = window.setTimeout(() => setHotBoth(true), hoverDelayMs);
    } else {
      setHotBoth(true);
    }
  };
  const leave = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setHotBoth(false);
  };

  // 卸载时别留着定时器,也别让父级以为还悬停着
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const showCaption = caption === "always" || hot;
  const pct = typeof progress === "number" && Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : null;
  const hasBadge = badge != null && badge !== false;

  return (
    <div className={`pc-lib-card-wrap${fill ? " is-fill" : ""}`}>
      <div
        {...attrs}
        className={`pc-lib-card${hot ? " is-hot" : ""}${draggable && !frozen ? " is-grab" : ""}${onClick && !frozen ? " is-click" : ""}${frozen ? " is-readonly" : ""}`}
        aria-disabled={frozen || undefined}
        draggable={draggable && !frozen}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onDragStart={(e) => { leave(); onDragStart?.(e); }}
        onDragEnd={onDragEnd}
        onClick={frozen ? undefined : onClick}
        onContextMenu={onContextMenu}
        title={frozen ? `${title}\n${ro.why}` : titleAttr}
        style={fill ? undefined : { aspectRatio: `1 / ${aspect && aspect > 0 ? aspect : 1}` }}
      >
        <div className="pc-lib-card-view">{preview}</div>
        {showCaption ? (
          <div className="pc-lib-card-cap">
            <div className="pc-lib-card-title">{title}</div>
            {(hasBadge || subtitle) && (
              <div className="pc-lib-card-meta">
                {hasBadge && <span className="pc-lib-card-badge">{badge}</span>}
                {subtitle && <span className="pc-lib-card-sub">{subtitle}</span>}
              </div>
            )}
          </div>
        ) : (
          hasBadge && <span className="pc-lib-card-badge is-corner">{badge}</span>
        )}
        {pct !== null && (
          <div className="pc-lib-card-bar" aria-hidden="true">
            <div className="pc-lib-card-bar-fill" style={{ width: `${pct * 100}%` }} />
          </div>
        )}
        {error && <div className="pc-lib-card-err">{error}</div>}
      </div>
      {footer}
    </div>
  );
}
