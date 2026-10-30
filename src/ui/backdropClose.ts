import { useCallback, useRef } from "react";
import type { PointerEvent, MouseEvent } from "react";

/**
 * 「点遮罩关闭」的正确写法。
 *
 * 直接给遮罩挂 onClick 有一个坑:用户在输入框里按下鼠标拖着选文字,松手时鼠标已经
 * 滑到了对话框外面 —— 浏览器把 click 派发给按下和松开两点的**共同祖先**,也就是遮罩,
 * 于是选个字就把窗口关了(Router / API 设置页实测)。
 *
 * 所以要求按下和松开都落在遮罩本身:pointerdown 时记一下目标是不是遮罩,click 时
 * 两样都对上才关。对话框内部的事件照旧 stopPropagation 也行,这里不依赖它。
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
