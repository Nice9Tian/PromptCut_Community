import { useEffect } from "react";
import { setCardScope, type CardScope, type ScopeEntry } from "../cardScope";
import { getState } from "../../store/project";
import { onlinePage } from "../../online/pageFlag";
import { onlineUnsupported } from "../../online/onlineUnsupported";
import { tr } from "../../i18n/index.ts";

/**
 * Context menu for custom cards: switch tier between "Project media" and "Custom media".
 *
 * Why it exists: a custom card defaults to **project media** (it only appears in the project that
 * created it), because it is mostly made for a certain client or a certain video. But sometimes
 * you do want to keep it for reuse -- your own brand card, a frequently used chart card. This menu
 * is that opening, one click, with no digging through config files.
 *
 * A tier switch takes effect immediately for **both the card library and the Agent**: both read
 * the same ownership table.
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
    // Click elsewhere, press Esc or scroll to close it
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

  // No entry = an old card created before this feature, treated as "unassigned" -- it is now handled as custom, so what is offered is "Move into this project"
  const current: CardScope | "unknown" = entry?.scope ?? "unknown";
  const target: CardScope = current === "project" ? "custom" : "project";
  const label = target === "custom" ? tr("Convert to custom media (usable across projects)") : tr("Move into this project (no longer shown across projects)");

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
      // A mousedown on the menu itself must not trigger "click elsewhere to close"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 pb-1 pt-0.5 text-[10px] uppercase tracking-wide text-neutral-500">
        {current === "project" ? tr("Project media") : current === "custom" ? tr("Custom media") : tr("Unassigned (treated as custom)")}
      </div>
      <button
        type="button"
        className="block w-full px-3 py-1.5 text-left text-neutral-200 hover:bg-neutral-700/50 disabled:opacity-40"
        // Online browser mode: changing a card's ownership writes to the card directory in the editor process (C10 contract, section 10, "Creating and changing cards"), so it is greyed out
        disabled={onlinePage()}
        title={onlinePage() ? onlineUnsupported(tr("edit card")) : undefined}
        onClick={() => { if (!onlinePage()) void apply(); }}
      >
        {label}
      </button>
    </div>
  );
}
