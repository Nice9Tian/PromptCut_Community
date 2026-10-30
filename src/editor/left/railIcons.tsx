import type { SVGProps } from "react";

/**
 * 左 rail 五项的图标:24 网格、1.6 描边、跟着文字色走。
 * 显示尺寸由共享样式 .pc-rail-item svg 定(22px),这里的 width / height 只是兜底。
 */
const base: SVGProps<SVGSVGElement> = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

/** 素材库:叠着的两张画面,前面那张带播放三角 */
export function RailIconLibrary() {
  return (
    <svg {...base}>
      <path d="M7 4.5h11.5A2.5 2.5 0 0 1 21 7v8" />
      <rect x="3" y="7.5" width="15" height="12" rx="2.2" />
      <path d="M9.2 11.2v4.6l3.9-2.3z" />
    </svg>
  );
}

/** 动画:往右跑的播放三角,左边拖着三道动势线 */
export function RailIconAnimations() {
  return (
    <svg {...base}>
      <path d="M10.5 6.5v11l8.5-5.5z" />
      <path d="M3 9h4M4.5 12H7M3 15h4" />
    </svg>
  );
}

/** 特效:一大一小两颗星 */
export function RailIconEffects() {
  return (
    <svg {...base}>
      <path d="M10 4.5l1.6 4.3 4.4 1.7-4.4 1.7L10 16.5l-1.6-4.3L4 10.5l4.4-1.7z" />
      <path d="M17.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </svg>
  );
}

/** 编辑:三根滑杆 */
export function RailIconEdit() {
  return (
    <svg {...base}>
      <path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1" />
      <circle cx="15" cy="6.5" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="17.5" r="2" />
    </svg>
  );
}

/** 字幕:画框底下两行字 */
export function RailIconCaptions() {
  return (
    <svg {...base}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M7 12.5h6M15.5 12.5H17M7 15.8h3M12.5 15.8H17" />
    </svg>
  );
}
