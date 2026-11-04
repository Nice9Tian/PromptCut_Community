import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { canCloseTab, closeTab, useAgentTabs } from "../../ai/agentTabs";
import { useScript } from "../../ai/script";
import { IconBubblePlus } from "../../ui/icons";
import { RailIconAnimations, RailIconCaptions, RailIconEdit, RailIconEffects, RailIconLibrary } from "../left/railIcons";
import { IconScript, glyphOf, shortLabel, tabTooltip } from "../right/chat/RightRail";
import { useRailCollapsed } from "../sideRails";
import { useAgentAttentionMap } from "./agentAttention";
import { beginRailPointer } from "./railDrag";
import { RAIL_MORE_H, RailMoreButton, RailOverflowMenu } from "./railOverflow";
import { CUTS_ITEM, agentIdOf, effectiveActive, isSectionItem, plusAnchor, visibleItems, type ItemId, type SectionId, type Side } from "./railLayout";
import { addAgentOnSide, clickRailItem, useRailLayout } from "./railStore";
import "../right/chat/chat.css";
import "./dock.css";
import { tr } from "../../i18n/index.ts";

/** A rail item is 56 high + 4 gap; "+" is 40 high + 4 gap (studio.css / dock.css) */
const SLOT_H = 60;
const PLUS_H = 44;

/** Append a status line at the end of the Agent item's hover description */
const AGENT_STATE_TIP: Record<"busy" | "done" | "interrupted" | "idle", string> = {
  busy: tr("Running"),
  done: tr("Finished, waiting for you to review"),
  interrupted: tr("Interrupted, waiting for you to review"),
  idle: "",
};

const SECTION_META: Record<SectionId, { label: string; Icon: ComponentType }> = {
  library: { label: tr("Media library"), Icon: RailIconLibrary },
  animations: { label: tr("Animation"), Icon: RailIconAnimations },
  effects: { label: tr("Effects"), Icon: RailIconEffects },
  edit: { label: tr("Edit"), Icon: RailIconEdit },
  captions: { label: tr("Captions"), Icon: RailIconCaptions },
};

/**
 * One vertical rail (shared by left and right). Item order, which side, and which item is selected all come from railStore.
 *
 *   Clicking another item = switch to it and expand this side; clicking the item currently selected on this side = collapse / expand (sideRails).
 *   Press and drag more than 4px = drag (railDrag.ts); you can reorder within the same rail or drag to the other rail.
 *   "+" (new Agent tab) is not a draggable item: it is drawn directly below the last Agent item on this side, and not drawn if this side has no Agent.
 *   No divider lines between items, only a 4px gap; an emptied rail is still 64px wide and full height, to serve as a drop target.
 *
 * Hooks: nav `data-pc="left-rail" | "right-rail"` + `data-pc-dock-rail=<side>`, list `data-pc-dock-list=<side>`,
 * each item's outer `.pc-dock-slot[data-pc-dock-item=<ItemId>]`, the button inside is still `data-pc-rail=<section | script>` / `data-pc-agent-tab=<tabId>`,
 * "+" `data-pc="agent-tab-add"` + `data-pc-dock-add=<side>`.
 */
/**
 * One side's rail is split into two parts: head is in the upper area (beside the drawer / panel), tail is beside the timeline card, with its top edge aligned to the timeline's top edge.
 * The cut group manages the timeline, so it and the items after it are drawn in tail; the two parts are the same rail (same list, same data-pc-dock-rail),
 * and drag and drop moves items between the two parts as usual.
 */
export type RailPart = "head" | "tail";

export function RailBar({ side, part = "head" }: { side: Side; part?: RailPart }) {
  const layout = useRailLayout();
  const collapsed = useRailCollapsed(side);
  const { tabs } = useAgentTabs();
  const script = useScript();
  const attention = useAgentAttentionMap();

  // When the upper part cannot fit vertically, the last few items fold into the "▾" popup: measure the available height of the list
  const listRef = useRef<HTMLDivElement>(null);
  const [listH, setListH] = useState(Infinity);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  const all = visibleItems(layout[side]);
  const active = effectiveActive(layout, side);
  const anchor = plusAnchor(all);
  // The cut group and the items after it are drawn in the part beside the timeline (tail), the ones before it above (head). With no cut group, the whole rail is in head
  const cut = all.indexOf(CUTS_ITEM);
  const split = cut < 0 ? all.length : cut;
  const offset = part === "tail" ? split : 0;
  const items = part === "tail" ? all.slice(split) : all.slice(0, split);
  const empty = items.length === 0;

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || part === "tail") return;
    const measure = () => setListH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [part, empty]);

  // How many items fit: accumulate in order (the "+" after the anchor item also takes height); if all fit, there is no "▾";
  // if not, reserve a place for "▾" and count again. Fold only the last items: drop target indexes are computed by the number of drawn items, and folding middle ones would not match
  let fit = items.length;
  if (part === "head") {
    const heightOf = (n: number) => {
      let h = n * SLOT_H;
      if (anchor >= 0 && anchor < n) h += PLUS_H;
      return h;
    };
    if (heightOf(items.length) > listH) {
      fit = 0;
      while (fit < items.length && heightOf(fit + 1) + RAIL_MORE_H <= listH) fit++;
    }
  }
  const hidden = items.slice(fit);
  const plusHidden = anchor >= fit && anchor < items.length;
  useEffect(() => {
    if (hidden.length === 0) setMenuOpen(false);
  }, [hidden.length]);

  if (part === "tail" && empty) return null;

  const renderSlot = (id: ItemId, inMenu = false): ReactNode => {
    const on = id === active;
    const expanded = on ? !collapsed : undefined;
    // Items in the popup: clicking switches to it and closes the popup; they cannot be dragged from here
    const handlers = inMenu
      ? {
          onClick: () => {
            clickRailItem(side, id);
            setMenuOpen(false);
          },
        }
      : {
          onClick: () => clickRailItem(side, id),
          onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => beginRailPointer(e, id),
        };

    // Cut group removed 2026-10-20 (Argon review comment: the only cut entry points are the cut group in the media library and the tab bar above the timeline); this item left over in old layouts is not drawn
    if (id === CUTS_ITEM) return null;

    if (isSectionItem(id)) {
      const { label, Icon } = SECTION_META[id];
      return (
        <div key={id} className="pc-dock-slot" data-pc-dock-item={id}>
          <button
            type="button"
            data-pc-rail={id}
            className={`pc-rail-item${on ? " is-on" : ""}`}
            aria-pressed={on}
            aria-expanded={expanded}
            title={on ? (collapsed ? tr("Expand \"{0}\"", label) : tr("Collapse \"{0}\"", label)) : label}
            {...handlers}
          >
            <Icon />
            <span>{label}</span>
          </button>
        </div>
      );
    }

    if (id === "script") {
      return (
        <div key={id} className="pc-dock-slot" data-pc-dock-item={id}>
          <button
            type="button"
            data-pc-rail="script"
            className={`pc-rail-item${on ? " is-on" : ""}`}
            aria-current={on ? "page" : undefined}
            aria-expanded={expanded}
            title={script ? tr("Script has {0} characters, attached to the AI every turn", script.length) : tr("Write down what this video is about, the AI follows it every turn")}
            {...handlers}
          >
            <IconScript />
            <span>{tr("Script")}</span>
            {script && <i className="pc-rr-dot" aria-hidden="true" />}
          </button>
        </div>
      );
    }

    const tabId = agentIdOf(id);
    const index = tabs.findIndex((t) => t.id === tabId);
    const t = tabs[index];
    if (!t) return null;
    // Start page placeholder (this project has no session at all): drawn as one "Start" item, with no close button
    const draft = t.draft === true;
    const closable = canCloseTab(t.id);
    // While running, the avatar background has a flowing light; when finished / interrupted and the user has not yet looked at this page, a small dot (blue / yellow), see agentAttention.tsx
    const state = t.busy ? "busy" : attention.get(t.id) ?? "idle";
    const stateTip = AGENT_STATE_TIP[state];
    return (
      <div key={id} className="pc-dock-slot pc-rr-tab" data-pc-dock-item={id}>
        <button
          type="button"
          aria-pressed={on}
          aria-expanded={expanded}
          className={`pc-rail-item pc-rr-agent${on ? " is-on" : ""}${t.busy ? " is-busy" : ""}${draft ? " is-draft" : ""}`}
          data-pc-agent-tab={t.id}
          data-pc-agent-state={state}
          data-pc-agent-draft={draft ? "1" : undefined}
          title={draft ? tr("Start page: this project has no Agent session yet, one is created after the first message is sent") : stateTip ? `${tabTooltip(t)}
${stateTip}` : tabTooltip(t)}
          {...handlers}
        >
          <span className="pc-rr-glyph" aria-hidden="true">{draft ? "✦" : glyphOf(t, index)}</span>
          <span className="pc-rr-label">{draft ? tr("Start") : shortLabel(t.title)}</span>
          {(state === "done" || state === "interrupted") && <i className={`pc-rr-state is-${state}`} aria-hidden="true" />}
          {t.unread > 0 && (
            <b className="pc-rr-badge" title={tr("{0} messages from other Agents pending", t.unread)}>{t.unread}</b>
          )}
        </button>
        {!draft && (
          <button
            type="button"
            className="pc-rr-x"
            aria-label={tr("Close {0}", t.title)}
            disabled={!closable}
            title={t.busy ? tr("Still running, closing it will interrupt it") : tr("Close this tab")}
            onClick={() => {
              if (t.busy && !confirm(tr("{0} is still running and closing it will interrupt it. Close anyway?", t.title))) return;
              closeTab(t.id);
            }}
          >
            ×
          </button>
        )}
      </div>
    );
  };

  // "+" and the items go in the same keyed array: after a new page opens, moving it below the new item is a move, not an unmount and rebuild
  const plusButton = (inMenu: boolean) => (
    <button
      key="+"
      type="button"
      className="pc-rail-item pc-dock-add"
      data-pc="agent-tab-add"
      data-pc-dock-add={inMenu ? undefined : side}
      title={tr("New assistant tab")}
      aria-label={tr("New assistant tab")}
      onClick={() => {
        addAgentOnSide(side);
        if (inMenu) setMenuOpen(false);
      }}
    >
      <IconBubblePlus />
      {inMenu && <span>{tr("New assistant tab")}</span>}
    </button>
  );
  const children: ReactNode[] = [];
  items.slice(0, fit).forEach((id, i) => {
    children.push(renderSlot(id));
    if (i + offset === anchor) children.push(plusButton(false));
  });
  if (hidden.length > 0) {
    children.push(
      <RailMoreButton
        key="more"
        ref={moreRef}
        dataPc={`${side}-rail-more`}
        count={hidden.length}
        open={menuOpen}
        hasActive={!!active && hidden.includes(active)}
        title={tr("{0} more", hidden.length)}
        onToggle={() => setMenuOpen((v) => !v)}
      />,
    );
  }

  return (
    <nav
      className={`pc-rail pc-rail--${side} pc-dock-rail${part === "tail" ? " pc-dock-rail--tail" : ""}`}
      data-pc={part === "tail" ? `${side}-rail-tail` : `${side}-rail`}
      data-pc-dock-rail={side}
      aria-label={side === "left" ? (part === "tail" ? tr("Left rail cuts") : tr("Left rail sections")) : part === "tail" ? tr("Right rail cuts") : tr("Right rail tabs")}
    >
      {/* A thin horizontal line on top of the part beside the timeline, separating it from the upper part */}
      {part === "tail" && <div className="pc-rail-sep pc-dock-tail-sep" aria-hidden="true" />}
      {/* data-pc-dock-offset: how many items come before this part (in head); added when drag and drop computes the drop target */}
      <div ref={listRef} className="pc-dock-rail-list" data-pc-dock-list={side} data-pc-dock-offset={offset}>
        {children}
      </div>
      {menuOpen && hidden.length > 0 && (
        <RailOverflowMenu dataPc={`${side}-rail-menu`} anchor={moreRef.current} onClose={() => setMenuOpen(false)}>
          {hidden.map((id) => renderSlot(id, true))}
          {plusHidden && plusButton(true)}
        </RailOverflowMenu>
      )}
    </nav>
  );
}
