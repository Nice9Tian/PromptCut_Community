import { useEffect, useRef, useState } from "react";
import type { JSX, MouseEvent as ReactMouseEvent } from "react";
import { onlineUnsupported } from "../online/pageFlag";
import "./WindowTitleBar.css";

/**
 * 在线构建的编译期常量(写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」),值同 `mode.ts` 的 `ONLINE`。
 * 在线构建里标题栏整条不画(见下面 `WindowTitleBar`),所以菜单里「桌面才有的项置灰」(C10 契约第 10 节〔裁〕,2026-09-28)
 * 在线页面上已无处可见;下面各处 `ONLINE_BUILD &&` 的分支只是没有清掉的旧写法,在线产物里随整个菜单一起被剪掉。
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
 * `desktopOnly`:在线页面做不成的项,值是悬停说明里的入口名(`onlineUnsupported(入口名)`)。
 * 依据:`product/platforms.md`「在线浏览器模式」只加入、不新建、不存草稿(新建、打开、保存);C10 契约第 10 节置灰清单
 * (配音、语音识别);其余是桌面壳的命令(打开本机目录、看运行日志、退出),在线页面没有桌面壳。
 */
const menus: Array<{ id: MenuId; label: string; items: Array<{ label: string; command?: string; shortcut?: string; separator?: boolean; desktopOnly?: string }> }> = [
  {
    id: "file",
    label: "文件",
    items: [
      { label: "新建项目", command: "new-project", shortcut: "Ctrl N", desktopOnly: "新建项目" },
      { label: "打开项目…", command: "open-project", shortcut: "Ctrl O", desktopOnly: "打开项目" },
      { label: "保存项目", command: "save-project", shortcut: "Ctrl S", desktopOnly: "保存项目" },
      { label: "导出视频", command: "export-video", shortcut: "Ctrl E" },
      { label: "打开导出文件夹", command: "open-export", separator: true, desktopOnly: "打开导出文件夹" },
      { label: "打开数据目录", command: "open-data", desktopOnly: "打开数据目录" },
      { label: "存储…", command: "open-storage", desktopOnly: "存储" },
      { label: "返回首页", command: "go-home", separator: true },
      { label: "退出", command: "quit", desktopOnly: "退出" },
    ],
  },
  {
    id: "edit",
    label: "编辑",
    items: [
      { label: "撤销", command: "undo", shortcut: "Ctrl Z" },
      { label: "重做", command: "redo", shortcut: "Ctrl ⇧ Z" },
    ],
  },
  {
    id: "view",
    label: "视图",
    items: [
      { label: "皮肤…", command: "open-skin" },
      { label: "配音设置…", command: "open-voice", desktopOnly: "配音" },
      { label: "语音识别引擎（库目录）", command: "open-pylibs", separator: true, desktopOnly: "语音识别" },
      { label: "语音模型目录", command: "open-models", desktopOnly: "语音识别" },
      { label: "重置 Python 库", command: "reset-pylibs", desktopOnly: "语音识别" },
    ],
  },
  {
    id: "help",
    label: "帮助",
    items: [
      { label: "快捷键", command: "shortcuts" },
      { label: "查看运行日志", command: "open-logs", desktopOnly: "查看运行日志" },
      { label: "关于 PromptCut", command: "about", separator: true },
    ],
  },
];

function tauriWindow(): WindowApi | null {
  const t = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return t?.window?.getCurrentWindow?.() ?? null;
}

/**
 * 「存储…」(`workflow/project.md`「开始」):回到开始页并滚到「存储」一块。
 *
 * 照「返回首页」的路走:在编辑器里时把 `go-home` 交给顶栏(`TopBar.tsx`),有没保存的改动由它问一句,
 * 确认了它发 `pc-go-home`、`Shell` 换到开始页。这里只在它**真的回去了**时留一个待办,开始页挂上时取走、滚过去;
 * 用户在确认框里点了取消就不留,免得下次回首页莫名其妙滚到底。已经在开始页时没有顶栏接 `go-home`,
 * 开始页自己听 `STORAGE_EVENT` 滚过去。
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
 * 无边框桌面窗口的标题栏。菜单和窗口按钮都在 WebView 里绘制，颜色直接读取皮肤
 * 的 --ui-* 变量，因此切换皮肤时标题栏会和编辑器同步变化。
 *
 * 在线构建(浏览器)里整条不画(2026-10-22 用户定:浏览器版不需要菜单行和 − □ × 三个按钮,后者在浏览器里按了没反应)。
 * 判别用编译期常量 `ONLINE_BUILD`,在线产物里下面那份实现整个剪掉;不用运行时有没有窗口 API 来判,
 * 免得桌面版万一拿不到窗口 API 时连菜单一起没了。菜单里在线页面还能用的七项各有别的入口,见 `docs/reports/AGENT-claude-browser-titlebar.md`;
 * 其中「快捷键」「关于 PromptCut」挪进了编辑器顶栏的「⋯」菜单(`TopBar.tsx`)。
 */
export function WindowTitleBar(): JSX.Element | null {
  return ONLINE_BUILD ? null : <DesktopTitleBar />;
}

/**
 * 这个项目只给了只读权限(游客)时,菜单里会改项目的命令置灰。编辑器顶栏(`src/editor/ReadOnlyFence.tsx` 的 ReadOnlyMarker)
 * 给 `<html>` 打 `data-pc-readonly="member"`、并把置灰说明(`viewOnlyText()` 那一句)放在 `data-pc-readonly-why`,
 * 这里只认这两个标记,不去引用编辑器(标题栏在 `src/ui`,在编辑器之下),说明也不在这里另编一句。
 * 菜单展开时才渲染,读一下标记就够,不用订阅。
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

  // 最大化时顶边不能拉伸,拉伸带要撤掉,让屏幕最顶上那几像素还是标题栏
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
        // 顶边拉伸带:系统给无边框窗口的顶边只留 ~4px,紧下面就是拖动区,很难按准,这里补到 8px、两头当斜角。
        // data-tauri-drag-region="false" 挡住外层的 deep 拖动区,不然按下去先变成拖窗口
        <div className="pc-titlebar-resize" data-tauri-drag-region="false" aria-hidden="true">
          <span className="pc-titlebar-resize-nw" onMouseDown={startResize("NorthWest")} />
          <span className="pc-titlebar-resize-n" onMouseDown={startResize("North")} />
          <span className="pc-titlebar-resize-ne" onMouseDown={startResize("NorthEast")} />
        </div>
      )}
      <nav className="pc-titlebar-menus" aria-label="应用菜单">
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
      <div className="pc-titlebar-window-controls" aria-label="窗口控制">
        <button type="button" className="pc-window-control" aria-label="最小化" onClick={() => void tauriWindow()?.minimize?.()}>−</button>
        <button type="button" className="pc-window-control" aria-label="最大化" onClick={() => void tauriWindow()?.toggleMaximize?.()}>□</button>
        <button type="button" className="pc-window-control pc-window-control--close" aria-label="关闭" onClick={() => void tauriWindow()?.close?.()}>×</button>
      </div>
    </header>
  );
}
