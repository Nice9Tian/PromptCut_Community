import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAgentTabs } from "../../ai/agentTabs";
import { onCaptionsRequest } from "../left/captionsBus";
import { LibrarySection } from "../left/LibrarySection";
// Must be a static import: AnimationsSection → cardGroups → CardCell → previewZoom → prewarmBoxes; window.__pcPreviewBoxes gets attached through this chain
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

// Page content re-renders only when its own props change: a click on the rail only changes the selected item, and should not re-render every section and every AiPanel
const LibraryPage = memo(LibrarySection);
const AnimationsPage = memo(AnimationsSection);
const EffectsPage = memo(EffectsSection);
const EditPage = memo(EditSection);
const CaptionsPage = memo(CaptionsSection);
const ScriptPageMemo = memo(ScriptPage);
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";
/**
 * Agent page in online browser mode: the local version of the AI assistant needs the local editor process (model config, chat history, and tool execution all go through its `/api/*`); per section 2 of the contract, the online page
 * does not mount AiPanel, and uses an AI panel with the "cloud" connection type instead (`OnlineAgentPage`, Cloud Agent service contract 9.5; no distinction by identity or tier, see "AI panel" in `product/platforms.md`).
 */
function OnlineAgentSwitch(props: { tabId: string; active: boolean; mcpConnected: boolean }) {
  return <OnlineAgentPage tabId={props.tabId} active={props.active} />;
}
const AgentPage = memo(ONLINE_BUILD ? OnlineAgentSwitch : AiPanel);

const goImport = () => activateRailItem("library", { expand: true });

/**
 * All pages (five sections, the script page, the AiPanel of each Agent tab) are rendered once each here, with createPortal into their own fixed nodes (pageNodes).
 * This component is mounted in RightPanel; RightPanel always occupies the same sibling slot in the Editor grid and is never unmounted,
 * so the React tree here never changes because of dragging, switching, collapsing, or changing layout mode: the portal key is the item id, and the container node is fixed by id.
 * The two side hosts (DockHost) only move DOM nodes, so running AI chats and the scroll position / search text / draft of sections are unaffected.
 *
 * Mount timing: the script page and AiPanel are mounted from the start (chats must keep running in the background); sections that have a position in the layout are mounted from the start (same as the five always-resident left rail sections before the redesign),
 * and are never unmounted once mounted.
 */
export function DockPages({ mcpConnected }: { mcpConnected: boolean }) {
  const layout = useRailLayout();
  const { tabs } = useAgentTabs();
  const collapsed = { left: useRailCollapsed("left"), right: useRailCollapsed("right") };

  // Which media the captions section focuses on: set in via captionsBus from the timeline / media library right-click "transcribe captions"
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
    // Register additionally during render (React allows a component to update its own state while rendering), so this pass draws with the new set
    setMountedSections(sections);
  }

  const parkRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = parkRef.current;
    return el ? registerDockPark(el) : undefined;
  }, []);

  // When the whole editor unmounts (back to the start page), clear the node table: the module-level node table still holds the old page subtrees, and they stay occupied if not cleared.
  // Runs only on unmount; it cannot be merged into the effect below that runs on every commit, or every render would delete all nodes and remount all pages.
  // (main.tsx does not wrap StrictMode, so there is no case of a fake unmount right after mounting deleting the nodes)
  useLayoutEffect(() => () => releasePageNodes(new Set()), []);

  const keep = new Set<ItemId>([...sections, "script", ...tabs.map((t) => agentItem(t.id))]);
  useLayoutEffect(() => {
    // Closed Agent: its portal was already unmounted in this commit, so discard the node too; newly mounted pages are left to placePages to put into the host
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
   * Section pages stay mounted; when not visible (not selected, or its side is collapsed) they are wrapped in a StoreHold: they do not follow store updates,
   * and in the commit where they are revealed they re-read the store as it is then (StoreHold in store/core.ts). Previously every edit re-rendered
   * the whole invisible effects library, node graph, and captions list, crowding the synchronous task of the edit (tiers-probe T4).
   */
  const hidden = (id: SectionId) => {
    const side = sideOf(layout, id);
    return !side || collapsed[side] || effectiveActive(layout, side) !== id;
  };
  const section = (id: SectionId, content: ReactNode) =>
    sections.has(id) ? portal(id, <StoreHold value={hidden(id)}>{content}</StoreHold>) : null;

  return (
    <>
      {/* Parking slot: page nodes of a side whose host is not mounted park here, without leaving the document */}
      <div ref={parkRef} className="pc-dock-park" data-pc-dock-park="" aria-hidden="true" style={{ display: "none" }} />
      {/* The "finished / interrupted, waiting for you to look" marker on an Agent item in the rail */}
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
      {/* Multi-Agent tabs: one AiPanel instance per tab stays mounted (chats keep running in the background); only the selected page of each side is shown */}
      {tabs.map((t) => portal(agentItem(t.id), <AgentPage tabId={t.id} active={shown(agentItem(t.id))} mcpConnected={mcpConnected} />))}
    </>
  );
}
