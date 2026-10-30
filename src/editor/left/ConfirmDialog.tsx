import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export function ConfirmDialog({ open, title, message, confirmText="确定", cancelText="取消", onConfirm, onCancel }: { open: boolean, title: string, message: string, confirmText?: string, cancelText?: string, onConfirm: () => void, onCancel: () => void }) {
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  
  const confirmRef = useRef(onConfirm);
  const cancelRef = useRef(onCancel);
  
  useEffect(() => {
    confirmRef.current = onConfirm;
    cancelRef.current = onCancel;
  });

  useEffect(() => {
    if (open) {
      cancelBtnRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelRef.current();
      } else if (e.key === "Enter") {
        e.preventDefault();
        confirmRef.current();
      }
    };
    
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div 
      className="fixed inset-0 bg-black/60 z-[1000] grid place-items-center"
      onClick={onCancel}
    >
      <div 
        data-pc="confirm"
        role="dialog" 
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-80 rounded-lg border border-neutral-700 bg-neutral-900 p-4 text-sm shadow-2xl"
      >
        <div className="font-medium mb-2 text-neutral-100">{title}</div>
        <div className="text-neutral-400 text-xs mb-4 whitespace-pre-line">
          {message.split('\n').map((line, i, arr) => (
            <span key={i}>
              {line}
              {i < arr.length - 1 && <br/>}
            </span>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button 
            data-pc="confirm-cancel"
            ref={cancelBtnRef}
            onClick={onCancel}
            className="px-3 py-1 rounded border border-neutral-700 text-xs text-neutral-200"
          >
            {cancelText}
          </button>
          <button 
            data-pc="confirm-ok"
            onClick={onConfirm}
            className="px-3 py-1 rounded bg-neutral-100 text-neutral-900 text-xs"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
