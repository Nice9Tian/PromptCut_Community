import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { useBackdropClose } from "../ui/backdropClose";
import { useSkin } from "../skins/useSkin";
import { skinGroups } from "../skins/skins";
import {
  SKIN_SLOTS,
  clearOverrides,
  getOverrides,
  setOverride,
  subscribeOverrides,
} from "../skins/overrides";
import "./SkinDialog.css";

/**
 * 皮肤对话框:上面挑预设,下面逐项调。
 *
 * 预设给一整套协调的配色,自定义是压在它上面的一层覆盖——换预设不会把改过的
 * 强调色冲掉,不想要了点「全部恢复默认」。改动即时生效,所见即所得,没有「应用」按钮。
 */
export function SkinDialog(props: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { open, onClose } = props;
  const { skinId, setSkin } = useSkin();
  const overrides = useSyncExternalStore(subscribeOverrides, getOverrides);
  const groups = useMemo(() => skinGroups(), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 遮罩:按下和松开都落在遮罩上才关,在输入框里拖着选文字不会误关(见 ui/backdropClose.ts)
  const backdrop = useBackdropClose(onClose);
  if (!open) return null;

  const slotGroups = SKIN_SLOTS.reduce<Record<string, typeof SKIN_SLOTS>>((acc, s) => {
    (acc[s.group] ||= []).push(s);
    return acc;
  }, {});

  return createPortal(
    <div className="pc-dialog-mask" {...backdrop}>
      <div
        className="pc-dialog pc-skin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pc-dialog-title-skin"
        onClick={(e) => e.stopPropagation()}
      >
        <div id="pc-dialog-title-skin" className="pc-dialog-title">
          皮肤
        </div>

        <div className="pc-skin-body">
          <section>
            <h3 className="pc-skin-h">预设风格</h3>
            {groups.map((g) => (
              <div key={g.group} className="pc-skin-group">
                <div className="pc-skin-group-name">{g.group}</div>
                <div className="pc-skin-presets">
                  {g.items.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={`pc-skin-preset${s.id === skinId ? " is-on" : ""}`}
                      title={s.description}
                      onClick={() => setSkin(s.id)}
                    >
                      {/* 直接用这套皮肤自己的变量画预览条,不用另外维护缩略图 */}
                      <span
                        className="pc-skin-chip"
                        style={{
                          background: s.vars["ui-bg"],
                          borderColor: s.vars["ui-border"],
                        }}
                      >
                        <i style={{ background: s.vars["ui-panel"] }} />
                        <i style={{ background: s.vars["ui-accent"] }} />
                        <i style={{ background: s.vars["ui-fg-muted"] }} />
                      </span>
                      <span className="pc-skin-preset-name">{s.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </section>

          <section>
            <div className="pc-skin-custom-head">
              <h3 className="pc-skin-h">自定义</h3>
              <button
                type="button"
                className="pc-btn"
                disabled={Object.keys(overrides).length === 0}
                onClick={() => clearOverrides()}
              >
                全部恢复默认
              </button>
            </div>
            <p className="pc-skin-note">
              改哪项就盖哪项，其余仍跟着预设走；换预设时这些改动会保留。
            </p>
            {Object.entries(slotGroups).map(([group, slots]) => (
              <div key={group} className="pc-skin-group">
                <div className="pc-skin-group-name">{group}</div>
                {slots.map((slot) => (
                  <SlotRow key={slot.key} slot={slot} overridden={overrides[slot.key]} />
                ))}
              </div>
            ))}
          </section>
        </div>

        <div className="pc-dialog-foot">
          <button type="button" className="pc-btn pc-btn--primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 一行槽位。
 *
 * 取色器要 #rrggbb,而皮肤里存的可能是 color-mix(...) 或 rgba(...),没法直接喂进去。
 * 所以拿一个探针元素把 var 解析成计算值再转成 hex——用户看到的就是眼前真实的颜色。
 */
function SlotRow({
  slot,
  overridden,
}: {
  slot: (typeof SKIN_SLOTS)[number];
  overridden?: string;
}): JSX.Element {
  const [resolved, setResolved] = useState("#000000");

  useEffect(() => {
    setResolved(resolveVarToHex(slot.key));
  }, [slot.key, overridden]);

  return (
    <div className="pc-skin-slot">
      <label className="pc-skin-slot-label" htmlFor={`slot-${slot.key}`}>
        {slot.label}
        {slot.hint && <span className="pc-skin-slot-hint">{slot.hint}</span>}
      </label>
      <input
        id={`slot-${slot.key}`}
        type="color"
        className="pc-skin-color"
        value={resolved}
        onChange={(e) => setOverride(slot.key, e.target.value)}
      />
      <button
        type="button"
        className="pc-skin-reset"
        title={overridden ? "恢复这一项的默认值" : "还没改过这一项"}
        disabled={!overridden}
        onClick={() => setOverride(slot.key, null)}
      >
        ↺
      </button>
    </div>
  );
}

/** 把 --ui-* 的当前生效值解析成 #rrggbb(取色器只吃这个格式) */
function resolveVarToHex(key: string): string {
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;visibility:hidden;color:var(--${key})`;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(rgb);
  if (!m) return "#000000";
  const hex = (n: string) => Math.round(Number(n)).toString(16).padStart(2, "0");
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}
