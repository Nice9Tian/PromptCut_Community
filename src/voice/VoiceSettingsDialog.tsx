import { useCallback, useEffect, useRef } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { VoiceSettings } from "./VoiceSettings";
import { closeVoiceSettings, useVoiceSettingsState } from "../ai/voiceSettingsStore";

/**
 * 「配音设置」子窗口。开始页的配音卡和编辑台顶栏的按钮都开它,两处各挂一份
 * (开始页和编辑台不会同时在屏幕上)。挂在 body 上,不受外层 overflow 裁切。
 */
export function VoiceSettingsDialog(): JSX.Element | null {
  const st = useVoiceSettingsState();
  if (!st.open) return null;
  // key 用 seq:每次打开都重新读一遍设置,不带着上次没保存的改动
  return <Dialog key={st.seq} />;
}

function Dialog(): JSX.Element {
  const dirty = useRef(false);

  // 有没保存的改动时关窗先问一句,免得调了半天一个 Esc 全没了
  const close = useCallback(() => {
    if (dirty.current && !confirm("有没保存的改动，关掉就不要了？")) return;
    closeVoiceSettings();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return createPortal(
    // 只认在遮罩本身上按下的点击:在输入框里拖选文字拖出窗口外松手,不该把窗口关了
    <div className="vsd-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="vsd-dialog" role="dialog" aria-modal="true" aria-label="配音设置">
        <div className="vsd-head">
          <div className="vsd-title">配音设置</div>
          <button className="vsd-x" onClick={close} aria-label="关闭">×</button>
        </div>
        <div className="vsd-body">
          <VoiceSettings bare onDirtyChange={(d) => { dirty.current = d; }} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
