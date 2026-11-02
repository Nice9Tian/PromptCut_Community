import { useCallback, useRef } from "react";
import type { PointerEvent, MouseEvent } from "react";

/**
 * The right way to write "click the backdrop to close".
 *
 * Attaching onClick directly to the backdrop has a pitfall: the user presses the mouse in an input box
 * and drags to select text, and by the time they release, the mouse has slid outside the dialog. The
 * browser dispatches the click to the **common ancestor** of the press point and the release point,
 * which is the backdrop, so selecting a word closes the window (observed on the Router / API settings
 * page).
 *
 * So both the press and the release are required to land on the backdrop itself: at pointerdown, note
 * whether the target is the backdrop, and at click close only when both match. Events inside the dialog
 * may still call stopPropagation as before, and nothing here relies on that.
 */
export function useBackdropClose(onClose: () => void): {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onClick: (e: MouseEvent<HTMLElement>) => void;
} {
  const downOnBackdrop = useRef(false);
  const onPointerDown = useCallback((e: PointerEvent<HTMLElement>) => {
    downOnBackdrop.current = e.target === e.currentTarget;
  }, []);
  const onClick = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      const hit = downOnBackdrop.current && e.target === e.currentTarget;
      downOnBackdrop.current = false;
      if (hit) onClose();
    },
    [onClose],
  );
  return { onPointerDown, onClick };
}
