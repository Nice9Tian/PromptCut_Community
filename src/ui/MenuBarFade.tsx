import { useEffect } from "react";
import type { JSX } from "react";

/**
 * 网页顶部那一条过渡带:从窗口原生菜单栏的颜色渐变到导航栏的底色。
 *
 * 桌面壳的菜单栏(文件 / 工具 / 外观 / 帮助)是 Windows 画的,颜色跟系统主题走;
 * 网页这边的导航栏是我们自己的深色。两者贴在一起中间是一道生硬的分界,这里加 10px
 * 把它接顺。菜单栏到底是什么颜色不猜:壳的 `menu_bar_color` 命令直接采样屏幕上那一行
 * 的像素(desktop/src-tauri/src/chrome_color.rs),读到什么就用什么。
 *
 * 浏览器里跑(没有壳)时没有菜单栏,这条高度为 0,什么都不显示。
 * 系统主题切换时菜单栏会变色:窗口每次重新拿到焦点、页面每次重新可见都再采一次。
 */

interface TauriGlobal {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

function invoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const t = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return t?.core?.invoke ?? null;
}

let lastApplied = "";

/** 采一次样并写进 CSS 变量。没有壳 / 采不到就把变量撤掉,过渡带自动收成 0 高 */
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
    /* 老版本的壳没有这个命令:当没有菜单栏处理 */
  }
}

export function MenuBarFade(): JSX.Element {
  useEffect(() => {
    if (!invoke()) return;
    // 刚加载时窗口可能还在动(还原尺寸、居中),延一点再采,采到的才是最终位置上的像素
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
