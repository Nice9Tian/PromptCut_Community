import { useEffect, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import "../ProjectSettingsDialog.css";
import { onGoneConversion, takeGoneNotices, type GoneConversion } from "./recoveryAssociation";
import { CLOUD_GONE_TEXT } from "./recoveryTexts";

/** Shows a notice once after an expired cloud project is converted to a local project. The text is in `recoveryTexts.ts`. */
export function CloudGoneDialog(): JSX.Element | null {
  const [items, setItems] = useState<GoneConversion[]>([]);
  useEffect(() => {
    const pull = () => setItems((old) => [...old, ...takeGoneNotices()]);
    pull();
    return onGoneConversion(pull);
  }, []);
  // A headless instance serves export and Agent, so a confirmation layer meant only for humans must not
  // block the picture
  const headless = (() => { try { return new URLSearchParams(location.search).has("headless"); } catch { return false; } })();
  if (headless || !items.length) return null;
  const item = items[items.length - 1];
  return createPortal(
    <div className="pc-dialog-mask" role="presentation">
      <div className="pc-dialog" role="alertdialog" aria-modal="true" aria-labelledby="pc-cloud-gone-title" data-pc="cloud-gone-dialog" data-room={item.from.roomId}>
        <div id="pc-cloud-gone-title" className="pc-dialog-title">{CLOUD_GONE_TEXT.title}</div>
        <div className="pc-dialog-body">
          <p className="text-neutral-300 text-sm mb-2">{CLOUD_GONE_TEXT.body}</p>
          <p className="text-neutral-400 text-sm">{CLOUD_GONE_TEXT.keep}</p>
        </div>
        <div className="pc-dialog-foot">
          <button type="button" className="pc-dialog-opt is-on" data-pc="cloud-gone-ok" onClick={() => setItems([])}>{CLOUD_GONE_TEXT.ok}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
