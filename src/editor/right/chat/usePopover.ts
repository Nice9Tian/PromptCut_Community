import { useEffect, useRef, useState } from "react";

/**
 * Open/close logic shared by the two small popovers on the input toolbar (the "✦" menu and the model's
 * "⋯" run options).
 *
 * Usage: put anchorRef on the layer wrapping "button + popover"; the popover carries data-pop, and
 * opening/closing uses inline display. The popover does not use a portal: it pops up from the input
 * area and lands above the message area, still inside the right-rail card, so the card's
 * overflow:hidden does not clip it; being mounted in the panel it also goes display:none together
 * with its tab, so switching to another tab leaves no orphaned menu behind.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape; also close on window resize, so the popover and button don't get misaligned
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      // Return focus to the button that opened it, so keyboard users don't fall back to body
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

  // After opening, move focus into the popover. Skip disabled items (e.g. "Diagnostic report" when there are no messages), otherwise focus would be lost
  useEffect(() => {
    if (!open) return;
    anchorRef.current
      ?.querySelector<HTMLElement>("[data-pop] button:not([disabled]), [data-pop] select:not([disabled])")
      ?.focus();
  }, [open]);

  return { open, setOpen, toggle: () => setOpen((v) => !v), anchorRef };
}
