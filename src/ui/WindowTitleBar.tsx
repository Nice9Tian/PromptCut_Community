import { useEffect, useRef, useState } from "react";
import type { JSX, MouseEvent as ReactMouseEvent } from "react";
import { onlineUnsupported } from "../online/onlineUnsupported";
import "./WindowTitleBar.css";
import { tr } from "../i18n/index.ts";

/**
 * A compile-time constant of the online build (for the technique and purpose see "Online build pruning" in
 * `src/online/pageFlag.ts`), with the same value as `ONLINE` in `mode.ts`.
 * In the online build the whole title bar is not drawn (see `WindowTitleBar` below), so the menu's "items
 * that exist only on desktop are grayed out" (C10 contract section 10 [ruling], 2026-09-28) is visible
 * nowhere on the online page; the `ONLINE_BUILD &&` branches below are just old code that was not cleaned
 * up, and in the online output they are cut away together with the whole menu.
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

type ResizeDirection = "North" | "NorthEast" | "NorthWest";

type WindowApi = {
  minimize?: () => Promise<unknown>;
  toggleMaximize?: () => Promise<unknown>;
  close?: () => Promise<unknown>;
  startResizeDragging?: (direction: ResizeDirection) => Promise<unknown>;
  isMaximized?: () => Promise<boolean>;
  onResized?: (handler: () => void) => Promise<() => void>;
};

type TauriGlobal = {
  window?: { getCurrentWindow?: () => WindowApi };
  core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
};

type MenuId = "file" | "edit" | "view" | "help";

/**
 * `desktopOnly`: items that cannot be done on the online page; the value is the entry name in the hover
 * explanation (`onlineUnsupported(entry name)`).
 * Basis: `product/platforms.md` "Online browser mode" can only join, never creates, and never stores drafts
 * (create, open, save); the gray-out list in C10 contract section 10 (voiceover, speech-to-text); the rest
 * are commands of the desktop shell (open a local directory, view the run log, quit), and the online page
 * has no desktop shell.
 */
const menus: Array<{ id: MenuId; label: string; items: Array<{ label: string; command?: string; shortcut?: string; separator?: boolean; desktopOnly?: string }> }> = [
  {
    id: "file",
    label: tr("File"),
    items: [
      { label: tr("New project"), command: "new-project", shortcut: "Ctrl N", desktopOnly: tr("New project") },
      { label: tr("Open project…"), command: "open-project", shortcut: "Ctrl O", desktopOnly: tr("Open project") },
      { label: tr("Save project"), command: "save-project", shortcut: "Ctrl S", desktopOnly: tr("Save project") },
      { label: tr("Export video"), command: "export-video", shortcut: "Ctrl E" },
      { label: tr("Open export folder"), command: "open-export", separator: true, desktopOnly: tr("Open export folder") },
      { label: tr("Open data folder"), command: "open-data", desktopOnly: tr("Open data folder") },
      { label: tr("Storage…"), command: "open-storage", desktopOnly: tr("Storage") },
      { label: tr("Back to home"), command: "go-home", separator: true },
      { label: tr("Exit"), command: "quit", desktopOnly: tr("Exit") },
    ],
  },
  {
    id: "edit",
    label: tr("Edit"),
    items: [
      { label: tr("Undo"), command: "undo", shortcut: "Ctrl Z" },
      { label: tr("Redo"), command: "redo", shortcut: "Ctrl ⇧ Z" },
    ],
  },
  {
    id: "view",
    label: tr("View"),
    items: [
      { label: tr("Skin…"), command: "open-skin" },
      { label: tr("Voiceover settings…"), command: "open-voice", desktopOnly: tr("Voiceover") },
      { label: tr("Speech recognition engine (library folder)"), command: "open-pylibs", separator: true, desktopOnly: tr("Speech recognition") },
      { label: tr("Speech model folder"), command: "open-models", desktopOnly: tr("Speech recognition") },
      { label: tr("Reset Python libraries"), command: "reset-pylibs", desktopOnly: tr("Speech recognition") },
    ],
  },
  {
    id: "help",
    label: tr("Help"),
    items: [
      { label: tr("Keyboard shortcuts"), command: "shortcuts" },
      { label: tr("View run logs"), command: "open-logs", desktopOnly: tr("View run logs") },
      { label: tr("About PromptCut"), command: "about", separator: true },
    ],
  },
];

function tauriWindow(): WindowApi | null {
  const t = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return t?.window?.getCurrentWindow?.() ?? null;
}

/**
 * "Storage…" (`workflow/project.md` "Start"): return to the start page and scroll to the "Storage" section.
 *
 * Follow the "Back to home" path: when in the editor, hand `go-home` to the top bar (`TopBar.tsx`), which prompts if there are unsaved changes;
 * once confirmed, it emits `pc-go-home`, and `Shell` switches to the start page. Here, only leave a todo when it **actually returns**, which is consumed and scrolled to when the start page mounts;
 * if the user clicks cancel in the confirmation dialog, leave nothing, avoiding mysteriously scrolling to the bottom next time returning home. When already on the start page, there is no top bar to receive `go-home`,
 * the start page listens to `STORAGE_EVENT` itself and scrolls there.
 */
export const STORAGE_EVENT = "pc-open-storage";
const STORAGE_PENDING_KEY = "__pcOpenStoragePending";

export function takeStorageRequest(): boolean {
  const g = globalThis as Record<string, unknown>;
  const pending = g[STORAGE_PENDING_KEY] === true;
  g[STORAGE_PENDING_KEY] = false;
  return pending;
}

function openStorage() {
  let wentHome = false;
  const mark = () => { wentHome = true; };
  window.addEventListener("pc-go-home", mark);
  try {
    window.dispatchEvent(new CustomEvent("pc-titlebar-command", { detail: "go-home" }));
  } finally {
    window.removeEventListener("pc-go-home", mark);
  }
  if (wentHome) (globalThis as Record<string, unknown>)[STORAGE_PENDING_KEY] = true;
  else window.dispatchEvent(new Event(STORAGE_EVENT));
}

function sendCommand(command: string) {
  if (!ONLINE_BUILD && command === "open-storage") return openStorage();
  const t = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!ONLINE_BUILD && ["open-export", "open-data", "open-pylibs", "open-models", "open-logs", "reset-pylibs", "about", "quit"].includes(command)) {
    const invoke = t?.core?.invoke;
    if (invoke) {
      void invoke("desktop_titlebar_command", { command }).catch(() => {});
      return;
    }
  }
  window.dispatchEvent(new CustomEvent("pc-titlebar-command", { detail: command }));
}

/**
 * Title bar for frameless desktop windows. Menus and window buttons are both rendered in WebView, and colors directly read the skin's
 * --ui-* variables, so switching skins keeps the title bar synchronized with the editor.
 *
 * Not rendered at all in online builds (browser) ((user decision, 2026-10-22): the browser edition does not need the menu row and the three buttons − □ ×, the latter having no effect when clicked in a browser).
 * Distinguished via the compile-time constant `ONLINE_BUILD`, stripping the implementation below entirely in online artifacts; runtime window API availability is not checked,
 * to avoid losing menus as well if the desktop app fails to obtain window APIs. The seven menu items still usable on online pages each have other entry points; see `docs/reports/AGENT-claude-browser-titlebar.md`;
 * among them, "Shortcuts" and "About PromptCut" have been moved into the "⋯" menu in the editor top bar (`TopBar.tsx`).
 */
export function WindowTitleBar(): JSX.Element | null {
  return ONLINE_BUILD ? null : <DesktopTitleBar />;
}

/**
 * When this project only has read-only permissions (guest), menu commands that modify the project are grayed out. The editor top bar (ReadOnlyMarker in `src/editor/ReadOnlyFence.tsx`)
 * sets `data-pc-readonly="member"` on `<html>` and puts the grayed-out explanation (the sentence from `viewOnlyText()`) in `data-pc-readonly-why`;
 * here we only recognize these two markers without importing the editor (the title bar is in `src/ui`, beneath the editor), and the explanation is not recomposed here.
 * Rendered only when the menu is opened; reading the markers is sufficient without needing a subscription.
 */
const READONLY_COMMANDS = new Set(["undo", "redo", "save-project"]);
const readOnlyNow = (): boolean => typeof document !== "undefined" && document.documentElement.dataset.pcReadonly === "member";
const readOnlyWhy = (): string => (typeof document !== "undefined" && document.documentElement.dataset.pcReadonlyWhy) || "";

function DesktopTitleBar(): JSX.Element {
  const [open, setOpen] = useState<MenuId | null>(null);
  const [maximized, setMaximized] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const canUseWindowApi = Boolean((window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__?.window?.getCurrentWindow);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // When maximized, the top edge cannot be resized; remove the resize strip so the topmost few pixels of the screen remain the title bar
  useEffect(() => {
    const win = canUseWindowApi ? tauriWindow() : null;
    if (!win) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = () => {
      void win.isMaximized?.()?.then((value) => {
        if (!disposed) setMaximized(value);
      }).catch(() => {});
    };
    sync();
    void win.onResized?.(sync)?.then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [canUseWindowApi]);

  const choose = (command?: string) => {
    setOpen(null);
    if (command) sendCommand(command);
  };

  const startResize = (direction: ResizeDirection) => (event: ReactMouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void tauriWindow()?.startResizeDragging?.(direction)?.catch(() => {});
  };

  return (
    <header ref={rootRef} className={`pc-titlebar${canUseWindowApi ? " is-desktop" : ""}`} data-tauri-drag-region={canUseWindowApi ? "deep" : undefined}>
      {canUseWindowApi && !maximized && (
        // Top edge resize strip: the system leaves only ~4px for the top edge of a frameless window, immediately followed by the drag region below, making it hard to hit accurately; here it is padded to 8px with both ends acting as chamfers.
        // data-tauri-drag-region="false" blocks the outer deep drag region, otherwise pressing down first triggers window dragging
        <div className="pc-titlebar-resize" data-tauri-drag-region="false" aria-hidden="true">
          <span className="pc-titlebar-resize-nw" onMouseDown={startResize("NorthWest")} />
          <span className="pc-titlebar-resize-n" onMouseDown={startResize("North")} />
          <span className="pc-titlebar-resize-ne" onMouseDown={startResize("NorthEast")} />
        </div>
      )}
      <nav className="pc-titlebar-menus" aria-label={tr("App menu")}>
        {menus.map((menu) => (
          <div className="pc-titlebar-menu-wrap" key={menu.id}>
            <button
              type="button"
              className={`pc-titlebar-menu-button${open === menu.id ? " is-open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={open === menu.id}
              onClick={() => setOpen((current) => current === menu.id ? null : menu.id)}
              onMouseEnter={() => open && setOpen(menu.id)}
            >
              {menu.label}
            </button>
            {open === menu.id && (
              <div className="pc-titlebar-menu" role="menu">
                {menu.items.map((item) => (
                  <div key={item.label}>
                    {item.separator && <div className="pc-titlebar-menu-separator" role="separator" />}
                    <button
                      type="button"
                      role="menuitem"
                      className="pc-titlebar-menu-item"
                      data-pc={item.command ? `titlebar-${item.command}` : undefined}
                      disabled={ONLINE_BUILD && !!item.desktopOnly}
                      aria-disabled={item.command && READONLY_COMMANDS.has(item.command) && readOnlyNow() ? true : undefined}
                      title={ONLINE_BUILD && item.desktopOnly ? onlineUnsupported(item.desktopOnly) : item.command && READONLY_COMMANDS.has(item.command) && readOnlyNow() ? readOnlyWhy() : undefined}
                      onClick={() => { if (!(ONLINE_BUILD && item.desktopOnly) && !(item.command && READONLY_COMMANDS.has(item.command) && readOnlyNow())) choose(item.command); }}
                    >
                      <span>{item.label}</span>
                      {item.shortcut && <kbd>{item.shortcut}</kbd>}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="pc-titlebar-spacer" data-tauri-drag-region />
      <div className="pc-titlebar-window-controls" aria-label={tr("Window controls")}>
        <button type="button" className="pc-window-control" aria-label={tr("Minimize")} onClick={() => void tauriWindow()?.minimize?.()}>−</button>
        <button type="button" className="pc-window-control" aria-label={tr("Maximize")} onClick={() => void tauriWindow()?.toggleMaximize?.()}>□</button>
        <button type="button" className="pc-window-control pc-window-control--close" aria-label={tr("Close")} onClick={() => void tauriWindow()?.close?.()}>×</button>
      </div>
    </header>
  );
}
