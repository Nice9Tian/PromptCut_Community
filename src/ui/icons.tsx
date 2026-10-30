import type { SVGProps } from "react";

/**
 * 按钮图标(设计稿「工具栏组件表」第 04 节)。
 * 统一规格:24 画幅、18px 显示、1.5 描边、方头端点、fill 走 none;颜色一律 currentColor,
 * 由按钮的文字色决定(常态次文字、悬浮主文字、主按钮跟随按钮前景)。
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Stroked({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** 播放:唯一的实心图标 */
export function IconPlay({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
      <path d="M7 4l13 8-13 8z" />
    </svg>
  );
}

/** 暂停:设计稿没给,按播放的实心规格补一个(播放/暂停是同一个按钮的两态) */
export function IconPause({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
      <path d="M8 5h3v14H8z" />
      <path d="M13 5h3v14h-3z" />
    </svg>
  );
}

export function IconReplay(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M11 9l4 3-4 3z" />
    </Stroked>
  );
}

export function IconUndo(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 0 10h-4" />
    </Stroked>
  );
}

export function IconRedo(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H9a5 5 0 0 0 0 10h4" />
    </Stroked>
  );
}

export function IconImport(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M12 3v10" />
      <path d="M8 9l4 4 4-4" />
      <path d="M4 16v4h16v-4" />
    </Stroked>
  );
}

export function IconOpen(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M3 8V5h6l2 2h8v3" />
      <path d="M3 8h18l-2 11H5z" />
    </Stroked>
  );
}

export function IconSave(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M8 4v5h7V4" />
      <path d="M8 14h8" />
    </Stroked>
  );
}

export function IconExport(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M12 20V9" />
      <path d="M8 13l4-4 4 4" />
      <path d="M4 4h16" />
    </Stroked>
  );
}

export function IconNewChat(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M4 5h16v11H9l-5 4z" />
      <path d="M12 8v5" />
      <path d="M9.5 10.5h5" />
    </Stroked>
  );
}

export function IconClock(p: IconProps) {
  return (
    <Stroked {...p}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </Stroked>
  );
}

export function IconCursor(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M4 4l5.5 16.5L12 14l5-5-13-5z" />
    </Stroked>
  );
}

export function IconText(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M4 6V4h16v2" />
      <path d="M12 4v16" />
      <path d="M9 20h6" />
    </Stroked>
  );
}

export function IconMove(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
      <path d="M8 9l4-4 4 4" />
      <path d="M8 15l4 4 4-4" />
      <path d="M15 8l4 4-4 4" />
      <path d="M9 8l-4 4 4 4" />
    </Stroked>
  );
}

/** 更多操作(三点) */
export function IconMore(p: IconProps) {
  return (
    <Stroked {...p}>
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
      <circle cx="5" cy="12" r="1" fill="currentColor" />
    </Stroked>
  );
}

/** 项目设置(齿轮) */
export function IconSettings(p: IconProps) {
  return (
    <Stroked {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Stroked>
  );
}


/** 回到开始页 */
export function IconHome(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M4 11l8-6.5 8 6.5" />
      <path d="M6.5 9.5V19h11V9.5" />
      <path d="M10 19v-5h4v5" />
    </Stroked>
  );
}

/** 配音设置:正在说话的小人(头、肩,嘴前两道声波)。以前是一排竖条声波,看着像语音识别 */
export function IconVoice(p: IconProps) {
  return (
    <Stroked {...p}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20.5c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5" />
      <path d="M15.5 6a3.5 3.5 0 0 1 0 4.5" />
      <path d="M18 3.5a7 7 0 0 1 0 9.5" />
    </Stroked>
  );
}

/** 新建项目 */
export function IconNew(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M13 3H6v18h12V8z" />
      <path d="M13 3v5h5" />
      <path d="M12 12v6M9 15h6" />
    </Stroked>
  );
}

/* ── 配色诊断与修正 v2 整屏用到、之前没有的图标 ─────────────────────────
 * 规格同上:24 画幅、1.5 描边、currentColor。 */

/** 上一段 / 跳到开头 */
export function IconSkipBack(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M11 5L5 12l6 7M19 5l-6 7 6 7" />
    </Stroked>
  );
}
/** 下一段 / 跳到结尾 */
export function IconSkipForward(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M13 5l6 7-6 7M5 5l6 7-6 7" />
    </Stroked>
  );
}
/** 循环播放 */
export function IconLoop(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </Stroked>
  );
}
/** 扬声器 */
export function IconVolume(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M11 5L6 9H3v6h3l5 4z" />
      <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" />
    </Stroked>
  );
}
/** 静音 */
export function IconVolumeMute(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M11 5L6 9H3v6h3l5 4z" />
      <path d="M16 9l5 6M21 9l-5 6" />
    </Stroked>
  );
}
/** 锁定 */
export function IconLock(p: IconProps) {
  return (
    <Stroked {...p}>
      <rect x="5" y="11" width="14" height="9" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Stroked>
  );
}
/** 未锁定 */
export function IconUnlock(p: IconProps) {
  return (
    <Stroked {...p}>
      <rect x="5" y="11" width="14" height="9" />
      <path d="M8 11V7a4 4 0 0 1 7.5-2" />
    </Stroked>
  );
}
/** 可见 */
export function IconEye(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </Stroked>
  );
}
/** 隐藏 */
export function IconEyeOff(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
      <path d="M4 4l16 16" />
    </Stroked>
  );
}
/** 拖动把手(三横) */
export function IconDrag(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Stroked>
  );
}
/** 加号 */
export function IconPlus(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M12 5v14M5 12h14" />
    </Stroked>
  );
}
/** 曲别针(添加附件):一根绕了两圈的回形针,整体斜 45° 放 */
export function IconPaperclip(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M16.5 6.5v9.5a4.5 4.5 0 0 1-9 0V5a3 3 0 0 1 6 0v10a1.5 1.5 0 0 1-3 0V7" transform="rotate(45 12 12)" />
    </Stroked>
  );
}
/**
 * 新开 Agent 分页(rail 上的「+」):对话气泡轮廓(左下角带小尾巴)里面一个 +。
 * 放在 rail 上,所以不走本文件的 1.5 描边方头规格,而是和 rail 图标(left/railIcons.tsx)同一套:
 * 24 网格、1.6 描边、圆头圆角、currentColor;显示尺寸由 .pc-rail-item svg 定(22px)。
 */
export function IconBubblePlus({ size = 22, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d="M6 4.5h12A2.5 2.5 0 0 1 20.5 7v8a2.5 2.5 0 0 1-2.5 2.5h-6.2L7.5 20.5v-3H6A2.5 2.5 0 0 1 3.5 15V7A2.5 2.5 0 0 1 6 4.5z" />
      <path d="M12 8.2v5.6M9.2 11h5.6" />
    </svg>
  );
}
/** 搜索 */
export function IconSearch(p: IconProps) {
  return (
    <Stroked {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="M16 16l4 4" />
    </Stroked>
  );
}
/** 下拉箭头 */
export function IconChevronDown(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M6 9l6 6 6-6" />
    </Stroked>
  );
}
/** 历史 / 刷新 */
export function IconHistory(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 8v4l3 2" />
    </Stroked>
  );
}
/** 向上发送 */
export function IconSend(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M12 20V5" />
      <path d="M6 11l6-6 6 6" />
    </Stroked>
  );
}
/** 搜索图标旁的清空 */
export function IconClose(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Stroked>
  );
}

/** 皮肤/配色(调色盘) */
export function IconPalette(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 0-4H13a1.5 1.5 0 0 1 0-3h2.5A4.5 4.5 0 0 0 20 9.5C20 5.9 16.4 3 12 3z" />
      <circle cx="7.5" cy="11.5" r="1" fill="currentColor" />
      <circle cx="11" cy="7.5" r="1" fill="currentColor" />
      <circle cx="15.5" cy="9" r="1" fill="currentColor" />
    </Stroked>
  );
}
