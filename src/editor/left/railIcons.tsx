import type { SVGProps } from "react";

/**
 * Icons for the five left rail items: 24 grid, 1.6 stroke, following the text color.
 * The display size is set by the shared style .pc-rail-item svg (22px); the width / height here
 * are only a fallback.
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

/** Media library: two stacked frames, the front one with a play triangle */
export function RailIconLibrary() {
  return (
    <svg {...base}>
      <path d="M7 4.5h11.5A2.5 2.5 0 0 1 21 7v8" />
      <rect x="3" y="7.5" width="15" height="12" rx="2.2" />
      <path d="M9.2 11.2v4.6l3.9-2.3z" />
    </svg>
  );
}

/** Animation: a play triangle running right, trailing three motion lines on the left */
export function RailIconAnimations() {
  return (
    <svg {...base}>
      <path d="M10.5 6.5v11l8.5-5.5z" />
      <path d="M3 9h4M4.5 12H7M3 15h4" />
    </svg>
  );
}

/** Effects: two stars, one big and one small */
export function RailIconEffects() {
  return (
    <svg {...base}>
      <path d="M10 4.5l1.6 4.3 4.4 1.7-4.4 1.7L10 16.5l-1.6-4.3L4 10.5l4.4-1.7z" />
      <path d="M17.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </svg>
  );
}

/** Edit: three slider bars */
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

/** Captions: two lines of text under a picture frame */
export function RailIconCaptions() {
  return (
    <svg {...base}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M7 12.5h6M15.5 12.5H17M7 15.8h3M12.5 15.8H17" />
    </svg>
  );
}
