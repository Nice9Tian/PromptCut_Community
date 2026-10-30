import { useEffect } from "react";
import { setCardScope, type CardScope, type ScopeEntry } from "../cardScope";
import { getState } from "../../store/project";
import { onlinePage, onlineUnsupported } from "../../online/pageFlag";

/**
 * 定制卡的右键菜单:在「项目素材」和「自定义素材」之间换档。
 *
 * 为什么要有这个:定制卡默认是**项目素材**(只在建它的那个项目里出现),因为它多半是
 * 给某个客户、某条片子做的。但有时候确实想留着复用 —— 自己的品牌卡、常用的图表卡。
 * 这个菜单就是那个口子,一次点击的事,不用去翻配置文件。
 *
 * 换档立刻对**卡库和 Agent 同时生效**:两边读的是同一张归属表。
 */
export function UserCardMenu({
  cardId,
  entry,
  x,
  y,
  onClose,
  onChanged,
}: {
  cardId: string;
  entry: ScopeEntry | undefined;
  x: number;
  y: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    // 点别处、按 Esc、滚动都收起来
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", close, true);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // 没有条目 = 这个功能之前建的老卡,当作「未归属」——它现在按自定义处理,所以给的是「收归本项目」
  const current: CardScope | "unknown" = entry?.scope ?? "unknown";
  const target: CardScope = current === "project" ? "custom" : "project";
  const label = target === "custom" ? "转换为自定义素材(跨项目可用)" : "收归本项目(不再跨项目出现)";

  const apply = async () => {
    await setCardScope(cardId, target, getState().project.id ?? null);
    onChanged();
    onClose();
  };

  return (
    <div
      className="fixed z-50 min-w-[190px] rounded border border-neutral-700 bg-[var(--ui-panel,#161a22)] py-1 text-[12px] shadow-lg"
      style={{ left: x, top: y }}
      data-pc="user-card-menu"
      // 菜单自己身上的 mousedown 不该触发「点别处关闭」
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 pb-1 pt-0.5 text-[10px] uppercase tracking-wide text-neutral-500">
        {current === "project" ? "项目素材" : current === "custom" ? "自定义素材" : "未归属(按自定义处理)"}
      </div>
      <button
        type="button"
        className="block w-full px-3 py-1.5 text-left text-neutral-200 hover:bg-neutral-700/50 disabled:opacity-40"
        // 在线浏览器模式:改卡的归属要写编辑器进程里的卡片目录(C10 契约第 10 节「建卡与改卡」),置灰
        disabled={onlinePage()}
        title={onlinePage() ? onlineUnsupported("改卡") : undefined}
        onClick={() => { if (!onlinePage()) void apply(); }}
      >
        {label}
      </button>
    </div>
  );
}
