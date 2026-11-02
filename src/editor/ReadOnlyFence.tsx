import { useEffect, type CSSProperties, type ReactNode } from "react";
import { useMemberReadOnly, useReadOnly } from "./readOnly";
import { viewOnlyText } from "./io/viewOnly";
import "./readOnlyKeys";
import "./readOnly.css";

/**
 * A "read-only fence" around a whole form: in a read-only project, all native controls inside the fence (buttons,
 * inputs, dropdowns, sliders, checkboxes, text areas) are greyed out together,
 * values display as usual, and can be viewed, scrolled and text-selected; hovering over them shows the
 * `viewOnlyText()` sentence.
 *
 * It uses `<fieldset disabled>`: this disables all descendant native controls as a whole and keeps them from
 * keyboard focus, so it misses fewer than adding `disabled` to each control one by one.
 * `display: contents` (readOnly.css) keeps it out of the layout, so wrapping it does not change the layout inside;
 * when not read-only it does nothing.
 * What the fence cannot manage: "controls" implemented on their own with pointer events (such as dragging a label
 * to change a number); those must check `useReadOnly()` in their own handlers.
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
 * Puts `data-pc-readonly="member"` on `<html>` (in a read-only project): stylesheets and UI outside the React tree
 * (the desktop app's title bar menu)
 * use it to recognize that "this project cannot be changed right now". The top bar is always present, so this is
 * rendered in the top bar. It also brings in the shortcut gate (`readOnlyKeys.ts`).
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
