import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAgentTabs } from "../../ai/agentTabs";
import { onCaptionsRequest } from "../left/captionsBus";
import { LibrarySection } from "../left/LibrarySection";
// 必须静态导入:AnimationsSection → cardGroups → CardCell → previewZoom → prewarmBoxes,window.__pcPreviewBoxes 靠这条链挂上
import { AnimationsSection } from "../left/AnimationsSection";
import { EffectsSection } from "../left/EffectsSection";
import { EditSection } from "../left/EditSection";
import { CaptionsSection } from "../left/CaptionsSection";
import { AiPanel } from "../right/AiPanel";
import { OnlineAgentPage } from "../right/OnlineAgentPage";
import { ScriptPage } from "../right/chat/ScriptPage";
import { AgentAttentionTracker } from "./agentAttention";
import { DockPageContext } from "./dockSide";
import { pageNode, placePages, registerDockPark, releasePageNodes } from "./pageNodes";
import { SECTION_IDS, agentItem, effectiveActive, sideOf, type ItemId, type SectionId } from "./railLayout";
import { activateRailItem, useRailLayout } from "./railStore";
import { useRailCollapsed } from "../sideRails";
import { StoreHold } from "../../store/project";
import "../left/left.css";
import "./dock.css";

// 页面内容只在自己的 props 变了才重渲:rail 上点一下只改选中项,不该把所有分区和所有 AiPanel 都重渲一遍
const LibraryPage = memo(LibrarySection);
const AnimationsPage = memo(AnimationsSection);
const EffectsPage = memo(EffectsSection);
const EditPage = memo(EditSection);
const CaptionsPage = memo(CaptionsSection);
const ScriptPageMemo = memo(ScriptPage);
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";
/**
 * 在线浏览器模式的 Agent 页:AI 助手的本机版要本机编辑器进程(模型配置、对话记录、工具执行都走它的 `/api/*`),在线页面按契约第 2 节
 * 不挂 AiPanel,换成「云端」接入方式的 AI 栏(`OnlineAgentPage`,云端 Agent 服务契约 9.5;不分身份、不分档,`product/platforms.md`「AI 栏」)。
 */
function OnlineAgentSwitch(props: { tabId: string; active: boolean; mcpConnected: boolean }) {
  return <OnlineAgentPage tabId={props.tabId} active={props.active} />;
}
const AgentPage = memo(ONLINE_BUILD ? OnlineAgentSwitch : AiPanel);

const goImport = () => activateRailItem("library", { expand: true });

/**
 * 所有页面(五个分区、剧本页、每个 Agent 分页的 AiPanel)统一在这里各渲染一次,createPortal 进各自固定的节点(pageNodes)。
 * 这个组件挂在 RightPanel 里 —— RightPanel 在 Editor 网格里永远占同一个兄弟槽位、从不卸载,
 * 所以这里的 React 树从不因为拖动、切换、收起、换布局模式而改变:portal 的 key 是项 id,容器节点按 id 固定。
 * 两侧宿主(DockHost)只挪 DOM 节点,正在跑的 AI 对话、分区的滚动位置 / 搜索词 / 草稿都不受影响。
 *
 * 挂载时机:剧本页和 AiPanel 一开始就挂(对话要在后台照跑);分区在布局里有位置的一开始就挂(和改版前左栏五个分区常驻一致),
 * 挂上之后再也不卸载。
 */
export function DockPages({ mcpConnected }: { mcpConnected: boolean }) {
  const layout = useRailLayout();
  const { tabs } = useAgentTabs();
  const collapsed = { left: useRailCollapsed("left"), right: useRailCollapsed("right") };

  // 字幕分区聚焦哪份素材:时间轴 / 素材库右键「转写字幕」经 captionsBus 设进来
  const [captionMediaId, setCaptionMediaId] = useState<string | null>(null);
  const [revealToken, setRevealToken] = useState(0);
  useEffect(
    () =>
      onCaptionsRequest((id) => {
        activateRailItem("captions", { expand: true });
        setCaptionMediaId(id);
        setRevealToken((n) => n + 1);
      }),
    [],
  );

  const [mountedSections, setMountedSections] = useState<ReadonlySet<SectionId>>(() => new Set());
  const due: SectionId[] = SECTION_IDS.filter((id) => !!sideOf(layout, id));
  let sections = mountedSections;
  if (due.some((id) => !mountedSections.has(id))) {
    sections = new Set([...mountedSections, ...due]);
    // 渲染期间补登记(React 允许组件在渲染里更新自己的 state),这一轮就按新集合画
    setMountedSections(sections);
  }

  const parkRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = parkRef.current;
    return el ? registerDockPark(el) : undefined;
  }, []);

  // 编辑台整个卸载(回首页)时把节点表清空:模块级的节点表还拿着旧页面子树,不清就一直占着。
  // 只在卸载时跑 —— 不能并进下面那个每次提交都跑的 effect,那样每次渲染都会删光节点、所有页面重挂载。
  // (main.tsx 不包 StrictMode,不会有「挂上立刻假卸载」把节点删掉的情况)
  useLayoutEffect(() => () => releasePageNodes(new Set()), []);

  const keep = new Set<ItemId>([...sections, "script", ...tabs.map((t) => agentItem(t.id))]);
  useLayoutEffect(() => {
    // 关掉的 Agent:portal 已在这次提交里卸载,节点一起扔掉;新挂上的页交给 placePages 摆到宿主里
    releasePageNodes(keep);
    placePages();
  });

  const shown = (id: ItemId) => {
    const side = sideOf(layout, id);
    return !!side && effectiveActive(layout, side) === id;
  };
  const portal = (id: ItemId, content: ReactNode) =>
    createPortal(<DockPageContext.Provider value={id}>{content}</DockPageContext.Provider>, pageNode(id), id);
  /*
   * 分区页常驻挂载,看不见时(没选中,或所在一侧收起着)包一层 StoreHold:不跟 store 的更新,
   * 露出来的那一次提交里再按当时的 store 重读(store/core.ts 的 StoreHold)。以前每次编辑都把
   * 看不见的特效库、节点图、字幕列表整棵重渲,挤在编辑那个同步任务里(tiers-probe T4)。
   */
  const hidden = (id: SectionId) => {
    const side = sideOf(layout, id);
    return !side || collapsed[side] || effectiveActive(layout, side) !== id;
  };
  const section = (id: SectionId, content: ReactNode) =>
    sections.has(id) ? portal(id, <StoreHold value={hidden(id)}>{content}</StoreHold>) : null;

  return (
    <>
      {/* 停车位:宿主没挂载的一侧的页面节点停在这里,不脱离文档 */}
      <div ref={parkRef} className="pc-dock-park" data-pc-dock-park="" aria-hidden="true" style={{ display: "none" }} />
      {/* rail 上 Agent 项的「跑完 / 中断,等你查看」标记 */}
      <AgentAttentionTracker />
      {section("library", <LibraryPage />)}
      {section("animations", <AnimationsPage />)}
      {section("effects", <EffectsPage />)}
      {section("edit", <EditPage />)}
      {section(
        "captions",
        <CaptionsPage mediaId={captionMediaId} onPick={setCaptionMediaId} revealToken={revealToken} onGoImport={goImport} />,
      )}
      {portal("script", <ScriptPageMemo active={shown("script")} />)}
      {/* 多 Agent 分页:每页一个 AiPanel 实例都挂着(对话在后台照跑),只显示各侧选中的那一页 */}
      {tabs.map((t) => portal(agentItem(t.id), <AgentPage tabId={t.id} active={shown(agentItem(t.id))} mcpConnected={mcpConnected} />))}
    </>
  );
}
