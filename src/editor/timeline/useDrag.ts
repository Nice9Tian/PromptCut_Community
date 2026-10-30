import { useEffect, useRef } from "react";

export function useDrag(
  onDragStart: (e: PointerEvent) => void,
  onDragMove: (e: PointerEvent, delta: { x: number; y: number }, pointerEvent: PointerEvent) => void,
  onDragEnd: (e: PointerEvent) => void
) {
  const elRef = useRef<any>(null);
  const callbacks = useRef({ onDragStart, onDragMove, onDragEnd });

  useEffect(() => {
    callbacks.current = { onDragStart, onDragMove, onDragEnd };
  });

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      el.setPointerCapture(e.pointerId);
      callbacks.current.onDragStart(e);
      e.stopPropagation();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      callbacks.current.onDragMove(e, { x: dx, y: dy }, e);
      e.stopPropagation();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!isDragging) return;
      isDragging = false;
      el.releasePointerCapture(e.pointerId);
      callbacks.current.onDragEnd(e);
      e.stopPropagation();
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  return elRef;
}
