import { useEffect } from "react";
import type { JSX } from "react";

/**
 * The transition strip at the top of the web page: it fades from the color of the window's native menu
 * bar to the base color of the navigation bar.
 *
 * The desktop shell's menu bar (File / Tools / Appearance / Help) is drawn by Windows, and its color
 * follows the system theme; the navigation bar on the web side is our own dark color. Placed together,
 * the two have a hard boundary between them, and a 10px strip is added here to smooth it out. The menu
 * bar's color is not guessed: the shell's `menu_bar_color` command samples the pixels of that row on the
 * screen directly (desktop/src-tauri/src/chrome_color.rs), and whatever it reads is what gets used.
 *
 * When running in a browser (no shell) there is no menu bar, and this strip has height 0 and shows
 * nothing.
 * The menu bar changes color when the system theme switches: sample again every time the window regains
 * focus and every time the page becomes visible again.
 */

interface TauriGlobal {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

function invoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const t = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return t?.core?.invoke ?? null;
}

let lastApplied = "";

/** Sample once and write it into a CSS variable. With no shell / nothing sampled, remove the variable and the transition strip collapses to 0 height automatically */
export async function refreshMenuBarColor(): Promise<void> {
  const call = invoke();
  const root = document.documentElement;
  if (!call || document.visibilityState !== "visible") return;
  try {
    const c = (await call("menu_bar_color")) as { r: number; g: number; b: number } | null;
    if (!c) {
      root.style.removeProperty("--pc-menubar");
      root.classList.remove("pc-has-menubar");
      lastApplied = "";
      return;
    }
    const css = `rgb(${c.r} ${c.g} ${c.b})`;
    if (css !== lastApplied) {
      lastApplied = css;
      root.style.setProperty("--pc-menubar", css);
      root.classList.add("pc-has-menubar");
    }
  } catch {
    /* Old versions of the shell do not have this command: treat it as having no menu bar */
  }
}

export function MenuBarFade(): JSX.Element {
  useEffect(() => {
    if (!invoke()) return;
    // Right after loading the window may still be moving (restoring its size, centering), so wait a little
    // before sampling, so that the pixels sampled are those at the final position
    const first = window.setTimeout(() => void refreshMenuBarColor(), 400);
    const onFocus = () => void refreshMenuBarColor();
    const onVisible = () => { if (document.visibilityState === "visible") void refreshMenuBarColor(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(first);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return <div className="pc-bar-fade" aria-hidden="true" />;
}
