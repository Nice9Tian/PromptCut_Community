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
import { tr } from "../i18n/index.ts";

/**
 * Skin dialog: pick a preset above, fine-tune item by item below.
 *
 * A preset gives a full coordinated color scheme; customizations are an override layer on top of
 * it, so switching presets does not wipe out an accent color you changed. If you no longer want
 * them, click "Restore all defaults". Changes take effect immediately, WYSIWYG, with no "Apply"
 * button.
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

  // Backdrop: close only when both press and release land on the backdrop, so dragging to select text inside an
  // input does not close it by mistake (see ui/backdropClose.ts)
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
          {tr("Skin")}
        </div>

        <div className="pc-skin-body">
          <section>
            <h3 className="pc-skin-h">{tr("Preset styles")}</h3>
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
                      {/* Draw the preview strip directly with this skin's own variables, so no separate thumbnails need to be maintained */}
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
              <h3 className="pc-skin-h">{tr("Custom")}</h3>
              <button
                type="button"
                className="pc-btn"
                disabled={Object.keys(overrides).length === 0}
                onClick={() => clearOverrides()}
              >
                {tr("Reset all to defaults")}
              </button>
            </div>
            <p className="pc-skin-note">
              {tr("Whatever you change overrides only that item; the rest keep following the preset. These changes are kept when you switch presets.")}
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
            {tr("Done")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * One row of slots.
 *
 * The color picker needs #rrggbb, but the skin may store color-mix(...) or rgba(...), which can't be
 * fed in directly. So a probe element resolves the var to a computed value and converts it to
 * hex: what the user sees is the real color in front of them.
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
        title={overridden ? tr("Reset this item to its default") : tr("This item hasn't been changed")}
        disabled={!overridden}
        onClick={() => setOverride(slot.key, null)}
      >
        ↺
      </button>
    </div>
  );
}

/** Resolve the currently effective value of --ui-* to #rrggbb (the color picker only accepts this format) */
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
