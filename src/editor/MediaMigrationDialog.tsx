import { useEffect, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { KIND_LABEL } from "./io/mediaKinds";
import { onMediaMigrations, takeMediaMigrations, type MediaKindMigration } from "./io/mediaMigrationBus";
import { onPythonDrops, takePythonDrops, pythonDropMessage } from "./io/pythonDrop";
import { tr } from "../i18n/index.ts";

/**
 * A one-time prompt layer shown when a project is opened. Two things share it (both happen only at load
 * time and are each said only once): the media category migration, and "Python cards in the old .proc
 * are disabled" (H6: the Python card runtime has been archived, and definitions and nodes are dropped
 * directly at load, with no forward compatibility).
 */
export function MediaMigrationDialog(): JSX.Element | null {
  const [items, setItems] = useState<MediaKindMigration[]>([]);
  const [droppedCards, setDroppedCards] = useState(0);
  const headless = (() => {
    try { return new URLSearchParams(location.search).has("headless"); } catch { return false; }
  })();
  useEffect(() => {
    const pull = () => setItems((old) => [...old, ...takeMediaMigrations()]);
    pull();
    return onMediaMigrations(pull);
  }, []);
  useEffect(() => {
    const pull = () => setDroppedCards((old) => old + takePythonDrops());
    pull();
    return onPythonDrops(pull);
  }, []);
  // A headless instance serves export / Agent, so a confirmation layer meant only for humans must not
  // block the picture.
  if (headless) return null;
  if (!items.length && droppedCards > 0) {
    return createPortal(
      <div className="pc-dialog-mask" role="presentation">
        <div className="pc-dialog" role="dialog" aria-modal="true" aria-labelledby="pc-python-nodes-dropped-title">
          <div id="pc-python-nodes-dropped-title" className="pc-dialog-title">{tr("Some cards have been disabled")}</div>
          <div className="pc-dialog-body">
            <p className="text-neutral-300 text-sm">{pythonDropMessage(droppedCards)}</p>
          </div>
          <div className="pc-dialog-foot">
            <button type="button" className="pc-dialog-opt is-on" onClick={() => setDroppedCards(0)}>{tr("OK")}</button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }
  if (!items.length) return null;
  return createPortal(
    <div className="pc-dialog-mask" role="presentation">
      <div className="pc-dialog" role="dialog" aria-modal="true" aria-labelledby="pc-media-migration-title">
        <div id="pc-media-migration-title" className="pc-dialog-title">{tr("Media categories organized automatically")}</div>
        <div className="pc-dialog-body">
          <p className="text-neutral-300 text-sm mb-3">{tr("Found media in an old project whose category did not match the file extension; moved to the matching tab:")}</p>
          <div className="max-h-64 overflow-y-auto rounded border border-neutral-700">
            {items.map((item, index) => (
              <div key={`${item.id}-${index}`} className="flex items-center justify-between gap-3 px-3 py-2 border-b last:border-b-0 border-neutral-800 text-xs">
                <span className="truncate text-neutral-200" title={item.name}>{item.name}</span>
                <span className="shrink-0 text-neutral-400">{KIND_LABEL[item.from]} → {KIND_LABEL[item.to]}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="pc-dialog-foot">
          <button type="button" className="pc-dialog-opt is-on" onClick={() => setItems([])}>{tr("OK")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
