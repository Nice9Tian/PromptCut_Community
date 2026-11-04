import type { SkinMode } from "./skins";
import { agentColorFor } from "./agentColor";
import { tr } from "../i18n/index.ts";

/**
 * Custom color scheme: an override layer on top of preset skins.
 *
 * Presets provide a coordinated set of --ui-*, while this only records the few items manually
 * modified by the user. It is split into two layers instead of having the user clone an entire
 * set so that this layer stays when switching presets: the accent color modified by the user is
 * not lost just because the base color changed; clicking "Reset to defaults" clears it when no
 * longer wanted.
 */

const STORAGE_KEY = "pc.skin.vars";

/**
 * Slots that can be adjusted individually in UI. Those not listed (derived colors, track ink,
 * etc.) are filled in by linkages below
 */
export interface SkinSlot {
  /** Name in --ui-* with -- stripped */
  key: string;
  label: string;
  group: string;
  hint?: string;
}

export const SKIN_SLOTS: SkinSlot[] = [
  { key: "ui-accent", label: tr("Accent color"), group: tr("Primary color"), hint: tr("Buttons, selected state, playhead; hover/pressed/faint background are derived from it") },
  { key: "ui-bg", label: tr("Canvas background"), group: tr("Surfaces") },
  { key: "ui-panel", label: tr("Panel background"), group: tr("Surfaces") },
  { key: "ui-panel-2", label: tr("Secondary panel"), group: tr("Surfaces") },
  { key: "ui-float", label: tr("Floating layer background"), group: tr("Surfaces"), hint: tr("Menus, dialogs") },
  { key: "ui-fg", label: tr("Primary text"), group: tr("Text and strokes") },
  { key: "ui-fg-muted", label: tr("Secondary text"), group: tr("Text and strokes") },
  { key: "ui-border", label: tr("Outline"), group: tr("Text and strokes") },
  { key: "ui-border-strong", label: tr("Strong stroke"), group: tr("Text and strokes") },
  { key: "ui-danger", label: tr("Danger"), group: tr("Semantic colors") },
  { key: "ui-warn", label: tr("Warning"), group: tr("Semantic colors") },
  { key: "ui-success", label: tr("Success"), group: tr("Semantic colors") },
  { key: "ui-track-video", label: tr("Video track"), group: tr("Track") },
  { key: "ui-track-audio", label: tr("Audio track"), group: tr("Track") },
  { key: "ui-track-text", label: tr("Text track"), group: tr("Track") },
  { key: "ui-track-image", label: tr("Image track"), group: tr("Track") },
  { key: "ui-track-fx", label: tr("Effects track"), group: tr("Track") },
];

export type SkinOverrides = Record<string, string>;

function read(): SkinOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Accept only recognized slots; prevent tampered localStorage from writing arbitrary attributes
    // to <html>
    const known = new Set(SKIN_SLOTS.map((s) => s.key));
    return Object.fromEntries(
      Object.entries(parsed).filter(([k, v]) => known.has(k) && typeof v === "string"),
    ) as SkinOverrides;
  } catch {
    return {};
  }
}

function write(next: SkinOverrides): void {
  try {
    if (Object.keys(next).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* If incognito mode cannot remember it, so be it; it still takes effect within this session */
  }
}

let overrides: SkinOverrides = read();
const listeners = new Set<() => void>();

export function getOverrides(): SkinOverrides {
  return overrides;
}

export function subscribeOverrides(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * When the accent color changes, its derived variants must follow along, otherwise hover and pressed
 * states retain old colors, looking broken.
 * Ratios directly copy the algorithm of sideToVars in skins.ts, only replacing the base color with
 * the one chosen by the user.
 */
function derive(key: string, value: string, mode: SkinMode): SkinOverrides {
  if (key !== "ui-accent") return {};
  const dark = mode === "dark";
  const mix = (b: string, pa: number) => `color-mix(in oklab, ${value} ${pa}%, ${b})`;
  return {
    "ui-accent-hover": mix("#ffffff", dark ? 82 : 78),
    "ui-accent-press": mix("#000000", dark ? 78 : 74),
    "ui-accent-soft": mix(dark ? "#000000" : "#ffffff", dark ? 24 : 14),
    "ui-info": value,
    "ui-glow": `0 0 10px ${mix("transparent", 45)}`,
    // Agent avatar color recalculates with the new accent color (yellow with same lightness and chroma;
    // switches to purple if accent color itself is yellow-orange); color picker always gives #rrggbb
    "ui-agent": agentColorFor(value),
  };
}

/** Derived keys: cleared together when a slot is reset */
export function derivedKeys(key: string): string[] {
  return Object.keys(derive(key, "#000000", "dark"));
}

/** Computes a slot along with its derived entries, passing them to useSkin to write */
export function expandOverrides(mode: SkinMode): SkinOverrides {
  const out: SkinOverrides = {};
  for (const [k, v] of Object.entries(overrides)) {
    out[k] = v;
    Object.assign(out, derive(k, v, mode));
  }
  return out;
}

export function setOverride(key: string, value: string | null): void {
  const next = { ...overrides };
  if (value === null) delete next[key];
  else next[key] = value;
  overrides = next;
  write(next);
  listeners.forEach((l) => l());
}

export function clearOverrides(): void {
  overrides = {};
  write(overrides);
  listeners.forEach((l) => l());
}
