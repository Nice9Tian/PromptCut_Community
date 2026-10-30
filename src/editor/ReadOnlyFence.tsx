import { useEffect, type CSSProperties, type ReactNode } from "react";
import { useMemberReadOnly, useReadOnly } from "./readOnly";
import { viewOnlyText } from "./io/viewOnly";
import "./readOnlyKeys";
import "./readOnly.css";

/**
 * 一整块表单的「只读围栏」：只读项目里，围栏里所有原生控件（按钮、输入框、下拉、滑块、勾选、文本框）一起置灰，
 * 值照常显示、能看能滚能选中文字；悬停在上面看到的是 `viewOnlyText()` 那一句。
 *
 * 用 `<fieldset disabled>`：它让后代的原生控件整体禁用，键盘也聚焦不到，比逐个控件加 `disabled` 不会漏。
 * `display: contents`（readOnly.css）让它不占布局，套上去不改变里面的排版；不只读时它什么都不做。
 * 围栏管不到的：靠指针事件自己实现的「控件」（拖标签改数字之类），那些要在各自的处理函数里看 `useReadOnly()`。
 */
export function ReadOnlyFence({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  const ro = useReadOnly();
  return (
    <fieldset
      className={`pc-ro-fence${className ? ` ${className}` : ""}`}
      style={style}
      disabled={ro.locked}
      title={ro.locked ? ro.why : undefined}
      data-pc-ro={ro.locked ? "1" : undefined}
    >
      {children}
    </fieldset>
  );
}

/**
 * 给 `<html>` 打上 `data-pc-readonly="member"`（只读项目里）：样式表和不在 React 树里的界面（桌面版标题栏菜单）
 * 凭它认出「此刻这个项目改不了」。顶栏常驻，渲在顶栏里。同时把快捷键闸（`readOnlyKeys.ts`）带进来。
 */
export function ReadOnlyMarker() {
  const locked = useMemberReadOnly();
  useEffect(() => {
    const root = document.documentElement;
    if (locked) {
      root.dataset.pcReadonly = "member";
      root.dataset.pcReadonlyWhy = viewOnlyText();
    } else {
      delete root.dataset.pcReadonly;
      delete root.dataset.pcReadonlyWhy;
    }
    return () => { delete root.dataset.pcReadonly; delete root.dataset.pcReadonlyWhy; };
  }, [locked]);
  return null;
}
