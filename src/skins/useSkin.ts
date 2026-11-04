import { useSyncExternalStore } from "react";
import { DEFAULT_SKIN, getSkin, skins } from "./skins";
import { expandOverrides, subscribeOverrides } from "./overrides";

/**
 * Skin state: selected id is stored in localStorage(pc.skin); on apply, writes the skin's --ui-*
 * variables one by one to <html>, and attaches data-skin (skin id) and data-skin-mode (dark/light).
 * skins.css works solely from these two attributes and variables, so adding a skin only requires
 * adding data, with no CSS changes.
 */
let currentSkin = DEFAULT_SKIN;
try {
  let saved = localStorage.getItem("pc.skin");
  // Migrating old default indigo-dark to studio-dark is only done once on first startup; the flag
  // is written whether migrated or not, so users manually choosing indigo-dark later won't be overridden
  if (!localStorage.getItem("pc.skin.studioMigrated")) {
    if (saved === "indigo-dark") {
      saved = "studio-dark";
      localStorage.setItem("pc.skin", saved);
    }
    localStorage.setItem("pc.skin.studioMigrated", "1");
  }
  if (saved && skins.some((s) => s.id === saved)) currentSkin = saved;
} catch {
  // ignore
}

const listeners = new Set<() => void>();
let appliedVars: string[] = [];

function applySkin(id: string) {
  if (typeof document === "undefined") return;
  const skin = getSkin(id);
  const root = document.documentElement;
  for (const k of appliedVars) root.style.removeProperty(`--${k}`);
  // Presets are applied first, then user customizations overlay on top; keys from both layers are
  // recorded in appliedVars, making it easy to revert cleanly when switching skins next time
  const custom = expandOverrides(skin.mode);
  const merged = { ...skin.vars, ...custom };
  appliedVars = Object.keys(merged);
  for (const [k, v] of Object.entries(merged)) root.style.setProperty(`--${k}`, v);
  root.dataset.skin = skin.id;
  root.dataset.skinMode = skin.mode;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentSkin;
}

export function setSkin(id: string) {
  if (id === currentSkin || !skins.some((s) => s.id === id)) return;
  currentSkin = id;
  try {
    localStorage.setItem("pc.skin", id);
  } catch {
    // ignore
  }
  const root = document.documentElement;
  // Only enable the 200ms color transition at the moment of switching; disabled normally to avoid
  // transitioning on every frame while scrubbing the timeline
  root.classList.add("skin-swapping");
  applySkin(id);
  setTimeout(() => root.classList.remove("skin-swapping"), 200);
  listeners.forEach((l) => l());
}

applySkin(currentSkin);

// Refresh in place when the user changes custom colors, without waiting to switch skins
subscribeOverrides(() => {
  applySkin(currentSkin);
  listeners.forEach((l) => l());
});

export function useSkin() {
  const skinId = useSyncExternalStore(subscribe, getSnapshot);
  return { skinId, setSkin };
}

export { skins };
