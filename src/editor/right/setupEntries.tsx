import type { JSX } from "react";
import type { AiProvider } from "../../ai/types";
import { tr } from "../../i18n/index.ts";

/**
 * The five entries at the first level of the settings dialog.
 *
 * The first three each correspond to a CLI; the last two both land on the same `api` driver, and
 * differ only in **how the configuration comes in**: Router pastes a distribution string that is
 * decoded automatically, custom API has you fill in the fields one by one.
 * So `provider` has duplicates, and which "face" was chosen is recorded separately in localStorage
 * (a pure UI preference).
 */
export type SetupEntryId = "codex" | "claude" | "agy" | "router" | "custom";

export interface SetupEntry {
  id: SetupEntryId;
  /** Which backend driver it lands on */
  provider: AiProvider;
  name: string;
  /** One-line description on the card */
  tagline: string;
  icon: JSX.Element;
}

const ICON_PROPS = {
  width: 26,
  height: 26,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** Terminal prompt: a base shared by the three CLIs, each overlaid with its own mark */
const IconCodex = (
  <svg {...ICON_PROPS}>
    <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
    <path d="M7 10l2.5 2L7 14" />
    <path d="M12.5 15h4.5" />
  </svg>
);

/** Claude: a radial starburst */
const IconClaude = (
  <svg {...ICON_PROPS}>
    <path d="M12 3v18M3 12h18" />
    <path d="M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

/** Antigravity: an arrow breaking away upward */
const IconAntigravity = (
  <svg {...ICON_PROPS}>
    <path d="M12 20V5" />
    <path d="M7.5 9.5L12 4.5l4.5 5" />
    <path d="M5 20h14" />
    <circle cx="12" cy="13.5" r="1" />
  </svg>
);

/** Router: a central node distributing to three places */
const IconRouter = (
  <svg {...ICON_PROPS}>
    <circle cx="12" cy="12" r="3" />
    <circle cx="4.5" cy="5" r="1.8" />
    <circle cx="19.5" cy="5" r="1.8" />
    <circle cx="12" cy="20.5" r="1.8" />
    <path d="M9.7 10.1L6 6.5M14.3 10.1L18 6.5M12 15v3.7" />
  </svg>
);

/** Custom API: a key */
const IconCustom = (
  <svg {...ICON_PROPS}>
    <circle cx="8" cy="8" r="4" />
    <path d="M11 11l8 8" />
    <path d="M16.5 16.5l2-2" />
    <path d="M19 19l1.8-1.8" />
  </svg>
);

/** The order is the order in the UI */
export const SETUP_ENTRIES: SetupEntry[] = [
  { id: "codex", provider: "codex", name: "Codex CLI", tagline: tr("OpenAI's official CLI"), icon: IconCodex },
  { id: "claude", provider: "claude", name: "Claude Code CLI", tagline: tr("Anthropic's official CLI"), icon: IconClaude },
  { id: "agy", provider: "agy", name: "Antigravity CLI", tagline: tr("Google's agentic CLI"), icon: IconAntigravity },
  { id: "router", provider: "api", name: "PromptCut Router", tagline: tr("Paste a distribution string to configure automatically"), icon: IconRouter },
  { id: "custom", provider: "api", name: tr("Custom API"), tagline: tr("Enter your own URL, model and key"), icon: IconCustom },
];

export const CLI_ENTRY_IDS: SetupEntryId[] = ["codex", "claude", "agy"];

export function isCliEntry(id: SetupEntryId): boolean {
  return CLI_ENTRY_IDS.includes(id);
}

const FACE_KEY = "aiSetupFace";

/** Remember whether Router or custom API was chosen last time: both use the same driver on the backend, so they cannot be told apart */
export function readFace(): SetupEntryId | null {
  try {
    const saved = localStorage.getItem(FACE_KEY);
    return SETUP_ENTRIES.some((e) => e.id === saved) ? (saved as SetupEntryId) : null;
  } catch {
    return null;
  }
}

export function writeFace(id: SetupEntryId): void {
  try {
    localStorage.setItem(FACE_KEY, id);
  } catch {
    /* Incognito mode and the like: if it cannot be remembered, so be it, no functional impact */
  }
}
