import { useEffect, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { KIND_LABEL } from "./io/mediaKinds";
import { onMediaMigrations, takeMediaMigrations, type MediaKindMigration } from "./io/mediaMigrationBus";
import { onPythonDrops, takePythonDrops, pythonDropMessage } from "./io/pythonDrop";

/**
 * 打开项目时的一次性提示层。两件事共用它（都只在加载那一刻发生、都只说一次）：
 * 素材分类迁移，和「旧 .proc 里的 Python 卡已停用」（H6：Python 卡运行时已归档，
 * 定义和节点在加载时直接丢弃，不向前兼容）。
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
  // 无头实例是给导出 / Agent 用的，不应让一个只给人看的确认层挡住画面。
  if (headless) return null;
  if (!items.length && droppedCards > 0) {
    return createPortal(
      <div className="pc-dialog-mask" role="presentation">
        <div className="pc-dialog" role="dialog" aria-modal="true" aria-labelledby="pc-python-nodes-dropped-title">
          <div id="pc-python-nodes-dropped-title" className="pc-dialog-title">部分卡片已停用</div>
          <div className="pc-dialog-body">
            <p className="text-neutral-300 text-sm">{pythonDropMessage(droppedCards)}</p>
          </div>
          <div className="pc-dialog-foot">
            <button type="button" className="pc-dialog-opt is-on" onClick={() => setDroppedCards(0)}>确定</button>
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
        <div id="pc-media-migration-title" className="pc-dialog-title">已自动整理素材分类</div>
        <div className="pc-dialog-body">
          <p className="text-neutral-300 text-sm mb-3">发现旧项目中有素材分类与文件扩展名不一致，已移动到对应分页：</p>
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
          <button type="button" className="pc-dialog-opt is-on" onClick={() => setItems([])}>确定</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
