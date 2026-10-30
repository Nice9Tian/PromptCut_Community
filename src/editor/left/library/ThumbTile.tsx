import type { ReactNode } from "react";

/**
 * 总览组框里的缩略预览:和 PreviewCard 同一套外观,但纯展示 ——
 * 不接点击、拖动、右键,也不挂 data-pc-card / data-pc-media 这类钩子(那些只属于详情里的真卡片),
 * 否则点缩略图会一边加到播放头一边打开组,自动化脚本也会找到两份同名元素。
 *
 * 唯一的例外是 `onHover`(视频缩略悬停播放):给了它,这一格就接指针(.is-hoverplay 把组框缩略区的
 * pointer-events: none 翻回来),但只听进出,点击照样冒泡到组框上打开组。
 */
export function ThumbTile({
  title,
  subtitle,
  preview,
  badge,
  name,
  desc,
  onHover,
}: {
  /** 压在底边的标题条 */
  title?: string;
  subtitle?: string;
  /** 画面区内容(图片、视频首帧、示意图) */
  preview?: ReactNode;
  badge?: ReactNode;
  /** 动效卡不悬停时那种「名字 + 说明」的文字画面 */
  name?: string;
  desc?: string;
  /** 指针进 / 出这一格 */
  onHover?: (hot: boolean) => void;
}) {
  return (
    <div
      className={`pc-lib-card is-static${onHover ? " is-hoverplay" : ""}`}
      onMouseEnter={onHover ? () => onHover(true) : undefined}
      onMouseLeave={onHover ? () => onHover(false) : undefined}
    >
      <div className="pc-lib-card-view">
        {preview}
        {name != null && (
          <div className="pc-lib-card-text">
            <div className="pc-lib-card-name">{name}</div>
            {desc && <div className="pc-lib-card-desc">{desc}</div>}
          </div>
        )}
      </div>
      {title ? (
        <div className="pc-lib-card-cap">
          <div className="pc-lib-card-title">{title}</div>
          {(badge != null || subtitle) && (
            <div className="pc-lib-card-meta">
              {badge != null && <span className="pc-lib-card-badge">{badge}</span>}
              {subtitle && <span className="pc-lib-card-sub">{subtitle}</span>}
            </div>
          )}
        </div>
      ) : (
        badge != null && <span className="pc-lib-card-badge is-corner">{badge}</span>
      )}
    </div>
  );
}
