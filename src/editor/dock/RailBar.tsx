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

/** rail 项 56 高 + 4 间距;「+」40 高 + 4 间距(studio.css / dock.css) */
const SLOT_H = 60;
const PLUS_H = 44;

/** Agent 项悬停说明末尾补一行状态 */
const AGENT_STATE_TIP: Record<"busy" | "done" | "interrupted" | "idle", string> = {
  busy: "正在运行",
  done: "已完成,等你查看",
  interrupted: "已中断,等你查看",
  idle: "",
};

const SECTION_META: Record<SectionId, { label: string; Icon: ComponentType }> = {
  library: { label: "素材库", Icon: RailIconLibrary },
  animations: { label: "动画", Icon: RailIconAnimations },
  effects: { label: "特效", Icon: RailIconEffects },
  edit: { label: "编辑", Icon: RailIconEdit },
  captions: { label: "字幕", Icon: RailIconCaptions },
};

/**
 * 一条竖向 rail(左右共用)。项的顺序、在哪一侧、选中哪一项都来自 railStore。
 *
 *   点另一项 = 切过去并展开这一侧;点这一侧此刻选中的项 = 收起 / 展开(sideRails)。
 *   按住拖动超过 4px = 拖动(railDrag.ts),可以在同一条 rail 里调顺序,也可以拖到另一条 rail。
 *   「+」(新 Agent 分页)不是可拖的项:画在这一侧最后一个 Agent 项正下方,这一侧没有 Agent 就不画。
 *   项之间不画分隔线,只靠 4px 间距;拖空的 rail 仍然 64px 宽、占满高度,当落点用。
 *
 * 钩子:nav `data-pc="left-rail" | "right-rail"` + `data-pc-dock-rail=<side>`,列表 `data-pc-dock-list=<side>`,
 * 每项外层 `.pc-dock-slot[data-pc-dock-item=<ItemId>]`,里面的按钮照旧 `data-pc-rail=<分区 | script>` / `data-pc-agent-tab=<tabId>`,
 * 「+」`data-pc="agent-tab-add"` + `data-pc-dock-add=<side>`。
 */
/**
 * 一侧 rail 分成两截:head 在上半区(抽屉 / 面板旁边),tail 在时间轴卡片旁边、顶边和时间轴顶边对齐。
 * 剪辑组管的是时间轴,所以它连同排在它后面的项画在 tail;两截是同一条 rail(同一份列表、同一个 data-pc-dock-rail),
 * 拖放在两截之间照常挪。
 */
export type RailPart = "head" | "tail";

export function RailBar({ side, part = "head" }: { side: Side; part?: RailPart }) {
  const layout = useRailLayout();
  const collapsed = useRailCollapsed(side);
  const { tabs } = useAgentTabs();
  const script = useScript();
  const attention = useAgentAttentionMap();

  // 上半截竖向放不下时,末尾几项收进「▾」子窗口:量列表可用高度
  const listRef = useRef<HTMLDivElement>(null);
  const [listH, setListH] = useState(Infinity);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  const all = visibleItems(layout[side]);
  const active = effectiveActive(layout, side);
  const anchor = plusAnchor(all);
  // 剪辑组和排在它后面的项画在时间轴旁边那截(tail),前面的画在上面(head)。没有剪辑组时整条都在 head
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

  // 放得下几项:按顺序累加(「+」跟在 anchor 那一项后面也占高度),全放下就不要「▾」;
  // 放不下就给「▾」留出位置再数一遍。只收末尾的项 —— 拖放落点按画出来的项数算,收中间的会对不上
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
    // 子窗口里的项:点了切过去并关窗口,不能从这里拖
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

    // 剪辑组 2026-10-20 撤掉(Argon 审核意见:剪辑入口只留素材库剪辑组和时间轴上方标签栏);老布局里残留的这一项不画
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
            title={on ? (collapsed ? `展开「${label}」` : `收起「${label}」`) : label}
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
            title={script ? `剧本已写 ${script.length} 字，每轮都会附给 AI` : "写下这条片子要讲什么，AI 每轮都会照着它做"}
            {...handlers}
          >
            <IconScript />
            <span>剧本</span>
            {script && <i className="pc-rr-dot" aria-hidden="true" />}
          </button>
        </div>
      );
    }

    const tabId = agentIdOf(id);
    const index = tabs.findIndex((t) => t.id === tabId);
    const t = tabs[index];
    if (!t) return null;
    // 开始页占位(本项目一个会话都没有):画成一项「开始」,没有关闭按钮
    const draft = t.draft === true;
    const closable = canCloseTab(t.id);
    // 跑的时候头像背景流光;跑完 / 中断且用户还没看这一页时一个小点(蓝 / 黄),见 agentAttention.tsx
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
          title={draft ? "开始页:这个项目还没有 Agent 会话,发出第一条消息后才会建立" : stateTip ? `${tabTooltip(t)}
${stateTip}` : tabTooltip(t)}
          {...handlers}
        >
          <span className="pc-rr-glyph" aria-hidden="true">{draft ? "✦" : glyphOf(t, index)}</span>
          <span className="pc-rr-label">{draft ? "开始" : shortLabel(t.title)}</span>
          {(state === "done" || state === "interrupted") && <i className={`pc-rr-state is-${state}`} aria-hidden="true" />}
          {t.unread > 0 && (
            <b className="pc-rr-badge" title={`${t.unread} 条其他 Agent 的消息待处理`}>{t.unread}</b>
          )}
        </button>
        {!draft && (
          <button
            type="button"
            className="pc-rr-x"
            aria-label={`关闭 ${t.title}`}
            disabled={!closable}
            title={t.busy ? "还在跑,关掉会中断它" : "关闭这一页"}
            onClick={() => {
              if (t.busy && !confirm(`${t.title} 还在跑,关掉会中断它。确定关闭?`)) return;
              closeTab(t.id);
            }}
          >
            ×
          </button>
        )}
      </div>
    );
  };

  // 「+」和各项放在同一个带 key 的数组里:新开一页后它挪到新项下面是移动,不是卸载重建
  const plusButton = (inMenu: boolean) => (
    <button
      key="+"
      type="button"
      className="pc-rail-item pc-dock-add"
      data-pc="agent-tab-add"
      data-pc-dock-add={inMenu ? undefined : side}
      title="新助手分页"
      aria-label="新助手分页"
      onClick={() => {
        addAgentOnSide(side);
        if (inMenu) setMenuOpen(false);
      }}
    >
      <IconBubblePlus />
      {inMenu && <span>新助手分页</span>}
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
        title={`还有 ${hidden.length} 项`}
        onToggle={() => setMenuOpen((v) => !v)}
      />,
    );
  }

  return (
    <nav
      className={`pc-rail pc-rail--${side} pc-dock-rail${part === "tail" ? " pc-dock-rail--tail" : ""}`}
      data-pc={part === "tail" ? `${side}-rail-tail` : `${side}-rail`}
      data-pc-dock-rail={side}
      aria-label={side === "left" ? (part === "tail" ? "左栏剪辑" : "左栏分区") : part === "tail" ? "右栏剪辑" : "右栏分页"}
    >
      {/* 时间轴旁边那一截顶上一道小横线,和上半部分分开 */}
      {part === "tail" && <div className="pc-rail-sep pc-dock-tail-sep" aria-hidden="true" />}
      {/* data-pc-dock-offset:这一截前面还有几项(在 head 里),拖放算落点时加上 */}
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
