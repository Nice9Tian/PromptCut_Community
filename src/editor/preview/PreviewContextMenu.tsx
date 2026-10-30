/**
 * 预览画布上的右键上下文菜单。
 * 包含「引用到 AI」和「删除」等针对单张卡片的操作。
 * 挂载在 window 顶层，点击外部时自动关闭。
 */
import React, { useEffect, useRef } from "react";
import { actions } from "../../store/project";
import { getCard } from "../../kernel/registry";
import { useReadOnly } from "../readOnly";

interface Props {
  x: number;
  y: number;
  clipId: string;
  cardId: string;
  onClose: () => void;
}

export function PreviewContextMenu({ x, y, clipId, cardId, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  // 这个项目只给了只读权限(游客):删除是写;「引用到 AI」要往只读的输入框里放东西,也置灰
  const ro = useReadOnly();

  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (rootRef.current && rootRef.current.contains(e.target as Node)) {
        return; // 点在菜单内部不关闭
      }
      onClose();
    };
    window.addEventListener("pointerdown", handleDown, { capture: true });
    window.addEventListener("contextmenu", handleDown, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", handleDown, { capture: true });
      window.removeEventListener("contextmenu", handleDown, { capture: true });
    };
  }, [onClose]);

  const handleQuote = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (ro.locked) return;
    const card = getCard(cardId);
    const label = card?.name || cardId;
    window.dispatchEvent(
      new CustomEvent("pc-quote-clip", {
        detail: { clipId, cardId, label },
      })
    );
    onClose();
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (ro.locked) return;
    actions.removeClip(clipId);
    onClose();
  };

  return (
    <div
      ref={rootRef}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 9999,
        background: "var(--ui-panel-2, #2c2c2c)",
        border: "1px solid var(--ui-border, #444)",
        borderRadius: 4,
        boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
        minWidth: 120,
        padding: "4px 0",
        color: "var(--ui-fg, #eee)",
        fontSize: 13,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="pc-menu-item"
        style={{ padding: "6px 12px", cursor: ro.locked ? "not-allowed" : "pointer", opacity: ro.locked ? 0.5 : 1 }}
        aria-disabled={ro.locked || undefined}
        title={ro.locked ? ro.why : undefined}
        onClick={handleQuote}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--ui-float, #3a3a3a)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        引用到 AI
      </div>
      <div
        className="pc-menu-item"
        style={{ padding: "6px 12px", cursor: ro.locked ? "not-allowed" : "pointer", color: "var(--ui-warn, #ff4d4f)", opacity: ro.locked ? 0.5 : 1 }}
        aria-disabled={ro.locked || undefined}
        title={ro.locked ? ro.why : undefined}
        onClick={handleDelete}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--ui-float, #3a3a3a)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        删除
      </div>
    </div>
  );
}
