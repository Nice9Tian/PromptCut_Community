import { useEffect, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { KIND_LABEL } from "./io/mediaKinds";
import { onMissingMaterials, takeMissingMaterials, type MissingMaterialNotice } from "./io/missingMaterialBus";
import { MISSING_MATERIALS_TEXT } from "./sync/recoveryTexts";

/**
 * 打开项目后认定了「确认缺失」的素材时弹一次，把缺了哪些列出来。认定在 `io/mediaUpload.ts`，文字在 `sync/recoveryTexts.ts`。
 * 保存重开时已经认定过的不再弹（那时不会有新通知）。
 */
export function MissingMaterialsDialog(): JSX.Element | null {
  const [items, setItems] = useState<MissingMaterialNotice[]>([]);
  useEffect(() => {
    const pull = () => setItems((old) => {
      const seen = new Set(old.map((item) => item.id));
      return [...old, ...takeMissingMaterials().filter((item) => !seen.has(item.id))];
    });
    pull();
    return onMissingMaterials(pull);
  }, []);
  // 无头实例是给导出、Agent 用的，不让一个只给人看的确认层挡住画面
  const headless = (() => { try { return new URLSearchParams(location.search).has("headless"); } catch { return false; } })();
  if (headless || !items.length) return null;
  return createPortal(
    <div className="pc-dialog-mask" role="presentation">
      <div className="pc-dialog" role="alertdialog" aria-modal="true" aria-labelledby="pc-missing-materials-title" data-pc="missing-materials-dialog">
        <div id="pc-missing-materials-title" className="pc-dialog-title">{MISSING_MATERIALS_TEXT.title}</div>
        <div className="pc-dialog-body">
          <p className="text-neutral-300 text-sm mb-3">{MISSING_MATERIALS_TEXT.missing(items.length)}</p>
          <div className="max-h-64 overflow-y-auto rounded border border-neutral-700">
            {items.map((item) => (
              <div key={item.id} data-pc="missing-material-item" data-media={item.id} className="flex items-center justify-between gap-3 px-3 py-2 border-b last:border-b-0 border-neutral-800 text-xs">
                <span className="truncate text-neutral-200" title={item.name}>{item.name}</span>
                <span className="shrink-0 text-neutral-400">{KIND_LABEL[item.kind]}{item.changed ? ` · ${MISSING_MATERIALS_TEXT.changed}` : ""}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="pc-dialog-foot">
          <button type="button" className="pc-dialog-opt is-on" data-pc="missing-materials-ok" onClick={() => setItems([])}>{MISSING_MATERIALS_TEXT.ok}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
