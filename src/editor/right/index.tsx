import { useEffect, useState } from "react";
import { DockHost } from "../dock/DockHost";
import { DockPages } from "../dock/DockPages";
import { RailBar } from "../dock/RailBar";
import { connectMcpExecutor } from "../../ai/mcpExecutor";
import { startUserEditing } from "../userEditing";
import { VoiceSettingsDialog } from "../../voice/VoiceSettingsDialog";

import { CollectLoginDialog } from "./CollectLoginDialog";
import { AgentBrowserFrame } from "./AgentBrowserFrame";

import { editorApi } from "../../mcp/api";

/** Compile-time constant of the online build; for how it is written and why, see "Online build pruning" in `src/online/pageFlag.ts` */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export function RightPanel() {
  const [mcpConnected, setMcpConnected] = useState(false);

  useEffect(() => {
    // Online browser mode has no editor process: do not connect the Agent's tool channel (C10a contract,
    // section 2); in the online build it is pruned together with the tool executor
    if (ONLINE_BUILD) return;
    const cleanup = connectMcpExecutor(() => editorApi, (s) => setMcpConnected(s.connected));
    // Push "user is editing" to the same editor process (A2), so when the Agent reads or writes these clips
    // the tool results carry a hint
    const stopEditing = startUserEditing();
    return () => { stopEditing(); cleanup(); };
  }, []);

  // The whole right rail column: on the left a host card (showing the page of the item selected in the right
  // rail), on the right a vertical rail stuck to the window edge (free side layout, editor/dock/).

  return (
    <>
      <div className="pc-right" data-pc="right">
        <DockHost side="right" />
        <RailBar side="right" />
      </div>
      {/*
        All pages (five sections, script page, each AiPanel) are rendered once here, portaled into their
        respective fixed nodes; hosts on both sides only move DOM nodes. RightPanel always occupies the
        same sibling slot in the Editor grid and never unmounts, so dragging / switching / collapsing
        never causes AiPanel to unmount and rebuild. Positioned after the host: the host's layout effect
        runs first and registers first; when page content layout effects run, nodes are already mounted in
        the document.
      */}
      <DockPages mcpConnected={mcpConnected} />
      {/*
        The three popovers below cannot be opened in online pages (their entry points online are disabled
        or absent: web collection, voiceover settings, Agent browser handoff); they are not mounted in
        online builds, pruned along with underlying /api calls (C10 contract section 10; M8 legacy L24).
      */}
      {/* Site login box: the card on the start page and the collect_login tool both open it; it is mounted here so it can appear in the editor */}
      {ONLINE_BUILD ? null : <CollectLoginDialog />}
      {/* Voiceover settings child window: opened by the "Voiceover settings" button on the top bar */}
      {ONLINE_BUILD ? null : <VoiceSettingsDialog />}
      {/* Overlay for when the agent hands over the browser in desktop shell mode (never opens with the Chrome approach) */}
      {ONLINE_BUILD ? null : <AgentBrowserFrame />}
    </>
  );
}
