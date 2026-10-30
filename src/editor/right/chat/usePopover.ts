import { useEffect, useRef, useState } from "react";

/**
 * 输入区工具条上两个小弹层(「✦」菜单、模型的「⋯」运行选项)共用的开合逻辑。
 *
 * 用法:anchorRef 挂在「按钮 + 弹层」外面那一层;弹层上带 data-pop,开合用行内 display。
 * 弹层不走 portal:它从输入区往上弹,落在消息区上方,仍在右栏卡片里,不会被卡片的
 * overflow:hidden 裁掉;挂在面板里还能跟着分页一起 display:none,切到别的分页时
 * 不会留下一个孤零零的菜单。
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  // 点外面、按 Escape 关闭;窗口尺寸一变也关掉,免得弹层和按钮错位
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      // 焦点还给打开它的那个按钮,键盘用户不至于掉回 body
      anchorRef.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
    };
    const close = () => setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  // 打开后把焦点送进弹层。跳过 disabled 的项(比如没消息时的「诊断报告」),否则焦点会落空
  useEffect(() => {
    if (!open) return;
    anchorRef.current
      ?.querySelector<HTMLElement>("[data-pop] button:not([disabled]), [data-pop] select:not([disabled])")
      ?.focus();
  }, [open]);

  return { open, setOpen, toggle: () => setOpen((v) => !v), anchorRef };
}
