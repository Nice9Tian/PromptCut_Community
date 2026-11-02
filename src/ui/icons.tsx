import type { SVGProps } from "react";

/**
 * Button icons (design mockup, "Toolbar component table", section 04).
 * Uniform spec: 24 artboard, displayed at 18px, 1.5 stroke, square caps, fill set to none; the color is
 * always currentColor, determined by the button's text color (secondary text normally, primary text on
 * hover, and for the primary button it follows the button foreground).
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

/** Play: the only solid icon */
export function IconPlay({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
      <path d="M7 4l13 8-13 8z" />
    </svg>
  );
}

/** Pause: the design mockup did not provide one, so one was added following the solid spec of play (play/pause are two states of the same button) */
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

/** More actions (three dots) */
export function IconMore(p: IconProps) {
  return (
    <Stroked {...p}>
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
      <circle cx="5" cy="12" r="1" fill="currentColor" />
    </Stroked>
  );
}

/** Project settings (gear) */
export function IconSettings(p: IconProps) {
  return (
    <Stroked {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Stroked>
  );
}


/** Back to the start page */
export function IconHome(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M4 11l8-6.5 8 6.5" />
      <path d="M6.5 9.5V19h11V9.5" />
      <path d="M10 19v-5h4v5" />
    </Stroked>
  );
}

/** Voiceover settings: a little person who is speaking (head, shoulders, two sound waves in front of the mouth). It used to be a row of vertical-bar sound waves, which looked like speech recognition */
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

/** New project */
export function IconNew(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M13 3H6v18h12V8z" />
      <path d="M13 3v5h5" />
      <path d="M12 12v6M9 15h6" />
    </Stroked>
  );
}

/* ── Icons needed by the whole color diagnosis and correction v2 screen that did not exist before ──────
 * Same spec as above: 24 artboard, 1.5 stroke, currentColor. */

/** Previous clip / jump to start */
export function IconSkipBack(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M11 5L5 12l6 7M19 5l-6 7 6 7" />
    </Stroked>
  );
}
/** Next clip / jump to end */
export function IconSkipForward(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M13 5l6 7-6 7M5 5l6 7-6 7" />
    </Stroked>
  );
}
/** Loop playback */
export function IconLoop(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </Stroked>
  );
}
/** Speaker */
export function IconVolume(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M11 5L6 9H3v6h3l5 4z" />
      <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" />
    </Stroked>
  );
}
/** Mute */
export function IconVolumeMute(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M11 5L6 9H3v6h3l5 4z" />
      <path d="M16 9l5 6M21 9l-5 6" />
    </Stroked>
  );
}
/** Locked */
export function IconLock(p: IconProps) {
  return (
    <Stroked {...p}>
      <rect x="5" y="11" width="14" height="9" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Stroked>
  );
}
/** Unlocked */
export function IconUnlock(p: IconProps) {
  return (
    <Stroked {...p}>
      <rect x="5" y="11" width="14" height="9" />
      <path d="M8 11V7a4 4 0 0 1 7.5-2" />
    </Stroked>
  );
}
/** Visible */
export function IconEye(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </Stroked>
  );
}
/** Hidden */
export function IconEyeOff(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
      <path d="M4 4l16 16" />
    </Stroked>
  );
}
/** Drag handle (three horizontal lines) */
export function IconDrag(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Stroked>
  );
}
/** Plus sign */
export function IconPlus(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M12 5v14M5 12h14" />
    </Stroked>
  );
}
/** Paperclip (add attachment): a paper clip wound twice, placed at a 45° tilt overall */
export function IconPaperclip(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M16.5 6.5v9.5a4.5 4.5 0 0 1-9 0V5a3 3 0 0 1 6 0v10a1.5 1.5 0 0 1-3 0V7" transform="rotate(45 12 12)" />
    </Stroked>
  );
}
/**
 * Open a new Agent tab ("+" on the rail): a chat bubble outline (with a small tail at the lower left)
 * with a + inside.
 * It sits on the rail, so it does not follow this file's 1.5 stroke square-cap spec, but the same set as
 * the rail icons (left/railIcons.tsx): 24 grid, 1.6 stroke, round caps and joins, currentColor; the
 * display size is set by .pc-rail-item svg (22px).
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
/** Search */
export function IconSearch(p: IconProps) {
  return (
    <Stroked {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="M16 16l4 4" />
    </Stroked>
  );
}
/** Dropdown arrow */
export function IconChevronDown(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M6 9l6 6 6-6" />
    </Stroked>
  );
}
/** History / refresh */
export function IconHistory(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 8v4l3 2" />
    </Stroked>
  );
}
/** Send upward */
export function IconSend(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M12 20V5" />
      <path d="M6 11l6-6 6 6" />
    </Stroked>
  );
}
/** The clear button next to the search icon */
export function IconClose(p: IconProps) {
  return (
    <Stroked {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Stroked>
  );
}

/** Skin / color scheme (palette) */
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
